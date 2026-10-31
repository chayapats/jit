import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S14Application, type S14Options } from "../src/s14/application";
import { S14Store } from "../src/s14/store";
import type { Attempt, AuthorityOptions, StartPayload, WorkExecutor } from "../src/s14/authority-types";
import type { QueueCeiling, SchedulerLimits, StepProposal, WorkGraph } from "../src/s14/graph-types";
import type { Bot } from "../src/s14/types";
import { canonical } from "../src/s14/validation";
import { validateWorkGraph } from "../src/s14/graph";
import { AppError } from "../src/errors";
import { createS14Handler } from "../src/s14/web";

const roots: string[] = [], stores = new Set<S14Store>();
const rid = () => crypto.randomUUID().replaceAll("-", "");
const barrier = () => Promise.withResolvers<void>();
afterEach(() => { for (const s of stores) s.close(); stores.clear(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function fixture(executor?: WorkExecutor, extra: AuthorityOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-team-")); roots.push(root);
  const store = new S14Store(join(root, "state.sqlite")); stores.add(store);
  const clock = { now: 1800000000000 };
  const options: S14Options = { now: () => clock.now, policy: { routes: [{ id: "route", provider: "codex", model: "fixture" }], tools: ["web_search", "computer"], resources: ["share1"] },
    chat: { async reply() { return { text: "Tool-free reply" }; } }, authority: { ...(executor ? { executor } : {}), ...extra } };
  const app = new S14Application(store, options);
  await app.provisionOwner("fixture-team-password"); const token = await app.login("fixture-team-password"), auth = app.authenticate(token);
  const setup = app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: 0, payload: { ownerName: "Owner", language: "en", routeId: "route", capabilities: { tools: ["web_search", "computer"], resources: ["share1"] } } });
  const bot = setup.bot!, conversationId = setup.conversation!.id;
  store.transaction(tx => {
    for (const name of ["second", "third"]) {
      const peer: Bot = { ...bot, id: name, name, responsibility: `${name} private responsibility`, capabilities: { tools: name === "second" ? ["web_search"] : [], resources: [] } };
      tx.run("INSERT INTO bots VALUES (?,?)", peer.id, canonical(peer));
      tx.run("INSERT INTO conversations VALUES (?,?,1)", `${name}chat`, peer.id);
    }
  });
  const start = (changes: Partial<StartPayload> = {}) => app.execute(auth.actor, { kind: "work.start", requestId: rid(), expectedRevision: app.conversation(auth.actor, conversationId).conversation.revision,
    payload: { conversationId, task: null, title: "Team research", purpose: "Compare evidence", completionRule: "Cited research", bots: [{ id: "jit", revision: 1 }, { id: "second", revision: 1 }], tools: ["web_search"], scopes: [],
      limits: { attempts: 8, steps: 8, calls: 40, outputBytes: 65536, wallMs: 1800000, concurrency: 2, reads: 40 }, expiresAt: clock.now + 1800000, ...changes } });
  return { app, store, root, options, auth, token, clock, start, conversationId };
}

test("barriers prove two real overlapping Bot transports, isolated context/tools and committed dependency ordering", async () => {
  const both = barrier(), release = barrier(), seen: Attempt[] = [];
  const f = await fixture({ async run(attempt) {
    seen.push(attempt);
    if (attempt.step!.handler === "research") {
      if (seen.filter(a => a.step!.handler === "research").length === 2) both.resolve();
      await release.promise;
      return { state: "ready", text: `Evidence ${attempt.snapshot.bot.id}` };
    }
    expect(attempt.step!.inputs.map(i => i.text).sort()).toEqual(["Evidence jit", "Evidence second"]);
    expect(attempt.step!.gaps).toEqual([]);
    expect(attempt.snapshot.tools).toEqual([]);
    return { state: "ready", text: "Synthesis from committed evidence" };
  } });
  const receipt = f.start(), draining = f.app.authority.drain();
  await both.promise;
  const lanes = f.app.graph.view(f.auth.actor, receipt.work!.id);
  expect(lanes.active).toBe(2);
  expect(lanes.steps.map(s => s.state)).toEqual(["running", "running", "waiting_evidence"]);
  expect(seen[0]!.memoryId).not.toBe(seen[1]!.memoryId);
  expect(seen.map(a => a.snapshot.bot.id).sort()).toEqual(["jit", "second"]);
  expect(f.app.authority.view(f.auth.actor, receipt.work!.id).results).toEqual([]);
  f.clock.now += 1000; release.resolve(); await draining;
  const view = f.app.authority.view(f.auth.actor, receipt.work!.id);
  expect(view.work.state).toBe("ready"); expect(view.results).toHaveLength(3);
  expect(f.app.graph.view(f.auth.actor, receipt.work!.id).steps.every(s => s.startedAt !== null && s.settledAt === f.clock.now)).toBe(true);
  expect(view.actualUsage).toBeNull();
});

test("quota failure retains the successful sibling and synthesis receives an explicit gap", async () => {
  const entered = barrier(), release = barrier(); let count = 0;
  const f = await fixture({ async run(a) {
    if (a.step!.handler === "synthesis") {
      expect(a.step!.inputs.map(i => i.text)).toEqual(["Successful sibling evidence"]);
      expect(a.step!.gaps).toMatchObject([{ reason: "quota_exceeded" }]);
      return { state: "ready", text: "Partial: quota left missing evidence" };
    }
    if (++count === 2) entered.resolve(); await release.promise;
    if (a.snapshot.bot.id === "second") throw new AppError("quota_exceeded");
    return { state: "ready", text: "Successful sibling evidence" };
  } });
  const started = f.start(), pending = f.app.authority.drain(); await entered.promise; release.resolve(); await pending;
  expect(f.app.authority.view(f.auth.actor, started.work!.id)).toMatchObject({ work: { state: "ready", reason: "partial_graph_evidence" }, results: [{ text: "Successful sibling evidence" }, { text: "Partial: quota left missing evidence" }] });
});

test("stopping one lane fences late callbacks, retains its actual slot and allows its valid sibling", async () => {
  const both = barrier(), slow = barrier(), sibling = barrier(), siblingDone = barrier(); let count = 0, cancelled = false;
  const f = await fixture({ async run(a, signal) {
    if (a.step!.handler === "synthesis") return { state: "ready", text: "Partial synthesis" };
    if (++count === 2) both.resolve();
    if (a.snapshot.bot.id === "jit") { signal.addEventListener("abort", () => { cancelled = true; }); await slow.promise; return { state: "ready", text: "late forbidden evidence" }; }
    await sibling.promise; siblingDone.resolve(); return { state: "ready", text: "Retained sibling" };
  } });
  const receipt = f.start(), draining = f.app.authority.drain(); await both.promise;
  const step = f.app.graph.view(f.auth.actor, receipt.work!.id).steps[0]!;
  const command = { kind: "work.step.stop" as const, requestId: rid(), expectedRevision: step.revision, payload: { workId: receipt.work!.id, stepId: step.id } };
  const stopped = f.app.execute(f.auth.actor, command); expect(f.app.execute(f.auth.actor, command)).toEqual(stopped);
  expect(cancelled).toBe(true); expect(stopped.step!.state).toBe("stopping");
  expect(stopped.conversationId).toBe(f.conversationId);
  const queued = f.start({ bots: [{ id: "third", revision: 1 }], tools: [] });
  sibling.resolve(); await siblingDone.promise;
  expect(f.app.graph.view(f.auth.actor, receipt.work!.id).steps[0]!.settledAt).toBeNull();
  slow.resolve(); await draining;
  const result = f.app.authority.view(f.auth.actor, receipt.work!.id);
  expect(result.results.some(r => r.text.includes("late forbidden"))).toBe(false);
  expect(result.results.some(r => r.text === "Retained sibling")).toBe(true);
  expect(f.app.graph.view(f.auth.actor, queued.work!.id).steps[0]!.state).toBe("committed");
});

test("finite concurrency queues excess Bots and route/Bot ceilings survive actual overlap", async () => {
  const first = barrier(), release = barrier(), seen: string[] = [];
  const f = await fixture({ async run(a) { seen.push(a.snapshot.bot.id); first.resolve(); if (seen.length === 1) await release.promise; return { state: "ready", text: "Committed" }; } }, { scheduler: { global: 2, route: 1, bot: 1, computer: 1 } });
  const receipt = f.start(), pending = f.app.authority.drain(); await first.promise;
  expect(seen).toEqual(["jit"]);
  expect(f.app.graph.view(f.auth.actor, receipt.work!.id).steps[1]!.state).toBe("queued");
  release.resolve(); await pending;
  expect(seen).toEqual(["jit", "second", "jit"]);
  expect(() => f.app.execute(f.auth.actor, { kind: "work.defaults.set", requestId: rid(), expectedRevision: 1, payload: { concurrency: Infinity, wallMs: 1, reads: 1 } })).toThrow();
  expect(f.app.graph.defaults(f.auth.actor)).toMatchObject({ concurrency: 2, wallMs: 1800000, reads: 40 });
});

test("typed DAG validation refuses cycles, missing nodes, wider tools/resources/Bots and budgets", async () => {
  const f = await fixture(); const receipt = f.start(), grant = receipt.grant!;
  const original = f.app.graph.view(f.auth.actor, receipt.work!.id).graph.nodes;
  const invalid = (change: (n: StepProposal[]) => void) => { const nodes = structuredClone(original); change(nodes); expect(() => validateWorkGraph(grant, nodes)).toThrow(); };
  invalid(n => { n[0]!.dependsOn = [n.at(-1)!.id]; });
  invalid(n => { n[0]!.dependsOn = ["missing"]; });
  invalid(n => { n[0]!.tools = ["shell"]; });
  invalid(n => { n[0]!.botId = "third"; });
  invalid(n => { n[0]!.handler = "arbitrary" as "research"; });
  invalid(n => { n[0]!.calls = grant.limits.calls; });
  invalid(n => { n[0]!.scopes = [{ kind: "resource", id: "guessed", revision: 1 }]; });
  const narrow = [original[0]!]; narrow[0]!.tools = [];
  expect(f.app.graph.propose(receipt.work!.id, 1, narrow).revision).toBe(2);
  expect(() => f.app.graph.propose(receipt.work!.id, 1, narrow)).toThrow("graph_already_admitted");
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM work_grants")!.n)).toBe(1);
});

test("private memory never leaks through sibling result handoff, and withdrawal preserves unrelated committed evidence", async () => {
  const f = await fixture({ async run(a) {
    if (a.step!.handler === "synthesis") {
      expect(a.step!.inputs.map(i => i.text)).not.toContain("Private sibling text");
      expect(a.step!.gaps.some(g => g.reason === "handoff_not_accessible")).toBe(true);
      return { state: "ready", text: "Accessible evidence only" };
    }
    return { state: "ready", text: a.snapshot.bot.id === "second" ? "Private sibling text" : "Public sibling text" };
  } });
  f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: 1, payload: { conversationId: "secondchat", text: "Private sibling fact" } });
  const started = f.start(); await f.app.authority.drain();
  expect(f.app.authority.view(f.auth.actor, started.work!.id).results).toHaveLength(3);
});

test("restart retains uncertain capacity, fences graph attempts and does not automatically replay", async () => {
  const f = await fixture(); const started = f.start();
  const a = f.app.authority.admit(started.work!.id, rid(), { botId: "jit", tools: [], scopes: [], input: "Read", calls: 1, outputBytes: 100 });
  f.app.authority.recover();
  expect(f.app.authority.view(f.auth.actor, started.work!.id).attempts[0]!.state).toBe("interrupted");
  expect(() => f.app.authority.commit(a.id, { state: "ready", text: "late" })).toThrow("attempt_fenced");
  const retry = f.start({ bots: [{ id: "jit", revision: 1 }], tools: [] });
  expect(() => f.app.authority.admit(retry.work!.id, rid(), { botId: "jit", tools: [], scopes: [], input: "Read", calls: 1, outputBytes: 100 })).toThrow("execution_capacity_held");
});

test("graph/default queries and exact lane commands use authenticated HTTP and CSRF", async () => {
  const f = await fixture(); const started = f.start(), handler = createS14Handler(f.app, "http://localhost:3001");
  const url = `http://localhost:3001/api/s14/work/${started.work!.id}/graph`;
  expect((await handler(new Request(url))).status).toBe(401);
  const response = await handler(new Request(url, { headers: { cookie: `jit_s14=${f.token}` } }));
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect((await response.json()).steps).toHaveLength(3);
});

test("interactive lanes precede background work and cancelled transports retain Bot/workspace capacity", async () => {
  const entered = barrier(), release = barrier(), order: string[] = [];
  const f = await fixture({ async run(a) { order.push(a.workId); if (order.length === 1) { entered.resolve(); await release.promise; } return { state: "ready", text: "Evidence" }; } }, { scheduler: { global: 1, route: 2, bot: 2, computer: 1 } });
  const initial = f.start({ bots: [{ id: "jit", revision: 1 }], tools: [] });
  const draining = f.app.authority.drain(); await entered.promise;
  const background = f.start({ bots: [{ id: "second", revision: 1 }], tools: [] });
  f.store.transaction(tx => {
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM work_graphs WHERE id=?", background.work!.id)!;
    const graph = JSON.parse(row.record_json) as WorkGraph; graph.priority = "background";
    tx.run("UPDATE work_graphs SET record_json=? WHERE id=?", canonical(graph), graph.id);
  });
  const interactive = f.start({ bots: [{ id: "third", revision: 1 }], tools: [] });
  release.resolve(); await draining;
  expect(order).toEqual([initial.work!.id, interactive.work!.id, background.work!.id]);
});

test("actual per-run public Schway hosts overlap with separate strict native contexts", async () => {
  const { schwayResearch } = await import("../src/s14/research");
  const entered = barrier(), release = barrier(); let streams = 0;
  const seen: string[] = [];
  const f = await fixture({ async run(a, signal) {
    return schwayResearch(join(f.root, "native"), f.app, { provider: "scripted", id: "barrier-model", async *stream(request) {
      seen.push(JSON.stringify(request));
      if (a.step!.handler === "research") { if (++streams === 2) entered.resolve(); await release.promise; }
      yield { type: "message_complete", message: { type: "assistant", id: rid(), content: [{ type: "text", text: `Committed ${a.snapshot.bot.id}` }] } };
    } }).run(a, signal);
  } });
  const started = f.start({ tools: [] }), draining = f.app.authority.drain(); await entered.promise;
  expect(f.app.graph.view(f.auth.actor, started.work!.id).active).toBe(2);
  expect(seen.filter(s => s.includes("second private responsibility"))).toHaveLength(1);
  release.resolve(); await draining;
  expect(f.app.authority.view(f.auth.actor, started.work!.id).results).toHaveLength(3);
});

test("computer workspace admissions stay exclusive even when the configured Bot ceiling allows two runs", async () => {
  const f = await fixture(undefined, { scheduler: { global: 4, route: 4, bot: 2, computer: 4 } });
  const started = f.start({ bots: [{ id: "jit", revision: 1 }], tools: ["computer"] });
  const admission = { botId: "jit", tools: ["computer"], scopes: [], input: "Local report", calls: 1, outputBytes: 100 };
  const first = f.app.authority.admit(started.work!.id, rid(), admission);
  expect(() => f.app.authority.admit(started.work!.id, rid(), admission)).toThrow("execution_capacity_held");
  f.app.authority.commit(first.id, { state: "waiting", text: "Evidence held" });
  const second = f.app.authority.admit(started.work!.id, rid(), admission);
  expect(second.id).not.toBe(first.id);
});

test("owner retry after a failed graph retains prior lanes and uses the shared drain and original grant", async () => {
  let runs = 0;
  const f = await fixture({ async run() {
    if (++runs === 1) throw new AppError("quota");
    return { state: "ready", text: "Recovered evidence" };
  } });
  const started = f.start({ bots: [{ id: "jit", revision: 1 }] });
  const plan = f.app.graph.view(f.auth.actor, started.work!.id).graph;
  await f.app.authority.drain();
  const before = f.app.authority.view(f.auth.actor, started.work!.id), graph = f.app.graph.view(f.auth.actor, before.work.id);
  expect(before.work.state).toBe("blocked");
  expect(plan.nodes[0]!.outputBytes).toBe(Math.floor(before.grant!.limits.outputBytes / before.grant!.limits.attempts));
  expect(before.reservations!.outputBytes).toBe(plan.nodes[0]!.outputBytes);
  const command = { kind: "work.retry" as const, requestId: rid(), expectedRevision: before.work.revision, payload: { workId: before.work.id } };
  const receipt = f.app.execute(f.auth.actor, command);
  expect(f.app.execute(f.auth.actor, command)).toEqual(receipt);
  await f.app.authority.drain();
  const after = f.app.authority.view(f.auth.actor, before.work.id);
  expect(runs).toBe(2);
  expect(after.work.state).toBe("ready");
  expect(after.grant).toEqual(before.grant);
  expect(after.reservations!.attempts).toBe(2);
  expect(after.reservations!.outputBytes).toBe(2 * plan.nodes[0]!.outputBytes);
  expect(after.results.map(result => result.text)).toEqual(["Recovered evidence"]);
  expect(f.app.graph.view(f.auth.actor, before.work.id).steps).toEqual(graph.steps);
  expect(f.store.read(tx => tx.all<{ active: number }>("SELECT active FROM attempt_transports"))).toEqual([{ active: 0 }, { active: 0 }]);
});

test("text-only dependencies respect the complete serialized handoff ceiling and preserve UTF-8 excerpts", async () => {
  let synthesis: Attempt | undefined;
  const f = await fixture({ async run(a) {
    if (a.step!.handler === "synthesis") { synthesis = a; return { state: "ready", text: "Bounded synthesis" }; }
    return { state: "ready", text: "ก".repeat(3000) };
  } });
  const work = f.start({ bots: [{ id: "jit", revision: 1 }], tools: [], limits: { attempts: 8, steps: 8, calls: 40, reads: 40, concurrency: 2, outputBytes: 100000, wallMs: 1800000 } });
  const plan = f.app.graph.view(f.auth.actor, work.work!.id).graph, base = plan.nodes[0]!;
  const nodes: StepProposal[] = Array.from({ length: 7 }, (_, i) => ({ ...base, id: `read_${i}`, calls: 1, outputBytes: 10000 }));
  nodes.push({ ...base, id: "synthesis", handler: "synthesis", dependsOn: nodes.map(n => n.id), calls: 1, outputBytes: 1000 });
  f.app.graph.propose(work.work!.id, plan.revision, nodes);
  await f.app.authority.drain();
  expect(synthesis).toBeDefined();
  const inputs = synthesis!.step!.inputs;
  expect(Buffer.byteLength(JSON.stringify(inputs))).toBeLessThanOrEqual(49152);
  expect(inputs).toHaveLength(5);
  expect(inputs.every(input => Buffer.byteLength(input.text) <= 8192 && !input.text.includes("�") && input.evidence.length === 0)).toBe(true);
  const gaps = synthesis!.step!.gaps;
  expect(gaps.filter(g => g.reason === "handoff_result_omitted")).toHaveLength(2);
  expect(gaps.filter(g => g.reason === "handoff_result_excerpt")).toHaveLength(7);
});

test("a provisionally committed recovery transport blocks another retry until actual settlement", async () => {
  const f = await fixture();
  const started = f.start({ bots: [{ id: "jit", revision: 1 }] });
  const attempt = f.app.authority.admit(started.work!.id, rid(), { botId: "jit", tools: [], scopes: [], input: "Read", calls: 2, outputBytes: 1024 });
  f.store.transaction(tx => tx.run("INSERT INTO attempt_transports VALUES (?,1)", attempt.id));
  f.app.authority.commit(attempt.id, { state: "ready", text: "Committed before native close" });
  const work = f.app.authority.view(f.auth.actor, started.work!.id).work;
  expect(work.state).toBe("ready");
  const command = { kind: "work.retry" as const, requestId: rid(), expectedRevision: work.revision, payload: { workId: work.id } };
  expect(() => f.app.execute(f.auth.actor, command)).toThrow("reconciliation_required");
  expect(f.app.authority.view(f.auth.actor, work.id).work).toEqual(work);
  expect(f.store.read(tx => tx.get("SELECT request_id FROM command_receipts WHERE request_id=?", command.requestId))).toBeNull();
  f.store.transaction(tx => tx.run("UPDATE attempt_transports SET active=0 WHERE attempt_id=?", attempt.id));
  f.app.execute(f.auth.actor, command);
  expect(f.app.graph.view(f.auth.actor, work.id).steps.every(step => step.state === "cancelled")).toBe(true);
});

test("read reservations are finite per grant, survive failure and defaults never modify a prior grant", async () => {
  const f = await fixture();
  const defaults = f.app.graph.defaults(f.auth.actor);
  const command = { kind: "work.defaults.set" as const, requestId: rid(), expectedRevision: defaults.revision, payload: { concurrency: 1, wallMs: 60000, reads: 1 } };
  const original = f.start({ bots: [{ id: "jit", revision: 1 }], expiresAt: f.clock.now + 60000, limits: { attempts: 2, steps: 2, calls: 10, outputBytes: 1000, wallMs: 60000, concurrency: 2, reads: 1 } });
  expect(f.app.execute(f.auth.actor, command)).toEqual(f.app.execute(f.auth.actor, command));
  expect(f.app.authority.view(f.auth.actor, original.work!.id).grant!.limits.concurrency).toBe(2);
  const attempt = f.app.authority.admit(original.work!.id, rid(), { botId: "jit", tools: ["web_search"], scopes: [], input: "Read", calls: 3, outputBytes: 100 });
  f.store.transaction(tx => f.app.authority.reserveRead(tx, attempt));
  expect(() => f.store.transaction(tx => f.app.authority.reserveRead(tx, attempt))).toThrow("read_budget_exhausted");
  f.app.authority.settle(attempt.id, "quota_exceeded");
  expect(f.app.authority.view(f.auth.actor, original.work!.id).reservations!.reads).toBe(1);
});

test("an exact owner-granted private memory share reaches synthesis while execution tools remain absent", async () => {
  const f = await fixture({ async run(a) {
    if (a.step!.handler === "synthesis") {
      expect(a.snapshot.tools).toEqual([]);
      expect(a.snapshot.scopes.map(s => s.ref.id)).toEqual(["share1"]);
      expect(a.step!.inputs.map(input => input.text)).toContain("Explicitly shared sibling result");
      expect(a.step!.gaps).toEqual([]);
      return { state: "ready", text: "Synthesis within the explicit share" };
    }
    return { state: "ready", text: a.snapshot.bot.id === "second" ? "Explicitly shared sibling result" : "Coordinator result" };
  } });
  const remembered = f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: 1, payload: { conversationId: "secondchat", text: "Private fact explicitly shared with Jit" } });
  const shared = f.app.execute(f.auth.actor, { kind: "memory.share", requestId: rid(), expectedRevision: 1,
    payload: { claim: remembered.claim!, scopeId: "share1", receiverBotId: "jit", expiresAt: f.clock.now + 1800000 } });
  const started = f.start({ scopes: [{ kind: "share", id: shared.share!.id, revision: shared.share!.revision }] });
  await f.app.authority.drain();
  expect(f.app.graph.view(f.auth.actor, started.work!.id).steps.at(-1)!.state).toBe("committed");
});


test("committed ingress wakes one existing drain and starts new work before an unrelated transport settles", async () => {
  const firstEntered = barrier(), secondEntered = barrier(), release = barrier(), seen: Attempt[] = [];
  let reentrant: Promise<void> | undefined;
  const f = await fixture({ async run(attempt) {
    seen.push(attempt);
    reentrant = f.app.authority.drain();
    (attempt.snapshot.bot.id === "jit" ? firstEntered : secondEntered).resolve();
    await release.promise;
    return { state: "ready", text: "Committed" };
  } });
  const first = f.start({ bots: [{ id: "jit", revision: 1 }], tools: [] }), draining = f.app.authority.drain();
  try {
    await firstEntered.promise;
    expect(reentrant).toBe(draining);
    const second = f.start({ bots: [{ id: "second", revision: 1 }], tools: [] });
    // No second explicit drain is required: the writer's post-commit signal wakes the current one.
    await secondEntered.promise;
    expect(f.app.authority.drain()).toBe(draining);
    expect(reentrant).toBe(draining);
    expect(seen.map(a => a.workId)).toEqual([first.work!.id, second.work!.id]);
    expect(f.app.graph.view(f.auth.actor, first.work!.id).steps[0]).toMatchObject({ state: "running", settledAt: null });
    const excess = f.start({ bots: [{ id: "third", revision: 1 }], tools: [] });
    expect(f.app.graph.view(f.auth.actor, excess.work!.id).steps[0]).toMatchObject({ state: "queued", queueCeiling: "global" });
  } finally { release.resolve(); await draining; }
  expect(seen).toHaveLength(3);
  expect(new Set(seen.map(a => a.id)).size).toBe(3);
});

test.each<QueueCeiling>(["global", "route", "bot", "computer", "work"])("queued projections name the current %s ceiling", async ceiling => {
  const scheduler: SchedulerLimits = { global: 4, route: 4, bot: 4, computer: 4 };
  if (ceiling !== "work") scheduler[ceiling] = 1;
  const f = await fixture(undefined, { scheduler });
  f.store.transaction(tx => {
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM bots WHERE id='second'")!;
    const bot = JSON.parse(row.record_json) as Bot; bot.capabilities.tools.push("computer");
    tx.run("UPDATE bots SET record_json=? WHERE id='second'", canonical(bot));
  });
  const first = f.start({ bots: [{ id: "jit", revision: 1 }], tools: ["computer"] });
  const work = ceiling === "work" ? first : f.start({ bots: [{ id: ceiling === "bot" ? "jit" : "second", revision: 1 }], tools: ["computer"] });
  if (ceiling === "work") {
    // Use a separate immutable grant with its own finite concurrency of one.
    const bounded = f.start({ bots: [{ id: "jit", revision: 1 }], tools: [], limits: { ...first.grant!.limits, concurrency: 1 } });
    const attempt = f.app.authority.admit(bounded.work!.id, rid(), { botId: "jit", tools: [], scopes: [], input: "First", calls: 1, outputBytes: 100 });
    expect(f.app.graph.view(f.auth.actor, bounded.work!.id).steps[0]!.queueCeiling).toBe("work");
    f.app.authority.settle(attempt.id);
    expect(f.app.graph.view(f.auth.actor, bounded.work!.id).steps[0]!.queueCeiling).toBeNull();
    return;
  }
  const attempt = f.app.authority.admit(first.work!.id, rid(), { botId: "jit", tools: ["computer"], scopes: [], input: "Hold capacity", calls: 1, outputBytes: 100 });
  expect(f.app.graph.view(f.auth.actor, work.work!.id).steps[0]!.queueCeiling).toBe(ceiling);
  f.app.authority.settle(attempt.id);
  expect(f.app.graph.view(f.auth.actor, work.work!.id).steps[0]!.queueCeiling).toBeNull();
});

test("queue and dependency phases retain their observed start times when evidence becomes runnable", async () => {
  const entered = barrier(), release = barrier(), synthesisEntered = barrier(), synthesisRelease = barrier();
  const f = await fixture({ async run(a) {
    if (a.step!.handler === "synthesis") { synthesisEntered.resolve(); await synthesisRelease.promise; }
    else { entered.resolve(); await release.promise; }
    return { state: "ready", text: "Committed evidence" };
  } });
  const work = f.start(), installedAt = f.clock.now;
  const initial = f.app.graph.view(f.auth.actor, work.work!.id).steps;
  expect(initial[0]).toMatchObject({ queuedAt: installedAt, waitingAt: null, startedAt: null });
  expect(initial[2]).toMatchObject({ queuedAt: null, waitingAt: installedAt, startedAt: null });
  f.clock.now += 1000;
  const draining = f.app.authority.drain();
  try {
    await entered.promise;
    expect(f.app.graph.view(f.auth.actor, work.work!.id).steps[0]).toMatchObject({ queuedAt: installedAt, startedAt: installedAt + 1000 });
    f.clock.now += 2000; release.resolve(); await synthesisEntered.promise;
    expect(f.app.graph.view(f.auth.actor, work.work!.id).steps[2]).toMatchObject({ queuedAt: installedAt + 3000, waitingAt: installedAt, startedAt: installedAt + 3000 });
  } finally { release.resolve(); synthesisRelease.resolve(); await draining; }
});


test("committed work at an empty drain's completion boundary is not lost", async () => {
  const seen: string[] = [];
  const f = await fixture({ async run(a) { seen.push(a.workId); return { state: "ready", text: "Evidence" }; } });
  const draining = f.app.authority.drain();
  const started = f.start({ bots: [{ id: "jit", revision: 1 }], tools: [] });
  await draining;
  expect(seen).toEqual([started.work!.id]);
  expect(f.app.authority.view(f.auth.actor, started.work!.id).work.state).toBe("ready");
});

test("two non-main research Bots overlap before the main Bot uses a slot, then the main Bot synthesizes", async () => {
  const both = barrier(), release = barrier(), seen: Attempt[] = [];
  const f = await fixture({ async run(attempt) {
    seen.push(attempt);
    if (attempt.step!.handler === "research" && attempt.snapshot.bot.id !== "jit") {
      if (seen.length === 2) both.resolve();
      await release.promise;
    }
    if (attempt.step!.handler === "synthesis") {
      expect(attempt.snapshot.bot.id).toBe("jit");
      expect(attempt.step!.inputs).toHaveLength(3);
    }
    return { state: "ready", text: `Evidence ${attempt.snapshot.bot.id}` };
  } });
  const started = f.start({ bots: [{ id: "jit", revision: 1 }, { id: "second", revision: 1 }, { id: "third", revision: 1 }] });
  const pending = f.app.authority.drain(); await both.promise;
  expect(seen.map(a => a.snapshot.bot.id)).toEqual(["second", "third"]);
  expect(f.app.graph.view(f.auth.actor, started.work!.id).active).toBe(2);
  f.clock.now += 1000; release.resolve(); await pending;
  const steps = f.app.graph.view(f.auth.actor, started.work!.id).steps;
  const peers = steps.filter(s => s.handler === "research" && s.botId !== "jit");
  expect(Math.min(...peers.map(s => s.settledAt!)) - Math.max(...peers.map(s => s.startedAt!))).toBe(1000);
  expect(steps.at(-1)).toMatchObject({ botId: "jit", handler: "synthesis", state: "committed" });
});

test("known Parallel quota blocks queued web lanes without admitting a model; synthesis retains the gap", async () => {
  const seen: Attempt[] = [];
  const f = await fixture({ async run(a) {
    seen.push(a);
    if (a.step!.handler === "research") {
      f.store.transaction(tx => tx.run("INSERT INTO web_reads VALUES (?,?,?)", "quota_read", a.id, canonical({ id: "quota_read", attemptId: a.id, workId: a.workId, mode: "anonymous", settingRevision: 1, outcome: "quota", remoteRequests: 4, finishedAt: f.clock.now, retryAt: f.clock.now + 60000 })));
    } else {
      expect(a.step!.gaps).toMatchObject([{ reason: "parallel_quota" }]);
    }
    return { state: "ready", text: "Partial evidence: Parallel quota" };
  } });
  const started = f.start({ limits: { attempts: 8, steps: 8, calls: 40, outputBytes: 65536, wallMs: 1800000, concurrency: 1, reads: 40 } });
  await f.app.authority.drain();
  expect(seen.map(a => a.step!.handler)).toEqual(["research", "synthesis"]);
  expect(f.app.graph.view(f.auth.actor, started.work!.id).steps[1]).toMatchObject({ state: "blocked", reason: "parallel_quota", attemptId: null, startedAt: null });
});
