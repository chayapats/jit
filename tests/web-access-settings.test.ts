import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { accessConfirmToken, type AccessLevel } from "../src/exec/access";
import { dictionaries } from "../src/i18n";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";
import { markSetupComplete } from "./fixtures/setup";

const password = "fixture-exe04-owner-password";
const origin = "http://localhost:3000";
const directories: string[] = [];
const stores: TransactionStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jit-exe04-")); directories.push(dir);
  const path = join(dir, "app.sqlite");
  const store = new TransactionStore(path); stores.push(store);
  const app = new Application(store, readConfig({ JIT_DATABASE: path }), { now: () => Date.UTC(2027, 0, 15, 8) });
  await app.setupOwner(password);
  markSetupComplete(store);
  const token = await app.login(password);
  return { app, store, token, auth: app.authenticate(token), web: createWebHandler(app) };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const rid = () => crypto.randomUUID();
const get = (f: Fixture, path: string, headers: Record<string, string> = {}, signedIn = true) =>
  f.web(new Request(`${origin}${path}`, { headers: { ...(signedIn ? { cookie: `jit_session=${f.token}` } : {}), ...headers } }));
const postForm = (f: Fixture, path: string, fields: Record<string, string>) =>
  f.web(new Request(`${origin}${path}`, { method: "POST", body: new URLSearchParams(fields).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: `jit_session=${f.token}` } }));
function setLanguage(f: Fixture, language: "th" | "en") {
  const { revision } = f.app.preferences(f.auth.actor);
  f.app.execute(f.auth.actor, { kind: "ui.preferences.set", requestId: rid(), projectId: null, expectedRevision: revision,
    payload: { theme: "system", language } });
}
/** Hidden inputs of the first form posting to `action`. */
function form(html: string, action: string): Record<string, string> {
  for (const match of html.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    if (match[1] !== action) continue;
    return Object.fromEntries([...match[2]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(m => [m[1]!, m[2]!]));
  }
  throw new Error(`no form for ${action}`);
}
function project(f: Fixture, name: string) {
  const { actor } = f.auth;
  return f.app.execute(actor, { kind: "project.create", requestId: rid(), projectId: null, expectedRevision: f.app.workspace(actor).revision, payload: { name } }).project;
}
function topic(f: Fixture, projectId: string, title: string) {
  const { actor } = f.auth;
  return f.app.execute(actor, { kind: "topic.create", requestId: rid(), projectId, expectedRevision: f.app.project(actor, projectId).revision, payload: { title } }).topic;
}
/** Widens through the Web channel with the token the confirmation page would render. */
function widen(f: Fixture, projectId: string, to: AccessLevel) {
  const state = f.app.projectAccess(f.auth.actor, projectId);
  return f.app.execute(f.auth.actor, { kind: "access.level.set", requestId: rid(), projectId, expectedRevision: state.revision,
    payload: { level: to, confirmToken: accessConfirmToken(projectId, state.level, to, state.revision) } });
}
function specialist(f: Fixture, name: string) {
  const { actor } = f.auth;
  return f.app.execute(actor, { kind: "role.save", requestId: rid(), projectId: null, expectedRevision: f.app.team(actor).ownerRevision,
    payload: { roleId: null, name, kind: "specialist", responsibility: "Checks access pages", enabled: true,
      route: { provider: "grok", model: "fixture-grok-exact", authRoute: "owner-grok" } } }).role!.id;
}

test("web.access_settings/v1: the access page lists every project with its badge", async () => {
  const f = await fixture();
  setLanguage(f, "en");
  const p = project(f, "Access project");
  const html = await (await get(f, "/settings/access")).text();
  expect(html).toContain(`id="access-${p.id}"`);
  expect(html).toContain('<span class="access-badge" data-level="read">Read only</span>');
  expect(html).toContain(`<a href="/settings/access/${p.id}/confirm?to=workspace&amp;rev=0">Raise to Workspace</a>`);
  // The default installation does not enable full yet: no widening link, only the note.
  expect(html).not.toContain("confirm?to=full");
  expect(html).toContain(dictionaries.en["access.full_unavailable"]);
});

test("web.access_settings/v1: narrowing posts the level and widening goes through the confirmation page", async () => {
  const f = await fixture();
  setLanguage(f, "en");
  const p = project(f, "Narrowing project");
  widen(f, p.id, "workspace");
  const fields = form(await (await get(f, "/settings/access")).text(), `/settings/access/${p.id}`);
  const narrowed = await postForm(f, `/settings/access/${p.id}`, { ...fields, level: "read" });
  expect([narrowed.status, narrowed.headers.get("location")]).toEqual([303, `/settings/access?project=${p.id}#access-${p.id}`]);
  expect(await (await get(f, "/settings/access")).text()).toContain('<span class="access-badge" data-level="read">Read only</span>');
  // The confirmation page binds one exact transition: rendering it shows the token for this revision.
  const current = f.app.projectAccess(f.auth.actor, p.id);
  const confirm = await (await get(f, `/settings/access/${p.id}/confirm?to=workspace&rev=${current.revision}`)).text();
  const token = accessConfirmToken(p.id, current.level, "workspace", current.revision);
  expect(confirm).toContain(`name="confirmToken" value="${token}"`);
  expect(confirm).toContain(dictionaries.en["access.confirm_button"]);
  // Submitting the confirmation raises the level and lands back on the project's row.
  const confirmFields = form(confirm, `/settings/access/${p.id}`);
  const raised = await postForm(f, `/settings/access/${p.id}`, { ...confirmFields, level: "workspace", confirmToken: token });
  expect([raised.status, raised.headers.get("location")]).toEqual([303, `/settings/access?project=${p.id}#access-${p.id}`]);
  expect(f.app.projectAccess(f.auth.actor, p.id).level).toBe("workspace");
  // A widening link to a level that is not higher redirects back instead of rendering.
  expect((await get(f, `/settings/access/${p.id}/confirm?to=read&rev=1`)).status).toBe(303);
});

test("web.access_settings/v1: an altered token or a stale revision is refused with a translated error", async () => {
  const f = await fixture();
  setLanguage(f, "en");
  const p = project(f, "Token project");
  const token = accessConfirmToken(p.id, "read", "workspace", 0);
  const forged = await postForm(f, `/settings/access/${p.id}`,
    { csrf: f.auth.csrf, requestId: rid(), expectedRevision: "0", level: "workspace", confirmToken: `${token.slice(0, -1)}${token.endsWith("0") ? "1" : "0"}` });
  expect(forged.status).toBe(409);
  expect(await forged.text()).toContain(dictionaries.en["access.error_confirm_required"]);
  expect(f.app.projectAccess(f.auth.actor, p.id).level).toBe("read");
});

test("web.access_settings/v1: a role above the project level is refused with a translated error", async () => {
  const f = await fixture();
  setLanguage(f, "en");
  const p = project(f, "Role project");
  widen(f, p.id, "workspace");
  const roleId = specialist(f, "Reviewer");
  const fields = form(await (await get(f, "/settings/access")).text(), `/settings/access/${p.id}/roles`);
  const refused = await postForm(f, `/settings/access/${p.id}/roles`, { ...fields, roleId, level: "full" });
  expect(refused.status).toBe(409);
  expect(await refused.text()).toContain(dictionaries.en["access.error_role_above_project"]);
});

test("web.access_settings/v1: stop everything halts and resume restores, with the badge telling the story", async () => {
  const f = await fixture();
  setLanguage(f, "en");
  const p = project(f, "Halt project");
  widen(f, p.id, "workspace");
  const halted = await postForm(f, `/settings/access/${p.id}/halt`,
    { csrf: f.auth.csrf, requestId: rid(), expectedRevision: "0" });
  expect(halted.status).toBe(303);
  const stopped = await (await get(f, "/settings/access")).text();
  expect(stopped).toContain('<span class="access-badge" data-level="workspace">Workspace <span class="access-strike"');
  expect(stopped).toContain(dictionaries.en["access.halted"]);
  expect(stopped).toContain(`action="/settings/access/${p.id}/resume"`);
  const resumed = await postForm(f, `/settings/access/${p.id}/resume`,
    { csrf: f.auth.csrf, requestId: rid(), expectedRevision: "1" });
  expect(resumed.status).toBe(303);
  expect(f.app.projectAccess(f.auth.actor, p.id).halted).toBe(false);
});

test("web.access_settings/v1: forms need a session and a CSRF token", async () => {
  const f = await fixture();
  const p = project(f, "Guarded project");
  expect((await get(f, "/settings/access", {}, false)).status).toBe(303);
  const forged = await postForm(f, `/settings/access/${p.id}`,
    { requestId: rid(), expectedRevision: "0", level: "workspace" });
  expect(forged.status).toBe(403);
});

test("web.access_settings/v1: role options never exceed the project level, with saved higher values kept as a note", async () => {
  const f = await fixture();
  setLanguage(f, "en");
  const p = project(f, "Role options project");
  const roleId = specialist(f, "Reviewer");
  widen(f, p.id, "workspace");
  // Pin the role at the project ceiling, then narrow the project below it.
  const restricted = await postForm(f, `/settings/access/${p.id}/roles`,
    { csrf: f.auth.csrf, requestId: rid(), expectedRevision: "0", roleId, level: "workspace" });
  expect(restricted.status).toBe(303);
  const narrowed = await postForm(f, `/settings/access/${p.id}`,
    { csrf: f.auth.csrf, requestId: rid(), expectedRevision: "1", level: "read" });
  expect(narrowed.status).toBe(303);
  const html = await (await get(f, "/settings/access")).text();
  // The select offers only the project level and below; the saved higher value stays as a read-only note.
  expect(html).toContain(`<p class="team-role-note">Workspace · ${dictionaries.en["access.error_role_above_project"]}</p>`);
  expect(html).not.toContain('value="workspace"');
  expect(html).not.toContain('value="full"');
});

test("web.access_settings/v1: the project and topic headers show the badge, in Thai and English", async () => {
  const f = await fixture();
  const p = project(f, "Badged project");
  widen(f, p.id, "workspace");
  const t = topic(f, p.id, "Badged topic");
  for (const language of ["th", "en"] as const) {
    setLanguage(f, language);
    const badge = `<span class="access-badge" data-level="workspace">${dictionaries[language]["access.level_workspace"]}</span>`;
    expect(await (await get(f, `/projects/${p.id}`)).text()).toContain(badge);
    const conversation = await (await get(f, `/projects/${p.id}/topics/${t.id}`)).text();
    expect(conversation).toContain(badge);
    // The topic header carries the kill switch while the level is wider than read.
    expect(conversation).toContain(`action="/settings/access/${p.id}/halt"`);
    expect(conversation).toContain(dictionaries[language]["access.stop_everything"]);
    // The sidebar names the level on every project row too.
    expect(conversation).toContain(badge);
  }
});

test("exec.computer/v1: the project row carries the Web-only confirm-every-action checkbox, on by default", async () => {
  const f = await fixture();
  const p = project(f, "Desktop project");
  const html = await (await get(f, "/settings/access")).text();
  const action = `/settings/access/${p.id}/computer`;
  expect(html).toContain(`action="${action}"`);
  expect(html).toContain('<input type="checkbox" name="confirmEveryAction" checked>');
  // An unticked box is absent from the post and turns the setting off; ticking it turns it back on.
  const off = await postForm(f, action, form(html, action));
  expect([off.status, off.headers.get("location")]).toEqual([303, `/settings/access?project=${p.id}#access-${p.id}`]);
  expect(f.app.computerSettings(f.auth.actor, p.id)).toMatchObject({ revision: 1, confirmEveryAction: false });
  const unticked = await (await get(f, "/settings/access")).text();
  expect(unticked).toContain('<input type="checkbox" name="confirmEveryAction">');
  const on = await postForm(f, action, { ...form(unticked, action), confirmEveryAction: "on" });
  expect(on.status).toBe(303);
  expect(f.app.computerSettings(f.auth.actor, p.id)).toMatchObject({ revision: 2, confirmEveryAction: true });
  // Replaying the first form returns its receipt; a new request at the stale revision is refused and changes nothing.
  expect((await postForm(f, action, form(html, action))).status).toBe(303);
  expect(f.app.computerSettings(f.auth.actor, p.id).revision).toBe(2);
  expect((await postForm(f, action, { ...form(html, action), requestId: rid() })).status).toBe(409);
  expect(f.app.computerSettings(f.auth.actor, p.id).confirmEveryAction).toBe(true);
  for (const key of ["access.computer_confirm_every", "access.computer_note"]) {
    expect(dictionaries.th[key as keyof typeof dictionaries.th]).toBeTruthy();
    expect(dictionaries.en[key as keyof typeof dictionaries.en]).toBeTruthy();
  }
});
