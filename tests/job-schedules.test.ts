import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";
import { JobQueue } from "../src/jobs/queue";
import {
  dueRange, nextDailyInstant, scheduleReminderWork, scheduleSummaryWork, scheduleRunRoleId,
  tickSchedules, validTimezone, wallToUtc,
  type JobSchedule, type ScheduleCommand, type ScheduleRecurrence,
} from "../src/jobs/schedules";
import { fixtureOutcome, ScriptedRunPort } from "../src/team/scripted-port";
import type { JobLimits } from "../src/jobs/types";

const password = "fixture-schedule-owner-password", epoch = 1_800_000_000_000;
const roots: string[] = [], stores: TransactionStore[] = [], queues: JobQueue[] = [];
afterEach(async () => {
  for (const queue of queues.splice(0)) { queue.close(); await queue.idle(); }
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
class Clock {
  now = epoch;
}
const limits: JobLimits = { roles: 4, calls: 4, rounds: 4, hops: 4, contextTokens: 10, outputTokens: 10, retries: 2, wallMs: 60_000 };
const grok = { provider: "grok" as const, model: "fixture-grok-exact", authRoute: "owner-grok" };

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jit-job03-")); roots.push(root);
  const path = join(root, "app.sqlite"), config = readConfig({ JIT_DATABASE: path }), store = new TransactionStore(path); stores.push(store);
  const clock = new Clock();
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes,
    request => fixtureOutcome("complete", `สรุปจำลอง · ${request.purpose}`));
  const queue = new JobQueue(store, config.jobs,
    [scheduleReminderWork(store, config, () => clock.now), scheduleSummaryWork(store, config, port, () => clock.now)],
    { now: () => clock.now }); queues.push(queue);
  const app = new Application(store, config, { jobs: queue, now: () => clock.now });
  await app.setupOwner(password); const token = await app.login(password), auth = app.authenticate(token);
  const project = app.execute(auth.actor, { kind: "project.create", requestId: crypto.randomUUID(), projectId: null, expectedRevision: 0, payload: { name: "โครงการตาราง 🧪" } }).project;
  const topic = app.execute(auth.actor, { kind: "topic.create", requestId: crypto.randomUUID(), projectId: project.id, expectedRevision: project.revision, payload: { title: "หัวข้อเตือน 🧪" } }).topic;
  return { root, path, config, store, clock, port, queue, app, token, auth, project: { ...project, revision: project.revision + 1 }, topic, web: createWebHandler(app) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type CreateCmd = Extract<ScheduleCommand, { kind: "schedule.create" }>;
function reminder(f: Fixture, patch: Partial<CreateCmd["payload"]> = {}): CreateCmd {
  return { kind: "schedule.create", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: f.project.revision,
    payload: { topicId: f.topic.id, kind: "reminder", purpose: "เตือนทบทวนงาน 🧪", timezone: "Asia/Bangkok",
      recurrence: { kind: "daily", time: "08:00" }, enabled: true, route: null, limits: structuredClone(limits),
      occurrenceBudget: 30, misfire: "coalesce", text: "ทบทวนงานค้างของคุณ", ...patch } };
}
function summary(f: Fixture, patch: Partial<CreateCmd["payload"]> = {}): CreateCmd {
  const base = reminder(f, { kind: "summary", purpose: "สรุปงานประจำวัน 🧪", route: structuredClone(grok), text: "สรุปงานที่ค้างให้เจ้าของ" });
  return { ...base, payload: { ...base.payload, ...patch } };
}
async function drain(f: Fixture) {
  for (let i = 0; i < 400; i++) {
    f.queue.pump(); tickSchedules(f.store, f.queue, f.config, f.clock.now);
    const pending = f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state IN ('queued', 'admitted')")!.n);
    if (pending === 0) { await f.queue.idle(); return; }
    await f.queue.idle(); await new Promise(resolve => setTimeout(resolve, 2));
  }
  throw new Error("queue did not drain");
}
async function reopen(f: Fixture) {
  f.queue.close(); await f.queue.idle(); queues.splice(queues.indexOf(f.queue), 1);
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const store = new TransactionStore(f.path); stores.push(store);
  const port = new ScriptedRunPort(store, f.config.team, f.config.jobs.outputBytes,
    request => fixtureOutcome("complete", `สรุปจำลอง · ${request.purpose}`));
  const queue = new JobQueue(store, f.config.jobs,
    [scheduleReminderWork(store, f.config, () => f.clock.now), scheduleSummaryWork(store, f.config, port, () => f.clock.now)],
    { now: () => f.clock.now }); queues.push(queue);
  const app = new Application(store, f.config, { jobs: queue, now: () => f.clock.now });
  f.token = await app.login(password);
  return { ...f, store, port, queue, app, auth: app.authenticate(f.token), web: createWebHandler(app) };
}
function request(f: Fixture, path: string, body?: Record<string, unknown>) {
  return new Request(`http://localhost:3000${path}`, { method: body ? "POST" : "GET", headers: { cookie: `jit_session=${f.token}`,
    ...(body ? { origin: "http://localhost:3000", "content-type": "application/json", "x-csrf-token": f.auth.csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
const readSchedule = (f: Fixture, id: string): JobSchedule =>
  f.store.read(tx => JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM job_schedules WHERE id = ?", id)!.record_json) as JobSchedule);

test("pure timezone math: validation rejects non-IANA zones and never consults host-local time", () => {
  expect(validTimezone("Asia/Bangkok")).toBe(true);
  expect(validTimezone("America/New_York")).toBe(true);
  expect(validTimezone("Nope/Zone")).toBe(false);
  expect(validTimezone("")).toBe(false);
  expect(validTimezone(null)).toBe(false);
  expect(validTimezone("x".repeat(200))).toBe(false);
});

test("pure wall-clock math: DST gap shifts forward, overlap takes the first instant", () => {
  // 2026-03-08 clocks jump 02:00 -> 03:00 in America/New_York; 02:30 never occurs.
  const gap = wallToUtc("America/New_York", 2026, 3, 8, 2, 30);
  expect(gap).toEqual({ utc: Date.UTC(2026, 2, 8, 7, 0), resolution: "gap_shifted" });
  // 2026-11-01 clocks fall back; 01:30 occurs twice. First is EDT (UTC-4) at 05:30Z.
  const overlap = wallToUtc("America/New_York", 2026, 11, 1, 1, 30);
  expect(overlap).toEqual({ utc: Date.UTC(2026, 10, 1, 5, 30), resolution: "overlap_first" });
  const exact = wallToUtc("Asia/Bangkok", 2026, 5, 4, 8, 0);
  expect(exact).toEqual({ utc: Date.UTC(2026, 4, 4, 1, 0), resolution: "exact" });
  // Next daily instant is strictly after the anchor, even across the transition.
  expect(nextDailyInstant("America/New_York", "02:30", Date.UTC(2026, 2, 7, 12, 0)).utc).toBe(Date.UTC(2026, 2, 8, 7, 0));
  expect(nextDailyInstant("America/New_York", "02:30", Date.UTC(2026, 2, 8, 7, 0)).utc).toBe(Date.UTC(2026, 2, 9, 6, 30));
});

test("pure due-range math: long downtime coalesces without enumerating every miss", () => {
  const schedule = { recurrence: { kind: "interval", everyMs: 3_600_000 } as ScheduleRecurrence, timezone: "Asia/Bangkok", cursor: { lastInstant: epoch, lastRevision: 1 }, createdAt: epoch };
  const due = dueRange(schedule, epoch + 10 * 3_600_000)!;
  expect(due).toMatchObject({ first: epoch + 3_600_000, last: epoch + 10 * 3_600_000, count: 10 });
  expect(dueRange(schedule, epoch + 3_599_999)).toBeNull();
  const once = { recurrence: { kind: "once", at: epoch + 5_000 } as ScheduleRecurrence, timezone: "Asia/Bangkok", cursor: { lastInstant: null, lastRevision: null }, createdAt: epoch };
  expect(dueRange(once, epoch + 4_999)).toBeNull();
  expect(dueRange(once, epoch + 5_000)).toMatchObject({ first: epoch + 5_000, last: epoch + 5_000, count: 1 });
  expect(dueRange({ ...once, cursor: { lastInstant: epoch + 5_000, lastRevision: 1 } }, epoch + 9_000)).toBeNull();
});

test("create validates, exposes next run, records the contract and dedupes receipts", async () => {
  const f = await fixture();
  const cmd = reminder(f);
  const receipt = f.app.execute(f.auth.actor, cmd);
  expect(receipt.schedule).toMatchObject({ projectId: f.project.id, topicId: f.topic.id, kind: "reminder", state: "active",
    contract: "jobs.configured_schedules/v1", occurrencesRemaining: 30, cursor: { lastInstant: null, lastRevision: null } });
  expect(receipt.schedule.nextRun).toBeGreaterThan(f.clock.now);
  expect(f.app.execute(f.auth.actor, cmd)).toEqual(receipt);
  expect(() => f.app.execute(f.auth.actor, { ...cmd, payload: { ...cmd.payload, purpose: "อื่น" } })).toThrow("request_id_conflict");
  expect(() => f.app.execute(f.auth.actor, { ...reminder(f), expectedRevision: 999 })).toThrow("stale_revision");
  expect(() => f.app.execute(f.auth.actor, reminder(f, { timezone: "Mars/Olympus" }))).toThrow("invalid_schedule_timezone");
  expect(() => f.app.execute(f.auth.actor, reminder(f, { recurrence: { kind: "weekly" } as never }))).toThrow("invalid_schedule_command");
  expect(() => f.app.execute(f.auth.actor, reminder(f, { recurrence: { kind: "interval", everyMs: 1_000 } }))).toThrow("invalid_schedule_command");
  expect(() => f.app.execute(f.auth.actor, reminder(f, { occurrenceBudget: 0 }))).toThrow("invalid_schedule_command");
  expect(() => f.app.execute(f.auth.actor, reminder(f, { misfire: "catch_up" as never }))).toThrow("invalid_schedule_command");
  expect(() => f.app.execute(f.auth.actor, reminder(f, { kind: "summary", route: null }))).toThrow("invalid_schedule_command");
  expect(() => f.app.execute(f.auth.actor, reminder(f, { route: structuredClone(grok) }))).toThrow("invalid_schedule_command");
  const other = await fixture();
  expect(() => other.app.execute(other.auth.actor, { ...reminder(other), projectId: f.project.id })).toThrow();
  expect(f.app.schedules(f.auth.actor, f.project.id).items.map(item => item.id)).toEqual([receipt.schedule.id]);
  const missing = crypto.randomUUID();
  expect(() => f.app.schedule(f.auth.actor, f.project.id, missing)).toThrow("schedule_not_found");
  const html = await (await f.web(request(f, `/projects/${f.project.id}/schedules`))).text();
  expect(html).toContain("เตือนทบทวนงาน");
  const detail = await (await f.web(request(f, `/projects/${f.project.id}/schedules/${receipt.schedule.id}`))).text();
  expect(detail).toContain("Asia/Bangkok");
});

test("pause/resume/edit recompute next run without replaying misses; stale edits are rejected", async () => {
  const f = await fixture();
  const created = f.app.execute(f.auth.actor, reminder(f, { recurrence: { kind: "interval", everyMs: 3_600_000 } })).schedule;
  const first = f.clock.now + 3_600_000;
  expect(created.nextRun).toBe(first);
  f.clock.now += 5 * 3_600_000;
  const paused = f.app.execute(f.auth.actor, { kind: "schedule.pause", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: created.revision, payload: { scheduleId: created.id } }).schedule;
  expect(paused).toMatchObject({ state: "paused", nextRun: null, revision: 2 });
  expect(() => f.app.execute(f.auth.actor, { kind: "schedule.pause", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: 2, payload: { scheduleId: created.id } })).toThrow("schedule_not_active");
  expect(tickSchedules(f.store, f.queue, f.config, f.clock.now)).toEqual([{ scheduleId: created.id, action: "skipped", instant: null, jobId: null, note: null }]);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM job_schedule_occurrences")!.n)).toBe(0);
  const resumed = f.app.execute(f.auth.actor, { kind: "schedule.resume", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: 2, payload: { scheduleId: created.id } }).schedule;
  expect(resumed).toMatchObject({ state: "active", revision: 3 });
  // Five hours passed while paused: next run is the next hourly boundary, not five replays.
  expect(resumed.nextRun).toBe(first + 5 * 3_600_000);
  expect(() => f.app.execute(f.auth.actor, { kind: "schedule.resume", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: 3, payload: { scheduleId: created.id } })).toThrow("schedule_not_active");
  const ticks = tickSchedules(f.store, f.queue, f.config, f.clock.now);
  expect(ticks).toHaveLength(1); expect(ticks[0]).toMatchObject({ action: "enqueued" });
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM job_schedule_occurrences")!.n)).toBe(1);
  const edited = f.app.execute(f.auth.actor, { kind: "schedule.edit", requestId: crypto.randomUUID(), projectId: f.project.id,
    expectedRevision: 3, payload: { scheduleId: created.id, purpose: "เตือนใหม่", timezone: "Asia/Bangkok",
      recurrence: { kind: "daily", time: "09:00" }, enabled: true, route: null, limits: structuredClone(limits), occurrenceBudget: 5, text: "ข้อความใหม่" } }).schedule;
  expect(edited).toMatchObject({ revision: 4, purpose: "เตือนใหม่", occurrencesRemaining: 5 });
  expect(() => f.app.execute(f.auth.actor, { kind: "schedule.edit", requestId: crypto.randomUUID(), projectId: f.project.id,
    expectedRevision: 3, payload: { scheduleId: created.id, purpose: "เก่า", timezone: "Asia/Bangkok",
      recurrence: { kind: "daily", time: "09:00" }, enabled: true, route: null, limits: structuredClone(limits), occurrenceBudget: 5, text: "x" } })).toThrow("stale_revision");
  expect(f.app.schedule(f.auth.actor, f.project.id, created.id).occurrences).toHaveLength(1);
});

test("DST gap occurrence discloses the forward shift; next run stays on wall time", async () => {
  const f = await fixture();
  f.clock.now = Date.UTC(2026, 2, 7, 12, 0);
  const created = f.app.execute(f.auth.actor, reminder(f, { timezone: "America/New_York", recurrence: { kind: "daily", time: "02:30" } })).schedule;
  expect(created.nextRun).toBe(Date.UTC(2026, 2, 8, 7, 0));
  expect(created.nextRunNote).toContain("ออมแสง");
  f.clock.now = Date.UTC(2026, 2, 8, 7, 0);
  const ticks = tickSchedules(f.store, f.queue, f.config, f.clock.now);
  expect(ticks[0]).toMatchObject({ action: "enqueued", instant: Date.UTC(2026, 2, 8, 7, 0) });
  const detail = f.app.schedule(f.auth.actor, f.project.id, created.id);
  expect(detail.occurrences[0]).toMatchObject({ scheduledInstant: Date.UTC(2026, 2, 8, 7, 0), resolution: "gap_shifted", requestedWall: "02:30", missed: null });
  await drain(f);
  const after = readSchedule(f, created.id);
  expect(after.lastResult).toMatchObject({ instant: Date.UTC(2026, 2, 8, 7, 0), state: "succeeded" });
  expect(after.nextRun).toBe(Date.UTC(2026, 2, 9, 6, 30));
  const intent = f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents")!.record_json);
  expect(JSON.parse(intent).payload.text).toContain("ออมแสง");
});

test("DST overlap occurrence takes the first instant and says so", async () => {
  const f = await fixture();
  f.clock.now = Date.UTC(2026, 9, 31, 12, 0);
  const created = f.app.execute(f.auth.actor, reminder(f, { timezone: "America/New_York", recurrence: { kind: "daily", time: "01:30" } })).schedule;
  expect(created.nextRun).toBe(Date.UTC(2026, 10, 1, 5, 30));
  f.clock.now = Date.UTC(2026, 10, 1, 5, 30);
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  expect(f.app.schedule(f.auth.actor, f.project.id, created.id).occurrences[0]).toMatchObject({
    scheduledInstant: Date.UTC(2026, 10, 1, 5, 30), resolution: "overlap_first", requestedWall: "01:30" });
  await drain(f);
  expect(readSchedule(f, created.id).lastResult).toMatchObject({ instant: Date.UTC(2026, 10, 1, 5, 30), state: "succeeded" });
});

test("long downtime coalesces into one occurrence with the missed interval disclosed", async () => {
  const f = await fixture();
  const created = f.app.execute(f.auth.actor, reminder(f, { recurrence: { kind: "interval", everyMs: 3_600_000 } })).schedule;
  f.clock.now += 3_600_000;
  const first = tickSchedules(f.store, f.queue, f.config, f.clock.now);
  expect(first[0]).toMatchObject({ action: "enqueued", instant: f.clock.now });
  f.clock.now += 10 * 3_600_000;
  const late = tickSchedules(f.store, f.queue, f.config, f.clock.now);
  expect(late[0]).toMatchObject({ action: "enqueued", instant: f.clock.now, note: expect.stringContaining("coalesced 10 missed") });
  const rows = f.store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM job_schedule_occurrences ORDER BY scheduled_instant").map(row => JSON.parse(row.record_json)));
  expect(rows).toHaveLength(2);
  expect(rows[1]).toMatchObject({ missed: { from: f.clock.now - 9 * 3_600_000, to: f.clock.now, count: 10 } });
  expect(new Set(rows.map(row => row.jobId as string)).size).toBe(2);
  await drain(f);
  const after = readSchedule(f, created.id);
  expect(after.occurrencesRemaining).toBe(28);
  expect(after.nextRun).toBe(f.clock.now + 3_600_000);
  expect(after.lastResult).toMatchObject({ instant: f.clock.now, state: "succeeded" });
});

test("duplicate ticks yield one logical job; the cursor never acknowledges uncreated work", async () => {
  const f = await fixture();
  const created = f.app.execute(f.auth.actor, reminder(f, { recurrence: { kind: "once", at: epoch + 60_000 } })).schedule;
  f.clock.now = epoch + 60_000;
  const a = tickSchedules(f.store, f.queue, f.config, f.clock.now);
  expect(a[0]).toMatchObject({ action: "enqueued", instant: epoch + 60_000 });
  const again = tickSchedules(f.store, f.queue, f.config, f.clock.now);
  expect(again).toMatchObject([{ action: "waiting", instant: null, jobId: null }]);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs")!.n)).toBe(1);
  expect(readSchedule(f, created.id).cursor).toEqual({ lastInstant: epoch + 60_000, lastRevision: 1 });
  // A tick that observes committed work its cursor does not cover must not create
  // a second job and must not advance the cursor without creating work.
  f.store.read(tx => {
    const schedule = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM job_schedules WHERE id = ?", created.id)!.record_json) as JobSchedule;
    schedule.cursor = { lastInstant: null, lastRevision: null };
    tx.run("UPDATE job_schedules SET record_json = ? WHERE id = ?", JSON.stringify(schedule), created.id);
  });
  const dup = tickSchedules(f.store, f.queue, f.config, f.clock.now);
  expect(dup).toMatchObject([{ action: "duplicate", instant: epoch + 60_000, jobId: a[0]!.jobId }]);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs")!.n)).toBe(1);
  expect(readSchedule(f, created.id).cursor).toEqual({ lastInstant: null, lastRevision: null });
  const reopened = await reopen(f);
  const afterRestart = tickSchedules(reopened.store, reopened.queue, reopened.config, reopened.clock.now);
  expect(afterRestart).toMatchObject([{ action: "duplicate", instant: epoch + 60_000, jobId: a[0]!.jobId }]);
  expect(reopened.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs")!.n)).toBe(1);
  // Restore the acknowledgment the first tick performed, then the occurrence drains to a committed result.
  reopened.store.read(tx => {
    const schedule = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM job_schedules WHERE id = ?", created.id)!.record_json) as JobSchedule;
    schedule.cursor = { lastInstant: epoch + 60_000, lastRevision: 1 };
    tx.run("UPDATE job_schedules SET record_json = ? WHERE id = ?", JSON.stringify(schedule), created.id);
  });
  await drain(reopened);
  expect(readSchedule(reopened, created.id)).toMatchObject({
    lastResult: { instant: epoch + 60_000, state: "succeeded" }, nextRun: null, occurrencesRemaining: 29 });
  const reopened2 = await reopen(reopened);
  expect(readSchedule(reopened2, created.id).lastResult).toMatchObject({ state: "succeeded" });
  expect(tickSchedules(reopened2.store, reopened2.queue, reopened2.config, reopened2.clock.now)).toMatchObject([
    { scheduleId: created.id, action: "waiting", instant: null, jobId: null }]);
});

test("revoke fences pending attempts and cancels unsent outbox items but keeps committed results", async () => {
  const f = await fixture();
  const created = f.app.execute(f.auth.actor, reminder(f, { recurrence: { kind: "once", at: epoch + 60_000 } })).schedule;
  f.clock.now = epoch + 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  const occurrence = f.app.schedule(f.auth.actor, f.project.id, created.id).occurrences[0]!;
  expect(occurrence.jobState).toBe("queued");
  const revoked = f.app.execute(f.auth.actor, { kind: "schedule.revoke", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: 1, payload: { scheduleId: created.id } });
  expect(revoked.schedule).toMatchObject({ state: "revoked", nextRun: null, revision: 2 });
  expect(revoked.fencedJobIds).toEqual([occurrence.jobId]);
  expect(() => f.app.execute(f.auth.actor, { kind: "schedule.revoke", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: 2, payload: { scheduleId: created.id } })).toThrow("schedule_not_active");
  await drain(f);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_intents")!.n)).toBe(0);
  expect(f.app.schedule(f.auth.actor, f.project.id, created.id).occurrences[0]!.jobState).toBe("blocked");
  expect(tickSchedules(f.store, f.queue, f.config, f.clock.now + 3_600_000)[0]!.action).toBe("skipped");

  const g = await fixture();
  const live = g.app.execute(g.auth.actor, reminder(g, { recurrence: { kind: "once", at: g.clock.now + 60_000 } })).schedule;
  g.clock.now += 60_000;
  tickSchedules(g.store, g.queue, g.config, g.clock.now);
  await drain(g);
  const intentId = readSchedule(g, live.id).lastResult!.deliveryIntentId!;
  expect(g.store.read(tx => JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE id = ?", intentId)!.record_json)).status).toBe("waiting");
  const rerevoked = g.app.execute(g.auth.actor, { kind: "schedule.revoke", requestId: crypto.randomUUID(), projectId: g.project.id, expectedRevision: 1, payload: { scheduleId: live.id } });
  expect(rerevoked.cancelledIntentIds).toEqual([intentId]);
  expect(g.store.read(tx => JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE id = ?", intentId)!.record_json)).status).toBe("cancelled");
});

test("edit supersedes pending attempts and prior unsent intents; manual job start stays unavailable", async () => {
  const f = await fixture();
  const created = f.app.execute(f.auth.actor, reminder(f, { recurrence: { kind: "once", at: epoch + 60_000 } })).schedule;
  f.clock.now = epoch + 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  const occurrence = f.app.schedule(f.auth.actor, f.project.id, created.id).occurrences[0]!;
  const edited = f.app.execute(f.auth.actor, { kind: "schedule.edit", requestId: crypto.randomUUID(), projectId: f.project.id,
    expectedRevision: 1, payload: { scheduleId: created.id, purpose: "เตือนใหม่", timezone: "Asia/Bangkok",
      recurrence: { kind: "once", at: epoch + 3_600_000 }, enabled: true, route: null, limits: structuredClone(limits), occurrenceBudget: 5, text: "ข้อความใหม่" } });
  expect(edited.schedule.revision).toBe(2);
  expect(edited.fencedJobIds).toEqual([occurrence.jobId]);
  await drain(f);
  expect(f.app.schedule(f.auth.actor, f.project.id, created.id).occurrences[0]!.jobState).toBe("blocked");
  expect(f.app.jobs(f.auth.actor, f.project.id).choices.some(choice => choice.id === "schedule.reminder" || choice.id === "schedule.summary")).toBe(false);
});

test("summary reads permitted context through the run port and commits output evidence; the output cannot seed memory loops", async () => {
  const f = await fixture();
  const roomy = { ...limits, contextTokens: 64000, outputTokens: 4000 };
  const created = f.app.execute(f.auth.actor, summary(f, { recurrence: { kind: "once", at: epoch + 60_000 }, limits: roomy })).schedule;
  f.clock.now = epoch + 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  await drain(f);
  const after = readSchedule(f, created.id);
  const result = after.lastResult!;
  expect(result).toMatchObject({ instant: epoch + 60_000, state: "succeeded" });
  expect(result.outputSource).not.toBeNull();
  expect(result.deliveryIntentId).not.toBeNull();
  const occurrence = f.app.schedule(f.auth.actor, f.project.id, created.id).occurrences[0]!;
  expect(occurrence).toMatchObject({ outputSource: result.outputSource, state: "complete" });
  const request = f.port.requests.at(-1)!;
  expect(request.route).toEqual(grok);
  expect(request.roleId).toBe(scheduleRunRoleId);
  expect(request.manifest.context).toBeDefined();
  expect(request.tools).toEqual([]);
  expect(f.store.read(tx => tx.get<{ depth: number }>(
    "SELECT depth FROM memory_derived_sources WHERE source_id = ?", result.outputSource!.sourceId))).toEqual({ depth: 1 });
  expect(JSON.parse(f.store.read(tx => tx.get<{ record_json: string }>(
    "SELECT record_json FROM memory_contexts WHERE owner_kind = 'schedule' ORDER BY sequence DESC LIMIT 1")!.record_json)).owner).toEqual({ kind: "schedule", id: occurrence.id });
  // The committed summary is refused as an extraction source and hidden from memory reads.
  expect(() => f.app.execute(f.auth.actor, { kind: "memory.extract", requestId: crypto.randomUUID(), projectId: f.project.id,
    expectedRevision: f.app.project(f.auth.actor, f.project.id).revision, payload: { topicId: f.topic.id, roleId: crypto.randomUUID(),
      source: result.outputSource!, dependencies: [], limits: structuredClone(f.config.jobs.maximum) } })).toThrow("memory_source_derived");
  const sources = f.app.memory(f.auth.actor, f.project.id).sources;
  expect(sources.some(item => item.source.reference.sourceId === result.outputSource!.sourceId)).toBe(false);
  // A follow-on occurrence assembles fresh context without the prior summary's text.
  const second = f.app.execute(f.auth.actor, { kind: "schedule.edit", requestId: crypto.randomUUID(), projectId: f.project.id,
    expectedRevision: 1, payload: { scheduleId: created.id, purpose: "สรุปใหม่", timezone: "Asia/Bangkok",
      recurrence: { kind: "once", at: f.clock.now + 60_000 }, enabled: true, route: structuredClone(grok),
      limits: roomy, occurrenceBudget: 5, text: "รอบสอง" } }).schedule;
  f.clock.now += 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  await drain(f);
  expect(readSchedule(f, created.id).lastResult!.instant).toBe(f.clock.now);
  expect(second.revision).toBe(2);
});

test("occurrence budget exhaustion stops future runs visibly; invalid commands stay rejected", async () => {
  const f = await fixture();
  const created = f.app.execute(f.auth.actor, reminder(f, { recurrence: { kind: "interval", everyMs: 3_600_000 }, occurrenceBudget: 1 })).schedule;
  f.clock.now += 3_600_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  await drain(f);
  const after = readSchedule(f, created.id);
  expect(after).toMatchObject({ occurrencesRemaining: 0, nextRun: null });
  expect(after.nextRunNote).toContain("ครบจำนวน");
  expect(tickSchedules(f.store, f.queue, f.config, f.clock.now + 3_600_000)[0]!.action).toBe("skipped");
  const unknown = crypto.randomUUID();
  expect(() => f.app.execute(f.auth.actor, { kind: "schedule.pause", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: 1, payload: { scheduleId: unknown } })).toThrow("schedule_not_found");
  expect(() => f.app.execute(f.auth.actor, { kind: "schedule.create", requestId: "bad id!!", projectId: f.project.id, expectedRevision: f.project.revision, payload: { topicId: f.topic.id, kind: "reminder", purpose: "x", timezone: "Asia/Bangkok", recurrence: { kind: "daily", time: "08:00" }, enabled: true, route: null, limits: structuredClone(limits), occurrenceBudget: 1, misfire: "coalesce", text: "x" } })).toThrow("invalid_schedule_command");
});

test("Web form creates, pauses and resumes a schedule; API reports Thai errors", async () => {
  const f = await fixture();
  const form = (extra: Record<string, string>) => new URLSearchParams({ csrf: f.auth.csrf, requestId: crypto.randomUUID(), expectedRevision: String(f.project.revision), ...extra });
  const created = await f.web(new Request(`http://localhost:3000/projects/${f.project.id}/schedules`, { method: "POST",
    headers: { cookie: `jit_session=${f.token}`, origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" },
    body: form({ topicId: f.topic.id, kind: "reminder", purpose: "เตือนผ่านเว็บ", timezone: "Asia/Bangkok",
      recurrence: JSON.stringify({ kind: "daily", time: "07:00" }), enabled: "true", route: "null", limits: JSON.stringify(limits), occurrenceBudget: "10", misfire: "coalesce", text: "ตื่นได้แล้ว" }) }));
  expect(created.status).toBe(303);
  const id = created.headers.get("location")!.split("/").at(-1)!;
  expect((await (await f.web(request(f, `/api/projects/${f.project.id}/schedules`))).json()).items).toHaveLength(1);
  const paused = await f.web(new Request(`http://localhost:3000/projects/${f.project.id}/schedules/${id}/pause`, { method: "POST",
    headers: { cookie: `jit_session=${f.token}`, origin: "http://localhost:3000", "content-type": "application/x-www-form-urlencoded" },
    body: form({ expectedRevision: "1" }) }));
  expect(paused.status).toBe(303);
  expect(readSchedule(f, id).state).toBe("paused");
  const bad = await f.web(request(f, `/api/projects/${f.project.id}/schedules`, { requestId: crypto.randomUUID(), expectedRevision: f.project.revision,
    topicId: f.topic.id, kind: "reminder", purpose: "x", timezone: "Mars/Olympus", recurrence: { kind: "daily", time: "07:00" },
    enabled: true, route: null, limits, occurrenceBudget: 1, misfire: "coalesce", text: "x" }));
  expect(bad.status).toBe(400);
  expect(await bad.json()).toEqual({ error: "invalid_schedule_timezone" });
});

test("schema v12 store migrates to v20 with new schedule tables and a private snapshot", async () => {
  const f = await fixture();
  const contextId = crypto.randomUUID(), ownerId = crypto.randomUUID();
  f.store.read(tx => tx.run("INSERT INTO memory_contexts (id, project_id, topic_id, owner_kind, owner_id, record_json) VALUES (?, ?, ?, 'discussion', ?, ?)",
    contextId, f.project.id, f.topic.id, ownerId, JSON.stringify({ id: contextId })));
  f.queue.close(); await f.queue.idle(); queues.splice(queues.indexOf(f.queue), 1);
  f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const db = new Database(f.path);
  db.exec("DROP TABLE memory_suppressed_sources; DROP TABLE memory_suppressed_claims; DROP TABLE memory_suppressions; DROP TABLE memory_corrections; DROP TABLE job_schedule_occurrences; DROP TABLE job_schedules; PRAGMA user_version = 12;");
  db.close();
  const before = new Set(readdirSync(f.root));
  const store = new TransactionStore(f.path); stores.push(store);
  expect(store.read(tx => tx.get("PRAGMA user_version"))).toEqual({ user_version: 20 });
  expect(readdirSync(f.root).filter(name => !before.has(name) && name.includes(".pre-v12-"))).toHaveLength(1);
  // The v12-era memory context row survives the owner_kind widening rebuild.
  expect(store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM memory_contexts WHERE id = ?", contextId)!.record_json))
    .toBe(JSON.stringify({ id: contextId }));
  const config = readConfig({ JIT_DATABASE: f.path });
  const queue = new JobQueue(store, config.jobs,
    [scheduleReminderWork(store, config, () => epoch), scheduleSummaryWork(store, config,
      new ScriptedRunPort(store, config.team, config.jobs.outputBytes), () => epoch)],
    { now: () => epoch }); queues.push(queue);
  const app = new Application(store, config, { jobs: queue, now: () => epoch });
  const actor = app.authenticate(f.token).actor;
  const created = app.execute(actor, { kind: "schedule.create", requestId: crypto.randomUUID(), projectId: f.project.id,
    expectedRevision: app.project(actor, f.project.id).revision, payload: { topicId: f.topic.id, kind: "reminder",
      purpose: "เตือนหลังย้าย 🧪", timezone: "Asia/Bangkok", recurrence: { kind: "once", at: epoch + 60_000 },
      enabled: true, route: null, limits: structuredClone(limits), occurrenceBudget: 1, misfire: "coalesce", text: "x" } }).schedule;
  expect(created.contract).toBe("jobs.configured_schedules/v1");
  expect(store.read(tx => tx.all("PRAGMA foreign_key_check"))).toEqual([]);
});
