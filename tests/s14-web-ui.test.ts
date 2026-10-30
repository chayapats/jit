import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dictionaries } from "../src/i18n";
import { S14Application, type S14Options } from "../src/s14/application";
import { S14Store } from "../src/s14/store";
import { createS14Handler } from "../src/s14/web";
import { s14AssetUrl } from "../src/s14/web-assets";
import { renderRefusal, renderS14 } from "../src/s14/web-pages";
import { createS14Product, inferTitle } from "../src/s14/web-product";
import { createS14RefusalHandler } from "../src/s14/web-refusal";
import type { AuthorityOptions, Effect, EffectAction, Work } from "../src/s14/authority-types";
import type { ChatOutput, Policy, Route } from "../src/s14/types";
import { accessibilityProblems } from "./fixtures/a11y";

/**
 * S14 Web product (#246, #247): rendering and form contracts over the real application and the authenticated handler.
 * Forms are submitted the way a browser without script submits them: the test reads the hidden fields out of the HTML.
 */
const origin = "http://localhost:3001", password = "fixture-s14-web-owner";
const rid = () => crypto.randomUUID().replaceAll("-", "");
const roots: string[] = [], stores: S14Store[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
type Reply = () => ChatOutput;
async function fixture(options: { language?: "th" | "en" | null; reply?: Reply; routes?: Route[]; tools?: string[]; authority?: AuthorityOptions } = {}) {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-web-")); roots.push(root);
  const store = new S14Store(join(root, "s14.sqlite")); stores.push(store);
  const clock = { now: 1800000000000 }, reply: { next: Reply } = { next: options.reply ?? (() => ({ text: "สวัสดี / Hello" })) };
  const policy: Policy = { routes: options.routes ?? [{ id: "selected", provider: "codex", model: "scripted-model" }], tools: options.tools ?? [], resources: [] };
  const app = new S14Application(store, { policy, chat: { async reply() { return reply.next(); } }, now: () => clock.now, authority: options.authority ?? {} } as S14Options);
  // Provider readiness is local protected-store state; these rendering tests fix it to "signed in" and never read a real store.
  app.signIns.providers = async () => policy.routes.map(route => ({ ...route, readiness: "configured-unverified" as const }));
  await app.provisionOwner(password);
  const token = await app.login(password), auth = app.authenticate(token), handler = createS14Handler(app, origin, renderS14, createS14Product(app));
  const language = options.language === undefined ? "th" : options.language;
  const conversationId = language && policy.routes.length ? app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: 0, payload: { ownerName: "เจ้าของ <b>", language, routeId: policy.routes[0]!.id, capabilities: { tools: policy.tools, resources: [] } } }).conversation!.id : "";
  const get = (path: string, headers: Record<string, string> = {}) => handler(new Request(`${origin}${path}`, { headers: { cookie: `jit_s14=${token}`, ...headers } }));
  const page = async (path: string) => { const response = await get(path); expect(response.status).toBe(200); return response.text(); };
  const post = (path: string, fields: Record<string, string>) => handler(new Request(`${origin}${path}`, { method: "POST", headers: { cookie: `jit_s14=${token}`, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() }));
  return { app, store, clock, reply, auth, token, handler, get, page, post, conversationId, policy };
}
type F = Awaited<ReturnType<typeof fixture>>;
const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
/** The hidden fields, checked boxes and named inputs a browser would post for the form with this action. */
function formFields(html: string, action: string, index = 0): Record<string, string> {
  const forms = [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(m => m[0]).filter(f => f.includes(`action="${action}"`));
  const form = forms[index]; if (!form) throw new Error(`no form ${action}`);
  const fields: Record<string, string> = {};
  for (const input of form.matchAll(/<input\b[^>]*>/g)) {
    const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(input[0])?.[1], key = attr("name");
    if (!key || (/type="(checkbox|radio)"/.test(input[0]) && !/\schecked/.test(input[0]))) continue;
    fields[unescape(key)] = unescape(attr("value") ?? "");
  }
  for (const area of form.matchAll(/<textarea\b[^>]*name="([^"]+)"[^>]*>([\s\S]*?)<\/textarea>/g)) fields[area[1]!] = unescape(area[2]!);
  return fields;
}
const commandOf = (html: string, index = 0) => JSON.parse(formFields(html, "/s14/commands", index).command!) as { kind: string; requestId: string; expectedRevision: number; payload: Record<string, unknown> };
/** Every form-submission control, so a test can assert which decisions a page offers at all. */
const buttons = (html: string) => [...html.matchAll(/<button\b[^>]*>([\s\S]*?)<\/button>/g)].map(m => m[1]!.replace(/<[^>]+>/g, "")).filter(label => label !== dictionaries.th["s14.chat.new"] && label !== dictionaries.en["s14.chat.new"]);
const countWork = (f: F) => f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM work_items")!.n);
const countGrants = (f: F) => f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM work_grants")!.n);
const send = (f: F, text: string) => { const conversation = f.app.conversation(f.auth.actor, f.conversationId).conversation; return f.app.execute(f.auth.actor, { kind: "message.post", requestId: rid(), expectedRevision: conversation.revision, payload: { conversationId: conversation.id, text } }); };
async function compose(f: F, text: string, work = false, path = `/chats/${f.conversationId}`) {
  const fields: Record<string, string> = { ...formFields(await f.page(path), "/s14/forms/compose"), text };
  if (work) fields.work = "on";
  return { fields, response: await f.post("/s14/forms/compose", fields) };
}
async function started(f: F, title = "งานทดสอบ"): Promise<Work> {
  const { response } = await compose(f, title, true); expect(response.status).toBe(303);
  return f.app.authority.list(f.auth.actor).find(w => w.title === title)!;
}
const sendAction: EffectAction = { kind: "send", destination: "https://recipient.invalid/exact?a=1&b=<x>", content: 'Exact <img src=x onerror=alert(1)> "content"' };
async function effectFixture(language: "th" | "en" = "en", performer: AuthorityOptions["effects"] = { send: async () => "unknown" }) {
  const f = await fixture({ language, tools: ["effect_send", "effect_push"], authority: { effects: performer } });
  const conversation = f.app.conversation(f.auth.actor, f.conversationId).conversation, now = f.clock.now;
  const work = f.app.execute(f.auth.actor, { kind: "work.start", requestId: rid(), expectedRevision: conversation.revision, payload: { conversationId: conversation.id, task: null, title: "Send quote", purpose: "Send the quote", completionRule: "Sent", bots: [{ id: "jit", revision: 1 }], tools: ["effect_send", "effect_push"], scopes: [], limits: { attempts: 1, steps: 1, calls: 8, outputBytes: 4096, wallMs: 1800000 }, expiresAt: now + 1800000 } }).work!;
  const attempt = f.app.authority.admit(work.id, rid(), { botId: "jit", tools: ["effect_send", "effect_push"], scopes: [], input: "Send", calls: 6, outputBytes: 1024 });
  return { ...f, work, attempt, propose: (action: EffectAction = sendAction, expires = now + 60000) => f.app.authority.proposeEffect(attempt.id, rid(), action, expires) };
}
const approve = (f: F, effect: Effect, decision: "approve" | "deny" = "approve") => f.app.execute(f.auth.actor, { kind: "approval.decide", requestId: rid(), expectedRevision: effect.revision, payload: { effectId: effect.id, actionHash: effect.actionHash, decision } });
const strict = (html: string) => {
  expect(html).not.toMatch(/\sstyle="/); expect(html).not.toMatch(/\son[a-z]+="/); expect(html).not.toContain("javascript:");
  expect([...html.matchAll(/<script\b[^>]*>/g)].every(m => /type="module" src="\/assets\//.test(m[0]))).toBe(true);
};

test("sign-in redirects pages, keeps API errors JSON and speaks the browser language until an owner chooses one", async () => {
  const f = await fixture({ language: null }), anonymous = (path: string, headers: Record<string, string> = {}) => f.handler(new Request(`${origin}${path}`, { headers }));
  const home = await anonymous("/"); expect(home.status).toBe(303); expect(home.headers.get("location")).toBe("/s14/login");
  expect((await anonymous("/api/s14/home")).status).toBe(401);
  const en = await (await anonymous("/s14/login", { "accept-language": "en" })).text(), th = await (await anonymous("/s14/login")).text();
  expect(en).toContain('lang="en"'); expect(en).toContain(dictionaries.en["s14.login.submit"]); expect(th).toContain(dictionaries.th["s14.login.submit"]); expect(accessibilityProblems(en, "en")).toEqual([]);
  const refused = await f.handler(new Request(`${origin}/s14/login`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded", "accept-language": "en" }, body: "password=wrong-password" }));
  expect(refused.status).toBe(401); expect(await refused.text()).toContain(dictionaries.en["s14.error.login_failed"]);
  const expired = await f.handler(new Request(`${origin}/s14/forms/compose`, { method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded", "accept-language": "en" }, body: "csrf=x" }));
  expect(expired.status).toBe(401); expect(await expired.text()).toContain('href="/s14/login"');
});

test("an unprovisioned installation points at the one-time link, with the source path collapsed, instead of a sign-in form that cannot work", async () => {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-web-")); roots.push(root);
  const store = new S14Store(join(root, "s14.sqlite")); stores.push(store);
  const app = new S14Application(store, { policy: { routes: [], tools: [], resources: [] }, chat: { async reply() { return { text: "" }; } } });
  const handler = createS14Handler(app, origin, renderS14, createS14Product(app));
  for (const locale of ["th", "en"] as const) {
    const html = await (await handler(new Request(`${origin}/s14/login`, { headers: { "accept-language": locale } }))).text();
    expect(html).toContain("bun src/main.ts setup --s14"); expect(html).not.toContain('type="password"');
    expect(html).toContain(dictionaries[locale]["s14.login.unprovisioned"]);
    expect(html).toContain(dictionaries[locale]["s14.login.unprovisioned_note"]);
    expect(html.indexOf(dictionaries[locale]["s14.login.unprovisioned"])).toBeLessThan(html.indexOf("<details"));
    expect(html.indexOf("<details")).toBeLessThan(html.indexOf("bun src/main.ts setup --s14"));
    expect(html.slice(html.indexOf("<details"))).toContain(dictionaries[locale]["s14.login.source_note"]);
  }
});

test("fresh setup infers the only route, asks only what it cannot infer, and is idempotent through the no-script form", async () => {
  const f = await fixture({ language: null }), html = await f.page("/");
  expect(html).toContain(`${dictionaries.th["s14.provider.using"]} Codex`); expect(html).toContain(dictionaries.th["s14.setup.route_configured_detail"]); expect(html).not.toContain("scripted-model"); strict(html); expect(accessibilityProblems(html, "th")).toEqual([]);
  const fields = formFields(html, "/s14/forms/setup"); fields.ownerName = "คุณเจ้าของ";
  expect(Object.keys(fields).sort()).toEqual(["csrf", "expectedRevision", "language", "ownerName", "requestId"]);
  expect(html).not.toMatch(/name="(routeId|model|provider|alias)"/);
  const response = await f.post("/s14/forms/setup", fields); expect(response.status).toBe(303); expect(response.headers.get("location")).toBe("/");
  expect((await f.post("/s14/forms/setup", fields)).status).toBe(303);
  const state = f.app.home(f.auth.actor); expect(state.bots).toHaveLength(1); expect(state.conversations).toHaveLength(1); expect(state.bots[0]!.capabilities).toEqual({ tools: [], resources: [] });
  expect(await f.page("/")).toContain(dictionaries.th["s14.home.prompt"]);
  expect((await f.post("/s14/forms/setup", { ...fields, requestId: rid(), extra: "x" })).status).toBe(400);
});

test("setup with no configured route names the blocker and offers no form; several routes become a choice", async () => {
  const none = await fixture({ language: null, routes: [] }), html = await none.page("/");
  expect(html).toContain(dictionaries.th["s14.setup.route_missing"]); expect(html).not.toContain("/s14/forms/setup"); strict(html);
  const many = await fixture({ language: null, routes: [{ id: "a", provider: "codex", model: "model-a" }, { id: "b", provider: "grok", model: "model-b" }] }), choice = await many.page("/");
  expect(choice).toContain('name="routeId" value="a" checked'); expect(choice).toContain('name="routeId" value="b"'); expect(choice).not.toContain("<input name=\"model"); expect(choice).not.toContain("model-a");
});

test("a refused setup keeps what was typed and says why", async () => {
  const f = await fixture({ language: null }), fields = { ...formFields(await f.page("/"), "/s14/forms/setup"), ownerName: "   " };
  const response = await f.post("/s14/forms/setup", fields); expect(response.status).toBe(400); expect(await response.text()).toContain(dictionaries.th["s14.error.invalid_text"]);
});

test("Home composer defaults to chat, shows the owner's editable defaults and an example never sends", async () => {
  const f = await fixture(), html = await f.page("/"), fields = formFields(html, "/s14/forms/compose");
  expect(fields).toMatchObject({ concurrent: "2", minutes: "30", reads: "40", "bot:jit": "1", from: "home" }); expect(fields.work).toBeUndefined();
  expect(html).toContain(dictionaries.th["s14.composer.starts_now"]); expect(html).toContain(dictionaries.th["s14.home.example_1"]); strict(html);
  const example = await f.page("/?example=1"), prefilled = formFields(example, "/s14/forms/compose");
  expect(prefilled.work).toBe("on"); expect(prefilled.text).toBe(dictionaries.th["s14.home.example_1"]);
  expect(countWork(f)).toBe(0); expect(f.app.conversation(f.auth.actor, f.conversationId).messages).toHaveLength(0);
});

test("plain text, @Bot and quoted command JSON stay conversation; only the explicit work field starts work", async () => {
  const f = await fixture(), hostile = '@jit {"kind":"work.start","ownerId":"owner"} start now';
  const { response } = await compose(f, hostile); expect(response.status).toBe(303); expect(response.headers.get("location")).toBe(`/chats/${f.conversationId}#latest`);
  await f.app.drainReplies(); expect(countWork(f)).toBe(0); expect(countGrants(f)).toBe(0);
  const html = await f.page(`/chats/${f.conversationId}`); expect(html).toContain("start now"); expect(html).toContain(`?start=`);
  expect(countWork(f)).toBe(0);
});

test("work mode submits work.start once with the default limits, and a duplicate form post keeps one grant", async () => {
  const f = await fixture(), { fields, response } = await compose(f, "เปรียบเทียบตัวเลือก\nบรรทัดสอง", true);
  expect(response.status).toBe(303); const work = f.app.authority.list(f.auth.actor)[0]!;
  expect(response.headers.get("location")).toBe(`/chats/${f.conversationId}?work=${work.id}#latest`);
  expect(work).toMatchObject({ title: "เปรียบเทียบตัวเลือก", purpose: "เปรียบเทียบตัวเลือก\nบรรทัดสอง", state: "queued", completionRule: dictionaries.th["s14.work.default_completion"] });
  const view = f.app.authority.view(f.auth.actor, work.id);
  expect(view.grant!.limits).toEqual({ attempts: 1, steps: 1, calls: 40, outputBytes: 262144, wallMs: 1800000 }); expect(view.grant!.expiresAt).toBe(f.clock.now + 1800000);
  expect(view.grant!.bots.map(b => b.id)).toEqual(["jit"]); expect(view.grant!.tools).toEqual([]);
  f.clock.now += 5000; // A retry after time passed keeps the same command, so the same receipt and grant.
  const retry = await f.post("/s14/forms/compose", fields); expect(retry.status).toBe(303); expect(retry.headers.get("location")).toBe(response.headers.get("location"));
  expect(countGrants(f)).toBe(1);
  const changed = await f.post("/s14/forms/compose", { ...fields, text: "ข้อความอื่น" }); expect(changed.status).toBe(409); expect(await changed.text()).toContain("ข้อความอื่น");
  expect(countGrants(f)).toBe(1);
});

test("edited limits reach the grant, out-of-range limits refuse with the draft kept, and the Bot limit caps named Bots", async () => {
  const f = await fixture({ reply: () => ({ text: "x", proposal: { name: "Scout", responsibility: "Read", routeId: "selected" } }) });
  const edited = { ...(await compose(f, "x")).fields }; expect(edited).toBeDefined(); await f.app.drainReplies();
  const proposal = f.app.home(f.auth.actor).proposals[0]!;
  f.app.execute(f.auth.actor, { kind: "bot.proposal.accept", requestId: rid(), expectedRevision: proposal.revision, payload: { proposalId: proposal.id, capabilities: { tools: [], resources: [] } } });
  const html = await f.page(`/chats/${f.conversationId}`), base = { ...formFields(html, "/s14/forms/compose"), text: "ทำงานนี้", work: "on" };
  const scout = f.app.home(f.auth.actor).bots.find(b => b.id !== "jit")!;
  const tooMany = await f.post("/s14/forms/compose", { ...base, concurrent: "1", [`bot:${scout.id}`]: "1" }); expect(tooMany.status).toBe(400);
  const refused = await tooMany.text(); expect(refused).toContain(dictionaries.th["s14.error.s14_too_many_bots"]); expect(refused).toContain("ทำงานนี้"); expect(countGrants(f)).toBe(0);
  const range = await f.post("/s14/forms/compose", { ...base, reads: "9999" }); expect(range.status).toBe(400); expect(await range.text()).toContain(dictionaries.th["s14.next.s14_limit_out_of_range"]);
  const ok = await f.post("/s14/forms/compose", { ...base, minutes: "5", reads: "10", [`bot:${scout.id}`]: "1" }); expect(ok.status).toBe(303);
  const grant = f.app.authority.view(f.auth.actor, f.app.authority.list(f.auth.actor)[0]!.id).grant!;
  expect(grant.limits).toMatchObject({ attempts: 2, calls: 10, wallMs: 300000 }); expect(grant.bots.map(b => b.id)).toEqual(["jit", scout.id]);
});

test("a stale composer keeps the owner's text and starts nothing; credential-shaped text is refused and not echoed", async () => {
  const f = await fixture(), html = await f.page(`/chats/${f.conversationId}`), fields = { ...formFields(html, "/s14/forms/compose"), text: "งานที่พิมพ์ไว้ยาวๆ", work: "on" };
  send(f, "ข้อความแทรก");
  const stale = await f.post("/s14/forms/compose", fields); expect(stale.status).toBe(409);
  const refused = await stale.text(); expect(refused).toContain("งานที่พิมพ์ไว้ยาวๆ"); expect(refused).toContain(dictionaries.th["s14.error.stale_revision"]); expect(formFields(refused, "/s14/forms/compose").work).toBe("on");
  expect(countGrants(f)).toBe(0);
  const secret = `sk-proj-${"x".repeat(32)}`, fresh = { ...formFields(await f.page(`/chats/${f.conversationId}`), "/s14/forms/compose"), text: `use ${secret}`, work: "on" };
  const response = await f.post("/s14/forms/compose", fresh); expect(response.status).toBe(403);
  const body = await response.text(); expect(body).toContain(dictionaries.th["s14.error.credential_content_refused"]); expect(body).not.toContain(secret);
});

test("accepting a task visibly does not start it; the separate start press does", async () => {
  const ran: string[] = [];
  const f = await fixture({ language: "en", reply: () => ({ text: "Suggestion", task: { title: "<b>Compare</b>", purpose: "Compare public facts", completionRule: "Evidence" } }), authority: { executor: { async run(a) { ran.push(a.id); return { state: "ready", text: "Evidence text" }; } } } });
  await compose(f, "suggest"); await f.app.drainReplies();
  const proposed = await f.page(`/chats/${f.conversationId}`), task = f.app.authority.list(f.auth.actor)[0]!;
  expect(proposed).toContain(dictionaries.en["s14.task.accept"]); expect(proposed).toContain("&lt;b&gt;Compare&lt;/b&gt;"); expect(proposed).toContain(dictionaries.en["s14.task.accept_note"]);
  expect(buttons(proposed)).not.toContain(dictionaries.en["s14.task.start"]); expect(accessibilityProblems(proposed, "en")).toEqual([]);
  expect(commandOf(proposed)).toMatchObject({ kind: "task.accept", expectedRevision: 1, payload: { taskId: task.id } });
  const accept = await f.post("/s14/commands", formFields(proposed, "/s14/commands"));
  expect(accept.status).toBe(303); const landed = await f.get(accept.headers.get("location")!);
  expect(landed.status).toBe(303); expect(landed.headers.get("location")).toBe(`/chats/${f.conversationId}?work=${task.id}#latest`);
  await f.app.authority.drain(); expect(ran).toHaveLength(0); expect(countGrants(f)).toBe(0);
  const accepted = await f.page(`/work/${task.id}`);
  expect(accepted).toContain(dictionaries.en["s14.task.not_running_title"]); expect(accepted).toContain(dictionaries.en["s14.work_state.accepted"]); expect(buttons(accepted)).toContain(dictionaries.en["s14.task.start"]); expect(buttons(accepted)).not.toContain(dictionaries.en["s14.task.accept"]);
  const start = await f.post("/s14/forms/task-start", formFields(accepted, "/s14/forms/task-start")); expect(start.status).toBe(303);
  await f.app.authority.drain(); expect(ran).toHaveLength(1);
  const work = f.app.authority.list(f.auth.actor)[0]!; expect(work.state).toBe("ready");
  const ready = await f.page(`/work/${task.id}`); expect(ready).toContain(dictionaries.en["s14.work.ready_detail"]); expect(ready).toContain("Evidence text"); expect(ready).toContain(dictionaries.en["s14.untrusted.result"]);
});

test("Bot proposal shows its exact revision, grants only ticked capabilities, and refuses a stale tab", async () => {
  const f = await fixture({ language: "en", tools: ["public_read", "other_tool"], reply: () => ({ text: "Proposal below", proposal: { name: "Scout", responsibility: "Read public sources", routeId: "selected" } }) });
  await compose(f, "x"); await f.app.drainReplies();
  const proposal = f.app.home(f.auth.actor).proposals[0]!, open = await f.page(`/proposals/${proposal.id}`);
  expect(open).toContain(`${dictionaries.en["s14.proposal.accept"]} r1`); expect(open).toContain(dictionaries.en["s14.proposal.no_effect"]); expect(open).toContain(dictionaries.en["s14.proposal.none_granted"]); expect(open).toContain("scripted-model");
  expect(accessibilityProblems(open, "en")).toEqual([]); strict(open);
  const staleTab = formFields(open, "/s14/forms/proposal-accept");
  const revised = await f.post("/s14/forms/proposal-revise", { ...formFields(open, "/s14/forms/proposal-revise"), name: "Scout Two", responsibility: "Read and compare" }); expect(revised.status).toBe(303);
  const second = await f.page(revised.headers.get("location")!);
  expect(second).toContain(`${dictionaries.en["s14.proposal.accept"]} r2`); expect(second).toContain(`${dictionaries.en["s14.proposal.changed_from"]} r1`); expect(second).toContain(dictionaries.en["s14.proposal.stale"]); expect(second).toContain(dictionaries.en["s14.untrusted.owner_edit"]);
  const stale = await f.post("/s14/forms/proposal-accept", staleTab); expect(stale.status).toBe(409);
  const refusal = await stale.text(); expect(refusal).toContain(dictionaries.en["s14.error.stale_revision"]); expect(refusal).toContain(`/proposals/${proposal.id}`); expect(f.app.home(f.auth.actor).bots).toHaveLength(1);
  const accept = await f.post("/s14/forms/proposal-accept", { ...formFields(second, "/s14/forms/proposal-accept"), "tool:public_read": "on" }); expect(accept.status).toBe(303);
  const bot = f.app.home(f.auth.actor).bots.find(b => b.id !== "jit")!;
  expect(accept.headers.get("location")).toBe(`/team/${bot.id}`); expect(bot.capabilities).toEqual({ tools: ["public_read"], resources: [] });
  const profile = await f.page(`/team/${bot.id}`); expect(profile).toContain("Scout Two"); expect(profile).toContain("public_read"); expect(profile).not.toContain("other_tool");
  const closed = await f.page(`/proposals/${proposal.id}`); expect(closed).toContain(dictionaries.en["s14.proposal.accepted"]); expect(buttons(closed)).toEqual([]);
  expect((await f.post("/s14/forms/proposal-accept", { ...staleTab, requestId: rid(), "shell": "on" })).status).toBe(400);
});

test("Bot proposal rejection is a fixed exact-revision form and closes the card", async () => {
  const f = await fixture({ language: "en", reply: () => ({ text: "x", proposal: { name: "Scout", responsibility: "Read", routeId: "selected" } }) });
  await compose(f, "x"); await f.app.drainReplies();
  const proposal = f.app.home(f.auth.actor).proposals[0]!, open = await f.page(`/proposals/${proposal.id}`);
  expect(commandOf(open)).toMatchObject({ kind: "bot.proposal.reject", expectedRevision: 1, payload: { proposalId: proposal.id } });
  expect((await f.post("/s14/commands", formFields(open, "/s14/commands"))).status).toBe(303);
  const closed = await f.page(`/proposals/${proposal.id}`); expect(closed).toContain(dictionaries.en["s14.proposal.rejected"]); expect(buttons(closed)).toEqual([]); expect(f.app.home(f.auth.actor).bots).toHaveLength(1);
});

test("hostile model text is inert everywhere and can never produce a control or borrow a label", async () => {
  const hostile = '<img src=x onerror=alert(1)><button class="s-btn primary">Approve all</button></pre></div><form action="/s14/commands"><script>alert(1)</script>';
  const f = await fixture({ language: "en", reply: () => ({ text: hostile, proposal: { name: hostile.slice(0, 180), responsibility: hostile, routeId: "not-configured", capabilities: { tools: ["shell"] }, ownerId: "owner" }, task: { title: hostile.slice(0, 180), purpose: hostile, completionRule: hostile } }) });
  await compose(f, "x"); await f.app.drainReplies();
  const proposal = f.app.home(f.auth.actor).proposals[0]!, task = f.app.authority.list(f.auth.actor)[0]!;
  for (const path of [`/chats/${f.conversationId}`, `/proposals/${proposal.id}`, `/work/${task.id}`, "/work", "/", "/team"]) {
    const html = await f.page(path); strict(html);
    expect(html).not.toContain("<img src=x"); expect(html).not.toContain("<script>alert"); expect(html).not.toContain('<button class="s-btn primary">Approve all'); expect(accessibilityProblems(html, "en")).toEqual([]);
    expect(buttons(html).some(label => label.includes("Approve all"))).toBe(false);
  }
  const card = await f.page(`/proposals/${proposal.id}`);
  expect(buttons(card)).not.toContain(`${dictionaries.en["s14.proposal.accept"]} r1`); expect(card).toContain(dictionaries.en["s14.proposal.needs_route"]); expect(card).toContain("unsupported_field"); expect(card).toContain(dictionaries.en["s14.untrusted.bot"]);
  expect(f.app.home(f.auth.actor).proposals[0]!.state).toBe("proposed");
});

test("approval card shows the exact action with its revision and hash, and Approve carries both", async () => {
  const f = await effectFixture(), effect = f.propose(), html = await f.page(`/effects/${effect.id}`);
  expect(html).toContain("https://recipient.invalid/exact?a=1&amp;b=&lt;x&gt;"); expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;"); expect(html).toContain(effect.actionHash); expect(html).toContain(">r1<");
  expect(html).toContain(dictionaries.en["s14.effect.single_use"]); expect(html).toContain(dictionaries.en["s14.effect.irreversible"]); strict(html); expect(accessibilityProblems(html, "en")).toEqual([]);
  expect(buttons(html)).toEqual([dictionaries.en["s14.effect_approve.send"], dictionaries.en["s14.effect.deny"]]);
  // Focus lands on the heading, and nothing in the slip is pre-focused for Enter.
  expect(html).toContain('id="slip" tabindex="-1" data-focus-on-load'); expect(html).not.toContain("autofocus");
  expect(commandOf(html)).toMatchObject({ kind: "approval.decide", expectedRevision: 1, payload: { effectId: effect.id, actionHash: effect.actionHash, decision: "approve" } });
  expect(commandOf(html, 1).payload.decision).toBe("deny");
  const approved = await f.post("/s14/commands", formFields(html, "/s14/commands")); expect(approved.status).toBe(303);
  const landed = await f.get(approved.headers.get("location")!); expect(landed.headers.get("location")).toBe(`/effects/${effect.id}`);
  const after = await f.page(`/effects/${effect.id}`); expect(after).toContain(dictionaries.en["s14.effect_state.approved"]); expect(after).toContain(dictionaries.en["s14.effect.approved_detail"]); expect(buttons(after)).toEqual([]);
});

test("changed action closes the old decision: diff shown, stale form refused, nothing approved", async () => {
  const f = await effectFixture(), effect = f.propose(), old = await f.page(`/effects/${effect.id}`), staleForm = formFields(old, "/s14/commands");
  const changed = f.app.authority.reviseEffect(f.attempt.id, effect.id, 1, { ...sendAction, content: "Different content" }, f.clock.now + 60000);
  const html = await f.page(`/effects/${effect.id}`);
  expect(html).toContain(`${dictionaries.en["s14.effect.changed"]} r1`); expect(html).toContain("s-diff-old"); expect(html).toContain("Different content"); expect(html).toContain(changed.actionHash); expect(html).toContain(dictionaries.en["s14.effect_state.changed"]);
  const stale = await f.post("/s14/commands", staleForm); expect(stale.status).toBe(409);
  const refusal = await stale.text(); expect(refusal).toContain(dictionaries.en["s14.error.stale_approval"]); expect(refusal).toContain(`/effects/${effect.id}`);
  expect(f.app.authority.effect(f.auth.actor, effect.id).effect.state).toBe("pending");
});

test("expired, denied, unsupported and unknown cards offer no way to send, and unknown offers no retry", async () => {
  const f = await effectFixture();
  const expired = f.propose(sendAction, f.clock.now + 1000), denied = f.propose(), unknown = f.propose(), unsupported = f.propose({ kind: "push", destination: "origin/main", content: "push it" });
  approve(f, denied, "deny"); approve(f, unknown); await f.app.authority.runEffect(unknown.id, 1, unknown.actionHash); f.clock.now += 2000;
  const expect_ = async (id: string, words: string[], controls: string[]) => { const html = await f.page(`/effects/${id}`); for (const w of words) expect(html).toContain(w); expect(buttons(html)).toEqual(controls); strict(html); expect(accessibilityProblems(html, "en")).toEqual([]); return html; };
  await expect_(expired.id, [dictionaries.en["s14.effect.expired_detail"], dictionaries.en["s14.effect_state.expired"]], []);
  await expect_(denied.id, [dictionaries.en["s14.effect_state.denied"], dictionaries.en["s14.effect.denied_detail"]], []);
  await expect_(unsupported.id, [dictionaries.en["s14.effect.unsupported"]], [dictionaries.en["s14.effect.deny"]]);
  const lost = await expect_(unknown.id, [dictionaries.en["s14.effect_state.unknown"], dictionaries.en["s14.effect.unknown_detail"], dictionaries.en["s14.effect.unknown_next"]], []);
  expect(lost).toContain('data-state="unknown"'); expect(lost).not.toMatch(/retry|ลองใหม่/i);
  const home = await f.page("/"); expect(home).toContain(`/effects/${unknown.id}#slip`); expect(home).not.toContain(`/effects/${denied.id}#slip`);
});

test("stop is a named exact form; open calls read stopping until they settle, then stopped, and unrelated work keeps running", async () => {
  let release!: (value: { state: "ready"; text: string }) => void;
  const f = await fixture({ language: "en", authority: { executor: { run: () => new Promise(resolve => { release = resolve; }) } } }); // Ignores abort: the open call must really outlive the stop.
  const work = await started(f, "Long work"), other = await started(f, "Other work");
  const queued = await f.page(`/work/${work.id}`); expect(queued).toContain(dictionaries.en["s14.work.queued_detail"]); expect(queued).toContain(dictionaries.en["s14.work.receipt"]);
  const draining = f.app.authority.drain(); await Bun.sleep(0);
  const running = await f.page(`/work/${work.id}`); expect(running).toContain(dictionaries.en["s14.work.running_detail"]); expect(running).toContain('data-live="true"'); expect(buttons(running)).toEqual([dictionaries.en["s14.work.stop"]]);
  expect(commandOf(running)).toMatchObject({ kind: "work.stop", payload: { workId: work.id } });
  expect(running).not.toContain(">0<"); expect(running).toContain(dictionaries.en["s14.usage.actual"]); expect(running).toContain(dictionaries.en["s14.unknown"]); expect(running).toContain("s-unknown-bar");
  expect((await f.post("/s14/commands", formFields(running, "/s14/commands"))).status).toBe(303);
  const stopping = await f.page(`/work/${work.id}`); expect(stopping).toContain(dictionaries.en["s14.work.stopping_detail"]); expect(buttons(stopping)).toEqual([]);
  release({ state: "ready", text: "late" }); await Bun.sleep(0);
  const stopped = await f.page(`/work/${work.id}`); expect(stopped).toContain(dictionaries.en["s14.work.stopped_detail"]); expect(stopped).not.toContain("late</p>");
  expect(f.app.authority.list(f.auth.actor).find(w => w.id === other.id)!.state).toBe("running");
  release({ state: "ready", text: "other result" }); await draining;
  expect(await f.page(`/work/${other.id}`)).toContain("other result");
});

test("blocked work names the reason and refuses to imply a retry; the grant view states exactly what was recorded", async () => {
  const f = await fixture({ language: "en", tools: ["public_read"], authority: { executor: { async run() { throw new Error("transport detail"); } } } });
  const html = await f.page(`/chats/${f.conversationId}`);
  expect(html).toContain('name="tool:public_read" value="on" checked');
  const work = await started(f, "Blocked work"); await f.app.authority.drain();
  const blocked = await f.page(`/work/${work.id}`);
  expect(blocked).toContain(dictionaries.en["s14.work_state.blocked"]); expect(blocked).toContain(dictionaries.en["s14.reason.handler_unavailable"]); expect(blocked).toContain(dictionaries.en["s14.work.blocked_next"]); expect(blocked).not.toContain("transport detail");
  const grant = await f.page(`/work/${work.id}?tab=grant`);
  for (const text of ["Blocked work", "public_read", "g1", "scripted-model", dictionaries.en["s14.grant.no_external"], dictionaries.en["s14.grant.no_scopes"], dictionaries.en["s14.grant.concurrency_detail"], dictionaries.en["s14.grant.enforced_note"]]) expect(grant).toContain(text);
  expect(accessibilityProblems(grant, "en")).toEqual([]);
  expect(grant).not.toMatch(/verified|authorized by|secure/i);
  const pane = await f.page(`/chats/${f.conversationId}?work=${work.id}&tab=grant`); expect(pane).toContain('data-pane="open"'); expect(pane).toContain("public_read");
});

test("blocked chat reply tells the owner it will not replay", async () => {
  const f = await fixture({ language: "en", reply: () => { throw new Error("provider detail"); } });
  await compose(f, "hello"); await f.app.drainReplies();
  const html = await f.page(`/chats/${f.conversationId}`);
  expect(html).toContain(dictionaries.en["s14.reply.blocked"]); expect(html).toContain(dictionaries.en["s14.reason.reply_unavailable"]); expect(html).toContain(dictionaries.en["s14.reply.blocked_next"]); expect(html).not.toContain("provider detail");
  send(f, "again"); const queued = await f.page(`/chats/${f.conversationId}`); expect(queued).toContain(dictionaries.en["s14.reply.queued"]); expect(queued).toContain('data-live="true"');
});

test("every surface renders in Thai and English with no raw keys, no Thai in English chrome and valid accessible markup", async () => {
  for (const language of ["th", "en"] as const) {
    const f = await effectFixture(language), effect = f.propose();
    const paths = ["/", "/work", "/team", "/team/jit", "/more", `/chats/${f.conversationId}`, `/chats/${f.conversationId}?work=${f.work.id}`, `/chats/${f.conversationId}?work=${f.work.id}&tab=grant`, `/work/${f.work.id}`, `/work/${f.work.id}?tab=grant`, `/effects/${effect.id}`];
    for (const path of paths) {
      const response = await f.get(path), html = await response.text();
      expect(response.status).toBe(200); expect(response.headers.get("content-language")).toBe(language); expect(response.headers.get("referrer-policy")).toBe("same-origin"); expect(response.headers.get("cache-control")).toBe("private, no-store");
      expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
      strict(html); expect(accessibilityProblems(html, language)).toEqual([]);
      const text = html.replace(/<head>[\s\S]*?<\/head>/, "").replace(/<[^>]+>/g, " ");
      expect(text).not.toMatch(/\bs14\.[a-z_]+\.?/); expect(text).not.toMatch(/undefined|null|NaN|\[object/);
      if (language === "en") expect(text.replace(/เจ้าของ|ไทย/g, "")).not.toMatch(/[฀-๿]/);
    }
  }
});

test("assets are hashed, immutable and same-origin; unknown paths are 404 and pages load no inline style", async () => {
  const f = await fixture();
  for (const name of ["s14.css", "s14.js", "app.css"] as const) {
    const response = await f.handler(new Request(`${origin}${s14AssetUrl(name)}`));
    expect(response.status).toBe(200); expect(response.headers.get("cache-control")).toContain("immutable"); expect(await response.text()).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  }
  expect((await f.handler(new Request(`${origin}/assets/s14.0000000000000000.css`))).status).toBe(404);
  const script = readFileSync(join(import.meta.dir, "../src/s14/web-enhance.js"), "utf8");
  expect(script).not.toMatch(/method:\s*"POST"|sendBeacon|localStorage|sessionStorage|eval\(/);
});

test("missing and malformed pages stay styled with a next step; JSON keeps its error shape", async () => {
  const f = await fixture({ language: "en" });
  const missing = await f.get("/work/not-a-real-work"); expect(missing.status).toBe(404); const html = await missing.text(); expect(html).toContain(dictionaries.en["s14.error.not_found"]); expect(accessibilityProblems(html, "en")).toEqual([]); strict(html);
  expect((await f.get("/api/s14/work/not-a-real-work")).headers.get("content-type")).toContain("application/json");
  const forged = await f.post("/s14/forms/compose", { csrf: "0".repeat(64), text: "x" }); expect(forged.status).toBe(403); expect(await forged.text()).toContain(dictionaries.en["s14.error.csrf_rejected"]);
  const cross = await f.handler(new Request(`${origin}/s14/forms/compose`, { method: "POST", headers: { cookie: `jit_s14=${f.token}`, origin: "https://evil.test", "content-type": "application/x-www-form-urlencoded" }, body: "csrf=x" })); expect(cross.status).toBe(403);
  const logout = await f.post("/s14/logout", { csrf: f.auth.csrf }); expect(logout.status).toBe(303); expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
  expect((await f.get("/")).headers.get("location")).toBe("/s14/login");
});

test("refusal page explains in both languages, offers no form and writes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-refusal-")); roots.push(root);
  const path = join(root, "legacy.sqlite"), db = new Database(path);
  db.exec("CREATE TABLE projects(id TEXT); PRAGMA user_version=45; INSERT INTO projects VALUES ('legacy')"); db.close();
  const hash = () => Object.fromEntries(readdirSync(root).map(n => [n, createHash("sha256").update(readFileSync(join(root, n))).digest("hex")])), before = hash();
  const handler = createS14RefusalHandler(path);
  for (const language of ["th", "en"] as const) {
    const response = handler(new Request(`${origin}/`, { headers: { "accept-language": language } })), html = await response.text();
    expect(response.status).toBe(409); expect(html).toContain(dictionaries[language]["s14.legacy.untouched"]); expect(html).toContain("JIT_S14_DATABASE="); expect(html).toContain("bun src/main.ts serve</pre>"); expect(html).toContain("legacy.sqlite"); expect(html).not.toContain(root);
    expect(html).not.toContain("<form"); expect(html).not.toContain("<button"); strict(html); expect(accessibilityProblems(html, language)).toEqual([]);
  }
  expect(handler(new Request(`${origin}/s14/commands`, { method: "POST" })).status).toBe(409);
  expect(handler(new Request(`${origin}${s14AssetUrl("s14.css")}`)).status).toBe(200);
  expect(hash()).toEqual(before); expect(renderRefusal("en", "<x>")).toContain("&lt;x&gt;");
});

test("serve --s14 --refusal-page refuses before any store opens, then explains on the loopback origin", async () => {
  const root = mkdtempSync(join(tmpdir(), "jit-s14-refusal-")); roots.push(root);
  const path = join(root, "legacy.sqlite"), db = new Database(path);
  db.exec("CREATE TABLE projects(id TEXT); PRAGMA user_version=45; INSERT INTO projects VALUES ('legacy')"); db.close();
  const before = readdirSync(root).sort(), port = 34000 + Math.floor(Math.random() * 1000);
  const child = Bun.spawn([process.execPath, "src/main.ts", "serve", "--s14", "--refusal-page"], { env: { ...process.env, JIT_S14_DATABASE: path, JIT_S14_ORIGIN: `http://localhost:${port}` }, stdout: "pipe", stderr: "pipe" });
  try {
    let response: Response | null = null;
    for (let i = 0; i < 100 && !response; i++) { await Bun.sleep(50); response = await fetch(`http://localhost:${port}/`).catch(() => null); }
    expect(response?.status).toBe(409); expect(await response!.text()).toContain("JIT_S14_DATABASE=");
    expect(readdirSync(root).sort()).toEqual(before);
  } finally { child.kill(); }
  expect(await child.exited).not.toBe(0); expect(await new Response(child.stderr).text()).toContain("choose_a_separate_JIT_S14_DATABASE_keep_legacy_installation");
});

test("the inferred title stays inside the byte limit on a character boundary", () => {
  const title = inferTitle(`\n  ${"ก".repeat(200)}\nsecond`); expect(Buffer.byteLength(title)).toBeLessThanOrEqual(200); expect(title.endsWith("…")).toBe(true); expect(title.isWellFormed()).toBe(true);
  expect(inferTitle("short\nsecond")).toBe("short");
});
