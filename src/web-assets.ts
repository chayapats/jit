import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { iconSpecs } from "./web-icons";
import { appIcon, faviconSvg } from "./web-logo";
import { styleSheet } from "./web-style";

/**
 * web.static_assets/v1 — the fixed, content-hashed browser asset table (ADR 0028).
 *
 * Every browser asset (stylesheet, enhancement script, fonts, icons, web app manifest, font licences) is listed here and
 * served by Jit from its own origin at `/assets/<name>.<hash>.<ext>`. The hash is the first 16 hex digits
 * of the SHA-256 of the exact bytes served, so a URL always names one immutable body and can be cached for
 * a year. The table is built once at startup from files shipped in `src/web-assets`; there is no bundler,
 * no remote origin and no owner or project data in any asset. Unknown asset paths are 404.
 */
export interface StaticAsset {
  /** Logical name used by renderers, e.g. `app.css`. */
  readonly name: string;
  /** Content-hashed public path, e.g. `/assets/app.3f2a…css`. */
  readonly path: string;
  readonly contentType: string;
  readonly hash: string;
  readonly body: Uint8Array<ArrayBuffer>;
}

export type AssetName = "app.css" | "app.js" | "attachments.js" | "favicon.svg" | "inter.woff2" | "noto-sans-thai.woff2" | "jetbrains-mono.woff2"
  | "icon-192.png" | "icon-512.png" | "icon-maskable-512.png" | "apple-touch-icon.png" | "manifest.webmanifest"
  | "OFL-Inter.txt" | "OFL-NotoSansThai.txt" | "OFL-JetBrainsMono.txt";

const root = join(import.meta.dir, "web-assets");
const types: Record<string, string> = {
  css: "text/css; charset=utf-8", js: "text/javascript; charset=utf-8", svg: "image/svg+xml", woff2: "font/woff2", txt: "text/plain; charset=utf-8",
  png: "image/png", webmanifest: "application/manifest+json",
};

function asset(name: AssetName, body: Uint8Array<ArrayBuffer>): StaticAsset {
  const hash = createHash("sha256").update(body).digest("hex").slice(0, 16);
  const dot = name.lastIndexOf(".");
  const extension = name.slice(dot + 1);
  return Object.freeze({ name, path: `/assets/${name.slice(0, dot)}.${hash}.${extension}`, contentType: types[extension]!, hash, body });
}
const file = (relative: string) => new Uint8Array(readFileSync(join(root, relative)));

function buildTable(): ReadonlyMap<AssetName, StaticAsset> {
  const fonts = {
    inter: asset("inter.woff2", file("fonts/Inter-Variable.woff2")),
    thai: asset("noto-sans-thai.woff2", file("fonts/NotoSansThai-Variable.woff2")),
    mono: asset("jetbrains-mono.woff2", file("fonts/JetBrainsMono-Variable.woff2")),
  };
  const encode = (text: string) => new TextEncoder().encode(text);
  const icons = iconSpecs.map(spec => ({ spec, asset: asset(spec.file as AssetName, file(`icons/${spec.file}`)) }));
  const list = [
    fonts.inter, fonts.thai, fonts.mono,
    // The stylesheet embeds the hashed font URLs, so its own hash changes whenever a font does.
    asset("app.css", encode(styleSheet({ inter: fonts.inter.path, thai: fonts.thai.path, mono: fonts.mono.path }))),
    asset("app.js", file("app.js")),
    // app.attachments/v1 (ATT03): the composer's upload module, loaded only on topic pages while the gate is on.
    asset("attachments.js", file("attachments.js")),
    asset("favicon.svg", encode(faviconSvg)),
    ...icons.map(icon => icon.asset),
    // web.pwa/v1: the manifest names the hashed icons, so its own hash changes whenever an icon does.
    asset("manifest.webmanifest", encode(webManifest(icons.filter(icon => icon.spec.purpose !== "touch")
      .map(icon => ({ src: icon.asset.path, sizes: `${icon.spec.size}x${icon.spec.size}`, type: "image/png", purpose: icon.spec.purpose })), appIcon.tile.background))),
    asset("OFL-Inter.txt", file("fonts/OFL-Inter.txt")),
    asset("OFL-NotoSansThai.txt", file("fonts/OFL-NotoSansThai.txt")),
    asset("OFL-JetBrainsMono.txt", file("fonts/OFL-JetBrainsMono.txt")),
  ];
  return new Map(list.map(item => [item.name as AssetName, item]));
}

/** The process-wide asset table, keyed by logical name. */
export const staticAssets: ReadonlyMap<AssetName, StaticAsset> = buildTable();
const byPath = new Map([...staticAssets.values()].map(item => [item.path, item]));

/** Content-hashed URL of a known asset. */
export function assetUrl(name: AssetName): string {
  return staticAssets.get(name)!.path;
}

/** Resolves an exact public asset path; anything else (old hashes, traversal, unknown names) is null. */
export function lookupAsset(pathname: string): StaticAsset | null {
  return byPath.get(pathname) ?? null;
}

/**
 * web.pwa/v1 manifest: language-neutral (the product name is the same in both languages), standalone, scoped to the
 * whole origin and opened at `/`, which signs in or opens the home. Colours are the dark tile of the icon.
 */
function webManifest(icons: { src: string; sizes: string; type: string; purpose: string }[], color: string): string {
  return JSON.stringify({ id: "/", name: "Jit", short_name: "Jit", start_url: "/", scope: "/", display: "standalone", background_color: color, theme_color: color, icons });
}
