import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application, type ApplicationOptions, type CreateProjectCommand, type OwnerActor } from "../src/application";
import { readConfig } from "../src/config";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";

const password = "fixture-owner-password";
const directories: string[] = [];
const stores: TransactionStore[] = [];
afterEach(() => { for (const s of stores.splice(0)) s.close(); for (const d of directories.splice(0)) rmSync(d, { recursive: true, force: true }); });

function directory(): string { const dir = mkdtempSync(join(tmpdir(), "jit-app01-")); directories.push(dir); return dir; }
async function fixture(options: ApplicationOptions = {}, env: Record<string, string> = {}) {
  const path = join(directory(), "app.sqlite");
  const config = readConfig({ JIT_DATABASE: path, ...env });
  const store = new TransactionStore(path); stores.push(store);
  const app = new Application(store, config, options);
  await app.setupOwner(password);
  const token = await app.login(password);
  return { path, config, store, app, token, auth: app.authenticate(token), web: createWebHandler(app) };
}
function command(requestId: string = crypto.randomUUID(), expectedRevision = 0, name = "โครงการ Jit"): CreateProjectCommand {
  return { kind: "project.create", requestId, projectId: null, expectedRevision, payload: { name } };
}
function webRequest(path: string, options: { method?: string; token?: string; body?: unknown; origin?: string; csrf?: string } = {}): Request {
  const headers: Record<string, string> = {};
  if (options.token) headers.cookie = `jit_session=${options.token}`;
  if (options.csrf) headers["x-csrf-token"] = options.csrf;
  if (options.body !== undefined) { headers["content-type"] = "application/json"; headers.origin = options.origin ?? "http://localhost:3000"; }
  return new Request(`http://localhost:3000${path}`, { method: options.method ?? "GET", headers,
    ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}) });
}
async function subprocess(input: { path: string; token: string; command: CreateProjectCommand; crash?: "project" | "receipt" }) {
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/command.ts")], {
    stdin: new Blob([JSON.stringify(input)]), stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect(stderr).toBe("");
  return { stdout, exitCode };
}

test("fresh local setup, browser login, create, reload, logout and reopen retain one project group", async () => {
  const f = await fixture();
  const login = await f.web(webRequest("/login", { method: "POST", body: { password } }));
  expect(login.status).toBe(303);
  const cookie = login.headers.get("set-cookie")!;
  expect(cookie).toContain("HttpOnly; SameSite=Strict; Path=/; Max-Age=28800");
  expect(await login.text()).not.toContain(password);
  const html = await (await f.web(webRequest("/", { token: f.token }))).text();
  expect(html).toContain("โครงการของคุณ");
  expect(html).not.toContain(f.token);
  const body = { name: "ระบบ <script>alert(1)</script>", requestId: "web-create-01", expectedRevision: 0 };
  const response = await f.web(webRequest("/api/projects", { method: "POST", token: f.token, csrf: f.auth.csrf, body }));
  expect(response.status).toBe(200);
  const receipt = await response.json();
  expect(receipt.project.groupId).toBeString();
  const group = await f.web(webRequest(`/projects/${receipt.project.id}`, { token: f.token }));
  const rendered = await group.text();
  expect(rendered).toContain("&lt;script&gt;");
  expect(rendered).not.toContain("<script>");
  expect(rendered.match(/data-group-id=/g)).toHaveLength(1);
  expect(group.headers.get("content-security-policy")).toContain("default-src 'none'");
  expect(group.headers.get("cache-control")).toBe("no-store");
  // no-referrer makes navigation-form Origin opaque in Chromium, rejecting legitimate owner forms.
  expect(group.headers.get("referrer-policy")).toBe("same-origin");
  f.store.close();
  const store = new TransactionStore(f.path); stores.push(store);
  const reopened = new Application(store, f.config);
  const actor = reopened.authenticate(f.token).actor;
  expect(reopened.project(actor, receipt.project.id)).toEqual(receipt.project);
  expect(reopened.execute(actor, command(body.requestId, 0, body.name))).toEqual(receipt);
  expect(reopened.workspace(actor).projects).toHaveLength(1);
  reopened.logout(actor);
  expect(() => reopened.workspace(actor)).toThrow("authentication_required");
  expect(() => reopened.authenticate(f.token)).toThrow("authentication_required");
});

test("owner setup is local-only; copied identities, anonymous and cross-origin mutations fail", async () => {
  const f = await fixture();
  await expect(f.app.setupOwner(password)).rejects.toThrow("owner_already_configured");
  expect(() => f.app.execute({ ownerId: "owner", channel: "web" } as OwnerActor, command())).toThrow("authentication_required");
  expect(() => f.app.execute({ ...f.auth.actor }, command())).toThrow("authentication_required");
  const body = { name: "unauthorized", requestId: "no-auth-01", expectedRevision: 0 };
  expect((await f.web(webRequest("/api/projects", { method: "POST", body }))).status).toBe(401);
  expect((await f.web(webRequest("/api/projects", { method: "POST", body, token: f.token, csrf: f.auth.csrf, origin: "https://evil.example" }))).status).toBe(403);
  expect((await f.web(webRequest("/api/projects", { method: "POST", body, token: f.token }))).status).toBe(403);
  expect((await f.web(webRequest("/api/projects", { method: "POST", body: { ...body, actor: "owner" }, token: f.token, csrf: f.auth.csrf }))).status).toBe(400);
  expect((await f.web(new Request("http://evil.example/login"))).status).toBe(403);
  expect((await f.web(webRequest("/setup", { method: "POST", body: { password } }))).status).toBe(303);
  expect(f.app.workspace(f.auth.actor).projects).toEqual([]);
});

test("duplicate receipts survive restart; changed payload and stale revision cannot overwrite", async () => {
  const f = await fixture();
  const c = command();
  const result = f.app.execute(f.auth.actor, c);
  expect(f.app.execute(f.auth.actor, c)).toEqual(result);
  expect(() => f.app.execute(f.auth.actor, { ...c, payload: { name: "different" } })).toThrow("request_id_conflict");
  expect(() => f.app.execute(f.auth.actor, command())).toThrow("stale_revision");
  const next = f.app.execute(f.auth.actor, command(crypto.randomUUID(), 1));
  expect(next.project.id).not.toBe(result.project.id);
  expect(next.project.groupId).not.toBe(result.project.groupId);
  expect(f.app.workspace(f.auth.actor).projects.map(p => p.name)).toEqual(["โครงการ Jit", "โครงการ Jit"]);
});

test("independent concurrent writers deduplicate one request and reject a competing stale command", async () => {
  const f = await fixture();
  const c = command();
  const duplicate = await Promise.all([subprocess({ path: f.path, token: f.token, command: c }), subprocess({ path: f.path, token: f.token, command: c })]);
  expect(duplicate.every(r => r.exitCode === 0)).toBe(true);
  expect(JSON.parse(duplicate[0]!.stdout)).toEqual(JSON.parse(duplicate[1]!.stdout));
  const competing = await Promise.all([subprocess({ path: f.path, token: f.token, command: command(crypto.randomUUID(), 1) }), subprocess({ path: f.path, token: f.token, command: command(crypto.randomUUID(), 1) })]);
  const results = competing.map(r => JSON.parse(r.stdout));
  expect(results.filter(r => r.error === "stale_revision")).toHaveLength(1);
  expect(f.app.workspace(f.auth.actor).projects).toHaveLength(2);
});

for (const crash of ["project", "receipt"] as const) {
  test(`SIGKILL after ${crash} writes leaves no half-accepted state or receipt`, async () => {
    const f = await fixture();
    const c = command();
    const result = await subprocess({ path: f.path, token: f.token, command: c, crash });
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).toBe("");
    f.store.close();
    const store = new TransactionStore(f.path); stores.push(store);
    const reopened = new Application(store, f.config);
    const actor = reopened.authenticate(f.token).actor;
    expect(reopened.workspace(actor)).toMatchObject({ revision: 0, projects: [] });
    expect(store.read(tx => tx.get<{ count: number }>("SELECT count(*) AS count FROM command_receipts")!.count)).toBe(0);
    expect(reopened.execute(actor, c).workspaceRevision).toBe(1);
  });
}

test("SQLite COMMIT failure never acknowledges success or retains state, receipt or audit", async () => {
  let store!: TransactionStore;
  const f = await fixture({ beforeCommit: stage => {
    if (stage === "receipt") store.read(tx => {
      tx.run("PRAGMA defer_foreign_keys = ON");
      tx.run("INSERT INTO project_groups VALUES ('invalid-group', 'nonexistent-project')");
    });
  } });
  store = f.store;
  const response = await f.web(webRequest("/api/projects", { method: "POST", token: f.token, csrf: f.auth.csrf,
    body: { requestId: "commit-fail-01", expectedRevision: 0, name: "do not acknowledge" } }));
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "storage_unavailable" });
  expect(f.app.workspace(f.auth.actor)).toMatchObject({ revision: 0, projects: [] });
  for (const table of ["projects", "project_groups", "command_receipts", "audit"]) {
    expect(store.read(tx => tx.get<{ count: number }>(`SELECT count(*) AS count FROM ${table}`)!.count)).toBe(0);
  }
});

test("persisted login budget, expiry and trusted reset fence existing sessions", async () => {
  let now = 1_000_000;
  const f = await fixture({ now: () => now }, { JIT_LOGIN_ATTEMPTS: "3", JIT_LOGIN_WINDOW_SECONDS: "5", JIT_SESSION_SECONDS: "10" });
  await expect(f.app.login("wrong")).rejects.toThrow("login_failed");
  await expect(f.app.login("wrong")).rejects.toThrow("login_failed");
  f.store.close();
  const store = new TransactionStore(f.path); stores.push(store);
  const reopened = new Application(store, f.config, { now: () => now });
  await expect(reopened.login(password)).rejects.toThrow("login_limited_try_later");
  now += 5001;
  const token = await reopened.login(password);
  const actor = reopened.authenticate(token).actor;
  now += 10001;
  expect(() => reopened.workspace(actor)).toThrow("authentication_required");
  const another = await reopened.login(password);
  const beforeReset = reopened.authenticate(another).actor;
  await reopened.setupOwner("fixture-reset-password", true);
  expect(() => reopened.workspace(beforeReset)).toThrow("authentication_required");
  await expect(reopened.login(password)).rejects.toThrow("login_failed");
  expect(await reopened.login("fixture-reset-password")).toBeString();
});

test("versioned migration snapshots existing v0 state and rejects future schema without writes", async () => {
  const dir = directory(), path = join(dir, "old.sqlite");
  const old = new Database(path);
  old.exec("CREATE TABLE fixture_marker (value TEXT); INSERT INTO fixture_marker VALUES ('pre-migration'); PRAGMA user_version = 0;"); old.close();
  const store = new TransactionStore(path); stores.push(store);
  expect(store.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version)).toBe(1);
  const snapshots = readdirSync(dir).filter(p => p.includes(".pre-v0-"));
  expect(snapshots).toHaveLength(1);
  const snapshot = new Database(join(dir, snapshots[0]!), { readonly: true });
  expect(snapshot.query("PRAGMA user_version").get()).toEqual({ user_version: 0 });
  expect(snapshot.query("SELECT * FROM fixture_marker").get()).toEqual({ value: "pre-migration" }); snapshot.close();
  expect(statSync(join(dir, snapshots[0]!)).mode & 0o777).toBe(0o600);
  const futurePath = join(dir, "future.sqlite");
  const future = new Database(futurePath); future.exec("PRAGMA user_version = 99; CREATE TABLE future_state (secret TEXT);"); future.close();
  const before = await Bun.file(futurePath).bytes();
  expect(() => new TransactionStore(futurePath)).toThrow("newer");
  expect(await Bun.file(futurePath).bytes()).toEqual(before);
});

test("finite ingress and query limits, pagination, secure cookies and config validation", async () => {
  const f = await fixture({}, { JIT_BODY_BYTES: "128", JIT_QUERY_BYTES: "128", JIT_PAGE_SIZE: "1" });
  expect((await f.web(webRequest("/login", { method: "POST", body: { password: "x".repeat(200) } }))).status).toBe(413);
  expect((await f.web(webRequest(`/?q=${"x".repeat(200)}`, { token: f.token }))).status).toBe(414);
  const first = f.app.execute(f.auth.actor, command());
  f.app.execute(f.auth.actor, command(crypto.randomUUID(), 1, "next"));
  expect(f.app.workspace(f.auth.actor)).toMatchObject({ hasMore: true });
  expect(f.app.workspace(f.auth.actor, 1).projects).toHaveLength(1);
  expect(f.app.project(f.auth.actor, first.project.id).groupId).toBe(first.project.groupId);
  expect(() => f.app.project(f.auth.actor, "โครงการ Jit")).toThrow("project_not_found");
  expect(() => readConfig({ JIT_BODY_BYTES: "Infinity" })).toThrow();
  expect(() => readConfig({ JIT_PAGE_SIZE: "0" })).toThrow();
  expect(() => readConfig({ JIT_ORIGIN: "http://private.example" })).toThrow("HTTPS");
  const secure = createWebHandler(new Application(f.store, { ...f.config, origin: "https://jit.example", bodyBytes: 1024 }));
  const response = await secure(new Request("https://jit.example/login", { method: "POST", headers: { origin: "https://jit.example", "content-type": "application/json" }, body: JSON.stringify({ password }) }));
  expect(response.headers.get("set-cookie")).toContain("__Host-jit_session=");
  expect(response.headers.get("set-cookie")).toContain("; Secure");
});
