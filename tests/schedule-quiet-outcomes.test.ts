import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";
import { JobQueue } from "../src/jobs/queue";
import {
  normalizeSummaryOutcome,
  scheduleReminderWork,
  scheduleSummaryWork,
  tickSchedules,
  type JobSchedule,
  type ScheduleCommand,
} from "../src/jobs/schedules";
import { fixtureOutcome, ScriptedRunPort } from "../src/team/scripted-port";
import { containsCredential } from "../src/security/credentials";
import type { JobLimits } from "../src/jobs/types";
import type { ApplicationRunOutcome } from "../src/team/types";

const password = "fixture-quiet-owner-password", epoch = 1_800_000_000_000;
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
const roomy: JobLimits = { ...limits, contextTokens: 64000, outputTokens: 4000 };
const grok = { provider: "grok" as const, model: "fixture-grok-exact", authRoute: "owner-grok" };

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "jit-quiet-")); roots.push(root);
  const path = join(root, "app.sqlite"), config = readConfig({ JIT_DATABASE: path }), store = new TransactionStore(path); stores.push(store);
  const clock = new Clock();
  const control: { next: () => ApplicationRunOutcome | Promise<ApplicationRunOutcome> } = { next: () => fixtureOutcome("complete", "สรุป") };
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, () => control.next());
  const queue = new JobQueue(store, config.jobs,
    [scheduleReminderWork(store, config, () => clock.now), scheduleSummaryWork(store, config, port, () => clock.now)],
    { now: () => clock.now }); queues.push(queue);
  const app = new Application(store, config, { jobs: queue, now: () => clock.now });
  await app.setupOwner(password); const token = await app.login(password), auth = app.authenticate(token);
  const project = app.execute(auth.actor, { kind: "project.create", requestId: crypto.randomUUID(), projectId: null, expectedRevision: 0, payload: { name: "โครงการสรุป 🧪" } }).project;
  const topic = app.execute(auth.actor, { kind: "topic.create", requestId: crypto.randomUUID(), projectId: project.id, expectedRevision: project.revision, payload: { title: "หัวข้อสรุป 🧪" } }).topic;
  return { root, path, config, store, clock, control, port, queue, app, token, auth, project: { ...project, revision: project.revision + 1 }, topic, web: createWebHandler(app) };
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
  return reminder(f, { kind: "summary", purpose: "สรุปงานประจำวัน 🧪", route: structuredClone(grok),
    recurrence: { kind: "once", at: epoch + 60_000 }, limits: structuredClone(roomy), text: "สรุปงานที่ค้างให้เจ้าของ", ...patch });
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
  const port = new ScriptedRunPort(store, f.config.team, f.config.jobs.outputBytes, () => f.control.next());
  const queue = new JobQueue(store, f.config.jobs,
    [scheduleReminderWork(store, f.config, () => f.clock.now), scheduleSummaryWork(store, f.config, port, () => f.clock.now)],
    { now: () => f.clock.now }); queues.push(queue);
  const app = new Application(store, f.config, { jobs: queue, now: () => f.clock.now });
  f.token = await app.login(password);
  return { ...f, store, port, queue, app, auth: app.authenticate(f.token), web: createWebHandler(app) };
}
function request(f: Fixture, path: string, body?: Record<string, unknown>, headers: Record<string, string> = {}) {
  return new Request(`http://localhost:3000${path}`, { method: body ? "POST" : "GET", headers: { cookie: `jit_session=${f.token}`, ...headers,
    ...(body ? { origin: "http://localhost:3000", "content-type": "application/json", "x-csrf-token": f.auth.csrf } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
const readSchedule = (f: Fixture, id: string): JobSchedule =>
  f.store.read(tx => JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM job_schedules WHERE id = ?", id)!.record_json) as JobSchedule);
const intentCount = (f: Fixture): number =>
  f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_intents")!.n);
const intents = (f: Fixture): { payload: { kind: string; text: string } }[] =>
  f.store.read(tx => tx.all<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence").map(row => JSON.parse(row.record_json)));

test("normalizeSummaryOutcome table", () => {
  expect(normalizeSummaryOutcome("plain text")).toEqual({ kind: "report", text: "plain text" });
  expect(normalizeSummaryOutcome('{"outcome":"no_update"}')).toEqual({ kind: "no_update" });
  expect(normalizeSummaryOutcome('{"outcome":"no_update","text":"x"}')).toEqual({ kind: "no_update" });
  expect(normalizeSummaryOutcome('{"outcome":"report","text":"ok"}')).toEqual({ kind: "report", text: "ok" });
  expect(normalizeSummaryOutcome('{"outcome":"report"}')).toEqual({ kind: "failed", reason: "invalid_outcome" });
  expect(normalizeSummaryOutcome('{"outcome":"failed","reason":"repo unreachable"}')).toEqual({ kind: "failed", reason: "repo unreachable" });
  expect(normalizeSummaryOutcome('{"outcome":"failed"}')).toEqual({ kind: "failed", reason: "invalid_outcome" });
  expect(normalizeSummaryOutcome('{"outcome":7}')).toEqual({ kind: "failed", reason: "invalid_outcome" });
  expect(normalizeSummaryOutcome('{"outcome":"later"}')).toEqual({ kind: "report", text: '{"outcome":"later"}' });
  expect(normalizeSummaryOutcome("[1,2]")).toEqual({ kind: "report", text: "[1,2]" });
  expect(normalizeSummaryOutcome("ไม่มีอะไรใหม่วันนี้")).toEqual({ kind: "report", text: "ไม่มีอะไรใหม่วันนี้" });
  expect(normalizeSummaryOutcome(`{"outcome":"failed","reason":"${"x".repeat(201)}"}`)).toEqual({ kind: "failed", reason: "invalid_outcome" });
  expect(normalizeSummaryOutcome('{"outcome":"failed","reason":"token is Bearer abc123"}')).toEqual({ kind: "failed", reason: "reason_redacted" });
});

test("no_update commits quietly", async () => {
  const f = await fixture();
  f.control.next = () => fixtureOutcome("complete", '{"outcome":"no_update"}');
  const created = f.app.execute(f.auth.actor, summary(f)).schedule;
  f.clock.now = epoch + 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  await drain(f);
  expect(intentCount(f)).toBe(0);
  const occurrence = f.app.schedule(f.auth.actor, f.project.id, created.id).occurrences[0]!;
  expect(occurrence).toMatchObject({ state: "complete", outcome: { kind: "no_update", reason: null }, deliveryIntentId: null, outputSource: null, jobState: "succeeded" });
  expect(readSchedule(f, created.id).lastResult).toMatchObject({ reason: "no_update", state: "succeeded", deliveryIntentId: null, outputSource: null });
  const th = await (await f.web(request(f, `/projects/${f.project.id}/schedules/${created.id}`))).text();
  expect(th).toContain("ไม่มีอะไรใหม่ ไม่แจ้งเตือน");
  const en = await (await f.web(request(f, `/projects/${f.project.id}/schedules/${created.id}`, undefined, { "Accept-Language": "en" }))).text();
  expect(en).toContain("Nothing new, no notification");
});

test("typed failed notifies once with the reason", async () => {
  const f = await fixture();
  f.control.next = () => fixtureOutcome("complete", '{"outcome":"failed","reason":"repo unreachable"}');
  const created = f.app.execute(f.auth.actor, summary(f)).schedule;
  f.clock.now = epoch + 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  await drain(f);
  expect(intentCount(f)).toBe(1);
  const [only] = intents(f);
  expect(only!.payload.kind).toBe("report");
  expect(only!.payload.text).toContain("repo unreachable");
  const occurrence = f.app.schedule(f.auth.actor, f.project.id, created.id).occurrences[0]!;
  expect(occurrence).toMatchObject({ state: "failed", outcome: { kind: "failed", reason: "repo unreachable" }, jobState: "partial" });
  expect(readSchedule(f, created.id).lastResult).toMatchObject({ state: "failed", reason: "repo unreachable" });
});

test("provider error notifies", async () => {
  const f = await fixture();
  f.control.next = () => fixtureOutcome("invalid_result");
  const a = f.app.execute(f.auth.actor, summary(f)).schedule;
  f.clock.now = epoch + 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  await drain(f);
  expect(intentCount(f)).toBe(1);
  expect(intents(f)[0]!.payload.text).toContain("invalid_result");
  expect(f.app.schedule(f.auth.actor, f.project.id, a.id).occurrences[0]).toMatchObject({ state: "failed" });
  f.control.next = () => fixtureOutcome("max_rounds");
  const b = f.app.execute(f.auth.actor, summary(f, { recurrence: { kind: "once", at: f.clock.now + 60_000 } })).schedule;
  f.clock.now += 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  await drain(f);
  expect(intentCount(f)).toBe(2);
  expect(intents(f)[1]!.payload.text).toContain("max_rounds");
  expect(f.app.schedule(f.auth.actor, f.project.id, b.id).occurrences[0]).toMatchObject({ state: "failed" });
});

test("quota waits instead of failing", async () => {
  const f = await fixture();
  f.control.next = () => fixtureOutcome("quota");
  const created = f.app.execute(f.auth.actor, summary(f)).schedule;
  f.clock.now = epoch + 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  await drain(f);
  expect(intentCount(f)).toBe(0);
  expect(f.app.schedule(f.auth.actor, f.project.id, created.id).occurrences[0]!.jobState).toBe("waiting");
});

test("report path unchanged", async () => {
  const f = await fixture();
  const created = f.app.execute(f.auth.actor, summary(f)).schedule;
  f.clock.now = epoch + 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  await drain(f);
  expect(intentCount(f)).toBe(1);
  const occurrence = f.app.schedule(f.auth.actor, f.project.id, created.id).occurrences[0]!;
  expect(occurrence.outputSource).not.toBeNull();
  expect(occurrence).toMatchObject({ state: "complete", outcome: { kind: "report", reason: null } });
});

test("late result after edit is fenced", async () => {
  const f = await fixture();
  let release!: (value: ApplicationRunOutcome) => void;
  const gate = new Promise<ApplicationRunOutcome>(resolve => { release = resolve; });
  f.control.next = () => gate;
  const created = f.app.execute(f.auth.actor, summary(f)).schedule;
  f.clock.now = epoch + 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  f.queue.pump();
  f.app.execute(f.auth.actor, { kind: "schedule.edit", requestId: crypto.randomUUID(), projectId: f.project.id,
    expectedRevision: 1, payload: { scheduleId: created.id, purpose: "สรุปใหม่", timezone: "Asia/Bangkok",
      recurrence: { kind: "once", at: epoch + 3_600_000 }, enabled: true, route: structuredClone(grok),
      limits: structuredClone(roomy), occurrenceBudget: 5, text: "รอบสอง" } });
  release(fixtureOutcome("complete", '{"outcome":"no_update"}'));
  await drain(f);
  expect(f.app.schedule(f.auth.actor, f.project.id, created.id).occurrences[0]!.outcome).toBeUndefined();
  expect(intentCount(f)).toBe(0);
});

test("restart does not resend", async () => {
  const f = await fixture();
  f.control.next = () => fixtureOutcome("complete", '{"outcome":"failed","reason":"repo unreachable"}');
  const created = f.app.execute(f.auth.actor, summary(f)).schedule;
  f.clock.now = epoch + 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  await drain(f);
  expect(intentCount(f)).toBe(1);
  const g = await reopen(f);
  tickSchedules(g.store, g.queue, g.config, g.clock.now);
  await drain(g);
  expect(intentCount(g)).toBe(1);
  expect(g.app.schedule(g.auth.actor, g.project.id, created.id).occurrences[0]).toMatchObject({
    state: "failed", outcome: { kind: "failed", reason: "repo unreachable" } });
});

test("coalesced misfire stays one quiet occurrence", async () => {
  const f = await fixture();
  f.control.next = () => fixtureOutcome("complete", '{"outcome":"no_update"}');
  const a = f.app.execute(f.auth.actor, summary(f, { recurrence: { kind: "interval", everyMs: 3_600_000 } })).schedule;
  f.clock.now += 5 * 3_600_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  await drain(f);
  const first = f.app.schedule(f.auth.actor, f.project.id, a.id).occurrences[0]!;
  expect(first.missed).toMatchObject({ count: 5 });
  expect(first).toMatchObject({ state: "complete", outcome: { kind: "no_update", reason: null } });
  expect(intentCount(f)).toBe(0);
  f.control.next = () => fixtureOutcome("complete", '{"outcome":"failed","reason":"x"}');
  f.token = await f.app.login(password);
  f.auth = f.app.authenticate(f.token);
  f.app.execute(f.auth.actor, { kind: "schedule.pause", requestId: crypto.randomUUID(), projectId: f.project.id,
    expectedRevision: 1, payload: { scheduleId: a.id } });
  const b = f.app.execute(f.auth.actor, summary(f, { recurrence: { kind: "interval", everyMs: 3_600_000 } })).schedule;
  f.clock.now += 5 * 3_600_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  await drain(f);
  const second = f.app.schedule(f.auth.actor, f.project.id, b.id).occurrences[0]!;
  expect(second.missed).toMatchObject({ count: 5 });
  expect(intentCount(f)).toBe(1);
});

test("failure notice redacts a credential-like schedule purpose", async () => {
  const f = await fixture();
  f.control.next = () => fixtureOutcome("complete", '{"outcome":"failed","reason":"repo unreachable"}');
  const created = f.app.execute(f.auth.actor, summary(f, { purpose: "Review bot token rotation" })).schedule;
  f.clock.now = epoch + 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  await drain(f);
  expect(intentCount(f)).toBe(1);
  const text = intents(f)[0]!.payload.text;
  expect(containsCredential(text)).toBe(false);
  expect(text).toContain("[credential-redacted]");
  expect(text).toContain("repo unreachable");
  expect(f.app.schedule(f.auth.actor, f.project.id, created.id).occurrences[0]).toMatchObject({
    state: "failed", outcome: { kind: "failed", reason: "repo unreachable" }, jobState: "partial" });
});

test("reminders never quiet", async () => {
  const f = await fixture();
  const created = f.app.execute(f.auth.actor, reminder(f, { recurrence: { kind: "once", at: epoch + 60_000 }, text: '{"outcome":"no_update"}' })).schedule;
  f.clock.now = epoch + 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  await drain(f);
  expect(intentCount(f)).toBe(1);
  expect(intents(f)[0]!.payload.kind).toBe("reminder");
  expect(f.app.schedule(f.auth.actor, f.project.id, created.id).occurrences[0]).toMatchObject({ state: "complete" });
});

/** delivery.attention_levels/v1 (REL04): the Telegram level through the owner command. */
function setTelegramLevel(f: Fixture, level: "all" | "needs-me") {
  return f.app.execute(f.auth.actor, { kind: "attention.set", requestId: crypto.randomUUID(), projectId: null,
    expectedRevision: f.app.attentionLevels(f.auth.actor).telegram.revision, payload: { channel: "telegram", level } }).attention;
}

for (const saved of [false, true]) test(`needs-me: owner-configured schedule reports notify once (saved=${saved})`, async () => {
  const f = await fixture();
  if (saved) setTelegramLevel(f, "needs-me");
  expect(f.app.attentionLevels(f.auth.actor).telegram).toMatchObject({ level: "needs-me", revision: saved ? 1 : 0 });
  f.control.next = () => fixtureOutcome("complete", '{"outcome":"report","text":"มีงานใหม่สองเรื่อง"}');
  const report = f.app.execute(f.auth.actor, summary(f)).schedule;
  f.clock.now = epoch + 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now); await drain(f);
  expect(intentCount(f)).toBe(1);
  expect(intents(f)[0]).toMatchObject({ attention: { class: "needs_owner" } });
  const occurrence = f.app.schedule(f.auth.actor, f.project.id, report.id).occurrences[0]!;
  expect(occurrence).toMatchObject({ state: "complete", outcome: { kind: "report" }, deliveryIntentId: expect.any(String) });
  tickSchedules(f.store, f.queue, f.config, f.clock.now); await drain(f);
  expect(intentCount(f)).toBe(1);
  f.control.next = () => fixtureOutcome("complete", '{"outcome":"failed","reason":"repo unreachable"}');
  f.app.execute(f.auth.actor, summary(f, { recurrence: { kind: "once", at: f.clock.now + 60_000 } }));
  f.clock.now += 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now); await drain(f);
  expect(intentCount(f)).toBe(2);
  expect(intents(f)[1]).toMatchObject({ attention: { class: "needs_owner" } });
});

test("needs-me never filters reminders, and returning to all notifies the next summary (REL04)", async () => {
  const f = await fixture();
  setTelegramLevel(f, "needs-me");
  const created = f.app.execute(f.auth.actor, reminder(f, { recurrence: { kind: "once", at: epoch + 60_000 } })).schedule;
  f.clock.now = epoch + 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  await drain(f);
  expect(intents(f).map(intent => intent.payload.kind)).toEqual(["reminder"]);
  expect(f.app.schedule(f.auth.actor, f.project.id, created.id).occurrences[0]!.deliveryIntentId).not.toBeNull();
  setTelegramLevel(f, "all");
  f.control.next = () => fixtureOutcome("complete", "รายงานประจำวัน");
  f.app.execute(f.auth.actor, summary(f, { recurrence: { kind: "once", at: f.clock.now + 60_000 } }));
  f.clock.now += 60_000;
  tickSchedules(f.store, f.queue, f.config, f.clock.now);
  await drain(f);
  expect(intents(f).map(intent => intent.payload.kind)).toEqual(["reminder", "report"]);
  expect(intents(f)[1]).toMatchObject({ attention: { class: "needs_owner" } });
});
