import { createHash } from "node:crypto";

/** One public, content-addressed member of `s16-desktop-release/v1`. No owner or service data is permitted. */
export interface DesktopAsset { path: string; sha256: string; bytes: number; contentType: string }
/** Immutable public client inventory embedded in the trusted worker, never accepted from a page message. */
export interface DesktopRelease { contract: "s16-desktop-release/v1"; id: string; assets: DesktopAsset[]; shells: { en: string; th: string }; manifest: string }
/** Generated release with the exact bytes served and verified by the browser. */
export interface DesktopPackage { release: DesktopRelease; bodies: ReadonlyMap<string, Uint8Array<ArrayBuffer>> }
const encoder = new TextEncoder();
const hash = (body: Uint8Array) => createHash("sha256").update(body).digest("hex");
/** Maximum size/count of a public client package; never a private response-cache budget. */
export const desktopLimits = Object.freeze({ assets: 12, assetBytes: 4 * 1024 * 1024, packageBytes: 8 * 1024 * 1024 });

/**
 * Builds a standalone browser-owned client package over the existing service. Only explicitly supplied public
 * source and existing Jit icons enter it; no Request, session, hostname or API projection is an input.
 */
export function buildDesktopPackage(input: { script: string; style: string; worklet: string; icons: { size: 192 | 512; body: Uint8Array<ArrayBuffer> }[] }): DesktopPackage {
  const assets: DesktopAsset[] = [], bodies = new Map<string, Uint8Array<ArrayBuffer>>();
  const add = (name: string, body: Uint8Array<ArrayBuffer>, contentType: string) => {
    if (body.byteLength > desktopLimits.assetBytes) throw new Error("desktop_asset_limit");
    const sha256 = hash(body), path = `/s16/assets/${sha256}/${name}`;
    if (bodies.has(path)) throw new Error("desktop_asset_duplicate");
    assets.push({ path, sha256, bytes: body.byteLength, contentType }); bodies.set(path, body); return path;
  };
  const script = add("client.js", encoder.encode(input.script), "text/javascript; charset=utf-8");
  const style = add("style.css", encoder.encode(input.style), "text/css; charset=utf-8");
  add("voice-worklet.js", encoder.encode(input.worklet), "text/javascript; charset=utf-8");
  if (input.icons.length !== 2 || !input.icons.some(icon => icon.size === 192) || !input.icons.some(icon => icon.size === 512)) throw new Error("desktop_icons_invalid");
  const icons = input.icons.map(icon => ({ src: add(`icon-${icon.size}.png`, icon.body, "image/png"), sizes: `${icon.size}x${icon.size}`, type: "image/png", purpose: "any" }));
  const manifest = add("manifest.webmanifest", encoder.encode(JSON.stringify({ id: "/s16/", name: "Jit", short_name: "Jit", start_url: "/s16/", scope: "/s16/", display: "standalone", background_color: "#101116", theme_color: "#101116", icons })), "application/manifest+json");
  const shell = (locale: "en" | "th") => `<!doctype html><html lang="${locale}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="theme-color" content="#101116"><title>Jit</title><link rel="manifest" href="${manifest}"><link rel="icon" href="${icons[0]!.src}"><link rel="stylesheet" href="${style}"><script type="module" src="${script}"></script></head><body><div id="root"></div></body></html>`;
  const shells = { en: add("shell-en.html", encoder.encode(shell("en")), "text/html; charset=utf-8"), th: add("shell-th.html", encoder.encode(shell("th")), "text/html; charset=utf-8") };
  assets.sort((a, b) => a.path.localeCompare(b.path));
  if (assets.length > desktopLimits.assets || assets.reduce((sum, asset) => sum + asset.bytes, 0) > desktopLimits.packageBytes) throw new Error("desktop_package_limit");
  const id = hash(encoder.encode(JSON.stringify({ contract: "s16-desktop-release/v1", assets, shells, manifest })));
  return { release: { contract: "s16-desktop-release/v1", id, assets, shells, manifest }, bodies };
}

/** Valid S16 document targets only: navigation never carries an action, arbitrary scheme or query command. */
export function desktopDocument(path: string): boolean {
  return /^\/s16(?:\/?|\/(?:search|memory|artifacts|routines|bots|computers|connections)|\/(?:chat|artifacts|routines|bots)\/[A-Za-z0-9_-]{1,128})$/.test(path);
}
