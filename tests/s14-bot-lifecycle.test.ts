import { afterEach, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { HostError, type HostSessionReference } from "schway/host";
import { record, save } from "../src/s14/application";
import type { Attempt } from "../src/s14/authority-types";
import type { BotLifecycleCommand, BotLifecycle } from "../src/s14/bot-lifecycle-types";
import type { NativeIntent, NativeRecoveryPort } from "../src/s14/recovery-types";
import type { Bot, Capabilities } from "../src/s14/types";
import { createS14Handler } from "../src/s14/web";
import { canonical } from "../src/s14/validation";
import { FakeComputerRuntime, barrier } from "./fixtures/s14-computer";
import { domainFixture, retryId, routineCommand, secondBot, workCommand, type DomainFixture } from "./fixtures/s14-domain";

const fixtures: DomainFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
async function fixture(changes: Parameters<typeof domainFixture>[0] = {}) { const f = await domainFixture(changes); fixtures.push(f); return f; }
function bot(f: DomainFixture, botId = "jit") { return f.app.botLifecycle.view(f.auth.actor, botId).bot; }
function propose(f: DomainFixture, botId: string, capabilities: Capabilities, reenable = false) {
  return f.app.execute(f.auth.actor, { kind: reenable ? "bot.reenable.propose" : "bot.capabilities.propose", requestId: retryId(), expectedRevision: bot(f, botId).revision,
    payload: { botId, capabilities } }).proposal!;
}
function accept(f: DomainFixture, proposal: ReturnType<typeof propose>) {
  return { kind: "bot.capabilities.accept" as const, requestId: retryId(), expectedRevision: proposal.revision,
    payload: { proposalId: proposal.id, proposalHash: proposal.hash } };
}
function lifecycleCommand(f: DomainFixture, botId: string, action: "retire" | "delete"): BotLifecycleCommand {
  const preview = f.app.botLifecycle.preview(f.auth.actor, botId, action);
  return action === "retire" ? { kind: "bot.retire", requestId: retryId(), expectedRevision: preview.bot.revision,
    payload: { botId, previewHash: preview.hash, retain: { history: true, evidence: true } } }
    : { kind: "bot.delete", requestId: retryId(), expectedRevision: preview.bot.revision, payload: { botId, previewHash: preview.hash } };
}
function nativeFixture() {
  const ledger = new Map<string, NativeIntent["discovered"]>();
  const controls = { busy: false, closeFailure: false, deleted: 0, retired: 0, opens: 0 };
  const port: NativeRecoveryPort = { async open(intent) {
    controls.opens++;
    return {
      async listSessions() { return { sessions: structuredClone(ledger.get(intent.id) ?? []) }; },
      async retireSession(reference) {
        if (controls.busy) throw new HostError("busy");
        controls.retired++;
        const entry = ledger.get(intent.id)!.find(row => row.reference.id === reference.id)!; entry.state = "retired";
      },
      async deleteSession(reference) {
        if (controls.busy) return { status: "blocked", session: reference, reason: "busy", nextAction: "wait" };
        controls.deleted++;
        ledger.get(intent.id)!.find(row => row.reference.id === reference.id)!.state = "deleted";
        return { status: "deleted", session: reference, removed: ["conversation"], nextAction: "none" };
      },
      async close() { if (controls.closeFailure) throw new HostError("busy"); },
    };
  } };
  return { ledger, controls, port };
}
function start(f: DomainFixture, selected: Bot, tools: string[] = [], ownConversation = false) {
  const conversationId = ownConversation ? f.app.home(f.auth.actor).conversations.find(c => c.botId === selected.id)!.id : f.conversationId;
  const command = workCommand(f, { conversationId, bots: [{ id: selected.id, revision: selected.revision }], tools });
  command.expectedRevision = f.app.conversation(f.auth.actor, conversationId).conversation.revision;
  return f.app.execute(f.auth.actor, command);
}
function admission(f: DomainFixture, workId: string, selected: Bot, tools: string[] = []) {
  return f.app.authority.admit(workId, retryId(), { botId: selected.id, tools, scopes: [], input: "Private bounded input", calls: 6, outputBytes: 16384 });
}
function claim(f: DomainFixture, conversationId: string, content: string) {
  return f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: retryId(), expectedRevision: f.app.conversation(f.auth.actor, conversationId).conversation.revision,
    payload: { conversationId, text: content } }).claim!;
}


test("tool-less Jit has exact owner repair path; widening does not expand existing work/resources/accounts", async () => {
  const f = await fixture(), n = nativeFixture();
  f.store.transaction(tx => { const current = record<Bot>(tx, "bots", "jit"); current.capabilities = { tools: [], resources: [] }; save(tx, "bots", current); });
  const original = start(f, bot(f)), proposal = propose(f, "jit", { tools: ["web_search", "web_fetch"], resources: [] });
  expect(bot(f).capabilities.tools).toEqual([]);
  expect(() => f.app.execute({ ownerId: "owner" }, accept(f, proposal))).toThrow("authentication_required");
  expect(() => f.app.execute(f.auth.actor, { ...accept(f, proposal), payload: { proposalId: proposal.id, proposalHash: "f".repeat(64) } })).toThrow("stale_capability_proposal");
  const command = accept(f, proposal), receipt = f.app.execute(f.auth.actor, command);
  expect(f.app.execute(f.auth.actor, command)).toEqual(receipt);
  expect(bot(f)).toMatchObject({ enabled: false, generation: 2, capabilities: { tools: ["web_search", "web_fetch"], resources: [] } });
  expect(f.app.authority.view(f.auth.actor, original.work!.id).grant!.tools).toEqual([]);
  expect(() => admission(f, original.work!.id, receipt.bot!, ["web_search"])).toThrow("grant_revoked");
  await f.app.botLifecycle.drain(n.port);
  expect(bot(f)).toMatchObject({ enabled: true, generation: 2 });
  expect(start(f, bot(f), ["web_search"]).grant!.tools).toEqual(["web_search"]);
  expect(() => propose(f, "jit", { tools: ["not_configured"], resources: [] })).toThrow("capability_unconfigured");
  expect(() => f.app.execute(f.auth.actor, { ...accept(f, proposal), requestId: retryId() })).toThrow("stale_capability_proposal");
});

test("stale proposals/previews, source/model authority and changed request IDs refuse; rollback keeps authority live", async () => {
  const f = await fixture(), b = await secondBot(f), n = nativeFixture();
  const first = propose(f, b.id, { tools: [], resources: [] }), second = propose(f, b.id, { tools: ["web_search"], resources: [] });
  expect(() => f.app.execute(f.auth.actor, accept(f, first))).toThrow("stale_capability_proposal");
  const staleDelete = lifecycleCommand(f, b.id, "delete");
  f.app.execute(f.auth.actor, accept(f, second)); await f.app.botLifecycle.drain(n.port);
  expect(() => f.app.execute(f.auth.actor, accept(f, first))).toThrow("stale_capability_proposal");
  expect(() => f.app.execute(f.auth.actor, staleDelete)).toThrow("stale_lifecycle_preview");
  const command = lifecycleCommand(f, b.id, "retire");
  f.options.beforeCommit = () => { throw new Error("fixture_before_commit"); };
  expect(() => f.app.execute(f.auth.actor, command)).toThrow("fixture_before_commit");
  expect(bot(f, b.id).enabled).toBe(true);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM lifecycle.bot_events WHERE bot_id=?", b.id)!.n)).toBe(1);
  delete f.options.beforeCommit;
  const receipt = f.app.execute(f.auth.actor, command); expect(f.app.execute(f.auth.actor, command)).toEqual(receipt);
  expect(() => f.app.execute(f.auth.actor, { ...command, requestId: retryId(), payload: { ...command.payload, ownerId: "owner" } } as never)).toThrow("invalid_shape");
  expect(() => f.app.execute(f.auth.actor, lifecycleCommand(f, "jit", "delete"))).toThrow("main_bot_required");
  expect(() => f.app.execute(f.auth.actor, lifecycleCommand(f, "jit", "retire"))).toThrow("main_bot_required");
});

test.each(["restrict", "retire", "delete"] as const)("%s fences queued admission, tools, routine tick and publication immediately while actual transport holds stopping", async action => {
  const entered = barrier();
  const f = await fixture({ authority: { executor: { async run() { await entered.wait(); return { state: "ready", text: "Late prohibited output" }; } } } }), b = await secondBot(f), n = nativeFixture();
  const routine = f.app.execute(f.auth.actor, routineCommand(f, { bots: [{ id: b.id, revision: b.revision }], tools: ["web_search"] })).routine;
  f.clock.now += 60000; f.app.routines.tick();
  const workId = f.app.routines.view(f.auth.actor, routine.id).history[0]!.workId!;
  const queued = start(f, b, ["web_search"]);
  const draining = f.app.authority.drain(); await entered.reached;
  const attempt = f.app.authority.view(f.auth.actor, workId).attempts[0] ?? f.app.authority.view(f.auth.actor, queued.work!.id).attempts[0]!;
  if (action === "restrict") f.app.execute(f.auth.actor, accept(f, propose(f, b.id, { tools: [], resources: [] })));
  else f.app.execute(f.auth.actor, lifecycleCommand(f, b.id, action));
  expect(f.app.botLifecycle.view(f.auth.actor, b.id).lifecycle.state).toBe(action === "delete" ? "deleting" : "stopping");
  expect(() => f.app.authority.reserveTool(attempt.id, "web_search")).toThrow();
  expect(() => f.app.authority.commit(attempt.id, { state: "ready", text: "Late publication" })).toThrow();
  expect(() => admission(f, queued.work!.id, b)).toThrow("grant_revoked");
  await f.app.botLifecycle.drain(n.port);
  expect(f.app.botLifecycle.view(f.auth.actor, b.id).lifecycle.reason).toBe("bot_transports_unsettled");
  f.clock.now += 60000; f.app.routines.tick();
  expect(f.app.routines.view(f.auth.actor, routine.id).history).toHaveLength(1);
  entered.release(); await draining;
  await f.app.botLifecycle.drain(n.port);
  expect(f.app.botLifecycle.view(f.auth.actor, b.id).lifecycle.state).toBe(action === "restrict" ? "active" : action === "retire" ? "retired" : "deleted");
  expect(f.app.authority.view(f.auth.actor, workId).results).toEqual([]);
  expect(f.app.authority.view(f.auth.actor, queued.work!.id).results).toEqual([]);
});

test("retirement retains explicit owner history/report evidence, but reenable is fresh generation and never revives work/routines", async () => {
  const f = await fixture(), b = await secondBot(f), n = nativeFixture();
  const conversation = f.app.home(f.auth.actor).conversations.find(c => c.botId === b.id)!;
  const retainedClaim = claim(f, conversation.id, "Private retained owner history");
  const work = start(f, b), a = admission(f, work.work!.id, b);
  f.app.authority.commit(a.id, { state: "ready", text: "Retained result", report: { title: "Retained report", claims: [{ id: "unsupported", text: "Unverified inference", kind: "inference", citations: [], covers: [], conflicts: [] }], missing: [], limitations: ["No source evidence"], artifactIds: [] } });
  const report = f.app.reports.list(f.auth.actor, work.work!.id)[0]!;
  expect(report.state).toBe("available");
  f.app.execute(f.auth.actor, lifecycleCommand(f, b.id, "retire")); await f.app.botLifecycle.drain(n.port);
  expect(f.app.memory.claim(f.auth.actor, b.id, retainedClaim).claim.state).toBe("available");
  expect(f.app.authority.view(f.auth.actor, work.work!.id).results[0]!.text).toBe("Retained result");
  expect(f.app.reports.list(f.auth.actor, work.work!.id)[0]!.state).toBe("available");
  expect(() => f.app.recovery.guardContext(a.memoryId!)).toThrow("native_context_fenced");
  const reenable = propose(f, b.id, { tools: ["web_search"], resources: [] }, true);
  f.app.execute(f.auth.actor, accept(f, reenable)); await f.app.botLifecycle.drain(n.port);
  expect(bot(f, b.id)).toMatchObject({ enabled: true, generation: 3, capabilities: { tools: ["web_search"], resources: [] } });
  expect(() => f.app.authority.admit(work.work!.id, retryId(), { botId: b.id, tools: [], scopes: [], input: "old", calls: 1, outputBytes: 100 })).toThrow("grant_revoked");
  expect(() => f.app.authority.commit(a.id, { state: "ready", text: "Old resurrection" })).toThrow();
  expect(start(f, bot(f, b.id), ["web_search"]).grant!.bots[0]!.generation).toBe(3);
});

test.each(["before", "after"] as const)("Bot narrowing fences owner browser input %s final runtime dispatch", async when => {
  const runtime = new FakeComputerRuntime(), gate = barrier();
  if (when === "before") runtime.beforeInput = gate; else runtime.afterInput = gate;
  const f = await fixture({ computers: { runtime } }), b = await secondBot(f), n = nativeFixture();
  const work = start(f, b, ["computer"]), a = admission(f, work.work!.id, b, ["computer"]);
  await f.app.computers.prepare(a.id);
  let view = f.app.computers.view(f.auth.actor, b.id);
  f.app.execute(f.auth.actor, { kind: "takeover.start", requestId: retryId(), expectedRevision: view.computer!.revision,
    payload: { botId: b.id, computerId: view.computer!.id, generation: view.computer!.generation, leaseRevision: view.lease!.revision } });
  view = f.app.computers.view(f.auth.actor, b.id);
  const input = f.app.computers.ownerInput(f.auth.actor, { kind: "takeover.input", requestId: retryId(), expectedRevision: view.computer!.revision,
    payload: { botId: b.id, computerId: view.computer!.id, generation: view.computer!.generation, leaseRevision: view.lease!.revision, input: { kind: "text", text: "transient private input" } } });
  await gate.reached;
  f.app.execute(f.auth.actor, accept(f, propose(f, b.id, { tools: [], resources: [] })));
  expect(f.app.computers.view(f.auth.actor, b.id).lease!.actor).toBeNull();
  expect(f.app.computers.view(f.auth.actor, b.id).computer!.state).toBe("stopping");
  gate.release(); expect((await input).state).toBe("unknown");
  expect(runtime.inputs).toHaveLength(when === "before" ? 0 : 1);
  f.app.authority.settle(a.id); await f.app.botLifecycle.drain(n.port);
  expect(f.app.botLifecycle.view(f.auth.actor, b.id).lifecycle.state).toBe("active");
});

test("computer-only delete does not retire Bot; retire does not erase computer volumes/history", async () => {
  const runtime = new FakeComputerRuntime(), f = await fixture({ computers: { runtime } }), b = await secondBot(f), n = nativeFixture();
  const work = start(f, b, ["computer"]), a = admission(f, work.work!.id, b, ["computer"]); await f.app.computers.prepare(a.id);
  const c = f.app.computers.view(f.auth.actor, b.id).computer!;
  f.app.execute(f.auth.actor, { kind: "computer.delete", requestId: retryId(), expectedRevision: c.revision, payload: { botId: b.id, computerId: c.id, generation: c.generation } });
  await f.app.computers.drain(); expect(bot(f, b.id).enabled).toBe(true);
  f.app.authority.settle(a.id);
  f.app.execute(f.auth.actor, lifecycleCommand(f, b.id, "retire")); await f.app.botLifecycle.drain(n.port);
  expect(runtime.destroyed).toHaveLength(1);
  expect(f.app.botLifecycle.view(f.auth.actor, b.id).lifecycle.state).toBe("retired");
});

test("delete propagates owned/derived sources, claims, shares, reports, artifacts and native contexts, preserving foreign originals", async () => {
  const runtime = new FakeComputerRuntime(), f = await fixture({ computers: { runtime } }), b = await secondBot(f), n = nativeFixture();
  const ownConversation = f.app.home(f.auth.actor).conversations.find(c => c.botId === b.id)!;
  const own = claim(f, ownConversation.id, "Bot-owned private original"), independent = claim(f, f.conversationId, "Independently owned Jit original");
  const ownLookup = f.app.memory.claim(f.auth.actor, b.id, own).claim, independentLookup = f.app.memory.claim(f.auth.actor, "jit", independent).claim;
  if (ownLookup.state !== "available" || independentLookup.state !== "available") throw Error("fixture missing claim");
  const outbound = f.app.execute(f.auth.actor, { kind: "snapshot.share", requestId: retryId(), expectedRevision: bot(f).revision,
    payload: { scopeId: "share1", target: { kind: "source", ...ownLookup.claim.source }, receiverBotId: "jit", workId: null, expiresAt: f.clock.now + 60000 } }).share;
  f.app.execute(f.auth.actor, { kind: "snapshot.share", requestId: retryId(), expectedRevision: b.revision,
    payload: { scopeId: "resource1", target: { kind: "source", ...independentLookup.claim.source }, receiverBotId: b.id, workId: null, expiresAt: f.clock.now + 60000 } });
  const received = f.app.execute(f.auth.actor, workCommand(f, { scopes: [{ kind: "share", id: outbound.id, revision: 1 }] }));
  const derivative = f.app.authority.admit(received.work!.id, retryId(), { botId: "jit", tools: [], scopes: [{ kind: "share", id: outbound.id, revision: 1 }], input: "Read the explicit snapshot", calls: 4, outputBytes: 16384 });
  f.app.authority.commit(derivative.id, { state: "ready", text: "Derived shared answer", report: { title: "Derived report",
    claims: [{ id: "c", text: "Derived unsupported inference", kind: "inference", citations: [], covers: [], conflicts: [] }], missing: [], limitations: [], artifactIds: [] } });
  const delivered = f.app.reports.list(f.auth.actor, received.work!.id)[0]!;
  if (delivered.state !== "available") throw Error("fixture report missing");
  const ownWork = start(f, b, ["computer"], true), ownAttempt = admission(f, ownWork.work!.id, b, ["computer"]);
  await f.app.computers.prepare(ownAttempt.id);
  const computer = f.app.computers.view(f.auth.actor, b.id).computer!;
  const intent = f.app.recovery.intent(ownAttempt.id, ownAttempt.memoryId!, ownAttempt.snapshot.route);
  const reference: HostSessionReference = { id: crypto.randomUUID(), branchId: "main" };
  n.ledger.set(intent.id, [{ reference, state: "active" }]); f.app.recovery.correlate(intent.id, reference);
  f.app.authority.settle(ownAttempt.id);
  const preview = f.app.botLifecycle.preview(f.auth.actor, b.id, "delete");
  expect(preview.data.sources.some(source => source.id === `result_${derivative.id}`)).toBe(true);
  expect(preview.data.claims.some(c => c.id === independent.id)).toBe(false);
  expect(preview.data.reports.map(r => r.id)).toContain(delivered.report.id);
  expect(preview.shares).toHaveLength(2);
  expect(preview.computer!.id).toBe(computer.id);
  expect(preview.native.map(i => i.id)).toContain(intent.id);
  n.controls.busy = true;
  const command = lifecycleCommand(f, b.id, "delete"), receipt = f.app.execute(f.auth.actor, command);
  expect(receipt.bot!.name).toBe("[deleted]");
  expect(f.app.execute(f.auth.actor, command)).toEqual(receipt);
  await f.app.botLifecycle.drain(n.port);
  expect(f.app.botLifecycle.view(f.auth.actor, b.id).lifecycle).toMatchObject({ state: "deleting", reason: "bot_native_cleanup_unresolved" });
  expect(f.app.memory.claim(f.auth.actor, b.id, own).claim.state).toBe("unavailable");
  expect(f.app.memory.claim(f.auth.actor, "jit", independent).claim.state).toBe("available");
  expect(f.app.reports.view(f.auth.actor, delivered.report.id).state).toBe("unavailable");
  expect(() => f.app.artifacts.download(f.auth.actor, delivered.artifacts[0]!.id)).toThrow("artifact_unavailable");
  expect(f.app.sharing.list(f.auth.actor).every(s => s.state === "revoked")).toBe(true);
  expect(runtime.destroyed).toEqual([computer.id]);
  n.controls.busy = false; await f.app.botLifecycle.drain(n.port);
  expect(f.app.botLifecycle.view(f.auth.actor, b.id).lifecycle.state).toBe("deleted");
  expect(n.controls.deleted).toBe(1);
  expect(() => propose(f, b.id, { tools: [], resources: [] }, true)).toThrow("bot_lifecycle_changed");
  expect(bot(f).enabled).toBe(true);
  const cache = f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM work_attempts WHERE id=?", ownAttempt.id)!.record_json);
  expect(cache).not.toContain("Private bounded input");
  expect(f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM work_grants WHERE id=?", ownWork.grant!.id)!.record_json)).not.toContain("Compare public facts");
});

test.each(["fenced", "data", "computer", "native", "complete"] as const)("crash after committed %s cleanup stage is retry-safe and ledger prevents old-image resurrection", async stage => {
  let fail = false;
  const runtime = new FakeComputerRuntime();
  const f = await fixture({ computers: { runtime }, botLifecycle: { afterStage(current) { if (fail && current === stage) throw Error(`crash_${stage}`); } } }), b = await secondBot(f), n = nativeFixture();
  const conversation = f.app.home(f.auth.actor).conversations.find(c => c.botId === b.id)!;
  const original = claim(f, conversation.id, "Secret deleted payload");
  const routine = f.app.execute(f.auth.actor, routineCommand(f, { bots: [{ id: b.id, revision: b.revision }] })).routine;
  const work = start(f, b, ["computer"], true), a = admission(f, work.work!.id, b, ["computer"]);
  await f.app.computers.prepare(a.id);
  const intent = f.app.recovery.intent(a.id, a.memoryId!, a.snapshot.route);
  const reference: HostSessionReference = { id: crypto.randomUUID(), branchId: "main" };
  n.ledger.set(intent.id, [{ reference, state: "active" }]); f.app.recovery.correlate(intent.id, reference);
  f.app.authority.settle(a.id);
  const before = join(f.root, "before-delete.sqlite"); copyFileSync(f.path, before);
  const command = lifecycleCommand(f, b.id, "delete"); f.app.execute(f.auth.actor, command);
  fail = true;
  await expect(f.app.botLifecycle.drain(n.port)).rejects.toThrow(`crash_${stage}`);
  fail = false; f.reopen(); await f.app.recovery.boot(n.port); await f.app.botLifecycle.drain(n.port);
  expect(f.app.botLifecycle.view(f.auth.actor, b.id).lifecycle.state).toBe("deleted");
  expect(f.app.memory.claim(f.auth.actor, b.id, original).claim.state).toBe("unavailable");
  // Restore the stale app image only; the current independent ledger remains mandatory.
  f.store.close(); copyFileSync(before, f.path); f.reopen();
  expect(bot(f, b.id).enabled).toBe(false);
  expect(f.app.memory.claim(f.auth.actor, b.id, original).claim.state).toBe("unavailable");
  f.clock.now += 60000; f.app.routines.tick();
  expect(f.app.routines.view(f.auth.actor, routine.id).history).toHaveLength(0);
  await f.app.recovery.boot(n.port); await f.app.botLifecycle.drain(n.port);
  expect(f.app.botLifecycle.view(f.auth.actor, b.id).lifecycle.state).toBe("deleted");
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM work_grants")!.n)).toBe(1);
  expect(n.controls.deleted).toBe(1);
  expect(runtime.volumes.size).toBe(0);
});

test("stale application image cannot revive accepted policy generations or old grants", async () => {
  const f = await fixture(), b = await secondBot(f), n = nativeFixture(), oldWork = start(f, b, ["web_search"]);
  const before = join(f.root, "before-restrict.sqlite"); copyFileSync(f.path, before);
  f.app.execute(f.auth.actor, accept(f, propose(f, b.id, { tools: [], resources: [] })));
  await f.app.botLifecycle.drain(n.port);
  f.store.close(); copyFileSync(before, f.path); f.reopen();
  expect(bot(f, b.id)).toMatchObject({ enabled: false, generation: 2, capabilities: { tools: [], resources: [] } });
  expect(() => admission(f, oldWork.work!.id, b, ["web_search"])).toThrow("grant_revoked");
  await f.app.botLifecycle.drain(n.port);
  expect(f.app.botLifecycle.view(f.auth.actor, b.id).lifecycle.state).toBe("retired");
});

test("chat transport and native context are fenced without pretending cancellation settled inference", async () => {
  const gate = barrier(); let blocked = false;
  const f = await fixture({ chat: { async reply() { if (blocked) await gate.wait(); return { text: "Reply", proposal: { name: "Researcher", responsibility: "Research" } }; } } }), b = await secondBot(f), n = nativeFixture();
  const conversation = f.app.home(f.auth.actor).conversations.find(c => c.botId === b.id)!;
  const queued = f.app.execute(f.auth.actor, { kind: "message.post", requestId: retryId(), expectedRevision: conversation.revision, payload: { conversationId: conversation.id, text: "Private request" } });
  const intent = f.app.recovery.intent(null, queued.reply!.snapshot.memory!.id, queued.reply!.snapshot.route);
  expect(intent.botId).toBe(b.id);
  blocked = true; const pending = f.app.drainReplies(); await gate.reached;
  f.app.execute(f.auth.actor, lifecycleCommand(f, b.id, "retire"));
  expect(() => f.app.recovery.guardContext(queued.reply!.snapshot.memory!.id)).toThrow("native_context_fenced");
  await f.app.botLifecycle.drain(n.port);
  expect(f.app.botLifecycle.view(f.auth.actor, b.id).lifecycle.reason).toBe("bot_transports_unsettled");
  gate.release(); await pending; await f.app.botLifecycle.drain(n.port);
  expect(f.app.botLifecycle.view(f.auth.actor, b.id).lifecycle.state).toBe("retired");
  expect(f.app.conversation(f.auth.actor, conversation.id).messages.filter(m => m.role === "bot")).toHaveLength(0);
});

test("newly arrived data invalidates lifecycle preview even when Bot revision did not change", async () => {
  const f = await fixture(), b = await secondBot(f), command = lifecycleCommand(f, b.id, "delete");
  const conversation = f.app.home(f.auth.actor).conversations.find(c => c.botId === b.id)!;
  claim(f, conversation.id, "New data after preview");
  expect(() => f.app.execute(f.auth.actor, command)).toThrow("stale_lifecycle_preview");
  expect(bot(f, b.id).enabled).toBe(true);
});

test("JSON and no-script commands share exact lifecycle receipts with authenticated private preview queries", async () => {
  const f = await fixture(), b = await secondBot(f), handler = createS14Handler(f.app, "http://localhost:3001");
  const headers = { origin: "http://localhost:3001", cookie: `jit_s14=${f.token}`, "content-type": "application/x-www-form-urlencoded" };
  const url = `http://localhost:3001/api/s14/bots/${b.id}/lifecycle/delete-preview`;
  expect((await handler(new Request(url))).status).toBe(401);
  const preview = await handler(new Request(url, { headers })); expect(preview.headers.get("cache-control")).toBe("private, no-store");
  const command = lifecycleCommand(f, b.id, "delete");
  const response = await handler(new Request("http://localhost:3001/s14/commands", { method: "POST", headers, body: new URLSearchParams({ csrf: f.auth.csrf, command: JSON.stringify(command) }) }));
  expect(response.status).toBe(303);
  const receipt = await (await handler(new Request(`http://localhost:3001${response.headers.get("location")}`, { headers }))).json();
  const duplicate = await handler(new Request("http://localhost:3001/api/s14/commands", { method: "POST", headers: { ...headers, "content-type": "application/json", "x-csrf-token": f.auth.csrf }, body: JSON.stringify(command) }));
  expect(await duplicate.json()).toEqual(receipt);
  const csrf = await handler(new Request("http://localhost:3001/s14/commands", { method: "POST", headers, body: new URLSearchParams({ csrf: "0".repeat(64), command: JSON.stringify(command) }) }));
  expect(csrf.status).toBe(403);
});

test("capability reduction during an actual public-read protocol wait fences its late evidence", async () => {
  const gate = barrier(); let calls = 0;
  const f = await fixture({ parallel: { transport: async (_url, init) => {
    calls++;
    const wire = JSON.parse(init.body as string);
    await gate.wait();
    return Response.json({ jsonrpc: "2.0", id: wire.id, result: { protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } } });
  } } }), b = await secondBot(f);
  const work = start(f, b, ["web_search"]), a = admission(f, work.work!.id, b, ["web_search"]);
  const reading = f.app.parallel.read(a.id, "web_search", { query: "public scientific facts" });
  await gate.reached;
  f.app.execute(f.auth.actor, accept(f, propose(f, b.id, { tools: [], resources: [] })));
  gate.release();
  const result = await reading;
  expect(result.outcome).toBe("authority_changed");
  expect(result.evidence).toEqual([]);
  expect(calls).toBe(1);
  expect(f.app.parallel.inspect(f.auth.actor, work.work!.id).evidence).toEqual([]);
  f.app.authority.settle(a.id);
});

test("Bot deletion preserves another Bot's independently authorized work even in its conversation", async () => {
  const f = await fixture(), b = await secondBot(f), n = nativeFixture();
  const conversation = f.app.home(f.auth.actor).conversations.find(c => c.botId === b.id)!;
  const command = workCommand(f, { conversationId: conversation.id }); command.expectedRevision = conversation.revision;
  const started = f.app.execute(f.auth.actor, command), a = admission(f, started.work!.id, bot(f));
  f.app.authority.commit(a.id, { state: "ready", text: "Independent Jit work with no deleted source dependency" });
  f.app.execute(f.auth.actor, lifecycleCommand(f, b.id, "delete")); await f.app.botLifecycle.drain(n.port);
  expect(f.app.authority.view(f.auth.actor, started.work!.id).results[0]!.text).toBe("Independent Jit work with no deleted source dependency");
  expect(f.app.authority.view(f.auth.actor, started.work!.id).work.title).toBe(command.payload.title);
  expect(bot(f).enabled).toBe(true);
});

test("delete erases exact effect payload caches but preserves unknown outcome/hash facts without resurrection or resend", async () => {
  let sends = 0;
  const f = await fixture({ policy: { routes: [{ id: "selected", provider: "codex", model: "fixture" }], tools: ["effect_send"], resources: [] },
    authority: { effects: { send: async (_action, allowed) => { allowed(); sends++; return "unknown"; } } } }), b = await secondBot(f), n = nativeFixture();
  const work = start(f, b, ["effect_send"]), a = admission(f, work.work!.id, b, ["effect_send"]);
  const effect = f.app.authority.proposeEffect(a.id, retryId(), { kind: "send", destination: "https://recipient.invalid/exact", content: "Private exact effect payload" }, f.clock.now + 60000);
  f.app.execute(f.auth.actor, { kind: "approval.decide", requestId: retryId(), expectedRevision: 1, payload: { effectId: effect.id, actionHash: effect.actionHash, decision: "approve" } });
  await f.app.authority.runEffect(effect.id, 1, effect.actionHash);
  expect(f.app.botLifecycle.preview(f.auth.actor, b.id, "delete").retainedEffects[0]!.actionHash).toBe(effect.actionHash);
  f.app.execute(f.auth.actor, lifecycleCommand(f, b.id, "delete"));
  f.app.authority.settle(a.id); await f.app.botLifecycle.drain(n.port);
  expect(f.app.authority.effect(f.auth.actor, effect.id).effect).toMatchObject({ state: "unknown", actionHash: effect.actionHash, payloadState: "deleted", action: { content: "[deleted]", destination: "[deleted]" } });
  const receipts = f.store.read(tx => tx.all<{ result_json: string }>("SELECT result_json FROM command_receipts"));
  expect(receipts.map(row => row.result_json).join()).not.toContain("Private exact effect payload");
  f.reopen(); await f.app.recovery.boot(n.port);
  await expect(f.app.authority.runEffect(effect.id, 1, effect.actionHash)).rejects.toThrow();
  expect(sends).toBe(1);
});

test("native-busy orphan retirement retries metadata settlement without replay or unrelated Bot cancellation", async () => {
  const f = await fixture(), b = await secondBot(f), n = nativeFixture();
  const work = start(f, b), a = admission(f, work.work!.id, b);
  const intent = f.app.recovery.intent(a.id, a.memoryId!, a.snapshot.route);
  const reference: HostSessionReference = { id: crypto.randomUUID(), branchId: "main" };
  n.ledger.set(intent.id, [{ reference, state: "active" }]); f.app.recovery.correlate(intent.id, reference);
  n.controls.busy = true; await f.app.recovery.boot(n.port);
  expect(f.app.authority.view(f.auth.actor, work.work!.id).attempts[0]!.state).toBe("interrupted");
  const unrelated = start(f, bot(f)), before = f.app.authority.view(f.auth.actor, unrelated.work!.id).authority;
  f.app.execute(f.auth.actor, lifecycleCommand(f, b.id, "retire"));
  await f.app.botLifecycle.drain(n.port);
  expect(f.app.botLifecycle.view(f.auth.actor, b.id).lifecycle.state).toBe("stopping");
  n.controls.busy = false; await f.app.botLifecycle.drain(n.port);
  expect(f.app.botLifecycle.view(f.auth.actor, b.id).lifecycle.state).toBe("retired");
  expect(f.app.authority.view(f.auth.actor, work.work!.id).work.state).toBe("stopped");
  expect(f.app.authority.view(f.auth.actor, unrelated.work!.id).authority).toEqual(before);
  expect(f.app.authority.view(f.auth.actor, unrelated.work!.id).work.state).toBe("queued");
});

test("forget and routine-control changes invalidate an otherwise identical lifecycle manifest", async () => {
  const f = await fixture(), b = await secondBot(f);
  const conversation = f.app.home(f.auth.actor).conversations.find(c => c.botId === b.id)!;
  const remembered = claim(f, conversation.id, "Forget this before deletion");
  const routine = f.app.execute(f.auth.actor, routineCommand(f, { bots: [{ id: b.id, revision: b.revision }] })).routine;
  const beforeForget = lifecycleCommand(f, b.id, "delete");
  f.app.execute(f.auth.actor, { kind: "memory.forget", requestId: retryId(), expectedRevision: remembered.revision, payload: { claim: remembered } });
  expect(() => f.app.execute(f.auth.actor, beforeForget)).toThrow("stale_lifecycle_preview");
  const beforePause = lifecycleCommand(f, b.id, "retire");
  f.app.execute(f.auth.actor, { kind: "routine.pause", requestId: retryId(), expectedRevision: routine.revision, payload: { routineId: routine.id } });
  expect(() => f.app.execute(f.auth.actor, beforePause)).toThrow("stale_lifecycle_preview");
});
