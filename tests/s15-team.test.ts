import { afterEach, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createTeamResourceTools, TeamService, type TeamContext, type TeamLease } from "../src/s15/team";
import { teamMemoryFixture } from "./fixtures/s15-team-memory";
import { ref } from "./fixtures/s15-policy";

const fixtures: ReturnType<typeof teamMemoryFixture>[] = [];
const fixture = () => { const f = teamMemoryFixture(); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0).reverse()) f.cleanup(); });

test("two independent Bots use the same team account without another resource grant, and retain partial evidence", async () => {
  const f = fixture(), a = f.context(), b = f.context("bot2"), entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  let reads = 0;
  const read = async (context: TeamContext) => { f.team.resource(context, "account"); reads++; if (reads === 2) entered.resolve(); await finish.promise; f.team.resource(context, "account"); return f.team.capture(context, { ...f.source(`Observed account evidence ${reads}.`), resources: [ref("account")] }); };
  const one = read(a), two = read(b); await entered.promise; expect(reads).toBe(2); finish.resolve();
  const [first, second] = await Promise.all([one, two]);
  expect(first.producer.bot.id).toBe("bot"); expect(second.producer.bot.id).toBe("bot2");
  let delivered = ""; f.team.handoff(a, b, [first.id], sources => { delivered = sources[0]!.text; }); expect(delivered).toContain("Observed account evidence");
  expect(f.team.result(a, [{ botId: "bot", sourceId: first.id }, { botId: "bot2", sourceId: second.id }, { botId: "bot3", sourceId: null }])).toMatchObject({ state: "partial", gaps: [{ botId: "bot3" }] });
  expect(f.team.resources(f.f.owner).resources.find(r => r.id === "account")).toMatchObject({ whoCanUse: "enabled_team", restrictions: expect.arrayContaining(["mediated_credentials"]) });
});

test("explicit narrower Bot/resource restrictions and S14-private ancestry deny before handoff bytes", () => {
  const f = fixture(), a = f.context(), b = f.context("bot2");
  const privateSource = f.team.capture(a, { ...f.source("Private original."), scope: { kind: "bot", botId: "bot", origin: "s14" }, resources: [ref("private")] });
  const descendant = f.team.capture(a, { ...f.source("Uncited derived result."), parents: [privateSource.id] });
  let bytes = 0; expect(() => f.team.handoff(a, b, [descendant.id], () => bytes++)).toThrow("lineage_withdrawn"); expect(bytes).toBe(0);
  expect(() => f.team.resource(b, "private")).toThrow("outside_scope");
  expect(() => f.team.register(f.f.owner, "promote", 1, f.registration("private", { revision: 2 }))).toThrow("private_promotion_requires_migration");
  f.team.register(f.f.owner, "narrow", 1, f.registration("account", { revision: 2, deniedBots: ["bot2"] }));
  f.f.input.resources = f.f.input.resources.map(r => r.id === "account" ? { ...r, revision: 2 } : r); f.f.catalog.get("resource:account")!.ref.revision = 2; f.f.input.rules.forEach(rule => { rule.resources = rule.resources.map(r => r.id === "account" ? { ...r, revision: 2 } : r); }); f.f.install();
  const denied = f.context("bot2"); expect(() => f.team.resource(denied, "account")).toThrow("outside_scope");
});

test("revocation during awaited handoff preparation fences receiver publication without deleting a valid sibling", async () => {
  const f = fixture(), a = f.context(), b = f.context("bot2");
  const first = f.team.capture(a, f.source("First evidence.")), second = f.team.capture(a, f.source("Independent evidence."));
  const barrier = Promise.withResolvers<void>(); let bytes = 0;
  const delivery = (async () => { await barrier.promise; f.team.handoff(a, b, [first.id], () => bytes++); })();
  f.team.withdraw(f.f.owner, first.id); barrier.resolve(); await expect(delivery).rejects.toThrow("lineage_withdrawn");
  expect(bytes).toBe(0); expect(f.team.source(b, second.id).text).toBe("Independent evidence.");
  f.f.service.owner.revoke(f.f.owner, "stop_receiver", { kind: "work", id: f.team.guard(b).id });
  expect(() => f.team.handoff(a, b, [second.id], () => bytes++)).toThrow("authority_revoked"); expect(bytes).toBe(0);
});

test("conflicting file aliases and browser input serialize, while disjoint work overlaps", async () => {
  const f = fixture(), a = f.context(), b = f.context("bot2"), barrier = Promise.withResolvers<void>();
  const lease = f.team.acquire(a, ["repo"], "write", 1000), fence = f.team.guardLease(lease)[0]!.fence;
  const writing = f.team.dispatch(lease, async () => { await barrier.promise; writeFileSync(join(f.f.dir, "result.txt"), "one"); return { value: "one", settled: true }; });
  expect(() => f.team.acquire(b, ["alias"], "write", 1000)).toThrow("resource_busy");
  const browser = f.team.acquire(b, ["browser"], "input", 1000);
  expect(() => f.team.acquire(a, ["browser"], "input", 1000)).toThrow("resource_busy");
  f.team.release(browser); barrier.resolve(); expect(await writing).toBe("one");
  const later = f.team.acquire(b, ["alias"], "write", 1000); expect(f.team.guardLease(later)[0]!.fence).toBeGreaterThan(fence);
  await expect(f.team.dispatch(lease, async () => ({ value: "stale", settled: true }))).rejects.toThrow("stale_lease");
  await f.team.dispatch(later, async () => { writeFileSync(join(f.f.dir, "result.txt"), "two"); return { value: "two", settled: true }; });
  expect(readFileSync(join(f.f.dir, "result.txt"), "utf8")).toBe("two");
});

test("expiry, stop and restart retain unsettled capacity; protected verified settlement permits a newer fence", async () => {
  const f = fixture(), a = f.context(), lease = f.team.acquire(a, ["repo"], "write", 10), barrier = Promise.withResolvers<void>();
  const writing = f.team.dispatch(lease, async () => { await barrier.promise; return { value: "late", settled: false }; });
  f.f.now += 100; expect(() => f.team.acquire(f.context("bot2"), ["repo"], "write", 10)).toThrow("resource_busy");
  barrier.resolve(); await expect(writing).rejects.toThrow("settlement_pending");
  const leaseId = f.team.store.db.query<{ id: string }, []>("SELECT id FROM leases WHERE state='unknown'").get()!.id;
  f.reopen(); expect(() => f.team.guard(a)).toThrow("authentication_required");
  expect(() => f.team.acquire(f.context("bot2"), ["repo"], "write", 10)).toThrow("resource_busy");
  expect(() => f.team.reconcileSettled(leaseId, () => false)).toThrow("settlement_pending");
  f.team.reconcileSettled(leaseId, () => true); const next = f.team.acquire(f.context("bot2"), ["repo"], "write", 10); f.team.release(next);
});

test("multi-resource acquisition is atomic and forged handles cannot dispatch", () => {
  const f = fixture(), a = f.context(), b = f.context("bot2"), held = f.team.acquire(a, ["repo"], "write", 1000);
  expect(() => f.team.acquire(b, ["browser", "repo"], "write", 1000)).toThrow("resource_busy");
  const disjoint = f.team.acquire(b, ["browser"], "input", 1000); f.team.release(disjoint); f.team.release(held);
  expect(() => f.team.guard({} as TeamContext)).toThrow("authentication_required"); expect(() => f.team.guardLease({} as TeamLease)).toThrow("stale_lease");
});

test("team tool composition uses a mediated broker and rechecks revocation after a wait", async () => {
  const f = fixture(), context = f.context(), actor = f.actors.get(context)!, entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>();
  const port = createTeamResourceTools(f.team, { async open(_work: typeof actor, input) { return { tools: [{ access: "read", definition: { name: "account_read", execution: "exclusive", description: "Mediated account read", inputSchema: { type: "object" }, async execute() { entered.resolve(); await finish.promise; input.guard(); return { content: "mediated observed bytes" }; } } }], async cancel() {}, async close() {} }; } }, { actor: work => work, bindings: [{ name: "account_read", resources: ["account"], mode: "read", settled: () => true }], leaseMs: 1000 });
  const session = await port.open(actor, { mode: "inspect", signal: new AbortController().signal, guard() {} });
  const result = session.tools[0]!.definition.execute({}, { workspace: {} as never, signal: new AbortController().signal }); await entered.promise;
  f.f.service.owner.revoke(f.f.owner, "stop", { kind: "work", id: f.team.guard(context).id }); finish.resolve();
  await expect(result).rejects.toThrow("authority_revoked"); await session.close();
  expect(JSON.stringify(f.team.resources(f.f.owner))).not.toContain("credential=");
});

test("TEAM refuses foreign/S14 stores without changing their bytes and excludes credential source content", () => {
  const f = fixture(), path = join(f.f.dir, "old.sqlite"); writeFileSync(path, "preserved S14 bytes"); const bytes = readFileSync(path);
  expect(() => new TeamService({ ...f.options, path, create: true })).toThrow("s15_data_store_incompatible"); expect(readFileSync(path)).toEqual(bytes);
  expect(() => f.team.capture(f.context(), f.source("password=example-secret-value"))).toThrow("credential_content_refused");
  expect(() => new TeamService({ ...f.options, create: false })).toThrow("s15_data_runtime_already_open");
});

test("P1: repository-only work opens only its available tools with unrelated browser bindings configured", async () => {
  const f = fixture(), context = f.context("bot", { resources: [ref("repo")], intent: "inspect", access: "read" }), actor = f.actors.get(context)!;
  let opens = 0, reads = 0;
  const port = createTeamResourceTools(f.team, { async open(_work: typeof actor, input) {
    opens++; input.guard();
    return { tools: [{ access: "read", definition: { name: "repo_read", description: "Read scoped repository", inputSchema: { type: "object" }, execution: "exclusive", async execute() { input.guard(); reads++; return { content: "repository evidence" }; } } }], async cancel() {}, async close() {} };
  } }, { actor: work => work, bindings: [
    { name: "repo_read", resources: ["repo"], mode: "read", settled: () => true },
    { name: "browser_input", resources: ["browser"], mode: "input", settled: () => true },
  ], leaseMs: 1000 });
  const session = await port.open(actor, { mode: "inspect", signal: new AbortController().signal, guard() {} });
  expect(opens).toBe(1); expect(session.tools.map(tool => tool.definition.name)).toEqual(["repo_read"]);
  const call = { workspace: {} as never, signal: new AbortController().signal };
  expect(await session.tools[0]!.definition.execute({}, call)).toEqual({ content: "repository evidence" });
  f.team.register(f.f.owner, "narrow_repo_after_open", 1, f.registration("repo", { revision: 2, deniedBots: ["bot"] }));
  await expect(session.tools[0]!.definition.execute({}, call)).rejects.toThrow("outside_scope");
  expect(reads).toBe(1); await session.close();
});
