import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { dictionaries } from "../src/i18n";
import { artifactHash } from "../src/s14/artifacts";
import type { WorkOutput } from "../src/s14/authority-types";
import type { NativeRecoveryPort } from "../src/s14/recovery-types";
import { createS14Handler } from "../src/s14/web";
import { renderS14 } from "../src/s14/web-pages";
import { createS14Product } from "../src/s14/web-product";
import { routineAttention } from "../src/s14/web-product-routines";
import { accessibilityProblems } from "./fixtures/a11y";
import { domainFixture, retryId, secondBot, type DomainFixture } from "./fixtures/s14-domain";

// Every case renders real pages through the whole product; a loaded CI runner exceeds the default 5 s.
setDefaultTimeout(30_000);

/**
 * ROUT14-01 and BOT14-02 product surfaces over the real application and handler. Forms are posted the way a browser without
 * script posts them: fields are read out of the rendered HTML, and scripted executors and native ports stand in for models.
 */
const origin = "http://localhost:3001";
const hostile = '<img src=x onerror=alert(1)><button class="s-btn primary">Approve all</button></pre></div><form action="/s14/commands"><script>alert(1)</script>';
const fixtures: DomainFixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.dispose(); });
const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
function formFields(html: string, action: string): Record<string, string> {
  const form = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(m => m[0]).find(f => f.includes(`action="${action}"`)); if (!form) throw new Error(`no form ${action}`);
  const fields: Record<string, string> = {};
  for (const input of form.matchAll(/<input\b[^>]*>/g)) {
    const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(input[0])?.[1], key = attr("name");
    if (!key || (/type="(checkbox|radio)"/.test(input[0]) && !/\schecked/.test(input[0]))) continue;
    fields[unescape(key)] = unescape(attr("value") ?? "");
  }
  for (const area of form.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) fields[area[1]!] = unescape(area[2]!);
  return fields;
}
const commandOf = (html: string, kind: string) => { const found = [...html.matchAll(/name="command" value="([^"]*)"/g)].map(m => JSON.parse(unescape(m[1]!)) as { kind: string; requestId: string; expectedRevision: number; payload: Record<string, unknown> }).find(item => item.kind === kind); if (!found) throw new Error(`no ${kind}`); return found; };
const hasCommand = (html: string, kind: string) => html.includes(`&quot;kind&quot;:&quot;${kind}&quot;`);
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1]!.replace(/<[^>]+>/g, ""));
const strict = (html: string) => { expect(html).not.toMatch(/\sstyle="/); expect(html).not.toMatch(/\son[a-z]+="/); expect(html).not.toContain("javascript:"); expect([...html.matchAll(/<script\b[^>]*>/g)].every(m => m[0].includes('src="/assets/'))).toBe(true); };
const safe = (html: string, language: "th" | "en") => { strict(html); expect(accessibilityProblems(html, language)).toEqual([]); expect(html).not.toContain("<img src=x"); expect(html).not.toContain("<script>alert"); };
const nativePort: NativeRecoveryPort = { async open() { return { async listSessions() { return { sessions: [] }; }, async retireSession() {}, async deleteSession(reference) { return { status: "deleted", session: reference, removed: [], nextAction: "none" }; }, async close() {} }; } };

async function fixture(language: "th" | "en" = "en", output: WorkOutput = { state: "ready", text: '{"outcome":"no_update"}' }, capabilities?: { tools: string[]; resources: string[] }) {
  const holder = { output }, f = await domainFixture({ authority: { executor: { async run() { return holder.output; } } } }, capabilities); fixtures.push(f);
  if (language === "th") f.app.execute(f.auth.actor, { kind: "owner.preferences.set", requestId: retryId(), expectedRevision: f.app.home(f.auth.actor).revision, payload: { language: "th", theme: "system" } });
  const handler = () => createS14Handler(f.app, origin, renderS14, createS14Product(f.app));
  const cookie = `jit_s14=${f.token}`, words = dictionaries[language];
  const get = (route: string) => handler()(new Request(`${origin}${route}`, { headers: { cookie } }));
  const page = async (route: string) => { const response = await get(route); expect(response.status).toBe(200); return response.text(); };
  const post = (route: string, fields: Record<string, string>) => handler()(new Request(`${origin}${route}`, { method: "POST", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
  /** Follows redirects the way a browser does after a form post. */
  const land = async (response: Response): Promise<{ status: number; html: string; path: string }> => {
    let current = response, path = "";
    for (let hop = 0; hop < 4 && current.status === 303; hop++) { path = current.headers.get("location")!; current = await get(path); }
    return { status: current.status, html: await current.text(), path };
  };
  const press = async (html: string, kind: string) => { const body = commandOf(html, kind), csrf = formFields(html, "/s14/commands").csrf!; return land(await post("/s14/commands", { csrf, command: JSON.stringify(body) })); };
  const csrf = () => f.app.authenticate(f.token).csrf;
  /** Fills the routine form as an owner would, then posts its review. */
  const review = async (purpose: string, changes: Record<string, string> = {}) => {
    const fields = { ...formFields(await page("/routines/new"), "/s14/forms/routine-preview"), purpose, timezone: "Asia/Bangkok", ...changes };
    return post("/s14/forms/routine-preview", fields);
  };
  const enable = async (purpose: string, changes: Record<string, string> = {}) => {
    const html = await (await review(purpose, changes)).text();
    return { html, landed: await land(await post("/s14/forms/routine-enable", formFields(html, "/s14/forms/routine-enable"))) };
  };
  const routines = () => f.app.routines.list(f.auth.actor);
  const run = async (minutes = 24 * 60) => { f.clock.now += minutes * 60000; f.app.routines.tick(); await f.app.authority.drain(); f.app.store.transaction(tx => f.app.routines.reconcile(tx)); };
  const settle = () => f.app.botLifecycle.drain(nativePort);
  return { ...f, f, holder, words, get, page, post, land, press, csrf, review, enable, routines, run, settle };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const propose = async (g: Fixture, botId: string, ticks: Record<string, string>, unticks: string[] = []) => {
  const base = "/s14/forms/capability-propose", fields = { ...formFields(await g.page(`/team/${botId}/capabilities?edit=1`), base), ...ticks };
  for (const name of unticks) delete fields[name];
  return g.land(await g.post(base, fields));
};

test.each(["th", "en"] as const)("%s owner sees the exact capture, enables through a no-script form and nothing runs yet", async language => {
  const g = await fixture(language), { words } = g, form = await g.page("/routines/new");
  safe(form, language);
  for (const key of ["s14.routine.field.what", "s14.routine.field.when", "s14.routine.misfire", "s14.routine.other", "s14.routine.limits_title"] as const) expect(form).toContain(words[key]);
  expect(form).toContain('data-device-timezone');
  const response = await g.review("Check UPS prices\r\nReport what changed", { schedule: "daily", time: "09:00", occurrences: "5", days: "20", reads: "12", minutes: "10", concurrent: "1" });
  expect(response.status).toBe(200);
  const html = await response.text(); safe(html, language);
  expect(g.routines()).toHaveLength(0);
  for (const value of [words["s14.routine.review_title"], "Asia/Bangkok", "09:00", words["s14.routine.misfire"], words["s14.routine.other"], words["s14.routine.enable"], words["s14.routine.words"], words["s14.routine.field.first"]]) expect(html).toContain(value);
  const fields = formFields(html, "/s14/forms/routine-enable");
  expect(fields.purpose).toBe("Check UPS prices\nReport what changed");
  const landed = await g.land(await g.post("/s14/forms/routine-enable", fields));
  expect(landed.status).toBe(200); expect(landed.path).toContain("/routines/"); expect(landed.html).toContain(words["s14.routine.done.enable"]);
  safe(landed.html, language);
  const [view] = g.routines(), p = view!.routine.capture.command.payload;
  expect(p).toMatchObject({ title: "Check UPS prices", timezone: "Asia/Bangkok", recurrence: { kind: "daily", time: "09:00" }, misfire: "coalesce", occurrenceBudget: 5, bots: [{ id: "jit" }] });
  expect(p.limits).toMatchObject({ wallMs: 600000, reads: 12, concurrency: 1 });
  expect(g.app.authority.list(g.auth.actor)).toHaveLength(0);
  // A retried form is one logical receipt.
  await g.post("/s14/forms/routine-enable", fields);
  expect(g.routines()).toHaveLength(1);
});

test("edit keeps the typed draft, and refused reviews keep it with the cause in words", async () => {
  const g = await fixture("en"), { words } = g;
  const reviewed = await (await g.review("Weekly brief", { schedule: "interval", hours: "6", occurrences: "3" })).text();
  const edited = await (await g.post("/s14/forms/routine-edit", formFields(reviewed, "/s14/forms/routine-enable"))).text();
  expect(edited).toContain("Weekly brief</textarea>"); expect(edited).toMatch(/value="interval" checked/); expect(edited).toContain('name="hours" min="1" max="720" value="6"');
  expect(g.routines()).toHaveLength(0);
  const bad = await g.review("Bad zone", { timezone: "Mars/Olympus" });
  expect(bad.status).toBe(400); const html = await bad.text();
  expect(html).toContain(words["s14.error.invalid_routine_schedule"]); expect(html).toContain("Bad zone</textarea>"); expect(html).toContain("Mars/Olympus"); safe(html, "en");
  const secret = await g.review("Use sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789");
  expect(secret.status).toBe(403); const refused = await secret.text();
  expect(refused).toContain(words["s14.error.credential_content_refused"]); expect(refused).not.toContain("abcdefghijklmnopqrstuvwxyz0123456789");
  const late = await g.review("Too late", { schedule: "once", at: "2020-01-01T08:00" });
  expect(late.status).toBe(400); expect(await late.text()).toContain("Too late</textarea>");
  const range = await g.review("Too many", { occurrences: "5000" });
  expect(range.status).toBe(400); expect(await range.text()).toContain(words["s14.error.s14_limit_out_of_range"]);
  expect(g.routines()).toHaveLength(0);
});

test("a stale enable returns to the form with nothing enabled, and no Bot means no capture", async () => {
  const g = await fixture("en"), html = await (await g.review("Stale check")).text(), fields = formFields(html, "/s14/forms/routine-enable");
  g.app.execute(g.auth.actor, { kind: "message.post", requestId: retryId(), expectedRevision: Number(fields.expectedRevision), payload: { conversationId: fields.conversationId!, text: "Moved on" } });
  const refused = await g.post("/s14/forms/routine-enable", fields);
  expect(refused.status).toBe(409); const page = await refused.text();
  expect(page).toContain(g.words["s14.error.stale_revision"]); expect(page).toContain("Stale check</textarea>");
  expect(g.routines()).toHaveLength(0);
  const none = formFields(await g.page("/routines/new"), "/s14/forms/routine-preview"); delete none["bot:jit"];
  const empty = await g.post("/s14/forms/routine-preview", { ...none, purpose: "No Bot", timezone: "UTC" });
  expect(empty.status).toBe(400); expect(await empty.text()).toContain(g.words["s14.error.invalid_bots"]);
});

test.each(["th", "en"] as const)("%s quiet runs make no noise while failures and decisions stay visible and grouped", async language => {
  const g = await fixture(language), { words } = g;
  await g.enable("Quiet routine", { schedule: "interval", hours: "1", occurrences: "6" });
  const id = g.routines()[0]!.routine.id;
  await g.run(61);
  const quiet = await g.page(`/routines/${id}`); safe(quiet, language);
  expect(quiet).toContain(words["s14.routine.run.quiet"]); expect(quiet).toContain(words["s14.routine.quiet_note"]);
  const calm = await g.page("/work"); expect(calm).not.toContain(words["s14.attention.routine.failed"]); expect(calm).toContain(words["s14.attention.none"]);
  expect(g.app.attention.view(g.auth.actor).items).toHaveLength(0);
  g.holder.output = { state: "ready", text: '{"outcome":"failed","reason":"source was down"}' };
  await g.run(61);
  const home = await g.page("/work"); safe(home, language);
  expect(home).toContain(words["s14.attention.group.routines"]); expect(home).toContain(words["s14.attention.routine.failed"]); expect(home).toContain("Quiet routine"); expect(home).toContain(`href="/routines/${id}"`);
  const failed = await g.page(`/routines/${id}`); expect(failed).toContain(words["s14.routine.latest_failed"]); expect(failed).toContain(words["s14.routine.run.failed"]);
  expect(await g.page("/work")).toContain(words["s14.attention.routine.failed"]);
  g.holder.output = { state: "ready", text: '{"outcome":"no_update"}' };
  await g.run(61);
  expect(await g.page("/work")).not.toContain(words["s14.attention.routine.failed"]);
  expect(await g.page(`/routines/${id}`)).toContain(words["s14.routine.run.failed"]);
});

test("a run report shows once per routine and is listed without raising the badge", async () => {
  const g = await fixture("en", { state: "ready", text: "Prices changed", report: { title: "Price report",
    claims: [{ id: "price", text: "Unverified price change", kind: "inference", citations: [], covers: [], conflicts: [] }],
    missing: [], limitations: ["No verified price source"], artifactIds: [] } }), { words } = g;
  g.app.execute(g.auth.actor, { kind: "attention.set", requestId: retryId(), expectedRevision: 0, payload: { level: "all" } });
  await g.enable("Report routine", { schedule: "interval", hours: "1", occurrences: "6" });
  await g.run(61); await g.run(61);
  const home = await g.page("/work");
  expect(home).toContain(words["s14.attention.group.updates"]); expect(home.match(new RegExp(words["s14.attention.routine.report"], "g"))).toHaveLength(1);
  expect(home).not.toContain(`${words["s14.nav.waiting"]} 1`);
});

test.each(["no_update", "failed"] as const)("old open routine decisions survive 150 newer notices and %s escalation on bounded Home/Work", async outcome => {
  const g = await fixture("en", { state: "ready", text: JSON.stringify({ outcome, reason: "fixture_failure", proposals: [
    { title: "Old open finding", purpose: "Owner must decide", completionRule: "Owner review" },
    { title: "Second finding", purpose: "Another owner decision", completionRule: "Owner review" },
  ] }) });
  await g.enable("Old decision routine", { schedule: "interval", hours: "1", occurrences: "1" });
  await g.run(61);
  const routineId = g.routines()[0]!.routine.id;
  const before = routineAttention(g.app, g.auth.actor, g.app.authority.list(g.auth.actor));
  expect(before.needs.find(row => row.need === "decision")).toMatchObject({ routineId, count: 2 });
  if (outcome === "failed") expect(before.needs.some(row => row.need === "failed")).toBe(true);
  const groupId = g.app.attention.view(g.auth.actor).items[0]!.groupId;
  g.store.transaction(tx => {
    tx.run("UPDATE attention_notices SET record_json=json_set(record_json,'$.state','unknown','$.remote','uncertain') WHERE group_id=?", groupId);
    for (let i = 0; i < 150; i++) g.app.attention.commit(tx, { groupId: `new_notice_${i}`, class: "needs_owner", reason: "routine_report", workId: null, proposalIds: [] });
  });
  expect(g.app.attention.view(g.auth.actor).items).toHaveLength(151);
  expect(g.app.attention.view(g.auth.actor).items.some(row => row.groupId === groupId)).toBe(true);
  const summary = routineAttention(g.app, g.auth.actor, g.app.authority.list(g.auth.actor));
  expect(summary.needs.find(row => row.need === "decision")).toMatchObject({ routineId, count: 2, delivery: "unknown" });
  expect(summary.needs).toHaveLength(outcome === "failed" ? 2 : 1);
  expect(() => g.app.routines.attention({ ownerId: "owner" })).toThrow("authentication_required");
  for (const path of ["/", "/work"]) {
    const html = await g.page(path);
    if (path === "/") expect(html).toContain('href="/work#s14-work-waiting"');
    else { expect(html).toContain(g.words["s14.attention.routine.decision"]); expect(html).toContain(`href="/routines/${routineId}#findings"`); }
    expect(html).toContain(`${g.words["s14.nav.waiting"]} ${summary.needs.length}`);
  }
  const proposal = g.app.authority.list(g.auth.actor).find(work => work.title === "Old open finding")!;
  g.app.execute(g.auth.actor, { kind: "task.accept", requestId: retryId(), expectedRevision: proposal.revision, payload: { taskId: proposal.id } });
  expect(routineAttention(g.app, g.auth.actor, []).needs.find(row => row.need === "decision")!.count).toBe(1);
});

test.each(["th", "en"] as const)("%s findings are proposals that grant nothing, and hostile text never reaches a control", async language => {
  const finding = { title: hostile, purpose: `Investigate ${hostile}`, completionRule: hostile };
  const g = await fixture(language, { state: "ready", text: "Found something", proposals: [finding] }), { words } = g;
  await g.enable(hostile, { schedule: "interval", hours: "1", occurrences: "3" });
  await g.run(61);
  const routine = g.routines()[0]!.routine, list = await g.page("/routines"), detail = await g.page(`/routines/${routine.id}`), home = await g.page("/work");
  for (const html of [list, detail, home]) safe(html, language);
  expect(buttons(detail).join(" ")).not.toContain("Approve all"); expect(buttons(list).join(" ")).not.toContain("Approve all");
  expect(detail).toContain(words["s14.routine.finding_note"]); expect(detail).toContain(words["s14.routine.finding_tag"]);
  expect(home).toContain(words["s14.attention.routine.decision"]);
  const before = g.app.authority.list(g.auth.actor).filter(item => item.grantId).length;
  const accepted = await g.press(detail, "task.accept");
  expect(accepted.status).toBe(200); safe(accepted.html, language);
  const now = g.app.authority.list(g.auth.actor);
  expect(now.filter(item => item.grantId)).toHaveLength(before);
  expect(now.some(item => item.reason === "routine_out_of_scope" && item.state === "accepted")).toBe(true);
  expect(g.routines()[0]!.routine.capture.command.payload.tools).toEqual(routine.capture.command.payload.tools);
});

test.each(["th", "en"] as const)("%s pause, resume and revoke are exact commands with honest words in every state", async language => {
  const g = await fixture(language), { words } = g;
  await g.enable("Controlled", { schedule: "interval", hours: "1", occurrences: "3" });
  const id = g.routines()[0]!.routine.id;
  const paused = await g.press(await g.page(`/routines/${id}`), "routine.pause");
  expect(paused.html).toContain(words["s14.routine.done.pause"]); expect(paused.html).toContain(words["s14.routine.paused_detail"]); expect(hasCommand(paused.html, "routine.resume")).toBe(true); expect(hasCommand(paused.html, "routine.pause")).toBe(false); safe(paused.html, language);
  const resumed = await g.press(paused.html, "routine.resume");
  expect(resumed.html).toContain(words["s14.routine.done.resume"]); expect(hasCommand(resumed.html, "routine.pause")).toBe(true);
  // A second tab rendered at the previous revision is a new request, so it is refused and leads back here.
  const tab = commandOf(paused.html, "routine.resume"), token = formFields(paused.html, "/s14/commands").csrf!;
  const stale = await g.land(await g.post("/s14/commands", { csrf: token, command: JSON.stringify({ ...tab, requestId: retryId() }) }));
  expect(stale.status).toBe(409); expect(stale.html).toContain(words["s14.error.stale_revision"]); expect(stale.html).toContain(`/routines/${id}`);
  const revoked = await g.press(resumed.html, "routine.revoke");
  expect(revoked.html).toContain(words["s14.routine.done.revoke"]); expect(revoked.html).toContain(words["s14.routine.revoked_detail"]);
  for (const kind of ["routine.pause", "routine.resume", "routine.revoke"]) expect(hasCommand(revoked.html, kind)).toBe(false);
  expect(revoked.html).toContain(`/routines/new?from=${id}`);
  const again = await g.page(`/routines/new?from=${id}`);
  expect(again).toContain("Controlled</textarea>"); expect(again).not.toContain("data-device-timezone");
  expect(await g.page("/routines")).toContain(words["s14.routine.revoked_list"]);
});

test("exhausted routines say so and a changed Bot blocks a routine until the owner replaces it", async () => {
  const g = await fixture("en"), { words } = g;
  await g.enable("Once only", { schedule: "once", at: "2026-10-31T12:00" });
  const once = g.routines()[0]!.routine;
  expect(once.capture.command.payload.occurrenceBudget).toBe(1);
  await g.run(6 * 60);
  const done = await g.page(`/routines/${once.id}`);
  expect(done).toContain(words["s14.routine.state.exhausted"]); expect(done).toContain(words["s14.routine.exhausted_detail"]);
  await g.enable("Bound routine", { schedule: "interval", hours: "1", occurrences: "3" });
  const bound = g.routines().find(item => item.routine.id !== once.id)!.routine;
  const landed = await propose(g, "jit", {}, ["tool:computer"]);
  expect(landed.html).toContain(words["s14.life.impact_routines"]); expect(landed.html).toContain("Bound routine");
  await g.land(await g.post("/s14/forms/capability-accept", formFields(landed.html, "/s14/forms/capability-accept")));
  const blocked = await g.page(`/routines/${bound.id}`); safe(blocked, "en");
  expect(blocked).toContain(words["s14.routine.blocked_title"]); expect(blocked).toContain(words["s14.routine.reason.bot_authority_changed"]);
  expect(hasCommand(blocked, "routine.resume")).toBe(false); expect(hasCommand(blocked, "routine.revoke")).toBe(true);
  expect(await g.page("/work")).toContain(words["s14.attention.routine.blocked"]);
  await g.press(blocked, "routine.revoke");
  expect(await g.page("/work")).not.toContain(words["s14.attention.routine.blocked"]);
});

test("an unknown or failed optional notification stays honest in history", async () => {
  const f = await domainFixture({ attention: { async send() { return "unknown"; } }, authority: { executor: { async run() { return { state: "ready", text: '{"outcome":"failed","reason":"down"}' }; } } } }); fixtures.push(f);
  const handler = createS14Handler(f.app, origin, renderS14, createS14Product(f.app)), page = async (route: string) => (await handler(new Request(`${origin}${route}`, { headers: { cookie: `jit_s14=${f.token}` } }))).text();
  const conversation = f.conversationId, jit = f.app.home(f.auth.actor).bots[0]!;
  const routine = f.app.execute(f.auth.actor, { kind: "routine.enable", requestId: retryId(), expectedRevision: f.app.conversation(f.auth.actor, conversation).conversation.revision, payload: { conversationId: conversation, title: "Daily", purpose: "Daily", completionRule: "Review", bots: [{ id: jit.id, revision: jit.revision }], tools: [], scopes: [], limits: { attempts: 4, steps: 4, calls: 8, outputBytes: 32768, wallMs: 60000, concurrency: 2, reads: 4 }, timezone: "UTC", recurrence: { kind: "interval", everyMs: 60000 }, misfire: "coalesce", occurrenceBudget: 3, endsAt: f.clock.now + 86400000 } }).routine;
  f.clock.now += 61000; f.app.routines.tick(); await f.app.authority.drain(); f.app.store.transaction(tx => f.app.routines.reconcile(tx)); await f.app.attention.drain();
  const html = await page(`/routines/${routine.id}`);
  expect(html).toContain(dictionaries.en["s14.routine.delivery.unknown"]);
  expect(await page("/work")).toContain(dictionaries.en["s14.routine.delivery.unknown"]);
});

test.each(["th", "en"] as const)("%s adding web tools shows the exact before and after, and acceptance reads as intent until it settles", async language => {
  const g = await fixture(language, undefined, { tools: [], resources: [] }), { words } = g;
  const form = await g.page("/team/jit/capabilities"); safe(form, language);
  expect(form).toContain(words["s14.life.draft_title"]); expect(form).toContain("web_search"); expect(form).not.toContain(words["s14.life.end_title"]); expect(form).toContain(words["s14.life.main_note"]);
  const before = g.app.botLifecycle.view(g.auth.actor, "jit").bot;
  const landed = await propose(g, "jit", { "tool:web_search": "on", "tool:web_fetch": "on" });
  safe(landed.html, language);
  expect(landed.path).toContain("/team/jit/capabilities?proposal=");
  expect(landed.html).toContain(words["s14.life.discard"]); expect(landed.html).not.toContain(words["s14.destroy.cancel"]);
  for (const value of [words["s14.life.now"], words["s14.life.after"], words["s14.life.adds"], words["s14.life.gain.web_search"], words["s14.life.not_1"], words["s14.life.impact_none"]]) expect(landed.html).toContain(value);
  expect(g.app.botLifecycle.view(g.auth.actor, "jit").bot).toEqual(before);
  const fields = formFields(landed.html, "/s14/forms/capability-accept");
  expect(buttons(landed.html).join(" ")).toContain(fields.proposalHash!.slice(0, 8));
  const accepted = await g.land(await g.post("/s14/forms/capability-accept", fields));
  expect(accepted.path).toContain("/team/jit?receipt="); safe(accepted.html, language);
  for (const value of [words["s14.life.done.capabilities_accept"], words["s14.life.done_intent"], words["s14.life.stopping.active"], words["s14.life.step.calls"], "data-live"]) expect(accepted.html).toContain(value);
  const home = await g.page("/"); expect(home).toContain(words["s14.life.main_paused"]);
  const chat = await g.page(`/chats/${g.conversationId}`); expect(chat).toContain(words["s14.life.chat_returning_detail"]); expect(chat).not.toContain("data-composer");
  await g.settle();
  const settled = await g.page(accepted.path); safe(settled, language);
  expect(settled).toContain(words["s14.life.done_settled"]); expect(settled).not.toContain(words["s14.life.stopping.active"]); expect(settled).not.toContain("data-live");
  expect(g.app.botLifecycle.view(g.auth.actor, "jit").bot).toMatchObject({ enabled: true, capabilities: { tools: ["web_search", "web_fetch"] } });
});

test("a stale proposal is refused and never accepted for the owner; the same ceiling offers no accept", async () => {
  const g = await fixture("en"), { words } = g, old = await propose(g, "jit", {}, ["tool:computer"]), fields = formFields(old.html, "/s14/forms/capability-accept");
  await secondBot(g);
  const newer = await propose(g, "jit", {});
  expect(newer.html).toContain(words["s14.life.proposal_same"]); expect(newer.html).not.toContain('action="/s14/forms/capability-accept"');
  const refused = await g.post("/s14/forms/capability-accept", fields);
  expect(refused.status).toBe(409); const page = await refused.text();
  expect(page).toContain(words["s14.error.stale_capability_proposal"]); expect(page).toContain(words["s14.life.draft_title"]); safe(page, "en");
  const superseded = await g.page(`/team/jit/capabilities?proposal=${fields.proposalId}`);
  expect(superseded).toContain(words["s14.life.proposal_superseded"]); expect(superseded).not.toContain('action="/s14/forms/capability-accept"');
  const unknown = await g.post("/s14/forms/capability-propose", { ...formFields(await g.page("/team/jit/capabilities?edit=1"), "/s14/forms/capability-propose"), injected: "1" });
  expect(unknown.status).toBe(400);
});

test.each(["th", "en"] as const)("%s the share dead end leads to a reviewed slot, then back to the same sheet", async language => {
  const g = await fixture(language, { state: "ready", text: "Review" }), { words } = g, bot = await secondBot(g);
  g.app.execute(g.auth.actor, { kind: "bot.capabilities.propose", requestId: "seedproposalrequest1", expectedRevision: bot.revision, payload: { botId: bot.id, capabilities: { tools: [], resources: [] } } });
  const seed = g.app.botLifecycle.view(g.auth.actor, bot.id).proposals[0]!;
  g.app.execute(g.auth.actor, { kind: "bot.capabilities.accept", requestId: retryId(), expectedRevision: seed.revision, payload: { proposalId: seed.id, proposalHash: seed.hash } }); await g.settle();
  const conversation = g.conversationId, jit = g.app.home(g.auth.actor).bots.find(item => item.id === "jit")!;
  const work = g.app.execute(g.auth.actor, { kind: "work.start", requestId: retryId(), expectedRevision: g.app.conversation(g.auth.actor, conversation).conversation.revision, payload: { conversationId: conversation, task: null, title: "File", purpose: "File", completionRule: "Review", bots: [{ id: "jit", revision: jit.revision }], tools: [], scopes: [], limits: { attempts: 8, steps: 8, calls: 16, outputBytes: 131072, concurrency: 2, reads: 40, wallMs: 3600000 }, expiresAt: g.clock.now + 3600000 } }).work!;
  const attempt = g.app.authority.admit(work.id, retryId(), { botId: "jit", scopes: [], tools: [], input: "Report", calls: 2, outputBytes: 65536 }), bytes = new TextEncoder().encode("Exact bytes");
  const stage = g.store.transaction(tx => g.app.artifacts.stage(tx, attempt, { name: "report-1.md", mediaType: "text/markdown", size: bytes.length, sha256: artifactHash(bytes) }, bytes));
  g.app.authority.commit(attempt.id, { state: "ready", text: "Review", report: { title: "Report", claims: [{ id: "claim", text: "Unverified", kind: "inference", citations: [], covers: [], conflicts: [] }], missing: [], limitations: ["Unverified"], artifactIds: [stage.id] } });
  const sheet = `/shares/new?kind=artifact&id=${stage.id}&revision=1&generation=1`, empty = await g.page(sheet); safe(empty, language);
  expect(empty).toContain(words["s14.share.none_title"]); expect(empty).toContain(words["s14.share.add_slot"]); expect(empty).not.toContain('action="/s14/forms/snapshot-share"');
  const link = unescape(/href="(\/team\/[^"]*add=slot[^"]*)"/.exec(empty)![1]!), form = await g.page(link); safe(form, language);
  const ticked = formFields(form, "/s14/forms/capability-propose");
  expect(Object.keys(ticked).filter(key => key.startsWith("resource:"))).toEqual(["resource:share_slot_01"]);
  expect(ticked.share).toContain(`id=${stage.id}`);
  const proposal = await g.land(await g.post("/s14/forms/capability-propose", ticked)); safe(proposal.html, language);
  expect(proposal.html).toContain(words["s14.life.gain.slot"]); expect(proposal.html).toContain(words["s14.life.not_3"]);
  const accepted = await g.land(await g.post("/s14/forms/capability-accept", formFields(proposal.html, "/s14/forms/capability-accept")));
  expect(accepted.html).toContain(words["s14.life.back_wait"]); expect(accepted.html).not.toContain(words["s14.life.back_to_share"]);
  expect(await g.page(sheet)).toContain(words["s14.share.blocked.stopping"]);
  await g.settle();
  const settled = await g.page(accepted.path); expect(settled).toContain(words["s14.life.back_to_share"]);
  const back = unescape(/href="(\/shares\/new\?[^"]*)"/.exec(settled)![1]!), ready = await g.page(back);
  const shared = await g.land(await g.post("/s14/forms/snapshot-share", { ...formFields(ready, "/s14/forms/snapshot-share"), hours: "2" }));
  expect(shared.status).toBe(200); expect(shared.path).toContain("/shares/share_slot_01");
  expect(g.app.sharing.list(g.auth.actor)[0]!.share).toMatchObject({ id: "share_slot_01", receiverBotId: bot.id });
  expect(g.app.authority.list(g.auth.actor).filter(item => item.grantId)).toHaveLength(1);
});

test("with no other Bot the sheet points at Jit rather than a slot", async () => {
  const g = await fixture("en", { state: "ready", text: "Review" }), conversation = g.conversationId, jit = g.app.home(g.auth.actor).bots[0]!;
  const work = g.app.execute(g.auth.actor, { kind: "work.start", requestId: retryId(), expectedRevision: g.app.conversation(g.auth.actor, conversation).conversation.revision, payload: { conversationId: conversation, task: null, title: "File", purpose: "File", completionRule: "Review", bots: [{ id: "jit", revision: jit.revision }], tools: [], scopes: [], limits: { attempts: 8, steps: 8, calls: 16, outputBytes: 131072, concurrency: 2, reads: 40, wallMs: 3600000 }, expiresAt: g.clock.now + 3600000 } }).work!;
  const attempt = g.app.authority.admit(work.id, retryId(), { botId: "jit", scopes: [], tools: [], input: "Report", calls: 2, outputBytes: 65536 }), bytes = new TextEncoder().encode("Exact bytes");
  const stage = g.store.transaction(tx => g.app.artifacts.stage(tx, attempt, { name: "report-1.md", mediaType: "text/markdown", size: bytes.length, sha256: artifactHash(bytes) }, bytes));
  g.app.authority.commit(attempt.id, { state: "ready", text: "Review", report: { title: "Report", claims: [{ id: "claim", text: "Unverified", kind: "inference", citations: [], covers: [], conflicts: [] }], missing: [], limitations: ["Unverified"], artifactIds: [stage.id] } });
  const html = await g.page(`/shares/new?kind=artifact&id=${stage.id}&revision=1&generation=1`);
  expect(html).toContain(g.words["s14.share.no_other_bot"]); expect(html).toContain(g.words["s14.share.ask_jit"]); expect(html).not.toContain(g.words["s14.share.add_slot"]);
});

test.each(["th", "en"] as const)("%s retire previews what stops and stays, then re-enable is a fresh generation needing new grants", async language => {
  const g = await fixture(language), { words } = g, bot = await secondBot(g);
  const conversationId = g.app.home(g.auth.actor).conversations.find(item => item.botId === bot.id)!.id;
  await g.enable("Bot routine", { schedule: "interval", hours: "1", occurrences: "3", [`bot:${bot.id}`]: String(bot.revision) });
  const preview = await g.page(`/team/${bot.id}/retire`); safe(preview, language);
  expect(preview).toContain(words["s14.life.retire.cancel"]); expect(preview).not.toContain(words["s14.destroy.cancel"]);
  for (const value of [words["s14.life.stops"], words["s14.life.stays"], words["s14.life.retire.stops_2"], words["s14.life.retire.stays_1"], words["s14.life.retire.again"], words["s14.life.computer_note"], words["s14.life.manifest"], "data-focus-on-load"]) expect(preview).toContain(value);
  expect(commandOf(preview, "bot.retire").payload).toMatchObject({ botId: bot.id, retain: { history: true, evidence: true } });
  expect(buttons(preview)).toContain(words["s14.life.retire.confirm"]);
  const retired = await g.press(preview, "bot.retire");
  expect(retired.path).toContain(`/team/${bot.id}?receipt=`); expect(retired.html).toContain(words["s14.life.done.retire"]); expect(retired.html).toContain(words["s14.life.stopping.retired"]); safe(retired.html, language);
  expect((await g.page("/team"))).toContain(words["s14.life.state.stopping"]);
  await g.settle();
  const rest = await g.page(`/team/${bot.id}`); safe(rest, language);
  expect(rest).toContain(words["s14.life.retired_detail"]); expect(rest).toContain(words["s14.life.reenable"]);
  expect(await g.page("/team")).toContain(words["s14.life.team.retired"]);
  const chat = await g.page(`/chats/${conversationId}`); expect(chat).toContain(words["s14.life.chat_closed"]); expect(chat).not.toContain("data-composer");
  const again = await g.page(`/team/${bot.id}/retire`); expect(again).toContain(words["s14.life.already_retired"]); expect(hasCommand(again, "bot.retire")).toBe(false);
  const form = await g.page(`/team/${bot.id}/capabilities`); safe(form, language);
  expect(form).toContain(words["s14.life.reenable_title"]);
  const reenable = await g.land(await g.post("/s14/forms/capability-reenable", formFields(form, "/s14/forms/capability-reenable")));
  safe(reenable.html, language);
  expect(reenable.html).toContain(words["s14.life.reenable_fresh"]); expect(reenable.html).toContain(words["s14.life.accept_reenable"]);
  const generation = g.app.botLifecycle.view(g.auth.actor, bot.id).bot.generation;
  await g.land(await g.post("/s14/forms/capability-accept", formFields(reenable.html, "/s14/forms/capability-accept"))); await g.settle();
  expect(g.app.botLifecycle.view(g.auth.actor, bot.id)).toMatchObject({ bot: { enabled: true, generation: generation + 1 }, lifecycle: { state: "active" } });
});

test.each(["th", "en"] as const)("%s delete shows the exact binding and honest limits, and a deleted Bot has no way back", async language => {
  const g = await fixture(language), { words } = g, bot = await secondBot(g);
  const preview = await g.page(`/team/${bot.id}/delete`); safe(preview, language);
  expect(preview).toContain(words["s14.life.delete.cancel"]); expect(preview).not.toContain(words["s14.destroy.cancel"]);
  for (const value of [words["s14.life.delete.lost"], words["s14.life.delete.does_1"], words["s14.life.delete.not_1"], words["s14.life.delete.not_3"], words["s14.life.delete.not_5"], words["s14.life.delete.kept"], words["s14.life.computer_note"], words["s14.life.manifest"]]) expect(preview).toContain(value);
  const command = commandOf(preview, "bot.delete"), current = g.app.botLifecycle.preview(g.auth.actor, bot.id, "delete");
  expect(command.payload.previewHash).toBe(current.hash); expect(preview).toContain(current.hash); expect(preview).toContain(current.conversations[0]!.id);
  expect(buttons(preview)).toContain(words["s14.life.delete.confirm"]);
  // Anything that changes the manifest makes the rendered press stale, and the refusal leads back to a fresh preview.
  g.app.execute(g.auth.actor, { kind: "conversation.create", requestId: retryId(), expectedRevision: g.app.botLifecycle.view(g.auth.actor, bot.id).bot.revision, payload: { botId: bot.id } });
  const stale = await g.press(preview, "bot.delete");
  expect(stale.status).toBe(409); expect(stale.html).toContain(words["s14.error.stale_lifecycle_preview"]); expect(stale.html).toContain(`/team/${bot.id}/delete`);
  const fresh = await g.page(`/team/${bot.id}/delete`), deleted = await g.press(fresh, "bot.delete");
  expect(deleted.html).toContain(words["s14.life.done.delete"]); expect(deleted.html).toContain(words["s14.life.stopping.deleted"]); safe(deleted.html, language);
  await g.settle();
  const gone = await g.page(`/team/${bot.id}`); safe(gone, language);
  expect(gone).toContain(words["s14.life.deleted_detail"]); expect(gone).toContain(words["s14.bot.deleted_name"]); expect(gone).not.toContain("[deleted]"); expect(gone).not.toContain(`/team/${bot.id}/capabilities`);
  const team = await g.page("/team"); expect(team).toContain(words["s14.life.team.deleted"]); expect(team).not.toContain("[deleted]");
  const home = await g.page("/"); expect(home).not.toContain("[deleted]"); expect(home).not.toContain(`/team/${bot.id}"`);
  const form = await g.page(`/team/${bot.id}/capabilities`); expect(form).not.toContain("/s14/forms/capability-");
  const noDelete = await g.page(`/team/${bot.id}/delete`); expect(hasCommand(noDelete, "bot.delete")).toBe(false);
});

test("Jit offers no retire or delete on any page, and the service refusal stays underneath", async () => {
  const g = await fixture("en"), { words } = g;
  for (const route of ["/team/jit/retire", "/team/jit/delete"]) { const html = await g.page(route); expect(html).toContain(words["s14.life.main_note"]); expect(hasCommand(html, "bot.retire") || hasCommand(html, "bot.delete")).toBe(false); safe(html, "en"); }
  const preview = g.app.botLifecycle.preview(g.auth.actor, "jit", "delete");
  expect(() => g.app.execute(g.auth.actor, { kind: "bot.delete", requestId: retryId(), expectedRevision: preview.bot.revision, payload: { botId: "jit", previewHash: preview.hash } })).toThrow("main_bot_required");
});

test("a hostile Bot name stays data on every lifecycle page", async () => {
  const g = await fixture("en"), bot = await secondBot(g);
  g.store.transaction(tx => { const row = JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM bots WHERE id=?", bot.id)!.record_json); row.name = hostile; tx.run("UPDATE bots SET record_json=? WHERE id=?", JSON.stringify(row), bot.id); });
  for (const route of ["/team", `/team/${bot.id}`, `/team/${bot.id}/capabilities`, `/team/${bot.id}/retire`, `/team/${bot.id}/delete`, "/routines/new"]) {
    const html = await g.page(route); safe(html, "en"); expect(buttons(html).join(" ")).not.toContain("Approve all");
  }
});

test.each(["th", "en"] as const)("%s recovery shows when Jit last started, localized, and More reaches routines", async language => {
  const g = await fixture(language), { words } = g, html = await g.page("/recovery"); safe(html, language);
  expect(html).toContain(words["s14.recovery.booted"]);
  const bootedAt = g.app.recovery.view(g.auth.actor).bootedAt;
  expect(html).toContain(`datetime="${new Date(bootedAt).toISOString()}"`);
  expect(html).toContain(new Intl.DateTimeFormat(language === "en" ? "en-GB" : "th-TH", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "UTC" }).format(new Date(bootedAt)));
  const more = await g.page("/more"); expect(more).toContain('href="/routines"');
  expect(await g.page("/routines")).toContain(words["s14.routine.empty"]);
});

test("receipts cannot fake a landing banner on another Bot or routine", async () => {
  const g = await fixture("en"), { words } = g, bot = await secondBot(g);
  await g.enable("Mine", { schedule: "interval", hours: "1", occurrences: "3" });
  await g.enable("Other", { schedule: "interval", hours: "2", occurrences: "3" });
  const [first, second] = g.routines();
  const receipt = g.app.execute(g.auth.actor, { kind: "routine.pause", requestId: retryId(), expectedRevision: first!.routine.revision, payload: { routineId: first!.routine.id } }).requestId;
  expect(await g.page(`/routines/${second!.routine.id}?receipt=${receipt}`)).not.toContain(words["s14.routine.done.pause"]);
  const proposal = g.app.execute(g.auth.actor, { kind: "bot.capabilities.propose", requestId: retryId(), expectedRevision: bot.revision, payload: { botId: bot.id, capabilities: { tools: [], resources: [] } } }).proposal!;
  const accepted = g.app.execute(g.auth.actor, { kind: "bot.capabilities.accept", requestId: retryId(), expectedRevision: proposal.revision, payload: { proposalId: proposal.id, proposalHash: proposal.hash } }).requestId;
  expect(await g.page(`/team/jit?receipt=${accepted}`)).not.toContain(words["s14.life.done.capabilities_accept"]);
  expect(await g.page(`/team/${bot.id}?receipt=${receipt}`)).not.toContain(words["s14.life.done.capabilities_accept"]);
});
