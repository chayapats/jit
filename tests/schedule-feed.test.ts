import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { dictionaries } from "../src/i18n";
import { TransactionStore, installationScopedTables } from "../src/store";
import { contentSecurityPolicy, createWebHandler } from "../src/web";
import { JobQueue } from "../src/jobs/queue";
import { dueRange, nextScheduledInstant, scheduleReminderWork, scheduleSummaryWork, tickSchedules, type JobSchedule, type ScheduleCommand } from "../src/jobs/schedules";
import { backupImageTables } from "../src/ops/backup";
import { escapeIcsText, feedLimits, feedPathToken, foldIcsLine, scheduleFeedContract, type FeedReceipt } from "../src/schedule-feed";
import { settingsSections } from "../src/web-settings";
import { fixtureOutcome, ScriptedRunPort } from "../src/team/scripted-port";
import type { JobLimits } from "../src/jobs/types";
import { markSetupComplete } from "./fixtures/setup";

const password = "fixture-feed-owner-password", origin = "http://localhost:3000";
const roots: string[] = [], stores: TransactionStore[] = [], queues: JobQueue[] = [];
afterEach(async () => {
  for (const queue of queues.splice(0)) { queue.close(); await queue.idle(); }
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const limits: JobLimits = { roles: 4, calls: 4, rounds: 4, hops: 4, contextTokens: 10, outputTokens: 10, retries: 2, wallMs: 60_000 };
const grok = { provider: "grok" as const, model: "fixture-grok-exact", authRoute: "owner-grok" };
const day = 86_400_000;

async function fixture(start = Date.UTC(2026, 9, 20, 0, 0)) {
  const root = mkdtempSync(join(tmpdir(), "jit-rel08-")); roots.push(root);
  const path = join(root, "app.sqlite"), config = readConfig({ JIT_DATABASE: path }), store = new TransactionStore(path); stores.push(store);
  const clock = { now: start };
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, request => fixtureOutcome("complete", `สรุป · ${request.purpose}`));
  const queue = new JobQueue(store, config.jobs,
    [scheduleReminderWork(store, config, () => clock.now), scheduleSummaryWork(store, config, port, () => clock.now)], { now: () => clock.now }); queues.push(queue);
  const app = new Application(store, config, { jobs: queue, now: () => clock.now });
  await app.setupOwner(password); markSetupComplete(store);
  const token = await app.login(password), auth = app.authenticate(token);
  const project = app.execute(auth.actor, { kind: "project.create", requestId: crypto.randomUUID(), projectId: null, expectedRevision: 0, payload: { name: "Calendar, project; one" } }).project;
  const topic = app.execute(auth.actor, { kind: "topic.create", requestId: crypto.randomUUID(), projectId: project.id, expectedRevision: project.revision, payload: { title: "Secret topic title" } }).topic;
  return { root, path, config, store, clock, queue, app, token, auth, project, topic, web: createWebHandler(app) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
type CreateCmd = Extract<ScheduleCommand, { kind: "schedule.create" }>;

function schedule(f: Fixture, patch: Partial<CreateCmd["payload"]> = {}, projectId = f.project.id, topicId = f.topic.id): JobSchedule {
  const expectedRevision = f.app.project(f.auth.actor, projectId).revision;
  return f.app.execute(f.auth.actor, { kind: "schedule.create", requestId: crypto.randomUUID(), projectId, expectedRevision,
    payload: { topicId, kind: "reminder", purpose: "Review the queue", timezone: "Asia/Bangkok", recurrence: { kind: "daily", time: "08:00" },
      enabled: true, route: null, limits: structuredClone(limits), occurrenceBudget: 1000, misfire: "coalesce", text: "Private reminder body text", ...patch } }).schedule;
}
function feedCommand(f: Fixture, kind: "feed.create" | "feed.rotate" | "feed.disable"): FeedReceipt {
  return f.app.execute(f.auth.actor, { kind, requestId: crypto.randomUUID(), projectId: null, expectedRevision: f.app.scheduleFeedSettings(f.auth.actor).revision, payload: {} });
}
function setPurpose(f: Fixture, includePurpose: boolean): FeedReceipt {
  return f.app.execute(f.auth.actor, { kind: "feed.set_include_purpose", requestId: crypto.randomUUID(), projectId: null,
    expectedRevision: f.app.scheduleFeedSettings(f.auth.actor).revision, payload: { includePurpose } });
}
const tokenOf = (url: string) => feedPathToken(new URL(url).pathname)!;
/** A calendar app's request: no cookie, no Origin, nothing but the URL. */
const fetchFeed = (f: Fixture, path: string, init: RequestInit = {}) => f.web(new Request(`${origin}${path}`, init));
const get = (f: Fixture, path: string) => f.web(new Request(`${origin}${path}`, { headers: { cookie: `jit_session=${f.token}` } }));
const postForm = (f: Fixture, path: string, fields: Record<string, string>) =>
  f.web(new Request(`${origin}${path}`, { method: "POST", body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: `jit_session=${f.token}` } }));
/** Hidden inputs of the first form posting to `action`. */
function form(html: string, action: string): Record<string, string> {
  for (const match of html.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    if (match[1] !== action) continue;
    return Object.fromEntries([...match[2]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(m => [m[1]!, m[2]!]));
  }
  throw new Error(`no form for ${action}`);
}

/** Strict RFC 5545 TEXT unescape: a bare `,` or `;`, or an unknown escape, is a parse error. */
function unescapeText(value: string): string {
  let out = "";
  for (let i = 0; i < value.length; i++) {
    const char = value[i]!;
    if (char === "," || char === ";") throw new Error(`unescaped ${char} in ${value}`);
    if (char !== "\\") { out += char; continue; }
    const next = value[++i];
    if (next === "n" || next === "N") out += "\n";
    else if (next === "\\" || next === "," || next === ";") out += next;
    else throw new Error(`bad escape in ${value}`);
  }
  return out;
}
const parseUtc = (value: string) => {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) throw new Error(`not a UTC date-time: ${value}`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6]));
};
interface ParsedEvent { uid: string; start: number; summary: string; props: Record<string, string> }
/**
 * Deterministic ICS reader: checks CRLF line ends, ≤ 75-octet physical lines, unfolds, balances BEGIN/END,
 * rejects repeated properties inside an event and parses every VEVENT back.
 */
function parseIcs(body: string): { calendar: Record<string, string>; events: ParsedEvent[] } {
  expect(body.endsWith("\r\n")).toBe(true);
  const physical = body.slice(0, -2).split("\r\n");
  for (const line of physical) {
    expect(Buffer.byteLength(line)).toBeLessThanOrEqual(75);
    expect(line).not.toMatch(/[\r\n]/);
  }
  const logical: string[] = [];
  for (const line of physical) {
    if (line.startsWith(" ")) logical[logical.length - 1] += line.slice(1);
    else logical.push(line);
  }
  const stack: string[] = [], events: ParsedEvent[] = [], calendar: Record<string, string> = {};
  let current: Record<string, string> | null = null;
  for (const line of logical) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw new Error(`bad content line: ${line}`);
    const name = line.slice(0, colon).split(";")[0]!, value = line.slice(colon + 1);
    if (name === "BEGIN") { stack.push(value); if (value === "VEVENT") current = {}; continue; }
    if (name === "END") {
      expect(stack.pop()).toBe(value);
      if (value === "VEVENT") {
        const props = current!; current = null;
        expect(Object.keys(props).sort()).toEqual(["DTSTAMP", "DTSTART", "SUMMARY", "TRANSP", "UID"]);
        parseUtc(props.DTSTAMP!);
        events.push({ uid: props.UID!, start: parseUtc(props.DTSTART!), summary: unescapeText(props.SUMMARY!), props });
      }
      continue;
    }
    const target = current ?? calendar;
    expect(target[name]).toBeUndefined();
    target[name] = value;
  }
  expect(stack).toEqual([]);
  expect(logical[0]).toBe("BEGIN:VCALENDAR");
  expect(calendar.VERSION).toBe("2.0");
  return { calendar, events };
}
/**
 * The engine's own sequence: `nextScheduledInstant` from `now`, bounded by the 30-day horizon and the budget the
 * engine will spend on future instants (an already-due, unticked instant spends one first).
 */
function engineSequence(s: JobSchedule, now: number): number[] {
  const out: number[] = [];
  for (let after = now, n = 0; n < s.occurrencesRemaining - (dueRange(s, now) ? 1 : 0); n++) {
    const next = nextScheduledInstant(s, after);
    if (!next || next.utc > now + 30 * day) break;
    out.push(next.utc); after = next.utc;
  }
  return out;
}
const readStored = (f: Fixture, id: string) => f.store.read(tx => JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM job_schedules WHERE id = ?", id)!.record_json) as JobSchedule);
async function readFeed(f: Fixture, url: string) {
  const response = await fetchFeed(f, new URL(url).pathname);
  expect(response.status).toBe(200);
  return parseIcs(await response.text());
}
const startsOf = (events: ParsedEvent[], id: string) => events.filter(e => e.uid.startsWith(`${id}-`)).map(e => e.start);

test("app.schedule_feed/v1: VEVENT starts equal the engine's nextScheduledInstant sequence for 30 days, across Bangkok and New York DST", async () => {
  const f = await fixture();
  const hourly = schedule(f, { recurrence: { kind: "interval", everyMs: 3_600_000 } });
  const bangkok = schedule(f, { timezone: "Asia/Bangkok", recurrence: { kind: "daily", time: "08:00" } });
  // 2026-11-01: New York falls back, so 01:30 happens twice; the engine takes the first (EDT) instant.
  const overlap = schedule(f, { timezone: "America/New_York", recurrence: { kind: "daily", time: "01:30" } });
  const url = feedCommand(f, "feed.create").url!;
  const { events, calendar } = await readFeed(f, url);
  expect(calendar.PRODID).toBe(`-//Jit//${scheduleFeedContract}//EN`);
  for (const s of [hourly, bangkok, overlap]) expect(startsOf(events, s.id)).toEqual(engineSequence(readStored(f, s.id), f.clock.now));
  expect(startsOf(events, hourly.id)).toHaveLength(720);
  expect(startsOf(events, bangkok.id)).toHaveLength(30);
  expect(startsOf(events, bangkok.id)[0]).toBe(Date.UTC(2026, 9, 20, 1, 0));
  const ny = startsOf(events, overlap.id);
  expect(ny).toHaveLength(30);
  expect(ny).toContain(Date.UTC(2026, 9, 31, 5, 30));
  expect(ny).toContain(Date.UTC(2026, 10, 1, 5, 30));
  expect(ny).toContain(Date.UTC(2026, 10, 2, 6, 30));
  expect(ny).not.toContain(Date.UTC(2026, 10, 1, 6, 30));
  // Events are ordered by start; UIDs are `<scheduleId>-<revision>-<instant>@jit` and unique.
  expect(events.map(e => e.start)).toEqual([...events.map(e => e.start)].sort((a, b) => a - b));
  expect(new Set(events.map(e => e.uid)).size).toBe(events.length);
  expect(events.find(e => e.uid.startsWith(bangkok.id))!.uid).toBe(`${bangkok.id}-1-${Date.UTC(2026, 9, 20, 1, 0)}@jit`);
  for (const e of events) expect(e.props.DTSTART).toMatch(/^\d{8}T\d{6}Z$/);

  // 2027-03-14: New York springs forward, so 02:30 does not exist and the engine shifts to 03:00 EDT (07:00Z).
  f.clock.now = Date.UTC(2027, 2, 1, 0, 0);
  // Months later the browser session has expired; the feed itself never needed one.
  f.token = await f.app.login(password); f.auth = f.app.authenticate(f.token);
  const gap = schedule(f, { timezone: "America/New_York", recurrence: { kind: "daily", time: "02:30" } });
  const later = await readFeed(f, url);
  const gapStarts = startsOf(later.events, gap.id);
  expect(gapStarts).toEqual(engineSequence(readStored(f, gap.id), f.clock.now));
  expect(gapStarts).toContain(Date.UTC(2027, 2, 13, 7, 30));
  expect(gapStarts).toContain(Date.UTC(2027, 2, 14, 7, 0));
  expect(gapStarts).toContain(Date.UTC(2027, 2, 15, 6, 30));
  for (const s of [hourly, bangkok, overlap]) expect(startsOf(later.events, s.id)).toEqual(engineSequence(readStored(f, s.id), f.clock.now));
});

test("app.schedule_feed/v1: the feed's next occurrences are the instants the engine actually materializes", async () => {
  const f = await fixture(Date.UTC(2026, 9, 30, 12, 0));
  const s = schedule(f, { timezone: "America/New_York", recurrence: { kind: "daily", time: "01:30" }, occurrenceBudget: 3 });
  const url = feedCommand(f, "feed.create").url!;
  const planned = startsOf((await readFeed(f, url)).events, s.id);
  // The budget caps the feed: three occurrences, the second on the DST overlap.
  expect(planned).toEqual([Date.UTC(2026, 9, 31, 5, 30), Date.UTC(2026, 10, 1, 5, 30), Date.UTC(2026, 10, 2, 6, 30)]);
  for (const [index, instant] of planned.entries()) {
    f.clock.now = instant;
    expect(tickSchedules(f.store, f.queue, f.config, f.clock.now)).toEqual([expect.objectContaining({ scheduleId: s.id, action: "enqueued", instant })]);
    f.queue.pump(); await f.queue.idle();
    // After each fire, the feed shows exactly the rest of the plan.
    expect(startsOf((await readFeed(f, url)).events, s.id)).toEqual(planned.slice(index + 1));
  }
  const fired = f.store.read(tx => tx.all<{ scheduled_instant: number }>("SELECT scheduled_instant FROM job_schedule_occurrences WHERE schedule_id = ? ORDER BY scheduled_instant", s.id)).map(r => r.scheduled_instant);
  expect(fired).toEqual(planned);
});

test("app.schedule_feed/v1: a due but unticked instant spends budget first, so the feed never shows an occurrence that cannot fire", async () => {
  const f = await fixture();
  const start = f.clock.now, hour = 3_600_000;
  const s = schedule(f, { recurrence: { kind: "interval", everyMs: hour }, occurrenceBudget: 2 });
  const url = feedCommand(f, "feed.create").url!;
  expect(startsOf((await readFeed(f, url)).events, s.id)).toEqual([start + hour, start + 2 * hour]);
  // The first instant has passed but the scheduler has not ticked: that tick will spend one of the two.
  f.clock.now = start + 1.5 * hour;
  expect(startsOf((await readFeed(f, url)).events, s.id)).toEqual([start + 2 * hour]);
  expect(tickSchedules(f.store, f.queue, f.config, f.clock.now)).toEqual([expect.objectContaining({ action: "enqueued", instant: start + hour })]);
  expect(startsOf((await readFeed(f, url)).events, s.id)).toEqual([start + 2 * hour]);
  // Missing the last instant too: it is due, the budget is spent on it, and nothing future is shown.
  f.clock.now = start + 2.5 * hour;
  expect(startsOf((await readFeed(f, url)).events, s.id)).toEqual([]);
  f.queue.pump(); await f.queue.idle();
  expect(tickSchedules(f.store, f.queue, f.config, f.clock.now)).toEqual([expect.objectContaining({ action: "enqueued", instant: start + 2 * hour })]);
  expect(readStored(f, s.id).occurrencesRemaining).toBe(0);
  expect(startsOf((await readFeed(f, url)).events, s.id)).toEqual([]);
});

test("app.schedule_feed/v1: the event cap keeps the earliest occurrences across all schedules, in order", async () => {
  const f = await fixture();
  const hourly = Array.from({ length: 8 }, (_, i) => { f.clock.now += 60_000 * i; return schedule(f, { recurrence: { kind: "interval", everyMs: 3_600_000 } }); });
  const { events } = await readFeed(f, feedCommand(f, "feed.create").url!);
  const all = hourly.flatMap(s => engineSequence(readStored(f, s.id), f.clock.now).map(instant => ({ id: s.id, instant })))
    .sort((a, b) => a.instant - b.instant || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  expect(all.length).toBeGreaterThan(feedLimits.events);
  expect(events).toHaveLength(feedLimits.events);
  expect(events.map(e => [e.uid.slice(0, 36), e.start])).toEqual(all.slice(0, feedLimits.events).map(e => [e.id, e.instant]));
});

test("app.schedule_feed/v1: paused and revoked schedules produce no VEVENT", async () => {
  const f = await fixture();
  const active = schedule(f);
  const paused = schedule(f, { enabled: false });
  const pausedLater = schedule(f);
  const revoked = schedule(f);
  f.app.execute(f.auth.actor, { kind: "schedule.pause", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: pausedLater.revision, payload: { scheduleId: pausedLater.id } });
  f.app.execute(f.auth.actor, { kind: "schedule.revoke", requestId: crypto.randomUUID(), projectId: f.project.id, expectedRevision: revoked.revision, payload: { scheduleId: revoked.id } });
  const once = schedule(f, { recurrence: { kind: "once", at: f.clock.now + 2 * day } });
  const beyond = schedule(f, { recurrence: { kind: "once", at: f.clock.now + 31 * day } });
  const { events } = await readFeed(f, feedCommand(f, "feed.create").url!);
  expect(startsOf(events, active.id)).toHaveLength(30);
  expect(startsOf(events, once.id)).toEqual([f.clock.now + 2 * day]);
  for (const id of [paused.id, pausedLater.id, revoked.id, beyond.id]) expect(startsOf(events, id)).toEqual([]);
  expect(events).toHaveLength(31);
});

test("app.schedule_feed/v1: wrong, malformed, rotated and turned-off tokens get 404; no request is logged; no session or cookie", async () => {
  const f = await fixture();
  schedule(f);
  const logged: string[] = [];
  const methods = ["log", "info", "warn", "error", "debug", "trace"] as const;
  const originals = methods.map(m => console[m]);
  for (const m of methods) console[m] = (...args: unknown[]) => { logged.push(args.map(String).join(" ")); };
  try {
    // Off before the first command: every path is 404.
    const nobody = `/feeds/schedules/${"A".repeat(43)}.ics`;
    expect((await fetchFeed(f, nobody)).status).toBe(404);
    const first = feedCommand(f, "feed.create");
    expect(first.feed).toMatchObject({ enabled: true, includePurpose: false, revision: 1 });
    expect(first.url).toMatch(/^http:\/\/localhost:3000\/feeds\/schedules\/[A-Za-z0-9_-]{43}\.ics$/);
    const path1 = new URL(first.url!).pathname, token1 = tokenOf(first.url!);
    const ok = await fetchFeed(f, path1);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(ok.headers.get("content-security-policy")).toBe(contentSecurityPolicy);
    expect(ok.headers.get("x-content-type-options")).toBe("nosniff");
    expect(ok.headers.get("cache-control")).toBe("no-store");
    expect(ok.headers.get("set-cookie")).toBeNull();
    // A wrong token of the right shape, one flipped character, other shapes and other methods are all 404 without a body.
    const flipped = token1.slice(0, -1) + (token1.endsWith("A") ? "B" : "A");
    for (const path of [nobody, `/feeds/schedules/${flipped}.ics`, `/feeds/schedules/${token1}`, `/feeds/schedules/${token1}.ics/x`,
      `/feeds/schedules/${token1.slice(1)}.ics`, `/feeds/schedules/${token1}x.ics`, `/feeds/${token1}.ics`, "/feeds/schedules/.ics", "/feeds/"]) {
      const response = await fetchFeed(f, path);
      expect([path, response.status]).toEqual([path, 404]);
      expect(await response.text()).toBe("");
      expect(response.headers.get("set-cookie")).toBeNull();
    }
    // Every method but GET is the same bodiless 404, never the HTML 405 page.
    for (const method of ["POST", "HEAD", "PUT", "DELETE", "PATCH", "OPTIONS"]) {
      const response = await fetchFeed(f, path1, { method, headers: { origin } });
      expect([method, response.status, await response.text(), response.headers.get("content-type")]).toEqual([method, 404, "", null]);
    }
    // A signed-in browser cookie changes nothing, and a stale or garbage cookie does not block the feed.
    expect((await f.web(new Request(`${origin}${path1}`, { headers: { cookie: "jit_session=garbage" } }))).status).toBe(200);
    // Reading the feed writes nothing: no audit row, receipt or session.
    const audit = f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM audit")!.n);
    await fetchFeed(f, path1);
    expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM audit")!.n)).toBe(audit);
    // New URL: the old one stops at once, the new one works.
    const rotated = feedCommand(f, "feed.rotate");
    const path2 = new URL(rotated.url!).pathname;
    expect(path2).not.toBe(path1);
    expect((await fetchFeed(f, path1)).status).toBe(404);
    expect((await fetchFeed(f, path2)).status).toBe(200);
    // Turn off: every URL stops.
    const off = feedCommand(f, "feed.disable");
    expect(off).toEqual({ feed: expect.objectContaining({ enabled: false, tokenCreatedAt: null }), url: null });
    for (const path of [path1, path2]) expect((await fetchFeed(f, path)).status).toBe(404);
    // Turning it on again mints a fresh URL; none of the old ones come back.
    const again = feedCommand(f, "feed.create");
    for (const path of [path1, path2]) expect((await fetchFeed(f, path)).status).toBe(404);
    expect((await fetchFeed(f, new URL(again.url!).pathname)).status).toBe(200);
    expect(logged.filter(line => line.includes("/feeds/") || line.includes(token1) || line.includes(tokenOf(rotated.url!)))).toEqual([]);
  } finally { methods.forEach((m, i) => { console[m] = originals[i]!; }); }
});

test("app.schedule_feed/v1: only the token hash is stored, receipts never hold the URL, and backups never carry the feed row", async () => {
  const f = await fixture();
  const cmd = { kind: "feed.create" as const, requestId: crypto.randomUUID(), projectId: null, expectedRevision: 0, payload: {} };
  const receipt = f.app.execute(f.auth.actor, cmd);
  const token = tokenOf(receipt.url!);
  // Replay of the same request id is the stored receipt: same state, no URL (it was shown once).
  expect(f.app.execute(f.auth.actor, cmd)).toEqual({ feed: receipt.feed, url: null });
  expect(() => f.app.execute(f.auth.actor, { ...cmd, kind: "feed.rotate" })).toThrow("request_id_conflict");
  // Wrong state and stale revisions are refused.
  expect(() => f.app.execute(f.auth.actor, { ...cmd, requestId: crypto.randomUUID(), expectedRevision: 1 })).toThrow("feed_already_enabled");
  expect(() => f.app.execute(f.auth.actor, { ...cmd, requestId: crypto.randomUUID(), kind: "feed.rotate", expectedRevision: 0 })).toThrow("stale_revision");
  expect(() => f.app.execute(f.auth.actor, { ...cmd, requestId: crypto.randomUUID(), payload: { extra: true } as never })).toThrow("invalid_feed_command");
  expect(() => f.app.execute(f.auth.actor, { kind: "feed.set_include_purpose", requestId: crypto.randomUUID(), projectId: null, expectedRevision: 1, payload: { includePurpose: "yes" as never } })).toThrow("invalid_feed_command");
  // No table anywhere holds the token or the URL.
  const tables = f.store.read(tx => tx.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table'")).map(t => t.name);
  for (const table of tables) {
    const dump = JSON.stringify(f.store.read(tx => tx.all(`SELECT * FROM "${table}"`)));
    expect([table, dump.includes(token)]).toEqual([table, false]);
  }
  expect(f.store.read(tx => tx.get<{ token_hash: string }>("SELECT token_hash FROM schedule_feed WHERE id = 1"))!.token_hash)
    .toBe(new Bun.CryptoHasher("sha256").update(token).digest("hex"));
  // Installation-scoped: excluded from backup images and kept from the live store on activation.
  expect(installationScopedTables).toContain("schedule_feed");
  expect(backupImageTables.schedule_feed).toBe("exclude");
  // Reads of the settings never return the token or its hash.
  expect(JSON.stringify(f.app.scheduleFeedSettings(f.auth.actor))).not.toContain(token);
  expect(Object.keys(f.app.scheduleFeedSettings(f.auth.actor)).sort()).toEqual(["enabled", "includePurpose", "revision", "tokenCreatedAt", "updatedAt"]);
  // An incomplete restore makes the feed unavailable (503) rather than serving or revealing anything.
  writeFileSync(`${f.path}.restore-pending`, JSON.stringify({ restoreId: crypto.randomUUID() }));
  const gated = await fetchFeed(f, new URL(receipt.url!).pathname);
  expect([gated.status, await gated.text()]).toEqual([503, ""]);
  rmSync(`${f.path}.restore-pending`);
  expect((await fetchFeed(f, new URL(receipt.url!).pathname)).status).toBe(200);
});

test("app.schedule_feed/v1: titles carry only kind and project name by default; the purpose appears escaped when the owner turns it on", async () => {
  const f = await fixture();
  const reminderSchedule = schedule(f, { purpose: "Check A, B; then C\\D" });
  const summarySchedule = schedule(f, { kind: "summary", route: structuredClone(grok), purpose: "Weekly summary purpose", recurrence: { kind: "once", at: f.clock.now + day } });
  const url = feedCommand(f, "feed.create").url!;
  let response = await fetchFeed(f, new URL(url).pathname);
  let body = await response.text();
  let { events, calendar } = parseIcs(body);
  // Language follows the owner preference, then Accept-Language, with Thai as the fallback.
  expect(unescapeText(calendar["X-WR-CALNAME"]!)).toBe(dictionaries.th["settings.feed_calendar_name"]);
  expect(response.headers.get("content-language")).toBe("th");
  const reminderTitle = `${dictionaries.th["common.reminder"]} · Calendar, project; one`;
  expect(events.find(e => e.uid.startsWith(reminderSchedule.id))!.summary).toBe(reminderTitle);
  expect(events.find(e => e.uid.startsWith(summarySchedule.id))!.summary).toBe(`${dictionaries.th["common.summary"]} · Calendar, project; one`);
  expect(events.find(e => e.uid.startsWith(reminderSchedule.id))!.props.SUMMARY).toContain("Calendar\\, project\\; one");
  // The feed holds no other project data: no purpose, reminder text, topic title, ids beyond the UID, or route.
  for (const text of ["Check A", "Weekly summary purpose", "Private reminder body text", "Secret topic title", f.topic.id, f.project.id, "fixture-grok-exact", "owner-grok"]) expect(body).not.toContain(text);

  setPurpose(f, true);
  response = await fetchFeed(f, new URL(url).pathname, { headers: { "accept-language": "en-US,en;q=0.9" } });
  body = await response.text();
  ({ events, calendar } = parseIcs(body));
  expect(response.headers.get("content-language")).toBe("en");
  expect(unescapeText(calendar["X-WR-CALNAME"]!)).toBe(dictionaries.en["settings.feed_calendar_name"]);
  const withPurpose = events.find(e => e.uid.startsWith(reminderSchedule.id))!;
  expect(withPurpose.summary).toBe(`${dictionaries.en["common.reminder"]} · Calendar, project; one · Check A, B; then C\\D`);
  expect(withPurpose.props.SUMMARY).toContain("Check A\\, B\\; then C\\\\D");
  expect(events.find(e => e.uid.startsWith(summarySchedule.id))!.summary).toBe(`${dictionaries.en["common.summary"]} · Calendar, project; one · Weekly summary purpose`);
  for (const text of ["Private reminder body text", "Secret topic title"]) expect(body).not.toContain(text);
  // Turning it back off removes the purpose again.
  setPurpose(f, false);
  expect((await readFeed(f, url)).events.some(e => e.summary.includes("Check A"))).toBe(false);
});

test("app.schedule_feed/v1: escaping and folding round-trip through the reader; every line is at most 75 octets", async () => {
  expect(escapeIcsText("a,b;c\\d\ne\r\nf\rg\u0001h\ti")).toBe("a\\,b\\;c\\\\d\\ne\\nf\\ng h\ti");
  // Folding never splits a UTF-8 character and keeps each physical line within the limit.
  const long = `SUMMARY:${"ก".repeat(40)}${"😀".repeat(20)}${"x".repeat(100)}`;
  const folded = foldIcsLine(long);
  for (const line of folded.split("\r\n")) expect(Buffer.byteLength(line)).toBeLessThanOrEqual(feedLimits.lineOctets);
  expect(folded.split("\r\n").map((line, i) => i === 0 ? line : line.slice(1)).join("")).toBe(long);
  expect(folded.includes("�")).toBe(false);

  const f = await fixture();
  const name = `โครงการชื่อยาวมาก 🧪, ที่มี; ตัวอักษร\\พิเศษ ${"ยาว".repeat(30)}`;
  const other = f.app.execute(f.auth.actor, { kind: "project.create", requestId: crypto.randomUUID(), projectId: null, expectedRevision: f.app.workspace(f.auth.actor).revision, payload: { name } }).project;
  const topic = f.app.execute(f.auth.actor, { kind: "topic.create", requestId: crypto.randomUUID(), projectId: other.id, expectedRevision: other.revision, payload: { title: "t" } }).topic;
  const s = schedule(f, { purpose: `จุดประสงค์ ${"ยาวมาก, ".repeat(20)}` }, other.id, topic.id);
  setPurpose(f, true);
  const { events } = await readFeed(f, feedCommand(f, "feed.create").url!);
  const mine = events.filter(e => e.uid.startsWith(s.id));
  expect(mine).toHaveLength(30);
  expect(mine[0]!.summary).toBe(`${dictionaries.th["common.reminder"]} · ${name} · จุดประสงค์ ${"ยาวมาก, ".repeat(20).trim()}`);
});

test("app.schedule_feed/v1: the settings page works without app.js in Thai and English, with New URL and Turn off", async () => {
  const f = await fixture();
  schedule(f);
  expect(settingsSections.find(section => section.id === "feed")).toEqual({ id: "feed", href: "/settings/feed", label: "settings.feed" });
  for (const language of ["th", "en"] as const) {
    const revision = f.app.preferences(f.auth.actor).revision;
    f.app.execute(f.auth.actor, { kind: "ui.preferences.set", requestId: crypto.randomUUID(), projectId: null, expectedRevision: revision, payload: { theme: "system", language } });
    const words = dictionaries[language];
    let html = await (await get(f, "/settings/feed")).text();
    expect(html.startsWith(`<!doctype html><html lang="${language}"`)).toBe(true);
    expect(html).toContain('<nav class="settings-nav"');
    expect(html).toContain(`<a href="/settings/feed" aria-current="page">${words["settings.feed"]}</a>`);
    expect(html).toContain(words["settings.feed_state_off"]);
    expect(html).toContain(words["settings.feed_note"]);
    expect(html).not.toContain('action="/settings/feed/disable"');
    expect(html).not.toContain("/feeds/schedules/");
    // New URL (create) through the plain form: the response page shows the URL once.
    let response = await postForm(f, "/settings/feed/create", form(html, "/settings/feed/create"));
    expect(response.status).toBe(200);
    html = await response.text();
    const shown = /<input id="feed-url" type="text" readonly value="([^"]+)"/.exec(html)![1]!;
    expect(shown).toMatch(/^http:\/\/localhost:3000\/feeds\/schedules\/[A-Za-z0-9_-]{43}\.ics$/);
    expect(html).toContain(words["settings.feed_url_once"]);
    expect((await fetchFeed(f, new URL(shown).pathname)).status).toBe(200);
    // Reloading the settings page never shows the URL again.
    html = await (await get(f, "/settings/feed")).text();
    expect(html).not.toContain(shown);
    expect(html).not.toContain("/feeds/schedules/");
    expect(html).toContain(words["settings.feed_url_hidden"]);
    expect(html).toContain(words["settings.feed_new_url"]);
    expect(html).toContain(words["settings.feed_turn_off"]);
    // New URL (rotate): a new URL, the old one is 404.
    response = await postForm(f, "/settings/feed/rotate", form(html, "/settings/feed/rotate"));
    expect(response.status).toBe(200);
    const rotated = /<input id="feed-url" type="text" readonly value="([^"]+)"/.exec(await response.text())![1]!;
    expect(rotated).not.toBe(shown);
    expect((await fetchFeed(f, new URL(shown).pathname)).status).toBe(404);
    // Include purpose, then Turn off: plain 303 back to the page.
    html = await (await get(f, "/settings/feed")).text();
    response = await postForm(f, "/settings/feed/purpose", { ...form(html, "/settings/feed/purpose"), includePurpose: "on" });
    expect([response.status, response.headers.get("location")]).toEqual([303, "/settings/feed"]);
    expect(f.app.scheduleFeedSettings(f.auth.actor).includePurpose).toBe(true);
    html = await (await get(f, "/settings/feed")).text();
    expect(html).toContain('name="includePurpose" checked');
    response = await postForm(f, "/settings/feed/purpose", form(html, "/settings/feed/purpose"));
    expect(f.app.scheduleFeedSettings(f.auth.actor).includePurpose).toBe(false);
    html = await (await get(f, "/settings/feed")).text();
    response = await postForm(f, "/settings/feed/disable", form(html, "/settings/feed/disable"));
    expect([response.status, response.headers.get("location")]).toEqual([303, "/settings/feed"]);
    expect((await fetchFeed(f, new URL(rotated).pathname)).status).toBe(404);
    // A replayed form (same request id and revision) is the stored receipt or a stale revision, never a second URL.
    const stale = await postForm(f, "/settings/feed/create", form(html, "/settings/feed/disable"));
    expect(stale.status).toBe(409);
  }
  // Commands need the session, CSRF and Origin like every other owner command.
  const html = await (await get(f, "/settings/feed")).text();
  const fields = form(html, "/settings/feed/create");
  expect((await postForm(f, "/settings/feed/create", { ...fields, csrf: "0".repeat(64) })).status).toBe(403);
  expect((await f.web(new Request(`${origin}/settings/feed/create`, { method: "POST", body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "http://evil.example", cookie: `jit_session=${f.token}` } }))).status).toBe(403);
  expect((await f.web(new Request(`${origin}/settings/feed`, {}))).status).toBe(303);
  expect((await postForm(f, "/settings/feed", fields)).status).toBe(404);
  // JSON API: same commands, the URL in the first response only.
  const api = await f.web(new Request(`${origin}/api/settings/feed/create`, { method: "POST", body: JSON.stringify({ requestId: crypto.randomUUID(), expectedRevision: f.app.scheduleFeedSettings(f.auth.actor).revision }),
    headers: { "content-type": "application/json", origin, cookie: `jit_session=${f.token}`, "x-csrf-token": f.auth.csrf } }));
  expect(api.status).toBe(200);
  const receipt = await api.json() as FeedReceipt;
  expect(receipt.url).toMatch(/\/feeds\/schedules\/[A-Za-z0-9_-]{43}\.ics$/);
  expect(await (await get(f, "/api/settings/feed")).json()).toEqual(receipt.feed);
});
