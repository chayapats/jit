import { readFileSync } from "node:fs";
import { AppError } from "../../errors";
import { negotiateLocale } from "../../i18n";
import { resolve } from "node:path";
import { browserLicenseHeader } from "../../../ops/package/upstream";
import { s16WorkerHeaders, s16WorkerPath, s16WorkerScript } from "./worker";

/** Bun-built React surface over the protected client API. No inline script, second auth or server. */
export async function createS16WebHandler(authenticate: (request: Request) => Promise<Response>): Promise<(request: Request) => Promise<Response>> {
  const built = await Bun.build({ entrypoints: [new URL("./app.tsx", import.meta.url).pathname], target: "browser", minify: true, metafile: true, define: { "process.env.NODE_ENV": JSON.stringify("production") } });
  if (!built.success || built.outputs.length !== 1 || !built.metafile) throw new AppError("client_build_unavailable", 503);
  const script = browserLicenseHeader(resolve(import.meta.dir, "../../.."), built.metafile.inputs) + await built.outputs[0]!.text(), style = readFileSync(new URL("./style.css", import.meta.url), "utf8");
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'", Vary: "Cookie, Accept-Language" };
  const worker = s16WorkerScript();
  return async request => {
    const url = new URL(request.url);
    // The notification worker carries no private data; the browser fetches its updates without relying on a session.
    if (url.pathname === s16WorkerPath) return request.method === "GET" && !url.search ? new Response(worker, { headers: s16WorkerHeaders }) : new Response("", { status: 405, headers });
    const checked = await authenticate(new Request(new URL("/api/s16/client/session", url), { headers: request.headers }));
    if (!checked.ok) return checked;
    await checked.body?.cancel();
    if (request.method !== "GET" || url.search) return new Response("", { status: 405, headers });
    if (url.pathname === "/s16/client.js") return new Response(script, { headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === "/s16/style.css") return new Response(style, { headers: { ...headers, "Content-Type": "text/css; charset=utf-8" } });
    if (url.pathname !== "/s16" && url.pathname !== "/s16/memory" && !/^\/s16\/(?:chat|artifacts|routines|bots)\/[A-Za-z0-9_-]{1,128}$/.test(url.pathname) && url.pathname !== "/s16/artifacts" && url.pathname !== "/s16/routines" && url.pathname !== "/s16/bots" && url.pathname !== "/s16/computers" && url.pathname !== "/s16/connections") return new Response("", { status: 404, headers });
    const locale = negotiateLocale(request.headers.get("accept-language"));
    return new Response(`<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Jit</title><link rel="stylesheet" href="/s16/style.css"><script type="module" src="/s16/client.js"></script></head><body><div id="root"></div></body></html>`, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  };
}
