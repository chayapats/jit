import { basename } from "node:path";
import { negotiateLocale } from "../i18n";
import { s14ContentSecurityPolicy } from "./web";
import { lookupS14Asset } from "./web-assets";
import { renderRefusal } from "./web-pages";

/** Read-only refusal surface: GET pages explain, every other method fails, and no store, lock or worker is opened. */
export function createS14RefusalHandler(store: string): (request: Request) => Response {
  // Unauthenticated page: name the selected file, not the full installation path.
  const name = basename(store);
  return request => {
    const url = new URL(request.url), headers = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": s14ContentSecurityPolicy };
    if (request.method !== "GET") return new Response(JSON.stringify({ error: "s14_fresh_state_required" }), { status: 409, headers: { ...headers, "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" } });
    const asset = url.pathname.startsWith("/assets/") ? lookupS14Asset(url.pathname) : null;
    if (asset) return new Response(asset.body, { headers: { ...headers, "Content-Type": asset.contentType, "Cache-Control": "public, max-age=31536000, immutable" } });
    return new Response(renderRefusal(negotiateLocale(request.headers.get("accept-language")), name), { status: 409, headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store", Vary: "Accept-Language" } });
  };
}
/** Binds the refusal surface to the loopback origin until the process is stopped; the exit code stays the refusal's. */
export function serveS14Refusal(store: string, origin: string): void {
  const url = new URL(origin); if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) return;
  const fetch = createS14RefusalHandler(store), server = Bun.serve({ hostname: url.hostname === "[::1]" ? "::1" : url.hostname, port: Number(url.port || 80), fetch });
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => { server.stop(true); process.exit(1); });
}
