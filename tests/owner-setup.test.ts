import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { TransactionStore } from "../src/store";
import { issueOwnerSetupLink, ownerSetupCsrf } from "../src/ops/owner-setup";
import { createWebHandler } from "../src/web";

const roots: string[] = [], stores: TransactionStore[] = [];
afterEach(() => { for (const store of stores.splice(0)) store.close(); for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(origin = "http://127.0.0.1:3000") {
  const root = mkdtempSync(join(tmpdir(), "jit-owner-setup-")); roots.push(root);
  const path = join(root, "app.sqlite"), store = new TransactionStore(path); stores.push(store);
  const clock = { now: 1000 }, config = readConfig({ JIT_DATABASE: path, JIT_ORIGIN: origin });
  const app = new Application(store, config, { now: () => clock.now }), web = createWebHandler(app);
  const issue = () => issueOwnerSetupLink(store, origin, clock.now)!;
  const token = (url: string) => new URL(url).searchParams.get("token")!;
  const request = (path: string, body?: Record<string, string>, headers: Record<string, string> = {}) => web(new Request(`${origin}${path}`, body ? {
    method: "POST", headers: { origin, "content-type": "application/x-www-form-urlencoded", ...headers }, body: new URLSearchParams(body),
  } : { headers }));
  return { root, path, store, app, web, issue, token, request, clock, origin };
}

test("installer stores only hash/expiry at 0600; rotating a link invalidates its predecessor", () => {
  const f = fixture(), first = f.issue(), token = f.token(first), record = readFileSync(`${f.path}.owner-setup.json`, "utf8");
  expect(record).not.toContain(token);
  expect(Object.keys(JSON.parse(record)).sort()).toEqual(["expiresAt", "hash"]);
  expect(statSync(`${f.path}.owner-setup.json`).mode & 0o777).toBe(0o600);
  f.app.checkOwnerSetup(token);
  const second = f.issue();
  expect(() => f.app.checkOwnerSetup(token)).toThrow("owner_setup_link_invalid");
  expect(() => f.app.checkOwnerSetup(f.token(second))).not.toThrow();
});

test("expiry is strict and persists after reopening; malformed/incorrect links fail closed", () => {
  const f = fixture(), token = f.token(f.issue());
  for (const invalid of [undefined, "", token.slice(1), "a".repeat(64), `${token}\n`]) expect(() => f.app.checkOwnerSetup(invalid)).toThrow("owner_setup_link_invalid");
  f.clock.now += 15 * 60 * 1000;
  expect(() => f.app.checkOwnerSetup(token)).toThrow("owner_setup_link_invalid");
  const reopened = new TransactionStore(f.path, { migrateExisting: false }); stores.push(reopened);
  expect(() => new Application(reopened, f.app.config, { now: () => f.clock.now }).checkOwnerSetup(token)).toThrow("owner_setup_link_invalid");
});

test("unsafe hash files and symlinks are never accepted", () => {
  const f = fixture(), token = f.token(f.issue()), path = `${f.path}.owner-setup.json`;
  chmodSync(path, 0o644);
  expect(() => f.app.checkOwnerSetup(token)).toThrow("owner_setup_link_invalid");
  rmSync(path); symlinkSync(join(f.root, "missing"), path);
  expect(() => f.app.checkOwnerSetup(token)).toThrow("owner_setup_link_invalid");
});

test("link GET only sets HttpOnly cookie and clears URL; clean page contains no token, does not consume", async () => {
  const f = fixture(), url = f.issue(), token = f.token(url);
  const opened = await f.web(new Request(url, { headers: { "accept-language": "en" } }));
  expect(opened.status).toBe(303);
  expect(opened.headers.get("location")).toBe("/owner/setup");
  expect(opened.headers.get("referrer-policy")).toBe("no-referrer");
  expect(opened.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Strict; Path=/; Max-Age=900");
  const cookie = opened.headers.get("set-cookie")!.split(";")[0]!;
  const page = await f.request("/owner/setup", undefined, { cookie, "accept-language": "en" });
  const html = await page.text();
  expect(page.status).toBe(200); expect(page.headers.get("cache-control")).toBe("no-store");
  expect(html).toContain("Create the Jit owner account"); expect(html).toContain('autocomplete="new-password"');
  expect(html).not.toContain(token); expect(html).toContain(ownerSetupCsrf(token));
  expect(f.store.read(tx => tx.get("SELECT * FROM owner"))).toBeNull();
  f.app.checkOwnerSetup(token);
});

test("password creation enforces Origin, CSRF, matching fields and existing password policy", async () => {
  const f = fixture(), token = f.token(f.issue()), cookie = `jit_setup=${token}`, password = crypto.randomUUID();
  const valid = { csrf: ownerSetupCsrf(token), password, confirm: password };
  expect((await f.request("/owner/setup", valid, { cookie, origin: "http://evil.invalid" })).status).toBe(403);
  expect((await f.request("/owner/setup", { ...valid, csrf: "" }, { cookie })).status).toBe(403);
  expect((await f.request("/owner/setup", { ...valid, confirm: "different" }, { cookie })).status).toBe(400);
  expect((await f.request("/owner/setup", { ...valid, password: "short", confirm: "short" }, { cookie })).status).toBe(400);
  expect(f.store.read(tx => tx.get("SELECT * FROM owner"))).toBeNull();
  f.app.checkOwnerSetup(token);
});

test("successful Web setup reuses Argon2 owner machinery, signs in and makes every replay unusable", async () => {
  const f = fixture(), token = f.token(f.issue()), password = crypto.randomUUID();
  const response = await f.request("/owner/setup", { csrf: ownerSetupCsrf(token), password, confirm: password }, { cookie: `jit_setup=${token}` });
  expect(response.status).toBe(303); expect(response.headers.get("location")).toBe("/setup");
  expect(response.headers.getSetCookie().some(cookie => cookie.startsWith("jit_setup=;") && cookie.includes("Max-Age=0"))).toBe(true);
  const sessionCookie = response.headers.getSetCookie().find(cookie => cookie.startsWith("jit_session="))!.split(";")[0]!;
  expect((await f.request("/setup", undefined, { cookie: sessionCookie })).status).toBe(200);
  const owner = f.store.read(tx => tx.get<{ password_hash: string }>("SELECT password_hash FROM owner"))!;
  expect(owner.password_hash).toStartWith("$argon2id$"); expect(owner.password_hash).not.toContain(password);
  expect(existsSync(`${f.path}.owner-setup.json`)).toBe(false);
  expect(issueOwnerSetupLink(f.store, f.origin, f.clock.now)).toBeNull();
  expect((await f.request(`/owner/setup?token=${token}`)).status).toBe(403);
  await expect(f.app.completeOwnerSetup(token, crypto.randomUUID())).rejects.toThrow("owner_setup_link_invalid");
});

test("concurrent setup submissions commit exactly one owner; setup token is never an owner session", async () => {
  const f = fixture(), token = f.token(f.issue());
  expect(() => f.app.authenticate(token)).toThrow("authentication_required");
  const results = await Promise.allSettled([f.app.completeOwnerSetup(token, crypto.randomUUID()), f.app.completeOwnerSetup(token, crypto.randomUUID())]);
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  expect(f.store.read(tx => tx.get<{ count: number }>("SELECT count(*) AS count FROM owner"))?.count).toBe(1);
});

test("a local owner configured while setup is open cannot be replaced by the capability", async () => {
  const f = fixture(), token = f.token(f.issue()), password = crypto.randomUUID();
  await f.app.setupOwner(password);
  await expect(f.app.completeOwnerSetup(token, crypto.randomUUID())).rejects.toThrow("owner_setup_link_invalid");
  expect(await f.app.login(password)).toBeString();
});

test("HTTPS bootstrap uses __Host cookies with Secure", async () => {
  const f = fixture("https://jit.example.test"), response = await f.web(new Request(f.issue()));
  expect(response.headers.get("set-cookie")).toStartWith("__Host-jit_setup=");
  expect(response.headers.get("set-cookie")).toContain("; Secure");
});
