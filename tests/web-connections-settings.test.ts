import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { ConnectionVault } from "../src/exec/connections";
import { dictionaries } from "../src/i18n";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";
import { markSetupComplete } from "./fixtures/setup";

const password = "fixture-exe11-owner-password";
const origin = "http://localhost:3000";
const epoch = 1_800_000_000_000;
const roots: string[] = [];
const stores: TransactionStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-exe11-"))); roots.push(root);
  const state = join(root, "state"), backups = join(root, "backups"), execution = join(root, "execution"), secrets = join(root, "secrets");
  mkdirSync(state); mkdirSync(execution);
  const config = readConfig({ JIT_DATABASE: join(state, "jit.sqlite"), JIT_EXECUTION_DIR: execution, JIT_EXECUTION_SECRETS_DIR: secrets });
  const store = new TransactionStore(config.databasePath); stores.push(store);
  const vault = new ConnectionVault(secrets, { forbidden: [state, backups, execution] });
  const app = new Application(store, config, { now: () => epoch, backupDir: backups, connections: vault });
  const web = createWebHandler(app);
  await app.setupOwner(password);
  markSetupComplete(store);
  const token = await app.login(password);
  const auth = app.authenticate(token);
  const project = app.execute(auth.actor, { kind: "project.create", requestId: crypto.randomUUID(), projectId: null,
    expectedRevision: app.workspace(auth.actor).revision, payload: { name: "โครงการ connection" } }).project;
  return { root, config, store, vault, app, web, token, auth, project };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const rid = () => crypto.randomUUID();
function setLanguage(f: Fixture, language: "th" | "en") {
  const { revision } = f.app.preferences(f.auth.actor);
  f.app.execute(f.auth.actor, { kind: "ui.preferences.set", requestId: rid(), projectId: null, expectedRevision: revision,
    payload: { theme: "system", language } });
}
const get = (f: Fixture, path: string, headers: Record<string, string> = {}, signedIn = true) =>
  f.web(new Request(`${origin}${path}`, { headers: { ...(signedIn ? { cookie: `jit_session=${f.token}` } : {}), ...headers } }));
const postForm = (f: Fixture, path: string, fields: Record<string, string>, csrf: string | null = f.auth.csrf) =>
  f.web(new Request(`${origin}${path}`, { method: "POST", body: new URLSearchParams(csrf === null ? fields : { csrf, ...fields }).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie: `jit_session=${f.token}` } }));
/** Hidden inputs of the first form posting to `action`. */
function form(html: string, action: string): Record<string, string> {
  for (const match of html.matchAll(/<form\b[^>]*action="([^"]+)"[^>]*>([\s\S]*?)<\/form>/g)) {
    if (match[1] !== action) continue;
    return Object.fromEntries([...match[2]!.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map(m => [m[1]!, m[2]!]));
  }
  throw new Error(`no form for ${action}`);
}
function connections(f: Fixture) {
  return f.app.connections(f.auth.actor).filter(item => item.removedAt === null);
}

test("web.connections_settings/v1: the empty page names the title and the note, never a secret input value", async () => {
  const f = await fixture();
  setLanguage(f, "en");
  const html = await (await get(f, "/settings/connections")).text();
  expect(html).toContain(dictionaries.en["connection.title"]);
  expect(html).not.toContain('id="connection-');
  // A malformed test echo is rejected instead of rendered.
  expect((await get(f, "/settings/connections?tested=nope")).status).toBe(400);
});

test("web.connections_settings/v1: create, rotate, test and remove round-trip without ever showing the secret", async () => {
  const f = await fixture();
  setLanguage(f, "en");
  const secret = "ghp_fixture_SECRET_123", rotated = "ghp_fixture_ROTATED_456";
  const label = "GitHub <script>alert(1)</script>";
  const before = await (await get(f, "/settings/connections")).text();
  const created = await postForm(f, "/settings/connections",
    { ...form(before, "/settings/connections"), kind: "github_token", label, [`scope-${f.project.id}`]: "on", secret });
  expect(created.status).toBe(303);
  const location = created.headers.get("location")!;
  const id = location.slice(location.indexOf("#connection-") + "#connection-".length);
  expect(id).toMatch(/^[a-f0-9-]{36}$/);
  let html = await (await get(f, "/settings/connections")).text();
  expect(html).toContain(`id="connection-${id}"`);
  expect(html).not.toContain(label);
  expect(html).toContain("GitHub &lt;script&gt;");
  expect(html).toContain(dictionaries.en["connection.kind_github_token"]);
  expect(html).toContain(f.project.name);
  expect(html).not.toContain(secret);
  expect(html).not.toContain(encodeURIComponent(secret));
  // A connection without a scope checkbox serves every project.
  const second = await postForm(f, "/settings/connections",
    { ...form(html, "/settings/connections"), kind: "deploy_secret", label: "Deploy", secret });
  expect(second.status).toBe(303);
  html = await (await get(f, "/settings/connections")).text();
  expect(html).toContain(dictionaries.en["connection.scope_all"]);
  // Rotate replaces the value: the rotated time moves and neither value ever appears.
  const beforeRotate = connections(f).find(item => item.id === id)!;
  expect(beforeRotate.rotatedAt).toBeNull();
  const rotatedResponse = await postForm(f, `/settings/connections/${id}/secret`,
    { ...form(html, `/settings/connections/${id}/secret`), secret: rotated });
  expect(rotatedResponse.status).toBe(303);
  expect(connections(f).find(item => item.id === id)!.rotatedAt).toBe(epoch);
  html = await (await get(f, "/settings/connections")).text();
  expect(html).not.toContain(secret);
  expect(html).not.toContain(rotated);
  // Test reports the stored value's verdict on the row.
  const tested = await postForm(f, `/settings/connections/${id}/test`, form(html, `/settings/connections/${id}/test`));
  expect(tested.status).toBe(303);
  expect(tested.headers.get("location")).toBe(`/settings/connections?tested=${id}&result=ok#connection-${id}`);
  html = await (await get(f, tested.headers.get("location")!)).text();
  expect(html).toContain(dictionaries.en["connection.last_test_ok"]);
  expect(html).not.toContain(secret);
  expect(html).not.toContain(rotated);
  // Remove needs the explicit checkbox; with it the row is gone.
  expect((await postForm(f, `/settings/connections/${id}/remove`, form(html, `/settings/connections/${id}/remove`))).status).toBe(400);
  const removed = await postForm(f, `/settings/connections/${id}/remove`,
    { ...form(html, `/settings/connections/${id}/remove`), confirm: "on" });
  expect(removed.status).toBe(303);
  expect(await (await get(f, "/settings/connections")).text()).not.toContain(`id="connection-${id}"`);
});

test("web.connections_settings/v1: forms need a session and a CSRF token", async () => {
  const f = await fixture();
  expect((await get(f, "/settings/connections", {}, false)).status).toBe(303);
  const unsigned = await f.web(new Request(`${origin}/settings/connections`,
    { method: "POST", body: new URLSearchParams({ kind: "github_token", label: "x", secret: "ghp_fixture_SECRET_123" }).toString(),
      headers: { "content-type": "application/x-www-form-urlencoded", origin } }));
  expect(unsigned.status).toBe(303);
  const forged = await postForm(f, "/settings/connections",
    { requestId: crypto.randomUUID(), expectedRevision: "0", kind: "github_token", label: "x", secret: "ghp_fixture_SECRET_123" }, null);
  expect(forged.status).toBe(403);
});

test("web.connections_settings/v1: no request, response, redirect or log line carries a secret", async () => {
  const f = await fixture();
  const secret = "ghp_fixture_SECRET_123", rotated = "ghp_fixture_ROTATED_456";
  const lines: string[] = [];
  const methods = ["log", "warn", "error", "info", "debug"] as const;
  const originals = new Map(methods.map(method => [method, console[method]]));
  for (const method of methods) console[method] = ((...args: unknown[]) => { lines.push(args.map(String).join(" ")); }) as never;
  try {
    const before = await (await get(f, "/settings/connections")).text();
    expect(before).not.toContain(secret);
    const created = await postForm(f, "/settings/connections",
      { ...form(before, "/settings/connections"), kind: "mcp_env", label: "MCP", secret });
    expect(created.headers.get("location")).not.toContain(secret);
    const id = created.headers.get("location")!.slice(created.headers.get("location")!.indexOf("#connection-") + "#connection-".length);
    const afterCreate = await (await get(f, "/settings/connections")).text();
    expect(afterCreate).not.toContain(secret);
    const rotatedResponse = await postForm(f, `/settings/connections/${id}/secret`,
      { ...form(afterCreate, `/settings/connections/${id}/secret`), secret: rotated });
    expect(rotatedResponse.headers.get("location")).not.toContain(rotated);
    const afterRotate = await (await get(f, "/settings/connections")).text();
    expect(afterRotate).not.toContain(secret);
    expect(afterRotate).not.toContain(rotated);
  } finally {
    for (const method of methods) console[method] = originals.get(method)!;
  }
  expect(lines.filter(line => line.includes(secret) || line.includes(rotated))).toEqual([]);
});
