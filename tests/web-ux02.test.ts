import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { dictionaries } from "../src/i18n";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";
import { legacyRedirect, panelTabs, paletteCommands, routeInventory, searchLimits, settingsPageHandler, settingsSections } from "../src/web-settings";
import { markSetupComplete } from "./fixtures/setup";
import { builtInModels } from "../src/team/route-options";

const password = "fixture-owner-password";
const origin = "http://localhost:3000";
const directories: string[] = [];
const stores: TransactionStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jit-ux02-")); directories.push(dir);
  const path = join(dir, "app.sqlite");
  const store = new TransactionStore(path); stores.push(store);
  const app = new Application(store, readConfig({ JIT_DATABASE: path }), { now: () => Date.UTC(2027, 0, 15, 8) });
  await app.setupOwner(password);
  markSetupComplete(store);
  const token = await app.login(password);
  return { app, store, token, auth: app.authenticate(token), web: createWebHandler(app) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const get = (f: Fixture, path: string, headers: Record<string, string> = {}, signedIn = true) =>
  f.web(new Request(`${origin}${path}`, { headers: { ...(signedIn ? { cookie: `jit_session=${f.token}` } : {}), ...headers } }));
const postForm = (f: Fixture, path: string, fields: Record<string, string>) =>
  f.web(new Request(`${origin}${path}`, { method: "POST", body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: `jit_session=${f.token}` } }));
const hostile = "<script>alert(1)</script>";

function project(f: Fixture, name: string) {
  const { actor } = f.auth;
  return f.app.execute(actor, { kind: "project.create", requestId: crypto.randomUUID(), projectId: null, expectedRevision: f.app.workspace(actor).revision, payload: { name } }).project;
}
function topic(f: Fixture, projectId: string, title: string) {
  const { actor } = f.auth;
  return f.app.execute(actor, { kind: "topic.create", requestId: crypto.randomUUID(), projectId, expectedRevision: f.app.project(actor, projectId).revision, payload: { title } }).topic;
}
function message(f: Fixture, projectId: string, topicId: string, text: string) {
  const { actor } = f.auth;
  const current = f.app.conversation(actor, projectId, topicId).topic;
  f.app.execute(actor, { kind: "message.send", requestId: crypto.randomUUID(), projectId, expectedRevision: current.revision, payload: { topicId, text } });
}
function propose(f: Fixture, projectId: string, topicId: string, title: string) {
  const { actor } = f.auth;
  const current = f.app.conversation(actor, projectId, topicId).topic;
  return f.app.execute(actor, { kind: "task.propose", requestId: crypto.randomUUID(), projectId, expectedRevision: current.revision, payload: { topicId, title, summary: "Summary" } }).task;
}
function seed(f: Fixture) {
  const p = project(f, `Project ${hostile}`);
  const t = topic(f, p.id, `Topic ${hostile}`);
  message(f, p.id, t.id, `Message ${hostile}`);
  const task = propose(f, p.id, t.id, `Task ${hostile}`);
  return { project: p, topic: f.app.conversation(f.auth.actor, p.id, t.id).topic, task };
}
function setLanguage(f: Fixture, language: "th" | "en") {
  const { revision } = f.app.preferences(f.auth.actor);
  f.app.execute(f.auth.actor, { kind: "ui.preferences.set", requestId: crypto.randomUUID(), projectId: null, expectedRevision: revision, payload: { theme: "system", language } });
}
/** Hidden inputs of the first form posting to `action`. */
function form(html: string, action: string): Record<string, string> {
  for (const match of html.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    if (match[1] !== action) continue;
    return Object.fromEntries([...match[2]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(m => [m[1]!, m[2]!]));
  }
  throw new Error(`no form for ${action}`);
}

test("web.settings_ia/v1 route inventory: every pre-UX02 page URL redirects to its settings page or still renders", async () => {
  const f = await fixture();
  const { project: p, topic: t, task } = seed(f);
  const unknown = crypto.randomUUID();
  const ids: Record<string, string> = { project: p.id, topic: t.id, task: task.id, source: t.source.sourceId };
  // A route that does not exist renders the generic error; a missing entity renders its own message.
  const routeMiss = new Set(Object.values(dictionaries).map(d => d["error.default"]));
  for (const entry of routeInventory) {
    const path = entry.from.replace(/:([a-z]+)/g, (_, name: string) => ids[name] ?? unknown)
      + (entry.from.endsWith("/sources/:source") ? `?revision=${t.source.revision}&generation=${t.source.generation}` : entry.from.endsWith("/claims/:claim") ? "?revision=1&generation=1" : "");
    const response = await get(f, path);
    if (entry.kind === "redirect") {
      expect([303, 308]).toContain(response.status);
      expect(response.headers.get("location")).toBe(entry.to!.replace(/:([a-z]+)/g, () => unknown));
      continue;
    }
    // Everything else answers at the same URL: a page, or the same redirect it answered before UX02.
    const html = await response.text();
    if (response.status === 303) { expect(response.headers.get("location")).toStartWith(`/projects/${p.id}/`); continue; }
    if (![200, 404, 409].includes(response.status)) throw new Error(`${path}: ${response.status}`);
    // A 404 here is the entity lookup (an unknown fixture id), never a route that no longer exists.
    if (response.status === 404) for (const text of routeMiss) expect(html, path).not.toContain(text);
    if (response.status === 200 && entry.kind === "settings") {
      expect(html).toContain('<nav class="settings-nav"');
      expect(html).toContain(`<a href="${settingsSections.find(s => s.id === entry.section)!.href}" aria-current="page">`);
    }
    if (response.status === 200 && entry.kind === "panel") expect(html).toContain('<nav class="project-tools"');
  }
  // Redirects keep the query string, happen before sign-in and never apply to commands or the JSON API.
  let response = await get(f, "/team?preset=tech");
  expect([response.status, response.headers.get("location")]).toEqual([308, "/settings/team?preset=tech"]);
  response = await get(f, "/backups", {}, false);
  expect([response.status, response.headers.get("location")]).toEqual([308, "/settings/backups"]);
  response = await get(f, "/settings/backups", {}, false);
  expect([response.status, response.headers.get("location")]).toEqual([303, "/login"]);
  for (const api of ["/api/team", "/api/backups", "/api/upgrades", "/api/restores"]) {
    response = await get(f, api);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
  }
  expect(legacyRedirect("/backups/x")).toBeNull();
  expect(legacyRedirect("/settings/backups")).toBeNull();
  expect(settingsPageHandler("/settings/telegram")).toBeNull();
  expect(settingsPageHandler(`/settings/restores/${unknown}`)).toBe(`/restores/${unknown}`);
  // New settings paths are pages only: posting to them is not a second command endpoint.
  expect((await postForm(f, "/settings/backups", { csrf: f.auth.csrf, requestId: crypto.randomUUID(), expectedRevision: "0" })).status).toBe(404);
  expect((await postForm(f, "/settings/team/roles", { csrf: f.auth.csrf })).status).toBe(404);
});

test("settings pages keep every command on its original endpoint with the same authority and receipts", async () => {
  const f = await fixture();
  for (const [page, action] of [["/settings/backups", "/backups"], ["/settings/upgrades", "/upgrades"], ["/settings/restores", "/restores"], ["/settings/team", "/team/roles"]] as const) {
    const html = await (await get(f, page)).text();
    expect(html).toContain(`action="${action}"`);
    expect(html).toContain('<nav class="settings-nav"');
  }
  // A role saved from the settings page form uses role.save, its CSRF/revision fields and returns to the settings page.
  const html = await (await get(f, "/settings/team")).text();
  const fields = form(html, "/team/roles");
  const response = await postForm(f, "/team/roles", { ...fields, name: "Reviewer", kind: "specialist", responsibility: "Checks correctness", enabled: "true", provider: "", model: "", authRoute: "" });
  expect([response.status, response.headers.get("location")]).toEqual([303, "/settings/team"]);
  expect(f.store.read(tx => tx.all<{ command_kind: string }>("SELECT command_kind FROM audit WHERE command_kind = 'role.save'"))).toHaveLength(1);
  // #167: the route picker sends no alias; a provider alone saves the recommended model with the provider as alias.
  const picker = await (await get(f, "/settings/team")).text();
  expect(picker).not.toContain('name="authRoute"');
  const routeForm = form(picker, "/team/routes");
  expect((await postForm(f, "/team/routes", { ...routeForm, roleId: "", provider: "codex", model: "" })).status).toBe(303);
  expect(f.app.team(f.auth.actor, null).ownerDefault).toEqual({ provider: "codex", model: builtInModels.codex, authRoute: "codex" });
  // The same form replayed is a stale revision, exactly as before the move.
  expect((await postForm(f, "/team/roles", { ...fields, requestId: crypto.randomUUID(), name: "Other", kind: "specialist", responsibility: "x", enabled: "true", provider: "", model: "", authRoute: "" })).status).toBe(409);
  // Settings sub-navigation lists every section, in Thai and English.
  for (const language of ["th", "en"] as const) {
    setLanguage(f, language);
    const page = await (await get(f, "/settings")).text();
    for (const section of settingsSections) expect(page).toContain(`<a href="${section.href}"${section.id === "general" ? ' aria-current="page"' : ""}>${dictionaries[language][section.label]}</a>`);
  }
  // Telegram status is read only: rendering it changes nothing.
  const before = f.store.read(tx => tx.get("SELECT revision, state FROM telegram_binding WHERE id = 1"));
  const telegram = await (await get(f, "/settings/telegram")).text();
  expect(telegram).toContain(dictionaries.en["telegram.unbound"]);
  expect(telegram).not.toMatch(/<form\b[^>]*method="post"[^>]*action="\/(?!logout)/);
  expect(f.store.read(tx => tx.get("SELECT revision, state FROM telegram_binding WHERE id = 1"))).toEqual(before);
});

test("topic right panel: closed by default, a separate page without script, one tab read per request", async () => {
  const f = await fixture();
  const { project: p, topic: t } = seed(f);
  const base = `/projects/${p.id}/topics/${t.id}`;
  const html = await (await get(f, base)).text();
  // Closed and empty on the topic page: the panel's data is not read until it is opened.
  expect(html).toContain(`<a class="header-action panel-toggle" href="${base}/panel" aria-controls="topic-panel" aria-expanded="false"`);
  expect(html).toContain('<aside class="topic-panel" id="topic-panel" aria-label="');
  expect(html).toMatch(/<aside class="topic-panel" id="topic-panel" aria-label="[^"]+" hidden><\/aside>/);
  // Focus order: header toggle, then the conversation and composer, then the panel after the main pane, then the palette.
  const order = ['class="header-action panel-toggle"', 'class="composer"', "</main>", 'id="topic-panel"', 'id="palette"'].map(marker => html.indexOf(marker));
  expect(order.every(index => index > 0)).toBe(true);
  expect(order).toEqual([...order].sort((a, b) => a - b));

  const panel = await (await get(f, `${base}/panel`)).text();
  expect(panel).toContain('<section class="panel-body" aria-labelledby="topic-panel-title" data-tab="tasks">');
  for (const tab of panelTabs) expect(panel).toContain(`href="${base}/panel?tab=${tab}" data-panel-tab="${tab}"`);
  expect(panel).toContain(`href="${base}/panel?tab=tasks" data-panel-tab="tasks" aria-current="page"`);
  expect(panel).toContain(`<a class="icon-button panel-close" href="${base}"`);
  expect(panel).toContain("Task &lt;script&gt;");
  expect(panel).not.toContain(hostile);
  // Panel focus order: heading (focus target), close, tabs, content.
  const inPanel = ["id=\"topic-panel-title\" tabindex=\"-1\"", "panel-close", 'class="panel-tabs"', 'class="panel-content"'].map(marker => panel.indexOf(marker));
  expect(inPanel.every(index => index > 0)).toBe(true);
  expect(inPanel).toEqual([...inPanel].sort((a, b) => a - b));
  for (const tab of panelTabs) {
    const response = await get(f, `${base}/panel?tab=${tab}`);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain(`data-tab="${tab}"`);
  }
  for (const bad of ["?tab=secrets", "?tab=tasks&tab=memory", "?tab="]) expect((await get(f, `${base}/panel${bad}`)).status).toBe(400);
  // Scope stays with the topic's own project.
  const other = project(f, "Other");
  expect((await get(f, `/projects/${other.id}/topics/${t.id}/panel`)).status).toBe(404);
  expect((await get(f, `/api${base}/panel`)).status).toBe(404);
  expect((await get(f, `${base}/panel`, {}, false)).headers.get("location")).toBe("/login");
  // The tasks tab reads this topic's tasks directly, not a project page filtered afterwards.
  const busy = topic(f, p.id, "Busy");
  for (let i = 0; i < f.app.config.pageSize + 1; i++) propose(f, p.id, busy.id, `Busy ${i}`);
  const fresh = topic(f, p.id, "Fresh");
  propose(f, p.id, fresh.id, "Fresh proposal");
  const freshPanel = await (await get(f, `/projects/${p.id}/topics/${fresh.id}/panel?tab=tasks`)).text();
  expect(freshPanel).toContain("Fresh proposal");
  expect(freshPanel).toContain('<span class="panel-count">1</span>');
  expect(freshPanel).not.toContain("Busy 0");
  // Reading the panel never changes state.
  const audit = f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM audit"))!.n;
  for (const tab of panelTabs) await get(f, `${base}/panel?tab=${tab}`);
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM audit"))!.n).toBe(audit);
});

test("⌘K query is bounded, read only, scoped to names and titles, and requires the owner session", async () => {
  const f = await fixture();
  const { project: p, topic: t } = seed(f);
  for (let i = 0; i < 9; i++) project(f, `Alpha ${i}`);
  for (let i = 0; i < 11; i++) topic(f, p.id, `Alpha topic ${i}`);
  message(f, p.id, t.id, "zebra-only-in-a-message");
  const search = async (q: string, headers: Record<string, string> = {}) => get(f, `/api/search?q=${encodeURIComponent(q)}`, headers);

  // An empty query reads no project data at all: commands only, so nothing is preloaded.
  let body = await (await search("")).json() as { query: string; items: { kind: string; label: string; detail: string | null; href: string }[]; more: boolean };
  expect(body.items.map(item => item.kind)).toEqual(paletteCommands.slice(0, searchLimits.commands).map(() => "command"));
  body = await (await search("alpha")).json() as typeof body;
  expect(body.items.filter(item => item.kind === "project")).toHaveLength(searchLimits.projects);
  expect(body.items.filter(item => item.kind === "topic")).toHaveLength(searchLimits.topics);
  expect(body.more).toBe(true);
  for (const item of body.items) expect(item.href).toMatch(/^\/(?![/\\])/);
  expect(body.items.find(item => item.kind === "topic")!.detail).toBe(p.name);
  // Message bodies are never searched.
  body = await (await search("zebra-only")).json() as typeof body;
  expect(body.items).toEqual([]);
  // Owner text is returned as data and escaped on the no-script page.
  body = await (await search("<script>")).json() as typeof body;
  expect(body.items.map(item => item.label).sort()).toEqual([`Project ${hostile}`, `Topic ${hostile}`]);
  const page = await (await get(f, `/search?q=${encodeURIComponent("<script>")}`)).text();
  expect(page).not.toContain(hostile);
  expect(page).toContain(`<a href="/projects/${p.id}/topics/${t.id}">`);
  expect(page).toContain('value="&lt;script&gt;"');
  // Command labels follow the owner language and match in either language.
  setLanguage(f, "en");
  body = await (await search("ตั้งค่า")).json() as typeof body;
  expect(body.items.some(item => item.kind === "command" && item.label === "Settings" && item.href === "/settings")).toBe(true);
  // Bounds and validation.
  expect((await search("a".repeat(searchLimits.query))).status).toBe(200);
  expect((await search("ก".repeat(searchLimits.query))).status).toBe(200);
  for (const response of [await search("a".repeat(searchLimits.query + 1)), await search("a\u0000b"), await get(f, "/api/search?q=a&q=b")]) {
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_query" });
  }
  expect((await get(f, `/search?q=${"a".repeat(searchLimits.query + 1)}`)).status).toBe(400);
  // A query that matches only navigation commands lists them without claiming there are no results.
  const commandsOnly = await (await get(f, `/search?q=${encodeURIComponent("Telegram")}`)).text();
  expect(commandsOnly).toContain('href="/settings/telegram"');
  expect(commandsOnly).not.toContain(`role="status">${dictionaries.en["search.no_results"]}`);
  expect(await (await get(f, "/search?q=nothing-matches-this")).text()).toContain(`<p class="empty-list" role="status">${dictionaries.en["search.no_results"]}</p>`);
  // Authorization: no session, no results; a forged cookie is refused the same way.
  let response = await get(f, "/api/search?q=alpha", {}, false);
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "authentication_required" });
  response = await f.web(new Request(`${origin}/api/search?q=alpha`, { headers: { cookie: `jit_session=${"0".repeat(64)}` } }));
  expect(response.status).toBe(401);
  expect(() => f.app.search({ ownerId: "owner", channel: "web" } as never, "alpha", searchLimits)).toThrow("authentication_required");
  // Searching is a read: no audit row, no receipt.
  const audit = f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM audit"))!.n;
  await search("alpha");
  expect(f.store.read(tx => tx.get<{ n: number }>("SELECT count(*) AS n FROM audit"))!.n).toBe(audit);
});

test("palette markup: closed dialog in every shell, labels from the dictionary, search link works without script", async () => {
  const f = await fixture();
  seed(f);
  for (const language of ["th", "en"] as const) {
    setLanguage(f, language);
    const html = await (await get(f, "/")).text();
    const d = dictionaries[language];
    expect(html).toContain(`<a class="nav-main nav-search" href="/search" aria-keyshortcuts="Meta+K Control+K"><svg`);
    expect(html).toContain(`<span>${d["shell.search"]}</span>`);
    expect(html).toMatch(/<dialog class="palette" id="palette" aria-labelledby="palette-title"/);
    // The dialog tag carries no `open` attribute (attribute values stripped before the check).
    expect(/<dialog\b[^>]*>/.exec(html)![0].replace(/"[^"]*"/g, '""')).not.toMatch(/\sopen\b/);
    for (const key of ["search.kind_command", "search.kind_project", "search.kind_topic", "search.no_results", "search.searching", "search.unavailable", "search.more_on_page"] as const) expect(html).toContain(`"${d[key]}"`);
    // Inside the dialog the query field is the first focusable control, so opening lands on it.
    const dialog = html.slice(html.indexOf('<dialog class="palette"'), html.indexOf("</dialog>"));
    expect(dialog.search(/<(input|button|a|select|textarea)\b(?![^>]*type="hidden")/)).toBe(dialog.indexOf('<input id="palette-query"'));
    expect(dialog).toContain('role="combobox" aria-expanded="false" aria-controls="palette-results"');
    expect(dialog).toContain('<form class="palette-form" method="get" action="/search" role="search">');
  }
});

test("sidebar badges show items waiting on the owner with words and a number, not colour alone", async () => {
  const f = await fixture();
  const { project: p, topic: t, task } = seed(f);
  const quiet = project(f, "Quiet");
  propose(f, p.id, t.id, "Second");
  for (const language of ["th", "en"] as const) {
    setLanguage(f, language);
    const d = dictionaries[language];
    const html = await (await get(f, `/projects/${quiet.id}`)).text();
    const badge = `<span class="nav-badge" title="${d["shell.badge_proposals"]} 2 · ${d["shell.badge_reviews"]} 0 · ${d["shell.badge_resumes"]} 0"><span aria-hidden="true">${d["shell.badge_waiting"]} 2</span><span class="sr-only">${d["shell.badge_waiting_long"]} 2: `;
    expect(html).toContain(badge);
    // Only the project with waiting items carries a badge.
    expect(html.match(/class="nav-badge"/g)).toHaveLength(1);
    const quietLink = html.slice(html.indexOf(`href="/projects/${quiet.id}"`), html.indexOf("</a>", html.indexOf(`href="/projects/${quiet.id}"`)));
    expect(quietLink).not.toContain("nav-badge");
  }
  // Accepting a proposal removes it from the count.
  const current = f.app.task(f.auth.actor, p.id, task.id);
  f.app.execute(f.auth.actor, { kind: "task.accept", requestId: crypto.randomUUID(), projectId: p.id, expectedRevision: current.task.revision, payload: { taskId: task.id, proposalId: current.proposals.at(-1)!.id } });
  expect(f.app.attention(f.auth.actor, [p.id, quiet.id])).toEqual({ [p.id]: { proposals: 1, reviews: 0, resumes: 0 }, [quiet.id]: { proposals: 0, reviews: 0, resumes: 0 } });
  // The read is bounded and validated.
  expect(() => f.app.attention(f.auth.actor, Array.from({ length: 51 }, () => crypto.randomUUID()))).toThrow("invalid_project_list");
  expect(() => f.app.attention(f.auth.actor, ["not-an-id"])).toThrow();
  expect(f.app.attention(f.auth.actor, [])).toEqual({});
});

/** A small DOM stand-in: just the element API app.js uses for the panel and the palette. */
class FakeElement {
  id = ""; className = ""; hidden = false; textContent = ""; value = ""; open = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  children: FakeElement[] = [];
  parent: FakeElement | null = null;
  listeners: Record<string, ((event: any) => unknown)[]> = {};
  constructor(readonly tag: string, readonly dom: FakeDom, init: Partial<Pick<FakeElement, "id" | "className" | "hidden">> & { attributes?: Record<string, string>; dataset?: Record<string, string> } = {}) {
    Object.assign(this, { id: init.id ?? "", className: init.className ?? "", hidden: init.hidden ?? false, dataset: { ...init.dataset } });
    for (const [key, value] of Object.entries(init.attributes ?? {})) this.attributes.set(key, value);
  }
  get classList() { return { contains: (name: string) => this.className.split(" ").includes(name) }; }
  setAttribute(key: string, value: string) { this.attributes.set(key, String(value)); }
  getAttribute(key: string) { return this.attributes.get(key) ?? null; }
  removeAttribute(key: string) { this.attributes.delete(key); }
  addEventListener(type: string, fn: (event: any) => unknown) { (this.listeners[type] ??= []).push(fn); }
  async dispatch(type: string, event: Record<string, unknown> = {}) {
    const e = { defaultPrevented: false, target: this, preventDefault() { this.defaultPrevented = true; }, ...event };
    for (let node: FakeElement | null = this; node; node = node.parent) await Promise.all((node.listeners[type] ?? []).map(fn => fn(e)));
    if (type === "keydown") await Promise.all((this.dom.listeners[type] ?? []).map(fn => fn(e)));
    return e;
  }
  focus() { this.dom.activeElement = this; }
  append(...nodes: FakeElement[]) { for (const node of nodes) { node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: FakeElement[]) { this.children = []; this.append(...nodes); }
  descendants(): FakeElement[] { return this.children.flatMap(child => [child, ...child.descendants()]); }
  matches(selector: string): boolean {
    if (selector.startsWith("#")) return this.id === selector.slice(1);
    if (selector.startsWith(".")) return this.classList.contains(selector.slice(1));
    const data = /^\[data-([a-z-]+)="([^"]+)"\]$/.exec(selector);
    if (data) return this.dataset[data[1]!.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] === data[2];
    return this.tag === selector;
  }
  querySelector(selector: string) { return this.descendants().find(node => node.matches(selector)) ?? null; }
  closest(selector: string) { for (let node: FakeElement | null = this; node; node = node.parent) if (node.matches(selector)) return node; return null; }
  showModal() { this.open = true; }
  close() { if (!this.open) return; this.open = false; void this.dispatch("close"); }
}
interface FakeDom { activeElement: FakeElement | null; listeners: Record<string, ((event: any) => unknown)[]> }

/** Builds a page with an `.app`, a topic panel toggle and aside, a sidebar search link and the palette dialog. */
function page() {
  const dom: FakeDom = { activeElement: null, listeners: {} };
  const el = (tag: string, init: ConstructorParameters<typeof FakeElement>[2] = {}) => new FakeElement(tag, dom, init);
  const app = el("div", { className: "app" });
  const toggle = el("a", { className: "header-action panel-toggle", attributes: { href: "/projects/p/topics/t/panel", "aria-expanded": "false" } });
  const aside = el("aside", { id: "topic-panel", className: "topic-panel", hidden: true });
  const search = el("a", { className: "nav-main nav-search", attributes: { href: "/search" } });
  const palette = el("dialog", { id: "palette", className: "palette", dataset: { kindCommand: "Go to", kindProject: "Project", kindTopic: "Topic", empty: "No results", loading: "Searching", error: "Unavailable", more: "More" } });
  const form = el("form", { className: "palette-form" });
  const input = el("input", { id: "palette-query" });
  const list = el("ul", { id: "palette-results" });
  const status = el("p", { className: "palette-status" });
  form.append(input); palette.append(form, list, status);
  /** The `.panel-body` the panel page at `href` returns. */
  const panelBody = (tab: string) => {
    const body = el("section", { className: "panel-body", dataset: { tab } });
    const title = el("h2", { id: "topic-panel-title" });
    const close = el("a", { className: "icon-button panel-close", attributes: { href: "/projects/p/topics/t" } });
    const tabs = ["memory", "tasks"].map(name => el("a", { attributes: { href: `/projects/p/topics/t/panel?tab=${name}` }, dataset: { panelTab: name } }));
    body.append(title, close, ...tabs);
    return body;
  };
  const fetched: { url: string; init: any }[] = [];
  const assigned: string[] = [];
  let searchItems: unknown[] = [];
  let failNext = false, holdTimers = false;
  const held: (() => void)[] = [];
  const globals = {
    document: {
      documentElement: { dataset: {} as Record<string, string> },
      get activeElement() { return dom.activeElement; },
      getElementById: (id: string) => ({ "topic-panel": aside, palette } as Record<string, FakeElement>)[id] ?? null,
      querySelector: (selector: string) => ({ ".app": app, ".panel-toggle": toggle, ".nav-search": search } as Record<string, FakeElement>)[selector] ?? null,
      querySelectorAll: () => [],
      createElement: (tag: string) => el(tag),
      adoptNode: (node: FakeElement) => node,
      addEventListener: (type: string, fn: (event: any) => unknown) => { (dom.listeners[type] ??= []).push(fn); },
    },
    window: { addEventListener() {}, setTimeout: (fn: () => void) => { if (holdTimers) held.push(fn); else fn(); return 1; }, clearTimeout() { held.length = 0; } },
    location: { hash: "", pathname: "/projects/p/topics/t", search: "", assign: (url: string) => assigned.push(url) },
    history: { replaceState() {} },
    CSS: { supports: () => true },
    DOMParser: class { parseFromString(text: string) { return { querySelector: () => panelBody(new URL(text, origin).searchParams.get("tab") ?? "tasks") }; } },
    fetch: async (url: string, init: any) => {
      fetched.push({ url, init });
      if (failNext) { failNext = false; return { ok: false, status: 503, headers: { get: () => "text/html" } }; }
      if (url.startsWith("/api/search")) return { ok: true, json: async () => ({ items: searchItems, more: false }), headers: { get: () => "application/json" } };
      return { ok: true, text: async () => url, headers: { get: () => "text/html; charset=utf-8" } };
    },
  };
  return { dom, app, toggle, aside, search, palette, input, list, status, fetched, assigned, globals,
    setResults: (items: unknown[]) => { searchItems = items; }, failNextFetch: () => { failNext = true; }, holdTimers: (hold: boolean) => { holdTimers = hold; } };
}
async function load(globals: Record<string, unknown>): Promise<() => void> {
  const saved = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  const restore = () => { for (const [key, d] of saved) { if (d) Object.defineProperty(globalThis, key, d); else delete (globalThis as Record<string, unknown>)[key]; } };
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
  try { await import(`../src/web-assets/app.js?case=${crypto.randomUUID()}`); } catch (error) { restore(); throw error; }
  return restore;
}

test("app.js panel contract: opens from the server page, moves focus in and back, tabs load in place, Escape closes", async () => {
  const dom = page();
  const restore = await load(dom.globals);
  try {
    expect(dom.aside.hidden).toBe(true);
    expect(dom.app.dataset.panel).toBe("closed");
    const click = await dom.toggle.dispatch("click");
    expect(click.defaultPrevented).toBe(true);
    expect(dom.fetched).toEqual([{ url: "/projects/p/topics/t/panel", init: { credentials: "same-origin", headers: { accept: "text/html" } } }]);
    expect(dom.aside.hidden).toBe(false);
    expect(dom.toggle.getAttribute("aria-expanded")).toBe("true");
    expect(dom.aside.children[0]!.className).toBe("panel-body");
    expect(dom.dom.activeElement?.id).toBe("topic-panel-title");
    // A tab link loads its panel page in place and keeps focus on that tab.
    const tab = dom.aside.querySelector('[data-panel-tab="memory"]')!;
    await tab.dispatch("click");
    expect(dom.fetched.at(-1)!.url).toBe("/projects/p/topics/t/panel?tab=memory");
    expect(dom.aside.children[0]!.dataset.tab).toBe("memory");
    expect(dom.dom.activeElement?.dataset.panelTab).toBe("memory");
    // Escape closes and returns focus to the toggle; reopening reuses the loaded panel.
    await dom.aside.dispatch("keydown", { key: "Escape" });
    expect(dom.aside.hidden).toBe(true);
    expect(dom.toggle.getAttribute("aria-expanded")).toBe("false");
    expect(dom.dom.activeElement).toBe(dom.toggle);
    const count = dom.fetched.length;
    await dom.toggle.dispatch("click");
    expect(dom.fetched).toHaveLength(count);
    expect(dom.aside.hidden).toBe(false);
    // The close link and a second toggle click both close.
    await dom.aside.querySelector(".panel-close")!.dispatch("click");
    expect(dom.aside.hidden).toBe(true);
    // If the panel page cannot be loaded, the browser opens it as a page (the no-script path).
    dom.failNextFetch();
    await dom.aside.querySelector('[data-panel-tab="tasks"]')!.dispatch("click");
    expect(dom.assigned).toEqual(["/projects/p/topics/t/panel?tab=tasks"]);
  } finally { restore(); }
});

test("app.js palette contract: ⌘K/Ctrl+K opens on the query field, arrows move the active row, Enter opens, Escape returns focus", async () => {
  const dom = page();
  const restore = await load(dom.globals);
  try {
    const opener = new FakeElement("button", dom.dom);
    opener.focus();
    dom.setResults([
      { kind: "project", label: "<b>Alpha</b>", detail: null, href: "/projects/a" },
      { kind: "topic", label: "Plan", detail: "Alpha", href: "/projects/a/topics/b" },
      { kind: "command", label: "Settings", detail: null, href: "/settings" },
      { kind: "command", label: "Evil", detail: null, href: "//evil.example/x" },
      { kind: "command", label: "Evil 2", detail: null, href: "/\\evil.example" },
      { kind: "command", label: "Evil 3", detail: null, href: "https://evil.example" },
    ]);
    const shortcut = await dom.input.dispatch("keydown", { key: "k", ctrlKey: true });
    expect(shortcut.defaultPrevented).toBe(true);
    expect(dom.palette.open).toBe(true);
    expect(dom.dom.activeElement).toBe(dom.input);
    expect(dom.fetched.at(-1)).toEqual({ url: "/api/search?q=", init: expect.objectContaining({ credentials: "same-origin", headers: { accept: "application/json" } }) });
    await Promise.resolve();
    // Only same-origin paths become rows; owner text is text, never markup.
    expect(dom.list.children.map(option => option.dataset.href)).toEqual(["/projects/a", "/projects/a/topics/b", "/settings"]);
    expect(dom.list.children[0]!.children.map(part => part.textContent)).toEqual(["Project", "<b>Alpha</b>"]);
    expect(dom.list.children[1]!.children.map(part => part.textContent)).toEqual(["Topic", "Plan", "Alpha"]);
    expect(dom.input.getAttribute("aria-expanded")).toBe("true");
    expect(dom.input.getAttribute("aria-activedescendant")).toBe("palette-option-0");
    await dom.input.dispatch("keydown", { key: "ArrowUp" });
    expect(dom.input.getAttribute("aria-activedescendant")).toBe("palette-option-2");
    await dom.input.dispatch("keydown", { key: "ArrowDown" });
    await dom.input.dispatch("keydown", { key: "ArrowDown" });
    expect(dom.input.getAttribute("aria-activedescendant")).toBe("palette-option-1");
    expect(dom.list.children.map(option => option.getAttribute("aria-selected"))).toEqual(["false", "true", "false"]);
    // Typing queries again with the typed text.
    dom.input.value = "plan";
    await dom.input.dispatch("input");
    expect(dom.fetched.at(-1)!.url).toBe("/api/search?q=plan");
    await Promise.resolve();
    await dom.input.dispatch("keydown", { key: "ArrowDown" });
    const enter = await dom.input.dispatch("keydown", { key: "Enter" });
    expect(enter.defaultPrevented).toBe(true);
    expect(dom.assigned).toEqual(["/projects/a/topics/b"]);
    expect(dom.palette.open).toBe(false);
    expect(dom.dom.activeElement).toBe(opener);
    // Escape (the dialog's own cancel) closes and returns focus; ⌘K toggles; the panel and drawer stay as they were.
    await dom.search.dispatch("click", { button: 0 });
    expect(dom.palette.open).toBe(true);
    dom.palette.close();
    expect(dom.palette.open).toBe(false);
    await dom.input.dispatch("keydown", { key: "k", metaKey: true });
    expect(dom.palette.open).toBe(true);
    await dom.input.dispatch("keydown", { key: "k", metaKey: true });
    expect(dom.palette.open).toBe(false);
    // No results and a failed query both say so in words; Enter then submits the form to /search.
    dom.setResults([]);
    await dom.input.dispatch("keydown", { key: "k", ctrlKey: true });
    await Promise.resolve();
    expect(dom.status.textContent).toBe("No results");
    const plainEnter = await dom.input.dispatch("keydown", { key: "Enter" });
    expect(plainEnter.defaultPrevented).toBe(false);
    dom.failNextFetch();
    dom.input.value = "x";
    await dom.input.dispatch("input");
    await Promise.resolve();
    expect(dom.status.textContent).toBe("Unavailable");
    expect(dom.list.children).toEqual([]);
    dom.palette.close();
    // Typing clears the previous query's active row, so Enter before the new results submits to /search instead.
    dom.setResults([{ kind: "command", label: "New chat", detail: null, href: "/" }]);
    await dom.input.dispatch("keydown", { key: "k", ctrlKey: true });
    await Promise.resolve();
    expect(dom.input.getAttribute("aria-activedescendant")).toBe("palette-option-0");
    dom.holdTimers(true);
    dom.input.value = "budget";
    await dom.input.dispatch("input");
    expect(dom.input.getAttribute("aria-activedescendant")).toBeNull();
    const pending = await dom.input.dispatch("keydown", { key: "Enter" });
    expect(pending.defaultPrevented).toBe(false);
    expect(dom.assigned).toEqual(["/projects/a/topics/b"]);
    dom.holdTimers(false);
    dom.palette.close();
    // The shortcut follows the physical K key under the Thai Kedmanee layout.
    await dom.input.dispatch("keydown", { key: "า", code: "KeyK", ctrlKey: true });
    expect(dom.palette.open).toBe(true);
  } finally { restore(); }
});
