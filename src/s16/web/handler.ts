import { readFileSync } from "node:fs";
import { AppError } from "../../errors";
import { negotiateLocale } from "../../i18n";
import { resolve } from "node:path";
import { browserLicenseHeader } from "../../../ops/package/upstream";
import { s16WorkerHeaders, s16WorkerPath, s16WorkerScript } from "./worker";
import { buildDesktopPackage, desktopDocument } from "../desktop/release";
import { staticAssets } from "../../web-assets";

/** Bun-built React surface over the protected client API. No inline script, second auth or server. */
export async function createS16WebHandler(authenticate: (request: Request) => Promise<Response>, options: { origin?: string } = {}): Promise<(request: Request) => Promise<Response>> {
  const built = await Bun.build({ entrypoints: [new URL("./app.tsx", import.meta.url).pathname], target: "browser", minify: true, metafile: true, define: { "process.env.NODE_ENV": JSON.stringify("production") } });
  if (!built.success || built.outputs.length !== 1 || !built.metafile) throw new AppError("client_build_unavailable", 503);
  const script = browserLicenseHeader(resolve(import.meta.dir, "../../.."), built.metafile.inputs) + await built.outputs[0]!.text(), style = readFileSync(new URL("./style.css", import.meta.url), "utf8");
  const voiceWorklet = readFileSync(new URL('./voice-worklet.js', import.meta.url), 'utf8');
  const headers = { "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer", "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; font-src 'self'; connect-src 'self'; img-src 'self' blob:; media-src blob:; worker-src 'self'; manifest-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'", Vary: "Cookie, Accept-Language" };
  // The Jit typefaces ship inside the public package with their SIL OFL texts, so the installed client renders offline.
  const font = (file: string) => new Uint8Array(readFileSync(new URL(`../../web-assets/fonts/${file}`, import.meta.url)));
  const fonts = [{ name: "inter.woff2", body: font("Inter-Variable.woff2"), contentType: "font/woff2" }, { name: "noto-sans-thai.woff2", body: font("NotoSansThai-Variable.woff2"), contentType: "font/woff2" },
    { name: "font-licenses.txt", body: new TextEncoder().encode(["OFL-Inter.txt", "OFL-NotoSansThai.txt"].map(file => readFileSync(new URL(`../../web-assets/fonts/${file}`, import.meta.url), "utf8")).join("\n\n")), contentType: "text/plain; charset=utf-8" }];
  const packaged = buildDesktopPackage({ script, style, worklet: voiceWorklet, fonts, icons: ([192, 512] as const).map(size => ({ size, body: staticAssets.get(`icon-${size}.png`)!.body })) });
  const packagedStyle = new TextDecoder().decode(packaged.bodies.get(packaged.release.assets.find(asset => asset.path.endsWith("/style.css"))!.path)!);
  const publicAssets = new Map(packaged.release.assets.map(asset => [asset.path, asset]));
  const worker = s16WorkerScript({ release: packaged.release, csp: headers["Content-Security-Policy"] });
  const publicHeaders = { ...headers, "Cache-Control": "public, max-age=31536000, immutable", "Cross-Origin-Resource-Policy": "same-origin", Vary: "" };
  return async request => {
    const url = new URL(request.url);
    if (options.origin && (url.host !== new URL(options.origin).host || request.headers.has("host") && request.headers.get("host") !== new URL(options.origin).host)) return new Response("", { status: 403, headers });
    // The notification worker carries no private data; the browser fetches its updates without relying on a session.
    if (url.pathname === s16WorkerPath) return request.method === "GET" && !url.search ? new Response(worker, { headers: s16WorkerHeaders }) : new Response("", { status: 405, headers });
    const asset = publicAssets.get(url.pathname);
    if (asset) return request.method === "GET" && !url.search ? new Response(packaged.bodies.get(asset.path)!, { headers: { ...publicHeaders, "Content-Type": asset.contentType } }) : new Response("", { status: 405, headers });
    if (url.pathname.startsWith("/s16/assets/")) return new Response("", { status: 404, headers });
    if (url.pathname === "/s16/desktop-release.json") return request.method === "GET" && !url.search ? Response.json(packaged.release, { headers: { ...publicHeaders, "Cache-Control": "no-store" } }) : new Response("", { status: 405, headers });
    const checked = await authenticate(new Request(new URL("/api/s16/client/session", url), { headers: request.headers }));
    if (!checked.ok) return checked;
    await checked.body?.cancel();
    if (request.method !== "GET" || url.search) return new Response("", { status: 405, headers });
    if (url.pathname === "/s16/client.js") return new Response(script, { headers: { ...headers, "Content-Type": "text/javascript; charset=utf-8" } });
    if (url.pathname === '/s16/voice-worklet.js') return new Response(voiceWorklet, { headers: { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' } });
    if (url.pathname === "/s16/style.css") return new Response(packagedStyle, { headers: { ...headers, "Content-Type": "text/css; charset=utf-8" } });
    if (!desktopDocument(url.pathname)) return new Response("", { status: 404, headers });
    const locale = negotiateLocale(request.headers.get("accept-language"));
    return new Response(packaged.bodies.get(packaged.release.shells[locale])!, { headers: { ...headers, "Content-Type": "text/html; charset=utf-8" } });
  };
}
