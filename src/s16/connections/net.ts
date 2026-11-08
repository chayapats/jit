import { AppError } from "../../errors";
import { openBrowserEgress, type BrowserEgress, type BrowserEgressPorts } from "../../s15/browser/egress";
import { BrowserError } from "../../s15/browser/validation";

/**
 * Protected network for connected sources (ADR 0089). Every request leaves through the protected browser's checked egress
 * (BROW15-03): the host name is resolved once, every answer must be a public address (loopback, private, link-local,
 * metadata, unique-local, mapped and documentation addresses refuse with `source_address_not_public`), and the socket
 * dials exactly the checked address, so DNS rebinding cannot reach the host or the working VM. Redirects are refused
 * (`source_redirect_refused`): a source cannot move a request (or its credential) to another destination. Responses are
 * read up to a finite byte bound. Proxy variables and connection reuse are never used.
 */
export interface SourceResponse { status: number; headers: Headers; text: string }
/** One checked destination: `send` makes exactly one request to it. */
export interface SourceRoute { send(init: SendInit): Promise<SourceResponse>; close(): void }
/** One request. `complete` (optional) is asked after every received chunk with the response content type and the text
 * so far; returning true ends the read early (an event stream whose matching reply has arrived but stays open). */
export interface SendInit { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal; timeoutMs: number; maxBytes: number; complete?: (contentType: string, text: string) => boolean }
export interface SourceNetwork {
  /** Canonical endpoint URL, or `source_endpoint_invalid`. HTTPS only (fixtures may allow plain HTTP). */
  validate(url: string): string;
  /** Resolve and check the destination; nothing is sent yet. */
  open(url: string): Promise<SourceRoute>;
  /** Convenience: open, send once and close. */
  request(url: string, init: Parameters<SourceRoute["send"]>[0]): Promise<SourceResponse>;
  close(): void;
}
/** Deterministic seams for tests only; production composition passes none. The public-address rule is not a seam. */
export interface SourceNetworkPorts extends BrowserEgressPorts { allowHttp?: boolean }

/** Validate an owner/source-supplied endpoint. Credentials in the URL, fragments and non-HTTPS schemes refuse. */
export function sourceUrl(input: unknown, allowHttp = false): URL {
  if (typeof input !== "string" || !input || Buffer.byteLength(input) > 2048 || /[\u0000- \u007f]/.test(input)) throw new AppError("source_endpoint_invalid");
  let url: URL; try { url = new URL(input); } catch { throw new AppError("source_endpoint_invalid"); }
  if (!(url.protocol === "https:" || allowHttp && url.protocol === "http:") || url.username || url.password || url.hash || !url.hostname) throw new AppError("source_endpoint_invalid");
  const host = url.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal")) throw new AppError("source_address_not_public");
  return url;
}

const mapped = (error: unknown): AppError => {
  if (error instanceof AppError) return error;
  if (error instanceof BrowserError) return new AppError(error.code === "website_address_not_public" ? "source_address_not_public" : error.code === "invalid_url" ? "source_endpoint_invalid" : "source_unreachable", error.code === "invalid_url" ? 400 : 502);
  return new AppError("source_unreachable", 502);
};

/** Read at most `max` bytes; a longer body refuses (`source_response_too_large`). `complete` may end the read early. */
async function bounded(response: Response, max: number, complete?: SendInit["complete"]): Promise<string> {
  const reader = response.body?.getReader(); if (!reader) return "";
  const type = (response.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const decoder = new TextDecoder("utf-8"); let text = "", length = 0;
  try {
    for (;;) {
      const chunk = await reader.read(); if (chunk.done) break;
      length += chunk.value.length; if (length > max) { await reader.cancel().catch(() => {}); throw new AppError("source_response_too_large", 502); }
      text += decoder.decode(chunk.value, { stream: true });
      if (complete?.(type, text)) { await reader.cancel().catch(() => {}); return text; }
    }
  } finally { reader.releaseLock(); }
  return text + decoder.decode();
}

export function openSourceNetwork(ports: SourceNetworkPorts = {}): SourceNetwork {
  let egress: BrowserEgress | null = null;
  const allowHttp = ports.allowHttp === true;
  const network: SourceNetwork = {
    validate(url) { return sourceUrl(url, allowHttp).href; },
    async open(url) {
      const target = sourceUrl(url, allowHttp).href;
      egress ??= openBrowserEgress({ ...(ports.resolve ? { resolve: ports.resolve } : {}), ...(ports.connect ? { connect: ports.connect } : {}) });
      let route: Awaited<ReturnType<BrowserEgress["route"]>>;
      try { route = await egress.route(target); } catch (error) { throw mapped(error); }
      let used = false;
      return {
        async send(init) {
          if (used) throw new AppError("source_unreachable", 502); used = true;
          const signal = init.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(init.timeoutMs)]) : AbortSignal.timeout(init.timeoutMs);
          let response: Response;
          try { response = await route.fetch(target, { method: init.method, headers: init.headers, ...(init.body !== undefined ? { body: init.body } : {}), redirect: "manual", signal }); }
          catch (error) { throw mapped(error); }
          if (response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); throw new AppError("source_redirect_refused", 502); }
          try { return { status: response.status, headers: response.headers, text: await bounded(response, init.maxBytes, init.complete) }; }
          catch (error) { throw mapped(error); }
        },
        close() { route.close(); },
      };
    },
    async request(url, init) { const route = await network.open(url); try { return await route.send(init); } finally { route.close(); } },
    close() { egress?.close(); egress = null; },
  };
  return network;
}
