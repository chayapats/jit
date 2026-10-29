import type {
  ExecutionBackend, ExecutionDirectoryEntry, ExecutionFileObservation, ExecutionSearchRequest, ExecutionSearchResult, ExecutionSpawnRequest, ExecutionSpawnResult,
} from "schway/host";
import { AppError } from "../errors";
import type { BoxHandle, BoxRuntime } from "./box-runtime";

/** Options of {@link createBoxBackend}. */
export interface BoxBackendOptions {
  /** Applied to every command output and search line before Schway sees it (the connection redaction guard). */
  redact?: (text: string) => string;
  /** Host-side deadline of one non-spawn runner call (default 90 s; the runner's own limits are tighter). */
  callMs?: number;
}

/** Jit's runner backend also accepts binary derivatives; Schway's text-only public backend remains compatible. */
export interface BoxBackend extends ExecutionBackend {
  writeFileAtomically(path: string, content: string | Uint8Array, options?: Parameters<ExecutionBackend["writeFileAtomically"]>[2]): Promise<void>;
}

/** Bytes per `read` request; the runner's fixed chunk limit. */
export const boxReadChunkBytes = 1_048_576;
const spawnGraceMs = 30_000;
const killMs = 10_000;
const defaultSpawnMs = 1_800_000;

interface RunnerResponse { v: 1; ok: boolean; result?: unknown; error?: { code?: unknown } }

/** A Node-style failure Schway maps to its model-visible error text. */
function errno(code: string): Error {
  return Object.assign(new Error(code), { code });
}
function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
const decode = (base64: string) => Uint8Array.from(Buffer.from(base64, "base64"));
const encode = (content: string | Uint8Array) => (typeof content === "string" ? Buffer.from(content, "utf8") : Buffer.from(content)).toString("base64");
const knownCodes = new Set(["ENOENT", "EACCES", "EPERM", "EISDIR", "ENOTDIR", "ECHANGED", "EINVAL", "EFBIG", "E2BIG", "EIO", "EPROTO", "ETIMEDOUT"]);
/** Runner limits a result can hit; an incomplete listing is an error, never a result that looks complete. */
const maxEntries = 10_000, maxFiles = 50_000;
function incomplete(message: string): Error { return Object.assign(new Error(message), { code: "EFBIG" }); }

const ereSpecial = /[\\.^$*+?()[\]{}|]/g;
/**
 * A POSIX extended regular expression, anchored to absolute paths under `cwd`, that matches at least every path the
 * glob matches (a superset: classes become any one character). The runner filters with it before its 50,000-file
 * cap, so files that cannot match never use up the cap; `Bun.Glob` then decides exactly on the host. Returns null
 * when the pattern cannot be translated safely (the runner then lists without a filter).
 */
export function globPrefilter(pattern: string, cwd: string): string | null {
  let out = "", depth = 0;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === "*" && pattern[i + 1] === "*") {
      const slashAfter = pattern[i + 2] === "/", atStart = i === 0 || pattern[i - 1] === "/";
      if (atStart && slashAfter) { out += "(.*/)?"; i += 2; } else { out += ".*"; i += 1; }
    } else if (c === "*") out += "[^/]*";
    else if (c === "?") out += "[^/]";
    else if (c === "[") { const end = pattern.indexOf("]", i + 2); if (end < 0) return null; out += "[^/]"; i = end; }
    else if (c === "{") { depth++; out += "("; }
    else if (c === "}") { if (!depth) return null; depth--; out += ")"; }
    else if (c === "," && depth) out += "|";
    else if (c === "\\") { const next = pattern[i + 1]; if (next === undefined) return null; out += next.replace(ereSpecial, "\\$&"); i++; }
    else out += c.replace(ereSpecial, "\\$&");
  }
  if (depth) return null;
  return `^${cwd.replace(/\/$/, "").replace(ereSpecial, "\\$&")}/${out}$`;
}

/** The literal leading directories of a glob (`src/lib` for `src/lib/**\/*.ts`), so the box walks only that subtree. */
export function globBase(pattern: string): string {
  const segments = pattern.split("/");
  const literal: string[] = [];
  for (const segment of segments.slice(0, -1)) {
    if (/[*?[\]{}!\\]/.test(segment) || segment === "" || segment === "." || segment === "..") break;
    literal.push(segment);
  }
  return literal.join("/");
}

/**
 * exec.box_backend/v1 (EXE03) — Schway's `ExecutionBackend` (`schway.host.core-tools/v1`) over the box runner.
 *
 * Each member is one `jit.box.runner/v1` request through {@link BoxRuntime.exec}; paths are the box paths of
 * `handle` (`/workspace`, `/tmp`). Schway keeps ownership of everything model-facing — path resolution and
 * confinement, the 50,000-byte output caps, truncation notices and spill files — so the core tools produce the same
 * output through a box as in process. The runner adds its own confinement to `/workspace` (realpath checks).
 *
 * - `readFile` streams 1 MiB chunks, one request each, and stops when iteration stops.
 * - `observeFile` returns opaque observations; `writeFileAtomically` only accepts observations this backend issued
 *   (`TypeError` otherwise) and the runner rejects a changed path with `ECHANGED`.
 * - `glob` lists regular files under the pattern's literal base directory in the box (hidden directories pruned unless
 *   the pattern names one) and matches them on the host with `Bun.Glob`, the matcher of Schway's local backend. A
 *   listing the runner had to cut (50,000 files, 10,000 directory entries) or stop (60 s) rejects (`EFBIG`,
 *   `ETIMEDOUT`) instead of returning results that look complete.
 * - A stream the box cut at 8 MiB ends with an explicit notice of the kept and total bytes.
 * - `spawn` runs `bash -c` in its own process group in the box. Cancellation sends a runner `kill` for that group
 *   (reaching the process inside the box, not only the `podman exec` client), then rejects with `AbortError`; a
 *   result that arrives after cancellation is never returned. Output is delivered to `onOutput` once the command ends.
 * - Runner failures reject with a Node-style `code` (`ENOENT`, `EACCES`, `EISDIR`, `ENOTDIR`, `ECHANGED`, …); a
 *   runner or transport failure is `EIO`.
 */
export function createBoxBackend(runtime: Pick<BoxRuntime, "exec">, handle: BoxHandle, options: BoxBackendOptions = {}): BoxBackend {
  const redact = options.redact ?? (text => text);
  const callMs = options.callMs ?? 90_000;
  const observations = new WeakMap<ExecutionFileObservation, string>();

  async function call<T>(request: Record<string, unknown>, settings: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<T> {
    if (settings.signal?.aborted) throw abortError();
    let result;
    try {
      result = await runtime.exec(handle, {
        input: new TextEncoder().encode(JSON.stringify({ v: 1, ...request })), timeoutMs: settings.timeoutMs ?? callMs,
        ...(settings.signal ? { signal: settings.signal } : {}),
      });
    } catch (error) {
      if (settings.signal?.aborted) throw abortError();
      throw error instanceof AppError ? errno("EIO") : error;
    }
    if (settings.signal?.aborted) throw abortError();
    let response: RunnerResponse;
    try { response = JSON.parse(new TextDecoder().decode(result.stdout)) as RunnerResponse; } catch { throw errno("EIO"); }
    if (result.exitCode !== 0 || !response || response.v !== 1) throw errno("EIO");
    if (!response.ok) {
      const code = typeof response.error?.code === "string" && knownCodes.has(response.error.code) ? response.error.code : "EIO";
      throw errno(code);
    }
    return response.result as T;
  }

  return {
    workspaceRoot: handle.workspaceRoot,
    temporaryDirectory: handle.temporaryDirectory,
    async realpath(path) { return (await call<{ path: string }>({ op: "realpath", path })).path; },
    async stat(path) { return { type: (await call<{ type: "file" | "directory" | "other" }>({ op: "stat", path })).type }; },
    readFile(path, readOptions) {
      return (async function* () {
        for (let offset = 0; ;) {
          const chunk = await call<{ data: string; eof: boolean }>({ op: "read", path, offset, length: boxReadChunkBytes }, readOptions?.signal ? { signal: readOptions.signal } : {});
          const bytes = decode(chunk.data);
          if (bytes.length) yield bytes;
          offset += bytes.length;
          if (chunk.eof || bytes.length === 0) return;
        }
      })();
    },
    async observeFile(path, observeOptions) {
      const observed = await call<{ targetExists: boolean; token: string; data?: string } | null>(
        { op: "observe", path, content: observeOptions?.content === true }, observeOptions?.signal ? { signal: observeOptions.signal } : {});
      if (!observed) return null;
      const observation: ExecutionFileObservation = { targetExists: observed.targetExists, ...(observed.data !== undefined ? { bytes: decode(observed.data) } : {}) };
      observations.set(observation, observed.token);
      return observation;
    },
    async writeFileAtomically(path, content, writeOptions = {}) {
      let observed: string | null | undefined;
      if (writeOptions.observed === null) observed = null;
      else if (writeOptions.observed !== undefined) {
        observed = observations.get(writeOptions.observed);
        if (observed === undefined) throw new TypeError("File observation was not issued by this backend");
      }
      await call({ op: "write", path, data: encode(content), createParents: writeOptions.createParents === true, ...(observed !== undefined ? { observed } : {}) },
        writeOptions.signal ? { signal: writeOptions.signal } : {});
    },
    async writePrivateFile(path, content) { await call({ op: "writePrivate", path, data: encode(content) }); },
    async list(path, listOptions) {
      const listed = await call<{ entries: ExecutionDirectoryEntry[]; truncated: boolean }>({ op: "list", path }, listOptions?.signal ? { signal: listOptions.signal } : {});
      if (listed.truncated) throw incomplete(`Directory has more than ${maxEntries} entries: ${path}. Use a more specific path.`);
      return listed.entries;
    },
    glob(pattern, globOptions) {
      return (async function* () {
        // Bun.Glob skips dot entries unless the pattern names one; prune hidden trees in the box the same way.
        const dot = pattern.split("/").some(segment => segment.startsWith("."));
        // Walk only the pattern's literal base directory, then match the full pattern on the host.
        const base = globBase(pattern), cwd = base ? `${globOptions.cwd.replace(/\/$/, "")}/${base}` : globOptions.cwd;
        let listed: { files: string[]; truncated: boolean };
        const match = globPrefilter(base ? pattern.slice(base.length + 1) : pattern, cwd);
        try { listed = await call<{ files: string[]; truncated: boolean }>({ op: "glob", cwd, dot, ...(match ? { match } : {}) }, globOptions.signal ? { signal: globOptions.signal } : {}); }
        catch (error) { if (base && (error as { code?: string }).code === "ENOENT") return; throw error; }
        if (listed.truncated) throw incomplete(`More than ${maxFiles} files under ${cwd}; results would be incomplete. Use a narrower path or pattern.`);
        const matcher = new Bun.Glob(pattern);
        for (const file of listed.files) { const relative = base ? `${base}/${file}` : file; if (matcher.match(relative)) yield relative; }
      })();
    },
    async search(request: ExecutionSearchRequest): Promise<ExecutionSearchResult> {
      const result = await call<ExecutionSearchResult>({
        op: "search", pattern: request.pattern, path: request.path, cwd: request.cwd, limit: request.limit,
        ...(request.glob !== undefined ? { glob: request.glob } : {}), ...(request.ignoreCase !== undefined ? { ignoreCase: request.ignoreCase } : {}),
      }, request.signal ? { signal: request.signal } : {});
      return { matches: result.matches.map(match => ({ ...match, text: redact(match.text) })), truncated: result.truncated,
        ...(result.failure !== undefined ? { failure: redact(result.failure) } : {}) };
    },
    async spawn(request: ExecutionSpawnRequest): Promise<ExecutionSpawnResult> {
      if (request.signal?.aborted) throw abortError();
      const id = crypto.randomUUID();
      const env = request.env === undefined ? undefined
        : Object.fromEntries(Object.entries(request.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
      const transport = new AbortController();
      let cancelled = false;
      const onAbort = () => {
        cancelled = true;
        // Kill the process group inside the box, then release the exec client whatever the kill call did.
        void call({ op: "kill", id }, { timeoutMs: killMs }).catch(() => undefined).finally(() => transport.abort());
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const timeoutMs = request.timeoutMs ?? defaultSpawnMs;
        const result = await call<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; stdoutBytes?: number; stderrBytes?: number }>(
          { op: "spawn", id, command: request.command, cwd: request.cwd, ...(env ? { env } : {}), ...(request.timeoutMs !== undefined ? { timeoutMs } : {}) },
          { signal: transport.signal, timeoutMs: timeoutMs + spawnGraceMs },
        ).catch(error => { if (cancelled) throw abortError(); throw error; });
        if (cancelled || request.signal?.aborted) throw abortError();
        // The box keeps at most 8 MiB of each stream; a cut stream says so instead of looking complete.
        const text = (base64: string, total: number | undefined) => {
          const bytes = decode(base64), body = redact(new TextDecoder("utf-8").decode(bytes));
          return total !== undefined && total > bytes.length
            ? `${body}\n[Output cut by the execution box: kept ${bytes.length} of ${total} bytes. Redirect large output to a file in the workspace.]\n` : body;
        };
        const stdout = text(result.stdout, result.stdoutBytes), stderr = text(result.stderr, result.stderrBytes);
        if (stdout) request.onOutput?.({ stream: "stdout", text: stdout });
        if (stderr) request.onOutput?.({ stream: "stderr", text: stderr });
        return { stdout, stderr, exitCode: result.exitCode, timedOut: result.timedOut };
      } finally {
        request.signal?.removeEventListener("abort", onAbort);
      }
    },
  };
}
