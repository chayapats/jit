import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { staticAssets, type StaticAsset } from "./web-assets";

/**
 * web.pwa/v1 — the static-only installable app (S09-D13, ADR 0028).
 *
 * The web app manifest and the install icons are entries of the hashed asset table (web.static_assets/v1). The
 * service worker lives at the fixed path {@link serviceWorkerPath}, because a worker's URL must stay the same for the
 * browser to find its updates; it is public, served `no-store`, and carries the ADR 0028 CSP like every response.
 *
 * Its cache allowlist is {@link offlineAssets}: the stylesheet, scripts, fonts and icons of the asset table, and
 * nothing else. Font licences and the manifest are left to the network, and pages, API, event streams and every
 * authenticated or owner response are never cached. {@link offlineVersion} names the cache; any change to an
 * allowlisted asset changes it, so the next worker opens a new cache and deletes the old ones.
 */
export const serviceWorkerPath = "/sw.js";

/** The assets the service worker precaches and serves from its cache, in table order. */
export const offlineAssets: readonly StaticAsset[] = Object.freeze([...staticAssets.values()].filter(asset => /\.(?:css|js|woff2|svg|png)$/.test(asset.path)));

/** First 16 hex digits of the SHA-256 of the sorted allowlisted paths (each path already carries its content hash). */
export const offlineVersion: string = createHash("sha256").update(offlineAssets.map(asset => asset.path).sort().join("\n")).digest("hex").slice(0, 16);

const placeholder = `const table = { version: "", paths: [] };`;

/** The served worker: the hand-written `src/web-assets/sw.js` with its asset line filled in for this version. */
export function serviceWorkerScript(): string {
  const template = readFileSync(join(import.meta.dir, "web-assets", "sw.js"), "utf8");
  if (template.split(placeholder).length !== 2) throw new Error("sw.js must contain its asset table line exactly once");
  return template.replace(placeholder, `const table = ${JSON.stringify({ version: offlineVersion, paths: offlineAssets.map(asset => asset.path) })};`);
}
