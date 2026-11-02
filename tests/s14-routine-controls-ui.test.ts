import { afterEach, expect, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ConnectionVault } from "../src/exec/connections";
import { dictionaries } from "../src/i18n";
import type { WorkOutput } from "../src/s14/authority-types";
import { createS14Handler } from "../src/s14/web";
import { renderS14 } from "../src/s14/web-pages";
import { createS14Product } from "../src/s14/web-product";
import { lookupS14Asset, s14AssetUrl } from "../src/s14/web-assets";
import { accessibilityProblems } from "./fixtures/a11y";
import { domainFixture, retryId, routineCommand, secondBot, type DomainFixture } from "./fixtures/s14-domain";

// Every case renders real pages through the whole product; a loaded CI runner exceeds the default 5 s.
setDefaultTimeout(30_000);

/**
 * UX14-02 product surfaces over the real application and handler. Forms are posted the way a browser without script posts them:
 * fields are read out of the rendered HTML, scripted executors stand in for models, and a scripted process stands in for `git ls-remote`.
 */
const origin = "http://localhost:3001", token = "fixture-private-branch-token-value", sha = "c".repeat(40);
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
  for (const select of form.matchAll(/<select\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/select>/g)) fields[select[1]!] = /<option value="([^"]*)" selected>/.exec(select[2]!)?.[1] ?? "";
  for (const area of form.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) fields[area[1]!] = unescape(area[2]!);
  return fields;
}
const commandOf = (html: string, kind: string) => { const found = [...html.matchAll(/name="command" value="([^"]*)"/g)].map(m => JSON.parse(unescape(m[1]!)) as { kind: string; requestId: string; expectedRevision: number; payload: Record<string, unknown> }).find(item => item.kind === kind); if (!found) throw new Error(`no ${kind}`); return found; };
const hasCommand = (html: string, kind: string) => html.includes(`&quot;kind&quot;:&quot;${kind}&quot;`);
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1]!.replace(/<[^>]+>/g, ""));
const strict = (html: string) => { expect(html).not.toMatch(/\sstyle="/); expect(html).not.toMatch(/\son[a-z]+="/); expect(html).not.toContain("javascript:"); expect([...html.matchAll(/<script\b[^>]*>/g)].every(m => m[0].includes('src="/assets/'))).toBe(true); };
const safe = (html: string, language: "th" | "en") => { strict(html); expect(accessibilityProblems(html, language)).toEqual([]); expect(html).not.toContain("<img src=x"); expect(html).not.toContain("<script>alert"); expect(buttons(html).some(label => label.includes("Approve all"))).toBe(false); };

async function fixture(language: "th" | "en" = "en", output: WorkOutput = { state: "ready", text: '{"outcome":"no_update"}' }, git = false) {
  const holder = { output }, policy = { routes: [{ id: "selected", provider: "codex" as const, model: "fixture" }], tools: ["web_search", "computer", "coding", "effect_push"], resources: ["share1", "resource1"] };
  const f = await domainFixture({ ...(git ? { policy } : {}), authority: { executor: { async run() { return holder.output; } } } }, git ? { tools: ["computer", "coding", "effect_push"], resources: ["resource1"] } : undefined); fixtures.push(f);
  if (language === "th") f.app.execute(f.auth.actor, { kind: "owner.preferences.set", requestId: retryId(), expectedRevision: f.app.home(f.auth.actor).revision, payload: { language: "th", theme: "system" } });
  const handler = () => createS14Handler(f.app, origin, renderS14, createS14Product(f.app));
  const cookie = `jit_s14=${f.token}`, words = dictionaries[language];
  const get = (route: string) => handler()(new Request(`${origin}${route}`, { headers: { cookie } }));
  const page = async (route: string) => { const response = await get(route); expect(response.status).toBe(200); return response.text(); };
  const post = (route: string, fields: Record<string, string>) => handler()(new Request(`${origin}${route}`, { method: "POST", headers: { cookie, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
  const land = async (response: Response): Promise<{ status: number; html: string; path: string }> => {
    let current = response, path = "";
    for (let hop = 0; hop < 4 && current.status === 303; hop++) { path = current.headers.get("location")!; current = await get(path); }
    return { status: current.status, html: await current.text(), path };
  };
  const press = async (html: string, kind: string) => { const body = commandOf(html, kind), csrf = formFields(html, "/s14/commands").csrf!; return land(await post("/s14/commands", { csrf, command: JSON.stringify(body) })); };
  const submit = async (html: string, action: string, changes: Record<string, string> = {}, drop: string[] = []) => { const fields = { ...formFields(html, action), ...changes }; for (const name of drop) delete fields[name]; return land(await post(action, fields)); };
  const enable = async (purpose: string, changes: Record<string, string> = {}) => {
    const review = await land(await post("/s14/forms/routine-preview", { ...formFields(await page("/routines/new"), "/s14/forms/routine-preview"), purpose, timezone: "Asia/Bangkok", ...changes }));
    return { review: review.html, landed: await submit(review.html, "/s14/forms/routine-enable") };
  };
  const routines = () => f.app.routines.list(f.auth.actor);
  const run = async (minutes = 61) => { f.clock.now += minutes * 60000; f.app.routines.tick(); await f.app.authority.drain(); f.app.store.transaction(tx => f.app.routines.reconcile(tx)); };
  return { ...f, f, holder, words, get, page, post, land, press, submit, enable, routines, run };
}
const failing: WorkOutput = { state: "ready", text: '{"outcome":"failed","reason":"source was down"}' };
const reporting: WorkOutput = { state: "ready", text: "Prices changed", report: { title: "Price report", claims: [{ id: "price", text: "Unverified price change", kind: "inference", citations: [], covers: [], conflicts: [] }], missing: [], limitations: ["No verified price source"], artifactIds: [] } };
const dismissAction = "/s14/forms/attention-dismiss";

test.each(["th", "en"] as const)("%s a failed run row can be dismissed without script, from each page, and the run stays in history", async language => {
  const g = await fixture(language, failing), { words } = g;
  await g.enable(hostile, { schedule: "interval", hours: "1", occurrences: "9" });
  await g.run();
  const id = g.routines()[0]!.routine.id, home = await g.page("/work"); safe(home, language);
  expect(home).toContain(words["s14.attention.routine.failed"]); expect(buttons(home)).toContain(words["s14.attention.dismiss"]); expect(home).toContain(words["s14.attention.dismiss_note"]);
  expect(home).toMatch(/aria-describedby="s14-notice-[a-f0-9]+"/);
  const work = await g.page("/work"); safe(work, language);
  const fields = formFields(work, dismissAction);
  expect(Object.keys(fields).sort()).toEqual(["csrf", "expectedRevision", "from", "noticeId", "requestId"]);
  expect(fields.from).toBe("work");
  const landed = await g.land(await g.post(dismissAction, fields));
  expect(landed.path).toBe("/work"); expect(landed.html).not.toContain(words["s14.attention.routine.failed"]); expect(landed.html).not.toContain(`${words["s14.nav.waiting"]} 1`);
  // The notice is resolved and the failure stays recorded.
  expect(g.app.attention.view(g.auth.actor).items[0]).toMatchObject({ resolvedAt: g.clock.now });
  const detail = await g.page(`/routines/${id}`); safe(detail, language);
  expect(detail).toContain(words["s14.routine.latest_failed"]); expect(detail).toContain(words["s14.routine.run.failed"]); expect(buttons(detail)).not.toContain(words["s14.attention.dismiss"]);
  // A second press of the same stale page changes nothing and says so.
  const stale = await g.land(await g.post(dismissAction, { ...fields, requestId: retryId() }));
  expect(stale.status).toBe(409); expect(stale.html).toContain(words["s14.error.stale_revision"]); expect(stale.html).toContain('href="/work"');
});

test("dismiss on a routine page returns there; a foreign address and unknown fields are refused", async () => {
  const g = await fixture("en", failing), { words } = g;
  await g.enable("Watch the page", { schedule: "interval", hours: "1", occurrences: "9" });
  await g.run();
  const id = g.routines()[0]!.routine.id, detail = await g.page(`/routines/${id}`), fields = formFields(detail, dismissAction);
  expect(fields).toMatchObject({ from: "routine", routineId: id });
  const refused = await g.post(dismissAction, { ...fields, extra: "1" }); expect(refused.status).toBe(400);
  const away = await g.land(await g.post(dismissAction, { ...fields, routineId: "../../evil" }));
  expect(away.path).toBe("/");
  expect(await g.page("/work")).not.toContain(words["s14.attention.routine.failed"]);
});

test("decisions and blocked routines offer no Dismiss, because acknowledging would not answer them", async () => {
  const g = await fixture("en", { state: "ready", text: '{"outcome":"no_update","proposals":[{"title":"Open finding","purpose":"Decide this","completionRule":"Owner review"}]}' }), { words } = g;
  await g.enable("Finding routine", { schedule: "interval", hours: "1", occurrences: "9" });
  await g.run();
  const home = await g.page("/work"); safe(home, "en");
  expect(home).toContain(words["s14.attention.routine.decision"]); expect(buttons(home)).not.toContain(words["s14.attention.dismiss"]); expect(home).not.toContain(words["s14.attention.dismiss_note"]);
  const bot = g.app.home(g.auth.actor).bots.find(item => item.id === "jit")!;
  g.app.execute(g.auth.actor, { kind: "bot.capabilities.propose", requestId: retryId(), expectedRevision: bot.revision, payload: { botId: "jit", capabilities: { tools: ["web_search"], resources: bot.capabilities.resources } } });
  const proposal = g.app.botLifecycle.view(g.auth.actor, "jit").proposals[0]!;
  g.app.execute(g.auth.actor, { kind: "bot.capabilities.accept", requestId: retryId(), expectedRevision: proposal.revision, payload: { proposalId: proposal.id, proposalHash: proposal.hash } });
  g.app.routines.tick();
  const blocked = await g.page("/work");
  expect(blocked).toContain(words["s14.attention.routine.blocked"]); expect(buttons(blocked)).not.toContain(words["s14.attention.dismiss"]);
});

test.each(["th", "en"] as const)("%s attention level posts without script and governs only future reports", async language => {
  const g = await fixture(language, reporting), { words } = g;
  await g.enable("Report routine", { schedule: "interval", hours: "1", occurrences: "9" });
  await g.run();
  // Default: the run reports, and Needs you stays calm.
  expect(await g.page("/work")).not.toContain(words["s14.attention.group.updates"]);
  expect(await g.page("/routines")).toContain(words["s14.attention.level.now.needs-me"]);
  const more = await g.page("/more"); safe(more, language);
  for (const key of ["s14.attention.level.title", "s14.attention.level.lead", "s14.attention.level.needs-me", "s14.attention.level.all", "s14.attention.level.note"] as const) expect(more).toContain(words[key]);
  expect(more).toMatch(/name="level" value="needs-me" checked/);
  const action = "/s14/forms/attention-level", saved = await g.submit(more, action, { level: "all" });
  expect(saved.path).toMatch(/^\/more\?receipt=[a-f0-9]+#s14-attention-level$/); expect(saved.html).toContain(words["s14.attention.level.saved_detail"]); expect(saved.html).toMatch(/name="level" value="all" checked/);
  expect(g.app.attention.view(g.auth.actor).setting).toMatchObject({ level: "all", revision: 1 });
  expect(await g.page("/work")).not.toContain(words["s14.attention.group.updates"]);
  await g.run();
  const home = await g.page("/work"); safe(home, language);
  expect(home).toContain(words["s14.attention.group.updates"]); expect(home).not.toContain(`${words["s14.nav.waiting"]} 1`);
  expect(await g.page("/routines")).toContain(words["s14.attention.level.now.all"]);
  // A report clears with Dismiss too.
  const cleared = await g.submit(home, dismissAction); expect(cleared.path).toBe("/work"); expect(cleared.html).not.toContain(words["s14.attention.group.updates"]);
  // A stale form and an invented level are refused, and neither changes the setting.
  const stale = await g.land(await g.post(action, { ...formFields(more, action), requestId: retryId(), level: "needs-me" })); expect(stale.status).toBe(409); expect(stale.html).toContain('href="/more"');
  const fresh = await g.page("/more"), invented = await g.land(await g.post(action, { ...formFields(fresh, action), level: "silent" })); expect(invented.status).toBeGreaterThanOrEqual(400);
  expect(g.app.attention.view(g.auth.actor).setting.level).toBe("all");
});

test("a saved banner on More reads a real attention receipt, so a link cannot fake it", async () => {
  const g = await fixture("en"), { words } = g;
  expect(await g.page("/more?receipt=forged")).not.toContain(words["s14.attention.level.saved_detail"]);
});

test.each(["th", "en"] as const)("%s a capability proposal can be discarded without changing anything", async language => {
  const g = await fixture(language), { words } = g, form = "/s14/forms/capability-propose";
  const before = g.app.home(g.auth.actor).bots.find(bot => bot.id === "jit")!;
  const proposed = await g.submit(await g.page("/team/jit/capabilities?edit=1"), form, {}, ["tool:web_search"]);
  const html = proposed.html; safe(html, language);
  for (const value of [words["s14.life.discard"], words["s14.life.discard_note"]]) expect(html).toContain(value);
  const action = "/s14/forms/capability-discard", fields = formFields(html, action), proposal = g.app.botLifecycle.view(g.auth.actor, "jit").proposals[0]!;
  expect(fields).toMatchObject({ botId: "jit", proposalId: proposal.id, proposalHash: proposal.hash, expectedRevision: String(proposal.revision) });
  const landed = await g.land(await g.post(action, fields));
  expect(landed.path).toMatch(/^\/team\/jit\?receipt=/); expect(landed.html).toContain(words["s14.life.done.capabilities_discard"]); expect(landed.html).toContain(words["s14.life.done.capabilities_discard_detail"]); expect(landed.html).not.toContain(words["s14.life.done_settled"]);
  expect(g.app.home(g.auth.actor).bots.find(bot => bot.id === "jit")).toEqual(before);
  expect(g.app.botLifecycle.view(g.auth.actor, "jit").proposals[0]).toMatchObject({ state: "discarded" });
  const page = await g.page("/team/jit/capabilities"); safe(page, language);
  expect(page).not.toContain(words["s14.life.accept"]); expect(page).toContain(words["s14.life.proposal_state.discarded"]);
  const read = await g.page(`/team/jit/capabilities?proposal=${proposal.id}`); safe(read, language);
  expect(read).toContain(words["s14.life.proposal_discarded"]); expect(read).not.toContain(words["s14.life.proposal_same"]); expect(buttons(read)).not.toContain(words["s14.life.discard"]);
  // Pressing an old page is refused, keeps the ceiling draft and does not read as an empty selection.
  const stale = await g.land(await g.post(action, { ...fields, requestId: retryId() }));
  expect(stale.status).toBe(409); expect(stale.html).toContain('name="tool:web_search" value="on" checked');
});

test("a proposal that matches today's ceiling can be discarded; a stale one offers only a new selection", async () => {
  const g = await fixture("en"), { words } = g, form = "/s14/forms/capability-propose";
  const same = await g.submit(await g.page("/team/jit/capabilities?edit=1"), form);
  expect(same.html).toContain(words["s14.life.proposal_same"]); expect(buttons(same.html)).toContain(words["s14.life.discard"]); expect(buttons(same.html).some(label => label.startsWith(words["s14.life.accept"]))).toBe(false);
  const bot = g.app.home(g.auth.actor).bots.find(item => item.id === "jit")!, proposal = g.app.botLifecycle.view(g.auth.actor, "jit").proposals[0]!;
  const other = g.app.execute(g.auth.actor, { kind: "bot.capabilities.propose", requestId: retryId(), expectedRevision: bot.revision, payload: { botId: "jit", capabilities: { tools: ["web_search"], resources: bot.capabilities.resources } } }).proposal!;
  g.app.execute(g.auth.actor, { kind: "bot.capabilities.accept", requestId: retryId(), expectedRevision: other.revision, payload: { proposalId: other.id, proposalHash: other.hash } });
  const stale = await g.page(`/team/jit/capabilities?proposal=${proposal.id}`);
  expect(buttons(stale)).not.toContain(words["s14.life.discard"]);
});

test.each(["th", "en"] as const)("%s run once now restates the captured scope and budget, posts without script and uses exactly one run", async language => {
  const g = await fixture(language), { words } = g;
  await g.enable(hostile, { schedule: "daily", time: "09:00", occurrences: "5", days: "20", reads: "12", minutes: "10", concurrent: "1" });
  const { routine } = g.routines()[0]!, html = await g.page(`/routines/${routine.id}`); safe(html, language);
  for (const value of [words["s14.routine.run_now_meta"], words["s14.routine.run_now_same"], words["s14.routine.run_now_left"].replace("{left}", "5"), words["s14.routine.run_now_next"], words["s14.routine.run_now_note"]]) expect(html).toContain(value);
  expect(html).toContain(`10 ${words["s14.time.minutes"]} · ${words["s14.grant.reads"]} 12`);
  expect(commandOf(html, "routine.run-now")).toMatchObject({ expectedRevision: routine.revision, payload: { routineId: routine.id } });
  expect(Object.keys(commandOf(html, "routine.run-now").payload)).toEqual(["routineId"]);
  const landed = await g.press(html, "routine.run-now");
  expect(landed.html).toContain(words["s14.routine.trigger.owner"]);
  expect(landed.path).toContain(`/routines/${routine.id}?receipt=`); expect(landed.html).toContain(words["s14.routine.done.run-now"]); expect(landed.html).toContain(words["s14.routine.done.run-now_detail"]);
  expect(g.routines()[0]!.routine.occurrencesRemaining).toBe(4);
  expect(g.routines()[0]!.history).toHaveLength(1);
  // A run is open, so the control steps aside and says why.
  expect(hasCommand(landed.html, "routine.run-now")).toBe(false); expect(landed.html).toContain(words["s14.routine.run_now_running"]);
  await g.f.app.authority.drain(); g.app.store.transaction(tx => g.app.routines.reconcile(tx));
  const next = await g.page(`/routines/${routine.id}`); expect(next).toContain(words["s14.routine.run_now_left"].replace("{left}", "4"));
  const repeat = await g.post("/s14/commands", { csrf: formFields(html, "/s14/commands").csrf!, command: JSON.stringify(commandOf(html, "routine.run-now")) });
  expect(repeat.status).toBe(303); expect(g.routines()[0]!.routine.occurrencesRemaining).toBe(4);
});

test("run once now warns on the last run and is absent for every state the service would refuse", async () => {
  const g = await fixture("en"), { words } = g;
  await g.enable("Last one", { schedule: "daily", time: "09:00", occurrences: "1" });
  const { routine } = g.routines()[0]!, last = await g.page(`/routines/${routine.id}`);
  expect(last).toContain(words["s14.routine.run_now_last"]); expect(last).toContain(words["s14.routine.run_now_left_last"]); expect(last).not.toContain(words["s14.routine.run_now_schedule"]);
  await g.press(last, "routine.run-now"); await g.f.app.authority.drain(); g.app.store.transaction(tx => g.app.routines.reconcile(tx));
  expect(g.routines()[0]!.routine.state).toBe("exhausted");
  const spent = await g.page(`/routines/${routine.id}`); safe(spent, "en"); expect(hasCommand(spent, "routine.run-now")).toBe(false);
  await g.enable("Paused one", { schedule: "daily", time: "09:00", occurrences: "3" });
  const open = g.routines().find(item => item.routine.state === "active")!.routine, active = await g.page(`/routines/${open.id}`); expect(hasCommand(active, "routine.run-now")).toBe(true);
  const paused = await g.press(active, "routine.pause"); expect(hasCommand(paused.html, "routine.run-now")).toBe(false);
  // Past its end date the capture is finished even before a tick marks it.
  const ended = g.app.execute(g.auth.actor, routineCommand(g.f, { recurrence: { kind: "weekly", day: 1, time: "09:00" }, endsAt: g.clock.now + 3600000 })).routine!;
  g.clock.now = ended.capture.command.payload.endsAt + 1;
  expect(hasCommand(await g.page(`/routines/${ended.id}`), "routine.run-now")).toBe(false);
});

test("a refused run keeps the owner on the routine with the cause in words", async () => {
  const g = await fixture("en"), { words } = g;
  const routine = g.app.execute(g.auth.actor, routineCommand(g.f, { recurrence: { kind: "weekly", day: 1, time: "09:00" } })).routine!;
  const html = await g.page(`/routines/${routine.id}`), csrf = formFields(html, "/s14/commands").csrf!;
  g.app.execute(g.auth.actor, { kind: "routine.pause", requestId: retryId(), expectedRevision: routine.revision, payload: { routineId: routine.id } });
  const refused = await g.land(await g.post("/s14/commands", { csrf, command: JSON.stringify(commandOf(html, "routine.run-now")) }));
  expect(refused.status).toBe(409); expect(refused.html).toContain(words["s14.error.stale_revision"]); expect(refused.html).toContain(`href="/routines/${routine.id}"`);
  for (const key of ["routine_running", "routine_not_ready", "routine_not_revoked", "routine_fenced"]) { expect(words[`s14.error.${key}` as keyof typeof words]).toBeTruthy(); expect(words[`s14.next.${key}` as keyof typeof words]).toBeTruthy(); }
});

test.each(["th", "en"] as const)("%s weekly recurrence reviews, enables and reopens with its day, time and zone", async language => {
  const g = await fixture(language), { words } = g, form = await g.page("/routines/new"); safe(form, language);
  expect(form).toContain('name="schedule" value="weekly"'); expect(form).toContain(words["s14.routine.every_week"]); expect(form).toContain(words["s14.routine.weekly_note"]);
  expect([...form.matchAll(/<select name="day">([\s\S]*?)<\/select>/g)][0]![1]!.match(/<option value="(\d)"/g)!.map(item => item.match(/\d/)![0])).toEqual(["1", "2", "3", "4", "5", "6", "0"]);
  expect(form).toMatch(/<option value="1" selected>/);
  const { review, landed } = await g.enable("Weekly digest", { schedule: "weekly", day: "0", weekTime: "07:30", timezone: "America/New_York", occurrences: "4", days: "60" });
  safe(review, language);
  expect(review).toContain(words["s14.routine.weekly.0"]); expect(review).toContain("07:30"); expect(review).toContain("America/New_York");
  expect(formFields(review, "/s14/forms/routine-enable")).toMatchObject({ schedule: "weekly", day: "0", weekTime: "07:30" });
  expect(landed.status).toBe(200);
  const { routine } = g.routines()[0]!;
  expect(routine.capture.command.payload).toMatchObject({ recurrence: { kind: "weekly", day: 0, time: "07:30" }, timezone: "America/New_York" });
  const detail = await g.page(`/routines/${routine.id}`); safe(detail, language);
  expect(detail).toContain(words["s14.routine.weekly.0"]); expect(detail).not.toContain("&quot;kind&quot;:&quot;weekly&quot;");
  expect(await g.page("/routines")).toContain(words["s14.routine.next"]);
  // Editing and reopening from the old capture keep every typed value.
  const edit = await g.land(await g.post("/s14/forms/routine-edit", formFields(review, "/s14/forms/routine-enable")));
  expect(edit.html).toMatch(/name="schedule" value="weekly" checked/); expect(edit.html).toMatch(/<option value="0" selected>/); expect(edit.html).toContain('name="weekTime" value="07:30"');
  const again = await g.page(`/routines/new?from=${routine.id}`);
  expect(again).toMatch(/name="schedule" value="weekly" checked/); expect(again).toMatch(/<option value="0" selected>/); expect(again).toContain('name="weekTime" value="07:30"');
});

test("a weekly form with a forged day or no time comes back with the cause and the typing", async () => {
  const g = await fixture("en"), { words } = g, form = "/s14/forms/routine-preview", fields = { ...formFields(await g.page("/routines/new"), form), purpose: "Keep this text", schedule: "weekly" };
  for (const changes of [{ day: "7" }, { weekTime: "" }, { day: "<script>" }]) {
    const refused = await g.post(form, { ...fields, ...changes }), html = await refused.text();
    expect(refused.status).toBe(400); safe(html, "en");
    expect(html).toContain(words["s14.error.invalid_routine_schedule"]); expect(html).toContain("Keep this text"); expect(html).toMatch(/name="schedule" value="weekly" checked/);
  }
  expect(g.routines()).toHaveLength(0);
});

test.each(["th", "en"] as const)("%s a revoked routine is deleted through its own slip, and work stays", async language => {
  const g = await fixture(language), { words } = g;
  await g.enable("Delete me", { schedule: "interval", hours: "1", occurrences: "9" });
  await g.run();
  const { routine } = g.routines()[0]!, workBefore = g.app.authority.list(g.auth.actor).length;
  const active = await g.page(`/routines/${routine.id}`);
  expect(active).not.toContain("confirm=delete"); expect(hasCommand(await g.page(`/routines/${routine.id}?confirm=delete`), "routine.delete")).toBe(false);
  const revoked = await g.press(active, "routine.revoke");
  expect(revoked.html).toContain(`/routines/${routine.id}?confirm=delete#slip`); expect(hasCommand(revoked.html, "routine.delete")).toBe(false);
  const slip = await g.page(`/routines/${routine.id}?confirm=delete`); safe(slip, language);
  for (const value of [words["s14.routine.delete_meta"], words["s14.routine.delete_does_1"], words["s14.routine.delete_not_1"], words["s14.routine.delete_free"], words["s14.routine.delete_keep"]]) expect(slip).toContain(value);
  expect(slip).toContain('id="slip" tabindex="-1" data-focus-on-load');
  const landed = await g.press(slip, "routine.delete");
  expect(landed.path).toMatch(/^\/routines\?receipt=/); expect(landed.html).toContain(words["s14.routine.done.delete"]); expect(landed.html).toContain(words["s14.routine.done.delete_detail"]); safe(landed.html, language);
  expect(g.routines()).toHaveLength(0); expect(g.app.authority.list(g.auth.actor)).toHaveLength(workBefore);
  expect((await g.get(`/routines/${routine.id}`)).status).toBe(404);
  expect(await g.page("/routines?receipt=forged")).not.toContain(words["s14.routine.done.delete"]);
});

test("delete waits for open decisions, so they cannot leave Needs you unanswered", async () => {
  const g = await fixture("en", { state: "ready", text: '{"outcome":"no_update","proposals":[{"title":"Open finding","purpose":"Decide this","completionRule":"Owner review"}]}' }), { words } = g;
  await g.enable("Finding routine", { schedule: "interval", hours: "1", occurrences: "9" });
  await g.run();
  const { routine } = g.routines()[0]!;
  await g.press(await g.page(`/routines/${routine.id}`), "routine.revoke");
  const slip = await g.page(`/routines/${routine.id}?confirm=delete`); safe(slip, "en");
  expect(slip).toContain(words["s14.routine.delete_hold"]); expect(hasCommand(slip, "routine.delete")).toBe(false); expect(slip).toContain(words["s14.routine.delete_keep"]);
});

/** Installs a vault and a scripted `git ls-remote`, so the real broker path runs with no network and no repository code. */
function broker(g: Awaited<ReturnType<typeof fixture>>, output = `printf '%s\\trefs/heads/main\\n' '${sha}'`) {
  g.app.git.options.vault = new ConnectionVault(join(realpathSync(g.root), "vault"), { forbidden: [g.path] });
  const seen: { token: boolean; calls: number } = { token: false, calls: 0 };
  g.app.coding.options.gitLimits = { createDirectory: () => mkdtempSync(join(g.root, "broker-")), async command(_directory, argv) {
    seen.calls++; expect(argv).toContain("ls-remote"); expect(argv.join(" ")).not.toContain(token);
    return ["/bin/sh", "-c", `test "$JIT_GIT_EFFECT_TOKEN" = '${token}' && ${output}`];
  } };
  return seen;
}

test.each(["th", "en"] as const)("%s a private repository is connected, granted and pinned from its branch without a pasted commit", async language => {
  const g = await fixture(language, undefined, true), { words } = g, seen = broker(g);
  const grant = await g.page("/coding/new"); safe(grant, language);
  for (const key of ["s14.coding.private_title", "s14.coding.private_lead", "s14.coding.private_connect"] as const) expect(grant).toContain(words[key]);
  const first = await g.page("/coding/connect"); safe(first, language);
  expect(first).toContain(words["s14.coding.connect_meta"]); expect(first).toContain(words["s14.coding.connect.step.token"]); expect(first).toContain('class="s-steps"');
  const stored = await g.submit(first, "/s14/forms/git-slot-connection", { label: "<img src=x onerror=alert(1)>" });
  expect(stored.path).toMatch(/^\/coding\/connect\?connection=/); safe(stored.html, language);
  expect(stored.html).toContain('type="password"'); expect(stored.html).toContain(words["s14.coding.connect_token_note"]); expect(g.app.coding.repositories(g.auth.actor)).toHaveLength(0);
  const ready = await g.submit(stored.html, "/s14/forms/git-secret", { secret: token });
  expect(ready.path).toMatch(/^\/coding\/new\?connection=/); safe(ready.html, language); expect(ready.html).not.toContain(token);
  expect(ready.html).toContain(words["s14.coding.connect_ready"]); expect(ready.html).toContain(words["s14.coding.base_branch_note"]); expect(ready.html).toContain(words["s14.coding.connection_fixed"]);
  // The grant names the stored token and the slot, and only the broker read fills in the commit.
  const form = "/s14/forms/coding-grant", fields = formFields(ready.html, form);
  expect(fields.connection).toMatch(/^[a-f0-9-]+:2$/); expect(fields.receiver).toBe("jit:resource1");
  const granted = await g.submit(ready.html, form, { url: "https://github.com/fixture/private", baseCommit: "main" });
  expect(granted.path).toMatch(/^\/coding\/repositories\/resource1\?receipt=/); safe(granted.html, language); expect(granted.html).toContain(sha); expect(granted.html).not.toContain(token);
  expect(seen.calls).toBe(1); expect(g.app.coding.repositories(g.auth.actor)[0]).toMatchObject({ baseCommit: sha, url: "https://github.com/fixture/private.git" });
  expect(g.app.authority.list(g.auth.actor)).toEqual([]);
  // The same token now sits under the repository and can repin it.
  for (const key of ["s14.coding.pin_title", "s14.coding.pin_note", "s14.coding.pin_submit"] as const) expect(granted.html).toContain(words[key]);
  const newer = "d".repeat(40); seen.calls = 0; broker(g, `printf '%s\\trefs/heads/next\\n' '${newer}'`);
  const pinned = await g.submit(granted.html, "/s14/forms/coding-repin", { branch: "next" });
  expect(pinned.path).toMatch(/^\/coding\/repositories\/resource1\?receipt=/); expect(pinned.html).toContain(words["s14.coding.done.coding_repository_resolve"]); expect(pinned.html).toContain(newer); safe(pinned.html, language);
  expect(g.app.coding.repositories(g.auth.actor)[0]).toMatchObject({ baseCommit: newer, revision: 2 });
});

test("a refused private read returns to its locked form with the typing and no token", async () => {
  const g = await fixture("en", undefined, true), { words } = g; broker(g, "false");
  const stored = await g.submit(await g.page("/coding/connect"), "/s14/forms/git-slot-connection");
  const ready = await g.submit(stored.html, "/s14/forms/git-secret", { secret: token });
  const form = "/s14/forms/coding-grant", response = await g.post(form, { ...formFields(ready.html, form), url: "https://github.com/fixture/private", baseCommit: "main" }), html = await response.text();
  expect(response.status).toBe(409); safe(html, "en"); expect(html).not.toContain(token);
  expect(html).toContain(words["s14.error.coding_branch_unavailable"]); expect(html).toContain(words["s14.coding.base_branch_note"]); expect(html).toContain('value="https://github.com/fixture/private"'); expect(html).toContain('value="main"'); expect(html).toContain('name="connection"');
  expect(g.app.coding.repositories(g.auth.actor)).toHaveLength(0);
});

test("a full commit needs no read, a removed token offers a fresh start, and a repin shows its own refusal", async () => {
  const g = await fixture("en", undefined, true), { words } = g, seen = broker(g);
  const stored = await g.submit(await g.page("/coding/connect"), "/s14/forms/git-slot-connection");
  // A refused token comes back empty and on the same step.
  const refused = await g.post("/s14/forms/git-secret", { ...formFields(stored.html, "/s14/forms/git-secret"), secret: "short" }), html = await refused.text();
  expect(refused.status).toBe(400); expect(html).toContain(words["s14.error.invalid_connection_secret"]); expect(html).toContain('type="password"'); expect(html).not.toContain('value="short"');
  const ready = await g.submit(html, "/s14/forms/git-secret", { secret: token });
  const list = await g.page("/coding/new"); expect(list).toContain(words["s14.coding.private_use"]);
  const connect = await g.page(`/coding/connect?connection=${g.app.git.connections(g.auth.actor)[0]!.id}`);
  const removed = await g.submit(connect, "/s14/forms/git-slot-remove");
  expect(removed.path).toBe("/coding/new"); expect(removed.html).not.toContain(words["s14.coding.private_use"]);
  const old = await g.land(await g.get(ready.path)); expect(old.html).toContain(words["s14.coding.connect_gone"]); expect(old.html).not.toContain(words["s14.coding.base_branch_note"]);
  const again = await g.submit(await g.page("/coding/connect"), "/s14/forms/git-slot-connection"), held = await g.submit(again.html, "/s14/forms/git-secret", { secret: token });
  const granted = await g.submit(held.html, "/s14/forms/coding-grant", { url: "https://github.com/fixture/private", baseCommit: sha });
  expect(seen.calls).toBe(0); expect(g.app.coding.repositories(g.auth.actor)[0]).toMatchObject({ baseCommit: sha });
  broker(g, "false");
  const bad = await g.post("/s14/forms/coding-repin", { ...formFields(granted.html, "/s14/forms/coding-repin"), branch: "gone" }), page = await bad.text();
  expect(bad.status).toBe(409); safe(page, "en"); expect(page).toContain(words["s14.error.coding_branch_unavailable"]); expect(page).toContain('value="gone"');
  expect(g.app.coding.repositories(g.auth.actor)[0]).toMatchObject({ baseCommit: sha, revision: 1 });
});

test("a repository with no stored token explains the pin instead of offering it, and public grants keep their own slot", async () => {
  const g = await fixture("en", undefined, true), { words } = g; broker(g);
  g.app.execute(g.auth.actor, { kind: "coding.repository.grant", requestId: retryId(), expectedRevision: 0, payload: { id: "resource1", botId: "jit", url: "https://github.com/fixture/public.git", baseCommit: sha } });
  const page = await g.page("/coding/repositories/resource1"); safe(page, "en");
  expect(page).toContain(words["s14.coding.pin_need_token"]); expect(page).not.toContain("/s14/forms/coding-repin");
  expect(await g.page("/coding/connect")).toContain(words["s14.coding.no_receiver"]);
});

test("a slot held by two Bots keeps the Bot chosen on the first step, and a forged Bot only widens the choice", async () => {
  const g = await fixture("en", undefined, true), { words } = g; broker(g);
  const other = await secondBot(g.f), first = await g.page("/coding/connect");
  expect(first.match(/name="receiver"/g)).toHaveLength(2);
  const stored = await g.submit(first, "/s14/forms/git-slot-connection", { receiver: `${other.id}:resource1` });
  expect(stored.path).toContain(`&bot=${other.id}`);
  const ready = await g.submit(stored.html, "/s14/forms/git-secret", { secret: token });
  expect(ready.path).toContain(`&bot=${other.id}`); expect(ready.html).not.toContain(words["s14.coding.which_bot"]);
  expect(formFields(ready.html, "/s14/forms/coding-grant").receiver).toBe(`${other.id}:resource1`);
  const id = g.app.git.connections(g.auth.actor)[0]!.id, forged = await g.page(`/coding/new?connection=${id}&bot=${encodeURIComponent('"><script>alert(1)</script>')}`);
  safe(forged, "en"); expect(forged).toContain(words["s14.coding.which_bot"]);
  const required = await g.post("/s14/forms/coding-grant", { ...formFields(forged, "/s14/forms/coding-grant"), url: "https://github.com/fixture/private", baseCommit: "main" });
  expect(required.status).toBe(400); expect(g.app.coding.repositories(g.auth.actor)).toHaveLength(0);
});

test("hostile Bot and label text stays escaped on the connect and grant pages", async () => {
  const g = await fixture("en", undefined, true); broker(g);
  const stored = await g.submit(await g.page("/coding/connect"), "/s14/forms/git-slot-connection", { label: "Label &lt;b&gt;" });
  expect(stored.html).toContain("Label &amp;lt;b&amp;gt;");
  safe(await g.page("/coding/new"), "en"); safe(await g.page("/coding/connect"), "en");
});

test("setup and stage lists no longer share a class, and each page gets its own rail", async () => {
  const text = await new Response(lookupS14Asset(new URL(s14AssetUrl("s14.css"), origin).pathname)!.body).text();
  expect(text).toMatch(/\.s-setup-steps \{ display: flex; gap: 4px;/);
  const stage = text.match(/^\.s-steps \{[^}]*\}$/gm)!;
  expect(stage).toHaveLength(1); expect(stage[0]).toContain("flex-direction: column");
  expect(text).not.toMatch(/^\.s-setup-steps \{[^}]*flex-direction/m);
});

test("a public grant cannot take the only slot held by a pending private token, including forged JSON", async () => {
  const g = await fixture("en", undefined, true), { words } = g; broker(g);
  const stored = await g.submit(await g.page("/coding/connect"), "/s14/forms/git-slot-connection");
  await g.submit(stored.html, "/s14/forms/git-secret", { secret: token });
  const before = g.app.git.connections(g.auth.actor);
  const page = await g.page("/coding/new");
  expect(page).toContain(words["s14.coding.no_receiver"]);
  expect(page).not.toContain('value="jit:resource1"');
  const payload = { id: "resource1", botId: "jit", url: "https://github.com/fixture/public.git", baseCommit: sha };
  expect(() => g.app.execute(g.auth.actor, { kind: "coding.repository.grant", requestId: retryId(), expectedRevision: 0, payload })).toThrow("coding_slot_reserved");
  await expect(g.app.coding.execute(g.auth.actor, { kind: "coding.repository.grant", requestId: retryId(), expectedRevision: 0,
    payload: { id: payload.id, botId: payload.botId, url: payload.url, baseBranch: "main" } })).rejects.toThrow("coding_slot_reserved");
  expect(g.app.coding.repositories(g.auth.actor)).toHaveLength(0);
  expect(g.app.git.connections(g.auth.actor)).toEqual(before);
  g.app.execute(g.auth.actor, { kind: "git.connection.remove", requestId: retryId(), expectedRevision: before[0]!.revision, payload: { connectionId: before[0]!.id } });
  expect(await g.page("/coding/new")).toContain('value="jit:resource1"');
  g.app.execute(g.auth.actor, { kind: "coding.repository.grant", requestId: retryId(), expectedRevision: 0, payload });
  expect(g.app.coding.repositories(g.auth.actor)).toHaveLength(1);
});

test("an old unresolved failure retains Dismiss after more than 100 resolved notices", async () => {
  const g = await fixture("en", failing);
  await g.enable("Old failure", { schedule: "interval", hours: "1", occurrences: "9" });
  await g.run();
  const old = g.app.attention.view(g.auth.actor).items[0]!;
  g.store.transaction(tx => {
    for (let i = 0; i < 110; i++) {
      g.app.attention.commit(tx, { groupId: `newer_resolved_${i}`, class: "needs_owner", reason: "routine_failed", workId: null, proposalIds: [] });
      tx.run("UPDATE attention_notices SET record_json=json_set(record_json,'$.resolvedAt',1) WHERE group_id=?", `newer_resolved_${i}`);
    }
  });
  for (const path of ["/work", `/routines/${g.routines()[0]!.routine.id}`]) {
    const html = await g.page(path), fields = formFields(html, dismissAction);
    expect(fields.noticeId).toBe(old.id);
    if (path.startsWith("/routines/")) expect(html).toContain(g.words["s14.routine.trigger.schedule"]);
  }
});

test("an old open finding remains actionable on both routine pages beyond the history window", async () => {
  const g = await fixture("en", { state: "ready", text: '{"outcome":"no_update","proposals":[{"title":"Old open finding","purpose":"Decide this","completionRule":"Owner review"}]}' });
  await g.enable("Finding routine", { schedule: "interval", hours: "1", occurrences: "9" });
  await g.run();
  const id = g.routines()[0]!.routine.id, original = g.app.routines.view(g.auth.actor, id).history[0]!;
  g.store.transaction(tx => {
    for (let i = 0; i < 60; i++) tx.run("INSERT INTO routine_occurrences VALUES (?,?,NULL,?)", `quiet_${i}`, id,
      JSON.stringify({ ...original, id: `quiet_${i}`, routineId: id, state: "complete", outcome: "no_update", proposals: [], createdAt: g.clock.now }));
  });
  expect(g.app.routines.view(g.auth.actor, id).history).toHaveLength(50);
  for (const path of ["/routines", `/routines/${id}`]) {
    const html = await g.page(path);
    expect(html).toContain("Old open finding");
    expect(html).toContain('id="findings"');
    expect(hasCommand(html, "task.reject")).toBe(true);
  }
  const finding = g.app.routines.findings(g.auth.actor, id)[0]!.work;
  g.app.execute(g.auth.actor, { kind: "task.reject", requestId: retryId(), expectedRevision: finding.revision, payload: { taskId: finding.id } });
  expect(g.app.routines.findings(g.auth.actor, id)).toHaveLength(0);
});

test("a pending Git slot blocks every resource claimant while its selected connection can continue", async () => {
  const g = await fixture("en", undefined, true); broker(g);
  await g.submit(await g.page("/coding/connect"), "/s14/forms/git-slot-connection");
  const connection = g.app.git.connections(g.auth.actor)[0]!;
  expect(g.app.sharing.freeSlots(g.auth.actor).some(slot => slot.scopeId === connection.repositoryId)).toBe(false);
  const { resourceSlotConflict } = await import("../src/s14/share-slots");
  g.store.read(tx => {
    for (const claimant of ["snapshot_share", "share", "personal_grant", "coding_repository"] as const)
      expect(resourceSlotConflict(tx, connection.repositoryId, claimant)).toBe(true);
    expect(resourceSlotConflict(tx, connection.repositoryId, "coding_repository", connection.id)).toBe(false);
    expect(resourceSlotConflict(tx, connection.repositoryId, "coding_repository", "wrong_connection")).toBe(true);
  });
  const share = { kind: "snapshot.share" as const, requestId: retryId(), expectedRevision: g.app.home(g.auth.actor).bots[0]!.revision,
    payload: { scopeId: connection.repositoryId, target: { kind: "source" as const, id: "absent", revision: 1, generation: 1 }, receiverBotId: "jit", workId: null, expiresAt: g.clock.now + 60000 } };
  expect(() => g.app.execute(g.auth.actor, share)).toThrow("snapshot_share_exists");
  g.app.execute(g.auth.actor, { kind: "git.connection.remove", requestId: retryId(), expectedRevision: connection.revision, payload: { connectionId: connection.id } });
  expect(g.app.sharing.freeSlots(g.auth.actor).some(slot => slot.scopeId === connection.repositoryId)).toBe(true);
});
