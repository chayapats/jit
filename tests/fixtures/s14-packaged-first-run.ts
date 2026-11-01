import { mock } from "bun:test";
import { strict as assert } from "node:assert";
import { dirname, join } from "node:path";
import type { HostAuthFetch, HostClock, HostCredentialStore } from "schway/host";

// Use the packaged application and public device protocol with deterministic ports, never accounts or inference.
const src = dirname(process.argv[1]!);
const actual = await import(join(src, "s14/application.ts")) as typeof import("../../src/s14/application");
const bootstrap = await import(join(src, "ops/owner-setup.ts"));
const { S14Store } = await import(join(src, "s14/store.ts"));
const credentials = new Map<string, string>();
const credentialStore: HostCredentialStore = {
  get: async id => credentials.get(id.account) ?? null,
  set: async (id, value) => { credentials.set(id.account, value); },
  delete: async id => credentials.delete(id.account),
};
let now = Date.now(), approve = false, starts = 0, replies = 0;
const waits = new Set<{ at: number; done(): void }>();
const clock: HostClock = { now: () => now, sleep: (ms, signal) => new Promise((resolve, reject) => {
  const wait = { at: now + ms, done: () => { waits.delete(wait); signal?.removeEventListener("abort", abort); resolve(); } };
  const abort = () => { waits.delete(wait); reject(new Error("cancelled")); };
  waits.add(wait); signal?.addEventListener("abort", abort, { once: true });
}) };
const authFetch: HostAuthFetch = async input => {
  const url = String(input);
  if (/usercode|device\/code|device_authorization|device\/authorization/.test(url)) {
    starts++; return Response.json({ user_code: "FIXTURE-267", device_auth_id: "fixture-device", verification_uri: "https://auth.example.test/device", interval: 1, expires_in: 60 });
  }
  if (url.endsWith("/oauth/token")) return Response.json({ access_token: "fixture-access-267", refresh_token: "fixture-refresh-267", expires_in: 3600 });
  if (approve) return Response.json({ authorization_code: "fixture-authorization-267", code_verifier: "fixture-verifier-267" });
  return Response.json({ error: "authorization_pending" }, { status: 400 });
};
let app: InstanceType<typeof actual.S14Application>;
mock.module(join(src, "s14/application.ts"), () => ({ ...actual, S14Application: class extends actual.S14Application {
  constructor(store: ConstructorParameters<typeof actual.S14Application>[0], options: ConstructorParameters<typeof actual.S14Application>[1]) {
    super(store, { ...options, now: clock.now, signIn: { clock, store: credentialStore, fetch: authFetch }, chat: { async reply(input: { route: unknown }) {
      assert.deepEqual(input.route, { id: "codex", provider: "codex", model: "gpt-6.1-sol" }); replies++;
      return { text: "Scripted packaged first reply" };
    } } }); app = this;
  }
} }));
globalThis.fetch = (() => { throw new Error("live_fetch_forbidden"); }) as unknown as typeof fetch;
const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
const rid = () => crypto.randomUUID().replaceAll("-", "");
const origin = process.env.JIT_S14_ORIGIN!;
Bun.serve = ((options: { fetch(request: Request): Promise<Response> }) => {
  setTimeout(() => { void (async () => {
    assert.equal(process.env.JIT_S14_ROUTES, undefined);
    const path = process.env.JIT_S14_DATABASE!, store = new S14Store(path);
    const link = bootstrap.issueOwnerSetupLink(store, origin, now)!; store.close();
    const request = (path: string, fields?: Record<string, string>, cookie = "") => options.fetch(new Request(origin + path, {
      ...(fields ? { method: "POST", body: new URLSearchParams(fields) } : {}),
      headers: { cookie, ...(fields ? { origin, "content-type": "application/x-www-form-urlencoded" } : {}) },
    }));
    const capability = new URL(link).searchParams.get("token")!;
    const initial = await request(new URL(link).pathname + new URL(link).search);
    assert.equal(initial.status, 303);
    const setupCookie = initial.headers.get("set-cookie")!.split(";")[0]!;
    const clean = await request("/owner/setup", undefined, setupCookie);
    assert.equal(clean.status, 200); assert.equal((await clean.text()).includes(capability), false);
    const created = await request("/owner/setup", { csrf: bootstrap.ownerSetupCsrf(capability), password: "fixture-owner-password-267", confirm: "fixture-owner-password-267" }, setupCookie);
    assert.equal(created.status, 303);
    const cookie = created.headers.getSetCookie().find(value => value.startsWith("jit_s14="))!.split(";")[0]!;
    const auth = app.authenticate(cookie.slice("jit_s14=".length));
    // JSON command API has a JSON body and CSRF header; no-script forms keep their existing renderer.
    const command = async (value: unknown) => options.fetch(new Request(origin + "/api/s14/commands", { method: "POST", headers: { cookie, origin, "content-type": "application/json", "x-csrf-token": auth.csrf }, body: JSON.stringify(value) }));
    const signIn = { kind: "setup.sign_in", requestId: rid(), expectedRevision: 0, payload: { provider: "codex", flowId: null } };
    const once = await (await command(signIn)).json() as { approval?: unknown }; assert.ok(once.approval);
    const replay = await (await command(signIn)).json() as { approval?: unknown }; assert.equal(replay.approval, undefined); assert.equal(starts, 1);
    approve = true; now += 1000; for (const wait of [...waits]) if (wait.at <= now) wait.done(); await flush();
    assert.equal(app.signIns.status(auth.actor, "codex", signIn.requestId).state, "ready");
    const setup = { kind: "setup", requestId: rid(), expectedRevision: app.home(auth.actor).revision,
      payload: { ownerName: "Owner", language: "en", routeId: "codex", capabilities: { tools: [], resources: [] } } };
    const response = await command(setup); assert.equal(response.status, 200);
    const result = await response.json() as { conversation: { id: string } };
    const message = { kind: "message.post", requestId: rid(), expectedRevision: 1, payload: { conversationId: result.conversation.id, text: "Hello" } };
    assert.equal((await command(message)).status, 200);
    await app.drainReplies(); await flush();
    assert.equal(replies, 1);
    assert.equal(app.conversation(auth.actor, result.conversation.id).messages.at(-1)!.text, "Scripted packaged first reply");
    assert.equal((await command(message)).status, 200); assert.equal(replies, 1);
    assert.equal((await command({ ...message, requestId: rid(), expectedRevision: 0 })).status, 409);
    assert.equal(bootstrap.issueOwnerSetupLink(app.store, origin, now), null);
    console.log(JSON.stringify({ state: "packaged_first_reply", replies, signIns: starts }));
    process.emit("SIGTERM");
  })().catch(() => { console.error("packaged_first_run_failed"); process.exit(1); }); }, 0);
  return { stop() {} };
}) as unknown as typeof Bun.serve;
