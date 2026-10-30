import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S14Application, type S14Options } from "../src/s14/application";
import { S14Store } from "../src/s14/store";
import { createS14Handler } from "../src/s14/web";
import type { Bot, ChatInput, ChatOutput, Policy } from "../src/s14/types";
import type { MemoryClaim, MemoryPacket, MemoryRef, MemorySource } from "../src/s14/memory-types";
import type { Work } from "../src/s14/authority-types";
import { canonical, canonicalByteLimit } from "../src/s14/validation";

const roots: string[] = [], stores = new Set<S14Store>();
const rid = () => crypto.randomUUID().replaceAll("-", "");
const epoch = 1800000000000, password = "fixture-memory-password";
const policy: Policy = { routes: [{ id: "selected", provider: "codex", model: "scripted" }], tools: ["web_search", "web_fetch"], resources: ["memshare"] };
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(script: (input: ChatInput) => Promise<ChatOutput> = async () => ({ text: "Fixture reply" })) {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-memory-")); roots.push(root);
  const path = join(root, "app.sqlite"), store = new S14Store(path); stores.add(store);
  const seen: ChatInput[] = [], clock = { now: epoch };
  const options: S14Options = { policy, now: () => clock.now, chat: { async reply(input) { seen.push(input); return script(input); } } };
  const app = new S14Application(store, options);
  await app.provisionOwner(password); const token = await app.login(password), auth = app.authenticate(token);
  const setup = app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: 0, payload: { ownerName: "Owner", language: "th", routeId: "selected", capabilities: { tools: policy.tools, resources: policy.resources } } });
  // A second already accepted participant is trusted fixture state, never model authority.
  const other: Bot = { ...setup.bot!, id: "other", name: "Other" };
  store.transaction(tx => { tx.run("INSERT INTO bots VALUES (?,?)", other.id, JSON.stringify(other)); tx.run("INSERT INTO conversations VALUES ('otherchat','other',1)"); });
  return { root, path, store, options, app, token, auth, clock, seen, conversationId: setup.conversation!.id };
}
type F = Awaited<ReturnType<typeof fixture>>;
function remember(f: F, content = "ชอบอาหารไทยไม่ใส่น้ำตาล", conversationId = f.conversationId) {
  return f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, conversationId).conversation.revision, payload: { conversationId, text: content } }).claim!;
}
function post(f: F, content: string, conversationId = f.conversationId) {
  return f.app.execute(f.auth.actor, { kind: "message.post", requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, conversationId).conversation.revision, payload: { conversationId, text: content } });
}
function packet(f: F, botId = "jit", purpose = "อาหารไทย preferences", conversationId = f.conversationId) {
  return f.store.transaction(tx => f.app.memory.assemble(tx, { botId, conversationId, purpose, sources: [] }));
}
function claim(f: F, reference: MemoryRef, botId = "jit") { return f.store.read(tx => f.app.memory.lookup(tx, botId, { id: reference.id, revision: reference.revision, generation: reference.generation })); }
function publish(f: F, reference: MemoryRef, expectedRevision = 1, kind: "memory.publish" | "memory.revoke" = "memory.publish") {
  return f.app.execute(f.auth.actor, { kind, requestId: rid(), expectedRevision, payload: { claim: reference } });
}

test.each(["ascii", "escaped", "unicode"])("chat shares the 128 KiB receipt budget with large memory and excludes withdrawn %s sources", async encoding => {
  const body = encoding === "escaped" ? '"'.repeat(16384) : encoding === "unicode" ? "ก".repeat(5461) + "x" : "x".repeat(16384);
  expect(Buffer.byteLength(body)).toBe(16384);
  const f = await fixture(async () => ({ text: body }));
  const withdrawn = post(f, body); await f.app.drainReplies();
  const extraction = f.store.transaction(tx => f.app.memory.extract(tx, withdrawn.reply!.snapshot.memory!.id,
    { id: withdrawn.message!.id, revision: 1, generation: 1 }, [{ kind: "inference", text: "Withdraw this source", quote: body.slice(0, 64), conflicts: [] }]));
  expect(extraction.claims).toHaveLength(1);
  f.app.execute(f.auth.actor, { kind: "memory.forget", requestId: rid(), expectedRevision: 1, payload: { claim: extraction.claims[0]! } });
  const excludedIds = f.app.conversation(f.auth.actor, f.conversationId).messages.map(m => m.id);
  remember(f, "Retained preference " + "p".repeat(880));
  for (let i = 0; i < 3; i++) f.app.execute(f.auth.actor, { kind: "memory.decision.set", requestId: rid(), expectedRevision: 0,
    payload: { conversationId: f.conversationId, key: `decision${i}`, text: `Pinned ${i} ` + "d".repeat(3991) } });
  for (let i = 0; i < 9; i++) {
    const command = { kind: "message.post" as const, requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision,
      payload: { conversationId: f.conversationId, text: i === 8 ? "newest" : body } };
    const receipt = f.app.execute(f.auth.actor, command), snapshot = receipt.reply!.snapshot, memory = snapshot.memory!;
    expect(f.app.execute(f.auth.actor, command)).toEqual(receipt);
    expect(Buffer.byteLength(canonical(receipt))).toBeLessThanOrEqual(canonicalByteLimit);
    expect(Buffer.byteLength(canonical(receipt.reply))).toBeLessThanOrEqual(canonicalByteLimit);
    expect(Buffer.byteLength(canonical(memory))).toBeGreaterThan(14000);
    expect(memory.decisions).toHaveLength(3);
    expect(memory.sources).toEqual(snapshot.messages.map(m => ({ id: m.id, revision: 1, generation: 1 })));
    for (const message of snapshot.messages) expect(f.store.read(tx => JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM memory_sources WHERE id=?", message.id)!.record_json)))
      .toMatchObject({ id: message.id, text: message.text, attribution: message.role === "owner" ? "owner" : "bot" });
    expect(snapshot.messages.at(-1)).toEqual(receipt.message!);
    expect(snapshot.messages.some(m => excludedIds.includes(m.id))).toBe(false);
    expect(f.app.memory.context(f.auth.actor, memory.id)).toEqual(memory);
    const eligible = f.app.conversation(f.auth.actor, f.conversationId).messages.filter(m => !excludedIds.includes(m.id));
    expect(snapshot.messages).toEqual(eligible.slice(-snapshot.messages.length));
    if (i >= 5) {
      expect(snapshot.messages.length).toBeLessThan(12);
      const next = eligible.at(-snapshot.messages.length - 1)!;
      expect(() => canonical({ ...receipt, reply: { ...receipt.reply!, snapshot: { ...snapshot, messages: [next, ...snapshot.messages] } } })).toThrow("data_too_large");
    }
    await f.app.drainReplies();
  }
  expect(f.seen).toHaveLength(10);
  expect(f.seen.at(-1)!.messages.at(-1)!.text).toBe("newest");
  expect(f.app.home(f.auth.actor).replies.filter(r => r.messageId !== withdrawn.message!.id).every(r => r.state === "succeeded")).toBe(true);
});

test("scope filtering precedes relevance and guessed IDs; only exact authenticated owner publication shares facts", async () => {
  const f = await fixture(), reference = remember(f);
  expect(claim(f, reference, "other")).toEqual({ state: "unavailable", reference, reason: "memory_unavailable" });
  expect(packet(f, "other", "ชอบอาหารไทยไม่ใส่น้ำตาล", "otherchat").claims).toEqual([]);
  expect(() => f.app.execute({ ownerId: "owner" }, { kind: "memory.publish", requestId: rid(), expectedRevision: 1, payload: { claim: reference } })).toThrow("authentication_required");
  const command = { kind: "memory.publish" as const, requestId: rid(), expectedRevision: 1, payload: { claim: reference } };
  const receipt = f.app.execute(f.auth.actor, command);
  expect(f.app.execute(f.auth.actor, command)).toEqual(receipt);
  expect(receipt.access).toMatchObject({ revision: 2, shared: true, publishedBy: "owner" });
  expect(claim(f, reference, "other").state).toBe("available");
  expect(packet(f, "other", "อาหารไทย", "otherchat").claims.map(c => c.id)).toContain(reference.id);
  expect(f.app.memory.claim(f.auth.actor, "jit", reference).history.map(a => a.shared)).toEqual([false, true]);
  expect(() => publish(f, reference)).toThrow("stale_revision");
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM audit WHERE kind='memory.publish'")!.n)).toBe(1);
});

test("Thai no-space and English lexical recall retain fact/inference, exact source revisions and conflicts", async () => {
  const f = await fixture(async input => {
    const last = input.messages.at(-1)!;
    return { text: "No authority from extraction", memory: [
      { kind: "inference", text: "ชอบอาหารไทยใส่น้ำตาล", quote: last.text, conflicts: input.memory!.claims.map(c => ({ id: c.id, revision: c.revision, generation: c.generation })) },
      { kind: "fact", text: "Forged global preference", quote: last.text, conflicts: [], scope: "shared" },
    ] };
  });
  const initial = remember(f), english = remember(f, "Prefer DARKMODE for coding");
  post(f, "วันนี้อยากลองอาหารไทยใส่น้ำตาล"); await f.app.drainReplies();
  const th = f.app.memory.inspect(f.auth.actor, "jit", "อาหารไทย").claims.filter(c => c.state === "available");
  expect(th.map(c => c.claim.kind)).toEqual(expect.arrayContaining(["fact", "inference"]));
  const inferred = th.find(c => c.claim.kind === "inference")!;
  expect(inferred.claim.conflicts).toContainEqual(initial);
  expect(inferred.claim.dependencies).toContainEqual(english);
  expect(inferred.claim.source).toMatchObject({ revision: 1, generation: 1 });
  expect(f.app.memory.inspect(f.auth.actor, "jit", "darkmode").claims).toHaveLength(1);
  expect(claim(f, inferred.claim, "other").state).toBe("unavailable");
  expect(f.app.memory.inspect(f.auth.actor, "other").claims).toHaveLength(0);
});

test("extractor facts require exact owner quotes and reject fabricated provenance, fields and oversized assertions", async () => {
  const f = await fixture(); const posted = post(f, "Owner exact statement");
  const source = { id: posted.message!.id, revision: 1, generation: 1 }, context = posted.reply!.snapshot.memory!;
  const output = f.store.transaction(tx => f.app.memory.extract(tx, context.id, source, [
    { kind: "fact", text: "Owner exact statement", quote: "Owner exact statement", conflicts: [] },
    { kind: "fact", text: "Different assertion", quote: "Owner exact statement", conflicts: [] },
    { kind: "inference", text: "Guess", quote: "not present", conflicts: [] },
    { kind: "inference", text: "Guess", quote: "Owner", conflicts: [{ id: "guessed", revision: 1, generation: 1 }] },
    { kind: "inference", text: "x".repeat(2049), quote: "Owner", conflicts: [] },
  ]));
  expect(output.rejected).toBe(4); expect(output.claims).toHaveLength(1);
  expect(claim(f, output.claims[0]!, "other").state).toBe("unavailable");
  expect(() => f.store.transaction(tx => f.app.memory.extract(tx, context.id, { ...source, revision: 2 }, []))).toThrow("memory_context_stale");
});

test("publication revocation fences in-flight chat and work tools/results without claiming knowledge erasure", async () => {
  let release!: (output: ChatOutput) => void, entered!: () => void;
  const gate = new Promise<void>(resolve => { entered = resolve; });
  const f = await fixture(async () => { entered(); return new Promise<ChatOutput>(resolve => { release = resolve; }); });
  const reference = remember(f); publish(f, reference);
  post(f, "อาหารไทย", "otherchat"); const pending = f.app.drainReplies(); await gate;
  expect(f.seen[0]!.memory!.claims.map(c => c.id)).toContain(reference.id);
  publish(f, reference, 2, "memory.revoke"); release({ text: "late private output" }); await pending;
  expect(f.app.home(f.auth.actor).replies[0]).toMatchObject({ state: "blocked", reason: "memory_context_stale" });
  expect(f.app.conversation(f.auth.actor, "otherchat").messages.some(m => m.text === "late private output")).toBe(false);
  const work = f.app.execute(f.auth.actor, { kind: "work.start", requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision,
    payload: { conversationId: f.conversationId, task: null, title: "Read", purpose: "อาหารไทย", completionRule: "Evidence", bots: [{ id: "jit", revision: 1 }], tools: ["web_search"], scopes: [], limits: { attempts: 1, steps: 1, calls: 3, outputBytes: 2048, wallMs: 60000 }, expiresAt: epoch + 60000 } }).work!;
  const attempt = f.app.authority.admit(work.id, rid(), { botId: "jit", tools: ["web_search"], scopes: [], input: "อาหารไทย", calls: 3, outputBytes: 2048 });
  f.app.execute(f.auth.actor, { kind: "memory.correct", requestId: rid(), expectedRevision: 1, payload: { claim: reference, text: "ชอบอาหารไทยไม่เผ็ด" } });
  expect(() => f.app.authority.reserveTool(attempt.id, "web_search")).toThrow("memory_context_stale");
  expect(() => f.app.authority.commit(attempt.id, { state: "ready", text: "Late" })).toThrow("memory_context_stale");
});

test("immutable receiver share also requires Bot resource ceiling and originating work scope; revoke closes late barriers", async () => {
  const f = await fixture(), reference = remember(f, "Private receiver snapshot");
  const shared = f.app.execute(f.auth.actor, { kind: "memory.share", requestId: rid(), expectedRevision: 1, payload: { claim: reference, scopeId: "memshare", receiverBotId: "other", expiresAt: epoch + 60000 } }).share!;
  expect(claim(f, reference, "other").state).toBe("unavailable");
  const scope = { kind: "share" as const, id: shared.id, revision: 1 };
  const work = f.app.execute(f.auth.actor, { kind: "work.start", requestId: rid(), expectedRevision: 1,
    payload: { conversationId: "otherchat", task: null, title: "Read", purpose: "receiver snapshot", completionRule: "Evidence", bots: [{ id: "other", revision: 1 }], tools: [], scopes: [scope], limits: { attempts: 1, steps: 1, calls: 3, outputBytes: 2048, wallMs: 60000 }, expiresAt: epoch + 60000 } }).work!;
  const attempt = f.app.authority.admit(work.id, rid(), { botId: "other", tools: [], scopes: [scope], input: "receiver snapshot", calls: 3, outputBytes: 2048 });
  expect(f.store.read(tx => f.app.memory.attemptPacket(tx, attempt.id)).claims.map(c => c.id)).toContain(reference.id);
  publish(f, reference, 1, "memory.revoke");
  expect(() => f.app.authority.commit(attempt.id, { state: "ready", text: "Late" })).toThrow("memory_context_stale");
});

test("forget suppresses siblings, conservative descendants and derived answers; raw source stays owner-inspectable", async () => {
  const f = await fixture(async input => ({ text: "A derived answer with preference", memory: [{ kind: "inference", text: "Derived preference", quote: input.messages.at(-1)!.text, conflicts: [] }] }));
  const original = remember(f, "Original owner preference");
  post(f, "Discuss my preference"); await f.app.drainReplies();
  const before = f.app.memory.inspect(f.auth.actor, "jit");
  const derivative = before.claims.find(c => c.state === "available" && c.claim.kind === "inference")!;
  expect(derivative.state).toBe("available");
  const impact = f.app.memory.preview(f.auth.actor, original);
  if (derivative.state !== "available") throw Error("fixture");
  expect(impact.claims.map(r => r.id)).toContain(derivative.claim.id);
  f.app.execute(f.auth.actor, { kind: "memory.forget", requestId: rid(), expectedRevision: 1, payload: { claim: original } });
  expect(claim(f, original).state).toBe("unavailable");
  expect(f.app.memory.inspect(f.auth.actor, "jit").sources.some(s => s.text === "Original owner preference")).toBe(true);
  post(f, "Fresh question"); await f.app.drainReplies();
  expect(f.seen.at(-1)!.messages.map(m => m.text)).not.toContain("A derived answer with preference");
  const old = before.claims.find(c => c.state === "available" && c.claim.id === original.id)!;
  if (old.state !== "available") throw Error("fixture");
  const lastPacket = f.seen[0]!.memory!;
  expect(() => f.store.transaction(tx => f.app.memory.extract(tx, lastPacket.id, old.claim.source, []))).toThrow("memory_context_stale");
});

test("current decisions survive restart and context compaction, and supersession or pinned overflow refuses stale output", async () => {
  const f = await fixture();
  const decision = f.app.execute(f.auth.actor, { kind: "memory.decision.set", requestId: rid(), expectedRevision: 0, payload: { conversationId: f.conversationId, key: "chosen", text: "Use owner-selected conclusion" } }).decision!;
  for (let n = 0; n < 8; n++) remember(f, `Preference item ${n}`);
  const input = packet(f);
  expect(input.claims).toHaveLength(6); expect(input.omitted).toBe(2);
  expect(input.decisions[0]).toMatchObject({ ...decision, text: "Use owner-selected conclusion" });
  f.store.close(); stores.delete(f.store);
  const reopened = new S14Store(f.path); stores.add(reopened);
  const app = new S14Application(reopened, f.options), actor = app.authenticate(f.token).actor;
  expect(app.memory.context(actor, input.id).decisions[0]!.text).toBe("Use owner-selected conclusion");
  app.execute(actor, { kind: "memory.decision.set", requestId: rid(), expectedRevision: 1, payload: { conversationId: f.conversationId, key: "chosen", text: "New owner decision" } });
  expect(app.memory.context(actor, input.id)).toMatchObject({ state: "retired", claims: [], decisions: [] });
  for (let n = 0; n < 5; n++) app.execute(actor, { kind: "memory.decision.set", requestId: rid(), expectedRevision: 0, payload: { conversationId: f.conversationId, key: `large${n}`, text: "z".repeat(4000) } });
  expect(() => reopened.transaction(tx => app.memory.assemble(tx, { botId: "jit", conversationId: f.conversationId, purpose: "new", sources: [] }))).toThrow("context_too_large");
});

test.each(["memory.forget", "memory.delete"] as const)("%s survives restored stale database using independent ledger before activation", async kind => {
  const f = await fixture(), reference = remember(f, "Never resurrect this private payload"), input = packet(f);
  const snapshot = join(f.root, "snapshot.sqlite"); copyFileSync(f.path, snapshot);
  f.app.execute(f.auth.actor, { kind, requestId: rid(), expectedRevision: 1, payload: { claim: reference } });
  f.store.close(); stores.delete(f.store); copyFileSync(snapshot, f.path);
  const restored = new S14Store(f.path); stores.add(restored);
  const app = new S14Application(restored, f.options), actor = app.authenticate(f.token).actor;
  expect(restored.read(tx => app.memory.lookup(tx, "jit", reference)).state).toBe("unavailable");
  expect(app.memory.context(actor, input.id).state).toBe("retired");
  if (kind === "memory.delete") expect(JSON.stringify(app.memory.inspect(actor, "jit"))).not.toContain("Never resurrect this private payload");
  restored.close(); stores.delete(restored); unlinkSync(`${f.path}.lifecycle.sqlite`);
  expect(() => new S14Store(f.path)).toThrow("s14_lifecycle_ledger_unavailable");
});

test("memory mutation and independent lifecycle ledger roll back together with receipts; authenticated HTTP queries/forms share seam", async () => {
  const f = await fixture(), reference = remember(f);
  const app = new S14Application(f.store, { ...f.options, beforeCommit: () => { throw Error("fixture_rollback"); } }), actor = app.authenticate(f.token).actor;
  expect(() => app.execute(actor, { kind: "memory.forget", requestId: rid(), expectedRevision: 1, payload: { claim: reference } })).toThrow("fixture_rollback");
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM lifecycle.withdrawals")!.n)).toBe(0);
  expect(claim(f, reference).state).toBe("available");
  const handler = createS14Handler(f.app, "http://localhost:3001");
  const headers = { cookie: `jit_s14=${f.token}` };
  expect((await handler(new Request("http://localhost:3001/api/s14/memory/jit?q=อาหาร", { headers }))).status).toBe(200);
  const command = { kind: "memory.forget", requestId: rid(), expectedRevision: 1, payload: { claim: reference } };
  const response = await handler(new Request("http://localhost:3001/s14/commands", { method: "POST", headers: { ...headers, origin: "http://localhost:3001", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf: f.auth.csrf, command: JSON.stringify(command) }) }));
  expect(response.status).toBe(303); expect(claim(f, reference).state).toBe("unavailable");
});

test("revocation excludes old replies, derived claims and packets after republication while preserving the original", async () => {
  const f = await fixture(async input => ({ text: "Reply derived from published memory", memory: [{ kind: "inference", text: "Derived receiver preference", quote: input.messages.at(-1)!.text, conflicts: [] }] }));
  const original = remember(f); publish(f, original);
  post(f, "อาหารไทย", "otherchat"); await f.app.drainReplies();
  const reply = f.app.conversation(f.auth.actor, "otherchat").messages.find(m => m.role === "bot")!;
  const derived = f.app.memory.inspect(f.auth.actor, "other").claims.find(c => c.state === "available" && c.claim.kind === "inference")!;
  expect(derived.state).toBe("available");
  const queued = post(f, "Follow up", "otherchat");
  expect(queued.reply!.snapshot.messages.some(m => m.id === reply.id)).toBe(true);
  publish(f, original, 2, "memory.revoke");
  expect(claim(f, original).state).toBe("available");
  expect(f.app.memory.context(f.auth.actor, queued.reply!.snapshot.memory!.id).state).toBe("retired");
  expect(f.app.conversation(f.auth.actor, "otherchat").messages.find(m => m.id === reply.id)).toMatchObject({ text: reply.text, contextState: "withdrawn" });
  post(f, "Fresh receiver question", "otherchat"); await f.app.drainReplies();
  expect(f.seen.at(-1)!.messages.some(m => m.id === reply.id)).toBe(false);
  publish(f, original, 3);
  expect(f.store.read(tx => f.app.memory.sourceCurrent(tx, { id: reply.id, revision: 1, generation: 1 }))).toBe(false);
  if (derived.state !== "available") throw Error("fixture");
  expect(claim(f, derived.claim, "other").state).toBe("unavailable");
  expect(claim(f, original).state).toBe("available");
});

test("receiver-share evidence and work handoffs retain original access revisions after revoke", async () => {
  const f = await fixture(), original = remember(f, "Private receiver snapshot");
  const shared = f.app.execute(f.auth.actor, { kind: "memory.share", requestId: rid(), expectedRevision: 1, payload: { claim: original, scopeId: "memshare", receiverBotId: "other", expiresAt: epoch + 60000 } }).share!;
  const scope = { kind: "share" as const, id: shared.id, revision: 1 };
  const work = f.app.execute(f.auth.actor, { kind: "work.start", requestId: rid(), expectedRevision: 1,
    payload: { conversationId: "otherchat", task: null, title: "Receiver research", purpose: "receiver snapshot", completionRule: "Evidence", bots: [{ id: "other", revision: 1 }, { id: "jit", revision: 1 }], tools: [], scopes: [scope], limits: { attempts: 2, steps: 2, calls: 6, outputBytes: 4096, wallMs: 60000 }, expiresAt: epoch + 60000 } }).work!;
  const parent = f.app.authority.admit(work.id, rid(), { botId: "other", tools: [], scopes: [scope], input: "receiver snapshot", calls: 3, outputBytes: 2048 });
  const evidence = f.store.transaction(tx => f.app.memory.source(tx, { id: rid(), botId: "other", conversationId: "otherchat", attribution: "external", text: "Derived evidence", ...f.app.memory.derive(tx, f.app.memory.attemptPacket(tx, parent.id)) }));
  f.app.authority.commit(parent.id, { state: "waiting", text: "Derived handoff text" });
  const child = f.app.authority.delegate(parent.id, rid(), { botId: "jit", tools: [], scopes: [], input: "Derived handoff text", calls: 3, outputBytes: 2048 });
  const childPacket = f.store.read(tx => f.app.memory.attemptPacket(tx, child.id));
  expect(childPacket.sources.length).toBeGreaterThan(0);
  publish(f, original, 1, "memory.revoke");
  expect(f.store.read(tx => f.app.memory.sourceCurrent(tx, evidence))).toBe(false);
  expect(f.app.memory.context(f.auth.actor, childPacket.id).state).toBe("retired");
  expect(() => f.app.authority.commit(child.id, { state: "ready", text: "Late handoff result" })).toThrow("memory_context_stale");
  expect(claim(f, original).state).toBe("available");
});

test.each(["memory.forget", "memory.delete", "memory.revoke"] as const)("task source is pinned on accept and fenced at start, admission and publication after %s", async kind => {
  const f = await fixture(async () => ({ text: "Memory-derived task suggestion", task: { title: "Derived task", purpose: "Task text derived from memory", completionRule: "Owner review" } }));
  const original = remember(f); publish(f, original);
  post(f, "Suggest a task", "otherchat"); await f.app.drainReplies();
  const task = f.app.authority.list(f.auth.actor)[0]!;
  const accept = () => f.app.execute(f.auth.actor, { kind: "task.accept", requestId: rid(), expectedRevision: 1, payload: { taskId: task.id } });
  // A second suggestion is left unaccepted to check the acceptance barrier too.
  post(f, "Suggest another task", "otherchat"); await f.app.drainReplies();
  const proposed = f.app.authority.list(f.auth.actor).find(w => w.id !== task.id)!;
  const accepted = accept().work!;
  expect(accepted.source).toEqual({ id: task.sourceMessageId!, revision: 1, generation: 1 });
  const start = (work: Work) => f.app.execute(f.auth.actor, { kind: "work.start", requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, "otherchat").conversation.revision,
    payload: { conversationId: "otherchat", task: { id: work.id, revision: work.revision }, title: work.title, purpose: work.purpose, completionRule: work.completionRule, bots: [{ id: "other", revision: 1 }], tools: ["web_search"], scopes: [], limits: { attempts: 1, steps: 1, calls: 3, outputBytes: 2048, wallMs: 60000 }, expiresAt: epoch + 60000 } });
  // A separate accepted clone lets us test both a pre-start and an already-running work item.
  const copy = { ...accepted, id: rid() }, queuedCopy = { ...accepted, id: rid() };
  f.store.transaction(tx => { for (const item of [copy, queuedCopy]) tx.run("INSERT INTO work_items VALUES (?,?,?)", item.id, item.conversationId, canonical(item)); });
  const running = start(accepted).work!, queued = start(queuedCopy).work!;
  const attempt = f.app.authority.admit(running.id, rid(), { botId: "other", tools: ["web_search"], scopes: [], input: accepted.purpose, calls: 3, outputBytes: 2048 });
  expect(f.store.read(tx => f.app.memory.attemptPacket(tx, attempt.id)).sources).toContainEqual(accepted.source!);
  f.app.execute(f.auth.actor, { kind, requestId: rid(), expectedRevision: kind === "memory.revoke" ? 2 : 1, payload: { claim: original } });
  expect(() => f.app.execute(f.auth.actor, { kind: "task.accept", requestId: rid(), expectedRevision: 1, payload: { taskId: proposed.id } })).toThrow("memory_source_unavailable");
  expect(() => start(copy)).toThrow("memory_source_unavailable");
  expect(() => f.app.authority.admit(queued.id, rid(), { botId: "other", tools: [], scopes: [], input: accepted.purpose, calls: 1, outputBytes: 1024 })).toThrow("memory_source_unavailable");
  expect(() => f.app.authority.reserveTool(attempt.id, "web_search")).toThrow("memory_context_stale");
  expect(() => f.app.authority.commit(attempt.id, { state: "ready", text: "Late derived task text" })).toThrow("memory_context_stale");
});

test("ordinary record volume prunes disposable packets, preserves live barriers and reopens without blocking chat", async () => {
  const f = await fixture(), original = remember(f), live = post(f, "Live context").reply!.snapshot.memory!;
  const work = f.app.execute(f.auth.actor, { kind: "work.start", requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision,
    payload: { conversationId: f.conversationId, task: null, title: "Retained work", purpose: "Use memory", completionRule: "Evidence", bots: [{ id: "jit", revision: 1 }], tools: [], scopes: [], limits: { attempts: 1, steps: 1, calls: 3, outputBytes: 2048, wallMs: 60000 }, expiresAt: epoch + 60000 } }).work!;
  const attempt = f.app.authority.admit(work.id, rid(), { botId: "jit", tools: [], scopes: [], input: "Use memory", calls: 3, outputBytes: 2048 });
  const found = claim(f, original); if (found.state !== "available") throw Error("fixture");
  let tail = found.claim.source;
  f.store.transaction(tx => {
    for (let i = 0; i < 20001; i++) {
      const source: MemorySource = { id: `bulk_source_${i}`, botId: "jit", conversationId: f.conversationId, revision: 1, generation: 1, attribution: "bot", text: "Ordinary source", derived: [tail], access: [], createdAt: epoch };
      tx.run("INSERT INTO memory_sources VALUES (?,?,?)", source.id, "jit", canonical(source));
      tail = { id: source.id, revision: 1, generation: 1 };
      tx.run("INSERT INTO memory_contexts VALUES (?,?,?)", `bulk_context_${i}`, "jit", canonical({ ...live, id: `bulk_context_${i}`, sources: [] }));
    }
  });
  f.store.close(); stores.delete(f.store);
  const store = new S14Store(f.path); stores.add(store);
  const app = new S14Application(store, f.options), actor = app.authenticate(f.token).actor;
  expect(store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM memory_contexts")!.n)).toBeLessThanOrEqual(258);
  expect(app.memory.context(actor, live.id).state).toBe("current");
  expect(app.memory.context(actor, attempt.memoryId!).state).toBe("current");
  expect(store.read(tx => app.memory.sourceCurrent(tx, tail))).toBe(true);
  app.execute(actor, { kind: "memory.forget", requestId: rid(), expectedRevision: 1, payload: { claim: original } });
  expect(store.read(tx => app.memory.sourceCurrent(tx, tail))).toBe(false);
  expect(app.memory.context(actor, live.id).state).toBe("retired");
  expect(() => app.authority.commit(attempt.id, { state: "ready", text: "Stale result" })).toThrow("memory_context_stale");
  app.execute(actor, { kind: "message.post", requestId: rid(), expectedRevision: app.conversation(actor, f.conversationId).conversation.revision, payload: { conversationId: f.conversationId, text: "Chat still works" } });
  await app.drainReplies();
  expect(app.conversation(actor, f.conversationId).messages.at(-1)!.role).toBe("bot");
});
