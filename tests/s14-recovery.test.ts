import { afterEach, expect, test } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostError, createHost, type HostSessionReference } from "schway/host";
import { record, save, S14Application, type S14Options } from "../src/s14/application";
import { S14Store } from "../src/s14/store";
import type { StartPayload } from "../src/s14/authority-types";
import type { Bot } from "../src/s14/types";
import type { StepProposal, WorkGraph } from "../src/s14/graph-types";
import type { NativeIntent, NativeRecoveryPort, ReconcileEffectCommand } from "../src/s14/recovery-types";
import { nativeIntentPaths, schwayRecovery } from "../src/s14/native-recovery";
import { replayPolicy } from "../src/s14/replay-policy";
import { createS14Handler } from "../src/s14/web";

const roots: string[] = [], stores = new Set<S14Store>();
const rid = () => crypto.randomUUID().replaceAll("-", "");
const reference = (): HostSessionReference => ({ id: crypto.randomUUID(), branchId: "main" });
const barrier = () => Promise.withResolvers<void>();
afterEach(() => { for (const store of stores) store.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(tools: string[] = [], changes: Partial<StartPayload> = {}, pendingNodes: StepProposal[] = []) {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-recovery-")); roots.push(root);
  const path = join(root, "app.sqlite"), store = new S14Store(path); stores.add(store);
  const clock = { now: 1800000000000 };
  const options: S14Options = { policy: { routes: [{ id: "selected", provider: "codex", model: "fixture" }], tools: ["web_fetch", "computer", "effect_send", "unregistered"], resources: ["share1"] },
    now: () => clock.now, chat: { async reply() { return { text: "Chat" }; } } };
  const app = new S14Application(store, options); await app.provisionOwner("fixture-recovery-owner-password");
  const token = await app.login("fixture-recovery-owner-password"), actor = app.authenticate(token).actor;
  const setup = app.execute(actor, { kind: "setup", requestId: rid(), expectedRevision: 0, payload: { ownerName: "Owner", language: "en", routeId: "selected", capabilities: { tools: options.policy.tools, resources: ["share1"] } } });
  const conversationId = setup.conversation!.id;
  const started = app.execute(actor, { kind: "work.start", requestId: rid(), expectedRevision: 1,
    payload: { conversationId, task: null, title: "Read", purpose: "Read evidence", completionRule: "Review", bots: [{ id: "jit", revision: 1 }], tools, scopes: [],
      limits: { attempts: 8, steps: 8, calls: 16, outputBytes: 131072, concurrency: 2, reads: 40, wallMs: 60000 }, expiresAt: clock.now + 60000, ...changes } });
  const workId = started.work!.id;
  const graph = store.read(tx => record<WorkGraph>(tx, "work_graphs", workId)), node = graph.nodes[0]!;
  node.calls = 2; node.outputBytes = 4096;
  app.graph.propose(workId, graph.revision, [node, ...pendingNodes]);
  const { id: _id, handler: _handler, dependsOn: _dependsOn, ...input } = node;
  const attempt = app.authority.admit(workId, rid(), input);
  store.transaction(tx => {
    const step = app.graph.steps(tx, workId)[0]!;
    attempt.step = { id: step.id, handler: node.handler, inputs: [], gaps: [] };
    step.attemptId = attempt.id; step.state = "running"; step.startedAt = clock.now;
    save(tx, "work_attempts", attempt); save(tx, "work_steps", step);
    app.recovery.prepare(tx, attempt); app.recovery.dispatch(tx, attempt.id);
    tx.run("INSERT INTO attempt_transports VALUES (?,1)", attempt.id);
  });
  const intent = () => app.recovery.intent(attempt.id, attempt.memoryId!, attempt.snapshot.route);
  const reopen = () => {
    store.close(); stores.delete(store);
    const next = new S14Store(path); stores.add(next);
    const reopened = new S14Application(next, options);
    return { app: reopened, store: next, get actor() { return reopened.authenticate(token).actor; } };
  };
  return { root, path, store, app, options, token, actor, clock, workId, attempt, intent, reopen, conversationId };
}
function nativeFixture() {
  const ledger = new Map<string, NativeIntent["discovered"]>();
  const controls = { busy: false, corrupt: false, partial: false, closeFailure: false, retired: 0, deleted: 0, opens: 0, lists: 0 };
  const port: NativeRecoveryPort = { async open(intent) {
    controls.opens++;
    return {
      async listSessions(options) {
        controls.lists++;
        if (controls.corrupt) throw new HostError("storage");
        const rows = ledger.get(intent.id) ?? [], start = options?.after ? rows.findIndex(r => r.reference.id === options.after) + 1 : 0;
        const sessions = rows.slice(start, start + 1);
        return { sessions: structuredClone(sessions), ...(start + 1 < rows.length ? { next: sessions[0]!.reference.id } : {}) };
      },
      async retireSession(ref) {
        if (controls.busy) throw new HostError("busy");
        controls.retired++;
        const entry = ledger.get(intent.id)!.find(e => e.reference.id === ref.id)!; entry.state = "retired";
      },
      async deleteSession(ref) {
        if (controls.busy) return { status: "blocked", session: ref, reason: "busy", nextAction: "wait" };
        if (controls.partial) return { status: "partial", session: ref, removed: [], remaining: ["conversation"], nextAction: "reconcile" };
        controls.deleted++;
        ledger.get(intent.id)!.find(e => e.reference.id === ref.id)!.state = "deleted";
        return { status: "deleted", session: ref, removed: ["conversation"], nextAction: "none" };
      },
      async close() { if (controls.closeFailure) throw new HostError("busy"); },
    };
  } };
  return { port, ledger, controls };
}

test.each(["before_creation", "after_native_persistence", "after_app_correlation"])("crash %s discovers/fences before safe requeue and retains spent reservations", async window => {
  const f = await fixture(), n = nativeFixture(), intent = f.intent(), ref = reference();
  if (window !== "before_creation") n.ledger.set(intent.id, [{ reference: ref, state: "active" }]);
  if (window === "after_app_correlation") f.app.recovery.correlate(intent.id, { ...ref, branchId: "saved-branch" });
  const before = f.app.authority.view(f.actor, f.workId).reservations;
  const { app, actor } = f.reopen(); await app.recovery.boot(n.port);
  expect(app.recovery.view(actor).checkpoints[0]).toMatchObject({ state: "queued", transport: "settled", reason: null });
  expect(app.authority.view(actor, f.workId).reservations).toEqual(before);
  expect(app.recovery.view(actor).native[0]!.state).toBe(window === "before_creation" ? "not_created" : "retired");
  if (window === "after_app_correlation") expect(app.recovery.view(actor).native[0]!.reference!.branchId).toBe("saved-branch");
  let runs = 0;
  app.authority.options.executor = { async run(attempt) { runs++; expect(attempt.id).not.toBe(f.attempt.id); return { state: "ready", text: "Fresh safe result" }; } };
  await app.authority.drain(); expect(runs).toBe(1);
  expect(app.recovery.view(actor).checkpoints[0]!.state).toBe("resumed");
  expect(() => app.authority.commit(f.attempt.id, { state: "ready", text: "Late old worker" })).toThrow();
});

test.each(["busy", "corrupt", "closeFailure"] as const)("native %s remains honestly unresolved, holds capacity and never auto-resubmits", async failure => {
  const f = await fixture(), n = nativeFixture(), intent = f.intent();
  n.ledger.set(intent.id, [{ reference: reference(), state: "active" }]); n.controls[failure] = true;
  const { app, actor, store } = f.reopen(); const before = app.authority.view(actor, f.workId).reservations;
  let calls = 0; app.authority.options.executor = { async run() { calls++; return { state: "ready", text: "Forbidden" }; } };
  await app.recovery.boot(n.port); await app.authority.drain();
  expect(calls).toBe(0); expect(app.recovery.view(actor).native[0]!.state).toBe("unresolved");
  expect(app.recovery.view(actor).checkpoints[0]).toMatchObject({ state: "waiting", reason: "old_transport_unsettled", transport: "unknown" });
  expect(app.authority.view(actor, f.workId).reservations).toEqual(before);
  expect(store.read(tx => tx.get<{ active: number }>("SELECT active FROM attempt_transports WHERE attempt_id=?", f.attempt.id)!.active)).toBe(1);
  n.controls[failure] = false; await app.recovery.boot(n.port);
  expect(app.recovery.view(actor).native[0]!.state).toBe("retired");
});

test("pagination discovers multiple orphan identities, while a missing saved identity remains unresolved", async () => {
  const f = await fixture(), n = nativeFixture(), intent = f.intent();
  n.ledger.set(intent.id, [{ reference: reference(), state: "active" }, { reference: reference(), state: "retired" }, { reference: reference(), state: "deleted" }]);
  f.app.recovery.correlate(intent.id, reference());
  const { app, actor } = f.reopen(); await app.recovery.boot(n.port);
  expect(n.controls.lists).toBe(3); expect(app.recovery.view(actor).native[0]).toMatchObject({ state: "unresolved", reason: "native_reference_missing" });
  expect(app.recovery.view(actor).native[0]!.discovered).toHaveLength(3);
});

test.each(["owner", "bot", "route", "source", "decision", "graph", "expiry", "budget", "reads", "stop", "step_stop", "revoked"])("changed %s waits with a specific reason and does not refund uncertain usage", async change => {
  const f = await fixture(["web_fetch"]), n = nativeFixture(); f.intent();
  const expected: Record<string, string> = { owner: "owner_authority_changed", bot: "configuration_or_route_changed", route: "configuration_or_route_changed", source: "source_or_context_changed", decision: "source_or_context_changed", graph: "checkpoint_configuration_changed", expiry: "grant_expired", budget: "budget_exhausted", reads: "budget_exhausted", stop: "owner_stopped", step_stop: "owner_stopped_step", revoked: "grant_revoked" };
  if (change === "stop") f.app.execute(f.actor, { kind: "work.stop", requestId: rid(), expectedRevision: f.app.authority.view(f.actor, f.workId).work.revision, payload: { workId: f.workId } });
  else if (change === "step_stop") f.app.execute(f.actor, { kind: "work.step.stop", requestId: rid(), expectedRevision: 1, payload: { workId: f.workId, stepId: f.attempt.step!.id } });
  else f.store.transaction(tx => {
    if (change === "owner") tx.run("UPDATE owner SET generation=generation+1");
    if (change === "bot") { const bot = record<Bot>(tx, "bots", "jit"); bot.generation++; save(tx, "bots", bot); }
    if (change === "source") { const packet = record<{ id: string; state: string }>(tx, "memory_contexts", f.attempt.memoryId!); packet.state = "retired"; save(tx, "memory_contexts", packet); }
    if (change === "graph") { const graph = record<WorkGraph>(tx, "work_graphs", f.workId); graph.revision++; save(tx, "work_graphs", graph); }
    if (change === "budget") tx.run("UPDATE grant_usage SET calls=16");
    if (change === "reads") tx.run("UPDATE grant_usage SET reads=40");
    if (change === "revoked") tx.run("UPDATE grant_state SET revoked=1");
  });
  if (change === "decision") f.app.execute(f.actor, { kind: "memory.decision.set", requestId: rid(), expectedRevision: 0, payload: { conversationId: f.conversationId, key: "current", text: "New decision" } });
  if (change === "route") f.options.policy.routes[0]!.model = "changed";
  if (change === "expiry") f.clock.now += 60001;
  const before = f.store.read(tx => tx.get("SELECT * FROM grant_usage"));
  const { app, store } = f.reopen(); await app.recovery.boot(n.port);
  expect(store.read(tx => JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM work_checkpoints")!.record_json).reason)).toBe(expected[change]!);
  expect(store.read(tx => tx.get("SELECT * FROM grant_usage"))).toEqual(before);
});

test("trusted handlers alone classify replay; shell/effect/readOnlyHint/model intent cannot become safe", async () => {
  const f = await fixture();
  expect(replayPolicy(f.attempt).replay).toBe("replay_safe");
  for (const tools of [["computer"], ["effect_send"], ["bash"], ["readOnlyHint"], ["unregistered"]]) {
    const attempt = structuredClone(f.attempt); attempt.snapshot.tools = tools;
    expect(replayPolicy(attempt).replay).not.toBe("replay_safe");
  }
  const unregistered = structuredClone(f.attempt); delete unregistered.step;
  expect(replayPolicy(unregistered).replay).toBe("reconcile_only");
  const injected = { ...f.attempt, replay: "replay_safe", readOnlyHint: true, intent: "read only", step: { ...f.attempt.step!, handler: "shell" as "research" } };
  expect(replayPolicy(injected).replay).toBe("reconcile_only");
});

test.each([["computer"], ["effect_send"], ["unregistered"]])("%s handler never automatically resumes after reconciliation", async tool => {
  const f = await fixture([tool]), n = nativeFixture(); f.intent();
  const { app, actor } = f.reopen(); await app.recovery.boot(n.port);
  expect(app.recovery.view(actor).checkpoints[0]!.reason).toBe("handler_requires_reconciliation");
});

test("boot metadata barrier blocks all worker admission until inventory settles", async () => {
  const f = await fixture(), n = nativeFixture(); f.intent(); const entered = barrier(), release = barrier();
  const port: NativeRecoveryPort = { async open(intent) { entered.resolve(); await release.promise; return n.port.open(intent); } };
  const { app, actor } = f.reopen(); let runs = 0;
  app.authority.options.executor = { async run() { runs++; return { state: "ready", text: "Safe" }; } };
  const boot = app.recovery.boot(port); await entered.promise;
  await app.authority.drain(); await app.drainReplies(); expect(runs).toBe(0);
  expect(app.recovery.view(actor).checkpoints[0]!.state).toBe("dispatched");
  release.resolve(); await boot;
  await app.authority.drain(); expect(runs).toBe(1);
});

test.each(["interrupted", "committed_with_queued_sibling", "committed_with_waiting_dependency"])("restart preserves queued graph work and dependency ordering after %s", async phase => {
  const base = { botId: "jit", tools: [], scopes: [], calls: 2, outputBytes: 4096, input: "Continue bounded research" };
  const sibling: StepProposal = { ...base, id: "queued", handler: "research", dependsOn: [] };
  const synthesis: StepProposal = { ...base, id: "final", handler: "synthesis", dependsOn: phase === "committed_with_waiting_dependency" ? ["research_0"] : ["research_0", "queued"] };
  const f = await fixture([], {}, phase === "committed_with_waiting_dependency" ? [synthesis] : [sibling, synthesis]);
  const n = nativeFixture(); f.intent();
  if (phase !== "interrupted") f.app.authority.commit(f.attempt.id, { state: "ready", text: "Previously committed producer" });
  const before = f.app.authority.view(f.actor, f.workId).reservations;
  const { app, actor } = f.reopen(); await app.recovery.boot(n.port);
  expect(app.authority.view(actor, f.workId).work.state).toBe("queued");
  expect(app.authority.view(actor, f.workId).reservations).toEqual(before);
  const runs: string[] = [];
  app.authority.options.executor = { async run(attempt) {
    expect(app.recovery.booting).toBe(false);
    expect(attempt.id).not.toBe(f.attempt.id);
    const node = app.graph.view(actor, f.workId).steps.find(step => step.id === attempt.step!.id)!.nodeId;
    runs.push(node);
    if (node === "final") {
      expect(attempt.step!.inputs).toHaveLength(synthesis.dependsOn.length);
      expect(attempt.step!.gaps).toEqual([]);
      for (const input of attempt.step!.inputs) expect(app.authority.view(actor, f.workId).results.some(result => result.attemptId === input.attemptId)).toBe(true);
    }
    return { state: "ready", text: `${node} committed` };
  } };
  await app.authority.drain();
  expect(runs).toEqual(phase === "interrupted" ? ["research_0", "queued", "final"] : phase === "committed_with_queued_sibling" ? ["queued", "final"] : ["final"]);
  expect(app.graph.view(actor, f.workId).steps.every(step => step.state === "committed")).toBe(true);
  expect(app.authority.view(actor, f.workId).work.state).toBe("ready");
  expect(app.authority.view(actor, f.workId).reservations!.attempts).toBe(before!.attempts + runs.length);
});

test("committed ingress and wake-up drains wait for the entire boot reconciliation including native close", async () => {
  const f = await fixture(), n = nativeFixture(); f.intent();
  const closing = barrier(), release = barrier();
  const port: NativeRecoveryPort = { async open(intent) {
    const host = await n.port.open(intent);
    return { ...host, async close() { closing.resolve(); await release.promise; await host.close(); } };
  } };
  const { app, actor } = f.reopen(); let workRuns = 0, chatRuns = 0;
  app.authority.options.executor = { async run() { expect(app.recovery.booting).toBe(false); workRuns++; return { state: "ready", text: "Safe fresh result" }; } };
  app.options.chat = { async reply() { expect(app.recovery.booting).toBe(false); chatRuns++; return { text: "Fresh chat" }; } };
  const boot = app.recovery.boot(port); await closing.promise;
  app.execute(actor, { ...f.attempt.snapshot.grant.command, requestId: rid(), expectedRevision: app.conversation(actor, f.conversationId).conversation.revision });
  app.execute(actor, { kind: "message.post", requestId: rid(), expectedRevision: app.conversation(actor, f.conversationId).conversation.revision,
    payload: { conversationId: f.conversationId, text: "New committed owner ingress" } });
  app.authority.wake();
  await Promise.all([app.authority.drain(), app.authority.drain(), app.drainReplies()]);
  expect(workRuns).toBe(0); expect(chatRuns).toBe(0);
  expect(app.recovery.view(actor).checkpoints[0]!.state).toBe("dispatched");
  release.resolve(); await boot;
  await app.authority.drain();
  expect(workRuns).toBe(2); expect(chatRuns).toBe(1);
});

test("crash after atomic artifact commit preserves one result/report and never replays it", async () => {
  const f = await fixture(), n = nativeFixture(); f.intent();
  f.app.authority.commit(f.attempt.id, { state: "ready", text: "Committed evidence", report: { title: "Report", claims: [{ id: "claim", kind: "inference", text: "Unverified", citations: [], covers: [], conflicts: [] }], missing: [], limitations: ["Unverified"], artifactIds: [] } });
  const report = f.app.reports.list(f.actor, f.workId)[0]!;
  const { app, actor } = f.reopen(); await app.recovery.boot(n.port);
  let runs = 0; app.authority.options.executor = { async run() { runs++; return { state: "ready", text: "Duplicate" }; } };
  await app.authority.drain(); expect(runs).toBe(0);
  expect(app.reports.list(actor, f.workId)).toEqual([report]);
  expect(app.authority.view(actor, f.workId).results).toHaveLength(1);
  expect(app.recovery.view(actor).checkpoints[0]!.state).toBe("committed");
});

test("stale restore discovers independent catalog orphans and retries partial deletion without resurrecting execution", async () => {
  const f = await fixture(), n = nativeFixture(), backup = join(f.root, "image.sqlite"); copyFileSync(f.path, backup);
  const intent = f.intent(); n.ledger.set(intent.id, [{ reference: reference(), state: "active" }]);
  // Restore an app image without the native intent or its context; the current independent catalog survives.
  f.store.transaction(tx => { tx.run("DELETE FROM native_intents"); tx.run("DELETE FROM memory_contexts"); });
  n.controls.partial = true;
  const { app, actor } = f.reopen(); await app.recovery.boot(n.port);
  expect(app.recovery.view(actor).native[0]).toMatchObject({ mode: "delete", state: "unresolved", reason: "native_delete_partial" });
  n.controls.partial = false; await app.recovery.boot(n.port);
  expect(app.recovery.view(actor).native[0]!.state).toBe("deleted");
  expect(app.recovery.view(actor).checkpoints[0]!.state).toBe("waiting");
});

async function unknownEffect() {
  const f = await fixture(["effect_send"]), n = nativeFixture(); f.intent();
  let sends = 0;
  f.app.authority.options.effects = { send: async () => { sends++; return "unknown"; } };
  const effect = f.app.authority.proposeEffect(f.attempt.id, rid(), { kind: "send", destination: "https://fixture.invalid/receiver", content: "Exact content" }, f.clock.now + 30000);
  f.app.execute(f.actor, { kind: "approval.decide", requestId: rid(), expectedRevision: effect.revision, payload: { effectId: effect.id, actionHash: effect.actionHash, decision: "approve" } });
  const backup = join(f.root, "approved.sqlite"); copyFileSync(f.path, backup);
  await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash);
  const command = (): ReconcileEffectCommand => ({ kind: "effect.reconcile", requestId: rid(), expectedRevision: effect.revision,
    payload: { effectId: effect.id, actionHash: effect.actionHash, outcome: "occurred", note: "Owner inspected destination" } });
  return { ...f, n, effect, command, backup, sends: () => sends };
}

test("unknown effect waits; exact typed owner statement is idempotent, revision-bound and never retries", async () => {
  const f = await unknownEffect(); await f.app.recovery.boot(f.n.port);
  expect(f.app.recovery.view(f.actor).checkpoints[0]!.reason).toBe("unknown_effect_reconcile_only");
  const command = f.command(), receipt = f.app.execute(f.actor, command);
  expect(receipt.effect).toMatchObject({ state: "unknown", reason: "owner_statement_not_verified", resolution: { basis: "owner_statement", outcome: "occurred" } });
  expect(f.app.execute(f.actor, command)).toEqual(receipt);
  expect(f.sends()).toBe(1);
  expect(() => f.app.execute(f.actor, f.command())).toThrow("stale_effect_resolution");
  await expect(f.app.authority.runEffect(f.effect.id, receipt.effect.revision, f.effect.actionHash)).rejects.toThrow("stale_approval");
  expect(() => f.app.execute({ ownerId: "owner" }, command)).toThrow("authentication_required");
});

test("stale approved-image restore cannot resend a claimed effect or lose the owner's recorded outcome", async () => {
  const f = await unknownEffect(); f.app.execute(f.actor, f.command());
  f.store.close(); stores.delete(f.store); copyFileSync(f.backup, f.path);
  const store = new S14Store(f.path); stores.add(store); const app = new S14Application(store, f.options), actor = app.authenticate(f.token).actor;
  const effect = app.authority.effect(actor, f.effect.id).effect;
  expect(effect.state).toBe("unknown"); expect(effect.resolution!.basis).toBe("owner_statement");
  await expect(app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).rejects.toThrow("stale_approval");
});

test("effect resolution refuses changed hash, extra fields, non-unknown state and missing CSRF", async () => {
  const f = await unknownEffect();
  expect(() => f.app.execute(f.actor, { ...f.command(), payload: { ...f.command().payload, actionHash: "a".repeat(64) } })).toThrow("stale_effect_resolution");
  expect(() => f.app.execute(f.actor, { ...f.command(), payload: { ...f.command().payload, retry: true } } as ReconcileEffectCommand)).toThrow("invalid_shape");
  const handler = createS14Handler(f.app, "http://localhost:3001");
  expect((await handler(new Request("http://localhost:3001/api/s14/recovery"))).status).toBe(401);
  expect((await handler(new Request("http://localhost:3001/api/s14/commands", { method: "POST", headers: { cookie: `jit_s14=${f.token}`, origin: "http://localhost:3001", "content-type": "application/json" }, body: JSON.stringify(f.command()) }))).status).toBe(403);
});

// Exercise the pinned public artifact without provider/model/tool construction or native byte parsing.
test("public host inventory finds an uncorrelated session, refuses a live lease, then retires it", async () => {
  const f = await fixture(), intent = f.intent(), directory = join(f.root, "native");
  const host = await createHost({ ...nativeIntentPaths(directory, intent), context: { policy: "strict", systemPrompt: "Fixture", sections: [] }, tools: { policy: "exact", hostedLookup: "off", definitions: [] }, limits: { maxTurns: 1, maxConcurrentTools: 1, contextWindow: 32768, maxInputChars: 1024 } });
  const session = await host.createSession();
  const { app, actor } = f.reopen();
  await app.recovery.boot(schwayRecovery(directory));
  expect(app.recovery.view(actor).native[0]!.discovered[0]!.reference.id).toBe(session.reference.id);
  expect(app.recovery.view(actor).native[0]).toMatchObject({ state: "unresolved", reason: "native_busy" });
  await session.close(); await host.close();
  await app.recovery.boot(schwayRecovery(directory));
  expect(app.recovery.view(actor).native[0]!.state).toBe("retired");
});

test.each(["before_creation", "after_native_persistence", "after_app_correlation", "during_retirement", "during_deletion"])("real pinned public artifact survives process crash %s without private record access", async phase => {
  const f = await fixture(), directory = join(f.root, "native");
  const child = Bun.spawn([process.execPath, "--no-env-file", join(import.meta.dir, "fixtures/s14-native-crash.ts")], {
    stdin: new Blob([JSON.stringify({ path: f.path, directory, policy: f.options.policy, now: f.clock.now, attemptId: f.attempt.id, phase })]), stdout: "pipe", stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(out).toBe(""); expect(err).toBe(""); expect(exit).toBe(0);
  const { app, actor } = f.reopen(); await app.recovery.boot(schwayRecovery(directory));
  const native = app.recovery.view(actor).native[0]!;
  expect(native.state).toBe(phase === "during_deletion" ? "deleted" : phase === "before_creation" ? "not_created" : "retired");
  expect(native.discovered).toHaveLength(phase === "before_creation" ? 0 : 1);
  expect(app.recovery.view(actor).checkpoints[0]!.state).toBe("queued");
});

test.each(["attempts", "steps", "output_bytes"])("exhausted %s reservations block recovery without a refund", async counter => {
  const f = await fixture(), n = nativeFixture(); f.intent();
  const columns = { attempts: "attempts=8", steps: "steps=8", output_bytes: "output_bytes=131072" };
  f.store.transaction(tx => tx.run(`UPDATE grant_usage SET ${columns[counter as keyof typeof columns]}`));
  const { app, actor } = f.reopen(); await app.recovery.boot(n.port);
  expect(app.recovery.view(actor).checkpoints[0]!.reason).toBe("budget_exhausted");
});

test("unknown usage with no discoverable correlation stays unsettled rather than inventing zero or transport termination", async () => {
  const f = await fixture(), n = nativeFixture();
  const { app, actor } = f.reopen(); await app.recovery.boot(n.port);
  expect(app.recovery.view(actor).checkpoints[0]).toMatchObject({ transport: "unknown", reason: "old_transport_unsettled", state: "waiting" });
  expect(app.recovery.view(actor).actualUsage).toBeNull();
});

test("owner resolution works after grant expiry, rolls back atomically and cannot claim verified read-back", async () => {
  const f = await unknownEffect(); f.clock.now += 60001;
  const command = f.command();
  f.options.beforeCommit = () => { throw Error("fixture_resolution_rollback"); };
  expect(() => f.app.execute(f.actor, command)).toThrow("fixture_resolution_rollback");
  expect(f.store.read(tx => tx.get("SELECT effect_id FROM lifecycle.effect_outcomes"))).toBeNull();
  expect(f.app.authority.effect(f.actor, f.effect.id).effect.resolution).toBeUndefined();
  delete f.options.beforeCommit;
  expect(() => f.app.execute(f.actor, { ...command, payload: { ...command.payload, basis: "verified_read_back" } } as ReconcileEffectCommand)).toThrow("invalid_shape");
  const receipt = f.app.execute(f.actor, command);
  expect(receipt.effect.resolution!.basis).toBe("owner_statement");
  expect(f.sends()).toBe(1);
});

test("known adapter outcomes cannot be overwritten by an owner unknown-effect resolution", async () => {
  const f = await unknownEffect();
  f.store.transaction(tx => { const effect = record<import("../src/s14/authority-types").Effect>(tx, "effects", f.effect.id); effect.state = "succeeded"; save(tx, "effects", effect); });
  expect(() => f.app.execute(f.actor, f.command())).toThrow("stale_effect_resolution");
});

test("stale approved-image restore retains uncertain call reservations and fences claimed actions without an owner statement", async () => {
  const f = await unknownEffect();
  const spent = f.app.authority.view(f.actor, f.workId).reservations;
  f.store.close(); stores.delete(f.store); copyFileSync(f.backup, f.path);
  const store = new S14Store(f.path); stores.add(store); const app = new S14Application(store, f.options), actor = app.authenticate(f.token).actor;
  const effect = app.authority.effect(actor, f.effect.id).effect;
  expect(effect.state).toBe("unknown"); expect(effect.resolution).toBeUndefined();
  expect(app.authority.view(actor, f.workId).reservations).toEqual(spent);
  await expect(app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).rejects.toThrow("stale_approval");
});

test("restored image missing an admitted attempt discovers its orphan and blocks its original grant instead of replaying unknown work", async () => {
  const f = await fixture(), n = nativeFixture(), intent = f.intent();
  n.ledger.set(intent.id, [{ reference: reference(), state: "active" }]); n.controls.busy = true;
  const spent = f.app.authority.view(f.actor, f.workId).reservations;
  f.store.transaction(tx => {
    tx.run("DELETE FROM native_intents"); tx.run("DELETE FROM work_checkpoints");
    tx.run("DELETE FROM attempt_transports"); tx.run("DELETE FROM attempt_usage");
    tx.run("DELETE FROM memory_contexts"); tx.run("DELETE FROM work_attempts");
    tx.run("UPDATE grant_usage SET attempts=0,steps=0,calls=0,output_bytes=0,reads=0");
  });
  const { app, actor } = f.reopen(); await app.recovery.boot(n.port);
  expect(app.recovery.view(actor).native[0]).toMatchObject({ mode: "delete", state: "unresolved", reason: "native_busy" });
  expect(app.authority.view(actor, f.workId).reservations).toEqual(spent);
  expect(() => app.authority.admit(f.workId, rid(), { botId: "jit", tools: [], scopes: [], input: "Replay", calls: 1, outputBytes: 100 })).toThrow();
  n.controls.busy = false; await app.recovery.boot(n.port);
  expect(app.recovery.view(actor).native[0]!.state).toBe("deleted");
  expect(app.authority.view(actor, f.workId).work.reason).toBe("native_checkpoint_missing");
});

test("a known returned handler failure is retained and reboot does not become an unsolicited retry", async () => {
  const f = await fixture(), n = nativeFixture();
  f.app.authority.settle(f.attempt.id, "handler_unavailable");
  f.store.transaction(tx => { f.app.recovery.settled(tx, f.attempt.id); f.app.graph.finish(tx, f.attempt, "handler_unavailable"); });
  const { app, actor } = f.reopen(); await app.recovery.boot(n.port);
  expect(app.recovery.view(actor).checkpoints[0]).toMatchObject({ state: "finished", reason: "handler_unavailable" });
  let calls = 0; app.authority.options.executor = { async run() { calls++; return { state: "ready", text: "Unexpected retry" }; } };
  await app.authority.drain(); expect(calls).toBe(0);
});

test("cooperative shutdown settlement remains eligible only within its original safe authority and budgets", async () => {
  const f = await fixture(), n = nativeFixture();
  f.app.authority.settle(f.attempt.id, "work_cancelled");
  f.store.transaction(tx => { f.app.recovery.settled(tx, f.attempt.id, true); f.app.graph.finish(tx, f.attempt, "work_cancelled"); });
  const { app, actor } = f.reopen(); await app.recovery.boot(n.port);
  expect(app.recovery.view(actor).checkpoints[0]).toMatchObject({ state: "queued", transport: "settled" });
});

test("a second boot revalidates queued recovery before any replacement admission", async () => {
  const f = await fixture(), n = nativeFixture(); f.intent();
  const { app, actor } = f.reopen(); await app.recovery.boot(n.port);
  expect(app.recovery.view(actor).checkpoints[0]!.state).toBe("queued");
  app.policy.routes[0]!.model = "changed-between-boots";
  await app.recovery.boot(n.port);
  expect(app.recovery.view(actor).checkpoints[0]).toMatchObject({ state: "waiting", reason: "configuration_or_route_changed" });
  expect(app.graph.view(actor, f.workId).steps[0]!.state).toBe("blocked");
  let calls = 0; app.authority.options.executor = { async run() { calls++; return { state: "ready", text: "Forbidden" }; } };
  await app.authority.drain(); expect(calls).toBe(0);
});

test("native uncertainty on a second boot fences an already queued recovery again and retains capacity", async () => {
  const f = await fixture(), n = nativeFixture(), intent = f.intent();
  n.ledger.set(intent.id, [{ reference: reference(), state: "active" }]);
  const { app, actor } = f.reopen(); await app.recovery.boot(n.port);
  expect(app.recovery.view(actor).checkpoints[0]!.state).toBe("queued");
  n.controls.corrupt = true; await app.recovery.boot(n.port);
  expect(app.recovery.view(actor).checkpoints[0]).toMatchObject({ state: "waiting", transport: "unknown", reason: "old_transport_unsettled" });
  expect(app.graph.view(actor, f.workId).steps[0]!.state).toBe("blocked");
  const next = app.execute(actor, { ...f.attempt.snapshot.grant.command, requestId: rid(),
    expectedRevision: app.conversation(actor, f.conversationId).conversation.revision });
  expect(() => app.authority.admit(next.work!.id, rid(), { botId: "jit", tools: [], scopes: [], input: "Another work", calls: 1, outputBytes: 100 })).toThrow("execution_capacity_held");
});
