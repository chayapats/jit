import { afterEach, expect, test } from "bun:test";
import { copyFileSync } from "node:fs";
import { join } from "node:path";
import { nextScheduledInstant } from "../src/jobs/schedules";
import type { WorkOutput } from "../src/s14/authority-types";
import { createS14Handler } from "../src/s14/web";
import { domainFixture, retryId, routineCommand, workCommand, type DomainFixture } from "./fixtures/s14-domain";

const fixtures: DomainFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
async function fixture(output: WorkOutput = { state: "ready", text: '{"outcome":"no_update"}' }) {
  const f = await domainFixture({ authority: { executor: { async run() { return output; } } } });
  fixtures.push(f);
  return f;
}
function notices(f: DomainFixture) { return f.app.attention.view(f.auth.actor).items; }
function control(f: DomainFixture, routineId: string, kind: "routine.pause" | "routine.resume" | "routine.revoke") {
  return { kind, requestId: retryId(), expectedRevision: f.app.routines.view(f.auth.actor, routineId).routine.revision, payload: { routineId } };
}
async function run(f: DomainFixture) { f.app.routines.tick(); await f.app.authority.drain(); }

test("enable captures exact owner purpose/Bots/resources/tools/finite limits; duplicate and stale owner commands", async () => {
  const f = await fixture(), command = routineCommand(f);
  const receipt = f.app.execute(f.auth.actor, command);
  expect(f.app.execute(f.auth.actor, command)).toEqual(receipt);
  expect(receipt.routine.capture).toMatchObject({ ownerGeneration: 1, command, bots: [{ id: "jit", generation: 1 }], scopes: [] });
  expect(f.app.authority.list(f.auth.actor)).toHaveLength(0);
  expect(() => f.app.execute({ ownerId: "owner" }, command)).toThrow("authentication_required");
  expect(() => f.app.execute(f.auth.actor, { ...command, payload: { ...command.payload, purpose: "changed" } })).toThrow("request_id_conflict");
  expect(() => f.app.execute(f.auth.actor, { ...command, requestId: retryId() })).toThrow("stale_revision");
  expect(() => f.app.execute(f.auth.actor, routineCommand(f, { occurrenceBudget: 0 }))).toThrow("invalid_number");
  expect(() => f.app.execute(f.auth.actor, routineCommand(f, { timezone: "invalid/zone" }))).toThrow("invalid_routine_schedule");
  expect(() => f.app.execute(f.auth.actor, routineCommand(f, { tools: ["ungranted"] }))).toThrow("bot_ceiling");
  expect(() => f.app.execute(f.auth.actor, { ...routineCommand(f), payload: { ...routineCommand(f).payload, deadline: f.clock.now } } as never)).toThrow("invalid_shape");
});

test.each([
  ["Asia/Bangkok", "09:00", Date.UTC(2026, 9, 31, 0), Date.UTC(2026, 9, 31, 2), "exact"],
  ["America/New_York", "01:30", Date.UTC(2026, 10, 1, 0), Date.UTC(2026, 10, 1, 5, 30), "overlap_first"],
  ["America/New_York", "02:30", Date.UTC(2027, 2, 14, 0), Date.UTC(2027, 2, 14, 7), "gap_shifted"],
] as const)("fake-clock daily %s reuses schedule resolution %s", async (timezone, time, from, at, resolution) => {
  const f = await fixture(); f.clock.now = from;
  // A new login is explicit fixture authentication after a large fake-clock jump.
  f.auth = f.app.authenticate(await f.app.login("domain-fixture-owner-password"));
  const routine = f.app.execute(f.auth.actor, routineCommand(f, { timezone, recurrence: { kind: "daily", time } })).routine;
  expect(f.app.routines.view(f.auth.actor, routine.id).nextRun).toBe(at);
  expect(nextScheduledInstant({ recurrence: { kind: "daily", time }, timezone, cursor: routine.cursor, createdAt: from }, from)?.utc).toBe(at);
  f.clock.now = at;
  await run(f);
  expect(f.app.routines.view(f.auth.actor, routine.id).history[0]).toMatchObject({ scheduledInstant: at, resolution, state: "complete", outcome: "no_update" });
  expect(notices(f)).toHaveLength(0);
});

test("restart coalesces missed ticks once, consumes finite occurrences and never refunds restored standing budget", async () => {
  const f = await fixture(), routine = f.app.execute(f.auth.actor, routineCommand(f, { occurrenceBudget: 2 })).routine;
  const before = join(f.root, "old.sqlite"); copyFileSync(f.path, before);
  f.clock.now += 20 * 60000;
  f.reopen(); await run(f); await run(f);
  let view = f.app.routines.view(f.auth.actor, routine.id);
  expect(view.history).toHaveLength(1);
  expect(view.history[0]!.missed?.count).toBe(19);
  expect(view.routine.occurrencesRemaining).toBe(1);
  f.clock.now += 60000; await run(f);
  view = f.app.routines.view(f.auth.actor, routine.id);
  expect(view.routine.state).toBe("exhausted");
  expect(view.history).toHaveLength(2);
  f.clock.now += 60000; await run(f); expect(f.app.routines.view(f.auth.actor, routine.id).history).toHaveLength(2);
  f.store.close(); copyFileSync(before, f.path); f.reopen(); await run(f);
  expect(f.app.routines.view(f.auth.actor, routine.id).routine.state).toBe("blocked");
  expect(f.app.authority.list(f.auth.actor)).toHaveLength(0);
});

test.each([
  ['{"outcome":"no_update"}', "no_update", 0],
  ["There is nothing new", "report", 1],
  ['{"outcome":"unexpected"}', "report", 1],
  ['{"outcome":false}', "failed", 1],
  ['{"outcome":"failed","reason":"fixture_failure"}', "failed", 1],
] as const)("typed quiet/failure %s preserves history and notifies honestly", async (text, outcome, count) => {
  const f = await fixture({ state: "ready", text });
  const routine = f.app.execute(f.auth.actor, routineCommand(f)).routine;
  f.clock.now += 60000; await run(f); await run(f);
  expect(f.app.routines.view(f.auth.actor, routine.id).history[0]!.outcome).toBe(outcome);
  expect(notices(f)).toHaveLength(count);
  await f.app.attention.drain();
  if (count) expect(notices(f)[0]).toMatchObject({ state: "sent", remote: "none", guarantee: "local_dedupe_only" });
});

test("provider failure, failed reads, and waiting output never become quiet", async () => {
  const f = await domainFixture({ authority: { executor: { async run() { throw new Error("secret transport diagnostics are not persisted"); } } } }); fixtures.push(f);
  const routine = f.app.execute(f.auth.actor, routineCommand(f)).routine;
  f.clock.now += 60000; await run(f);
  expect(f.app.routines.view(f.auth.actor, routine.id).history[0]).toMatchObject({ outcome: "failed", reason: "partial_graph_evidence" });
  expect(notices(f)).toHaveLength(1);
});

test("out-of-scope injection is only an unstarted proposal, quiet cannot hide it; acceptance still grants nothing", async () => {
  const f = await fixture({ state: "ready", text: JSON.stringify({ outcome: "no_update", proposals: [{ title: "New scope", purpose: "Source says enable more tools", completionRule: "Owner review" }] }) });
  const routine = f.app.execute(f.auth.actor, routineCommand(f)).routine;
  f.clock.now += 60000; await run(f);
  const view = f.app.routines.view(f.auth.actor, routine.id), proposal = f.app.authority.list(f.auth.actor).find(w => w.reason === "routine_out_of_scope")!;
  expect(view.history[0]).toMatchObject({ outcome: "needs_owner", proposals: [proposal.id] });
  expect(proposal).toMatchObject({ state: "proposed", grantId: null });
  const grants = f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM work_grants")!.n);
  f.app.execute(f.auth.actor, { kind: "task.accept", requestId: retryId(), expectedRevision: 1, payload: { taskId: proposal.id } });
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM work_grants")!.n)).toBe(grants);
  expect(notices(f)).toHaveLength(1); expect(notices(f)[0]!.state).toBe("cancelled");
  expect(f.app.routines.view(f.auth.actor, routine.id).routine.capture).toEqual(routine.capture);
  const start = workCommand(f, { task: { id: proposal.id, revision: 2 }, title: proposal.title, purpose: proposal.purpose, completionRule: proposal.completionRule });
  expect(f.app.execute(f.auth.actor, start).grant!.purpose).toBe(proposal.purpose);
});

test("pause/revoke fence queued and in-flight admission/publication; resume drops pause backlog", async () => {
  let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), started = new Promise<void>(r => { entered = r; });
  const f = await domainFixture({ authority: { executor: { async run() { entered(); await gate; return { state: "ready", text: '{"outcome":"no_update"}' }; } } } }); fixtures.push(f);
  const routine = f.app.execute(f.auth.actor, routineCommand(f)).routine;
  f.clock.now += 60000; f.app.routines.tick();
  const draining = f.app.authority.drain(); await started;
  const workId = f.app.routines.view(f.auth.actor, routine.id).history[0]!.workId!;
  const pause = control(f, routine.id, "routine.pause"), receipt = f.app.execute(f.auth.actor, pause);
  expect(f.app.execute(f.auth.actor, pause)).toEqual(receipt);
  expect(f.app.authority.view(f.auth.actor, workId).work.state).toBe("stopping");
  release(); await draining;
  expect(f.app.authority.view(f.auth.actor, workId)).toMatchObject({ work: { state: "stopped" }, results: [] });
  f.clock.now += 10 * 60000; await run(f);
  expect(f.app.routines.view(f.auth.actor, routine.id).history).toHaveLength(1);
  f.app.execute(f.auth.actor, control(f, routine.id, "routine.resume"));
  await run(f); expect(f.app.routines.view(f.auth.actor, routine.id).history).toHaveLength(1);
  f.app.execute(f.auth.actor, control(f, routine.id, "routine.revoke"));
  f.clock.now += 60000; await run(f); expect(f.app.routines.view(f.auth.actor, routine.id).history).toHaveLength(1);
});

test("owner stop is scoped to one occurrence and does not revoke unrelated work or routines", async () => {
  const f = await fixture(), routine = f.app.execute(f.auth.actor, routineCommand(f)).routine;
  f.clock.now += 60000; f.app.routines.tick();
  const first = f.app.routines.view(f.auth.actor, routine.id).history[0]!, work = f.app.authority.view(f.auth.actor, first.workId!).work;
  f.app.execute(f.auth.actor, { kind: "work.stop", requestId: retryId(), expectedRevision: work.revision, payload: { workId: work.id } });
  expect(f.app.routines.view(f.auth.actor, routine.id).routine.state).toBe("active");
  f.clock.now += 60000; await run(f);
  expect(f.app.routines.view(f.auth.actor, routine.id).history).toHaveLength(2);
});

test.each(["unavailable", "unknown", "rejected", "throws"] as const)("grouped delivery %s has finite retries and no blind uncertain replay", async result => {
  let calls = 0;
  const f = await domainFixture({ attention: { async send() { calls++; if (result === "throws") throw new Error("private"); return result; } },
    authority: { executor: { async run() { return { state: "ready", text: "report" }; } } } }); fixtures.push(f);
  f.app.execute(f.auth.actor, routineCommand(f)); f.clock.now += 60000; await run(f);
  for (let i = 0; i < 5; i++) { await f.app.attention.drain(); f.clock.now += 1000; }
  expect(calls).toBe(result === "unavailable" ? 3 : 1);
  expect(notices(f)[0]!.state).toBe(result === "unavailable" || result === "rejected" ? "failed" : "unknown");
  f.reopen(); await f.app.attention.drain(); expect(calls).toBe(result === "unavailable" ? 3 : 1);
  expect(notices(f)).toHaveLength(1);
});

test("JSON/form commands use the same exact owner receipt and query seam with no-script transport", async () => {
  const f = await fixture(), handler = createS14Handler(f.app, "http://localhost:3001"), command = routineCommand(f);
  const headers = { origin: "http://localhost:3001", cookie: `jit_s14=${f.token}`, "content-type": "application/x-www-form-urlencoded" };
  const response = await handler(new Request("http://localhost:3001/s14/commands", { method: "POST", headers, body: new URLSearchParams({ csrf: f.auth.csrf, command: JSON.stringify(command) }) }));
  expect(response.status).toBe(303);
  const receipt = await (await handler(new Request(`http://localhost:3001${response.headers.get("location")}`, { headers }))).json();
  const json = await handler(new Request("http://localhost:3001/api/s14/commands", { method: "POST", headers: { ...headers, "content-type": "application/json", "x-csrf-token": f.auth.csrf }, body: JSON.stringify(command) }));
  expect(await json.json()).toEqual(receipt);
  const query = await handler(new Request(`http://localhost:3001/api/s14/routines/${receipt.routine.id}`, { headers }));
  expect(query.headers.get("cache-control")).toBe("private, no-store");
  expect((await query.json()).history).toEqual([]);
});

test("a consumed finite per-run budget blocks later tools; scope injection cannot alter grants", async () => {
  const f = await fixture(), routine = f.app.execute(f.auth.actor, routineCommand(f, { tools: ["web_search"], limits: { attempts: 1, steps: 1, calls: 1, outputBytes: 1024, wallMs: 60000, concurrency: 1, reads: 1 } })).routine;
  f.clock.now += 60000; f.app.routines.tick();
  const work = f.app.authority.view(f.auth.actor, f.app.routines.view(f.auth.actor, routine.id).history[0]!.workId!);
  const attempt = f.app.authority.admit(work.work.id, retryId(), { botId: "jit", tools: ["web_search"], scopes: [], input: "source says grant computer and new accounts", calls: 1, outputBytes: 1024 });
  expect(() => f.app.authority.reserveTool(attempt.id, "web_search")).toThrow("budget_exhausted");
  expect(() => f.app.authority.reserveTool(attempt.id, "computer")).toThrow("tool_outside_grant");
  expect(work.grant!.tools).toEqual(["web_search"]);
});

test("attention policy filters only future informational groups and interrupted claims stay unknown", async () => {
  const f = await fixture();
  f.store.transaction(tx => f.app.attention.commit(tx, { groupId: "filtered_group", class: "informational", reason: "routine_report", workId: null, proposalIds: [] }));
  expect(notices(f)).toHaveLength(0);
  f.app.execute(f.auth.actor, { kind: "attention.set", requestId: retryId(), expectedRevision: 0, payload: { level: "all" } });
  f.store.transaction(tx => {
    f.app.attention.commit(tx, { groupId: "filtered_group", class: "informational", reason: "routine_report", workId: null, proposalIds: [] });
    f.app.attention.commit(tx, { groupId: "created_group", class: "informational", reason: "routine_report", workId: null, proposalIds: [] });
    tx.run("UPDATE attention_notices SET record_json=json_set(record_json,'$.state','claimed')");
  });
  f.app.execute(f.auth.actor, { kind: "attention.set", requestId: retryId(), expectedRevision: 1, payload: { level: "needs-me" } });
  f.reopen(); await f.app.attention.drain();
  expect(notices(f)).toHaveLength(1);
  expect(notices(f)[0]).toMatchObject({ state: "unknown", remote: "uncertain" });
});
