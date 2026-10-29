import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync, mkdirSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { TransactionStore } from "../src/store";
import { AttachmentStorage } from "../src/attachments/storage";
import { stripAttachmentMetadata } from "../src/attachments/fallback";
import { AttachmentSanitizer, sanitizerOutputLimits } from "../src/attachments/sanitizer";
import { PodmanAttachmentSanitizer, sanitizerCommandRunner, type AttachmentSanitizerRuntime, type SanitizeJob } from "../src/attachments/sanitizer-runtime";
import type { CommandRunner } from "../src/exec/podman-runtime";
import { readAttachment, readAttachmentEvents } from "../src/attachments/records";

const dirs: string[] = [], stores: TransactionStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) { try { s.close(); } catch {} } for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const python = process.env.JIT_TEST_PYTHON ?? "python3";
const fixtureEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", LANG: "C.UTF-8" };
const fixtures = join(import.meta.dir, "fixtures/attachments"), script = join(import.meta.dir, "../ops/box/sanitize");
const bytes = (name: string) => readFileSync(join(fixtures, name));
const base = `jit-box-base@sha256:${"a".repeat(64)}`;
const host = { memoryBytes: 8 * 1024 ** 3, dataFilesystemBytes: 32 * 1024 ** 3, backupFilesystemBytes: 32 * 1024 ** 3 };
const okCommand = (stdout = "", exitCode = 0) => ({ exitCode, stdout: Buffer.from(stdout), stderr: new Uint8Array() });
class FakeRuntime implements AttachmentSanitizerRuntime {
  calls: SanitizeJob[] = []; resets = 0; reachable = true;
  constructor(readonly handler: (job: SanitizeJob) => void | Promise<void> = localParser) {}
  async available() { return this.reachable; }
  async reset() { this.resets++; }
  async run(job: SanitizeJob) { this.calls.push(job); await this.handler(job); }
}
async function localParser(job: SanitizeJob) {
  // Only tiny repository fixtures, never uploaded real files; no container or network is invoked.
  const proc = Bun.spawn([python, script, job.kind, String(job.pixels), "30", join(job.input, "input"), job.output], { env: fixtureEnv, stdout: "ignore", stderr: "pipe" });
  const err = await new Response(proc.stderr).text(); expect([await proc.exited, err]).toEqual([0, ""]);
}
async function fixture(runtime: AttachmentSanitizerRuntime | null = null) {
  const dir = mkdtempSync(join(tmpdir(), "jit-sanitize-")); dirs.push(dir);
  const path = join(dir, "jit.sqlite"), store = new TransactionStore(path); stores.push(store);
  const config = readConfig({ JIT_DATABASE: path }, host); config.attachments = { ...config.attachments, enabled: true, diskReserveBytes: 1000 };
  let now = 1_800_000_000_000;
  const app = new Application(store, config, { now: () => now++, attachmentSanitizer: runtime, attachments: { diskFree: () => 1e10 } });
  await app.setupOwner("fixture-sanitizer-owner-password"); const actor = app.authenticate(await app.login("fixture-sanitizer-owner-password")).actor;
  const p = app.execute(actor, { kind: "project.create", projectId: null, requestId: crypto.randomUUID(), expectedRevision: 0, payload: { name: "fixture" } }).project;
  const t = app.execute(actor, { kind: "topic.create", projectId: p.id, requestId: crypto.randomUUID(), expectedRevision: 1, payload: { title: "fixture" } }).topic;
  const storage = new AttachmentStorage(store, config.attachments, { diskFree: () => 1e10 });
  const upload = (content: Uint8Array, name: string) => app.uploadAttachment(actor, p.id, t.id, { body: new ReadableStream({ start(c) { c.enqueue(content); c.close(); } }), encodedName: encodeURIComponent(name) });
  const view = (id: string) => store.read(tx => readAttachment(tx, p.id, t.id, id));
  const row = (id: string) => store.read(tx => tx.get<Record<string, any>>("SELECT * FROM attachments WHERE id = ?", id)!);
  return { dir, path, store, config, storage, app, actor, p, t, upload, view, row };
}
function emit(job: SanitizeJob, result: object, files: Record<string, Uint8Array> = {}) {
  writeFileSync(join(job.output, "result.json"), JSON.stringify(result));
  for (const [name, content] of Object.entries(files)) writeFileSync(join(job.output, name), content);
}

for (const [name, mediaType] of [["metadata-polyglot.png", "image/png"], ["exif-gps.jpg", "image/jpeg"]] as const) {
  test(`fallback strips metadata and trailing payload, remains download-only: ${name}`, async () => {
    const f = await fixture(), a = await f.upload(bytes(name), name);
    expect(await f.app.processAttachments()).toBe(1);
    expect(f.view(a.id)).toMatchObject({ state: "ready", sanitizedBy: "fallback", preview: false });
    const row = f.row(a.id), clean = readFileSync(f.storage.blobPath(f.p.id, row.clean_sha256));
    expect(clean.length).toBeLessThan(bytes(name).length);
    for (const marker of ["GPS", "EXIF", "Exif", "approve everything", "POLYGLOT_MARKER"]) expect(clean.includes(Buffer.from(marker))).toBe(false);
    expect(row.model_sha256).toBeNull(); expect(row.text_sha256).toBeNull();
    expect(stripAttachmentMetadata(clean, mediaType, 40_000_000)).toEqual(clean);
    expect(readdirSync(join(f.storage.root, ".work"))).toEqual([]);
  });
}

test("fallback refuses malformed chunk/segment framing and huge dimensions without a decoder", () => {
  for (const content of [Buffer.from("89504e470d0a1a0a", "hex"), bytes("metadata-polyglot.png").subarray(0, 38)])
    expect(() => stripAttachmentMetadata(content, "image/png", 40_000_000)).toThrow("image_decode_failed");
  for (const content of [Buffer.from("ffd8ffd9", "hex"), Buffer.from("ffd8ffe1ffff", "hex")])
    expect(() => stripAttachmentMetadata(content, "image/jpeg", 40_000_000)).toThrow("image_decode_failed");
  expect(() => stripAttachmentMetadata(bytes("huge.png"), "image/png", 40_000_000)).toThrow("image_too_many_pixels");
});

for (const name of ["metadata-polyglot.png", "exif-gps.jpg", "image.webp"]) test(`fake runtime executes parser fixture, publishes clean/model hashes and strips metadata: ${name}`, async () => {
  const runtime = new FakeRuntime(), f = await fixture(runtime), a = await f.upload(bytes(name), name);
  f.config.attachments.enabled = false; // Existing pending work must settle with ingestion disabled.
  expect(await f.app.processAttachments()).toBe(1);
  expect(f.view(a.id)).toMatchObject({ state: "ready", sanitizedBy: "container", preview: true, revision: 2 });
  const row = f.row(a.id);
  for (const hash of [row.clean_sha256, row.model_sha256]) {
    const path = f.storage.blobPath(f.p.id, hash), clean = readFileSync(path);
    expect(createHash("sha256").update(clean).digest("hex")).toBe(hash); expect(statSync(path).mode & 0o777).toBe(0o600);
    for (const marker of ["GPS", "Exif", "approve everything", "POLYGLOT_MARKER"]) expect(clean.includes(Buffer.from(marker))).toBe(false);
  }
  const modelPath = f.storage.blobPath(f.p.id, row.model_sha256);
  const check = Bun.spawnSync([python, "-c", "from PIL import Image; import sys; im=Image.open(sys.argv[1]); print(max(im.size))", modelPath]);
  expect(check.exitCode).toBe(0); expect(Number(check.stdout.toString())).toBeLessThanOrEqual(2048);
  expect(runtime.calls).toHaveLength(1); expect(runtime.calls[0]!.input).toStartWith(join(f.storage.root, ".work"));
  const events = f.store.read(tx => readAttachmentEvents(tx, f.p.id));
  expect(events[0]).toMatchObject({ kind: "sanitize", status: "ok", detail: { sanitizedBy: "container", truncated: false } });
  expect(JSON.stringify(events)).not.toContain("POLYGLOT_MARKER");
});

for (const [name, reason] of [["bomb.png", "image_too_many_pixels"], ["huge.png", "image_too_many_pixels"], ["malformed.pdf", "pdf_extract_failed"]]) {
  test(`hostile fixture is rejected after two attempts and original removed: ${name}`, async () => {
    const runtime = new FakeRuntime(), f = await fixture(runtime), a = await f.upload(bytes(name!), name!);
    const original = f.storage.blobPath(f.p.id, f.row(a.id).sha256);
    expect(await f.app.processAttachments()).toBe(1);
    expect(f.view(a.id)).toMatchObject({ state: "rejected", reason }); expect(f.row(a.id).sanitize_attempts).toBe(2);
    expect(f.row(a.id).sha256).toBeNull(); expect(existsSync(original)).toBe(false); expect(runtime.calls).toHaveLength(2);
    expect(f.store.read(tx => readAttachmentEvents(tx, f.p.id)).filter(e => e.kind === "sanitize").map(e => e.status)).toEqual(["failed", "failed"]);
  });
}

function pdf(pages: number, content = "fixture text") {
  const objects: string[] = ["<< /Type /Catalog /Pages 2 0 R >>", `<< /Type /Pages /Kids [${Array.from({ length: pages }, (_, n) => `${3 + n * 2} 0 R`).join(" ")}] /Count ${pages} >>`];
  for (let n = 0; n < pages; n++) {
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 300] /Resources << /Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >> >> /Contents ${4 + n * 2} 0 R >>`);
    const stream = content ? `BT /F1 12 Tf 10 200 Td (${content}) Tj ET` : ""; objects.push(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`);
  }
  let out = "%PDF-1.7\n"; const offsets = [0];
  for (const [n, object] of objects.entries()) { offsets.push(out.length); out += `${n + 1} 0 obj\n${object}\nendobj\n`; }
  const xref = out.length; out += `xref\n0 ${offsets.length}\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out);
}
for (const [pages, content, truncated] of [[1, "", false], [1, "fixture text", false], [51, "fixture text", true]] as const) test(`PDF extracts text only, including empty and page cap: ${pages}/${content}`, async () => {
  const f = await fixture(new FakeRuntime()), a = await f.upload(pdf(pages, content), "file.pdf");
  await f.app.processAttachments(); const row = f.row(a.id);
  expect(f.view(a.id)).toMatchObject({ state: "ready", preview: false, sanitizedBy: "container", textTruncated: truncated });
  const text = readFileSync(f.storage.blobPath(f.p.id, row.text_sha256), "utf8");
  expect(text.split("fixture text").length - 1).toBe(content ? Math.min(50, pages) : 0);
  expect(row.clean_sha256).toBeNull(); expect(row.model_sha256).toBeNull();
  if (!content) expect(row.text_bytes).toBe(0);
});

test("pending rows resume after reopen; an interrupted second attempt rejects without a third parser", async () => {
  const runtime = new FakeRuntime(job => emit(job, { ok: false, reason: "image_decode_failed" })), f = await fixture(runtime);
  const a = await f.upload(bytes("exif-gps.jpg"), "a.jpg");
  const worker = new AttachmentSanitizer(f.storage, runtime);
  expect(await worker.pump(1)).toBe(0); expect(f.row(a.id).sanitize_attempts).toBe(1);
  f.store.close();
  const reopened = new TransactionStore(f.path); stores.push(reopened);
  const storage = new AttachmentStorage(reopened, f.config.attachments, { diskFree: () => 1e10 });
  let settled = 0;
  const recovered = new AttachmentSanitizer(storage, runtime, { onSettled: () => { settled++; } });
  expect(await recovered.pump()).toBe(1); expect(settled).toBe(1); expect(runtime.calls).toHaveLength(2);
  reopened.transaction(tx => tx.run("UPDATE attachments SET state = 'pending', sha256 = ?, sanitize_attempts = 2 WHERE id = ?", createHash("sha256").update(bytes("exif-gps.jpg")).digest("hex"), a.id));
  expect(await recovered.pump()).toBe(1); expect(runtime.calls).toHaveLength(2);
});

test("one installation serializes workers; a binding revision change preserves valid output and deletion fences late output", async () => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const runtime = new FakeRuntime(async job => { entered(); await gate; await localParser(job); });
  const f = await fixture(runtime), a = await f.upload(bytes("exif-gps.jpg"), "a.jpg");
  const worker = new AttachmentSanitizer(f.storage, runtime), second = new AttachmentSanitizer(f.storage, runtime);
  const pump = worker.pump(); await started;
  expect(second.pump()).toBe(pump); expect(runtime.calls).toHaveLength(1);
  // ATT03 binding bumps the metadata revision while preserving immutable file content.
  f.store.transaction(tx => tx.run("UPDATE attachments SET revision = revision + 1 WHERE id = ?", a.id));
  release(); await pump; expect(f.view(a.id).state).toBe("ready");
  const deletion = new FakeRuntime(async job => {
    await localParser(job);
    f.store.transaction(tx => tx.run("UPDATE attachments SET state = 'deleted', sha256 = NULL, revision = revision + 1 WHERE id = ?", b.id));
  });
  const b = await f.upload(bytes("metadata-polyglot.png"), "a.png");
  expect(await new AttachmentSanitizer(f.storage, deletion).pump()).toBe(0);
  expect(f.row(b.id)).toMatchObject({ state: "deleted", clean_sha256: null, model_sha256: null });
});

for (const [label, output] of [
  ["wrong magic", (job: SanitizeJob) => emit(job, { ok: true, width: 1, height: 1, truncated: false }, { "clean.png": Buffer.from("bad"), "model.png": Buffer.from("bad") })],
  ["symlink", (job: SanitizeJob) => { emit(job, { ok: true, width: 1, height: 1, truncated: false }, { "model.png": bytes("metadata-polyglot.png") }); symlinkSync(join(fixtures, "metadata-polyglot.png"), join(job.output, "clean.png")); }],
  ["oversize image", (job: SanitizeJob) => { emit(job, { ok: true, width: 1, height: 1, truncated: false }, { "clean.png": bytes("metadata-polyglot.png"), "model.png": bytes("metadata-polyglot.png") }); truncateSync(join(job.output, "clean.png"), sanitizerOutputLimits.image + 1); }],
  ["oversize JSON", (job: SanitizeJob) => writeFileSync(join(job.output, "result.json"), " ".repeat(sanitizerOutputLimits.result + 1))],
  ["extra output", (job: SanitizeJob) => emit(job, { ok: true, width: 1, height: 1, truncated: false }, { "clean.png": bytes("metadata-polyglot.png"), "model.png": bytes("metadata-polyglot.png"), "unexpected": Buffer.from("payload") })],
  ["bad dimension", (job: SanitizeJob) => emit(job, { ok: true, width: 1e20, height: 1, truncated: false })],
] as const) test(`invalid parser output never publishes derivatives: ${label}`, async () => {
  const f = await fixture(new FakeRuntime(output)), a = await f.upload(bytes("metadata-polyglot.png"), "a.png");
  await f.app.processAttachments();
  expect(f.view(a.id)).toMatchObject({ state: "rejected", reason: "sanitize_output_invalid", preview: false });
  expect(f.row(a.id)).toMatchObject({ clean_sha256: null, model_sha256: null, text_sha256: null });
});

for (const content of [Buffer.from([0xc3]), Buffer.from("text\0nul"), Buffer.alloc(sanitizerOutputLimits.text + 1, 65)]) test(`PDF output is bounded UTF-8 without NUL: ${content.length}`, async () => {
  const f = await fixture(new FakeRuntime(job => emit(job, { ok: true, pages: 1, truncated: false }, { "text.txt": content })));
  const a = await f.upload(bytes("malformed.pdf"), "a.pdf"); await f.app.processAttachments();
  expect(f.view(a.id)).toMatchObject({ state: "rejected", reason: "sanitize_output_invalid" });
});

test("PDF/WebP upload is refused when runtime capability is absent; valid PNG still uses fallback", async () => {
  const runtime = new FakeRuntime(); runtime.reachable = false; const f = await fixture(runtime);
  for (const name of ["malformed.pdf", "image.webp"]) await expect(f.upload(bytes(name), name)).rejects.toThrow("attachment_needs_sanitizer");
  const a = await f.upload(bytes("exif-gps.jpg"), "a.jpg"); await f.app.processAttachments();
  expect(f.view(a.id)).toMatchObject({ state: "ready", sanitizedBy: "fallback", preview: false }); expect(runtime.calls).toEqual([]);
});

test("runtime capability requires rootless cgroup controls and the rebuilt pinned base image", async () => {
  let info = { security: { rootless: true }, cgroupVersion: "v2", cgroupControllers: ["memory", "cpu", "pids"] }, version = "1";
  const command: CommandRunner = async args => okCommand(JSON.stringify(args[0] === "info" ? { host: info } : [{ Config: { Labels: { "jit.sanitize.version": version } } }]));
  const runtime = new PodmanAttachmentSanitizer(base, "/fixture/state", readConfig({}, host).attachments, command);
  expect(await runtime.available()).toBe(true); version = ""; expect(await runtime.available()).toBe(false); version = "1";
  info.security.rootless = false; expect(await runtime.available()).toBe(false); info.security.rootless = true;
  info.cgroupControllers = ["cpu"]; expect(await runtime.available()).toBe(false);
  expect(() => new PodmanAttachmentSanitizer("image:latest", "fixture", readConfig({}, host).attachments, command)).toThrow("sanitizer_unavailable");
});

test("container flags have exactly per-job input/output, fixed environment, no network; deadline kills then removes", async () => {
  const calls: string[][] = []; let expire!: () => void;
  const command: CommandRunner = async (args, request) => {
    calls.push([...args]);
    if (args[0] === "run") return new Promise(resolve => { request.signal?.addEventListener("abort", () => resolve(okCommand("", 137)), { once: true }); });
    return okCommand(args[0] === "ps" ? "b".repeat(64) : "");
  };
  const limits = readConfig({}, host).attachments;
  const runtime = new PodmanAttachmentSanitizer(base, "installation", limits, command, (callback, ms) => { expire = callback; expect(ms).toBe(30_000); return () => {}; });
  const pending = runtime.run({ input: "/generated/in", output: "/generated/out", kind: "png", pixels: limits.imagePixels });
  const run = calls[0]!;
  for (const flag of ["--rm", "--pull=never", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--read-only", "--memory=512m", "--memory-swap=512m", "--pids-limit=64", "--cpus=1", "--userns=keep-id:uid=1000,gid=1000"]) expect(run).toContain(flag);
  expect(run[run.indexOf("--network") + 1]).toBe("none"); expect(run[run.indexOf("--user") + 1]).toBe("1000:1000");
  expect(run.filter((_, i) => run[i - 1] === "--mount")).toEqual(["type=bind,source=/generated/in,destination=/in,ro=true", "type=bind,source=/generated/out,destination=/out,rw=true"]);
  expect(run.filter((_, i) => run[i - 1] === "--env")).toEqual(["HOME=/tmp", "LANG=C.UTF-8"]);
  expect(run.slice(-5)).toEqual([base, "/opt/jit/sanitize", "png", "40000000", "30"]);
  expire(); await expect(pending).rejects.toThrow("sanitize_timeout");
  expect(calls.slice(1).map(c => c[0])).toEqual(["ps", "kill", "rm"]);
  expect(calls.at(-1)).toEqual(["rm", "--force", "--ignore", "b".repeat(64)]);
});

test("failed runtime cleanup retains work and pending state; next pump resets before retry", async () => {
  let fail = true;
  const runtime = new FakeRuntime(async job => { if (fail) throw new Error("sanitizer_cleanup_failed"); await localParser(job); });
  const f = await fixture(runtime), a = await f.upload(bytes("exif-gps.jpg"), "a.jpg");
  const worker = new AttachmentSanitizer(f.storage, runtime);
  await expect(worker.pump()).rejects.toThrow("sanitizer_cleanup_failed");
  expect(f.view(a.id).state).toBe("pending"); expect(readdirSync(join(f.storage.root, ".work"))).toHaveLength(1);
  fail = false; expect(await worker.pump()).toBe(1); expect(readdirSync(join(f.storage.root, ".work"))).toHaveLength(0);
});

test("lifecycle fencing after parser completion publishes no output and leaves a restartable pending row", async () => {
  let fenced = false;
  const runtime = new FakeRuntime(async job => { await localParser(job); fenced = true; });
  const f = await fixture(runtime), a = await f.upload(bytes("exif-gps.jpg"), "a.jpg");
  const worker = new AttachmentSanitizer(f.storage, runtime, { assertCurrent: () => { if (fenced) throw new Error("service_unavailable"); } });
  await expect(worker.pump()).rejects.toThrow("service_unavailable");
  expect(f.row(a.id)).toMatchObject({ state: "pending", sanitize_attempts: 1, clean_sha256: null });
});

test("actual PDF script bounds its subprocess pipe and snaps a truncated multibyte UTF-8 tail", async () => {
  const runtime = new FakeRuntime(async job => {
    const bin = join(job.input, "fake-poppler"); mkdirSync(bin, { mode: 0o700 });
    const interpreter = Bun.which(python)!;
    writeFileSync(join(bin, "pdfinfo"), `#!${interpreter}\nprint('Pages: 1')\n`, { mode: 0o700 });
    writeFileSync(join(bin, "pdftotext"), `#!${interpreter}\nimport sys\nsys.stdout.buffer.write(('a' * (2 * 1024 * 1024 - 1) + '🧪tail').encode('utf-8'))\n`, { mode: 0o700 });
    const proc = Bun.spawn([python, script, job.kind, String(job.pixels), "30", join(job.input, "input"), job.output], {
      env: { ...fixtureEnv, PATH: `${bin}:${fixtureEnv.PATH}` }, stdout: "ignore", stderr: "pipe",
    });
    const err = await new Response(proc.stderr).text(); expect([await proc.exited, err]).toEqual([0, ""]);
  });
  const f = await fixture(runtime), a = await f.upload(bytes("malformed.pdf"), "a.pdf"); await f.app.processAttachments();
  expect(f.view(a.id)).toMatchObject({ state: "ready", textTruncated: true });
  expect(f.row(a.id).text_bytes).toBe(sanitizerOutputLimits.text - 1);
});

test("a rejected duplicate never unlinks another pending or ready row's original", async () => {
  let fail = true;
  const runtime = new FakeRuntime(async job => { if (fail) throw new Error("sanitize_out_of_memory"); await localParser(job); });
  const f = await fixture(runtime), first = await f.upload(bytes("exif-gps.jpg"), "a.jpg"), second = await f.upload(bytes("exif-gps.jpg"), "b.jpg");
  const original = f.storage.blobPath(f.p.id, f.row(first.id).sha256);
  const worker = new AttachmentSanitizer(f.storage, runtime); expect(await worker.pump(2)).toBe(1);
  expect(f.view(first.id)).toMatchObject({ state: "rejected", reason: "sanitize_out_of_memory" }); expect(existsSync(original)).toBe(true);
  fail = false; expect(await worker.pump()).toBe(1); expect(f.view(second.id).state).toBe("ready"); expect(existsSync(original)).toBe(true);
});

test("close aborts an active parser before SQLite closes and leaves its attempt restartable", async () => {
  let entered!: () => void; const started = new Promise<void>(resolve => { entered = resolve; }); let stopped = false;
  const runtime: AttachmentSanitizerRuntime = {
    available: async () => true, reset: async () => {},
    run: async (_job, signal) => new Promise((_resolve, reject) => { entered(); signal!.addEventListener("abort", () => { stopped = true; reject(new Error("sanitize_timeout")); }, { once: true }); }),
  };
  const f = await fixture(runtime), a = await f.upload(bytes("exif-gps.jpg"), "a.jpg");
  const worker = new AttachmentSanitizer(f.storage, runtime), pending = worker.pump(); await started;
  await worker.close(); await expect(pending).rejects.toThrow("sanitizer_unavailable"); expect(stopped).toBe(true);
  expect(f.row(a.id)).toMatchObject({ state: "pending", sanitize_attempts: 1, clean_sha256: null });
  expect(readdirSync(join(f.storage.root, ".work"))).toHaveLength(0); expect(await worker.pump()).toBe(0);
});

test("CLI out-of-memory termination has a closed reason and always removes the container", async () => {
  const calls: string[] = [];
  const runtime = new PodmanAttachmentSanitizer(base, "fixture", readConfig({}, host).attachments, async args => { calls.push(args[0]!); return okCommand(args[0] === "ps" ? "c".repeat(64) : "", args[0] === "run" ? 137 : 0); });
  await expect(runtime.run({ input: "/fixture/in", output: "/fixture/out", kind: "jpeg", pixels: 20_000_000 })).rejects.toThrow("sanitize_out_of_memory");
  expect(calls).toEqual(["run", "ps", "rm"]);
});


test("the CLI runner bounds output, closes abortable pipes and strips the service environment", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jit-fake-sanitize-cli-")); dirs.push(dir);
  const cli = join(dir, "fake-podman");
  writeFileSync(cli, `#!${Bun.which("bun")}
if (process.argv[2] === "flood") console.log("x".repeat(70000));
else if (process.argv[2] === "hold") setInterval(() => {}, 1000);
else console.log(JSON.stringify(Object.keys(process.env).sort()));
`, { mode: 0o700 });
  const runner = sanitizerCommandRunner(cli, { PATH: fixtureEnv.PATH, HOME: dir, LANG: "C.UTF-8", JIT_FIXTURE_SECRET: "synthetic-secret", RANDOM_SECRET: "synthetic-secret" });
  const result = await runner(["env"], { timeoutMs: 1000 });
  expect(result.exitCode).toBe(0); expect(JSON.parse(Buffer.from(result.stdout).toString())).toEqual(["HOME", "LANG", "PATH"]);
  await expect(runner(["flood"], { timeoutMs: 1000 })).rejects.toThrow("sanitizer_unavailable");
  const abort = new AbortController(), pending = runner(["hold"], { timeoutMs: 1000, signal: abort.signal });
  abort.abort(); expect((await pending).exitCode).not.toBe(0);
});


test("late cleanup cannot remove a successor that reused the installation container name", async () => {
  const calls: string[][] = [];
  const runtime = new PodmanAttachmentSanitizer(base, "fixture", readConfig({}, host).attachments, async args => {
    calls.push([...args]);
    // The prior process's container is already removed; a new owner uses the same name with a different job label.
    return okCommand();
  });
  await runtime.run({ input: "/fixture/in", output: "/fixture/out", kind: "png", pixels: 20_000_000 });
  expect(calls.map(c => c[0])).toEqual(["run", "ps"]);
  const job = calls[0]!.find(arg => arg.startsWith("jit.sanitize.job="))!;
  expect(calls[1]).toContain(`label=${job}`); expect(calls[1]).not.toContain(runtime.name);
});
