import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileParser } from "../src/s16/files/parser";
import type { AttachmentSanitizerRuntime, SanitizeJob } from "../src/attachments/sanitizer-runtime";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const bytes = (value: string) => new TextEncoder().encode(value);
function fixture(run: AttachmentSanitizerRuntime["run"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-binary-parser-"))); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  let resets = 0, live = true, resetFails = false;
  const runtime = { s16: { contract: "s16-isolated-file/v1" as const, generation: "controlled-fixture-only" }, async available() { return live; }, async reset() { resets++; if (resetFails) throw Error("sanitizer_cleanup_failed"); }, run };
  const parser = new FileParser(runtime, join(root, "parser"), true); cleanups.push(() => parser.close());
  return { root, parser, get resets() { return resets; }, unavailable() { live = false; }, failReset() { resetFails = true; }, restoreReset() { resetFails = false; } };
}
const emit = (job: SanitizeJob, result: object, text = "Launch: Friday.\n") => {
  writeFileSync(join(job.output, "result.json"), JSON.stringify({ validation: "s16-isolated-file/v1", encrypted: false, ...result }), { mode: 0o600 });
  writeFileSync(join(job.output, "text.txt"), text, { mode: 0o600 });
};
test("PDF output is bounded complete UTF-8 with actual text, hash and page evidence", async () => {
  const f = fixture(async job => { expect(readdirSync(job.input)).toEqual(["input"]); expect(readFileSync(join(job.input, "input"), "utf8")).toBe("%PDF-fixture"); emit(job, { ok: true, pages: 2, truncated: false }); });
  const output = await f.parser.parse("pdf", bytes("%PDF-fixture"));
  expect(output.kind).toBe("pdf"); expect(new TextDecoder().decode(output.bytes)).toContain("Friday"); expect(output.sha256).toHaveLength(64); expect(readdirSync(join(f.root, "parser"))).toEqual([]);
});
for (const [reason, result, text] of [["truncated", { ok: true, pages: 50, truncated: true }, "partial"], ["pages", { ok: true, pages: 51, truncated: false }, "partial"], ["empty", { ok: true, pages: 1, truncated: false }, ""], ["nul", { ok: true, pages: 1, truncated: false }, "bad\0text"], ["encrypted", { ok: true, pages: 1, truncated: false, encrypted: true }, "partial"], ["expanded", { ok: true, pages: 1, truncated: false }, "x".repeat(65537)]] as const) test(`refuses incomplete/unsafe PDF extraction: ${reason}`, async () => {
  const f = fixture(async job => emit(job, result, text)); await expect(f.parser.parse("pdf", bytes("%PDF-fixture"))).rejects.toThrow(); expect(readdirSync(join(f.root, "parser"))).toEqual([]);
});
test("parser outputs cannot escape through symlinks or extra files", async () => {
  const f = fixture(async job => { emit(job, { ok: true, pages: 1, truncated: false }); symlinkSync("/etc/passwd", join(job.output, "extra")); });
  await expect(f.parser.parse("pdf", bytes("%PDF-fixture"))).rejects.toThrow();
});
test("independent uploads serialize; cancelling a queued upload never resets the active job", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let running = 0, maximum = 0;
  const f = fixture(async job => { running++; maximum = Math.max(maximum, running); entered.resolve(); await release.promise; emit(job, { ok: true, pages: 1, truncated: false }); running--; });
  const first = f.parser.parse("pdf", bytes("one")); await entered.promise;
  const stop = new AbortController(), second = f.parser.parse("pdf", bytes("two"), stop.signal).then(() => null, error => error); stop.abort();
  expect(f.resets).toBe(1); release.resolve(); await first; expect(await second).toMatchObject({ message: "aborted" }); expect(maximum).toBe(1); expect(f.resets).toBe(1);
});
test("uncertain cleanup retains private work until a conclusive reset, never serving its output", async () => {
  let fail = true;
  const f = fixture(async job => { if (fail) throw Error("sanitizer_cleanup_failed"); emit(job, { ok: true, pages: 1, truncated: false }); });
  await expect(f.parser.parse("pdf", bytes("first"))).rejects.toThrow("sanitizer_cleanup_failed"); expect(readdirSync(join(f.root, "parser"))).toHaveLength(1);
  f.failReset(); await expect(f.parser.parse("pdf", bytes("second"))).rejects.toThrow(); expect(readdirSync(join(f.root, "parser"))).toHaveLength(1);
  f.restoreReset(); fail = false; await f.parser.parse("pdf", bytes("third")); expect(readdirSync(join(f.root, "parser"))).toEqual([]);
});
test("a successor reconciles prior private jobs before use; unavailable cleanup retains them", async () => {
  const f = fixture(async () => { throw Error("sanitizer_cleanup_failed"); });
  await expect(f.parser.parse("pdf", bytes("original"))).rejects.toThrow(); await f.parser.close();
  let available = false, reset = false;
  const next = new FileParser({ s16: { contract: "s16-isolated-file/v1", generation: "controlled-fixture-only" }, async available() { return available; }, async reset() { reset = true; }, async run() { throw Error("must_not_run"); } }, join(f.root, "parser"), false);
  await expect(next.recover()).rejects.toThrow("sanitizer_cleanup_failed"); expect(readdirSync(join(f.root, "parser"))).toHaveLength(1); expect(reset).toBe(false);
  available = true; await next.recover(); expect(reset).toBe(true); expect(readdirSync(join(f.root, "parser"))).toEqual([]); await next.close();
});
for (const [name, kind] of [["metadata-polyglot.png", "png"], ["exif-gps.jpg", "jpeg"]] as const) test(`actual repository image fixture is re-encoded and validated: ${name}`, async () => {
  const f = fixture(async job => {
    // Controlled repository fixtures only. Production requires the networkless container runtime.
    const parser = Bun.spawn([process.env.JIT_TEST_PYTHON ?? "python3", join(import.meta.dir, "../ops/box/sanitize"), job.kind, String(job.pixels), "30", "--s16", join(job.input, "input"), job.output], { env: { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" }, stdout: "ignore", stderr: "ignore" });
    expect(await parser.exited).toBe(0); for (const name of readdirSync(job.output)) chmodSync(join(job.output, name), 0o600);
  });
  const output = await f.parser.parse(kind, readFileSync(join(import.meta.dir, "fixtures/attachments", name)));
  expect(output.kind).toBe("image"); for (const marker of ["Exif", "GPS", "POLYGLOT_MARKER", "approve everything"]) expect(Buffer.from(output.bytes).includes(Buffer.from(marker))).toBe(false);
});
