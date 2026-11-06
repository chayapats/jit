import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model, ModelRequest } from "schway/host";
import { composedFixture, ref } from "./fixtures/s15-composition";
import type { S15CompositionOptions } from "../src/s15/composition";
import type { FileUpload, FileReceipt } from "../src/s16/files/types";
import { ConversationStore } from "../src/s15/conversation/store";
import { ProtectedDataStore } from "../src/s15/team/store";
import { MEMORY_SCHEMA_V1 } from "../src/s15/memory/store";
import { memoryDerivativeId } from "../src/s15/memory/identity";
import { binaryRuntime, fixtureImage, imageProbes } from "./fixtures/s16-binary";
import { routeTransport, ROUTE_MODEL } from "./fixtures/s15-route-transport";

const all: Awaited<ReturnType<typeof composedFixture>>[] = [];
afterEach(async () => { for (const f of all.splice(0)) await f.close(); });
const hash = (text: string | Uint8Array) => createHash("sha256").update(text).digest("hex");
const fact = "Working knowledge: The launch day is Friday.\n";
async function world(tune?: (options: S15CompositionOptions) => S15CompositionOptions) {
  const captures: ModelRequest[] = []; let inputId = "", phase = "file", calls = 0, offsets = [0];
  let wait: { entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | null = null;
  // Match the fact text, not a weekday: Schway adds the local date and weekday to every model request.
  const model: Model = { provider: "codex-subscription", id: "fixture-model", async *stream(request) {
    captures.push(request); const body = JSON.stringify(request);
    if (phase === "answer" && wait) { const held = wait; wait = null; held.entered.resolve(); await held.release.promise; }
    const step = calls++; const parts = phase === "file" ? step < offsets.length ? [{ type: "tool_call" as const, id: "read" + step, name: "file_read", arguments: { id: inputId, offset: offsets[step]! } }] : step === offsets.length ? [{ type: "tool_call" as const, id: "create", name: "file_create", arguments: { name: "summary.md", text: body.includes("launch day is Friday") ? "Launch day: Friday.\n" : "No observed launch day.\n" } }] : [{ type: "text" as const, text: "Created a summary from the observed file." }] : [{ type: "text" as const, text: body.includes("launch day is Monday") ? "The launch day is Monday." : body.includes("launch day is Friday") ? "The launch day is Friday." : "No launch memory is available." }];
    yield { type: "message_complete", message: { type: "assistant", id: "m" + captures.length, content: parts } };
  } };
  const f = await composedFixture("default", false, undefined, options => {
    options.proposedPolicy!.rules[0]!.adapters.push("s16_files"); options.proposedPolicy!.rules[0]!.operations.push("artifact_create");
    const configured = { ...options, files: { memory: true }, model: { ...options.model, scripted: () => model } }; return tune ? tune(configured) : configured;
  }); all.push(f);
  async function file(text = fact, id = "filework", reads = [0], completed = true) {
    phase = "file"; calls = 0; offsets = reads;
    const started = await f.request(`/api/s16/client/conversations/${id}/uploads`, "POST", { requestId: "up_" + hash(id), conversationId: id, name: "knowledge.txt", bytes: Buffer.byteLength(text), sha256: hash(text) });
    expect(started.status).toBe(201); const pending = await started.json() as FileUpload;
    const response = await f.raw(`/api/s16/client/uploads/${pending.id}/bytes`, text); expect({ status: response.status, error: response.ok ? null : await response.clone().text() }).toEqual({ status: 200, error: null });
    const receipt = (await response.json() as FileUpload).receipt!; inputId = receipt.id;
    expect((await f.request(`/api/s16/client/conversations/${id}/messages`, "POST", { contract: "s16-conversation/v2", requestId: id, conversationId: id, text: "Create a downloadable summary from this file", continuation: null, files: [{ id: receipt.id, sha256: receipt.sha256 }] })).status).toBe(202);
    await f.service.conversation.drain(); const row = f.service.conversation.view(f.owner, id); expect({ state: row.state, code: row.code }).toEqual(completed ? { state: "completed", code: null } : { state: "held", code: "file_read_required" }); phase = "answer";
    return { receipt, row, artifact: row.artifacts?.length ? `/api/s16/client/requests/${id}/artifacts/${row.artifacts[0]!.id}` : "" };
  }
  async function answer(id = "later", conversation = id, text = "What does working knowledge say about the launch day?") {
    phase = "answer"; f.interpretation = { intent: "answer", purposeId: "purpose", resourceIds: ["computer"], access: "read", subject: null };
    expect((await f.request(`/api/s16/client/conversations/${conversation}/messages`, "POST", { contract: "s15-conversation/v1", requestId: id, conversationId: conversation, text, continuation: null })).status).toBe(202);
    await f.service.conversation.drain(); return f.service.conversation.view(f.owner, id);
  }
  return { f, captures, file, answer, hold() { const held = { entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }; wait = held; return held; } };
}

test("actual observed file knowledge changes a later request through exact sourced memory, including restart", async () => {
  const w = await world(), source = await w.file(), claims = w.f.service.memory.view(w.f.owner).claims;
  expect(claims).toHaveLength(1); expect(claims[0]).toMatchObject({ kind: "inference", confirmation: "unconfirmed", text: fact.trim(), provenance: { filePins: [{ source: { id: source.receipt.id }, sha256: source.receipt.sha256, representationSha256: null }] } });
  const later = await w.answer(); expect(later.result).toBe("The launch day is Friday.");
  expect(JSON.stringify(w.captures.at(-1))).toContain(source.receipt.sha256); expect(JSON.stringify(w.captures.at(-1))).toContain(fact.trim());
  const bootstrap = await (await w.f.request("/api/s16/client/bootstrap")).json(); expect(bootstrap.capabilities).toMatchObject({ revision: 2, uploads: { memory: true, memoryContract: "s16-file-memory/v1" } });
  expect(readFileSync(join(w.f.directory, "conversation.sqlite")).readUInt32BE(60)).toBe(4);
  expect(readFileSync(join(w.f.directory, "team.sqlite")).readUInt32BE(60)).toBe(2); expect(readFileSync(join(w.f.directory, "memory.sqlite")).readUInt32BE(60)).toBe(4);
  await w.f.reopen(); expect((await w.answer("restarted")).result).toBe("The launch day is Friday.");
  await w.f.service.close(); expect(() => new ConversationStore(join(w.f.directory, "conversation.sqlite"), "fixture", false, true)).toThrow("conversation_store_incompatible");
  expect(() => new ProtectedDataStore(join(w.f.directory, "memory.sqlite"), "fixture", false, 0x4a495437, MEMORY_SCHEMA_V1)).toThrow("s15_data_store_incompatible");
  expect(() => new ProtectedDataStore(join(w.f.directory, "memory.sqlite"), "fixture", false, 0x4a495437, MEMORY_SCHEMA_V1, true)).toThrow("s15_data_store_incompatible");
  expect(() => new ProtectedDataStore(join(w.f.directory, "memory.sqlite"), "fixture", false, 0x4a495437, MEMORY_SCHEMA_V1, false, [1, 3])).toThrow("s15_data_store_incompatible");
});
test("withdrawal invalidates memory, history and old artifact downloads without blocking clean unrelated work", async () => {
  const w = await world(), source = await w.file(); expect((await w.answer()).result).toContain("Friday");
  await w.f.request(`/api/s16/client/uploads/${source.receipt.id}/withdraw`, "POST", {});
  expect((await w.f.request(source.artifact)).status).toBe(409);
  expect(w.f.service.memory.view(w.f.owner).claims[0]).toMatchObject({ sourceState: "withdrawn", text: "", quote: "" });
  const before = w.f.interpreterPrompts.length, later = await w.answer("clean", "later", "Tell me the working knowledge about the launch day.");
  expect({ state: later.state, result: later.result }).toEqual({ state: "completed", result: "No launch memory is available." });
  expect(w.f.interpreterPrompts.slice(before).join()).not.toContain("The launch day is Friday");
  await w.f.reopen(); expect((await w.answer("after_restart")).result).toBe("No launch memory is available.");
});
test("an exact generic-computer source approval does not authorize file-derived memory for a new model request", async () => {
  const w = await world(); await w.file();
  for (const approval of w.f.recipientApprovals) if (approval.purpose.id === "purpose") approval.sources = w.f.dataSources.map(source => source.ref);
  const count = w.captures.length, result = await w.answer(); expect(result.result).toBeNull(); expect(result.state).toBe("held"); expect(w.captures).toHaveLength(count);
});
test("file-dependent interpreter history has its own exact recipient check before a physical model send", async () => {
  const w = await world(); await w.file(); await w.answer("first", "conversation");
  const inference = w.f.service.policy.owner.prepareInterpretation(w.f.owner, { requestId: "history_probe", selection: w.f.choice, expiresAt: 800000 });
  const context = w.f.service.memory.options.team.bindHistory(w.f.service.policy.control.bindWork(inference.authority.id));
  expect(w.f.service.memory.history(context, "first", "What does working knowledge say about the launch day?")).toHaveLength(1);
  for (const approval of w.f.recipientApprovals) if (approval.purpose.id === "interpret") approval.sources = w.f.dataSources.map(source => source.ref);
  const count = w.f.interpreterPrompts.length, result = await w.answer("second", "conversation");
  expect(result.result).toBeNull(); expect(result.state).toBe("held"); expect(w.f.interpreterPrompts).toHaveLength(count);
});
test("owner correction and forget keep original file ancestry and fence stale artifacts/uncited replies", async () => {
  const w = await world(), source = await w.file(); await w.answer();
  const original = w.f.service.memory.view(w.f.owner).claims[0]!;
  const impact = w.f.service.memory.command(w.f.owner, { contract: "s15-memory-command/v1", requestId: "impact", kind: "memory.impact", claim: { id: original.id, revision: original.revision } }) as { impact: { artifacts: number } };
  expect(impact.impact.artifacts).toBe(1);
  const corrected = await w.f.service.memory.command(w.f.owner, { contract: "s15-memory-command/v1", requestId: "correct", kind: "memory.correct", claim: { id: original.id, revision: original.revision }, text: "Working knowledge: The launch day is Monday." }) as { claim: { id: string; revision: number } };
  expect((await w.f.request(source.artifact)).status).toBe(409); expect(w.f.service.conversation.view(w.f.owner, "later").result).toBeNull();
  expect((await w.answer("corrected")).result).toBe("The launch day is Monday.");
  const replacement = w.f.service.memory.view(w.f.owner).claims.find(claim => claim.id === corrected.claim.id)!; expect(replacement.provenance.filePins).toEqual(original.provenance.filePins);
  w.f.service.memory.command(w.f.owner, { contract: "s15-memory-command/v1", requestId: "forget", kind: "memory.forget", claim: corrected.claim });
  expect((await w.answer("forgotten")).result).toBe("No launch memory is available."); await w.f.reopen(); expect((await w.answer("forgotten_restart")).result).toBe("No launch memory is available.");
});
test("withdrawal or forget during a model wait fences the late reply and its next publication", async () => {
  for (const operation of ["withdraw", "forget"]) {
    const w = await world(), source = await w.file(), held = w.hold(), running = w.answer(); await held.entered.promise;
    if (operation === "withdraw") await w.f.request(`/api/s16/client/uploads/${source.receipt.id}/withdraw`, "POST", {});
    else { const claim = w.f.service.memory.view(w.f.owner).claims[0]!; w.f.service.memory.command(w.f.owner, { contract: "s15-memory-command/v1", requestId: "forget_wait", kind: "memory.forget", claim: { id: claim.id, revision: claim.revision } }); }
    held.release.resolve(); const result = await running; expect(result.result).toBeNull(); expect(result.state).toBe("held"); expect((await w.f.request(source.artifact)).status).toBe(409);
  }
});
test("private Bot knowledge stays private after routing a fresh conversation to a peer Bot", async () => {
  let peer = false;
  const w = await world(options => ({ ...options, conversation: { ...options.conversation, bot: ref(peer ? "specialist" : "bot") }, team: { ...options.team!, retention: authority => ({ kind: "bot", botId: authority.request.bot.id, origin: "s15" }) } }));
  const source = await w.file(); await w.answer("private", "conversation"); peer = true; await w.f.reopen();
  const count = w.f.interpreterPrompts.length, result = await w.answer("peer", "conversation");
  expect(result.result).toBe("No launch memory is available."); expect(w.f.interpreterPrompts.slice(count).join()).not.toContain("The launch day is Friday"); expect(JSON.stringify(w.captures.at(-1))).not.toContain(source.receipt.sha256);
});
test("metadata ancestry does not release original bytes, while final use rejects tampered custody", async () => {
  const w = await world(), source = await w.file();
  const original = readFileSync(join(w.f.directory, "file-bytes", source.receipt.id + ".blob"));
  writeFileSync(join(w.f.directory, "file-bytes", source.receipt.id + ".blob"), Buffer.alloc(original.length, 65));
  const work = w.f.service.policy.control.bindWork(source.row.authority!.id), context = w.f.service.memory.options.team.bind(work);
  expect(w.f.service.memory.ancestry(context, "filework")).toHaveLength(1);
  const count = w.captures.length, result = await w.answer(); expect(result.result).toBeNull(); expect(result.state).toBe("held"); expect(w.captures).toHaveLength(count);
});
test("an inference-only history context cannot capture new sources or read raw TEAM payloads", async () => {
  const w = await world(); await w.file(); const claim = w.f.service.memory.view(w.f.owner).claims[0]!;
  const prepared = w.f.service.policy.owner.prepareInterpretation(w.f.owner, { requestId: "history_only", selection: w.f.choice, bot: ref("bot"), expiresAt: 800000 }), team = w.f.service.memory.options.team, context = team.bindHistory(w.f.service.policy.control.bindWork(prepared.authority.id));
  expect(team.historyAncestry(context, [claim.provenance.teamSourceId!])).toHaveLength(1);
  expect(() => team.source(context, claim.provenance.teamSourceId!)).toThrow("outside_scope");
  expect(() => team.capture(context, { id: "forbidden", text: "Private source", scope: { kind: "team" }, origin: { kind: "work", id: "history_only", conversationId: null, at: 1000 }, resources: [], parents: [] })).toThrow("outside_scope");
  expect(() => team.resource(context, "computer")).toThrow("outside_scope");
});
test("enabling file memory never adopts a previously accepted text-only file command", async () => {
  let enabled = false; const w = await world(options => ({ ...options, files: { memory: enabled } }));
  const source = await w.file(); expect(source.row.fileMemory).toBeUndefined(); expect(w.f.service.memory.view(w.f.owner).claims).toEqual([]);
  enabled = true; await w.f.reopen(); expect((await w.answer()).result).toBe("No launch memory is available."); expect(w.f.service.conversation.view(w.f.owner, "filework").fileMemory).toBeUndefined();
});
test("actual image-derived inference keeps both hashes; forgetting blocks automatic paraphrase replay", async () => {
  let image = true, turn = 0, seen = "", wording = "The inspected image checksum is"; const captured: ModelRequest[] = [];
  const model: Model = { provider: "codex-subscription", id: "fixture-model", async *stream(request) {
    captured.push(request);
    if (image) { expect(request.imageData?.size).toBe(1); seen = hash([...request.imageData!.values()][0]!); }
    const parts = image ? turn++ === 0 ? [{ type: "tool_call" as const, id: "create" + turn, name: "file_create", arguments: { name: "image.md", text: "Observed image checksum: " + seen } }] : [{ type: "text" as const, text: `Working knowledge: ${wording} ${seen}.` }] : [{ type: "text" as const, text: JSON.stringify(request).includes(seen) ? "Remembered the inspected image checksum." : "No inspected image knowledge." }];
    yield { type: "message_complete", message: { type: "assistant", id: "image" + captured.length, content: parts } };
  } };
  const w = await world(options => ({ ...options, files: { ...options.files!, parserRuntime: binaryRuntime(), imageProbes }, model: { ...options.model, scripted: () => model } }));
  const bytes = fixtureImage("metadata-polyglot.png"), pending = await (await w.f.request("/api/s16/client/conversations/imagework/uploads", "POST", { requestId: "image", conversationId: "imagework", name: "pixels.png", bytes: bytes.length, sha256: hash(bytes) })).json() as FileUpload;
  const receipt = (await (await w.f.raw(`/api/s16/client/uploads/${pending.id}/bytes`, bytes.buffer)).json() as FileUpload).receipt!;
  const command = { contract: "s16-conversation/v2", requestId: "imagework", conversationId: "imagework", text: "Create a downloadable image inspection brief", continuation: null, files: [{ id: receipt.id, sha256: receipt.sha256 }] };
  expect((await w.f.request("/api/s16/client/conversations/imagework/messages", "POST", command)).status).toBe(202); await w.f.service.conversation.drain(); expect(w.f.service.conversation.view(w.f.owner, "imagework").state).toBe("completed");
  const claim = w.f.service.memory.view(w.f.owner).claims[0]!; expect(claim).toMatchObject({ kind: "inference", confirmation: "unconfirmed", provenance: { filePins: [{ source: { id: receipt.id }, sha256: receipt.sha256, representationSha256: seen }] } }); expect(seen).not.toBe(receipt.sha256);
  image = false; expect((await w.answer("image_later", "image_later", "What working knowledge records the inspected image checksum?")).result).toContain("Remembered"); expect(captured.at(-1)!.imageData).toBeUndefined();
  w.f.service.memory.command(w.f.owner, { contract: "s15-memory-command/v1", requestId: "forget_image", kind: "memory.forget", claim: { id: claim.id, revision: claim.revision } });
  image = true; turn = 0; wording = "A different paraphrase of the recorded checksum is"; w.f.interpretation = { intent: "execute", purposeId: "purpose", resourceIds: ["computer"], access: "reversible_write", subject: null };
  expect((await w.f.request("/api/s16/client/conversations/imagework/messages", "POST", { ...command, requestId: "image_again" })).status).toBe(202); await w.f.service.conversation.drain(); expect({ state: w.f.service.conversation.view(w.f.owner, "image_again").state, code: w.f.service.conversation.view(w.f.owner, "image_again").code }).toEqual({ state: "completed", code: null });
  expect(w.f.service.memory.view(w.f.owner).claims).toHaveLength(1); expect(w.f.service.memory.view(w.f.owner).claims[0]!.lifecycle).toBe("forgotten");
});
test("file-memory withdrawal during native auth renewal fences the physical resend", async () => {
  let native = false, w!: Awaited<ReturnType<typeof world>>, original!: FileReceipt;
  const transport = routeTransport("grok", { responses: [401, "ok"], async renewal() { w.f.service.files!.withdraw(w.f.owner, original.id); } });
  w = await world(options => { const { scripted: _scripted, ...nativeModel } = options.model; return native ? { ...options, conversation: { ...options.conversation, route: { provider: "grok", model: ROUTE_MODEL.grok } }, credentials: { store: transport.store, fetch: transport.fetch }, interpreter: { ...options.interpreter!, provider: "xai", id: ROUTE_MODEL.grok }, model: nativeModel } : options; });
  original = (await w.file()).receipt; native = true; w.f.route.provider = "grok"; w.f.route.modelId = ROUTE_MODEL.grok; w.f.route.charge = "metered"; await w.f.reopen();
  const result = await w.answer("native_resend"); expect(result.result).toBeNull(); expect(result.state).toBe("held"); expect(transport.bodies).toHaveLength(1); expect(transport.bodies[0]).toContain("Friday");
  expect(w.f.service.models.project(w.f.owner).selections.some(row => row.physicalDispatches?.some(send => send.kind === "auth-retry" && send.refusal !== null))).toBe(true);
});
test("a useful line crossing read chunks is retained only after every byte was actually observed", async () => {
  const input = "x".repeat(4080) + "\n" + fact;
  const partial = await world(); await partial.file(input, "partial", [0], false); expect(partial.f.service.memory.view(partial.f.owner).claims).toEqual([]);
  const complete = await world(); await complete.file(input, "complete", [0, 4096]); expect(complete.f.service.memory.view(complete.f.owner).claims).toHaveLength(1); expect((await complete.answer()).result).toContain("Friday");
  const repeated = await world(); await repeated.file(fact, "repeat", [0, 0]); expect(repeated.f.service.memory.view(repeated.f.owner).claims).toHaveLength(1);
});
test("original/hash/generation/resource substitution cannot become a new TEAM memory source", async () => {
  const w = await world(), source = await w.file(), pin = w.f.service.files!.pin(w.f.owner, source.receipt.id), team = w.f.service.memory.options.team;
  const context = team.bind(w.f.service.policy.control.bindWork(source.row.authority!.id));
  for (const forged of [{ ...pin, sha256: "0".repeat(64) }, { ...pin, source: { ...pin.source, generation: 2 } }, { ...pin, resource: ref("repo") }, { ...pin, representationSha256: "0".repeat(64) }]) {
    expect(w.f.service.files!.pinsCurrent([forged])).toBe(false);
    expect(() => team.capture(context, { id: "forged", text: fact, scope: { kind: "team" }, origin: { kind: "work", id: "forged", conversationId: null, at: 1000 }, resources: [ref("computer")], parents: [], filePins: [forged] })).toThrow("lineage_withdrawn");
  }
});
test("an authorized VM tool receives the actual memory-derived content under the same source guards", async () => {
  let vm = false, turns = 0; const transported: Record<string, unknown>[] = [];
  const w = await world(options => {
    const scripted = options.model.scripted!, openTransport = options.vm.transport!;
    return { ...options, model: { ...options.model, scripted(route) { const original = scripted(route); return { ...original, async *stream(request, call) { if (!vm) { yield* original.stream(request, call); return; } const found = JSON.stringify(request).includes("Friday"); yield { type: "message_complete", message: { type: "assistant", id: "vm" + turns, content: turns++ === 0 ? [{ type: "tool_call", id: "bash", name: "bash", arguments: { command: found ? "printf Friday" : "printf no_memory" } }] : [{ type: "text", text: "Completed the authorized memory-based command." }] } }; } }; } },
      vm: { ...options.vm, transport(...args) { const transport = openTransport(...args), invoke = transport.invoke.bind(transport); transport.invoke = async (request, input) => { transported.push(request); return invoke(request, input); }; return transport; } } };
  });
  await w.file(); vm = true; w.f.interpretation = { intent: "execute", purposeId: "purpose", resourceIds: ["computer"], access: "reversible_write", subject: null };
  const result = await w.f.chat("Run a command using the working knowledge about the launch day", "vm_memory");
  expect({ state: result.state, code: result.code }).toEqual({ state: "completed", code: null }); expect(w.f.vmCalls).toContain("spawn"); expect(JSON.stringify(transported)).toContain("printf Friday");
});
test("a maximum-length client request identity does not overflow internal memory observation keys", async () => {
  const w = await world(); await w.file(fact, "r".repeat(128)); expect((await w.answer()).result).toContain("Friday");
  await w.f.reopen(); expect((await w.answer("after_long_id_restart")).result).toContain("Friday");
});

test.each([false, true])("public aliases of old native/reply keys cannot replace file lineage (long first: %s)", async longFirst => {
  const w = await world(), source = await w.file(), long = "r".repeat(128);
  const aliases = [`memory_${hash(`native_${long}`)}`, `memory_${hash(`reply_${long}`)}`, "native_short", "reply_short"];
  const answer = async (id: string, text?: string) => { const result = await w.answer(id, id, text); expect(result.state).toBe("completed"); return result; };
  if (longFirst) { await answer(long, "Tell me a short greeting"); await answer("short", "Tell me another greeting"); }
  for (const alias of aliases) expect((await answer(alias)).result).toContain("Friday");
  if (!longFirst) { await answer(long, "Tell me a short greeting"); await answer("short", "Tell me another greeting"); }
  const rows = () => w.f.service.memory.store.db.query<{ record_json: string }, [string]>("SELECT record_json FROM derivatives WHERE id=?");
  for (const alias of aliases) expect(JSON.parse(rows().get(alias)!.record_json)).toMatchObject({ kind: "context", filePins: [expect.objectContaining({ sha256: source.receipt.sha256 })] });
  expect(JSON.parse(rows().get(memoryDerivativeId("native", long))!.record_json)).toMatchObject({ kind: "native", claimIds: [] });
  await w.f.reopen();
  await w.f.request(`/api/s16/client/uploads/${source.receipt.id}/withdraw`, "POST", {});
  for (const alias of aliases) expect(w.f.service.conversation.view(w.f.owner, alias).result).toBeNull();
});
