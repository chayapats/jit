import type { SearchProvider, SearchResult } from "schway/host";
import { AppError } from "../errors";

/** Trusted protocol-fixture seam; production sends only to the adapter's fixed HTTPS endpoint. */
export type WebSearchTransport = (url: string, init: RequestInit) => Promise<Response>;
const responseLimit = 256 * 1024;

async function boundedJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) { await response.body?.cancel(); throw new AppError("web_provider_unavailable", 503); }
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > responseLimit) throw new AppError("web_provider_response_too_large", 503);
      chunks.push(chunk.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

function keyProvider(id: "tavily" | "exa", secret: string, transport: WebSearchTransport): SearchProvider {
  if (!secret.trim()) throw new AppError("web_connection_unavailable", 409);
  return { id, async search(query, options): Promise<readonly SearchResult[]> {
    if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 20 || !query.trim() || Buffer.byteLength(query) > 8192) throw new AppError("invalid_web_search");
    const signal = AbortSignal.any([options.signal, AbortSignal.timeout(15000)]);
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (id === "tavily") headers.Authorization = `Bearer ${secret}`;
    else headers["x-api-key"] = secret;
    const body = id === "tavily"
      ? { query, max_results: options.limit, search_depth: "basic", auto_parameters: false, include_answer: false, include_raw_content: false, include_images: false }
      : { query, numResults: options.limit, type: "auto", contents: { highlights: true } };
    try {
      const response = await transport(id === "tavily" ? "https://api.tavily.com/search" : "https://api.exa.ai/search", {
        method: "POST", headers, body: JSON.stringify(body), signal, redirect: "error", credentials: "omit", referrerPolicy: "no-referrer",
      });
      const value = await boundedJson(response);
      const results = value && typeof value === "object" ? (value as { results?: unknown }).results : null;
      if (!Array.isArray(results)) throw new AppError("web_provider_unavailable", 503);
      return results.slice(0, options.limit).map((item: unknown) => {
        if (!item || typeof item !== "object") throw new AppError("web_provider_unavailable", 503);
        const row = item as { title?: unknown; url?: unknown; content?: unknown; highlights?: unknown };
        if (typeof row.url !== "string" || typeof row.title !== "string") throw new AppError("web_provider_unavailable", 503);
        const snippet = id === "tavily" ? row.content : Array.isArray(row.highlights) && row.highlights.every(part => typeof part === "string") ? row.highlights.join("\n") : "";
        if (typeof snippet !== "string") throw new AppError("web_provider_unavailable", 503);
        return { title: row.title, url: row.url, snippet };
      });
    } catch {
      // Neither provider response bodies nor transport diagnostics (which can echo a key) leave this boundary.
      throw new AppError("web_provider_unavailable", 503);
    }
  } };
}

/** Bounded Tavily Search adapter; the vault value stays in its closure and is sent only as the provider auth header. */
export function createTavilyProvider(secret: string, transport: WebSearchTransport = fetch): SearchProvider { return keyProvider("tavily", secret, transport); }
/** Bounded Exa Search adapter; returns citation highlights and never selects another provider or billing route. */
export function createExaProvider(secret: string, transport: WebSearchTransport = fetch): SearchProvider { return keyProvider("exa", secret, transport); }
