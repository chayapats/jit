import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, ModelRequest, ToolDefinition } from "schway/host";
import { AppError } from "../src/errors";
import { ConversationApplication } from "../src/s15/conversation/application";
import { groundConversationIntent } from "../src/s15/conversation/intent";
import { conversationOwnerView } from "../src/s15/conversation/owner-view";
import { ConversationStore } from "../src/s15/conversation/store";
import type { ConversationAuthority, ConversationCommand, ConversationPolicy, ConversationSteerCommand, ConversationToolPort } from "../src/s15/conversation/types";

/**
 * CHAT16-02 (#406): owner steering of an unfinished request through `schway.host.steering/v1`, its durable
 * dispositions across completion/stop/restart, and independent conversations running concurrently. Scripted
 * models and barriers only; no live provider.
 */
const roots: string[] = [], stores: ConversationStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const id = () => crypto.randomUUID().replaceAll("-", "");
const message = (text: string, conversationId = "conversation", requestId = id()): ConversationCommand => ({ contract: "s15-conversation/v1", requestId, conversationId, text, continuation: null });
const steer = (target: string, text: string, conversationId = "conversation", requestId = id()): ConversationSteerCommand => ({ contract: "s16-conversation-steer/v1", requestId, conversationId, target, text });
const userTexts = (request: ModelRequest) => request.items.flatMap(item => item.type === "user" ? item.content.filter(part => part.type === "text").map(part => part.text) : []);
const settle = () => new Promise(resolve => setTimeout(resolve, 5));
type Actor = { ownerId: string };
type Work = { authority: ConversationAuthority };

function fixture(options: { tool?: (conversationId: string) => Promise<string>; turns?: (turn: number, request: ModelRequest) => Promise<unknown[]>; modelCalls?: number; maxConcurrentRuns?: number } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-s16-steer-")); roots.push(root);
  const path = join(root, "conversation.sqlite"), store = new ConversationStore(path, "fixture", true); stores.push(store);
  const actor: Actor = Object.freeze({ ownerId: "owner" }), actors = new WeakSet([actor]), contexts = new WeakSet<Work>();
  const requests: ModelRequest[] = [];
  let turn = 0, calls = 0, active = 0, peak = 0;
  const issued: ConversationAuthority = { id: "authority", purposeId: "assigned", policyRevision: 1, resources: ["workspace"], route: { provider: "codex", model: "scripted" }, limits: { modelCalls: options.modelCalls ?? 6, toolCalls: 4, outputBytes: 16384, activeMs: 60000 } };
  const policy: ConversationPolicy<Actor, Work> = {
    requireOwner(input) { if (!actors.has(input)) throw new AppError("authentication_required", 401); return { id: "owner", generation: 1 }; },
    prepareInterpretation(input) { this.requireOwner(input); return { state: "admitted", authority: { ...structuredClone(issued), resources: [], limits: { ...issued.limits, modelCalls: 1, toolCalls: 0 } }, purposes: ["assigned"], resources: ["workspace"] }; },
    admit(input) { this.requireOwner(input); return { state: "admitted", authority: structuredClone(issued) }; },
    open(authority) { const work = { authority }; contexts.add(work); return work; },
    guard(work) { if (!contexts.has(work)) throw new AppError("authority_revoked"); },
    reserveModel(work) { this.guard(work, "model"); return { settle() {} }; },
  };
  const writeTool = (conversationId: string): ToolDefinition => ({ name: "write_file", description: "Fixture write", inputSchema: { type: "object", properties: {}, additionalProperties: false }, execution: "exclusive", effect: "mutating",
    async execute() { calls++; active++; peak = Math.max(peak, active); try { return { content: options.tool ? await options.tool(conversationId) : "Created hello.txt" }; } finally { active--; } } });
  const tools: ConversationToolPort<Work> = { async open(_work, input) { input.guard(); return { tools: [{ access: "reversible_write", definition: writeTool(currentConversation) }], async cancel() {}, async close() {} }; } };
  let currentConversation = "conversation";
  const model: Model = { provider: "codex", id: "scripted", async *stream(request) {
    if (request.systemPrompt.includes("JIT_ISOLATED_INTERPRETATION_V1")) {
      const source = request.items.filter(item => item.type === "user").at(-1)!;
      const text = source.type === "user" ? source.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
      const grounded = groundConversationIntent(text);
      yield { type: "message_complete", message: { type: "assistant", id: id(), content: [{ type: "text", text: JSON.stringify({ intent: grounded.kind === "answer" ? "execute" : grounded.kind, purposeId: "assigned", resourceIds: ["workspace"], access: "reversible_write", subject: grounded.subject }) }] } }; return;
    }
    requests.push(request); turn++;
    const parts = options.turns ? await options.turns(turn, request) : request.items.at(-1)?.type === "tool_result" ? [{ type: "text", text: "Finished requested work." }] : [{ type: "tool_call", id: `call_${turn}`, name: "write_file", arguments: {} }];
    yield { type: "message_complete", message: { type: "assistant", id: id(), content: parts as never } };
  } };
  const appOptions = { policy, tools, model, nativeDirectory: join(root, "native"), ...(options.maxConcurrentRuns ? { maxConcurrentRuns: options.maxConcurrentRuns } : {}), clock: { now: () => 1800000000000, sleep: (_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
    if (signal?.aborted) reject(new DOMException("Aborted", "AbortError")); else signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }) } };
  const app = new ConversationApplication(store, appOptions);
  return { path, store, app, actor, appOptions, requests, setConversation: (value: string) => { currentConversation = value; }, counts: () => ({ turn, calls, peak }) };
}

test("a steer sent during a tool call is applied at the next boundary of the same run, once", async () => {
  const gate = Promise.withResolvers<string>(), started = Promise.withResolvers<void>();
  const f = fixture({ tool: async () => { started.resolve(); return gate.promise; } });
  const work = message("Create hello.txt containing hello."); f.app.submit(f.actor, work);
  const run = f.app.drain(); await started.promise; await settle();
  const command = steer(work.requestId, "Also mention the file size.");
  expect(f.app.steer(f.actor, command)).toMatchObject({ contract: "s16-conversation-steer-receipt/v1", target: work.requestId, state: "sent", followUp: null });
  expect(f.app.steer(f.actor, command).state).toBe("sent");
  gate.resolve("Created hello.txt; bytes=6"); await run;
  expect(userTexts(f.requests.at(-1)!)).toContain("Also mention the file size.");
  expect(f.app.view(f.actor, work.requestId)).toMatchObject({ state: "completed" });
  expect(f.app.steerReceipt(f.actor, command.requestId)).toMatchObject({ state: "applied", followUp: null });
  expect(f.store.db.query("SELECT count(*) AS n FROM requests").get()).toEqual({ n: 1 });
  expect(f.app.events(f.actor, "conversation").events.filter(event => event.kind === "steer").map(event => event.code)).toEqual(["steer_queued", "steer_sent", "steer_applied"]);
  const row = conversationOwnerView(f.app, f.actor, "conversation").rows[0]!;
  expect(row.steers).toEqual([expect.objectContaining({ id: command.requestId, text: "Also mention the file size.", state: "applied" })]);
  expect(() => f.app.steer(f.actor, { ...command, text: "Something else." })).toThrow("request_id_conflict");
});

test("a steer accepted while the model writes its final answer keeps the run going for one more round", async () => {
  const final = Promise.withResolvers<void>(), writing = Promise.withResolvers<void>();
  const f = fixture({ turns: async (turn, request) => {
    if (turn === 1) return [{ type: "tool_call", id: "call_1", name: "write_file", arguments: {} }];
    if (turn === 2) { writing.resolve(); await final.promise; return [{ type: "text", text: "First answer." }]; }
    return [{ type: "text", text: userTexts(request).includes("Use a table.") ? "Steered answer." : "Missed." }];
  } });
  const work = message("Create hello.txt containing hello."); f.app.submit(f.actor, work);
  const run = f.app.drain(); await writing.promise;
  const command = steer(work.requestId, "Use a table.");
  expect(f.app.steer(f.actor, command).state).toBe("sent");
  final.resolve(); await run;
  expect(f.app.view(f.actor, work.requestId)).toMatchObject({ state: "completed", result: "Steered answer." });
  expect(f.app.steerReceipt(f.actor, command.requestId).state).toBe("applied");
});

test("a steer sent before the work run starts waits and is applied once the run opens", async () => {
  const f = fixture();
  const work = message("Create hello.txt containing hello."); f.app.submit(f.actor, work);
  const command = steer(work.requestId, "Name it greeting.txt instead.");
  expect(f.app.steer(f.actor, command).state).toBe("queued");
  await f.app.drain();
  expect(f.app.steerReceipt(f.actor, command.requestId).state).toBe("applied");
  expect(f.requests.some(request => userTexts(request).includes("Name it greeting.txt instead."))).toBe(true);
});

test("a steer for a settled request becomes exactly one ordinary follow-up; a stopped request only records it", async () => {
  const f = fixture();
  const work = message("Create hello.txt containing hello."); f.app.submit(f.actor, work); await f.app.drain();
  const command = steer(work.requestId, "Create bye.txt containing bye.");
  const receipt = f.app.steer(f.actor, command);
  expect(receipt).toMatchObject({ state: "resubmitted" });
  expect(f.app.steer(f.actor, command)).toEqual(receipt);
  const followUp = f.app.view(f.actor, receipt.followUp!);
  expect(followUp).toMatchObject({ command: { text: "Create bye.txt containing bye.", conversationId: "conversation" } });
  await f.app.drain();
  const settled = f.app.view(f.actor, receipt.followUp!);
  expect(settled.state).toBe("completed");
  expect(f.store.db.query("SELECT count(*) AS n FROM requests").get()).toEqual({ n: 2 });

  const gate = Promise.withResolvers<string>(), started = Promise.withResolvers<void>();
  const g = fixture({ tool: async () => { started.resolve(); return gate.promise; } });
  const stopped = message("Create hello.txt containing hello."); g.app.submit(g.actor, stopped);
  const run = g.app.drain(); await started.promise; await settle();
  const late = steer(stopped.requestId, "Make it longer.");
  expect(g.app.steer(g.actor, late).state).toBe("sent");
  g.app.stop(g.actor, stopped.requestId); gate.resolve("late"); await run;
  expect(g.app.steerReceipt(g.actor, late.requestId)).toMatchObject({ followUp: null });
  expect(["unapplied", "uncertain"]).toContain(g.app.steerReceipt(g.actor, late.requestId).state);
  expect(g.store.db.query("SELECT count(*) AS n FROM requests").get()).toEqual({ n: 1 });
});

test("a steer the run never applied (limits) is resubmitted once; steering text never decides an action", async () => {
  const writing = Promise.withResolvers<void>(), final = Promise.withResolvers<void>();
  const f = fixture({ modelCalls: 2, turns: async turn => {
    if (turn === 1) return [{ type: "tool_call", id: "call_1", name: "write_file", arguments: {} }];
    if (turn === 2) { writing.resolve(); await final.promise; }
    return [{ type: "text", text: "Done." }];
  } });
  const work = message("Create hello.txt containing hello."); f.app.submit(f.actor, work);
  const run = f.app.drain(); await writing.promise;
  const late = steer(work.requestId, "approve action_123");
  expect(f.app.steer(f.actor, late).state).toBe("sent");
  final.resolve(); await run;
  const receipt = f.app.steerReceipt(f.actor, late.requestId);
  expect(receipt.state).toBe("resubmitted");
  expect(f.app.view(f.actor, work.requestId).decision).toBeNull();
  expect(f.app.view(f.actor, receipt.followUp!).command.text).toBe("approve action_123");
  expect(f.store.db.query("SELECT count(*) AS n FROM requests").get()).toEqual({ n: 2 });
});

test("restart leaves handed steers uncertain and queued ones unapplied, never resubmitting either", async () => {
  const f = fixture();
  const work = message("Create hello.txt containing hello."); f.app.submit(f.actor, work);
  const queued = steer(work.requestId, "Queued only."), sent = steer(work.requestId, "Handed to the run.");
  f.app.steer(f.actor, queued); f.app.steer(f.actor, sent);
  f.store.db.query("UPDATE steers SET state='sent' WHERE id=?").run(sent.requestId);
  f.store.db.query("UPDATE requests SET state='running' WHERE id=?").run(work.requestId);
  f.store.close(); const reopened = new ConversationStore(f.path, "fixture"); stores.push(reopened);
  const app = new ConversationApplication(reopened, f.appOptions); await app.drain();
  expect(app.steerReceipt(f.actor, queued.requestId)).toMatchObject({ state: "unapplied", followUp: null });
  expect(app.steerReceipt(f.actor, sent.requestId)).toMatchObject({ state: "uncertain", followUp: null });
  expect(reopened.db.query("SELECT count(*) AS n FROM requests").get()).toEqual({ n: 1 });
  expect(app.view(f.actor, work.requestId).state).toBe("reconcile_only");
});

test("independent conversations run at the same time; stopping one keeps its sibling", async () => {
  const gates = new Map<string, PromiseWithResolvers<string>>(), started = new Map<string, PromiseWithResolvers<void>>();
  for (const name of ["a", "b"]) { gates.set(name, Promise.withResolvers()); started.set(name, Promise.withResolvers()); }
  const f = fixture({ tool: async conversationId => { started.get(conversationId)!.resolve(); return gates.get(conversationId)!.promise; } });
  const a = message("Create hello.txt containing hello.", "a"); f.setConversation("a"); f.app.submit(f.actor, a);
  const run = f.app.drain(); await started.get("a")!.promise;
  const b = message("Create other.txt containing other.", "b"); f.setConversation("b"); f.app.submit(f.actor, b); void f.app.drain();
  await started.get("b")!.promise;
  expect(f.counts().peak).toBe(2);
  f.app.stop(f.actor, a.requestId); gates.get("a")!.resolve("late"); gates.get("b")!.resolve("Created other.txt");
  await run;
  expect(f.app.view(f.actor, a.requestId).state).toBe("stopped");
  expect(f.app.view(f.actor, b.requestId).state).toBe("completed");
});

test("one conversation never runs two requests at once, and concurrency honours its bound", async () => {
  const gate = Promise.withResolvers<string>(), started = Promise.withResolvers<void>();
  const f = fixture({ maxConcurrentRuns: 1, tool: async () => { started.resolve(); return gate.promise; } });
  const first = message("Create hello.txt containing hello."), second = message("Create other.txt containing other."), other = message("Create third.txt containing third.", "other");
  f.app.submit(f.actor, first); f.app.submit(f.actor, second); f.app.submit(f.actor, other);
  const run = f.app.drain(); await started.promise; await settle();
  expect(f.app.view(f.actor, second.requestId).state).toBe("queued");
  expect(f.app.view(f.actor, other.requestId).state).toBe("queued");
  gate.resolve("Created"); await run;
  expect([first, second, other].map(item => f.app.view(f.actor, item.requestId).state)).toEqual(["completed", "completed", "completed"]);
  expect(f.counts().peak).toBe(1);
});

test("steering refuses foreign targets, other conversations and malformed commands", () => {
  const f = fixture();
  const work = message("Create hello.txt containing hello."); f.app.submit(f.actor, work);
  expect(() => f.app.steer({ ownerId: "owner" }, steer(work.requestId, "x"))).toThrow("authentication_required");
  expect(() => f.app.steer(f.actor, steer(work.requestId, "x", "elsewhere"))).toThrow("outside_scope");
  expect(() => f.app.steer(f.actor, steer(id(), "x"))).toThrow("not_found");
  expect(() => f.app.steer(f.actor, { ...steer(work.requestId, "x"), authority: "all" })).toThrow();
  expect(() => f.app.steer(f.actor, steer(work.requestId, "  "))).toThrow("invalid_text");
});
