import { afterEach, expect, test } from "bun:test";
import { dictionaries } from "../src/i18n";
import { AppError } from "../src/errors";
import { artifactHash } from "../src/s14/artifacts";
import { evidenceTargets } from "../src/s14/web-product-team";
import { accessibilityProblems } from "./fixtures/a11y";
import { claim, gate, report, rid, teamFixture, type TeamFixture } from "./fixtures/s14-team";

/**
 * Team progress, work defaults and report surfaces (#251 TEAM14-01, #252 REPORT14-01): every state comes from the real
 * scheduler and report handler through the authenticated handler, and every form is submitted the way a browser without
 * script submits it, reading its fields out of the HTML.
 */
const open: TeamFixture[] = [];
afterEach(() => { for (const f of open.splice(0)) f.close(); });
const fixture = async (options: Parameters<typeof teamFixture>[0] = {}) => { const f = await teamFixture(options); open.push(f); return f; };
const en = dictionaries.en, th = dictionaries.th;
const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const formsFor = (html: string, action: string) => [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(m => m[0]).filter(f => f.includes(`action="${action}"`));
function fields(form: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const input of form.matchAll(/<input\b[^>]*>/g)) {
    const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(input[0])?.[1], key = attr("name");
    if (!key || (/type="(checkbox|radio)"/.test(input[0]) && !/\schecked/.test(input[0]))) continue;
    out[unescape(key)] = unescape(attr("value") ?? "");
  }
  for (const area of form.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) out[area[1]!] = unescape(area[2]!);
  return out;
}
const commands = (html: string, kind: string) => formsFor(html, "/s14/commands").map(fields).filter(item => JSON.parse(item.command!).kind === kind);
const text = (html: string) => unescape(html.replace(/<head>[\s\S]*?<\/head>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
const strict = (html: string, locale: "th" | "en" = "en") => { expect(html).not.toMatch(/\sstyle="/); expect(html).not.toMatch(/\son[a-z]+="/); expect(accessibilityProblems(html, locale)).toEqual([]); };
const follow = async (f: TeamFixture, response: Response) => { expect(response.status).toBe(303); const location = response.headers.get("location")!; return location.startsWith("/s14/receipts/") ? f.get(location) : response; };
const ok = () => ({ state: "ready" as const, text: "Committed evidence" });

test.each(["en", "th"] as const)("%s claim coverage declarations stay labelled as Bot claims when source coverage is insufficient", async language => {
  const f = await fixture({ language });
  const work = await reported(f, async a => {
    const source = (await f.app.parallel.read(a.id, "web_fetch", { url: "https://example.com/article", fullContent: false })).evidence[0]!;
    return report([claim(a, source, { citations: [{ attemptId: a.id, id: source.id, revision: 1, quote: source.content, scope: "excerpt" }], covers: ["full_page"] })]);
  }, { requiredEvidence: [{ id: "full_page", label: "Required full page", url: null, coverage: "full_content_returned", freshness: "any" }] });
  const view = f.app.reports.list(f.auth.actor, work.id)[0]!;
  expect(view.state).toBe("available");
  if (view.state !== "available") throw Error("report unavailable");
  expect(view.report).toMatchObject({ state: "ready_for_review", coverage: "partial", covered: [] });
  expect(view.report.claims[0]).toMatchObject({ support: "supported", covers: ["full_page"] });
  const html = await f.page(`/work/${work.id}?tab=report`), body = text(html);
  expect(body).toContain(language === "en" ? "Bot claims to address: Required full page" : "Bot อ้างว่าตอบ: Required full page");
  expect(body).toContain(dictionaries[language]["s14.report.state.ready_for_review"]);
  expect(body).not.toContain("Meets:");
  strict(html, language);
});
const barCount = (html: string, kind: string) => [...html.matchAll(new RegExp(`class="s-bar-${kind}"`, "g"))].length;

/** Three Bots under a limit of 2: two truly running, one queued, the synthesis waiting on them. */
async function overlapping(f: TeamFixture) {
  const jit = gate(), scout = gate(), analyst = gate();
  f.scripts.lanes = { "jit:research": jit.run(ok), scout: scout.run(ok), analyst: analyst.run(ok) };
  const work = f.start(), pending = f.app.authority.drain();
  await Promise.all([jit.entered, scout.entered]);
  return { work, pending, jit, scout, analyst };
}
async function settle(run: Awaited<ReturnType<typeof overlapping>>) { run.jit.release(); run.scout.release(); run.analyst.release(); await run.pending; }

test("running lanes state real overlap, the limit, the queue and the dependency wait, with bars only from recorded intervals", async () => {
  const f = await fixture(), run = await overlapping(f);
  f.clock.now += 90000;
  const html = await f.page(`/work/${run.work.id}`), body = text(html);
  expect(body).toContain(`2 ${en["s14.team.working_many"]} · ${en["s14.team.limit"]} 2 · 1 ${en["s14.team.count_queued"]} · 1 ${en["s14.team.count_waiting"]}`);
  expect(barCount(html, "run")).toBe(2);
  expect(html.match(/<svg class="s-tl-track"/g)).toHaveLength(4);
  for (const word of [en["s14.step_state.running"], en["s14.step_state.queued"], en["s14.step_state.waiting_evidence"]]) expect(body).toContain(word);
  expect(body).toContain(`${en["s14.team.waiting_on"]} Jit · ${en["s14.step_handler.research"]} · Scout · Analyst`);
  expect(body).toContain(`${en["s14.timeline.overlap"]} 1 ${en["s14.time.min"]} 30 ${en["s14.time.sec"]}`);
  expect(body).toContain(en["s14.timeline.not_recorded"]);
  expect(body).toContain(en["s14.usage.actual"]); expect(html).toContain("s-unknown-bar");
  expect(body).toContain(`${en["s14.usage.reserved"]} 0 ${en["s14.usage.of"]} 40`);
  expect(html).toContain('data-live="true"'); strict(html);
  await settle(run);
});

test("lanes and timeline never invent a run: pending lanes draw only their recorded phases, and no run recorded says so", async () => {
  const f = await fixture(), work = f.start();
  f.clock.now += 30000;
  const html = await f.page(`/work/${work.id}`), body = text(html);
  expect(body).toContain(en["s14.team.working_none"]); expect(body).toContain(en["s14.timeline.none"]);
  expect(barCount(html, "run")).toBe(0); expect(barCount(html, "done")).toBe(0);
  expect(barCount(html, "queued")).toBe(3); expect(barCount(html, "waiting")).toBe(1);
  expect(body).toContain(en["s14.step_state.queued"]); expect(body).not.toContain(en["s14.timeline.overlap"]); strict(html);
});

test("queued and waiting phases come from recorded starts, stay after the lane moves on and never count as run time", async () => {
  const f = await fixture(), started = f.clock.now, run = await overlapping(f);
  f.clock.now += 90000;
  const live = await f.page(`/work/${run.work.id}`), body = text(live), steps = f.steps(run.work.id);
  expect(steps.map(step => [step.queuedAt, step.waitingAt])).toEqual([[started, null], [started, null], [started, null], [null, started]]);
  // Two lanes admitted at once queued for no recorded time, so only the held lane and the dependent lane show a phase.
  expect(live.match(/<rect class="s-bar-queued"[^>]*>/g)).toEqual(['<rect class="s-bar-queued" x="0" y="3" width="1000" height="6"/>']);
  expect(live.match(/<line class="s-bar-waiting"[^>]*>/g)).toEqual(['<line class="s-bar-waiting" x1="0" x2="1000" y1="6" y2="6"/>']);
  expect(barCount(live, "run")).toBe(2);
  expect(body).toContain(`${en["s14.timeline.overlap"]} 1 ${en["s14.time.min"]} 30 ${en["s14.time.sec"]}`);
  for (const key of ["s14.timeline.key_waiting", "s14.timeline.key_queued", "s14.timeline.col_waited", "s14.timeline.col_queued"] as const) expect(body).toContain(en[key]);
  expect(body).toContain(`08:00:00 UTC · ${en["s14.timeline.so_far"]} 1 ${en["s14.time.min"]} 30 ${en["s14.time.sec"]}`);
  f.clock.now += 30000; await settle(run);
  const done = await f.page(`/work/${run.work.id}`), table = text(done), lanes = f.steps(run.work.id);
  expect(lanes.map(step => step.state)).toEqual(["committed", "committed", "committed", "committed"]);
  expect(lanes[2]).toMatchObject({ queuedAt: started, startedAt: started + 120000 });
  expect(lanes[3]).toMatchObject({ waitingAt: started, queuedAt: started + 120000 });
  // Phase starts remain recorded; each closed phase now ends at the observation after it, not at the page's clock.
  f.clock.now += 600000;
  const later = await f.page(`/work/${run.work.id}`);
  expect(barCount(later, "queued")).toBe(1); expect(barCount(later, "waiting")).toBe(1); expect(later).not.toContain("s-tl-now");
  expect(later).toContain('class="s-bar-queued" x="0" y="3" width="1000"');
  expect(table).toContain(`2 ${en["s14.time.min"]}`); expect(table).not.toContain(en["s14.timeline.so_far"]); strict(later);
});

test("a lane cancelled before it ran marks where its phase began and never stretches that phase to now", async () => {
  const f = await fixture(), run = await overlapping(f), lane = f.steps(run.work.id)[2]!;
  f.app.execute(f.auth.actor, { kind: "work.step.stop", requestId: rid(), expectedRevision: lane.revision, payload: { workId: run.work.id, stepId: lane.id } });
  f.clock.now += 60000;
  const html = await f.page(`/work/${run.work.id}`), body = text(html);
  expect(f.steps(run.work.id)[2]).toMatchObject({ state: "cancelled", startedAt: null, settledAt: null });
  expect(barCount(html, "open")).toBe(1); expect(barCount(html, "queued")).toBe(0);
  expect(body).toContain(en["s14.timeline.end_not_recorded"]);
  expect(html.match(/class="s-tl-now"/g)).toHaveLength(3);
  await settle(run);
});

test("a stopped run keeps its outline and gains a cap, so it never reads as a queue", async () => {
  const f = await fixture(), run = await overlapping(f), lane = f.steps(run.work.id)[1]!;
  f.app.execute(f.auth.actor, { kind: "work.step.stop", requestId: rid(), expectedRevision: lane.revision, payload: { workId: run.work.id, stepId: lane.id } });
  f.clock.now += 1000; await settle(run);
  const html = await f.page(`/work/${run.work.id}`);
  expect(barCount(html, "stopped")).toBe(1); expect(barCount(html, "cap")).toBe(1);
});

test("the Thai timeline and lane name the phases and the holding ceiling in Thai", async () => {
  const f = await fixture({ language: "th" }), run = await overlapping(f);
  f.clock.now += 5000;
  const html = await f.page(`/work/${run.work.id}`), body = text(html);
  for (const key of ["s14.timeline.key_waiting", "s14.timeline.key_queued", "s14.timeline.col_waited"] as const) expect(body).toContain(th[key]);
  expect(body).toContain(`${th["s14.team.held_work"]}: 2`); strict(html, "th");
  await settle(run);
});

test.each(["global", "route", "bot", "computer"] as const)("a queued lane names the %s ceiling holding it, and only then", async ceiling => {
  const f = await fixture({ scheduler: { global: 4, route: 4, bot: 4, computer: 4, [ceiling]: 1 } });
  const first = f.start({ bots: [{ id: "jit", revision: 1 }], tools: ["computer"] });
  const work = f.start({ bots: [{ id: ceiling === "bot" ? "jit" : "scout", revision: 1 }], tools: ["computer"] });
  const attempt = f.app.authority.admit(first.id, rid(), { botId: "jit", tools: ["computer"], scopes: [], input: "Hold capacity", calls: 1, outputBytes: 100 });
  const held = await f.page(`/work/${work.id}`), body = text(held), word = en[`s14.team.held_${ceiling}`];
  expect(f.app.graph.view(f.auth.actor, work.id).steps[0]!.queueCeiling).toBe(ceiling);
  expect(body).toContain(ceiling === "computer" ? `${word}.` : `${word}: 1.`); expect(body).toContain(en["s14.step_line.queued"]); strict(held);
  f.app.authority.settle(attempt.id);
  const free = text(await f.page(`/work/${work.id}`));
  expect(free).not.toContain("Held by"); expect(free).toContain(en["s14.step_line.queued_free"]);
});

test("a queued lane held by the grant says this work's limit, and a queue never reads as a fault", async () => {
  const f = await fixture(), run = await overlapping(f), html = await f.page(`/work/${run.work.id}`), body = text(html);
  expect(body).toContain(`${en["s14.team.held_work"]}: 2. ${en["s14.step_line.queued"]}`);
  expect(body).not.toContain("Capacity is full");
  await settle(run);
});

test("a step stops by a no-script post: stopping until it settles, the sibling keeps running, nothing replaces it", async () => {
  const f = await fixture(), run = await overlapping(f), html = await f.page(`/work/${run.work.id}`);
  const lanes = f.steps(run.work.id), forms = commands(html, "work.step.stop");
  expect(forms).toHaveLength(4);
  const form = forms.find(item => JSON.parse(item.command!).payload.stepId === lanes[1]!.id)!;
  expect(JSON.parse(form.command!)).toMatchObject({ kind: "work.step.stop", expectedRevision: lanes[1]!.revision, payload: { workId: run.work.id, stepId: lanes[1]!.id } });
  const landed = await follow(f, await f.post("/s14/commands", form));
  expect(landed.status).toBe(303); expect(landed.headers.get("location")).toBe(`/chats/${f.conversationId}?work=${run.work.id}#latest`);
  const stopping = await f.page(`/work/${run.work.id}`), body = text(stopping);
  expect(body).toContain(en["s14.step_state.stopping"]); expect(body).toContain(en["s14.step_line.stopping"]); expect(body).toContain(`1 ${en["s14.team.count_stopping"]}`);
  expect(barCount(stopping, "stopping")).toBe(1); expect(commands(stopping, "work.step.stop")).toHaveLength(3);
  expect(f.steps(run.work.id)[1]!.settledAt).toBeNull();
  f.clock.now += 4000; await settle(run);
  const after = await f.page(`/work/${run.work.id}`), done = text(after);
  expect(done).toContain(en["s14.step_state.cancelled"]); expect(done).toContain(en["s14.step_line.cancelled"]);
  expect(barCount(after, "stopped")).toBe(1);
  expect(f.steps(run.work.id)[0]!.state).toBe("committed");
  expect(f.app.authority.view(f.auth.actor, run.work.id).results.some(result => result.text === "late")).toBe(false);
});

test("a stale lane form is refused and leads back to the work", async () => {
  const f = await fixture(), run = await overlapping(f), html = await f.page(`/work/${run.work.id}`), form = commands(html, "work.step.stop")[1]!;
  const lane = f.steps(run.work.id)[1]!;
  f.app.execute(f.auth.actor, { kind: "work.step.stop", requestId: rid(), expectedRevision: lane.revision, payload: { workId: run.work.id, stepId: lane.id } });
  const refused = await f.post("/s14/commands", form), page = await refused.text();
  expect(refused.status).toBe(409); expect(page).toContain(en["s14.error.stale_revision"]); expect(page).toContain(`/work/${run.work.id}`);
  await settle(run);
});

test("sibling failure names what was kept, and the finished work reads partial next to ready, never complete", async () => {
  const f = await fixture();
  f.scripts.lanes = { "scout:research": async () => { throw new AppError("quota_exceeded"); } };
  const work = f.start({ bots: [{ id: "jit", revision: 1 }, { id: "scout", revision: 1 }] });
  await f.app.authority.drain();
  const html = await f.page(`/work/${work.id}`), body = text(html);
  expect(body).toContain(en["s14.team.sibling_title"]); expect(body).toContain(`${en["s14.team.sibling_broken"]} Scout`); expect(body).toContain(en["s14.team.sibling_kept"]);
  expect(body).toContain(en["s14.step_state.failed"]); expect(body).toContain(en["s14.reason.quota_exceeded"]); expect(html).toContain("quota_exceeded");
  expect(html.match(/class="s-bar-mark"/g)).toHaveLength(1);
  expect(body).toContain(`${en["s14.work_state.ready"]} · ${en["s14.report.coverage.partial"]}`);
  expect(body).toContain(en["s14.work.no_report_yet"]);
  expect(body).not.toMatch(/\bcomplete\b/i);
  const list = await f.page("/work"); expect(text(list)).toContain(en["s14.work_state.ready"]);
  const chat = await f.page(`/chats/${f.conversationId}`); expect(text(chat)).toContain(en["s14.report.coverage.partial"]); strict(html);
});

test("stopping the whole work holds the words until open calls settle, then keeps committed evidence", async () => {
  const f = await fixture(), run = await overlapping(f);
  f.app.execute(f.auth.actor, { kind: "work.stop", requestId: rid(), expectedRevision: f.app.authority.view(f.auth.actor, run.work.id).work.revision, payload: { workId: run.work.id } });
  const stopping = text(await f.page(`/work/${run.work.id}`));
  expect(stopping).toContain(en["s14.work_state.stopping"]); expect(stopping).toContain(en["s14.work.stopping_detail"]);
  await settle(run);
  const stopped = text(await f.page(`/work/${run.work.id}`));
  expect(stopped).toContain(en["s14.work_state.stopped"]); expect(stopped).toContain(en["s14.work.stopped_kept"]);
  expect(stopped).not.toContain(en["s14.team.sibling_title"]);
});

test("the Bot dot follows its own lane, so only Bots really running read as working", async () => {
  const f = await fixture(), run = await overlapping(f), team = await f.page("/team");
  const stateOf = (name: string) => new RegExp(`<b>${name}</b>[\\s\\S]*?class="s-pill ">(?:<span[^>]*>[^<]*</span>)?([^<]+)<`).exec(team)?.[1];
  expect(stateOf("Scout")).toBe(en["s14.bot_state.working"]); expect(stateOf("Analyst")).toBe(en["s14.bot_state.queued"]);
  await settle(run);
});

test("work defaults start at the owner-confirmed values, save by no-script post and reach only future start forms", async () => {
  const f = await fixture(), before = f.start({ bots: [{ id: "jit", revision: 1 }] }), html = await f.page("/settings/work");
  const form = formsFor(html, "/s14/forms/work-defaults")[0]!, values = fields(form);
  expect(values).toMatchObject({ concurrent: "2", minutes: "30", reads: "40", expectedRevision: "1" }); strict(html);
  const response = await f.post("/s14/forms/work-defaults", { ...values, concurrent: "3", minutes: "45", reads: "12" });
  expect(response.status).toBe(303); expect(response.headers.get("location")).toMatch(/^\/settings\/work\?receipt=/);
  expect(text(await f.page(response.headers.get("location")!))).toContain(en["s14.defaults.saved"]);
  expect(f.app.graph.defaults(f.auth.actor)).toEqual({ id: "work", revision: 2, concurrency: 3, wallMs: 2700000, reads: 12 });
  expect(f.app.authority.view(f.auth.actor, before.id).grant!.limits).toMatchObject({ concurrency: 2, wallMs: 1800000, reads: 40 });
  const compose = fields(formsFor(await f.page(`/chats/${f.conversationId}`), "/s14/forms/compose")[0]!);
  expect(compose).toMatchObject({ concurrent: "3", minutes: "45", reads: "12" });
  const started = await f.post("/s14/forms/compose", { ...compose, text: "Check three vendors", work: "on", concurrent: "", minutes: "", reads: "" });
  expect(started.status).toBe(303);
  const latest = f.app.authority.list(f.auth.actor).find(item => item.title === "Check three vendors")!;
  expect(f.app.authority.view(f.auth.actor, latest.id).grant!.limits).toMatchObject({ concurrency: 3, wallMs: 2700000, reads: 12 });
});

test("defaults: a stale form shows the fresh saved values, an out-of-range form keeps the typed ones, unknown fields refuse", async () => {
  const f = await fixture(), values = fields(formsFor(await f.page("/settings/work"), "/s14/forms/work-defaults")[0]!);
  f.app.execute(f.auth.actor, { kind: "work.defaults.set", requestId: rid(), expectedRevision: 1, payload: { concurrency: 5, wallMs: 600000, reads: 9 } });
  const stale = await f.post("/s14/forms/work-defaults", { ...values, concurrent: "4" }), page = await stale.text();
  expect(stale.status).toBe(409); expect(page).toContain(en["s14.error.stale_revision"]); expect(fields(formsFor(page, "/s14/forms/work-defaults")[0]!)).toMatchObject({ concurrent: "5", minutes: "10", reads: "9", expectedRevision: "2" });
  const fresh = fields(formsFor(page, "/s14/forms/work-defaults")[0]!);
  const range = await f.post("/s14/forms/work-defaults", { ...fresh, reads: "999" }), rangePage = await range.text();
  expect(range.status).toBe(400); expect(rangePage).toContain(en["s14.error.s14_limit_out_of_range"]); expect(fields(formsFor(rangePage, "/s14/forms/work-defaults")[0]!).reads).toBe("999");
  expect((await f.post("/s14/forms/work-defaults", { ...fresh, extra: "1" })).status).toBe(400);
  expect(f.app.graph.defaults(f.auth.actor).revision).toBe(2);
});

test("owner evidence lines become exact targets; a URL line asks for the full page and a blank box sends none", async () => {
  expect(evidenceTargets("\n Power draw \n https://example.com/spec \n")).toEqual([
    { id: "target_1", label: "Power draw", url: null, coverage: "snippet", freshness: "any" },
    { id: "target_2", label: "https://example.com/spec", url: "https://example.com/spec", coverage: "full_content_returned", freshness: "any" }]);
  const f = await fixture(), compose = fields(formsFor(await f.page(`/chats/${f.conversationId}`), "/s14/forms/compose")[0]!);
  await f.post("/s14/forms/compose", { ...compose, text: "With targets", work: "on", evidence: "Power draw\nhttps://example.com/spec" });
  const fresh = fields(formsFor(await f.page(`/chats/${f.conversationId}`), "/s14/forms/compose")[0]!);
  await f.post("/s14/forms/compose", { ...fresh, text: "Without targets", work: "on" });
  const grant = (title: string) => f.app.authority.view(f.auth.actor, f.app.authority.list(f.auth.actor).find(item => item.title === title)!.id).grant!;
  expect(grant("With targets").command.payload.requiredEvidence!.map(target => target.label)).toEqual(["Power draw", "https://example.com/spec"]);
  expect(Object.hasOwn(grant("Without targets").command.payload, "requiredEvidence")).toBe(false);
  const tab = text(await f.page(`/work/${f.app.authority.list(f.auth.actor).find(item => item.title === "With targets")!.id}?tab=grant`));
  expect(tab).toContain("Power draw"); expect(tab).toContain(`${en["s14.grant.concurrency"]} 2`);
});

/** One Bot, one committed report revision per script. */
async function reported(f: TeamFixture, build: Parameters<typeof scripted>[1], changes: Parameters<TeamFixture["start"]>[0] = {}) {
  const work = f.start({ bots: [{ id: "jit", revision: 1 }], ...changes });
  await scripted(f, build);
  return work;
}
async function scripted(f: TeamFixture, build: (attempt: import("../src/s14/authority-types").Attempt) => Promise<import("../src/s14/report-types").ReportProposal>) {
  f.scripts.lanes = { jit: async attempt => ({ state: "ready", text: "Done", report: await build(attempt) }) };
  await f.app.authority.drain();
}

test("no committed report reads as none, even when the result text says done", async () => {
  const f = await fixture(); f.scripts.lanes = { jit: async () => ({ state: "ready", text: "All done, report.md is complete" }) };
  const work = f.start({ bots: [{ id: "jit", revision: 1 }] }); await f.app.authority.drain();
  const body = text(await f.page(`/work/${work.id}?tab=report`));
  expect(body).toContain(en["s14.report.none"]); expect(body).toContain(en["s14.report.none_detail"]); expect(body).not.toContain(en["s14.report.fact_coverage"]);
});

test("ready for review, coverage, missing evidence and owner review are four separate facts, and none reads as complete", async () => {
  const f = await fixture();
  const work = await reported(f, async a => report([claim(a, await f.read(a))], { missing: ["Vendor B page unread"], limitations: ["Prices are a week old"] }));
  const html = await f.page(`/work/${work.id}?tab=report`), body = text(html);
  for (const key of ["s14.report.fact_state", "s14.report.fact_coverage", "s14.report.fact_missing", "s14.report.fact_review"] as const) expect(body).toContain(en[key]);
  expect(body).toContain(en["s14.report.state.ready_for_review"]); expect(body).toContain(en["s14.report.coverage.partial"]); expect(body).toContain(en["s14.report.completion.owner_review_required"]);
  expect(body).toContain(en["s14.report.note_partial"]); expect(body).toContain(en["s14.report.miss.rule"]);
  expect(body).toContain("Vendor B page unread"); expect(body).toContain("Prices are a week old");
  expect(body.replace(en["s14.report.note_partial"], "")).not.toMatch(/\bcomplete\b/i);
  expect(html.indexOf(en["s14.report.coverage_title"])).toBeLessThan(html.indexOf(en["s14.report.claims"]));
  strict(html);
});

test("covered still says the work is not closed; targets met and missing are named in the owner's words", async () => {
  const f = await fixture(), url = "https://example.com/article";
  const met = await reported(f, async a => report([claim(a, await f.read(a), { covers: ["page"] })]), { requiredEvidence: [{ id: "page", label: "Maker's page", url, coverage: "full_content_returned", freshness: "any" }] });
  const covered = text(await f.page(`/work/${met.id}?tab=report`));
  expect(covered).toContain(en["s14.report.coverage.covered"]); expect(covered).toContain(en["s14.report.note_covered"]); expect(covered).toContain("Maker's page"); expect(covered).toContain(en["s14.report.completion.owner_review_required"]);
  const gap = await reported(f, async a => report([claim(a, await f.read(a))]), { requiredEvidence: [{ id: "power", label: "Power at full load", url: null, coverage: "snippet", freshness: "any" }] });
  const short = text(await f.page(`/work/${gap.id}?tab=report`));
  expect(short).toContain(`${en["s14.report.miss.target"]} Power at full load`); expect(short).toContain(en["s14.report.coverage.partial"]);
});

test("claims link to the exact evidence row, and weakness, conflict and missing support are text flags", async () => {
  const f = await fixture();
  let sourceId = "";
  const work = await reported(f, async a => {
    const source = await f.read(a); sourceId = source.id;
    const cited = { attemptId: a.id, id: source.id, revision: source.revision, quote: "Returned full", scope: "excerpt" as const };
    return report([
      claim(a, source, { id: "first", text: "Alder costs less", kind: "inference", citations: [cited], conflicts: ["second"] }),
      claim(a, source, { id: "second", text: "Birch costs less", kind: "inference", citations: [cited], conflicts: ["first"] }),
      claim(a, source, { id: "third", text: "Draws 7 W", citations: [] }),
    ]);
  });
  const html = await f.page(`/work/${work.id}?tab=report`), body = text(html);
  expect(html).toContain(`href="/work/${work.id}?tab=evidence#source-${sourceId}"`);
  expect(body).toContain(en["s14.report.flag.conflicting"]); expect(body).toContain(en["s14.report.flag.unsupported"]); expect(body).toContain(en["s14.report.flag.cached_reported"]);
  expect(body).toContain(en["s14.report.no_citation"]); expect(body).toContain(`${en["s14.report.conflicts_with"]} 2`); expect(body).toContain(`${en["s14.report.conflicts_with"]} 1`);
  expect(body).toContain("Alder costs less"); expect(body).toContain("Birch costs less");
  expect(html).toContain('href="#claim-third"'); expect(html).toContain('id="claim-third"');
  expect(await f.page(`/work/${work.id}?tab=evidence`)).toContain(`id="source-${sourceId}"`);
  strict(html);
  const pane = await f.page(`/chats/${f.conversationId}?work=${work.id}&tab=report`);
  expect(pane).toContain(`href="/chats/${f.conversationId}?work=${work.id}&amp;tab=evidence#source-${sourceId}"`); strict(pane);
});

test("revisions stay readable: the latest opens by default, an older one says so, a withdrawn one shows no payload", async () => {
  const f = await fixture();
  f.scripts.lanes = {
    "jit:research": async a => ({ state: "ready", text: "One", report: report([claim(a, await f.read(a))], { title: "First revision" }) }),
    "scout:research": async a => ({ state: "ready", text: "Two", report: report([claim(a, await f.read(a), { covers: [] })], { title: "Second revision" }) }),
  };
  const work = f.start({ bots: [{ id: "jit", revision: 1 }, { id: "scout", revision: 1 }] }); await f.app.authority.drain();
  const views = f.app.reports.list(f.auth.actor, work.id); expect(views).toHaveLength(2);
  const [first, second] = views.map(view => view.state === "available" ? view.report : null);
  const latest = await f.page(`/work/${work.id}?tab=report`);
  expect(text(latest)).toContain(`${en["s14.tab.report"]} r2`); expect(text(latest)).toContain(second!.title); expect(text(latest)).not.toContain(en["s14.report.older"]);
  expect(latest).toContain(`href="/work/${work.id}?tab=report&amp;report=${first!.id}"`);
  const older = text(await f.page(`/work/${work.id}?tab=report&report=${first!.id}`));
  expect(older).toContain(`${en["s14.report.older"]} r1`); expect(older).toContain(first!.title);
  expect(text(await f.page(`/work/${work.id}?tab=report&report=${"0".repeat(32)}`))).toContain(`${en["s14.tab.report"]} r2`);
  f.store.transaction(tx => { tx.run("UPDATE reports SET content_json=NULL WHERE id=?", second!.id); tx.run("UPDATE artifacts SET content=NULL WHERE report_id=?", second!.id); });
  const gone = await f.page(`/work/${work.id}?tab=report`), body = text(gone);
  expect(body).toContain(`${en["s14.report.withdrawn"]} r2`); expect(body).toContain(en["s14.report.withdrawn_detail"]); expect(body).not.toContain(second!.title);
  expect(gone).toContain(`report=${first!.id}`); strict(gone);
  const list = text(await f.page("/work")); expect(list).toContain(`${en["s14.tab.report"]} r1`);
});

test("downloads carry checksum, type and size, attach with no-store headers and refuse once withdrawn", async () => {
  const f = await fixture();
  const work = await reported(f, async a => report([claim(a, await f.read(a))]));
  const view = f.app.reports.list(f.auth.actor, work.id)[0]!; if (view.state !== "available") throw Error("unavailable");
  const html = await f.page(`/work/${work.id}?tab=report`);
  expect(view.artifacts.map(file => file.name)).toEqual(["report-r1.md", "evidence-r1.json"]);
  for (const file of view.artifacts) {
    expect(html).toContain(`/s14/artifacts/${file.id}/download`); expect(html).toContain(file.sha256); expect(html).toContain(file.mediaType); expect(text(html)).toContain(`${file.size} ${en["s14.report.bytes"]}`);
    const response = await f.get(`/s14/artifacts/${file.id}/download`), bytes = new Uint8Array(await response.arrayBuffer());
    expect(response.status).toBe(200); expect(artifactHash(bytes)).toBe(file.sha256); expect(bytes.length).toBe(file.size);
    expect(response.headers.get("content-type")).toBe(file.mediaType); expect(response.headers.get("content-length")).toBe(String(file.size));
    expect(response.headers.get("content-disposition")).toBe(`attachment; filename="${file.name}"`); expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff"); expect(response.headers.get("content-security-policy")).toStartWith("sandbox;");
    expect(response.headers.get("content-digest")).toBe(`sha-256=:${Buffer.from(file.sha256, "hex").toString("base64")}:`);
  }
  f.store.transaction(tx => tx.run("UPDATE artifacts SET content=NULL WHERE report_id=?", view.report.id));
  const refused = await f.get(`/s14/artifacts/${view.artifacts[0]!.id}/download`);
  expect(refused.status).toBeGreaterThanOrEqual(400); expect(await refused.text()).toContain(en["s14.error.artifact_unavailable"]);
});

test("hostile report and source text stays inert data: no markup, no links out, no authority control", async () => {
  const hostile = `<img src=x onerror=alert(1)><script>alert(2)</script><form action="/s14/commands"><button>Approve</button></form>[go](javascript:alert(3))`;
  const f = await fixture({ fullContent: `Page. ${hostile}` });
  const work = await reported(f, async a => {
    const source = await f.read(a);
    return report([claim(a, source, { id: "c1" }), claim(a, source, { id: "c2", text: hostile, kind: "inference" })], { title: `<script>alert(4)</script>`, missing: [hostile, "required_evidence:forged", "unsupported_claim:forged", "completion_rule_not_machine_verified_forged"], limitations: [hostile] });
  });
  const baseline = await f.page(`/work/${work.id}?tab=grant`), forms = (html: string) => html.match(/<form\b/g)?.length ?? 0;
  for (const path of [`/work/${work.id}?tab=report`, `/work/${work.id}?tab=evidence`, `/chats/${f.conversationId}?work=${work.id}&tab=report`]) {
    const html = await f.page(path), main = html.slice(html.indexOf("<main"));
    expect(main).not.toContain("<img src=x"); expect(main).not.toContain("<script>"); expect(main).not.toContain('<form action="/s14/commands">'); expect(main).not.toContain('href="javascript:'); expect(main).not.toContain("<button>Approve");
    expect(main).toContain("&lt;img src=x onerror=alert(1)&gt;"); strict(html);
  }
  const report_ = await f.page(`/work/${work.id}?tab=report`);
  // The owner's own accept control is the only form a report adds, and it carries only service identities.
  expect(forms(report_)).toBeLessThanOrEqual(forms(baseline) + 1);
  expect(formsFor(report_, "/s14/commands").map(fields).map(item => JSON.parse(item.command!).kind)).toEqual(["report.review.accept"]);
  expect(commands(report_, "report.review.accept")[0]!.command).not.toContain("alert");
  expect([...report_.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1]).join(" ")).not.toContain("Approve");
  expect(report_.match(/href="https?:/g)).toBeNull();
  // Look-alike gap strings never become typed lines; they stay visible as Bot text.
  const coverage = report_.slice(report_.indexOf(en["s14.report.coverage_title"]));
  expect(coverage).toContain("required_evidence:forged"); expect(coverage).toContain("unsupported_claim:forged");
});

test("Forget preview names the report revisions and files it would withdraw", async () => {
  const f = await fixture();
  const remembered = f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision, payload: { conversationId: f.conversationId, text: "Report style memory" } }), ref = remembered.claim!;
  const work = await reported(f, async a => report([claim(a, await f.read(a))]));
  const view = f.app.reports.list(f.auth.actor, work.id)[0]!; if (view.state !== "available") throw Error("unavailable");
  const html = await f.page(`/memory/jit/claims/${ref.id}?revision=${ref.revision}&generation=${ref.generation}&action=forget`), body = text(html);
  expect(body).toContain(`${en["s14.memory.impact.files"]} 2`); expect(body).toContain(en["s14.memory.impact.reports_detail"]);
  expect(html).toContain(`href="/work/${work.id}?tab=report&amp;report=${view.report.id}"`); strict(html);
});

test("every new surface renders in both languages with no raw keys and valid accessible markup", async () => {
  for (const language of ["th", "en"] as const) {
    const f = await fixture({ language });
    const finished = await reported(f, async a => report([claim(a, await f.read(a))], { missing: ["gap"] }));
    const run = await overlapping(f); f.clock.now += 5000;
    const base = [`/work/${run.work.id}`, `/work/${run.work.id}?tab=report`, `/chats/${f.conversationId}?work=${run.work.id}`, `/work/${finished.id}?tab=report`, `/work/${finished.id}?tab=grant`, `/chats/${f.conversationId}?work=${finished.id}&tab=report`, "/settings/work", "/more", "/work", "/"];
    for (const path of base) {
      const response = await f.get(path), html = await response.text();
      expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toBe("private, no-store"); expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
      strict(html, language);
      const words = text(html);
      expect(words).not.toMatch(/\bs14\.[a-z_]+\.?/); expect(words).not.toMatch(/undefined|\[object|NaN/);
      if (language === "en") expect(words.replace(/เจ้าของ|ไทย/g, "")).not.toMatch(/[฀-๿]/);
    }
    await settle(run);
  }
});

test("dictionaries define every team and report key in both languages and the Thai words match the design vocabulary", () => {
  expect(th["s14.step_state.waiting_evidence"]).toBe("รอหลักฐาน"); expect(th["s14.step_state.queued"]).toBe("รอคิว"); expect(th["s14.report.state.ready_for_review"]).toBe("พร้อมตรวจ"); expect(th["s14.report.coverage.partial"]).toBe("ได้บางส่วน");
  for (const key of Object.keys(th)) if (/^s14\.(team|timeline|report|defaults|step_)/.test(key)) expect(en[key as keyof typeof en]).toBeTruthy();
  expect(`${en["s14.report.note_partial"]} ${en["s14.report.note_covered"]}`).toContain("not closed");
});


test("a lane stop from the conversation pane returns through its receipt to that conversation pane", async () => {
  const f = await fixture(), run = await overlapping(f);
  try {
    const pane = await f.page(`/chats/${f.conversationId}?work=${run.work.id}`), form = commands(pane, "work.step.stop")[1]!;
    const response = await f.post("/s14/commands", form), landed = await follow(f, response);
    const path = `/chats/${f.conversationId}?work=${run.work.id}#latest`;
    expect(landed.headers.get("location")).toBe(path);
    const returned = await f.page(path);
    expect(returned).toContain('data-pane="open"');
    expect(returned).toContain(en["s14.step_state.stopping"]);
    const replay = await follow(f, await f.post("/s14/commands", form));
    expect(replay.headers.get("location")).toBe(path);
  } finally { await settle(run); }
});

test("model text imitating real targets, claims and read IDs never becomes a service fact in the report UI", async () => {
  const f = await fixture(); let imitations: string[] = [];
  const work = await reported(f, async attempt => {
    const source = await f.read(attempt), reads = f.app.parallel.inspect(f.auth.actor, attempt.workId).reads;
    imitations = ["required_evidence:page", "unsupported_claim:c1", "conflicting_claim:c1", `read:${reads[0]!.id}:partial`, `missing_url:${source.url}`];
    return report([claim(attempt, source, { id: "c1", covers: ["page"] })], { missing: imitations });
  }, { requiredEvidence: [{ id: "page", label: "Maker's page", url: "https://example.com/article", coverage: "full_content_returned", freshness: "any" }] });
  const html = await f.page(`/work/${work.id}?tab=report`), body = text(html);
  for (const imitation of imitations) expect(body).toContain(imitation);
  for (const key of ["s14.report.miss.target", "s14.report.miss.unsupported", "s14.report.miss.conflict", "s14.report.miss.read", "s14.report.miss.url"] as const) expect(body).not.toContain(en[key]);
  expect(html).toContain('class="s-untrusted'); strict(html);
});

const accept = (html: string) => commands(html, "report.review.accept");
const buttonOf = (html: string) => /<form[^>]*action="\/s14\/commands"[^>]*>(?:(?!<\/form>)[\s\S])*?report\.review\.accept[\s\S]*?<button class="([^"]*)">([^<]*)<\/button>/.exec(html);

test("the accept control sends the exact review revision and report identity through a no-script post", async () => {
  const f = await fixture(), work = await reported(f, async a => report([claim(a, await f.read(a))], { missing: ["Vendor B page unread"] }));
  const html = await f.page(`/work/${work.id}?tab=report`), forms = accept(html);
  const review = await (await f.get(`/api/s14/work/${work.id}/report-review`)).json() as import("../src/s14/report-types").ReportReview;
  expect(review).toMatchObject({ workId: work.id, reportRevision: 1, completion: "owner_review_required", acceptance: null });
  expect(forms).toHaveLength(1); expect(Object.keys(forms[0]!).sort()).toEqual(["command", "csrf"]);
  const command = JSON.parse(forms[0]!.command!);
  expect(Object.keys(command).sort()).toEqual(["expectedRevision", "kind", "payload", "requestId"]);
  expect(command).toMatchObject({ kind: "report.review.accept", expectedRevision: review.revision, payload: { reportId: review.reportId, reportRevision: review.reportRevision } });
  expect(Object.keys(command.payload).sort()).toEqual(["reportId", "reportRevision"]);
  const body = text(html);
  expect(body).toContain(en["s14.report.review.accept_note"]); expect(body).toContain(`${en["s14.report.review.stays_partial"]} 2 ${en["s14.report.missing_count"]}`);
  expect(html.indexOf('id="s14-review"')).toBeGreaterThan(html.indexOf(en["s14.report.files"]));
  expect(html.indexOf('id="s14-review"')).toBeLessThan(html.indexOf('id="s14-revisions"'));
  expect(html).toContain('href="#s14-review"'); strict(html);
  const pane = await f.page(`/chats/${f.conversationId}?work=${work.id}&tab=report`);
  expect(accept(pane)).toHaveLength(1); expect(pane).toContain('id="s14-review"'); strict(pane);
});

test.each(["en", "th"] as const)("the %s control names the revision and partial, and no word of it reads as finishing the work", async language => {
  const f = await fixture({ language }), words = dictionaries[language], url = "https://example.com/article";
  const partial = await reported(f, async a => report([claim(a, await f.read(a))]));
  const label = buttonOf(await f.page(`/work/${partial.id}?tab=report`))!;
  expect(label[2]).toBe(`${words["s14.report.review.accept"]} r1 ${words["s14.report.review.as_partial"]}`); expect(label[1]).toBe("s-btn");
  const covered = await reported(f, async a => report([claim(a, await f.read(a), { covers: ["page"] })]), { requiredEvidence: [{ id: "page", label: "Maker's page", url, coverage: "full_content_returned", freshness: "any" }] });
  const whole = buttonOf(await f.page(`/work/${covered.id}?tab=report`))!;
  expect(whole[2]).toBe(`${words["s14.report.review.accept"]} r1`); expect(whole[1]).toBe("s-btn primary");
  for (const button of [label[2]!, whole[2]!]) expect(button).not.toMatch(/complete|done|close|finish|approve|เสร็จ|ครบ|ปิด|อนุมัติ/i);
});

test("accepting a partial report records that exact revision and leaves coverage, gaps, work and files alone", async () => {
  const f = await fixture(), work = await reported(f, async a => report([claim(a, await f.read(a))], { missing: ["Vendor B page unread"], limitations: ["Prices are a week old"] }));
  const before = f.app.reports.list(f.auth.actor, work.id)[0]!, workBefore = f.app.authority.view(f.auth.actor, work.id); if (before.state !== "available") throw Error("unavailable");
  const form = accept(await f.page(`/work/${work.id}?tab=report`))[0]!;
  const landed = await follow(f, await f.post("/s14/commands", form)), path = `/chats/${f.conversationId}?work=${work.id}&tab=report#latest`;
  expect(landed.headers.get("location")).toBe(path);
  const after = await f.page(path), body = text(after), review = f.app.reports.review(f.auth.actor, work.id);
  expect(review).toMatchObject({ completion: "owner_accepted", acceptance: { reportId: before.report.id, reportRevision: 1 } });
  expect(body).toContain(`${en["s14.report.review.accepted"]} r1`); expect(body).toContain(en["s14.report.review.accepted_at"]); expect(body).toContain(en["s14.report.review.clears"]);
  expect(body).not.toContain(en["s14.report.completion.owner_review_required"]);
  expect(body).toContain(en["s14.report.coverage.partial"]); expect(body).toContain(en["s14.report.note_partial"]); expect(body).toContain("Vendor B page unread"); expect(body).toContain(en["s14.report.miss.rule"]);
  expect(accept(after)).toEqual([]); expect(after).not.toContain('href="#s14-review"');
  const again = f.app.reports.list(f.auth.actor, work.id)[0]!; if (again.state !== "available") throw Error("unavailable");
  expect(again.report).toEqual(before.report); expect(again.artifacts).toEqual(before.artifacts);
  expect(f.app.authority.view(f.auth.actor, work.id).work).toEqual(workBefore.work);
  strict(after);
  // The browser's own retry of that one press lands on the same receipt and records nothing new.
  expect((await follow(f, await f.post("/s14/commands", form))).headers.get("location")).toBe(path);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM audit WHERE kind='report.review.accept'")!.n)).toBe(1);
});

/** Two lanes with the second report held back, so the owner can accept r1 before r2 arrives. */
async function superseded(f: TeamFixture) {
  const entered = Promise.withResolvers<void>(), hold = Promise.withResolvers<void>();
  f.scripts.lanes = {
    "jit:research": async a => ({ state: "ready", text: "One", report: report([claim(a, await f.read(a))], { title: "First revision" }) }),
    "scout:research": async a => { const source = await f.read(a); entered.resolve(); await hold.promise; return { state: "ready", text: "Two", report: report([claim(a, source)], { title: "Second revision" }) }; },
  };
  const work = f.start({ bots: [{ id: "jit", revision: 1 }, { id: "scout", revision: 1 }] }), pending = f.app.authority.drain();
  await entered.promise;
  while (!f.app.reports.list(f.auth.actor, work.id).length) await Bun.sleep(1);
  return { work, publish: async () => { hold.resolve(); await pending; } };
}

test("a new revision clears acceptance: the older one cannot be reviewed and the latest asks again", async () => {
  const f = await fixture(), run = await superseded(f), id = run.work.id;
  const form = accept(await f.page(`/work/${id}?tab=report`))[0]!;
  await f.post("/s14/commands", form);
  expect(text(await f.page(`/work/${id}?tab=report`))).toContain(`${en["s14.report.review.accepted"]} r1`);
  await run.publish();
  const latest = await f.page(`/work/${id}?tab=report`), body = text(latest), review = f.app.reports.review(f.auth.actor, id);
  expect(review).toMatchObject({ reportRevision: 2, completion: "owner_review_required", acceptance: null });
  expect(body).toContain(en["s14.report.completion.owner_review_required"]); expect(body).not.toContain(en["s14.report.review.accepted"]);
  expect(JSON.parse(accept(latest)[0]!.command!)).toMatchObject({ expectedRevision: review.revision, payload: { reportId: review.reportId, reportRevision: 2 } });
  const first = f.app.reports.list(f.auth.actor, id)[0]!; if (first.state !== "available") throw Error("unavailable");
  const older = await f.page(`/work/${id}?tab=report&report=${first.report.id}`), words = text(older);
  expect(words).toContain(en["s14.report.review.latest_only"]); expect(words).not.toContain(en["s14.report.completion.owner_review_required"]);
  expect(accept(older)).toEqual([]); expect(older).not.toContain('id="s14-review"'); strict(older);
});

test("a form left open across a new revision is refused and leads back to the report", async () => {
  const f = await fixture(), run = await superseded(f), id = run.work.id;
  const form = accept(await f.page(`/work/${id}?tab=report`))[0]!;
  await run.publish();
  const refused = await f.post("/s14/commands", form), page = await refused.text();
  expect(refused.status).toBe(409); expect(page).toContain(en["s14.error.stale_revision"]); expect(page).toContain(`href="/work/${id}?tab=report"`);
  expect(f.app.reports.review(f.auth.actor, id).acceptance).toBeNull();
});

test.each(["memory.forget", "memory.delete"] as const)("%s clears acceptance: the revision is withdrawn and offers no control", async kind => {
  const f = await fixture();
  const remembered = f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: f.app.conversation(f.auth.actor, f.conversationId).conversation.revision, payload: { conversationId: f.conversationId, text: "Report style memory" } });
  const work = await reported(f, async a => report([claim(a, await f.read(a))]));
  const form = accept(await f.page(`/work/${work.id}?tab=report`))[0]!;
  await f.post("/s14/commands", form);
  const accepted = await f.page(`/work/${work.id}?tab=report`);
  expect(text(accepted)).toContain(en["s14.report.review.clears"]);
  f.app.execute(f.auth.actor, { kind, requestId: rid(), expectedRevision: 1, payload: { claim: remembered.claim! } });
  const html = await f.page(`/work/${work.id}?tab=report`), body = text(html);
  expect(f.app.reports.review(f.auth.actor, work.id)).toMatchObject({ completion: "owner_review_required", acceptance: null });
  expect(body).toContain(`${en["s14.report.withdrawn"]} r1`); expect(body).toContain(en["s14.report.review.withdrawn"]);
  expect(body).not.toContain(`${en["s14.report.review.accepted"]} r1`); expect(accept(html)).toEqual([]); expect(html).not.toContain('id="s14-review"'); strict(html);
});

test("a withdrawn revision refuses a form left open, in words, with the way back to the report", async () => {
  const f = await fixture(), work = await reported(f, async a => report([claim(a, await f.read(a))]));
  const form = accept(await f.page(`/work/${work.id}?tab=report`))[0]!, view = f.app.reports.list(f.auth.actor, work.id)[0]!; if (view.state !== "available") throw Error("unavailable");
  f.store.transaction(tx => tx.run("UPDATE reports SET content_json=NULL WHERE id=?", view.report.id));
  const refused = await f.post("/s14/commands", form), page = await refused.text();
  expect(refused.status).toBe(409); expect(page).toContain(en["s14.error.report_unavailable"]); expect(page).toContain(`href="/work/${work.id}?tab=report"`);
});

test("the owner's accepted state renders in both languages with valid markup and no raw keys", async () => {
  for (const language of ["th", "en"] as const) {
    const f = await fixture({ language }), work = await reported(f, async a => report([claim(a, await f.read(a))]));
    await f.post("/s14/commands", accept(await f.page(`/work/${work.id}?tab=report`))[0]!);
    for (const path of [`/work/${work.id}?tab=report`, `/chats/${f.conversationId}?work=${work.id}&tab=report`]) {
      const html = await f.page(path), words = text(html);
      expect(words).toContain(`${dictionaries[language]["s14.report.review.accepted"]} r1`); expect(words).toContain(dictionaries[language]["s14.report.review.clears"]);
      expect(words).not.toMatch(/\bs14\.[a-z_]+\.?/); strict(html, language);
    }
  }
});

test.each(["en", "th"] as const)("the %s report separates gaps Jit recorded from gaps the Bot wrote, and labels the Bot's", async language => {
  const f = await fixture({ language }), words = dictionaries[language];
  const work = await reported(f, async a => report([claim(a, await f.read(a))], { missing: ["Vendor B page unread"] }), { requiredEvidence: [{ id: "power", label: "Power at full load", url: null, coverage: "snippet", freshness: "any" }] });
  const html = await f.page(`/work/${work.id}?tab=report`), body = text(html);
  const start = html.indexOf(`id="s14-coverage"`), block = html.slice(start, html.indexOf(`id="s14-claims"`));
  const frame = /<div class="s-untrusted">[\s\S]*?<\/div><ul[\s\S]*?<\/ul><\/div>/.exec(block)![0], service = block.replace(frame, "");
  expect(block).toContain(words["s14.report.missing_service"]);
  expect(frame).toContain(words["s14.report.missing_bot"]); expect(frame).toContain("Vendor B page unread"); expect(frame).not.toContain("Power at full load");
  expect(service).toContain("Power at full load"); expect(service).toContain(words["s14.report.miss.target"]); expect(service).not.toContain("Vendor B page unread");
  expect(body).toContain(`1 ${words["s14.report.missing_count"]}`); expect(body).toContain(`1 ${words["s14.report.missing_from_bot"]}`);
  strict(html, language);
});
