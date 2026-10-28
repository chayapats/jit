import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tr, withLocale, type Locale, type MessageKey } from "../i18n";

/**
 * app.local_api/v1 `jit` CLI: `ask`, `status` and `pending` over the loopback API (ADR 0035).
 *
 * The CLI never opens SQLite. It reads `url` and `headers` from `<data>/local-api/` on every call, so a service
 * restart (which rotates the token) is picked up by reading the files again. It sends the token only to a
 * `http://127.0.0.1:<port>` URL and never prints it.
 */

/** Exit codes from ADR 0035. */
export const cliExit = Object.freeze({ done: 0, failed: 1, usage: 2, waitingOnOwner: 3, timedOut: 4, unavailable: 5 } as const);

export interface CliIo {
  /** `<data>/local-api/` for the selected installation. */
  directory: string;
  locale: Locale;
  out(text: string): void;
  err(text: string): void;
  /** Standard input when it is not a terminal, otherwise null. */
  stdin(): Promise<string | null>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

class Usage extends Error {}
class Unavailable extends Error {}

const say = (io: CliIo, key: MessageKey, extra = "") => io.err(withLocale(io.locale, () => tr(key)) + (extra ? ` ${extra}` : ""));

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const maxTimeoutMs = 24 * 60 * 60 * 1000;

/** Parses `30m`, `1s`, `2h` or `500ms` into milliseconds (at most 24 h). */
export function parseDuration(value: string): number {
  const match = /^(\d{1,9})(ms|s|m|h)$/.exec(value);
  if (!match) throw new Usage("timeout");
  const ms = Number(match[1]) * { ms: 1, s: 1000, m: 60_000, h: 3_600_000 }[match[2] as "ms" | "s" | "m" | "h"];
  if (ms < 1 || ms > maxTimeoutMs) throw new Usage("timeout");
  return ms;
}

interface Parsed { positional: string[]; wait: boolean; timeoutMs: number | null; id: string | null; json: boolean }

function parse(args: string[], allowed: readonly string[]): Parsed {
  const parsed: Parsed = { positional: [], wait: false, timeoutMs: null, id: null, json: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") { parsed.positional.push(...args.slice(i + 1)); break; }
    if (!arg.startsWith("--")) { parsed.positional.push(arg); continue; }
    if (!allowed.includes(arg)) throw new Usage(arg);
    if (arg === "--wait") parsed.wait = true;
    else if (arg === "--json") parsed.json = true;
    else if (arg === "--timeout") { const value = args[++i]; if (value === undefined || parsed.timeoutMs !== null) throw new Usage(arg); parsed.timeoutMs = parseDuration(value); }
    else if (arg === "--id") {
      const value = args[++i];
      if (value === undefined || parsed.id !== null || !/^[A-Za-z0-9._:-]{1,128}$/.test(value)) throw new Usage(arg);
      parsed.id = value;
    }
  }
  return parsed;
}

interface ApiFiles { url: string; headers: Record<string, string> }

/** Reads the listener files again; missing or malformed files mean the API is off or Jit is not running. */
function readFiles(directory: string): ApiFiles {
  try {
    if (!existsSync(join(directory, "url")) || !existsSync(join(directory, "headers"))) throw new Unavailable();
    const url = readFileSync(join(directory, "url"), "utf8").trim();
    if (!/^http:\/\/127\.0\.0\.1:\d{1,5}$/.test(url)) throw new Unavailable();
    const headers = JSON.parse(readFileSync(join(directory, "headers"), "utf8")) as unknown;
    if (!headers || typeof headers !== "object" || Array.isArray(headers) || Object.keys(headers).join(",") !== "Authorization" ||
        typeof (headers as { Authorization: unknown }).Authorization !== "string") throw new Unavailable();
    return { url, headers: headers as Record<string, string> };
  } catch { throw new Unavailable(); }
}

interface ApiResponse { status: number; body: Record<string, unknown>; retryAfterMs: number }

/** How long a command without `--wait` keeps retrying a rate-limited request: one rate window plus slack. */
const rateRetryMs = 65_000;

/**
 * One API request. A 401 usually means the service restarted and rotated the token, so the files are read once
 * more. A 429 waits for `Retry-After` and retries while that still ends before `deadline`; otherwise it is returned.
 */
async function call(io: CliIo, method: "GET" | "POST", path: string, body: unknown, timeoutMs: number, deadline: number): Promise<ApiResponse> {
  const sleep = io.sleep ?? Bun.sleep, now = io.now ?? Date.now;
  for (let attempt = 0; ; attempt++) {
    const files = readFiles(io.directory);
    let response: Response;
    try {
      response = await fetch(`${files.url}${path}`, { method, signal: AbortSignal.timeout(timeoutMs), redirect: "error",
        headers: { ...files.headers, ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch { throw new Unavailable(); }
    if (response.status === 401) {
      await response.body?.cancel();
      if (attempt === 0) continue;
      throw new Unavailable();
    }
    const parsed = await response.json().catch(() => ({})) as Record<string, unknown>;
    const retry = Number(response.headers.get("retry-after") ?? "1");
    const retryAfterMs = (Number.isFinite(retry) && retry > 0 ? Math.min(retry, 60) : 1) * 1000;
    if (response.status === 429 && now() + retryAfterMs <= deadline) { await sleep(retryAfterMs); attempt = -1; continue; }
    return { status: response.status, body: parsed, retryAfterMs };
  }
}

/**
 * Runs `ask`, `status` or `pending` and returns the exit code. Output goes through `io`; nothing reads SQLite.
 * `ask TOPIC|general [text…] [--wait] [--timeout 30m] [--id key] [--json]` (text from stdin when none is given),
 * `status RECEIPT [--json]`, `pending [--json]`.
 */
export async function runLocalApiCli(command: "ask" | "status" | "pending", args: string[], io: CliIo): Promise<number> {
  const sleep = io.sleep ?? Bun.sleep, now = io.now ?? Date.now;
  let parsed: Parsed;
  try {
    parsed = parse(args, command === "ask" ? ["--wait", "--timeout", "--id", "--json"] : ["--json"]);
    if (command === "ask") {
      if (!parsed.positional.length || (!uuid.test(parsed.positional[0]!) && parsed.positional[0] !== "general")) throw new Usage("topic");
      if (parsed.timeoutMs !== null && !parsed.wait) throw new Usage("--timeout");
    } else if (command === "status") {
      if (parsed.positional.length !== 1 || !/^[A-Za-z0-9_-]{8,128}$/.test(parsed.positional[0]!)) throw new Usage("receipt");
    } else if (parsed.positional.length) throw new Usage("pending");
  } catch (error) {
    if (!(error instanceof Usage)) throw error;
    say(io, "local_api.cli_usage");
    return cliExit.usage;
  }
  const print = (value: Record<string, unknown>) => io.out(JSON.stringify(value));
  const refused = (response: ApiResponse) => {
    const code = typeof response.body.error === "string" ? response.body.error : `http_${response.status}`;
    if (parsed.json) print({ outcome: "refused", error: code }); else say(io, "local_api.cli_refused", code);
    return cliExit.failed;
  };
  try {
    if (command === "pending") {
      const response = await call(io, "GET", "/v1/pending", undefined, 10_000, now() + rateRetryMs);
      if (response.status !== 200) return refused(response);
      if (parsed.json) { print({ outcome: "done", ...response.body }); return cliExit.done; }
      const proposals = (response.body.proposals ?? []) as { id: string; revision: number; roles: { roleName: string }[] }[];
      const jobs = (response.body.jobs ?? []) as { id: string; reason: string | null }[];
      if (!proposals.length && !jobs.length) say(io, "local_api.cli_nothing_pending");
      for (const item of proposals) io.out(`proposal ${item.id} revision ${item.revision}: ${item.roles.map(role => role.roleName).join(", ")}`);
      for (const job of jobs) io.out(`job ${job.id}: ${job.reason ?? "waiting"}`);
      return cliExit.done;
    }
    if (command === "status") return reportReply(await call(io, "GET", `/v1/replies/${parsed.positional[0]}`, undefined, 10_000, now() + rateRetryMs));

    // ask
    const target = parsed.positional[0]!;
    let text = parsed.positional.slice(1).join(" ");
    if (!text) text = (await io.stdin())?.replace(/\r?\n$/, "") ?? "";
    if (!text.trim()) { say(io, "local_api.cli_usage"); return cliExit.usage; }
    const key = parsed.id ?? crypto.randomUUID();
    const deadline = now() + (parsed.timeoutMs ?? 30 * 60_000);
    // The retry key makes a repeated send safe: it replays the same receipt.
    const sent = await call(io, "POST", `/v1/topics/${target}/messages`, { text, clientRequestId: key }, 10_000, parsed.wait ? deadline : now() + rateRetryMs);
    if (sent.status !== 202) return refused(sent);
    const receiptId = String(sent.body.receiptId);
    if (!parsed.wait) {
      if (parsed.json) print({ outcome: "accepted", ...sent.body }); else io.out(receiptId);
      return cliExit.done;
    }
    for (;;) {
      const remaining = deadline - now();
      if (remaining <= 0) break;
      const waitSeconds = Math.max(1, Math.min(25, Math.ceil(remaining / 1000)));
      let response: ApiResponse;
      try { response = await call(io, "GET", `/v1/replies/${receiptId}?wait=${waitSeconds}`, undefined, waitSeconds * 1000 + 10_000, deadline); }
      catch (error) {
        // Service restarting: the receipt is durable, so read the files again until the deadline.
        if (!(error instanceof Unavailable)) throw error;
        await sleep(Math.min(1000, Math.max(1, deadline - now())));
        continue;
      }
      if (response.status === 429) break;
      if (response.status !== 200 || response.body.outcome !== "running") return reportReply(response);
    }
    if (parsed.json) print({ outcome: "timed_out", receiptId }); else say(io, "local_api.cli_timed_out", receiptId);
    return cliExit.timedOut;
  } catch (error) {
    if (!(error instanceof Unavailable)) throw error;
    if (parsed.json) print({ outcome: "unavailable" }); else say(io, "local_api.cli_unavailable");
    return cliExit.unavailable;
  }

  /** Prints one reply read; a reply still thinking is a successful `status` read (exit 0). */
  function reportReply(response: ApiResponse): number {
    if (response.status !== 200) return refused(response);
    const body = response.body, outcome = body.outcome as string;
    if (parsed.json) print(body);
    else if (typeof body.answer === "string") io.out(body.answer);
    const pending = (body.pending ?? []) as { kind: string; id: string; revision: number }[];
    if (outcome === "done") return cliExit.done;
    if (outcome === "running") { if (!parsed.json) say(io, "local_api.cli_thinking", String(body.receiptId)); return cliExit.done; }
    if (outcome === "waiting_on_owner") {
      if (!parsed.json) {
        const reply = body.reply as { nextAction: string | null } | null;
        say(io, "local_api.cli_waiting_on_owner", [...pending.map(item => `${item.kind}:${item.id}@${item.revision}`), reply?.nextAction ?? ""].filter(Boolean).join(" "));
      }
      return cliExit.waitingOnOwner;
    }
    if (!parsed.json) {
      const reply = body.reply as { state: string; reason: string | null } | null;
      say(io, "local_api.cli_failed", [reply?.state, reply?.reason].filter(Boolean).join(" "));
    }
    return cliExit.failed;
  }
}

/** The CLI language: `th` or `en` from `LC_ALL`, `LC_MESSAGES` or `LANG`, Thai otherwise (the product default). */
export function cliLocale(env: Record<string, string | undefined>): Locale {
  const value = env.LC_ALL || env.LC_MESSAGES || env.LANG || "";
  return value.toLowerCase().startsWith("en") ? "en" : "th";
}
