import { afterEach, expect, test } from "bun:test";
import { nextScheduledInstant, dueRange } from "../src/jobs/schedules";
import { domainFixture, retryId, routineCommand, type DomainFixture } from "./fixtures/s14-domain";
const fixtures: DomainFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
async function fixture() {
  const f = await domainFixture({ authority: { executor: { async run() { return { state: "ready", text: '{"outcome":"no_update"}' }; } } } });
  fixtures.push(f); return f;
}
test("run-now consumes captured budget once, refuses payload widening and stale/paused/exhausted authority", async () => {
  const f = await fixture(), r = f.app.execute(f.auth.actor, routineCommand(f, { occurrenceBudget: 2 })).routine;
  const command = { kind: "routine.run-now" as const, requestId: retryId(), expectedRevision: r.revision, payload: { routineId: r.id } };
  const receipt = f.app.execute(f.auth.actor, command);
  expect(f.app.execute(f.auth.actor, command)).toEqual(receipt);
  expect(receipt.routine.occurrencesRemaining).toBe(1);
  expect(() => f.app.execute(f.auth.actor, { ...command, requestId: retryId() })).toThrow("stale_revision");
  expect(() => f.app.execute(f.auth.actor, { ...command, requestId: retryId(), expectedRevision: 2, payload: { routineId: r.id, tools: ["computer"] } } as never)).toThrow("invalid_shape");
  expect(() => f.app.execute(f.auth.actor, { ...command, requestId: retryId(), expectedRevision: 2 })).toThrow("routine_running");
  await f.app.authority.drain();
  const work = f.app.authority.list(f.auth.actor)[0]!;
  expect(f.app.authority.view(f.auth.actor, work.id).grant).toMatchObject({ tools: r.capture.command.payload.tools, limits: r.capture.command.payload.limits });
  f.app.execute(f.auth.actor, { ...command, requestId: retryId(), expectedRevision: 2 });
  await f.app.authority.drain();
  expect(f.app.routines.view(f.auth.actor, r.id).history).toHaveLength(2);
  expect(() => f.app.execute(f.auth.actor, { ...command, requestId: retryId(), expectedRevision: 3 })).toThrow("routine_fenced");
});
test("acknowledge is revisioned and replay-safe, cancels queued delivery without resolving underlying work", async () => {
  const f = await fixture();
  f.store.transaction(tx => f.app.attention.commit(tx, { groupId: "ack_group", class: "needs_owner", reason: "routine_failed", workId: null, proposalIds: [] }));
  const n = f.app.attention.view(f.auth.actor).items[0]!;
  const command = { kind: "attention.acknowledge" as const, requestId: retryId(), expectedRevision: n.revision, payload: { noticeId: n.id } };
  const receipt = f.app.execute(f.auth.actor, command);
  expect(f.app.execute(f.auth.actor, command)).toEqual(receipt);
  expect(receipt.notice).toMatchObject({ state: "cancelled", resolvedAt: f.clock.now, retriesRemaining: 0 });
  expect(() => f.app.execute(f.auth.actor, { ...command, requestId: retryId() })).toThrow("stale_revision");
  await f.app.attention.drain();
  expect(f.app.attention.view(f.auth.actor).items[0]!.state).toBe("cancelled");
});
test("weekly captures follow New York wall time through DST and coalesce missed weeks", async () => {
  const f = await fixture();
  f.clock.now = Date.UTC(2026, 9, 25, 12);
  f.auth = f.app.authenticate(await f.app.login("domain-fixture-owner-password"));
  const r = f.app.execute(f.auth.actor, routineCommand(f, { timezone: "America/New_York", recurrence: { kind: "weekly", day: 0, time: "09:00" } })).routine;
  const schedule = { ...r.capture.command.payload, cursor: r.cursor, createdAt: r.createdAt };
  expect(nextScheduledInstant(schedule, f.clock.now)?.utc).toBe(Date.UTC(2026, 9, 25, 13));
  expect(nextScheduledInstant(schedule, Date.UTC(2026, 9, 25, 13))?.utc).toBe(Date.UTC(2026, 10, 1, 14));
  expect(dueRange(schedule, Date.UTC(2026, 10, 8, 14))).toMatchObject({ count: 3, last: Date.UTC(2026, 10, 8, 14) });
  expect(() => f.app.execute(f.auth.actor, routineCommand(f, { recurrence: { kind: "weekly", day: 7, time: "09:00" } }))).toThrow("invalid_number");
});
test("revoked captures free capacity and delete only at exact revoked revision; list history is bounded", async () => {
  const f = await fixture(), r = f.app.execute(f.auth.actor, routineCommand(f)).routine;
  for (let i = 0; i < 130; i++) f.store.transaction(tx => tx.run("INSERT INTO routine_occurrences VALUES (?,?,NULL,?)", `history_${i}`, r.id, JSON.stringify({ id: `history_${i}`, routineId: r.id, state: "complete" })));
  expect(f.app.routines.list(f.auth.actor)[0]!.history).toHaveLength(50);
  expect(() => f.app.routines.view(f.auth.actor, r.id, 1001)).toThrow("invalid_number");
  const remove = { kind: "routine.delete" as const, requestId: retryId(), expectedRevision: 1, payload: { routineId: r.id } };
  expect(() => f.app.execute(f.auth.actor, remove)).toThrow("routine_not_revoked");
  f.app.execute(f.auth.actor, { ...remove, kind: "routine.revoke", requestId: retryId() });
  const receipt = f.app.execute(f.auth.actor, { ...remove, expectedRevision: 2 });
  expect(f.app.execute(f.auth.actor, { ...remove, expectedRevision: 2 })).toEqual(receipt);
  expect(() => f.app.routines.view(f.auth.actor, r.id)).toThrow("not_found");
});
test("discard exact capability proposal does not change Bot or grant authority", async () => {
  const f = await fixture(), bot = f.app.home(f.auth.actor).bots[0]!;
  const proposal = f.app.execute(f.auth.actor, { kind: "bot.capabilities.propose", requestId: retryId(), expectedRevision: bot.revision, payload: { botId: bot.id, capabilities: bot.capabilities } }).proposal!;
  const command = { kind: "bot.capabilities.discard" as const, requestId: retryId(), expectedRevision: proposal.revision, payload: { proposalId: proposal.id, proposalHash: proposal.hash } };
  const receipt = f.app.execute(f.auth.actor, command);
  expect(f.app.execute(f.auth.actor, command)).toEqual(receipt);
  expect(receipt.proposal?.state).toBe("discarded");
  expect(f.app.home(f.auth.actor).bots[0]).toEqual(bot);
  expect(() => f.app.execute(f.auth.actor, { ...command, kind: "bot.capabilities.accept", requestId: retryId() })).toThrow("stale_capability_proposal");
});

test("real routine reports obey attention.set while failures escalate filtered groups", async () => {
  const f = await fixture(), r = f.app.execute(f.auth.actor, routineCommand(f)).routine;
  // Exercise the production settlement projection with committed report outcomes.
  const notify = (outcome: "report" | "failed", group: string) => f.store.transaction(tx => {
    const occurrence = { id: group, routineId: r.id, outcome, state: outcome === "failed" ? "failed" : "complete", proposals: [], workId: null };
    (f.app.routines as unknown as { notify(tx: unknown, o: unknown): void }).notify(tx, occurrence);
  });
  notify("report", "filtered_report");
  expect(f.app.attention.view(f.auth.actor).items).toHaveLength(0);
  const set = { kind: "attention.set" as const, requestId: retryId(), expectedRevision: 0, payload: { level: "all" as const } };
  const receipt = f.app.execute(f.auth.actor, set);
  expect(f.app.execute(f.auth.actor, set)).toEqual(receipt);
  expect(() => f.app.execute(f.auth.actor, { ...set, requestId: retryId() })).toThrow("stale_revision");
  notify("report", "new_report"); notify("failed", "filtered_report");
  expect(f.app.attention.view(f.auth.actor).items).toHaveLength(2);
});

test("Bot fencing preserves exhausted state and its concrete reason through reconciliation", async () => {
  const f = await fixture(), r = f.app.execute(f.auth.actor, routineCommand(f, { occurrenceBudget: 1 })).routine;
  f.app.execute(f.auth.actor, { kind: "routine.run-now", requestId: retryId(), expectedRevision: 1, payload: { routineId: r.id } });
  await f.app.authority.drain();
  f.store.transaction(tx => { f.app.routines.fenceBot(tx, "jit"); f.app.routines.reconcile(tx); });
  expect(f.app.routines.view(f.auth.actor, r.id).routine).toMatchObject({ state: "exhausted", reason: "bot_authority_changed" });
});
