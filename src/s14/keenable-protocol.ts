import type { SearchProvider, SearchResult } from "schway/host";
import { redactCredentials } from "../security/credentials";
import { redactRegisteredSecrets } from "../security/secret-fingerprints";
import { ParallelFailure, publicOutbound, publicWebUrl, retryAt } from "./parallel-protocol";
import type { ParallelResult } from "./parallel-types";

/** Keyless Keenable search/fetch endpoints verified against the live API on 2026-11-08. */
export const keenableSearchEndpoint = "https://api.keenable.ai/v1/search/public";
export const keenableFetchEndpoint = "https://api.keenable.ai/v1/fetch/public";
/** Fixed client title sent with every keyless Keenable request; no key, session or model is ever sent. */
export const keenableTitle = "Jit";
/** Trusted deterministic HTTP fixture seam; mirrors ParallelTransport so the gateway can share one transport. */
export type KeenableTransport = (url: string, init: RequestInit) => Promise<Response>;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ParallelFailure("schema_changed");
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.isWellFormed() || Buffer.byteLength(value) > max) throw new ParallelFailure("schema_changed");
  return value;
}
function stamp(value: unknown): string | null {
  return typeof value === "string" && value.length <= 100 && /^\d{4}-\d{2}-\d{2}(?:T[^\s]+)?$/.test(value) && Number.isFinite(Date.parse(value)) ? value : null;
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
async function jsonBody(response: Response, signal: AbortSignal, cap: number): Promise<unknown> {
  const raw = await cancellable(response.text(), signal);
  // No silent content trimming: a response past the byte cap is an explicit oversize outcome.
  if (Buffer.byteLength(raw) > cap) throw new ParallelFailure("oversize");
  try { return JSON.parse(raw); } catch { throw new ParallelFailure("schema_changed"); }
}
function headers(): Record<string, string> {
  return { "content-type": "application/json", accept: "application/json", "X-Keenable-Title": keenableTitle };
}
function clean(title: string, content: string): { title: string; content: string } {
  return {
    title: redactRegisteredSecrets(redactCredentials(title)),
    content: redactRegisteredSecrets(redactCredentials(content)),
  };
}

/** Bounded keyless Keenable client returning the same normalized result as ParallelMcp. */
export class KeenableSearch implements SearchProvider {
  readonly id = "keenable";
  requests = 0;
  last: ParallelResult | null = null;
  constructor(readonly options: {
    transport?: KeenableTransport; maxBytes?: number; beforeRequest?: (method: string) => void; now?: () => number;
  } = {}) {}

  private async send(url: string, init: RequestInit, signal: AbortSignal): Promise<Response> {
    abort(signal);
    if (this.requests >= 5) throw new ParallelFailure("service_error");
    this.options.beforeRequest?.("tools/call");
    this.requests++;
    return (this.options.transport ?? fetch)(url, { ...init, signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer" });
  }

  /** Executes one keyless read; one HTTP request, no key, no session id, no model name. */
  async call(tool: "web_search" | "web_fetch", input: { query?: string; url?: string; fullContent?: boolean }, signal: AbortSignal): Promise<ParallelResult> {
    const subject = tool === "web_search" ? input.query : input.url;
    if (typeof subject !== "string" || !subject.trim() || Buffer.byteLength(subject) > 8192 || !subject.isWellFormed() || /[\u0000-\u001f\u007f]/.test(subject)) throw new ParallelFailure("blocked");
    publicOutbound(subject, tool === "web_fetch");
    const cap = this.options.maxBytes ?? 262144;
    const now = (this.options.now ?? Date.now)();
    if (tool === "web_search") {
      const response = await this.send(keenableSearchEndpoint, {
        method: "POST", headers: headers(), body: JSON.stringify({ query: subject }),
      }, signal);
      const retry = retryAt(response.headers, now);
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new ParallelFailure(response.status === 429 ? "quota" : response.status === 403 || response.status === 451 ? "blocked" : "service_error", response.status === 429 ? retry : null);
      }
      return this.normalizeSearch(await jsonBody(response, signal, cap));
    }
    const target = new URL(keenableFetchEndpoint);
    target.searchParams.set("url", subject!);
    const response = await this.send(target.href, { method: "GET", headers: { accept: "application/json", "X-Keenable-Title": keenableTitle } }, signal);
    const retry = retryAt(response.headers, now);
    if (response.status === 404) {
      await response.body?.cancel().catch(() => {});
      publicWebUrl(subject!);
      return { evidence: [], missing: [subject!], failures: [{ url: subject!, kind: "not_found", status: 404 }], usage: null, sessionId: null, omittedResults: 0, partial: true };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new ParallelFailure(response.status === 429 ? "quota" : response.status === 403 || response.status === 451 ? "blocked" : "service_error", response.status === 429 ? retry : null);
    }
    return this.normalizeFetch(subject!, input.fullContent === true, await jsonBody(response, signal, cap));
  }

  private normalizeSearch(data: unknown): ParallelResult {
    const root = object(data);
    if (!Array.isArray(root.results) || root.results.length > 100) throw new ParallelFailure("schema_changed");
    const evidence: ParallelResult["evidence"] = [];
    const partial = root.results.length > 20;
    for (const raw of root.results.slice(0, 20)) {
      const row = object(raw), url = text(row.url, 8192);
      publicOutbound(url, true);
      const snippet = typeof row.snippet === "string" ? row.snippet : typeof row.content === "string" ? row.content : typeof row.description === "string" ? row.description : "";
      const content = text(snippet, 262144);
      const titleRaw = row.title === null || row.title === undefined ? "" : text(row.title, 4096);
      const cleaned = clean(titleRaw, content);
      evidence.push({ requestedUrl: null, url, finalUrl: null, title: cleaned.title, content: cleaned.content,
        coverage: "snippet", publishedAt: null, reportedRetrievedAt: stamp(row.acquired_at), freshness: "unknown", cache: null,
        truncated: false, untrusted: true });
    }
    return { evidence, missing: [], failures: [], usage: null, sessionId: null, omittedResults: Math.max(0, root.results.length - evidence.length), partial };
  }

  private normalizeFetch(requested: string, fullContent: boolean, data: unknown): ParallelResult {
    const row = object(data), url = typeof row.url === "string" && row.url ? text(row.url, 8192) : requested;
    publicOutbound(url, true);
    const body = typeof row.content === "string" && row.content ? row.content : typeof row.description === "string" ? row.description : "";
    const content = text(body, 262144);
    const titleRaw = row.title === null || row.title === undefined ? "" : text(row.title, 4096);
    const cleaned = clean(titleRaw, content);
    const evidence: ParallelResult["evidence"] = [{ requestedUrl: url === requested || publicWebUrl(url).href === publicWebUrl(requested).href ? requested : null,
      url, finalUrl: url !== requested ? url : null, title: cleaned.title, content: cleaned.content,
      coverage: fullContent ? "full_content_returned" : "excerpt", publishedAt: null, reportedRetrievedAt: null,
      freshness: "unknown", cache: null, truncated: false, untrusted: true }];
    const missing = cleaned.content.length > 0 ? [] : [requested];
    return { evidence, missing, failures: [], usage: null, sessionId: null, omittedResults: 0, partial: missing.length > 0 };
  }

  /** SearchProvider preserves the keyless identity; richer evidence remains in last for the trusted gateway. */
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
