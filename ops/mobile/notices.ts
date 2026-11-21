import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";

/** Reviewed corresponding-source pins for the selected Android runtime JAR, never a build-cache candidate. */
export interface MobilePublicSuffixPin {
  coordinate: string; jarSha256: string; compressedSha256: string;
  source: string; sourceSha256: string; license: "MPL-2.0";
}
/** Public source text qualified against the frozen release runtime, with no installation-specific path. */
export interface MobilePublicSuffixBinding { pin: MobilePublicSuffixPin; version: string; sourceText: string }
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const require = (value: unknown, code = "mobile_public_suffix_invalid"): void => { if (!value) throw Error(code); };
const digest = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
function read(path: string, maximum: number): string {
  const info = lstatSync(path);
  require(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size > 0 && info.size <= maximum);
  return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
}
function version(pin: MobilePublicSuffixPin): string {
  const found = /^com\.squareup\.okhttp3:okhttp:(\d+\.\d+\.\d+)$/.exec(pin.coordinate);
  require(found && digest(pin.jarSha256) && digest(pin.compressedSha256) && digest(pin.sourceSha256) && pin.source === "public-suffix-list.txt" && pin.license === "MPL-2.0");
  return found![1]!;
}
function header(pin: MobilePublicSuffixPin): string {
  return "// MPL-2.0. Source data from the Public Suffix List (publicsuffix.org).\n" +
    `// Modified by Jit: reconstructed the exact rule/exception text from ${pin.coordinate} publicsuffixes.gz; comments were not present in that artifact.\n` +
    `// Runtime JAR SHA-256: ${pin.jarSha256}\n// Compressed source SHA-256: ${pin.compressedSha256}\n` +
    "// Original notice is retained in the mobile license inventory.\n";
}

/** Reconstructs bounded rule/exception text from the exact pinned JAR member; performs no download. */
export function reconstructMobilePublicSuffix(pin: MobilePublicSuffixPin, compressed: Uint8Array): string {
  version(pin); require(compressed.length > 0 && compressed.length <= 1048576 && hash(compressed) === pin.compressedSha256, "mobile_public_suffix_compressed_changed");
  const bytes = gunzipSync(compressed, { maxOutputLength: 1048576 }); let offset = 0;
  const section = (): string[] => {
    require(offset + 4 <= bytes.length); const size = bytes.readUInt32BE(offset); offset += 4;
    require(size <= 524288 && offset + size <= bytes.length);
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(offset, offset + size)); offset += size;
    require(!/[\r\0]/.test(text) && (!text || text.endsWith("\n")));
    const rows = text ? text.slice(0, -1).split("\n") : []; require(rows.length <= 30000 && rows.every(row => row.length > 0)); return rows;
  };
  const rules = section(), exceptions = section(); require(offset === bytes.length && rules.length > 0);
  return header(pin) + [...rules, ...exceptions.map(rule => "!" + rule)].join("\n") + "\n";
}

/** Qualifies a native client or sealed distribution directory; another version's valid source hash still refuses. */
export function mobilePublicSuffixSource(project: string): MobilePublicSuffixBinding {
  const input = join(project, "native-inputs");
  const native = JSON.parse(read(join(input, "notices.json"), 8388608));
  const android = JSON.parse(read(join(input, "android.json"), 8388608));
  const pin = native.publicSuffix as MobilePublicSuffixPin;
  require(native.contract === "s16-mobile-native-notices/v1" && android.contract === "s16-mobile-android-inputs/v1" && pin && typeof pin === "object" && !Array.isArray(pin));
  require(Object.keys(pin).sort().join() === "compressedSha256,coordinate,jarSha256,license,source,sourceSha256");
  const selectedVersion = version(pin); require(Array.isArray(android.artifacts));
  const runtime = android.artifacts.filter((row: { coordinate?: unknown }) => typeof row?.coordinate === "string" && row.coordinate.startsWith("com.squareup.okhttp3:okhttp:"));
  require(runtime.length === 1 && runtime[0].coordinate === pin.coordinate && runtime[0].file === `okhttp-${selectedVersion}.jar` && runtime[0].sha256 === pin.jarSha256, "mobile_public_suffix_runtime_mismatch");
  const sourceText = read(join(input, pin.source), 1048576);
  require(hash(sourceText) === pin.sourceSha256 && sourceText.startsWith(header(pin)), "mobile_public_suffix_source_changed");
  return { pin, version: selectedVersion, sourceText };
}

/** Public provenance for the selected runtime and reconstructed source; contains no local cache path. */
export function mobilePublicSuffixProvenance(binding: MobilePublicSuffixBinding) {
  return { component: "Public Suffix List", license: binding.pin.license, coordinate: binding.pin.coordinate,
    jarSha256: binding.pin.jarSha256, compressedSha256: binding.pin.compressedSha256, source: binding.pin.source, sourceSha256: binding.pin.sourceSha256 };
}

/** Release preflight: the shipped source, notice index and provenance must all describe the selected runtime. */
export function verifyMobilePublicSuffixNotices(project: string): MobilePublicSuffixBinding {
  const binding = mobilePublicSuffixSource(project), output = join(project, "notices");
  const index = JSON.parse(read(join(output, "index.json"), 8388608)), provenance = JSON.parse(read(join(output, "provenance.json"), 1048576));
  require(index.contract === "s16-mobile-notices/v1" && Array.isArray(index.components) && Array.isArray(index.texts));
  const runtime = index.components.filter((row: { id?: unknown }) => typeof row?.id === "string" && row.id.startsWith("Public Suffix List in OkHttp "));
  const source = index.components.filter((row: { id?: unknown }) => row?.id === "Public Suffix List / corresponding source");
  const texts = index.texts.filter((row: { id?: unknown }) => row?.id === binding.pin.sourceSha256);
  require(runtime.length === 1 && runtime[0].id === "Public Suffix List in OkHttp " + binding.version && runtime[0].license === "MPL-2.0" &&
    source.length === 1 && source[0].license === "MPL-2.0" && Array.isArray(source[0].notices) && source[0].notices.length === 1 && source[0].notices[0] === binding.pin.sourceSha256 &&
    texts.length === 1 && texts[0].text === binding.sourceText, "mobile_public_suffix_notice_mismatch");
  require(provenance.contract === "s16-mobile-license-provenance/v1" && Array.isArray(provenance.entries));
  const entries = provenance.entries.filter((row: { component?: unknown }) => row?.component === "Public Suffix List"), expected = mobilePublicSuffixProvenance(binding);
  require(entries.length === 1 && Object.entries(expected).every(([key, value]) => entries[0][key] === value), "mobile_public_suffix_provenance_mismatch");
  return binding;
}
