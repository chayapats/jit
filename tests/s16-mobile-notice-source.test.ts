import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { mobilePublicSuffixProvenance, mobilePublicSuffixSource, reconstructMobilePublicSuffix, verifyMobilePublicSuffixNotices, type MobilePublicSuffixPin } from "../ops/mobile/notices";

const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jit-mobile-notices-")), input = join(root, "clients/mobile/native-inputs"), notices = join(root, "clients/mobile/notices");
  mkdirSync(input, { recursive: true }); mkdirSync(notices);
  const rules = Buffer.from("*.example\ncom\n中国\n"), exceptions = Buffer.from("city.example\n"), a = Buffer.alloc(4), b = Buffer.alloc(4); a.writeUInt32BE(rules.length); b.writeUInt32BE(exceptions.length);
  const compressed = gzipSync(Buffer.concat([a, rules, b, exceptions]));
  const pin: MobilePublicSuffixPin = { coordinate: "com.squareup.okhttp3:okhttp:4.9.2", jarSha256: "a".repeat(64), compressedSha256: hash(compressed), source: "public-suffix-list.txt", sourceSha256: "b".repeat(64), license: "MPL-2.0" };
  const sourceText = reconstructMobilePublicSuffix(pin, compressed); pin.sourceSha256 = hash(sourceText);
  const native = { contract: "s16-mobile-native-notices/v1", publicSuffix: pin }, android = { contract: "s16-mobile-android-inputs/v1", artifacts: [{ coordinate: pin.coordinate, file: "okhttp-4.9.2.jar", sha256: pin.jarSha256 }] };
  const index = { contract: "s16-mobile-notices/v1", components: [{ id: "Public Suffix List in OkHttp 4.9.2", license: "MPL-2.0", notices: ["license"] }, { id: "Public Suffix List / corresponding source", license: "MPL-2.0", notices: [pin.sourceSha256] }], texts: [{ id: pin.sourceSha256, text: sourceText }] };
  const provenance = { contract: "s16-mobile-license-provenance/v1", entries: [mobilePublicSuffixProvenance({ pin, version: "4.9.2", sourceText })] };
  const save = () => { for (const [path, value] of [[join(input, "notices.json"), native], [join(input, "android.json"), android], [join(notices, "index.json"), index], [join(notices, "provenance.json"), provenance]] as const) writeFileSync(path, JSON.stringify(value)); writeFileSync(join(input, pin.source), sourceText); };
  save(); return { root, project: join(root, "clients/mobile"), input, pin, android, index, provenance, compressed, sourceText, save, close: () => rmSync(root, { recursive: true, force: true }) };
}

test("corresponding source and shipped notices bind the selected runtime coordinate and JAR", () => {
  const f = fixture(); try { const actual = verifyMobilePublicSuffixNotices(f.project); expect(actual.pin).toEqual(f.pin); expect(actual.sourceText).toContain("!city.example\n"); expect(actual.sourceText).toContain("中国\n"); } finally { f.close(); }
});

test("a valid own source hash cannot substitute another OkHttp version or JAR", () => {
  const f = fixture(); try {
    f.android.artifacts[0]!.coordinate = "com.squareup.okhttp3:okhttp:4.12.0"; f.save(); expect(() => mobilePublicSuffixSource(f.project)).toThrow("mobile_public_suffix_runtime_mismatch");
    f.android.artifacts[0]!.coordinate = f.pin.coordinate; f.android.artifacts[0]!.sha256 = "c".repeat(64); f.save(); expect(() => mobilePublicSuffixSource(f.project)).toThrow("mobile_public_suffix_runtime_mismatch");
    f.android.artifacts[0]!.sha256 = f.pin.jarSha256; f.android.artifacts.push({ ...f.android.artifacts[0]! }); f.save(); expect(() => mobilePublicSuffixSource(f.project)).toThrow("mobile_public_suffix_runtime_mismatch");
    f.android.artifacts.length = 0; f.save(); expect(() => mobilePublicSuffixSource(f.project)).toThrow("mobile_public_suffix_runtime_mismatch");
  } finally { f.close(); }
});

test("regeneration reads both bounded gzip sections and refuses a different or truncated member", () => {
  const f = fixture(); try {
    expect(reconstructMobilePublicSuffix(f.pin, f.compressed)).toBe(f.sourceText);
    expect(() => reconstructMobilePublicSuffix(f.pin, gzipSync(Buffer.from("different")))).toThrow("mobile_public_suffix_compressed_changed");
    const malformed = gzipSync(Buffer.from([0, 0, 0, 8, 1])); expect(() => reconstructMobilePublicSuffix({ ...f.pin, compressedSha256: hash(malformed) }, malformed)).toThrow("mobile_public_suffix_invalid");
    const oversized = gzipSync(Buffer.alloc(1048577, 65)); expect(() => reconstructMobilePublicSuffix({ ...f.pin, compressedSha256: hash(oversized) }, oversized)).toThrow();
  } finally { f.close(); }
});

test("changed source, stale component labels and provenance cannot ship as matching notices", () => {
  const f = fixture(); try {
    writeFileSync(join(f.input, f.pin.source), f.sourceText + "changed\n"); expect(() => verifyMobilePublicSuffixNotices(f.project)).toThrow("mobile_public_suffix_source_changed"); f.save();
    f.index.components[0]!.id = "Public Suffix List in OkHttp 4.12.0"; f.save(); expect(() => verifyMobilePublicSuffixNotices(f.project)).toThrow("mobile_public_suffix_notice_mismatch");
    f.index.components[0]!.id = "Public Suffix List in OkHttp 4.9.2"; f.provenance.entries[0]!.jarSha256 = "d".repeat(64); f.save(); expect(() => verifyMobilePublicSuffixNotices(f.project)).toThrow("mobile_public_suffix_provenance_mismatch");
  } finally { f.close(); }
});

test("checked-in corresponding source qualifies against the frozen runtime and shipped notices", () => {
  const root = resolve(import.meta.dir, ".."), binding = verifyMobilePublicSuffixNotices(join(root, "clients/mobile"));
  expect(binding.pin.coordinate).toBe("com.squareup.okhttp3:okhttp:4.9.2"); expect(binding.pin.jarSha256).toBe("3b2ee1b768c1df28c30d2fe6b38dda4d2c519210e30ca3d27950618c563c92de");
  expect(readFileSync(join(root, "clients/mobile/native-inputs", binding.pin.source), "utf8")).toBe(binding.sourceText);
});
