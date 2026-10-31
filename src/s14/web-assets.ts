import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { assetUrl, lookupAsset, type AssetName, type StaticAsset } from "../web-assets";
import { s14StyleSheet } from "./web-style";
import { s14BackupStyleSheet } from "./web-style-backup";
import { s14FirstRunStyleSheet } from "./web-style-first-run";
import { s14MemoryStyleSheet } from "./web-style-memory";
import { s14RoutineStyleSheet } from "./web-style-routines";
import { s14SharingStyleSheet } from "./web-style-sharing";
import { s14TeamStyleSheet } from "./web-style-team";

/** S14-only hashed assets; the legacy table keeps serving the fonts, base stylesheet and favicon unchanged. */
export type S14AssetName = "s14.css" | "s14.js";
function asset(name: S14AssetName, contentType: string, source: string): StaticAsset {
  const body = new TextEncoder().encode(source), hash = createHash("sha256").update(body).digest("hex").slice(0, 16), dot = name.lastIndexOf(".");
  return Object.freeze({ name, path: `/assets/${name.slice(0, dot)}.${hash}.${name.slice(dot + 1)}`, contentType, hash, body: new Uint8Array(body) });
}
const own: ReadonlyMap<S14AssetName, StaticAsset> = new Map<S14AssetName, StaticAsset>([
  ["s14.css", asset("s14.css", "text/css; charset=utf-8", s14StyleSheet() + s14MemoryStyleSheet() + s14TeamStyleSheet() + s14FirstRunStyleSheet() + s14SharingStyleSheet() + s14RoutineStyleSheet() + s14BackupStyleSheet())],
  ["s14.js", asset("s14.js", "text/javascript; charset=utf-8", readFileSync(join(import.meta.dir, "web-enhance.js"), "utf8"))],
]);
const byPath = new Map([...own.values()].map(item => [item.path, item]));
/** Content-hashed URL of one S14 or shared browser asset. */
export const s14AssetUrl = (name: S14AssetName | AssetName): string => own.get(name as S14AssetName)?.path ?? assetUrl(name as AssetName);
/** Resolves an exact public asset path; unknown names, old hashes and traversal stay null. */
export const lookupS14Asset = (pathname: string): StaticAsset | null => byPath.get(pathname) ?? lookupAsset(pathname);
