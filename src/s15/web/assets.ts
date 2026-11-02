import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { StaticAsset } from "../../web-assets";
import { lookupS14Asset } from "../../s14/web-assets";
import { CREDENTIAL_PATTERNS } from "../../security/credentials";
import { s15StyleSheet } from "./style";

/** S15-only hashed assets. Shared fonts, base and S14 Plain stylesheets come from the existing tables unchanged. */
export type S15AssetName = "s15.css" | "s15.js";
function asset(name: S15AssetName, contentType: string, source: string): StaticAsset {
  const body = new TextEncoder().encode(source), hash = createHash("sha256").update(body).digest("hex").slice(0, 16), dot = name.lastIndexOf(".");
  return Object.freeze({ name, path: `/assets/${name.slice(0, dot)}.${hash}.${name.slice(dot + 1)}`, contentType, hash, body: new Uint8Array(body) });
}
const own: ReadonlyMap<S15AssetName, StaticAsset> = new Map<S15AssetName, StaticAsset>([
  ["s15.css", asset("s15.css", "text/css; charset=utf-8", s15StyleSheet())],
  // Only public detector shapes enter the browser, so a credential-shaped draft is never kept locally.
  ["s15.js", asset("s15.js", "text/javascript; charset=utf-8", `const s15CredentialPatterns = ${JSON.stringify(CREDENTIAL_PATTERNS.map(({ pattern }) => [pattern.source, pattern.flags.replace("g", "")]))}.map(([source, flags]) => new RegExp(source, flags));\n` + readFileSync(join(import.meta.dir, "enhance.js"), "utf8"))],
]);
const byPath = new Map([...own.values()].map(item => [item.path, item]));
/** Content-hashed URL of one S15 asset. */
export const s15AssetUrl = (name: S15AssetName): string => own.get(name)!.path;
/** Exact public asset path lookup across the S15, S14 and shared tables; unknown names and old hashes stay null. */
export const lookupS15Asset = (pathname: string): StaticAsset | null => byPath.get(pathname) ?? lookupS14Asset(pathname);
