import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostAuthFetch, HostCredentialStore } from "schway/host";
import { dictionaries } from "../src/i18n";
import { issueOwnerSetupLink } from "../src/ops/owner-setup";
import { S14Application, type S14Options } from "../src/s14/application";
import type { ParallelTransport } from "../src/s14/parallel-protocol";
import { supportedS14Routes, type S14SignInReceipt } from "../src/s14/sign-in";
import { S14Store } from "../src/s14/store";
import { createS14Handler } from "../src/s14/web";
import { createS14Auth, renderOwnerSetupRefused, renderSignIn } from "../src/s14/web-first-run";
import { renderFailure, renderRefusal, renderS14 } from "../src/s14/web-pages";
import { createS14Product } from "../src/s14/web-product";
import { createS14RefusalHandler } from "../src/s14/web-refusal";
import { accessibilityProblems } from "./fixtures/a11y";
import anonymous from "./fixtures/parallel/tools-anonymous.json";
import fetchResult from "./fixtures/parallel/fetch.json";
import search from "./fixtures/parallel/search.json";
import { FakeComputerRuntime } from "./fixtures/s14-computer";

/**
 * UX14-01 product surfaces over the real application and handler. Forms post the way a browser without script posts
 * them, read out of the HTML. The provider protocol, chat and Parallel are fixtures; no live service is reached.
 */
const origin = "http://localhost:3001", password = "fixture-first-run-owner", deviceCode = "ONCE-UI-265";
const hostile = '<img src=x onerror=alert(1)><button class="s-btn primary">Approve all</button></pre></div><form action="/s14/commands"><script>alert(1)</script>';
const rid = () => crypto.randomUUID().replaceAll("-", "");
const roots: string[] = [], apps: S14Application[] = [];
afterEach(async () => { for (const app of apps.splice(0)) { await app.signIns.close(); app.store.close(); } for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const transport: ParallelTransport = async (_url, init) => {
  const wire = JSON.parse(init.body as string) as { method: string; id?: number; params: { name?: string } };
  const rpc = (result: unknown) => Response.json({ jsonrpc: "2.0", id: wire.id, result });
  if (wire.method === "initialize") return rpc({ protocolVersion: "2025-03-26", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
  if (wire.method === "notifications/initialized") return new Response(null, { status: 202 });
  if (wire.method === "tools/list") return Response.json(anonymous);
  return Response.json(wire.params.name === "web_search" ? search : fetchResult);
};
const unescape = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
const formsFor = (html: string, action: string) => [...html.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(m => m[0]).filter(f => f.includes(`action="${action}"`));
function fields(form: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const input of form.matchAll(/<input\b[^>]*>/g)) {
    const attr = (name: string) => new RegExp(`\\s${name}="([^"]*)"`).exec(input[0])?.[1], key = attr("name");
    if (!key || (/type="(checkbox|radio)"/.test(input[0]) && !/\schecked/.test(input[0]))) continue;
    out[unescape(key)] = unescape(attr("value") ?? "");
  }
  return out;
}
const commandForm = (html: string, kind: string) => { const form = formsFor(html, "/s14/commands").map(fields).find(item => JSON.parse(item.command!).kind === kind); if (!form) throw new Error(`no ${kind} form`); return form; };
const hasCommand = (html: string, kind: string) => formsFor(html, "/s14/commands").some(form => JSON.parse(fields(form).command!).kind === kind);
const strict = (html: string, locale: "th" | "en" = "en") => { expect(html).not.toMatch(/\sstyle="/); expect(html).not.toMatch(/\son[a-z]+="/); expect(html).not.toContain("javascript:"); expect(accessibilityProblems(html, locale)).toEqual([]); };
const visible = (html: string) => html.replace(/<head>[\s\S]*?<\/head>/, "").replace(/<[^>]+>/g, " ");
const clean = (html: string, locale: "th" | "en") => { const text = visible(html); expect(text).not.toMatch(/\bs14\.[a-z_]+\.?/); expect(text).not.toMatch(/undefined|\bnull\b|NaN|\[object|\{[a-z]+\}/); if (locale === "en") expect(text.replace(/ไทย/g, "")).not.toMatch(/[฀-๿]/); };

/** Fresh installation with the fake native store and device protocol, so readiness and sign-in run their real code. */
async function fresh(options: { fetch?: HostAuthFetch } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-s14-first-ui-"))); roots.push(root);
  const store = new S14Store(join(root, "s14.sqlite")), clock = { now: 1800000000000 }, credentials = new Map<string, string>(), state = { approved: false };
  const nativeStore: HostCredentialStore = { get: async id => credentials.get(id.account) ?? null, set: async (id, value) => { credentials.set(id.account, value); }, delete: async id => credentials.delete(id.account) };
  const fake: HostAuthFetch = async input => {
    const url = String(input);
    if (/usercode|device\/code|device_authorization|device\/authorization/.test(url)) return Response.json({ user_code: deviceCode, device_auth_id: "device-private", verification_uri: "https://auth.example.test/device", interval: 1, expires_in: 600 });
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: "fixture-provider-token", refresh_token: "fixture-refresh", expires_in: 3600 });
    if (state.approved) return Response.json({ authorization_code: "auth-private", code_verifier: "verifier-private" });
    return Response.json({ error: "authorization_pending" }, { status: 400 });
  };
  const app = new S14Application(store, { policy: { routes: supportedS14Routes(), tools: ["web_search", "web_fetch"], resources: [] }, signIn: { store: nativeStore, fetch: options.fetch ?? fake }, now: () => clock.now, chat: { async reply(input) { return { text: input.language === "th" ? "สวัสดี" : "Hello" }; } } } as S14Options);
  apps.push(app);
  const handler = createS14Handler(app, origin, renderS14, createS14Product(app), createS14Auth(app));
  const cookies = new Map<string, string>(), jar = () => [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  const absorb = (response: Response) => { for (const line of response.headers.getSetCookie()) { const [pair] = line.split(";"), at = pair!.indexOf("="); if (line.includes("Max-Age=0")) cookies.delete(pair!.slice(0, at)); else cookies.set(pair!.slice(0, at), pair!.slice(at + 1)); } return response; };
  const get = async (path: string, locale = "th") => absorb(await handler(new Request(origin + path, { headers: { cookie: jar(), "accept-language": locale } })));
  const post = async (path: string, body: Record<string, string>, locale = "th") => absorb(await handler(new Request(origin + path, { method: "POST", headers: { cookie: jar(), origin, "accept-language": locale, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() })));
  return { app, store, clock, state, credentials, handler, get, post, link: () => new URL(issueOwnerSetupLink(store, origin, clock.now)!), cookies };
}
const settle = async (f: { credentials: Map<string, string> }) => { for (let i = 0; i < 400 && !f.credentials.size; i++) await Bun.sleep(5); };

/** Signed-in, set-up installation for the surfaces after first run. */
async function ready(language: "th" | "en" = "en", options: { tools?: string[]; computers?: S14Options["computers"]; attempts?: number; reply?: S14Options["chat"] } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-s14-after-ui-"))); roots.push(root);
  const store = new S14Store(join(root, "s14.sqlite")), clock = { now: 1800000000000 }, tools = options.tools ?? ["web_search", "web_fetch"];
  const app = new S14Application(store, { policy: { routes: [{ id: "selected", provider: "codex", model: "scripted-model" }], tools, resources: [] }, now: () => clock.now, parallel: { transport }, computers: options.computers ?? {}, chat: options.reply ?? { async reply() { return { text: "Fixture reply", task: { title: "Suggested <b>task</b>", purpose: "Read facts", completionRule: "Evidence" } }; } }, authority: { executor: { async run() { return { state: "ready", text: "Evidence retained" }; } } } } as S14Options);
  apps.push(app); app.signIns.providers = async () => [{ id: "selected", provider: "codex", model: "scripted-model", readiness: "configured-unverified" }];
  await app.provisionOwner(password);
  const token = await app.login(password), auth = app.authenticate(token), handler = createS14Handler(app, origin, renderS14, createS14Product(app), createS14Auth(app));
  const conversationId = app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: 0, payload: { ownerName: "Owner", language, routeId: "selected", capabilities: { tools, resources: [] } } }).conversation!.id;
  const get = (path: string) => handler(new Request(origin + path, { headers: { cookie: `jit_s14=${token}` } }));
  const page = async (path: string) => { const response = await get(path); expect(response.status).toBe(200); return response.text(); };
  const post = (path: string, body: Record<string, string>) => handler(new Request(origin + path, { method: "POST", headers: { cookie: `jit_s14=${token}`, origin, "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(body).toString() }));
  const revision = () => app.conversation(auth.actor, conversationId).conversation.revision;
  const start = (title = "Compare", granted: string[] = ["web_search"], attempts = options.attempts ?? 4) => app.execute(auth.actor, { kind: "work.start", requestId: rid(), expectedRevision: revision(), payload: { conversationId, task: null, title, purpose: `${title} purpose`, completionRule: "Owner review", bots: [{ id: "jit", revision: 1 }], tools: granted, scopes: [], limits: { attempts, steps: attempts, calls: 20, outputBytes: 32768, wallMs: 3600000 }, expiresAt: clock.now + 3600000 } }).work!;
  const stopped = (work: { id: string }, text: string, state: "ready" | "waiting" = "waiting", calls = 2) => { const attempt = app.authority.admit(work.id, rid(), { botId: "jit", tools: ["web_search"], scopes: [], input: "x", calls, outputBytes: 4096 }); return { attempt, commit: () => app.authority.commit(attempt.id, { state, text }) }; };
  return { app, store, clock, auth, handler, get, page, post, conversationId, start, stopped, revision, words: dictionaries[language] };
}

test("the fresh journey runs with no script and no shell: link, password, provider, device code, name, first reply", async () => {
  const f = await fresh(), words = dictionaries.th, link = f.link();
  const opened = await f.get(link.pathname + link.search); expect(opened.status).toBe(303); expect(opened.headers.get("location")).toBe("/owner/setup"); expect(opened.headers.get("location")).not.toContain("token");
  const setupPage = await (await f.get("/owner/setup")).text(); strict(setupPage, "th"); clean(setupPage, "th");
  expect(setupPage).toContain(words["s14.first.password_title"]); expect(setupPage).toContain('autocomplete="new-password"'); expect(setupPage).not.toContain(link.searchParams.get("token")!);
  const form = fields(formsFor(setupPage, "/owner/setup")[0]!);
  expect(Object.keys(form).sort()).toEqual(["confirm", "csrf", "password"]);

  const mismatch = await f.post("/owner/setup", { ...form, password: "a-long-password-1", confirm: "a-long-password-2" }), mismatchPage = await mismatch.text();
  expect(mismatch.status).toBe(400); expect(mismatch.headers.get("content-type")).toContain("text/html"); expect(mismatchPage).toContain(words["s14.error.owner_setup_password_mismatch"]); expect(mismatchPage).not.toContain("a-long-password"); strict(mismatchPage, "th");
  const short = await f.post("/owner/setup", { ...form, password: "short", confirm: "short" }), shortPage = await short.text();
  expect(short.status).toBe(400); expect(shortPage).toContain(words["s14.error.password_length_12_to_256"]); expect(shortPage).not.toContain('value="short"');

  const created = await f.post("/owner/setup", { ...form, password, confirm: password }); expect(created.status).toBe(303); expect(created.headers.get("location")).toBe("/");
  const providers = await (await f.get("/")).text(); strict(providers, "th"); clean(providers, "th");
  expect(providers).toContain(words["s14.provider.choose_title"]); expect(providers).toContain("Codex"); expect(providers).toContain("Grok"); expect(providers).toContain(words["s14.provider.state.needs-login"]);
  expect(providers).not.toContain("gpt-"); expect(providers).not.toMatch(/name="(model|alias|routeId)"/); expect(providers).not.toContain("/s14/forms/setup");

  const started = await f.post("/s14/commands", commandForm(providers, "setup.sign_in")), approvalPage = await started.text();
  expect(started.status).toBe(200); strict(approvalPage, "th"); clean(approvalPage, "th");
  expect(approvalPage).toContain(deviceCode); expect(approvalPage).toContain('href="https://auth.example.test/device" target="_blank" rel="noopener noreferrer"'); expect(approvalPage).toContain(words["s14.signin.once"]); expect(approvalPage).toContain('hidden>'); expect(approvalPage).toContain("data-sign-in=");
  const flow = /href="\/s14\/sign-in\/codex\/([a-zA-Z0-9_-]+)"/.exec(approvalPage)![1]!;
  const stored = f.store.read(tx => tx.all<{ result_json: string }>("SELECT result_json FROM command_receipts")).map(row => row.result_json).join("");
  expect(stored).not.toContain(deviceCode); expect(stored).not.toContain("auth.example.test");

  const waiting = await (await f.get(`/s14/sign-in/codex/${flow}`)).text(); strict(waiting, "th");
  expect(waiting).not.toContain(deviceCode); expect(waiting).not.toContain("auth.example.test"); expect(waiting).toContain(words["s14.signin.pending_title"]); expect(hasCommand(waiting, "setup.sign_in.cancel")).toBe(true);

  f.state.approved = true; await settle(f); await Bun.sleep(20);
  const done = await (await f.get(`/s14/sign-in/codex/${flow}`)).text(); strict(done, "th");
  expect(done).toContain(words["s14.signin.ready_detail"]); expect(done).toContain('href="/?provider=codex"'); expect(done).not.toContain("data-sign-in=");
  const know = await (await f.get("/?provider=codex")).text(); strict(know, "th"); clean(know, "th");
  expect(know).toContain(`${words["s14.provider.using"]} Codex`); expect(know).toContain('href="/?change"');
  const setup = fields(formsFor(know, "/s14/forms/setup")[0]!);
  expect(setup).toMatchObject({ language: "th", "tool:web_search": "on", "tool:web_fetch": "on" });
  expect(Object.keys(setup)).toContain("routeId"); expect(setup.routeId).toBe("codex");
  const posted = await f.post("/s14/forms/setup", { ...setup, ownerName: "พลอย" }); expect(posted.status).toBe(303); expect(posted.headers.get("location")).toBe("/");
  const home = await (await f.get("/")).text(); expect(home).toContain("พลอย"); strict(home, "th");
  const compose = fields(formsFor(home, "/s14/forms/compose")[0]!);
  const sent = await f.post("/s14/forms/compose", { ...compose, text: "สวัสดีจิต" }); expect(sent.status).toBe(303);
  await f.app.drainReplies();
  const chat = await (await f.get(sent.headers.get("location")!.replace("#latest", ""))).text();
  expect(chat).toContain("สวัสดีจิต"); expect(chat).toMatch(/s-bot-text">สวัสดี</); expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM work_items")!.n)).toBe(0);
});

test("every device state explains itself in both languages with one obvious action and no approval data", () => {
  const states = ["starting", "pending", "busy", "ready", "expired", "denied", "cancelled", "provider-error", "store-error", "cleanup-required"] as const;
  for (const locale of ["th", "en"] as const) for (const state of states) for (const setup of [true, false]) {
    const receipt: S14SignInReceipt = { kind: "setup.sign_in", requestId: "flow", provider: "grok", signIn: { id: "flow", expiresAt: null, state } };
    const html = renderSignIn(receipt, "csrf-token", 7, locale, { now: 1, setup, theme: "system" });
    strict(html, locale); clean(html, locale); expect(html).toContain("Grok");
    expect(html).not.toContain('class="s-code"');
    const retry = ["expired", "denied", "cancelled", "provider-error", "store-error", "cleanup-required"].includes(state);
    expect(hasCommand(html, "setup.sign_in")).toBe(retry); expect(hasCommand(html, "setup.sign_in.cancel")).toBe(state === "pending" || state === "starting");
    expect(html.includes("data-sign-in=")).toBe(state === "pending" || state === "starting");
    if (retry) { expect(JSON.parse(commandForm(html, "setup.sign_in").command!)).toMatchObject({ expectedRevision: 7, payload: { provider: "grok", flowId: null } }); expect(html).toContain(dictionaries[locale]["s14.signin.other"]); }
    if (state === "ready") expect(html).toContain(setup ? 'href="/?provider=grok"' : 'href="/settings/provider"');
  }
  const words = dictionaries.en, html = (state: "expired" | "denied") => renderSignIn({ kind: "setup.sign_in", requestId: "flow", provider: "codex", signIn: { id: "flow", expiresAt: null, state } }, "csrf", 1, "en", { now: 1, setup: true, theme: "dark" });
  expect(html("expired")).toContain(words["s14.signin.new_code"]); expect(html("expired")).toContain(words["s14.signin.expired_title"]); expect(html("denied")).toContain(words["s14.signin.denied_title"].replace("{provider}", "Codex")); expect(html("denied")).toContain('data-theme="dark"');
});

test("hostile approval text is escaped, and only an https page becomes a link", () => {
  const render = (userCode: string, verificationUri: string) => renderSignIn({ kind: "setup.sign_in", requestId: "flow", provider: "codex", signIn: { id: "flow", expiresAt: 1000, state: "pending" }, approval: { userCode, verificationUri } }, "csrf", 1, "en", { now: 1, setup: true, theme: "system" });
  const html = render(hostile, `https://auth.example.test/?q=${hostile}`);
  expect(html).not.toContain("<img src=x"); expect(html).not.toContain("<script>alert"); expect(html).not.toContain('<button class="s-btn primary">Approve all'); strict(html);
  for (const uri of ["http://auth.example.test/device", `data:text/html,${hostile}`, "not a url"]) { const plain = render("CODE", uri); expect(plain).not.toContain('target="_blank"'); expect(plain).not.toContain("<img src=x"); }
});

test("a refused setup link is a page with one way forward, and gives nothing away", async () => {
  const f = await fresh();
  for (const locale of ["th", "en"] as const) {
    const response = await f.get("/owner/setup?token=" + "a".repeat(64), locale), html = await response.text();
    expect(response.status).toBe(403); expect(response.headers.get("content-type")).toContain("text/html"); expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(html).toContain(dictionaries[locale]["s14.first.refused_title"]); expect(html).toContain(dictionaries[locale]["s14.login.unprovisioned_note"]); expect(html).not.toContain("<form"); strict(html, locale); clean(html, locale);
  }
  const link = f.link(); await f.get(link.pathname + link.search);
  const form = fields(formsFor(await (await f.get("/owner/setup")).text(), "/owner/setup")[0]!);
  await f.post("/owner/setup", { ...form, password, confirm: password });
  const replay = await f.get(link.pathname + link.search), html = await replay.text();
  expect(replay.status).toBe(403); expect(html).toContain(dictionaries.th["s14.first.refused_owner"]); expect(html).toContain('href="/s14/login"');
  expect(renderOwnerSetupRefused("origin_rejected", "en", false)).toContain(dictionaries.en["s14.first.refused_post_title"]);
  // The bare contract handler stays JSON.
  const bare = await createS14Handler(f.app, origin)(new Request(`${origin}/owner/setup?token=x`)); expect(bare.headers.get("content-type")).toContain("application/json");
});

test("provider words are honest: a signed-in provider is unverified, and a state sign-in cannot fix offers no button", async () => {
  const f = await ready("en"), words = f.words, base = { id: "selected", provider: "codex" as const, model: "scripted-model" };
  for (const [readiness, button] of [["configured-unverified", true], ["needs-login", true], ["rejected", true], ["store-unavailable", true], ["invalid-store", true], ["quota-exceeded", true], ["cleanup-required", true], ["model-unavailable", false], ["integration-unavailable", false]] as const) {
    f.app.signIns.providers = async () => [{ ...base, readiness }];
    const html = await f.page("/settings/provider"); strict(html); clean(html, "en");
    expect(html).toContain(words[`s14.provider.state.${readiness}`]); expect(hasCommand(html, "setup.sign_in")).toBe(button); expect(html).toContain(words["s14.provider.settings_note"]); expect(html).toContain(`${words["s14.provider.in_use"]}: Jit`); expect(html).not.toContain("scripted-model"); expect(html).not.toContain('name="routeId"');
  }
});

test("a reply that fails names one next step, and the home page keeps its way to other chats without a sidebar", async () => {
  const f = await ready("en", { reply: { async reply() { throw new Error("provider said no"); } } });
  const fieldsOf = fields(formsFor(await f.page(`/chats/${f.conversationId}`), "/s14/forms/compose")[0]!);
  await f.post("/s14/forms/compose", { ...fieldsOf, text: "hello" }); await f.app.drainReplies();
  const html = await f.page(`/chats/${f.conversationId}`);
  expect(html).toContain(f.words["s14.reply.blocked"]); expect(html).toContain(`href="/settings/provider">${f.words["s14.reply.check_provider"]}`); expect(html).not.toContain("provider said no");
  expect(await f.page("/")).toContain('class="s-home-chats"');
});

test("the refusal page is the default, read-only, explains in both languages and offers no form", async () => {
  const handler = createS14RefusalHandler("/private/path/application.sqlite");
  for (const locale of ["th", "en"] as const) {
    const response = handler(new Request(`${origin}/anything`, { headers: { "accept-language": locale } })), html = await response.text();
    expect(response.status).toBe(409); expect(response.headers.get("content-security-policy")).toContain("script-src 'self'");
    expect(html).toContain(dictionaries[locale]["s14.legacy.untouched"]); expect(html).toContain("application.sqlite"); expect(html).not.toContain("/private/path"); expect(html).not.toContain("<form"); strict(html, locale); clean(html.replace(/--s14|bun src\S+/g, ""), locale);
  }
  expect(handler(new Request(`${origin}/`, { method: "POST" })).status).toBe(409);
  expect(renderRefusal("en", '<b>"x"')).not.toContain('<b>"x"');
});

test("rejecting a task grants nothing, stays in history and leaves no decision behind", async () => {
  const f = await ready("en"), words = f.words;
  const chatPage = fields(formsFor(await f.page(`/chats/${f.conversationId}`), "/s14/forms/compose")[0]!);
  await f.post("/s14/forms/compose", { ...chatPage, text: "hello" }); await f.app.drainReplies();
  const proposed = await f.page(`/chats/${f.conversationId}`), task = f.app.authority.list(f.auth.actor).find(w => w.state === "proposed")!;
  expect(proposed).toContain(words["s14.task.reject"]); expect(proposed).toContain("Suggested &lt;b&gt;task&lt;/b&gt;"); expect(proposed).toContain(words["s14.task.reject_note"]);
  const form = commandForm(proposed, "task.reject"); expect(JSON.parse(form.command!)).toMatchObject({ expectedRevision: task.revision, payload: { taskId: task.id } });
  const response = await f.post("/s14/commands", form); expect(response.status).toBe(303);
  const landing = await f.get(response.headers.get("location")!); expect(landing.status).toBe(303);
  const html = await f.page(landing.headers.get("location")!.replace("#latest", "")); strict(html); clean(html, "en");
  expect(html).toContain(words["s14.task.rejected_detail"]); expect(html).toContain("Suggested &lt;b&gt;task&lt;/b&gt;"); expect(hasCommand(html, "task.accept")).toBe(false); expect(hasCommand(html, "task.reject")).toBe(false); expect(html).not.toContain("/s14/forms/task-start");
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM work_grants")!.n)).toBe(0);
  const list = await f.page("/work"); expect(list).toContain(words["s14.work_list.rejected"]); expect(list).toContain("Suggested &lt;b&gt;task&lt;/b&gt;");
  const detail = await f.page(`/work/${task.id}`); expect(detail).toContain(words["s14.task.rejected_detail"]); expect(detail).not.toContain(words["s14.grant.none"]);
});

test("a new chat is one form, grants nothing and is told apart from the first", async () => {
  const f = await ready("th"), words = f.words, home = await f.page("/");
  const form = fields(formsFor(home, "/s14/forms/new-chat")[0]!); expect(Object.keys(form).sort()).toEqual(["botId", "csrf", "expectedRevision", "requestId"]);
  const response = await f.post("/s14/forms/new-chat", form); expect(response.status).toBe(303);
  const path = response.headers.get("location")!, html = await f.page(path); strict(html, "th");
  expect(html).toContain(`<h1>${words["s14.jit"]} · ${words["s14.chat.number"]} 2</h1>`); expect(f.app.home(f.auth.actor).conversations).toHaveLength(2); expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM work_grants")!.n)).toBe(0);
  expect((await f.post("/s14/forms/new-chat", { ...form, requestId: rid(), extra: "x" })).status).toBe(400);
  expect(await f.page("/team/jit")).toContain('action="/s14/forms/new-chat"');
  const refused = await f.post("/s14/forms/new-chat", { ...form, requestId: rid(), botId: "missing" }); expect(await refused.text()).toContain('href="/team/missing"');
});

test("language and theme apply at once to every page and survive only as a typed preference", async () => {
  const f = await ready("th"), more = await f.page("/more"); strict(more, "th");
  expect(more).toContain('name="theme" value="system" checked'); expect(more).not.toContain("data-theme="); expect(more).toContain('<meta name="color-scheme" content="dark light">');
  const form = fields(formsFor(more, "/s14/forms/preferences")[0]!); expect(Object.keys(form).sort()).toEqual(["csrf", "expectedRevision", "language", "requestId", "theme"]);
  const response = await f.post("/s14/forms/preferences", { ...form, language: "en", theme: "dark" }); expect(response.status).toBe(303);
  const saved = await f.page(response.headers.get("location")!); strict(saved); clean(saved, "en");
  expect(saved).toContain('<html lang="en" data-theme="dark">'); expect(saved).toContain('<meta name="color-scheme" content="dark">'); expect(saved).toContain(dictionaries.en["s14.more.saved"]); expect(saved).toContain('name="theme" value="dark" checked');
  expect(await f.page("/more")).not.toContain(dictionaries.en["s14.more.saved"]);
  expect(await f.page("/more?receipt=not-a-preference")).not.toContain(dictionaries.en["s14.more.saved"]);
  expect((await (await f.handler(new Request(`${origin}/s14/login`))).text())).toContain('data-theme="dark"');
  expect(renderFailure("en", "stale_revision", "/", "light")).toContain('data-theme="light"');
  const refused = await f.post("/s14/forms/preferences", { ...fields(formsFor(await f.page("/more"), "/s14/forms/preferences")[0]!), theme: "neon" }); expect(refused.status).toBe(400); expect(await refused.text()).toContain(dictionaries.en["s14.error.invalid_theme"]);
  expect((await f.post("/s14/forms/preferences", { ...form, requestId: rid(), extra: "x" })).status).toBe(400);
  expect(f.app.home(f.auth.actor).owner).toMatchObject({ language: "en", theme: "dark" });
});

test("unpin is an exact form, states what it keeps, and a stale tab is refused with the page intact", async () => {
  const f = await ready("en"), words = f.words;
  const decision = f.app.execute(f.auth.actor, { kind: "memory.decision.set", requestId: rid(), expectedRevision: 0, payload: { conversationId: f.conversationId, key: "k1", text: hostile } });
  const html = await f.page("/memory?scope=jit"); strict(html); expect(html).not.toContain("<img src=x"); expect(html).toContain(words["s14.memory.decision_unpin_note"]); expect(html).toContain(words["s14.memory.decisions_limit"]);
  const form = fields(formsFor(html, "/s14/forms/memory-unpin")[0]!); expect(form).toMatchObject({ botId: "jit", decisionId: decision.decision!.id, revision: "1", generation: "1", expectedRevision: "1" });
  const response = await f.post("/s14/forms/memory-unpin", form); expect(response.status).toBe(303);
  const landing = await f.page(response.headers.get("location")!); expect(landing).toContain(words["s14.memory.done.decision_unpin"]); expect(landing).not.toContain("/s14/forms/memory-unpin"); clean(landing, "en");
  expect(f.app.memory.decision(f.auth.actor, decision.decision!.id)).toMatchObject({ pinned: false, revision: 2 });
  const stale = await f.post("/s14/forms/memory-unpin", { ...form, requestId: rid() }); expect(stale.status).toBe(409); expect(await stale.text()).toContain(words["s14.error.stale_revision"]);
  expect((await f.post("/s14/forms/memory-unpin", { ...form, requestId: rid(), extra: "x" })).status).toBe(400);
});

test("retry and summarize say what exists, what they will not do, and post one exact command each", async () => {
  const f = await ready("en"), words = f.words, work = f.start(), { attempt, commit } = f.stopped(work, "Half done", "waiting", 12);
  await f.app.parallel.read(attempt.id, "web_search", { query: "public docs" }); commit();
  const html = await f.page(`/work/${work.id}`); strict(html); clean(html, "en");
  expect(html).toContain(words["s14.recover.title"]); expect(html).toContain(words["s14.recover.note"]); expect(html).toContain(words["s14.recover.summary_note"]); expect(html).toContain(words["s14.coverage.snippet"]); expect(html).toContain(`${words["s14.recover.evidence_of"]} Jit`);
  const current = f.app.authority.view(f.auth.actor, work.id).work;
  expect(JSON.parse(commandForm(html, "work.retry").command!)).toMatchObject({ expectedRevision: current.revision, payload: { workId: work.id } });
  const form = commandForm(html, "work.summarize"), response = await f.post("/s14/commands", form); expect(response.status).toBe(303);
  await f.app.authority.drain();
  const after = await f.page(`/work/${work.id}`); strict(after); expect(after).toContain(words["s14.recover.done_summarize"]); expect(after).toContain(words["s14.recover.done_summarize_detail"].replace("{count}", "1")); expect(after).toContain("Half done"); expect(after).toContain("Evidence retained");
  const summarized = f.app.authority.view(f.auth.actor, work.id); expect(summarized.attempts.at(-1)!.snapshot.tools).toEqual([]);
  expect(after).toContain(`<details class="s-more"><summary>${words["s14.recover.more"]}`);
});

test("with no evidence there is no summary control, and every blocker offers its unblock instead of a retry", async () => {
  const f = await ready("en"), words = f.words, none = f.start("No evidence"); f.stopped(none, "Nothing").commit();
  const bare = await f.page(`/work/${none.id}`);
  expect(bare).toContain(words["s14.recover.evidence_none"]); expect(bare).toContain(words["s14.recover.no_summary"]); expect(hasCommand(bare, "work.summarize")).toBe(false); expect(hasCommand(bare, "work.retry")).toBe(true);

  const spent = await ready("en", { attempts: 1 }), used = spent.start("Spent"); spent.stopped(used, "Done").commit();
  const out = await spent.page(`/work/${used.id}`); strict(out);
  expect(out).toContain(words["s14.recover.block.budget_title"]); expect(hasCommand(out, "work.retry")).toBe(false); expect(hasCommand(out, "work.summarize")).toBe(false);
  expect(out).toContain(`/chats/${spent.conversationId}?redo=${used.id}#s14-text`);
  const redo = await spent.page(`/chats/${spent.conversationId}?redo=${used.id}`); expect(redo).toContain("Spent purpose"); expect(redo).toContain('name="work" value="on" checked');
  expect(spent.store.read(tx => tx.get<{ n: number }>("SELECT count(*) n FROM work_grants")!.n)).toBe(1);
  expect(await spent.page(`/chats/${spent.conversationId}?redo=../../x`)).not.toContain("Spent purpose");

  const late = await ready("en"), old = late.start("Old"); late.stopped(old, "Done").commit(); late.clock.now += 3600001;
  const expired = await late.page(`/work/${old.id}`); expect(expired).toContain(words["s14.recover.block.expired_title"]); expect(hasCommand(expired, "work.retry")).toBe(false);

  const open = await ready("en"), running = open.start("Running"); open.stopped(running, "x");
  const busy = await open.page(`/work/${running.id}`); expect(busy).not.toContain(words["s14.recover.title"]);

  const stale = await ready("en"), work = stale.start("Stale"); stale.stopped(work, "Done").commit();
  const form = commandForm(await stale.page(`/work/${work.id}`), "work.retry"); expect((await stale.post("/s14/commands", form)).status).toBe(303);
  const again = await stale.post("/s14/commands", { ...form, command: JSON.stringify({ ...JSON.parse(form.command!), requestId: rid() }) }); expect(again.status).toBe(409); expect(await again.text()).toContain(words["s14.error.stale_revision"]);
});

test("a held external action blocks recovery with a link to its own card and never a retry", async () => {
  const f = await ready("en", { tools: ["web_search", "effect_send"] }), words = f.words, work = f.start("Send", ["effect_send"]);
  const attempt = f.app.authority.admit(work.id, rid(), { botId: "jit", tools: ["effect_send"], scopes: [], input: "x", calls: 2, outputBytes: 1024 });
  const effect = f.app.authority.proposeEffect(attempt.id, rid(), { kind: "send", destination: "https://recipient.invalid", content: "Hello" }, f.clock.now + 60000);
  f.app.authority.commit(attempt.id, { state: "waiting", text: "Held" });
  const html = await f.page(`/work/${work.id}`); strict(html);
  expect(html).toContain(words["s14.recover.block.effect_title"]); expect(html).toContain(`href="/effects/${effect.id}#slip">${words["s14.recover.block.effect_open"]}`); expect(hasCommand(html, "work.retry")).toBe(false); expect(hasCommand(html, "work.summarize")).toBe(false);
});

test("takeover renews in one action, expired or not, and the query feeds the open control and activity log", async () => {
  const runtime = new FakeComputerRuntime(), f = await ready("en", { tools: ["computer"], computers: { runtime } }), words = f.words, open = () => f.page("/team/jit?tab=computer");
  const empty = await open(); expect(empty).toContain(words["s14.computer.no_eligible"]); expect(hasCommand(empty, "computer.open")).toBe(false); strict(empty);
  const works = [1, 2, 3, 4].map(n => f.start(`Report ${n}`, ["computer"]));
  const many = await open(); expect(formsFor(many, "/s14/commands").filter(form => JSON.parse(fields(form).command!).kind === "computer.open")).toHaveLength(3); expect(many).toContain(`${words["s14.computer.more_eligible"]} 1`);
  f.app.execute(f.auth.actor, { kind: "computer.open", requestId: rid(), expectedRevision: 0, payload: { botId: "jit", workId: works[3]!.id } }); await f.app.computers.drain();
  const idle = await open(); await f.post("/s14/commands", commandForm(idle, "takeover.start"));
  const driving = await open(); strict(driving); expect(hasCommand(driving, "takeover.renew")).toBe(true); expect(hasCommand(driving, "takeover.end")).toBe(true); expect(driving).toContain(words["s14.lease.renew"]); expect(driving).toContain("up to 5 minutes");
  const before = f.app.computers.view(f.auth.actor, "jit"), posted = await f.post("/s14/commands", commandForm(driving, "takeover.renew")); expect(posted.status).toBe(303);
  const after = f.app.computers.view(f.auth.actor, "jit"); expect(after.lease!.revision).toBe(before.lease!.revision + 1); expect(after.lease!.actor).toBe("owner");
  f.clock.now += 300001;
  const expired = await open(); strict(expired); expect(expired).toContain(words["s14.lease.expired"]); expect(expired).toContain(words["s14.lease.resume"]); expect(expired).toContain(words["s14.lease.close_expired"]); expect(hasCommand(expired, "takeover.start")).toBe(false);
  expect(await (await f.post("/s14/commands", commandForm(expired, "takeover.renew"))).status).toBe(303);
  const resumed = await open(); expect(resumed).toContain(words["s14.lease.owner"]); expect(resumed).toContain(words["s14.activity.takeover.renew"]); expect(hasCommand(resumed, "takeover.renew")).toBe(true);
  expect(formsFor(driving, "/s14/commands").map(form => fields(form).command!).filter(c => JSON.parse(c).kind.startsWith("approval")).length).toBe(0);
});

test("the activity log has a word for every kind, and page identity stays untrusted text", async () => {
  const runtime = new FakeComputerRuntime(), f = await ready("th", { tools: ["computer"], computers: { runtime } }), words = f.words;
  const work = f.start("Report", ["computer"]);
  f.app.execute(f.auth.actor, { kind: "computer.open", requestId: rid(), expectedRevision: 0, payload: { botId: "jit", workId: work.id } }); await f.app.computers.drain();
  const kinds = ["page.opened", "screenshot", "agent.scroll", "system.stop", "takeover.renew", "computer.open", "computer.stop", "computer.reset", "computer.delete", "takeover.start", "takeover.end", "attempt.bound"] as const;
  f.app.computers.activity = () => kinds.map((kind, i) => ({ kind, at: f.clock.now - i, state: null }));
  const log = await f.page("/team/jit?tab=computer"); strict(log, "th"); clean(log, "th");
  for (const kind of kinds) expect(log).toContain(words[`s14.activity.${kind}`]);
  expect(log).toContain(words["s14.screen.page_unknown"]);

  const real = f.app.computers.view.bind(f.app.computers);
  f.app.computers.view = (actor, id) => ({ ...real(actor, id), page: { url: hostile, title: hostile, untrusted: true } as never });
  const html = await f.page("/team/jit?tab=computer"); strict(html, "th");
  expect(html).toContain(words["s14.screen.page_label"]); expect(html).not.toContain("<img src=x"); expect(html).not.toContain("<script>alert"); expect(html).not.toContain('<button class="s-btn primary">Approve all');
  expect(html).toContain('alt="'); expect(html.match(/<a\b[^>]*href="[^"]*onerror/)).toBeNull();
});

test("impact previews list bounded names from the service, escaped, with the omitted counts", async () => {
  const f = await ready("en"), words = f.words, claim = f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: f.revision(), payload: { conversationId: f.conversationId, text: "Saved fixture" } }).claim!;
  const real = f.app.memory.preview.bind(f.app.memory);
  f.app.memory.preview = (actor, ref) => ({ ...real(actor, ref), contexts: Array.from({ length: 70 }, (_, i) => `ctx${i}`), names: { bots: [{ id: "b1", name: hostile }], work: [{ id: "w1", title: hostile }], omittedBots: 2, omittedWork: 3 } });
  const html = await f.page(`/memory/jit/claims/${claim.id}?revision=${claim.revision}&generation=${claim.generation}&action=forget`); strict(html);
  expect(html).not.toContain("<img src=x"); expect(html).toContain(words["s14.memory.impact.bots"]); expect(html).toContain(`${words["s14.memory.impact.more"]} 2`); expect(html).toContain(`${words["s14.memory.impact.more"]} 3`); expect(html).toContain('href="/work/w1"');
  expect(visible(html)).toContain("4"); expect(html).toContain(">70<");
});
