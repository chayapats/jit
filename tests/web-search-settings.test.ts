import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { ConnectionVault } from "../src/exec/connections";
import { dictionaries } from "../src/i18n";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";
import { WebTools } from "../src/web-tools";
import { defaultWebProviders, testWebSearch } from "../src/web-tools/providers";
import { ManagedSearxng, type SearxngRuntime } from "../src/web-tools/searxng";
import { markSetupComplete } from "./fixtures/setup";

const password = "web03-owner-fixture-password", origin = "http://localhost:3000", rid = () => crypto.randomUUID();
const cleanup: (() => void)[] = [];
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); });
async function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-web03-"))), state = join(root, "state"), secrets = join(root, "secrets"); mkdirSync(state);
  const config = readConfig({ JIT_DATABASE: join(state, "app.sqlite") }), store = new TransactionStore(config.databasePath);
  const vault = new ConnectionVault(secrets, { forbidden: [state] });
  const queries: string[] = [], headers: string[] = []; let failing = false, missingPodman = false;
  const runtime: SearxngRuntime = { async status() { return missingPodman ? { state: "unavailable", reason: "podman" } : { state: "ready", reason: null }; }, async running() { return true; }, async start() {}, async stop() {}, async search(q) { queries.push(`searxng:${q}`); if (failing) throw Error("fixture"); return [{ title: "Fixture", url: "https://example.test", snippet: "scripted" }]; } };
  const builtin = new ManagedSearxng(runtime, { secret: () => "a".repeat(64), timers: { set() {}, clear() {} } });
  const providers = defaultWebProviders(async (url, options) => {
    queries.push(`${url.includes("tavily") ? "tavily" : "exa"}:${JSON.parse(options.body as string).query}`); headers.push(JSON.stringify(options.headers));
    if (failing) throw Error("fixture transport"); return Response.json({ results: [{ title: "Fixture", url: "https://example.test", content: "fixture", highlights: ["fixture"] }] });
  }, builtin);
  const tools = new WebTools(store, { providers, vault, searxng: builtin });
  let now = 1_800_000_000_000;
  const app = new Application(store, config, { now: () => now, connections: vault, web: tools });
  await app.setupOwner(password); markSetupComplete(store); const token = await app.login(password), auth = app.authenticate(token);
  app.execute(auth.actor, { kind: "ui.preferences.set", requestId: rid(), projectId: null, expectedRevision: 0, payload: { language: "en", theme: "system" } });
  const web = createWebHandler(app);
  cleanup.push(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const get = (path = "/settings/web-search", signedIn = true) => web(new Request(`${origin}${path}`, { headers: signedIn ? { cookie: `jit_session=${token}` } : {} }));
  const post = (body: Record<string, unknown>, path = "/settings/web-search", json = false, csrf = true, from = origin) => web(new Request(`${origin}${path}`, {
    method: "POST", headers: { "content-type": json ? "application/json" : "application/x-www-form-urlencoded", origin: from, cookie: `jit_session=${token}`, ...(csrf ? { "x-csrf-token": auth.csrf } : {}) },
    body: json ? JSON.stringify(body) : new URLSearchParams(body as Record<string, string>).toString(),
  }));
  const save = (provider: string, apiKey?: string, expectedRevision = app.webSearch(auth.actor).revision, requestId = rid(), json = false) => post({ requestId, expectedRevision, provider, ...(apiKey === undefined ? {} : { apiKey }) }, json ? "/api/settings/web-search" : "/settings/web-search", json);
  return { root, store, app, vault, tools, providers, auth, queries, headers, get, post, save, runtime, advance: (ms: number) => { now += ms; }, fail: () => { failing = true; }, missingPodman: () => { missingPodman = true; } };
}
test("WEB03 fresh page is Built-in, private query notice is explicit in both locales, missing Podman has a one-click repair path", async () => {
  const f = await fixture();
  expect(f.app.webSearch(f.auth.actor)).toMatchObject({ id: "searxng", connectionId: null, revision: 0, fallback: null });
  let html = await (await f.get()).text(); expect(html).toContain('value="searxng" checked'); expect(html).toContain(dictionaries.en["web_search.provider_searxng_note"]); expect(f.queries).toEqual([]);
  expect(html).toContain(dictionaries.en["podman.checking"]);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  f.missingPodman(); f.advance(30_000);
  html = await (await f.get()).text();
  expect(html).toContain(dictionaries.en["web_search.status_ready"]);
  for (let i = 0; i < 10; i++) await Promise.resolve();
  html = await (await f.get()).text(); expect(html).toContain(dictionaries.en["searxng.reason_podman"]); expect(html).toContain('value="tavily"');
  f.app.execute(f.auth.actor, { kind: "ui.preferences.set", requestId: rid(), projectId: null, expectedRevision: 1, payload: { language: "th", theme: "system" } });
  html = await (await f.get()).text(); expect(html).toContain(dictionaries.th["web_search.provider_searxng_note"]);
});
test("WEB03 key is stored once only in vault, search uses explicit provider, and receipt replay stays idempotent", async () => {
  const f = await fixture(), key = "tvly-web03-test-secret-123", requestId = rid();
  expect((await f.save("tavily", key, 0, requestId)).status).toBe(303);
  const c = f.app.connections(f.auth.actor)[0]!; expect(c).toMatchObject({ kind: "web_search_key", secret: "set", label: "Tavily" }); expect(f.vault.read(c.id)).toBe(key);
  expect((await f.save("tavily", key, 0, requestId)).status).toBe(303); expect(f.app.connections(f.auth.actor)).toHaveLength(1);
  const selected = f.providers.resolve(f.store, undefined, f.vault)!; await selected.search("public fixture", { limit: 1, signal: new AbortController().signal }); expect(f.queries).toEqual(["tavily:public fixture"]); expect(f.headers[0]).toContain(key);
  for (const path of ["/settings/web-search", "/api/settings/web-search", "/settings/connections"]) expect(await (await f.get(path)).text()).not.toContain(key);
  for (const table of ["web_provider", "connections", "command_receipts", "audit", "connection_audit"]) expect(JSON.stringify(f.store.read(tx => tx.all(`SELECT * FROM ${table}`)))).not.toContain(key);
  expect(readFileSync(f.store.path).includes(Buffer.from(key))).toBe(false); expect(readFileSync(`${f.store.path}-wal`).includes(Buffer.from(key))).toBe(false);
});
test("WEB03 missing/malformed keys render inline without changing selection; Built-in preserves stored connections", async () => {
  const f = await fixture(); let response = await f.save("exa"); expect(response.status).toBe(409); expect(await response.text()).toContain(dictionaries.en["error.web_search_key_missing"]);
  response = await f.save("exa", "short"); expect(response.status).toBe(400); expect(await response.text()).toContain(dictionaries.en["error.invalid_connection_secret"]); expect(f.app.connections(f.auth.actor)).toHaveLength(0);
  await f.save("tavily", "tvly-web03-keep-key"); await f.save("searxng", "ignored"); expect(f.app.webSearch(f.auth.actor)).toMatchObject({ id: "searxng", connectionId: null }); expect(f.app.connections(f.auth.actor)).toHaveLength(1);
  await f.save("tavily"); expect(f.app.webSearch(f.auth.actor).id).toBe("tavily");
});
test("WEB03 removal uses the existing connection route and visibly falls back, without selecting another vendor", async () => {
  const f = await fixture(); await f.save("tavily", "tvly-web03-remove-key"); const c = f.app.connections(f.auth.actor)[0]!;
  const response = await f.post({ requestId: rid(), expectedRevision: c.revision, confirm: "on", returnTo: "web-search" }, `/settings/connections/${c.id}/remove`);
  expect(response.headers.get("location")).toBe("/settings/web-search"); expect(f.app.webSearch(f.auth.actor)).toMatchObject({ id: "tavily", effectiveId: "searxng", fallback: "key_missing" });
  expect(await (await f.get()).text()).toContain(dictionaries.en["web_search.key_removed_fallback"]);
  let fallback = 0; const provider = f.providers.resolve(f.store, undefined, f.vault, () => { fallback++; })!;
  await provider.search("public fixture", { limit: 1, signal: new AbortController().signal }); expect(fallback).toBe(1); expect(f.queries).toEqual(["searxng:public fixture"]);
});
test("WEB03 missing key files fall back, unsafe ones refuse, and provider errors never change billing selection", async () => {
  const f = await fixture(); await f.save("exa", "exa-web03-stored-key"); const c = f.app.connections(f.auth.actor)[0]!;
  chmodSync(join(f.vault.directory, c.id), 0o644); expect(() => f.providers.resolve(f.store, undefined, f.vault)).toThrow("connection_vault_unsafe");
  chmodSync(join(f.vault.directory, c.id), 0o600); f.fail(); expect(await f.app.testWebSearch(f.auth.actor, 1)).toBe("failed"); expect(f.app.webSearch(f.auth.actor).effectiveId).toBe("exa");
  unlinkSync(join(f.vault.directory, c.id)); expect(f.app.webSearch(f.auth.actor).fallback).toBe("key_missing");
});
test("WEB03 replace key is a one-way existing vault route and redirects back to search settings", async () => {
  const f = await fixture(); await f.save("exa", "exa-web03-original-key"); const c = f.app.connections(f.auth.actor)[0]!;
  const response = await f.post({ requestId: rid(), expectedRevision: c.revision, secret: "exa-web03-replacement-key", returnTo: "web-search" }, `/settings/connections/${c.id}/secret`);
  expect(response.headers.get("location")).toBe("/settings/web-search"); expect(f.vault.read(c.id)).toBe("exa-web03-replacement-key"); expect(await (await f.get()).text()).not.toContain("exa-web03-replacement-key");
});
test("WEB03 exact body, auth, CSRF, Origin, query validation, stale revision and Web-only owner command", async () => {
  const f = await fixture(), body = { requestId: rid(), expectedRevision: 0, provider: "searxng" };
  expect((await f.post({ ...body, foo: "no" })).status).toBe(400); expect((await f.post(body, undefined, false, false)).status).toBe(403); expect((await f.post(body, undefined, false, true, "https://wrong.test")).status).toBe(403);
  expect((await f.get("/api/settings/web-search", false)).status).toBe(401); expect((await f.get("/settings/web-search?tested=wrong")).status).toBe(400); expect((await f.get("/settings/web-search?tested=ok&tested=failed")).status).toBe(400);
  await f.save("searxng"); expect((await f.save("searxng", undefined, 0, rid(), true)).status).toBe(409);
  f.app.execute(f.auth.actor, { kind: "local_api.set", requestId: rid(), projectId: null, expectedRevision: 0, payload: { enabled: true } }); const actor = f.app.issueLocalApiActor()!.actor;
  expect(() => f.app.execute(actor, { kind: "web.provider.set", requestId: rid(), projectId: null, expectedRevision: 1, payload: { id: "searxng", connectionId: null } })).toThrow("web_settings_requires_web");
});
test("WEB03 explicit tests use one bounded public query and script results through redirect; GET never searches", async () => {
  const f = await fixture(); await f.get(); expect(f.queries).toEqual([]);
  let r = await f.post({ requestId: rid(), expectedRevision: 0 }, "/settings/web-search/test"); expect(r.headers.get("location")).toBe("/settings/web-search?tested=ok"); expect(f.queries).toEqual(["searxng:jit connectivity check"]);
  expect(await (await f.get(r.headers.get("location")!)).text()).toContain(dictionaries.en["web_search.test_ok"]);
  f.fail(); r = await f.post({ requestId: rid(), expectedRevision: 0 }, "/settings/web-search/test"); expect(r.headers.get("location")).toBe("/settings/web-search?tested=failed"); expect(await (await f.get(r.headers.get("location")!)).text()).toContain(dictionaries.en["web_search.test_failed"]);
});
test("WEB03 JSON save never returns the key and migration 42 to 43 preserves existing connection kinds", async () => {
  const f = await fixture(), key = "exa-web03-json-secret"; const response = await f.save("exa", key, 0, rid(), true); expect(response.status).toBe(200); expect(await response.text()).not.toContain(key);
  f.app.execute(f.auth.actor, { kind: "connection.create", requestId: rid(), projectId: null, expectedRevision: 0, payload: { kind: "mcp_env", label: "MCP", projectScope: null } });
  f.app.execute(f.auth.actor, { kind: "connection.create", requestId: rid(), projectId: null, expectedRevision: 0, payload: { kind: "github_token", label: "GitHub", projectScope: null } });
  const copy = join(f.root, "schema42.sqlite"); const snapshot = new Database(f.store.path); snapshot.query("VACUUM INTO ?").run(copy); snapshot.close();
  const old = new Database(copy); old.exec("ALTER TABLE web_tool_calls DROP COLUMN fallback; PRAGMA user_version = 42;"); old.close();
  const migrated = new TransactionStore(copy); try { expect(migrated.read(tx => tx.all<{ kind: string }>("SELECT kind FROM connections ORDER BY kind")).map(x => x.kind)).toEqual(["github_token", "mcp_env", "web_search_key"]); expect(migrated.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version"))!.user_version).toBe(45); } finally { migrated.close(); }
});


test("WEB03 Test returns on its deadline even when a queued provider ignores cancellation", async () => {
  const controller = new AbortController(); let calls = 0;
  const tested = testWebSearch({ id: "fixture", async search(query, options) { calls++; expect(query).toBe("jit connectivity check"); expect(options.limit).toBe(1); return new Promise(() => {}); } }, controller.signal);
  controller.abort(); expect(await tested).toBe("failed"); expect(calls).toBe(1);
});


test("WEB03 a blocked readiness probe leaves settings and provider controls usable", async () => {
  const f = await fixture(); let calls = 0;
  let finish!: (status: Awaited<ReturnType<SearxngRuntime["status"]>>) => void;
  f.runtime.status = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  try {
    const response = await f.get(); expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain(dictionaries.en["podman.checking"]);
    expect(html).toContain('value="tavily"');
    expect((await f.get()).status).toBe(200); expect(calls).toBe(1);
  } finally { finish?.({ state: "ready", reason: null }); }
});
