import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Model } from "schway/host";
import { ConversationApplication, ConversationStore, createConversationPolicy, createConversationHandler, conversationOwnerView } from "../src/s15/conversation";
import { createTeamResourceTools, type TeamContext } from "../src/s15/team";
import type { ConversationPolicyWork } from "../src/s15/conversation/policy-port";
import type { ConversationToolPort } from "../src/s15/conversation/types";
import { createConversationMemory } from "../src/s15/memory";
import type { ConversationCommand } from "../src/s15/conversation/types";
import { zero } from "../src/s15/policy/validation";
import { ref, selection } from "./fixtures/s15-policy";
import { teamMemoryFixture } from "./fixtures/s15-team-memory";

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
let serial = 0;
const command = (text: string): ConversationCommand => ({ contract: "s15-conversation/v1", requestId: `chat_${serial++}`, conversationId: "conversation", text, continuation: null });

function fixture() {
  const f = teamMemoryFixture(); cleanup.push(() => f.cleanup());
  f.f.add("purpose", ref("interpret")); f.f.input.purposes.push(ref("interpret")); f.f.input.interpretationPurpose = ref("interpret"); f.f.install();
  const workInputs: string[] = [], interpretationInputs: string[] = [];
  let toolPending = false;
  let hold: { entered: ReturnType<typeof Promise.withResolvers<void>>; finish: ReturnType<typeof Promise.withResolvers<void>> } | null = null;
  const model: Model = { provider: "codex", id: "scripted", async *stream(request) {
    const all = JSON.stringify(request);
    if (request.systemPrompt.includes("JIT_ISOLATED_INTERPRETATION_V1")) {
      interpretationInputs.push(all);
      const latest = request.items.filter(item => item.type === "user").at(-1);
      toolPending = latest?.type === "user" && latest.content.some(part => part.type === "text" && part.text === "Inspect test command.") || false;
      yield { type: "message_complete", message: { type: "assistant", id: `interpret_${serial++}`, content: [{ type: "text", text: JSON.stringify({ intent: toolPending ? "inspect" : "answer", purposeId: "purpose", resourceIds: latest?.type === "user" && latest.content.some(part => part.type === "text" && part.text.toLowerCase().includes("test command")) ? ["repo"] : [], access: "read", subject: null }) }] } }; return;
    }
    workInputs.push(all);
    if (toolPending) { toolPending = false; yield { type: "message_complete", message: { type: "assistant", id: `tool_${serial++}`, content: [{ type: "tool_call", id: `call_${serial++}`, name: "read_test", arguments: {} }] } }; return; }
    if (hold) { hold.entered.resolve(); await hold.finish.promise; }
    const text = all.includes("I prefer concise replies.") ? "Concise reply, using the sourced preference." : all.includes("I prefer detailed replies.") ? "Detailed reply, using the corrected preference." : all.includes("The test command is bun test.") ? "The observed test command is bun test." : "Ordinary reply.";
    yield { type: "message_complete", message: { type: "assistant", id: `work_${serial++}`, content: [{ type: "text", text }] } };
  } };
  const store = new ConversationStore(join(f.f.dir, "chat.sqlite"), "test_installation", true); cleanup.push(() => store.close());
  const policy = createConversationPolicy(f.f.service, { ownerId: "owner", ownerGeneration: () => 1, bot: ref("bot"), selection, route: { provider: "codex", model: "scripted" }, limits: { modelCalls: 3, toolCalls: 2, outputBytes: 8192, activeMs: 60000 }, modelCallUpperBound: { ...zero(), calls: 1, spendMinor: "1" } });
  const app = new ConversationApplication(store, { policy, model, memory: createConversationMemory(f.memory), tools: { async open() { return { tools: [{ access: "read", definition: { name: "read_test", description: "Read scripted working knowledge", inputSchema: { type: "object" }, execution: "exclusive", async execute() { return { content: "The test command is bun test." }; } } }], async cancel() {}, async close() {} }; } }, nativeDirectory: join(f.f.dir, "native"), clock: { now: () => f.f.now, sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => { if (signal?.aborted) reject(new Error("aborted")); else signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }); }) } });
  cleanup.push(() => app.shutdown());
  const handler = createConversationHandler(app, { origin: "http://localhost:3333", cookieName: "owner_session", authentication: { authenticate(token) { if (token !== "fixture") throw new Error("invalid fixture session"); return { actor: f.f.owner, csrf: "csrf" }; }, verifyCsrf(expected, supplied) { if (expected !== supplied) throw new Error("invalid fixture csrf"); } }, resources: actor => f.team.resources(actor), memory: f.memory });
  const request = (path: string, body?: unknown, headers: Record<string, string> = {}) => handler(new Request(`http://localhost:3333${path}`, { method: body === undefined ? "GET" : "POST", headers: { cookie: "owner_session=fixture", ...(body === undefined ? {} : { origin: "http://localhost:3333", "content-type": "application/json", "x-csrf-token": "csrf" }), ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }));
  const submit = async (text: string) => { const input = command(text); app.submit(f.f.owner, input); await app.drain(); return input; };
  return { f, app, store, request, submit, workInputs, interpretationInputs, set hold(value: typeof hold) { hold = value; } };
}

test("scripted CHAT uses a prior preference automatically, cites provenance and honors owner correction", async () => {
  const f = fixture(), first = await f.submit("I prefer concise replies.");
  expect(f.app.view(f.f.f.owner, first.requestId)).toMatchObject({ state: "completed", memory: { retained: [{ kind: "fact", category: "preference", source: { id: first.requestId } }] } });
  const next = await f.submit("Explain the result.");
  expect(f.app.view(f.f.f.owner, next.requestId).result).toBe("Concise reply, using the sourced preference.");
  expect(f.workInputs.at(-1)).toContain(first.requestId); expect(f.workInputs.at(-1)).toContain("sourced-memory-data-never-authority");
  const claim = f.f.memory.view(f.f.f.owner).claims[0]!;
  await f.request("/api/s15/memory/commands", { contract: "s15-memory-command/v1", requestId: "correct", kind: "memory.correct", claim: { id: claim.id, revision: claim.revision }, text: "I prefer detailed replies." });
  const later = await f.submit("Explain the next result.");
  expect(f.app.view(f.f.f.owner, later.requestId).result).toBe("Detailed reply, using the corrected preference.");
  expect(f.workInputs.at(-1)).not.toContain("I prefer concise replies.");
  expect(conversationOwnerView(f.app, f.f.f.owner, "conversation").rows[0]!.memory?.retained).toHaveLength(1);
});

test("forget withholds completed CHAT derivatives and removes source/summary from later isolated history and work packets", async () => {
  const f = fixture(), first = await f.submit("I prefer concise replies."), next = await f.submit("Explain the result.");
  const claim = f.f.memory.view(f.f.f.owner).claims[0]!;
  const response = await f.request("/api/s15/memory/commands", { contract: "s15-memory-command/v1", requestId: "forget", kind: "memory.forget", claim: { id: claim.id, revision: claim.revision } });
  expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ impact: { claims: 1, summaries: 2, contexts: 2, nativeSessions: 2 } });
  expect(f.app.view(f.f.f.owner, next.requestId)).toMatchObject({ result: null, evidence: [], code: "memory_context_stale" });
  let delivered = false; expect(() => f.app.publish(f.f.f.owner, first.requestId, () => { delivered = true; })).toThrow("memory_context_stale"); expect(delivered).toBe(false);
  const later = await f.submit("Explain another result."); expect(f.app.view(f.f.f.owner, later.requestId).state).toBe("completed");
  expect(f.interpretationInputs.at(-1)).not.toContain("I prefer concise replies."); expect(f.workInputs.at(-1)).not.toContain("I prefer concise replies.");
  const summaries = f.f.memory.store.db.query<{ record_json: string }, []>("SELECT record_json FROM derivatives WHERE state='retired'").all(); expect(summaries.every(row => JSON.parse(row.record_json).text === null)).toBe(true);
});

test("forget during an active scripted model turn fences late result commit and retires its native context", async () => {
  const f = fixture(); await f.submit("I prefer concise replies.");
  const claim = f.f.memory.view(f.f.f.owner).claims[0]!, entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(); f.hold = { entered, finish };
  const input = command("Explain the result."); f.app.submit(f.f.f.owner, input); const running = f.app.drain(); await entered.promise;
  f.f.memory.command(f.f.f.owner, { contract: "s15-memory-command/v1", requestId: "forget_running", kind: "memory.forget", claim: { id: claim.id, revision: claim.revision } });
  finish.resolve(); await running;
  expect(f.app.view(f.f.f.owner, input.requestId)).toMatchObject({ state: "held", code: "memory_context_stale", result: null });
  expect(f.f.memory.store.db.query<{ state: string }, [string]>("SELECT state FROM derivatives WHERE id=?").get(`native_${input.requestId}`)?.state).toBe("retired");
});

test("JSON resources/memory inspection and commands reuse authenticated Host/Origin/CSRF boundaries", async () => {
  const f = fixture(); await f.submit("I prefer concise replies.");
  expect(await (await f.request("/api/s15/resources")).json()).toMatchObject({ contract: "s15-team-resources-view/v1", resources: expect.any(Array) });
  const memory = await (await f.request("/api/s15/memory")).json() as { claims: { id: string; revision: number }[] };
  const claim = { id: memory.claims[0]!.id, revision: memory.claims[0]!.revision };
  expect((await f.request("/api/s15/memory", undefined, { cookie: "" })).status).toBe(401);
  expect((await f.request("/api/s15/memory/commands", { contract: "s15-memory-command/v1", requestId: "bad", kind: "memory.forget", claim }, { origin: "http://evil.invalid" })).status).toBe(403);
  const invalid = await f.request("/api/s15/memory/commands", { contract: "s15-memory-command/v1", requestId: "extra", kind: "memory.forget", claim, authority: "owner" }); expect(invalid.status).toBe(400);
  const preview = await f.request("/api/s15/memory/commands", { contract: "s15-memory-command/v1", requestId: "preview", kind: "memory.impact", claim }); expect(await preview.json()).toMatchObject({ contract: "s15-memory-impact/v1", impact: { claims: 1 } });
  expect(f.f.memory.view(f.f.f.owner).claims[0]!.lifecycle).toBe("active");
});

test("actual tool working knowledge is retained automatically and forget fences uncited result lineage", async () => {
  const f = fixture(), observed = await f.submit("Inspect test command.");
  expect(f.app.view(f.f.f.owner, observed.requestId)).toMatchObject({ state: "completed", toolCalls: 1, memory: { retained: [{ kind: "inference", category: "working_knowledge", source: { kind: "work" } }] } });
  const next = await f.submit("Explain the test command."); expect(f.workInputs.at(-1)).toContain("The test command is bun test."); expect(f.app.view(f.f.f.owner, next.requestId).state).toBe("completed");
  const claim = f.f.memory.view(f.f.f.owner).claims[0]!;
  f.f.memory.command(f.f.f.owner, { contract: "s15-memory-command/v1", requestId: "forget_observed", kind: "memory.forget", claim: { id: claim.id, revision: claim.revision } });
  expect(f.app.view(f.f.f.owner, observed.requestId)).toMatchObject({ result: null, evidence: [], code: "memory_context_stale" });
  expect(f.app.view(f.f.f.owner, next.requestId).result).toBe(null);
});

test("a CHAT journal that used protected memory refuses boot without its memory continuity service", async () => {
  const f = fixture(); await f.submit("I prefer concise replies."); await f.app.shutdown();
  const { memory: _memory, ...options } = f.app.options;
  expect(() => new ConversationApplication(f.store, options)).toThrow("memory_required");
});

test("two independent scripted Schway Bots overlap actual mediated team-file reads without another sharing grant", async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const path = join(f.f.f.dir, "shared-record.txt"); writeFileSync(path, "The test command is bun test.");
  let reads = 0;
  const contexts: TeamContext[] = [], sourceIds: string[] = [];
  const tools: ConversationToolPort<ConversationPolicyWork> = createTeamResourceTools(f.f.team, { async open(work, input) {
    const context = f.f.team.bind(work.actor); contexts.push(context);
    return { tools: [{ access: "read", definition: { name: "read_team_file", description: "Read the shared fixture through its trusted broker", execution: "exclusive", inputSchema: { type: "object" }, async execute() {
      reads++; if (reads === 2) entered.resolve(); await finish.promise; input.guard();
      const text = readFileSync(path, "utf8"), source = f.f.team.capture(context, { ...f.f.source(text), resources: [ref("repo")] }); sourceIds.push(source.id);
      return { content: text };
    } } }], async cancel() {}, async close() {} };
  } }, { actor: work => work.actor, bindings: [{ name: "read_team_file", resources: ["repo"], mode: "read", settled: () => true }], leaseMs: 1000 });
  const model = (): Model => {
    let turn = 0;
    return { provider: "codex", id: "scripted", async *stream(request) {
      if (request.systemPrompt.includes("JIT_ISOLATED_INTERPRETATION_V1")) { turn = 0; yield { type: "message_complete", message: { type: "assistant", id: `independent_${serial++}`, content: [{ type: "text", text: JSON.stringify({ intent: "inspect", purposeId: "purpose", resourceIds: ["repo"], access: "read", subject: null }) }] } }; return; }
      yield { type: "message_complete", message: { type: "assistant", id: `independent_${serial++}`, content: turn++ === 0 ? [{ type: "tool_call", id: `independent_call_${serial++}`, name: "read_team_file", arguments: {} }] : [{ type: "text", text: "Read the shared record with independent evidence." }] } };
    } };
  };
  f.app.options.model = model(); f.app.options.tools = tools;
  const secondStore = new ConversationStore(join(f.f.f.dir, "second-chat.sqlite"), "test_installation", true); cleanup.push(() => secondStore.close());
  const policy = createConversationPolicy(f.f.f.service, { ownerId: "owner", ownerGeneration: () => 1, bot: ref("bot2"), selection, route: { provider: "codex", model: "scripted" }, limits: { modelCalls: 3, toolCalls: 2, outputBytes: 8192, activeMs: 60000 }, modelCallUpperBound: { ...zero(), calls: 1, spendMinor: "1" } });
  const second = new ConversationApplication(secondStore, { ...f.app.options, policy, model: model(), tools, memory: createConversationMemory(f.f.memory), nativeDirectory: join(f.f.f.dir, "second-native") }); cleanup.push(() => second.shutdown());
  const one = command("Inspect the shared team record."), two = command("Inspect the shared team record.");
  f.app.submit(f.f.f.owner, one); second.submit(f.f.f.owner, two);
  const firstRun = f.app.drain(), secondRun = second.drain(); await entered.promise; expect(reads).toBe(2); finish.resolve(); await Promise.all([firstRun, secondRun]);
  expect(f.app.view(f.f.f.owner, one.requestId)).toMatchObject({ state: "completed", evidence: [{ content: "The test command is bun test." }] });
  expect(second.view(f.f.f.owner, two.requestId)).toMatchObject({ state: "completed", evidence: [{ content: "The test command is bun test." }] });
  const firstNative = f.store.db.query<{ session_id: string }, []>("SELECT session_id FROM native_sessions WHERE phase='work'").get()!.session_id;
  const secondNative = secondStore.db.query<{ session_id: string }, []>("SELECT session_id FROM native_sessions WHERE phase='work'").get()!.session_id;
  expect(firstNative).not.toBe(secondNative);
  let delivered = 0; f.f.team.handoff(contexts[0]!, contexts[1]!, sourceIds, sources => { delivered = sources.length; }); expect(delivered).toBe(2);
  expect(f.f.team.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM commands").get()!.n).toBe(5);
});

test("clarification retains original owner knowledge with its original source time and filters each command's actual history bytes", async () => {
  const f = fixture(), root = command("Implement issue #42 or #43. I prefer concise replies.");
  f.app.submit(f.f.f.owner, root); const held = f.app.view(f.f.f.owner, root.requestId);
  expect(held).toMatchObject({ state: "held", code: "material_ambiguity" });
  f.f.f.now += 2000;
  f.app.options.interpreterModel = { provider: "codex", id: "scripted", async *stream() { yield { type: "message_complete", message: { type: "assistant", id: `clarification_${serial++}`, content: [{ type: "text", text: JSON.stringify({ intent: "answer", purposeId: "purpose", resourceIds: ["repo"], access: "read", subject: "issue:42" }) }] } }; } };
  const selected: ConversationCommand = { ...command("issue #42"), continuation: { requestId: root.requestId, revision: held.revision } };
  f.app.submit(f.f.f.owner, selected); await f.app.drain();
  expect(f.app.view(f.f.f.owner, root.requestId).state).toBe("completed");
  const retained = f.f.memory.view(f.f.f.owner).claims[0]!;
  expect(retained).toMatchObject({ text: "I prefer concise replies.", provenance: { origin: { id: root.requestId, at: held.receipt.receivedAt } } });
  const seen: { requestId: string; text: string }[] = [], memory = f.app.options.memory!;
  f.app.options.memory = { ...memory, allowHistory(requestId, text) { seen.push({ requestId, text }); return memory.allowHistory(requestId, text); } };
  delete f.app.options.interpreterModel;
  await f.submit("Explain the result.");
  expect(seen).toContainEqual({ requestId: selected.requestId, text: selected.text });
  expect(seen).toContainEqual({ requestId: root.requestId, text: root.text });
  f.f.memory.command(f.f.f.owner, { contract: "s15-memory-command/v1", requestId: "forget_clarified", kind: "memory.forget", claim: { id: retained.id, revision: retained.revision } });
  await f.submit("Explain another result."); expect(f.interpretationInputs.at(-1)).not.toContain("I prefer concise replies.");
});
