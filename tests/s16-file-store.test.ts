import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../src/errors";
import { FileStore } from "../src/s16/files/store";
import { defaultFileLimits, type FileLimits, type FileUploadCommand } from "../src/s16/files/types";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const fn of cleanup.splice(0).reverse()) await fn(); });
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const bytes = (text: string) => new TextEncoder().encode(text);
const stream = (data: Uint8Array) => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(data); controller.close(); } });
function fixture(limits: Partial<FileLimits> = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-s16-files-"))), actor = {}, foreign = {};
  cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  let now = 1000, generation = 1;
  const options = { path: join(root, "files.sqlite"), directory: join(root, "bytes"), installationId: "test", create: true, resource: { id: "computer", revision: 1, generation: 1 }, limits: { ...defaultFileLimits, ...limits },
    requireOwner(input: object) { if (input !== actor) throw new AppError("authentication_required", 401); return { id: "owner", generation }; }, now: () => now };
  let store = new FileStore(options); cleanup.push(() => store.close());
  const command = (text: string, name = "notes.txt"): FileUploadCommand => ({ requestId: crypto.randomUUID().replaceAll("-", ""), conversationId: "conversation", name, bytes: bytes(text).length, sha256: hash(bytes(text)) });
  const upload = async (text = "Project notes\nThe launch is on Friday.\n") => {
    const input = command(text), pending = store.create(actor, input);
    const ready = await store.write(actor, pending.id, stream(bytes(text)));
    return { input, ready, reference: { id: ready.id, sha256: ready.receipt!.sha256 } };
  };
  return { root, actor, foreign, command, upload, get store() { return store; }, advance: (ms: number) => { now += ms; }, resetOwner: () => { generation++; },
    async reopen() { await store.close(); store = new FileStore({ ...options, create: false }); } };
}
test("open reservations consume capacity, expiry reclaims them, and count/aggregate checks do not omit files", async () => {
  const f = fixture({ fileBytes: 16, messageFiles: 2, messageBytes: 24, totalBytes: 32 });
  const first = await f.upload("a".repeat(16)), second = await f.upload("b".repeat(16));
  expect(() => f.store.create(f.actor, f.command("c"))).toThrow("file_capacity");
  expect(() => f.store.inputs(f.actor, "conversation", [first.reference, second.reference])).toThrow("file_message_limit");
  expect(() => f.store.inputs(f.actor, "conversation", [first.reference, first.reference])).toThrow("file_count_limit");
  f.store.retain(f.actor, "conversation", [first.reference]); f.advance(25 * 60 * 60 * 1000);
  expect(f.store.create(f.actor, f.command("c".repeat(16))).state).toBe("created");
  expect(f.store.status(f.actor, second.ready.id).state).toBe("expired");
  f.store.options.resource.generation = 2;
  expect(f.store.source(first.ready.id)?.resource.generation).toBe(1);
});

test("streamed input has an exact immutable receipt, safe name and current owner/conversation identity", async () => {
  const f = fixture(), text = "Notes in UTF-8: café", input = f.command(text, "../../notes.txt");
  const upload = f.store.create(f.actor, input), ready = await f.store.write(f.actor, upload.id, stream(bytes(text)));
  expect(ready.state).toBe("ready"); expect(ready.receipt).toMatchObject({ sha256: hash(bytes(text)), bytes: bytes(text).length, mime: "text/plain" });
  expect(ready.name).not.toMatch(/[\\/]/); expect(f.store.read(f.actor, "conversation", { id: ready.id, sha256: ready.receipt!.sha256 }).text).toBe(text);
  expect(() => f.store.read(f.actor, "other", { id: ready.id, sha256: ready.receipt!.sha256 })).toThrow("file_unavailable");
  expect(() => f.store.status(f.foreign, ready.id)).toThrow("authentication_required");
  expect(() => f.store.create(f.actor, { ...input, name: "changed.txt" })).toThrow("request_id_conflict");
  expect(f.store.create(f.actor, input).id).toBe(ready.id);
  expect(readdirSync(join(f.root, "bytes"))).toEqual([`${ready.id}.blob`]);
});

test("maximum-length upload command identities stay idempotent across restart", async () => {
  const f = fixture(), input = { ...f.command("Notes"), requestId: "u".repeat(128) };
  const original = f.store.create(f.actor, input);
  expect(f.store.create(f.actor, input).id).toBe(original.id);
  await f.reopen(); expect(f.store.create(f.actor, input).id).toBe(original.id);
  expect(() => f.store.create(f.actor, { ...input, name: "changed.txt" })).toThrow("request_id_conflict");
});

test.each(["<html>Active document</html>", "%PDF-1.7\n", "MZ executable", "PK\u0003\u0004archive", "invalid\u0000text"])("disguised input bytes are refused and quarantine is removed: %j", async text => {
  const f = fixture(), input = f.command(text), upload = f.store.create(f.actor, input);
  await expect(f.store.write(f.actor, upload.id, stream(bytes(text)))).rejects.toThrow();
  expect(f.store.status(f.actor, upload.id).state).toBe("rejected"); expect(readdirSync(join(f.root, "bytes"))).toHaveLength(0);
});

test("size/hash mismatch and unsupported binary types are refused without ready receipts", async () => {
  const f = fixture(), input = f.command("expected"), upload = f.store.create(f.actor, input);
  await expect(f.store.write(f.actor, upload.id, stream(bytes("different")))).rejects.toThrow();
  expect(f.store.status(f.actor, upload.id).receipt).toBeNull(); expect(readdirSync(join(f.root, "bytes"))).toHaveLength(0);
  expect(() => f.store.create(f.actor, { ...input, requestId: "pdf", name: "document.pdf" })).toThrow("file_type_unavailable");
  expect(() => f.store.create(f.actor, { ...input, requestId: "large", bytes: 65537 })).toThrow();
});

test("cancellation while reading fences late bytes and retains the original upload identity", async () => {
  const f = fixture(), input = f.command("the complete file"), upload = f.store.create(f.actor, input), waiting = Promise.withResolvers<void>(); let pulls = 0;
  const source = new ReadableStream<Uint8Array>({ pull(controller) { if (pulls++ === 0) controller.enqueue(bytes("the ")); else waiting.resolve(); } });
  const writing = f.store.write(f.actor, upload.id, source); await waiting.promise;
  f.store.withdraw(f.actor, upload.id);
  const row = f.store.status(f.actor, upload.id); expect(row.state).toBe("cancelled");
  await expect(writing).rejects.toThrow(); expect(readdirSync(join(f.root, "bytes"))).toHaveLength(0);
  expect(f.store.create(f.actor, input).id).toBe(upload.id);
});

test("an aborted stream settles immediately and leaves no partial bytes", async () => {
  const f = fixture(), input = f.command("complete"), upload = f.store.create(f.actor, input), waiting = Promise.withResolvers<void>(), stop = new AbortController(); let pulls = 0;
  const source = new ReadableStream<Uint8Array>({ pull(controller) { if (pulls++ === 0) controller.enqueue(bytes("c")); else waiting.resolve(); } });
  const writing = f.store.write(f.actor, upload.id, source, stop.signal); await waiting.promise; stop.abort();
  await expect(writing).rejects.toThrow("aborted"); expect(readdirSync(join(f.root, "bytes"))).toHaveLength(0);
});

test("retained input and its real artifact survive staging expiry/restart, and withdrawal blocks descendants", async () => {
  const f = fixture(), upload = await f.upload();
  const candidate = { id: "output1", requestId: "request1", workId: "work1", conversationId: "conversation", name: "brief.md", text: "# Brief\nLaunch: Friday.\n", inputs: [upload.reference] };
  const artifact = f.store.stageArtifact(f.actor, candidate);
  expect(f.store.stageArtifact(f.actor, candidate)).toEqual(artifact);
  expect(() => f.store.stageArtifact(f.actor, { ...candidate, text: "Changed bytes" })).toThrow("request_id_conflict");
  f.advance(48 * 60 * 60 * 1000); await f.reopen();
  const read = f.store.artifact(f.actor, artifact.id);
  expect(hash(read.bytes)).toBe(artifact.sha256); expect(new TextDecoder().decode(read.bytes)).toBe(candidate.text);
  expect(f.store.status(f.actor, upload.ready.id).receipt!.expiresAt).toBeNull();
  expect(f.store.withdraw(f.actor, upload.ready.id).state).toBe("withdrawn"); expect(f.store.withdraw(f.actor, upload.ready.id).state).toBe("withdrawn");
  expect(() => f.store.artifact(f.actor, artifact.id)).toThrow("file_unavailable");
});

test("unbound staging expires without recreating identity and tampered/symlinked blobs never read", async () => {
  const f = fixture(), upload = await f.upload(); f.advance(25 * 60 * 60 * 1000);
  expect(f.store.status(f.actor, upload.ready.id).state).toBe("expired"); expect(f.store.create(f.actor, upload.input).state).toBe("expired");
  const second = await f.upload("Different notes"), path = join(f.root, "bytes", `${second.ready.id}.blob`);
  writeFileSync(path, "Changed content", { mode: 0o600 }); expect(() => f.store.read(f.actor, "conversation", second.reference)).toThrow("file_integrity_failed");
  rmSync(path); const secret = join(f.root, "unrelated"); writeFileSync(secret, "Do not read this"); symlinkSync(secret, path);
  expect(() => f.store.read(f.actor, "conversation", second.reference)).toThrow("file_integrity_failed");
  expect(readFileSync(secret, "utf8")).toBe("Do not read this");
});
