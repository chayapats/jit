import type { SearchProvider, SearchResult } from "schway/host";
import { AppError } from "../errors";
import { containsCredential, redactCredentials } from "../security/credentials";
import { redactRegisteredSecrets } from "../security/secret-fingerprints";
import { canonical } from "./validation";
import pin from "./protocol/parallel-mcp.json";
import type { ParallelResult, ParallelSetting, WebOutcome } from "./parallel-types";

/** Fixed public service endpoint verified from Parallel documentation on 2026-10-30. */
export const parallelEndpoint = pin.endpoint;
/** Trusted deterministic HTTP fixture seam; no endpoint is accepted from model or source text. */
export type ParallelTransport = (url: string, init: RequestInit) => Promise<Response>;
/** Trusted fake-clock timer seam for whole-read deadlines, including discovery and response streaming. */
export type ParallelTimer = (callback: () => void, ms: number) => () => void;
/** Safe protocol failure; vendor bodies, transport messages and credentials never enter errors. */
export class ParallelFailure extends AppError {
  constructor(readonly outcome: WebOutcome) { super(`parallel_${outcome}`, 503); }
}

function schema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(schema);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !["description", "title", "$schema"].includes(key))
    .map(([key, item]) => [key, key === "required" && Array.isArray(item) ? [...item].sort() : schema(item)]));
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ParallelFailure("schema_changed");
  return value as Record<string, unknown>;
}
function string(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.isWellFormed() || Buffer.byteLength(value) > max) throw new ParallelFailure("schema_changed");
  return value;
}
function abort(signal: AbortSignal): void {
  if (signal.aborted) throw new ParallelFailure("cancelled");
}
async function cancellable<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  abort(signal);
  let cancel: (() => void) | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
      cancel = () => reject(new ParallelFailure("cancelled"));
      signal.addEventListener("abort", cancel, { once: true });
      if (signal.aborted) cancel();
    })]);
  } finally { if (cancel) signal.removeEventListener("abort", cancel); }
}

/** Jit URL policy reuses the pinned direct-fetch address ranges for literals without claiming vendor DNS validation. */
export function publicWebUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new ParallelFailure("blocked"); }
  const host = url.hostname.replace(/^\[|\]$/g, "").toLowerCase().replace(/\.$/, "");
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port && !["80", "443"].includes(url.port) ||
      !host.includes(".") && !host.includes(":") || /(?:^|\.)(?:localhost|local|internal|lan|home|metadata|invalid|test)$/.test(host) ||
      host === "instance-data" || host === "metadata.goog") throw new ParallelFailure("blocked");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b, c] = host.split(".").map(Number) as [number, number, number];
    if (a === 0 || a === 10 || a === 127 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 ||
        a === 172 && b >= 16 && b <= 31 || a === 192 && (b === 168 || b === 0 && (c === 0 || c === 2)) ||
        a === 198 && (b === 18 || b === 19 || b === 51 && c === 100) || a === 203 && b === 0 && c === 113 || a >= 224) throw new ParallelFailure("blocked");
  }
  if (host.includes(":")) {
    const [left = "", right] = host.split("::"), front = left ? left.split(":") : [], back = right ? right.split(":") : [];
    const words = right !== undefined ? [...front, ...Array(8 - front.length - back.length).fill("0"), ...back] : front;
    const first = parseInt(words[0]!, 16), second = parseInt(words[1]!, 16);
    if (first < 0x2000 || first > 0x3fff || first === 0x2002 || first === 0x2001 && (second < 0x200 || second === 0xdb8) ||
        (parseInt(words[4]!, 16) === 0 || parseInt(words[4]!, 16) === 0x200) && parseInt(words[5]!, 16) === 0x5efe) throw new ParallelFailure("blocked");
  }
  for (const key of url.searchParams.keys()) if (/(?:key|token|password|secret|credential|auth|signature)/i.test(key)) throw new ParallelFailure("credential_refused");
  return url;
}

/** Credential/internal-address preflight shared by the service gateway and normalized vendor evidence. */
export function publicOutbound(value: string, isUrl: boolean): void {
  let decoded = value;
  for (let n = 0; n < 8; n++) {
    try { const next = decodeURIComponent(decoded.replaceAll("+", " ")); if (next === decoded) break; decoded = next; } catch { break; }
  }
  if (containsCredential(value) || containsCredential(decoded) || redactRegisteredSecrets(value) !== value || redactRegisteredSecrets(decoded) !== decoded) throw new ParallelFailure("credential_refused");
  if (isUrl) publicWebUrl(value);
  else {
    for (const url of value.match(/https?:\/\/[^\s<>"')]+/gi) ?? []) publicWebUrl(url);
    for (const address of decoded.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g) ?? []) publicWebUrl(`https://${address}`);
    if (/\b(?:localhost|metadata\.google\.internal|[\w-]+\.(?:internal|local|lan))\b/i.test(decoded)) throw new ParallelFailure("blocked");
  }
}

/** Bounded MCP client and supported SearchProvider; optional credentials remain in this trusted closure only. */
export class ParallelMcp implements SearchProvider {
  readonly id = "parallel";
  requests = 0;
  last: ParallelResult | null = null;
  #transportSession: string | null = null;
  constructor(readonly options: {
    mode: ParallelSetting["mode"]; secret: string | null; sessionId: string | null; model: string;
    transport?: ParallelTransport; maxBytes?: number; beforeRequest?: (method: string) => void;
    /** Persist validated vendor correlation independently of evidence acceptance. */
    onSessionId?: (sessionId: string) => void;
  }) {}

  private async rpc(method: string, params: unknown, signal: AbortSignal, requestId: number | null): Promise<Record<string, unknown>> {
    abort(signal);
    if (this.requests >= 5) throw new ParallelFailure("service_error");
    this.options.beforeRequest?.(method);
    this.requests++;
    const headers: Record<string, string> = { "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-03-26" };
    if (this.options.secret !== null) headers.authorization = `Bearer ${this.options.secret}`;
    if (this.#transportSession) headers["Mcp-Session-Id"] = this.#transportSession;
    const body = JSON.stringify({ jsonrpc: "2.0", ...(requestId === null ? {} : { id: requestId }), method, params });
    const response = await (this.options.transport ?? fetch)(parallelEndpoint, { method: "POST", headers, body, signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
    if (!response.ok) {
      await response.body?.cancel();
      throw new ParallelFailure(response.status === 429 ? "quota" : response.status === 403 || response.status === 451 ? "blocked" : response.status === 401 ? "key_unavailable" : "service_error");
    }
    const transportSession = response.headers.get("mcp-session-id");
    if (transportSession !== null) {
      if (!/^[\x21-\x7e]{1,1024}$/.test(transportSession) || this.#transportSession !== null && transportSession !== this.#transportSession) throw new ParallelFailure("schema_changed");
      this.#transportSession = transportSession;
    }
    if (requestId === null) { await response.body?.cancel(); return {}; }
    if (!response.body) throw new ParallelFailure("schema_changed");
    const reader = response.body.getReader(), chunks: Uint8Array[] = [];
    const cap = this.options.maxBytes ?? 262144;
    let size = 0, stream = "", consumed = 0;
    const sse = response.headers.get("content-type")?.split(";")[0] === "text/event-stream";
    const result = (value: unknown) => {
      const message = object(value);
      if (message.jsonrpc === "2.0" && !Object.hasOwn(message, "id") && typeof message.method === "string" && !Object.hasOwn(message, "result") && !Object.hasOwn(message, "error")) return null;
      if (message.jsonrpc !== "2.0" || message.id !== requestId) throw new ParallelFailure("schema_changed");
      if (message.error) throw new ParallelFailure("service_error");
      return object(message.result);
    };
    try {
      for (;;) {
        const chunk = await cancellable(reader.read(), signal);
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > cap) throw new ParallelFailure("oversize");
        chunks.push(chunk.value);
        if (sse) {
          stream = Buffer.concat(chunks).toString("utf8").replaceAll("\r\n", "\n");
          const events = stream.split("\n\n").slice(0, -1);
          for (const event of events.slice(consumed)) {
            const data = event.split("\n").filter(line => line.startsWith("data:")).map(line => line.slice(5).trimStart()).join("\n");
            if (data) { const response = result(JSON.parse(data)); if (response) return response; }
          }
          consumed = events.length;
        }
      }
      if (sse) throw new ParallelFailure("schema_changed");
      const response = result(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!response) throw new ParallelFailure("schema_changed");
      return response;
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }

  /** Executes one selected read after pinned discovery; no unlisted tool, protocol retry or identity fallback exists. */
  async call(tool: "web_search" | "web_fetch", input: { query?: string; url?: string; fullContent?: boolean }, signal: AbortSignal): Promise<ParallelResult> {
    const subject = tool === "web_search" ? input.query : input.url;
    if (typeof subject !== "string" || !subject.trim() || Buffer.byteLength(subject) > 8192 || !subject.isWellFormed() || /[\u0000-\u001f\u007f]/.test(subject)) throw new ParallelFailure("blocked");
    publicOutbound(subject, tool === "web_fetch");
    const initialized = await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "jit-public-read", version: "1" } }, signal, 1);
    if (initialized.protocolVersion !== "2025-03-26" || !object(initialized.capabilities).tools) throw new ParallelFailure("schema_changed");
    await this.rpc("notifications/initialized", {}, signal, null);
    const discovered = await this.rpc("tools/list", {}, signal, 2);
    const tools = discovered.tools;
    if (!Array.isArray(tools) || discovered.nextCursor) throw new ParallelFailure("schema_changed");
    const names = tools.map(t => string(object(t).name, 64)).sort();
    const expectedNames = ["web_search", "web_fetch", "web_decisions", ...(this.options.mode === "authenticated" ? ["web_research"] : [])].sort();
    if (canonical(names) !== canonical(expectedNames)) throw new ParallelFailure("schema_changed");
    for (const pinned of pin.variants[this.options.mode]) {
      const advertised = tools.find(t => object(t).name === pinned.name);
      if (canonical(schema(object(advertised).inputSchema)) !== canonical(schema(pinned.inputSchema))) throw new ParallelFailure("schema_changed");
    }
    const args: Record<string, unknown> = tool === "web_search"
      ? { objective: input.query!, search_queries: [input.query!] }
      : { urls: [input.url!], full_content: input.fullContent ?? false, allow_live_fetch: true };
    if (this.options.mode === "anonymous") {
      if (this.options.sessionId) args.session_id = this.options.sessionId;
      if (this.options.model.length <= 100) { publicOutbound(this.options.model, false); args.client_model = this.options.model; }
    }
    const raw = await this.rpc("tools/call", { name: tool, arguments: args }, signal, 3);
    if (raw.isError === true) {
      // Structured error codes alone select a class; raw error content stays private to the protocol boundary.
      const code = object(raw.structuredContent ?? {}).code;
      throw new ParallelFailure(code === "rate_limit_exceeded" || code === "quota_exceeded" ? "quota" : code === "blocked" ? "blocked" : "service_error");
    }
    let data: Record<string, unknown>;
    if (raw.structuredContent) data = object(raw.structuredContent);
    else {
      if (!Array.isArray(raw.content) || raw.content.length !== 1 || object(raw.content[0]).type !== "text") throw new ParallelFailure("schema_changed");
      data = object(JSON.parse(string(object(raw.content[0]).text, this.options.maxBytes ?? 262144)));
    }
    return this.normalize(tool, input, data, raw._meta);
  }

  private normalize(tool: "web_search" | "web_fetch", input: { url?: string; fullContent?: boolean }, data: Record<string, unknown>, meta: unknown): ParallelResult {
    let sessionId: string | null = null;
    if (data.session_id !== undefined) {
      sessionId = string(data.session_id, 1000);
      if (!sessionId || /[\s\u0000-\u001f\u007f]/.test(sessionId) || containsCredential(sessionId) || this.options.sessionId !== null && this.options.sessionId !== sessionId) throw new ParallelFailure("schema_changed");
      if (this.options.mode === "anonymous") this.options.onSessionId?.(sessionId);
    }
    if (!Array.isArray(data.results) || data.results.length > 100) throw new ParallelFailure("schema_changed");
    const evidence: ParallelResult["evidence"] = [];
    let partial = data.results.length > 20;
    for (const raw of data.results.slice(0, 20)) {
      const row = object(raw), url = string(row.url, 8192);
      publicOutbound(url, true);
      if (row.final_url !== undefined && row.final_url !== null) publicOutbound(string(row.final_url, 8192), true);
      const excerpts = row.excerpts ?? [];
      if (!Array.isArray(excerpts) || excerpts.length > 100 || excerpts.some(v => typeof v !== "string")) throw new ParallelFailure("schema_changed");
      const full = typeof row.full_content === "string" ? row.full_content : null;
      const content = full ?? (typeof row.content === "string" ? row.content : excerpts.join("\n\n"));
      // No silent content trimming: the raw response cap and model envelope cap produce explicit outcomes.
      string(content, 262144);
      const reported = row.cache_status;
      const stamp = (value: unknown): string | null => typeof value === "string" && value.length <= 100 && /^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
      evidence.push({ requestedUrl: tool === "web_fetch" && publicWebUrl(url).href === publicWebUrl(input.url!).href ? input.url! : null, url, finalUrl: typeof row.final_url === "string" ? row.final_url : null,
        title: row.title === null || row.title === undefined ? "" : string(row.title, 4096), content,
        coverage: tool === "web_search" ? "snippet" : input.fullContent === true && full !== null ? "full_content_returned" : "excerpt",
        publishedAt: stamp(row.publish_date),
        reportedRetrievedAt: stamp(row.fetched_at),
        freshness: reported === "cached" ? "cached_reported" : reported === "live" ? "live_reported" : "unknown",
        cache: reported === undefined ? null : { status: ["cached", "live", "stale"].includes(reported as string) ? reported : "unknown", cachedAt: stamp(row.cached_at) },
        truncated: row.truncated === true, untrusted: true });
      const added = evidence.at(-1)!;
      added.title = redactRegisteredSecrets(redactCredentials(added.title));
      added.content = redactRegisteredSecrets(redactCredentials(added.content));
      partial ||= row.truncated === true || tool === "web_fetch" && input.fullContent === true && full === null;
    }
    const missing: string[] = [], failures: ParallelResult["failures"] = [];
    if (tool === "web_fetch" && !evidence.some(e => e.requestedUrl === input.url && e.content.length > 0)) missing.push(input.url!);
    if (data.errors !== undefined) {
      if (!Array.isArray(data.errors) || data.errors.length > 100) throw new ParallelFailure("schema_changed");
      for (const error of data.errors) {
        const url = object(error).url;
        if (typeof url === "string") {
          publicOutbound(url, true);
          if (!missing.includes(url)) missing.push(url);
          const detail = object(error);
          const status = detail.http_status_code;
          failures.push({ url, kind: typeof detail.error_type === "string" && ["fetch_error", "not_found", "blocked", "access_denied", "timeout", "robots_denied"].includes(detail.error_type) ? detail.error_type : "unknown",
            status: typeof status === "number" && Number.isInteger(status) && status >= 100 && status <= 599 ? status : null });
        }
      }
      partial ||= data.errors.length > 0;
    }
    const usageValue = meta === undefined ? undefined : object(meta)["parallel/usage"];
    let usage: ParallelResult["usage"] = null;
    if (usageValue !== undefined) {
      if (!Array.isArray(usageValue) || usageValue.length > 20) throw new ParallelFailure("schema_changed");
      usage = usageValue.map(entry => {
        const row = object(entry);
        if (typeof row.count !== "number" || !Number.isFinite(row.count) || row.count < 0 || typeof row.cost_usd !== "number" || !Number.isFinite(row.cost_usd) || row.cost_usd < 0) throw new ParallelFailure("schema_changed");
        return { name: redactCredentials(string(row.name, 100)), count: row.count, costUsd: row.cost_usd };
      });
    }
    return { evidence, missing, failures, usage, sessionId, omittedResults: Math.max(0, data.results.length - evidence.length), partial: partial || missing.length > 0 };
  }

  /** SearchProvider preserves the selected MCP identity; richer evidence remains in last for the trusted gateway. */
  async search(query: string, options: { limit: number; signal: AbortSignal }): Promise<readonly SearchResult[]> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 20) throw new ParallelFailure("oversize");
    this.last = await this.call("web_search", { query }, options.signal);
    if (this.last.evidence.length > options.limit) {
      this.last.omittedResults += this.last.evidence.length - options.limit;
      this.last.evidence = this.last.evidence.slice(0, options.limit);
      this.last.partial = true;
    }
    return this.last.evidence.map(e => ({ url: e.url, title: e.title, snippet: e.content }));
  }
}
