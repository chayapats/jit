import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { dictionaries } from "../src/i18n";
import type { CapabilityProposal } from "../src/s14/bot-lifecycle-types";
import type { NativeRecoveryPort } from "../src/s14/recovery-types";
import type { Bot } from "../src/s14/types";
import { canonical } from "../src/s14/validation";
import { s14StyleSheet } from "../src/s14/web-style";
import { accessibilityProblems } from "./fixtures/a11y";
import { gate, rid, teamFixture, type TeamFixture } from "./fixtures/s14-team";

/**
 * EVID14-01 S14-AC13 follow-ups: what a browser run found that the markup alone must keep true. Announcements sit in the
 * accessibility tree, a ceiling change clears by itself, and the main Bot's place under a run limit is visible before starting.
 */
const open: TeamFixture[] = [];
afterEach(() => { for (const f of open.splice(0)) f.close(); });
const fixture = async (language: "th" | "en" = "en") => { const f = await teamFixture({ language }); open.push(f); return f; };
const noNative: NativeRecoveryPort = { async open() { throw new Error("no native session in this fixture"); } };
const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const text = (html: string) => unescape(html.replace(/<head>[\s\S]*?<\/head>/, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " "));
const safe = (html: string, locale: "th" | "en") => { expect(accessibilityProblems(html, locale)).toEqual([]); expect(text(html)).not.toMatch(/\{[a-z]+\}/); };
function fields(html: string, action: string): Record<string, string> {
  const form = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(m => m[0]).find(item => item.includes(`action="${action}"`));
  if (!form) throw new Error(`no form ${action}`);
  const out: Record<string, string> = {};
  for (const input of form.matchAll(/<input\b[^>]*>/g)) {
    const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(input[0])?.[1], key = attr("name");
    if (!key || (/type="(checkbox|radio)"/.test(input[0]) && !/\schecked/.test(input[0]))) continue;
    out[unescape(key)] = unescape(attr("value") ?? "");
  }
  for (const area of form.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) out[area[1]!] = unescape(area[2]!);
  return out;
}
const scoutOf = (f: TeamFixture) => f.app.home(f.auth.actor).bots.find(bot => bot.id === "scout")!;
/** Accepts one ceiling change; the Bot stays closed until the drain settles it. */
function acceptCeiling(f: TeamFixture, bot: Bot = scoutOf(f)) {
  const { proposal } = f.app.execute(f.auth.actor, { kind: "bot.capabilities.propose", requestId: rid(), expectedRevision: bot.revision, payload: { botId: bot.id, capabilities: { tools: ["web_search"], resources: [] } } }) as unknown as { proposal: CapabilityProposal };
  f.app.execute(f.auth.actor, { kind: "bot.capabilities.accept", requestId: rid(), expectedRevision: proposal.revision, payload: { proposalId: proposal.id, proposalHash: proposal.hash } });
}

test.each(["th", "en"] as const)("%s a ceiling change closes the chat in words, keeps reading live and reopens it for the same Bot", async language => {
  const f = await fixture(language), words = dictionaries[language];
  acceptCeiling(f);
  const closed = await f.page("/chats/scoutchat"), landing = await f.page("/team/scout");
  expect(text(closed)).toContain(words["s14.life.chat_returning"].replace("{bot}", scoutOf(f).name));
  expect(closed).toContain(words["s14.life.chat_returning_detail"]);
  expect(closed).not.toContain(words["s14.life.chat_closed_detail"]);
  expect(closed).toContain('href="/team/scout"'); expect(closed).toContain("data-live"); expect(closed).toContain('id="s14-dock"');
  expect(closed).not.toContain("data-composer");
  expect(closed).toContain(words["s14.refresh"]); // The no-script way to see it reopen.
  expect(landing).toContain('id="s14-bot-overview"'); expect(landing).toContain(words["s14.bot.read_chat"]); expect(landing).toContain("data-live");
  safe(closed, language); safe(landing, language);
  await f.app.botLifecycle.drain(noNative);
  const reopened = await f.page("/chats/scoutchat"), bot = await f.page("/team/scout");
  expect(reopened).toContain("data-composer"); expect(reopened).toContain('data-sig="open"');
  expect(reopened).not.toContain(words["s14.life.chat_returning_detail"]); expect(reopened).not.toContain(words["s14.life.chat_closed"]);
  expect(reopened).not.toContain("data-live");
  expect(bot).toContain(words["s14.bot.direct"]); expect(bot).not.toContain(words["s14.bot.read_chat"]);
  safe(reopened, language); safe(bot, language);
});

test("a retired Bot's retained chat stays closed and points at the Bot, and a refused message keeps its text", async () => {
  const f = await fixture(), words = dictionaries.en, html = await f.page("/chats/scoutchat"), form = fields(html, "/s14/forms/compose");
  acceptCeiling(f); // The tab above is now stale: its post is refused while the Bot settles.
  const refused = await f.post("/s14/forms/compose", { ...form, text: "Keep these words" }), body = await refused.text();
  expect(refused.status).toBe(403);
  expect(body).toMatch(/<div role="alert">[\s\S]*?This Bot is disabled/); expect(body).toContain("Keep these words"); expect(body).toContain("data-composer");
  safe(body, "en");
  await f.app.botLifecycle.drain(noNative);
  const scout = scoutOf(f), preview = f.app.botLifecycle.preview(f.auth.actor, "scout", "retire");
  f.app.execute(f.auth.actor, { kind: "bot.retire", requestId: rid(), expectedRevision: scout.revision, payload: { botId: "scout", previewHash: preview.hash, retain: { history: true, evidence: true } } });
  await f.app.botLifecycle.drain(noNative);
  const retired = await f.page("/chats/scoutchat");
  expect(retired).toContain(words["s14.life.chat_closed"]); expect(retired).toContain(words["s14.life.chat_closed_detail"]);
  expect(retired).not.toContain(words["s14.life.chat_returning_detail"]); expect(retired).toContain('href="/team/scout"');
  expect(retired).not.toContain("data-composer"); expect(retired).not.toContain("data-live");
  safe(retired, "en");
});

test("the main Bot's own ceiling change keeps Home reading until it settles", async () => {
  const f = await fixture(), words = dictionaries.en;
  acceptCeiling(f, f.app.home(f.auth.actor).bots.find(bot => bot.id === "jit")!);
  const paused = await f.page("/");
  expect(paused).toContain(words["s14.life.main_paused"]); expect(paused).toContain("data-live"); expect(paused).toMatch(/id="s14-live">[\s\S]*?Jit is changing its ceiling/);
  await f.app.botLifecycle.drain(noNative);
  const home = await f.page("/");
  expect(home).not.toContain(words["s14.life.main_paused"]); expect(home).not.toContain("data-live");
});

test.each(["th", "en"] as const)("%s the grant says the chat's Bot takes a place before anything starts", async language => {
  const f = await fixture(language), words = dictionaries[language], html = await f.page(`/chats/${f.conversationId}`), jit = words["s14.jit"];
  const form = /<form class="s-composer[\s\S]*?<\/form>/.exec(html)![0];
  expect(form).toContain(`<legend>${words["s14.grant.bots_legend"]}</legend>`); expect(form).toContain(`<legend>${words["s14.grant.tools"]}</legend>`);
  expect(form).toContain(words["s14.grant.lead_fixed"]); expect(unescape(form)).toContain(words["s14.grant.places_note"].replaceAll("{bot}", jit));
  expect(unescape(form)).toContain(words["s14.composer.serial_note"]);
  expect(form).toMatch(/type="hidden" name="bot:jit"/); expect(form).not.toMatch(/type="checkbox" name="bot:jit"/); // Fixed, so it is a fact and not a choice.
  expect(form).toMatch(/type="checkbox" name="bot:scout"/); expect(form).toMatch(/type="checkbox" name="bot:analyst"/);
  safe(html, language);
  expect(await f.page("/settings/work")).toContain(words["s14.defaults.concurrent_note"]);
  const routine = await f.page("/routines/new"); expect(unescape(routine)).toContain(words["s14.routine.places_note"]); safe(routine, language);
});

test("a task start states the same limit, and the Bot of a direct chat is the one named", async () => {
  const f = await fixture(), words = dictionaries.en, conversation = f.app.conversation(f.auth.actor, "scoutchat").conversation;
  const html = await f.page(`/chats/${conversation.id}`), form = /<form class="s-composer[\s\S]*?<\/form>/.exec(html)![0], scout = scoutOf(f).name;
  expect(unescape(form)).toContain(words["s14.grant.places_note"].replaceAll("{bot}", scout));
  expect(form).toMatch(/type="hidden" name="bot:scout"/); expect(form).toMatch(/type="checkbox" name="bot:jit"/);
});

test("a queued lane names who holds the places, so waiting for its turn never reads as a fault", async () => {
  const f = await fixture(), words = dictionaries.en, first = gate(), second = gate();
  f.scripts.lanes = { scout: first.run(() => ({ state: "ready", text: "One" })), analyst: second.run(() => ({ state: "ready", text: "Two" })) };
  const work = f.start({ bots: [{ id: "jit", revision: 1 }, { id: "scout", revision: 1 }, { id: "analyst", revision: 1 }], limits: { attempts: 4, steps: 4, calls: 16, outputBytes: 262144, wallMs: 1800000, concurrency: 2, reads: 8 } }), pending = f.app.authority.drain();
  await Promise.all([first.entered, second.entered]);
  expect(f.steps(work.id).filter(step => step.state === "running").map(step => step.botId).sort()).toEqual(["analyst", "scout"]);
  const html = await f.page(`/work/${work.id}`);
  expect(text(html)).toContain(`${words["s14.team.places_used"]} Scout · Analyst`);
  safe(html, "en");
  first.release(); second.release(); await pending; await f.app.authority.drain();
  expect(await f.page(`/work/${work.id}`)).not.toContain(words["s14.team.places_used"]);
});

test.each(["th", "en"] as const)("%s saved and refused landings are in the accessibility tree", async language => {
  const f = await fixture(language), words = dictionaries[language], more = await f.page("/more");
  const saved = await f.post("/s14/forms/preferences", { ...fields(more, "/s14/forms/preferences") });
  const landed = await f.page(saved.headers.get("location")!);
  expect(landed).toMatch(new RegExp(`<div role="status"><div class="s-banner ok">[\\s\\S]*?${words["s14.more.saved"]}`));
  const missing = await f.get("/nowhere"), failure = await missing.text();
  expect(failure).toContain('class="s-notice-card" role="alert"'); safe(failure, language);
  const defaults = await f.page("/settings/work"), done = await f.post("/s14/forms/work-defaults", { ...fields(defaults, "/s14/forms/work-defaults") });
  expect(await f.page(done.headers.get("location")!)).toMatch(new RegExp(`<div role="status"><div class="s-banner ok">[\\s\\S]*?${words["s14.defaults.saved"]}`));
});

test("a vendor reset time is shown only when one was given, and unknown stays unknown", async () => {
  const f = await fixture(), words = dictionaries.en, gone = gate();
  f.scripts.lanes = { jit: gone.run(() => ({ state: "ready", text: "Done" })) };
  const work = f.start({ bots: [{ id: "jit", revision: 1 }] }), pending = f.app.authority.drain();
  await gone.entered;
  const attempt = f.app.authority.view(f.auth.actor, work.id).attempts[0]!, retryAt = f.clock.now + 90000;
  const quota = (id: string, value: number | null) => f.store.transaction(tx => tx.run("INSERT INTO web_reads VALUES (?,?,?)", id, attempt.id, canonical({ id, attemptId: attempt.id, workId: work.id, botId: "jit", requestId: id, tool: "web_search", mode: "anonymous", settingRevision: 1, subject: "public docs", outcome: "quota", dispatched: true, remoteRequests: 1, requestedAt: f.clock.now, finishedAt: f.clock.now, retryAt: value, usage: null, evidence: [], failures: [], missing: [], omittedResults: 0 })));
  quota("quota_known", retryAt); quota("quota_unknown", null);
  const html = await f.page(`/work/${work.id}?tab=evidence`), body = text(html);
  expect(body).toContain(words["s14.web_outcome.resets_at"]); expect(body).toContain(words["s14.web_outcome.quota_known_detail"]); expect(body).toContain(words["s14.web_outcome.quota_detail"]);
  expect(html).toContain(`<time datetime="${new Date(retryAt).toISOString()}">`);
  safe(html, "en");
  gone.release(); await pending;
});

test("the composer's focus and the states drawn with a background survive forced colours and a short screen", () => {
  const css = s14StyleSheet();
  expect(css).toContain(".s-composer:focus-within { border-color: var(--fg); box-shadow: 0 0 0 1px var(--fg); }");
  const forced = /@media \(forced-colors: active\) \{[\s\S]*?\n\}/.exec(css)![0];
  for (const rule of [".s-mode:has(input:checked)", ".s-composer:focus-within", ".s-link[aria-current=page]", ".s-worktabs a[aria-current=page]"]) expect(forced).toContain(rule);
  const short = /@media \(max-height: 480px\) \{[\s\S]*?\n\}/.exec(css)![0];
  expect(short).toContain(".s-hdr-t small { display: none; }"); expect(css).not.toMatch(/outline: none[^}]*\.s-mode/);
});

/** Runs the real enhancement script against a stub page and returns what one live read did. */
async function liveRead(options: { before: string; after: string; focused?: boolean }) {
  const source = readFileSync(new URL("../src/s14/web-enhance.js", import.meta.url), "utf8");
  const status = { textContent: "", dataset: { reply: "Reply" } };
  const dock = { id: "s14-dock", innerHTML: "Closed", className: "s-dock", dataset: { sig: options.before } as Record<string, string>, contains: () => !!options.focused, querySelector: () => null };
  const fresh = { id: "s14-dock", innerHTML: "Composer", className: "s-dock", dataset: { sig: options.after, announce: "This chat can take messages again" } as Record<string, string>, contains: () => false, querySelector: () => null };
  const wired: string[] = [], composer = { dataset: {} as Record<string, string>, querySelector: () => null };
  const page = (live: boolean, element: typeof dock | typeof fresh) => ({ documentElement: { dataset: {} }, body: {}, activeElement: {},
    getElementById: (id: string) => id === "s14-dock" ? element : id === "s-phase" ? status : null,
    querySelectorAll: (selector: string) => { if (selector === "[data-composer]" && element === dock && dock.innerHTML === "Composer") { wired.push("wired"); return [composer]; } return []; },
    querySelector: (selector: string) => selector === "[data-live]" && live ? {} : null });
  const ticks: Array<() => Promise<void>> = [];
  runInNewContext(source, { document: page(true, dock), location: { href: "http://localhost:3001/chats/fixture", hash: "" },
    DOMParser: class { parseFromString() { return page(false, fresh); } }, fetch: async () => ({ ok: true, text: async () => "fresh page" }),
    setTimeout: (tick: () => Promise<void>) => ticks.push(tick) });
  await ticks.shift()!();
  return { dock, status, ticks, wired };
}

test("a live read reopens the composer and says so, but never replaces it while it is unchanged or in use", async () => {
  const reopened = await liveRead({ before: "closed.stopping.active", after: "open" });
  expect(reopened.dock.innerHTML).toBe("Composer"); expect(reopened.dock.dataset.sig).toBe("open");
  expect(reopened.status.textContent).toBe("This chat can take messages again"); expect(reopened.wired).toEqual(["wired"]);
  expect(reopened.ticks).toHaveLength(0); // Settled, so the reads stop.
  const same = await liveRead({ before: "open", after: "open" });
  expect(same.dock.innerHTML).toBe("Closed"); expect(same.status.textContent).toBe("");
  const typing = await liveRead({ before: "closed.stopping.active", after: "open", focused: true });
  expect(typing.dock.innerHTML).toBe("Closed"); expect(typing.ticks).toHaveLength(1); // Deferred, and tried again.
});

test("the status line carries a pill's word and not its hidden glyph", async () => {
  const source = readFileSync(new URL("../src/s14/web-enhance.js", import.meta.url), "utf8");
  const status = { textContent: "", dataset: { reply: "Reply" } }, glyph = { remove() { pill.textContent = "Ready for review"; } }, pill = { textContent: "✓Ready for review", querySelector: (selector: string) => selector === "[aria-hidden]" ? glyph : null };
  const page = (live: boolean, word: unknown) => ({ documentElement: { dataset: {} }, body: {}, activeElement: {}, getElementById: (id: string) => id === "s-phase" ? status : null, querySelectorAll: () => [],
    querySelector: (selector: string) => selector === "[data-live]" && live ? {} : selector.includes(".s-pill") ? word : null });
  const ticks: Array<() => Promise<void>> = [];
  runInNewContext(source, { document: page(true, null), location: { href: "http://localhost:3001/work/fixture", hash: "" }, DOMParser: class { parseFromString() { return page(false, pill); } }, fetch: async () => ({ ok: true, text: async () => "fresh page" }), setTimeout: (tick: () => Promise<void>) => ticks.push(tick) });
  await ticks.shift()!();
  expect(status.textContent).toBe("Ready for review");
});

/** A form the way the enhancement sees it: named controls, one fold, and hidden fields it must never carry across. */
function fakeComposer(values: { text?: string; completion?: string; evidence?: string; concurrent?: string; work?: boolean; tools?: Record<string, boolean>; revision?: string; open?: boolean } = {}) {
  const control = (name: string, type: string, tagName: string, value: string, checked = false) => ({ name, type, tagName, value, checked });
  const fields = [control("expectedRevision", "hidden", "INPUT", values.revision ?? "4"), control("bot:jit", "hidden", "INPUT", values.revision ?? "4"), control("text", "textarea", "TEXTAREA", values.text ?? ""),
    control("completion", "text", "INPUT", values.completion ?? ""), control("evidence", "textarea", "TEXTAREA", values.evidence ?? ""), control("concurrent", "number", "INPUT", values.concurrent ?? "2"), control("work", "checkbox", "INPUT", "on", !!values.work),
    ...Object.entries(values.tools ?? {}).map(([tool, on]) => control(`tool:${tool}`, "checkbox", "INPUT", "on", on)), { name: "", type: "fieldset", tagName: "FIELDSET", value: "", checked: false }, { name: "", type: "submit", tagName: "BUTTON", value: "", checked: false }];
  const fold = { open: !!values.open };
  return { fields, fold, dataset: {} as Record<string, string>, elements: fields, field: (name: string) => fields.find(item => item.name === name)!,
    querySelector: (selector: string) => selector === "textarea" ? { addEventListener() {} } : null, querySelectorAll: (selector: string) => selector === "details" ? [fold] : [] };
}
type FakeComposer = ReturnType<typeof fakeComposer>;
/** One state of the chat foot: a composer, or the closed notice with its hidden held block. */
interface FakeFoot { sig: string; composer?: FakeComposer }
const heldBlock = () => { const text = { textContent: "" }; return { hidden: true, text, querySelector: (selector: string) => selector === "[data-draft-text]" ? text : null }; };
/** Drives the real script over stub pages: each read returns the next foot, so a test walks a Bot closing and reopening. */
async function dockJourney(start: FakeFoot, reads: FakeFoot[]) {
  const source = readFileSync(new URL("../src/s14/web-enhance.js", import.meta.url), "utf8");
  const status = { textContent: "", dataset: { reply: "Reply" } }, held = heldBlock(), foots = new Map<string, FakeFoot>([["start", start], ...reads.map((foot, index) => [`read-${index}`, foot] as const)]);
  let foot = start;
  const dock = { className: "s-dock", dataset: { sig: start.sig } as Record<string, string>, contains: () => false,
    set innerHTML(markup: string) { foot = foots.get(markup)!; }, get innerHTML() { return [...foots].find(([, item]) => item === foot)![0]; },
    querySelector: (selector: string) => selector === "[data-composer]" ? foot.composer ?? null : selector === "[data-draft-held]" && !foot.composer ? held : null };
  let index = 0;
  const parsed = (read: number) => ({ documentElement: { dataset: {} }, body: {}, activeElement: {}, querySelectorAll: () => [], querySelector: (selector: string) => selector === "[data-live]" && read < reads.length - 1 ? {} : null,
    getElementById: (id: string) => id === "s14-dock" ? { innerHTML: `read-${read}`, className: "s-dock", dataset: { sig: reads[read]!.sig, announce: "Announce", kept: "Kept" } as Record<string, string> } : null });
  const ticks: Array<() => Promise<void>> = [], stored: unknown[] = [];
  runInNewContext(source, { document: { documentElement: { dataset: {} }, body: {}, activeElement: {}, getElementById: (id: string) => id === "s14-dock" ? dock : id === "s-phase" ? status : null,
    querySelectorAll: (selector: string) => selector === "[data-composer]" && foot.composer ? [foot.composer] : [], querySelector: (selector: string) => selector === "[data-live]" ? {} : null },
    location: { href: "http://localhost:3001/chats/fixture", hash: "" }, DOMParser: class { parseFromString() { return parsed(index++); } },
    fetch: async (_url: string, init?: { method?: string; body?: unknown }) => { if (init?.method && init.method !== "GET") stored.push(init.body); return { ok: true, text: async () => "fresh page" }; },
    setTimeout: (tick: () => Promise<void>) => ticks.push(tick), localStorage: new Proxy({}, { get() { throw new Error("draft text must stay in page memory"); } }) });
  for (const _ of reads) await ticks.shift()!();
  return { dock, held, status, foot: () => foot, stored };
}

test("a composer that leaves and returns keeps the draft and selected options, on the fresh form's own revisions", async () => {
  const typed = fakeComposer({ text: "Compare the two quotes", completion: "A short table", evidence: "https://example.com/a", concurrent: "3", work: true, tools: { web_search: false, web_fetch: true }, open: true });
  const back = fakeComposer({ revision: "9", tools: { web_search: true, web_fetch: true } });
  const run = await dockJourney({ sig: "open", composer: typed }, [{ sig: "closed.stopping.active" }, { sig: "open", composer: back }]);
  expect(run.dock.dataset.sig).toBe("open"); expect(run.foot().composer).toBe(back);
  expect(back.field("text").value).toBe("Compare the two quotes"); expect(back.field("completion").value).toBe("A short table"); expect(back.field("evidence").value).toBe("https://example.com/a");
  expect(back.field("concurrent").value).toBe("3"); expect(back.field("work").checked).toBe(true); expect(back.field("tool:web_search").checked).toBe(false); expect(back.field("tool:web_fetch").checked).toBe(true); expect(back.fold.open).toBe(true);
  expect(back.field("expectedRevision").value).toBe("9"); expect(back.field("bot:jit").value).toBe("9"); // A kept draft never carries a stale revision.
  expect(run.status.textContent).toBe("Kept"); expect(run.stored).toEqual([]);
});

test("while the composer is gone the draft stays readable, including when the chat never reopens", async () => {
  const typed = fakeComposer({ text: "Do not lose this\nsecond line", evidence: "https://example.com/a" });
  const closing = await dockJourney({ sig: "open", composer: typed }, [{ sig: "closed.stopping.retired" }, { sig: "closed.retired.retired" }]);
  expect(closing.foot().composer).toBeUndefined(); expect(closing.held.hidden).toBe(false);
  expect(closing.held.text.textContent).toBe("Do not lose this\nsecond line\n\nhttps://example.com/a"); expect(closing.status.textContent).toBe("Kept"); expect(closing.stored).toEqual([]);
});

test("an untouched composer shows no held block, and options alone still come back", async () => {
  const blank = await dockJourney({ sig: "open", composer: fakeComposer() }, [{ sig: "closed.stopping.active" }]);
  expect(blank.held.hidden).toBe(true); expect(blank.status.textContent).toBe("Announce");
  const back = fakeComposer();
  const options = await dockJourney({ sig: "open", composer: fakeComposer({ work: true }) }, [{ sig: "closed.stopping.active" }, { sig: "open", composer: back }]);
  expect(back.field("work").checked).toBe(true); expect(options.held.hidden).toBe(true); expect(options.status.textContent).toBe("Announce");
});

test("text the service refused to send survives the reopening read that replaces its composer", async () => {
  const refused = fakeComposer({ text: "Keep these words", work: true }), back = fakeComposer();
  await dockJourney({ sig: "closed.stopping.active", composer: refused }, [{ sig: "open", composer: back }]);
  expect(back.field("text").value).toBe("Keep these words"); expect(back.field("work").checked).toBe(true);
});

test("a tool the ceiling no longer offers is never ticked back, and the closed foot renders only an empty block", async () => {
  const back = fakeComposer({ tools: { web_fetch: false } });
  await dockJourney({ sig: "open", composer: fakeComposer({ text: "Draft", tools: { computer: true, web_fetch: true } }) }, [{ sig: "closed.stopping.active" }, { sig: "open", composer: back }]);
  expect(back.fields.some(item => item.name === "tool:computer")).toBe(false); expect(back.field("tool:web_fetch").checked).toBe(true);
  const f = await fixture(); acceptCeiling(f);
  const html = await f.page("/chats/scoutchat"), block = /<div data-draft-held hidden>[\s\S]*?<\/div>/.exec(html)![0];
  expect(block).toContain("<pre"); expect(block).toMatch(/data-draft-text[^>]*><\/pre>/); expect(block).toContain(dictionaries.en["s14.life.draft_held_returning"]);
  expect(html).toContain(`data-kept="${dictionaries.en["s14.life.chat_closed_kept"]}"`); safe(html, "en");
  await f.app.botLifecycle.drain(noNative);
  const open = await f.page("/chats/scoutchat"); expect(open).not.toContain("data-draft-held"); expect(open).toContain(`data-kept="${dictionaries.en["s14.life.chat_open_kept"]}"`);
  const script = readFileSync(new URL("../src/s14/web-enhance.js", import.meta.url), "utf8");
  expect(script).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
});
