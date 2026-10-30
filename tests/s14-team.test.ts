import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S14Application, type S14Options } from "../src/s14/application";
import { S14Store } from "../src/s14/store";
import type { Attempt, AuthorityOptions, StartPayload, WorkExecutor } from "../src/s14/authority-types";
import type { StepProposal, WorkGraph } from "../src/s14/graph-types";
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
