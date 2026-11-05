import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "schway/host";
import { composedFixture } from "./fixtures/s15-composition";
import { binaryRuntime, encryptedPdf, fixtureImage, imageProbes, launchPdf } from "./fixtures/s16-binary";
import type { FileReceipt, FileUpload } from "../src/s16/files/types";
import { ConversationStore } from "../src/s15/conversation/store";
import { DurableJournal } from "../src/s15/durable-journal";
import type { S15CompositionOptions } from "../src/s15/composition";

const fixtures: Awaited<ReturnType<typeof composedFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });
const hash = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");
async function fixture(model?: Model, tune?: (options: S15CompositionOptions) => S15CompositionOptions) {
  const f = await composedFixture("default", false, undefined, options => {
    if (!options.proposedPolicy!.rules[0]!.adapters.includes("s16_files")) { options.proposedPolicy!.rules[0]!.adapters.push("s16_files"); options.proposedPolicy!.rules[0]!.operations.push("artifact_create"); }
    const configured = { ...options, files: { parserRuntime: binaryRuntime(), imageProbes }, ...(model ? { model: { ...options.model, scripted: () => model } } : {}) }; return tune ? tune(configured) : configured;
  }); fixtures.push(f); return f;
}
async function upload(f: Awaited<ReturnType<typeof fixture>>, name: string, bytes: Uint8Array): Promise<FileReceipt> {
  const created = await f.request("/api/s16/client/conversations/conversation/uploads", "POST", { requestId: "upload", conversationId: "conversation", name, bytes: bytes.length, sha256: hash(bytes) });
  expect(created.status).toBe(201); const pending = await created.json() as FileUpload;
  const response = await f.raw(`/api/s16/client/uploads/${pending.id}/bytes`, new Uint8Array(bytes).buffer);
  expect(response.status).toBe(200); const ready = await response.json() as FileUpload;
  expect(ready.state).toBe("ready"); expect(ready.receipt?.contract).toBe("s16-file-receipt/v2"); return ready.receipt!;
}
async function send(f: Awaited<ReturnType<typeof fixture>>, file: FileReceipt) {
  const command = { contract: "s16-conversation/v2", requestId: "work", conversationId: "conversation", text: "Create a brief from the attached file", continuation: null, files: [{ id: file.id, sha256: file.sha256 }] };
  expect((await f.request("/api/s16/client/conversations/conversation/messages", "POST", command)).status).toBe(202); await f.service.conversation.drain(); return f.service.conversation.view(f.owner, "work");
}
test("PDF actual isolated-runtime fixture extraction reaches model/tools and a guarded immutable download", async () => {
  let fileId = "", turn = 0;
  const model: Model = { provider: "codex-subscription", id: "fixture-model", async *stream(request) {
    const step = turn++, content = step === 0 ? [{ type: "tool_call" as const, id: "read", name: "file_read", arguments: { id: fileId, offset: 0 } }] : step === 1 ? [{ type: "tool_call" as const, id: "write", name: "file_create", arguments: { name: "brief.md", text: JSON.stringify(request).includes("Launch: Friday.") ? "Launch: Friday.\n" : "No launch evidence.\n" } }] : [{ type: "text" as const, text: "Created the file from observed PDF text." }];
    yield { type: "message_complete", message: { type: "assistant", id: "m" + step, content } };
  } };
  const f = await fixture(model), receipt = await upload(f, "notes.pdf", launchPdf()); fileId = receipt.id;
  expect(receipt).toMatchObject({ mime: "application/pdf", representation: { mime: "text/plain", pages: 1 } });
  const row = await send(f, receipt); expect(row.state).toBe("completed");
  const artifact = row.artifacts![0]!, path = `/api/s16/client/requests/work/artifacts/${artifact.id}`, download = await f.request(path);
  expect(await download.text()).toBe("Launch: Friday.\n"); expect(readFileSync(join(f.directory, "conversation.sqlite")).readUInt32BE(60)).toBe(3);
  expect(() => new ConversationStore(join(f.directory, "conversation.sqlite"), "fixture", false)).toThrow();
  await f.reopen(); expect((await f.request(path)).status).toBe(200);
  await f.request(`/api/s16/client/uploads/${receipt.id}/withdraw`, "POST", {}); expect((await f.request(path)).status).toBe(409);
});
test.each(["metadata-polyglot.png", "exif-gps.jpg"] as const)("sanitized pixels reach actual Schway image input and influence the artifact: %s", async name => {
  let turn = 0, seen = "";
  const model: Model = { provider: "codex-subscription", id: "fixture-model", async *stream(request) {
    expect(request.imageData?.size).toBe(1); const bytes = [...request.imageData!.values()][0]!; seen = hash(bytes);
    for (const marker of ["GPS", "Exif", "POLYGLOT_MARKER"]) expect(Buffer.from(bytes).includes(Buffer.from(marker))).toBe(false);
    yield { type: "message_complete", message: { type: "assistant", id: "image" + turn, content: turn++ === 0 ? [{ type: "tool_call", id: "write", name: "file_create", arguments: { name: "image.md", text: `Observed image bytes: ${seen}\n` } }] : [{ type: "text", text: "Created the file using the actual image input." }] } };
  } };
  const f = await fixture(model), receipt = await upload(f, name, fixtureImage(name));
  const row = await send(f, receipt); expect(row.state).toBe("completed"); expect(receipt.contract === "s16-file-receipt/v2" && receipt.representation.sha256).toBe(seen);
  expect(row.evidence.some(item => item.kind === "input" && item.tool === "image_input")).toBe(true);
  const artifact = row.artifacts![0]!; expect(await (await f.request(`/api/s16/client/requests/work/artifacts/${artifact.id}`)).text()).toContain(seen);
  expect(f.vmCalls).toEqual([]);
  await f.reopen(); expect((await f.request(`/api/s16/client/requests/work/artifacts/${artifact.id}`)).status).toBe(200);
});

test("binary custody rejects an older text-only journal reader before any CHAT message exists", async () => {
  const f = await fixture(); await upload(f, "notes.pdf", launchPdf()); await f.service.close();
  expect(readFileSync(join(f.directory, "files.sqlite")).readUInt32BE(60)).toBe(2);
  expect(() => new DurableJournal(join(f.directory, "files.sqlite"), "fixture", false, 0x4a495446)).toThrow("continuity_unavailable");
  await f.reopen(); expect(f.modelPrompts).toEqual([]);
});
test("advertised MIME pairs require the actual parser and exact current model-image probe", async () => {
  for (const [runtimeReady, probes, formats] of [[true, [], ["pdf"]], [true, [{ ...imageProbes[0]!, model: "other" }], ["pdf"]], [false, imageProbes, []]] as const) {
    const f = await fixture(undefined, options => ({ ...options, files: { ...options.files!, imageProbes: [...probes], parserRuntime: { ...binaryRuntime(), async available() { return runtimeReady; } } } }));
    const caps = (await (await f.request("/api/s16/client/bootstrap")).json()).capabilities.uploads;
    expect(caps.extensions.filter((ext: string) => ["pdf", "png", "jpg", "jpeg"].includes(ext))).toEqual(formats);
    const bytes = fixtureImage("exif-gps.jpg"), refused = await f.request("/api/s16/client/conversations/conversation/uploads", "POST", { requestId: "image", conversationId: "conversation", name: "input.jpg", bytes: bytes.length, sha256: hash(bytes) });
    expect(refused.status).toBe(runtimeReady ? 409 : 503); expect(f.modelPrompts).toEqual([]);
  }
});
test.each(["malformed.pdf", "huge.png", "bomb.png"])("actual malformed/expanded fixture is refused before model access: %s", async name => {
  const f = await fixture(), bytes = new Uint8Array(readFileSync(join(import.meta.dir, "fixtures/attachments", name)));
  const pending = await (await f.request("/api/s16/client/conversations/conversation/uploads", "POST", { requestId: "invalid", conversationId: "conversation", name, bytes: bytes.length, sha256: hash(bytes) })).json() as FileUpload;
  expect(pending.state).toBe("created"); expect((await f.raw(`/api/s16/client/uploads/${pending.id}/bytes`, new Uint8Array(bytes).buffer)).status).not.toBe(200);
  expect(f.service.files!.status(f.owner, pending.id).state).toBe("rejected"); expect(f.modelPrompts).toEqual([]); expect(f.vmCalls).toEqual([]);
});
test("withdrawal while validation is active suppresses late output and removes original/derived bytes", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), runtime = binaryRuntime();
  const f = await fixture(undefined, options => ({ ...options, files: { ...options.files!, parserRuntime: { ...runtime, async run(job, signal) { await runtime.run(job, signal); entered.resolve(); await release.promise; } } } }));
  const bytes = launchPdf(), pending = await (await f.request("/api/s16/client/conversations/conversation/uploads", "POST", { requestId: "upload", conversationId: "conversation", name: "notes.pdf", bytes: bytes.length, sha256: hash(bytes) })).json() as FileUpload;
  const writing = f.raw(`/api/s16/client/uploads/${pending.id}/bytes`, new Uint8Array(bytes).buffer); await entered.promise;
  expect(f.service.files!.status(f.owner, pending.id).state).toBe("validating");
  await f.request(`/api/s16/client/uploads/${pending.id}/withdraw`, "POST", {}); release.resolve();
  expect((await writing).status).not.toBe(200); expect(f.service.files!.status(f.owner, pending.id).state).toBe("cancelled");
  expect(readdirSync(join(f.directory, "file-bytes"))).toEqual([]); expect(readdirSync(join(f.directory, "file-parser"))).toEqual([]);
});
test("a real encrypted PDF with an empty user password is refused rather than silently decrypted", async () => {
  const f = await fixture(), bytes = encryptedPdf();
  const pending = await (await f.request("/api/s16/client/conversations/conversation/uploads", "POST", { requestId: "encrypted", conversationId: "conversation", name: "locked.pdf", bytes: bytes.length, sha256: hash(bytes) })).json() as FileUpload;
  expect((await f.raw(`/api/s16/client/uploads/${pending.id}/bytes`, new Uint8Array(bytes).buffer)).status).toBe(409);
  expect(f.service.files!.status(f.owner, pending.id).state).toBe("rejected"); expect(f.modelPrompts).toEqual([]);
});
test("a derivative substitution and a newly restricted recipient each fence image release", async () => {
  for (const tamper of [true, false]) {
    let sends = 0; const f = await fixture({ provider: "codex-subscription", id: "fixture-model", async *stream() { sends++; yield { type: "message_complete", message: { type: "assistant", id: "forbidden", content: [] } }; } });
    const receipt = await upload(f, "input.jpg", fixtureImage("exif-gps.jpg"));
    if (tamper) writeFileSync(join(f.directory, "file-bytes", receipt.id + ".blob.derived"), "changed", { mode: 0o600 });
    else for (const approval of f.recipientApprovals) if (approval.purpose.id === "purpose") approval.sources = f.dataSources.map(source => source.ref);
    if (tamper) expect((await f.request("/api/s16/client/conversations/conversation/messages", "POST", { contract: "s16-conversation/v2", requestId: "work", conversationId: "conversation", text: "Create a brief from the attached file", continuation: null, files: [{ id: receipt.id, sha256: receipt.sha256 }] })).status).toBe(409);
    else expect((await send(f, receipt)).result).toBeNull();
    expect(sends).toBe(0); expect(f.vmCalls).toEqual([]);
  }
});
