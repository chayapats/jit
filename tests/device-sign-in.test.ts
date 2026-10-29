import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostAuthFetch, HostClock, HostCredentialStore } from "schway/host";
import { Application } from "../src/application";
import { readConfig } from "../src/config";
import { TransactionStore } from "../src/store";
import { createWebHandler } from "../src/web";
import { setupCheckMarker, setupCheckWork } from "../src/setup";
import { JobQueue } from "../src/jobs/queue";
import { ScriptedRunPort, fixtureOutcome } from "../src/team/scripted-port";
import type { ApplicationRunRequest } from "../src/team/types";
import { DeviceSignIns, type SignInCommand, type SignInReceipt } from "../src/device-sign-in";
import { dictionaries, withLocale } from "../src/i18n";
import { signInPage } from "../src/web-sign-in";

const origin = "http://localhost:3000", code = "ONCE-ONLY-CODE-175", tokenSecret = "TOKEN-SECRET-175", link = "https://auth.example.test/device-175";
const roots: string[] = [], apps: Application[] = [], stores: TransactionStore[] = [], queues: JobQueue[] = [];
afterEach(async () => {
  for (const app of apps.splice(0)) await app.closeDeviceSignIns();
  for (const queue of queues.splice(0)) { queue.close(); await queue.idle(); }
  for (const store of stores.splice(0)) store.close();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
async function flush() { for (let i = 0; i < 100; i++) await Promise.resolve(); }
class Clock implements HostClock {
  time = 1_900_000_000_000;
  waits = new Set<{ at: number; resolve(): void; reject(): void }>();
  now = () => this.time;
  sleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("aborted")); return; }
    const finish = (aborted: boolean) => { this.waits.delete(wait); signal?.removeEventListener("abort", abort); aborted ? reject(new Error("aborted")) : resolve(); };
    const wait = { at: this.time + ms, resolve: () => finish(false), reject: () => finish(true) }, abort = wait.reject;
    this.waits.add(wait); signal?.addEventListener("abort", abort, { once: true });
  });
  async advance(ms: number) { this.time += ms; for (const wait of [...this.waits]) if (wait.at <= this.time) wait.resolve(); await flush(); }
}
interface Protocol { result: "pending" | "success" | "denied" | "expired" | "error"; starts: number; requests: string[] }
async function fixture(options: { failStore?: boolean; uncertain?: boolean; failRead?: boolean; path?: string; clock?: Clock; writeGate?: Promise<void>; expiresIn?: number; hungRead?: boolean; hungStart?: boolean; quota?: boolean } = {}) {
  const root = options.path ? join(options.path, "..") : mkdtempSync(join(tmpdir(), "jit-sign01-"));
  if (!options.path) roots.push(root);
  const path = options.path ?? join(root, "state.sqlite"), clock = options.clock ?? new Clock();
  const config = readConfig({ JIT_DATABASE: path }), store = new TransactionStore(path); stores.push(store);
  const values = new Map<string, string>();
  const credentialStore: HostCredentialStore = {
    get: async identity => { if (options.hungRead) await new Promise(() => {}); if (options.failRead) throw new Error(tokenSecret); return values.get(identity.account) ?? null; },
    set: async (identity, value) => { await options.writeGate; values.set(identity.account, value); if (options.failStore) throw new Error(tokenSecret); },
    delete: async identity => { if (options.uncertain) throw new Error(tokenSecret); return values.delete(identity.account); },
  };
  const protocol: Protocol = { result: "pending", starts: 0, requests: [] };
  let startAborted = false;
  const authFetch: HostAuthFetch = async (input, init) => {
    const url = String(input); protocol.requests.push(url);
    if (/usercode|device\/code|device_authorization|device\/authorization/.test(url)) {
      protocol.starts++;
      if (options.hungStart) await new Promise<never>((_, reject) => {
        const abort = () => { startAborted = true; reject(new Error("aborted")); };
        init!.signal!.addEventListener("abort", abort, { once: true });
        if (init!.signal!.aborted) abort();
      });
      return Response.json({ user_code: code, device_auth_id: "private-device-id", device_code: "private-device-id", verification_uri: link, interval: 1, expires_in: options.expiresIn ?? 60 });
    }
    if (url.endsWith("/oauth/token")) return Response.json({ access_token: tokenSecret, refresh_token: "REFRESH-SECRET-175", expires_in: 3600 });
    if (protocol.result === "success") {
      if (url.includes("x.ai")) return Response.json({ access_token: tokenSecret, refresh_token: "REFRESH-SECRET-175", expires_in: 3600 });
      return Response.json({ status: "success", authorization_code: "private-auth-code", code_verifier: "private-verifier" });
    }
    const error = protocol.result === "pending" ? "authorization_pending" : protocol.result === "denied" ? "access_denied" : protocol.result === "expired" ? "expired_token" : "invalid_request";
    return Response.json({ error, description: tokenSecret }, { status: 400 });
  };
  const requests: ApplicationRunRequest[] = [];
  const port = new ScriptedRunPort(store, config.team, config.jobs.outputBytes, request => { requests.push(request); return fixtureOutcome(options.quota ? "quota" : "complete", "OK"); });
  const queue = new JobQueue(store, config.jobs, [setupCheckWork(store, config, port, clock.now)], { now: clock.now }); queues.push(queue);
  const app = new Application(store, config, { now: clock.now, jobs: queue, signIn: { store: credentialStore, fetch: authFetch, clock } }); apps.push(app);
  if (!options.path) await app.setupOwner("Fixture password 175!");
  const session = await app.login("Fixture password 175!"), auth = app.authenticate(session), web = createWebHandler(app);
  const get = (url: string) => web(new Request(`${origin}${url}`, { headers: { cookie: `jit_session=${session}` } }));
  const post = (url: string, fields: Record<string, string>, headers: Record<string, string> = {}) => web(new Request(`${origin}${url}`, {
    method: "POST", body: new URLSearchParams(fields), headers: { cookie: `jit_session=${session}`, origin, "content-type": "application/x-www-form-urlencoded", ...headers },
  }));
  const command = (provider: "codex" | "grok" = "codex", surface: "setup" | "settings" = "setup", flowId: string | null = null): SignInCommand => ({
    kind: flowId ? "setup.sign_in.cancel" : "setup.sign_in", requestId: crypto.randomUUID(), projectId: null,
    expectedRevision: surface === "setup" ? app.setup(auth.actor).revision : app.team(auth.actor).ownerRevision, payload: { provider, surface, flowId },
  });
  const wake = () => app.execute(auth.actor, { kind: "setup.wake", requestId: crypto.randomUUID(), projectId: null, expectedRevision: app.setup(auth.actor).revision, payload: { language: "en" } });
  return { root, path, store, app, auth, clock, protocol, queue, requests, values, get, post, command, wake, startAborted: () => startAborted };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const status = (f: Fixture, receipt: SignInReceipt, provider: "codex" | "grok" = "codex") => f.app.signInStatus(f.auth.actor, provider, receipt.signIn.id);
const metadata = (f: Fixture) => f.store.read(tx => JSON.stringify(tx.all("SELECT * FROM command_receipts")));

test("Codex success displays approval once, checks the exact selected route and retains no secrets", async () => {
  const f = await fixture(); f.wake();
  const command = f.command(), receipt = await f.app.execute(f.auth.actor, command);
  expect(receipt.approval).toEqual({ userCode: code, verificationUri: link });
  expect(f.protocol.starts).toBe(1);
  expect(f.requests).toHaveLength(0);
  expect(f.app.setup(f.auth.actor).connection.route).toEqual({ provider: "codex", model: "gpt-6-astra", authRoute: "codex" });
  const replay = await f.app.execute(f.auth.actor, command);
  expect(replay.approval).toBeUndefined(); expect(f.protocol.starts).toBe(1);
  f.protocol.result = "success"; await f.clock.advance(1000);
  expect(status(f, receipt).state).toBe("ready");
  f.queue.pump(); await f.queue.idle();
  expect(f.requests).toHaveLength(1); expect(f.requests[0]!.route.provider).toBe("codex");
  expect(f.requests[0]!.instructions.operator).toContain(setupCheckMarker);
  expect(f.app.setup(f.auth.actor).connection.status).toBe("unverified");
  expect(f.values.size).toBe(1);
  expect(await f.app.providerReadiness(f.auth.actor)).toMatchObject({ codex: "configured-unverified", grok: "needs-login" });
  const all = metadata(f) + JSON.stringify(f.requests) + JSON.stringify(status(f, receipt));
  for (const secret of [code, link, tokenSecret, "private-device-id", "private-auth-code", "private-verifier", "REFRESH-SECRET-175"]) expect(all).not.toContain(secret);
  expect(readFileSync(f.path).includes(Buffer.from(code))).toBe(false);
  expect(readFileSync(`${f.path}-wal`).includes(Buffer.from(code))).toBe(false);
});

for (const result of ["denied", "expired", "error"] as const) test(`device ${result} is explicit, retryable and never inferred ready`, async () => {
  const f = await fixture(); f.wake(); const receipt = await f.app.execute(f.auth.actor, f.command());
  f.protocol.result = result; await f.clock.advance(1000);
  expect(status(f, receipt).state).toBe(result === "error" ? "provider-error" : result);
  expect(f.requests).toHaveLength(0); expect(f.values.size).toBe(0);
  expect((await f.app.execute(f.auth.actor, f.command())).approval?.userCode).toBe(code);
});

test("deadline expiry is bounded by a fake clock, and cancel stops writes and permits retry", async () => {
  const f = await fixture(); f.wake(); const receipt = await f.app.execute(f.auth.actor, f.command());
  await f.clock.advance(60_001); expect(status(f, receipt).state).toBe("expired");
  const next = await f.app.execute(f.auth.actor, f.command());
  const cancel = f.command("codex", "setup", next.signIn.id);
  expect((await f.app.execute(f.auth.actor, cancel)).signIn.state).toBe("cancelled");
  f.protocol.result = "success"; await f.clock.advance(1000);
  expect(f.values.size).toBe(0); expect(status(f, next).state).toBe("cancelled");
  expect((await f.app.execute(f.auth.actor, cancel)).approval).toBeUndefined();
  expect((await f.app.execute(f.auth.actor, f.command())).approval?.userCode).toBe(code);
});

test("same-route starts are busy, other provider is independent and stale cancel cannot cancel a replacement", async () => {
  const f = await fixture(); f.wake(); const first = await f.app.execute(f.auth.actor, f.command());
  const before = f.app.setup(f.auth.actor).revision;
  expect((await f.app.execute(f.auth.actor, f.command())).signIn.state).toBe("busy");
  expect(f.app.setup(f.auth.actor).revision).toBe(before); expect(f.protocol.starts).toBe(1);
  const grok = await f.app.execute(f.auth.actor, f.command("grok", "settings")); expect(grok.approval?.userCode).toBe(code);
  await f.app.execute(f.auth.actor, f.command("codex", "setup", first.signIn.id)); await flush();
  const replacement = await f.app.execute(f.auth.actor, f.command());
  await f.app.execute(f.auth.actor, f.command("codex", "setup", first.signIn.id));
  expect(status(f, replacement).state).toBe("pending");
});

for (const uncertain of [false, true]) test(`store failure is blocked with cleanup uncertainty ${uncertain}`, async () => {
  const f = await fixture({ failStore: true, uncertain }); f.wake(); const receipt = await f.app.execute(f.auth.actor, f.command());
  f.protocol.result = "success"; await f.clock.advance(1000);
  expect(status(f, receipt).state).toBe(uncertain ? "cleanup-required" : "store-error"); expect(f.requests).toHaveLength(0);
  const html = withLocale("en", () => signInPage({ signIn: status(f, receipt) }, "codex", "setup", f.auth.csrf, f.app.setup(f.auth.actor).revision));
  expect(html).toContain(dictionaries.en[uncertain ? "signin.recover_store" : "signin.unlock_store"]);
  expect(metadata(f)).not.toContain(tokenSecret); if (!uncertain) expect(f.values.size).toBe(0);
});

test("readable leftover credentials stay blocked across retries until a guarded commit recovers the store", async () => {
  const options = { failStore: true, uncertain: true };
  const f = await fixture(options); f.wake();
  const failed = await f.app.execute(f.auth.actor, f.command());
  f.protocol.result = "success"; await f.clock.advance(1000);
  expect(status(f, failed).state).toBe("cleanup-required"); expect(f.values.size).toBe(1);
  expect(await f.app.providerReadiness(f.auth.actor)).toEqual({ codex: "cleanup-required", grok: "needs-login" });
  for (const path of ["/setup?step=connect", "/settings/team"]) {
    const html = await (await f.get(path)).text();
    expect(html).toContain(dictionaries.en["signin.readiness.blocked"]);
    expect(html).toContain(dictionaries.en["signin.recover_store"]);
    expect(html).not.toContain(`>${dictionaries.en["signin.readiness.ready"]}<`);
  }
  f.protocol.result = "pending";
  const cancelled = await f.app.execute(f.auth.actor, f.command());
  await f.app.execute(f.auth.actor, f.command("codex", "setup", cancelled.signIn.id)); await flush();
  expect((await f.app.providerReadiness(f.auth.actor)).codex).toBe("cleanup-required");
  options.failStore = false; options.uncertain = false;
  const recovered = await f.app.execute(f.auth.actor, f.command());
  expect((await f.app.providerReadiness(f.auth.actor)).codex).toBe("cleanup-required");
  f.protocol.result = "success"; await f.clock.advance(1000);
  expect(status(f, recovered).state).toBe("ready");
  expect((await f.app.providerReadiness(f.auth.actor)).codex).toBe("configured-unverified");
});

test("shutdown aborts a hung provider start and awaits its terminal receipt before returning", async () => {
  const f = await fixture({ hungStart: true }); f.wake();
  const command = f.command();
  const started = f.app.execute(f.auth.actor, command);
  await flush(); expect(f.protocol.starts).toBe(1);
  await f.app.closeDeviceSignIns();
  expect(f.startAborted()).toBe(true);
  expect(f.store.read(tx => tx.get<{ result_json: string }>("SELECT result_json FROM command_receipts WHERE request_id = ?", command.requestId))!.result_json).toContain('"state":"cancelled"');
  expect((await started).signIn.state).toBe("cancelled");
  expect(f.values.size).toBe(0); expect(f.requests).toHaveLength(0); expect(f.clock.waits.size).toBe(0);
});

test("shutdown also settles the starting flow during its local store preflight", async () => {
  const clock = new Clock();
  const signIns = new DeviceSignIns({ clock, store: { get: () => new Promise(() => {}), set: async () => {}, delete: async () => false } });
  const started = signIns.start("codex", crypto.randomUUID(), () => {}, () => {}, () => {});
  await signIns.close();
  expect((await started).signIn.state).toBe("cancelled"); expect(signIns.busy("codex")).toBe(false); expect(clock.waits.size).toBe(0);
});

test("shutdown bounds waiting for an uncooperative store write while retaining its late-write fence", async () => {
  let release!: () => void;
  const writeGate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ writeGate }); f.wake();
  const receipt = await f.app.execute(f.auth.actor, f.command());
  f.protocol.result = "success"; await f.clock.advance(1000);
  let closed = false;
  const closing = f.app.closeDeviceSignIns().then(() => { closed = true; });
  await flush(); expect(closed).toBe(false);
  await f.clock.advance(29_999); expect(closed).toBe(false);
  await f.clock.advance(1); await closing;
  expect(closed).toBe(true);
  release(); await flush();
  expect(status(f, receipt).state).toBe("cancelled"); expect(f.values.size).toBe(0); expect(f.requests).toHaveLength(0);
});

test("restart cancels a pending flow, replay cannot restore a code and retry starts a fresh flow", async () => {
  const f = await fixture(); f.wake(); const command = f.command(), receipt = await f.app.execute(f.auth.actor, command);
  await f.app.closeDeviceSignIns(); f.queue.close(); await f.queue.idle(); queues.splice(queues.indexOf(f.queue), 1); f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const next = await fixture({ path: f.path, clock: f.clock });
  expect(status(next, receipt).state).toBe("cancelled");
  expect((await next.app.execute(next.auth.actor, command)).approval).toBeUndefined(); expect(next.protocol.starts).toBe(0);
  expect((await next.app.execute(next.auth.actor, next.command())).signIn.id).not.toBe(receipt.signIn.id);
});

test("revoking the owner session fences credential commits", async () => {
  const f = await fixture(); f.wake(); await f.app.execute(f.auth.actor, f.command()); f.app.logout(f.auth.actor);
  f.protocol.result = "success"; await f.clock.advance(1000); expect(f.values.size).toBe(0); expect(f.requests).toHaveLength(0);
});

test("settings sign-in does not change billing/route and a changed route prevents the automatic check", async () => {
  const f = await fixture(); f.wake(); const receipt = await f.app.execute(f.auth.actor, f.command());
  const team = f.app.team(f.auth.actor);
  f.app.execute(f.auth.actor, { kind: "route.save", requestId: crypto.randomUUID(), projectId: null, expectedRevision: team.ownerRevision, payload: { roleId: null, route: { provider: "grok", model: "custom", authRoute: "legacy" } } });
  f.protocol.result = "success"; await f.clock.advance(1000); expect(status(f, receipt).state).toBe("ready"); expect(f.requests).toHaveLength(0);
  const before = f.app.team(f.auth.actor).ownerDefault;
  const grok = await f.app.execute(f.auth.actor, f.command("grok", "settings")); await f.clock.advance(1000);
  expect(status(f, grok, "grok").state).toBe("ready");
  expect(f.app.team(f.auth.actor).ownerDefault).toEqual(before);
});

test("no-JS Web sign-in, status, replay and cancel use session, Origin, CSRF and exact owner commands", async () => {
  const f = await fixture(); f.wake();
  const html = await (await f.get("/setup?step=connect")).text();
  expect(html).toContain('form="sign-in-codex"'); expect(html).toContain(dictionaries.en["signin.readiness.needed"]);
  const fields = { csrf: f.auth.csrf, requestId: crypto.randomUUID(), expectedRevision: String(f.app.setup(f.auth.actor).revision), provider: "codex", surface: "setup" };
  expect((await f.post("/setup/sign-in", { ...fields, csrf: "bad" })).status).toBe(403);
  expect((await f.post("/setup/sign-in", fields, { origin: "https://evil.test" })).status).toBe(403);
  expect((await f.post("/setup/sign-in", { ...fields, surprise: "value" })).status).toBe(400);
  const response = await f.post("/setup/sign-in", fields), page = await response.text();
  expect(response.status).toBe(200); expect(response.headers.get("referrer-policy")).toBe("no-referrer"); expect(response.headers.get("cache-control")).toContain("no-store");
  expect(page).toContain(code); expect(page).toContain(link); expect(page).toContain("data-status-url");
  const path = /data-status-page="([^"]+)"/.exec(page)![1]!.replaceAll("&amp;", "&");
  expect(await (await f.get(path)).text()).not.toContain(code);
  expect(await (await f.get(`/api${path}`)).text()).not.toContain(link);
  expect(await (await f.post("/setup/sign-in", fields)).text()).not.toContain(code);
  const id = /\/codex\/([a-f0-9-]{36})/.exec(path)![1]!;
  expect((await f.post(`/setup/sign-in/codex/${id}/cancel`, { csrf: f.auth.csrf, requestId: crypto.randomUUID(), expectedRevision: String(f.app.setup(f.auth.actor).revision), surface: "setup" })).status).toBe(303);
  expect(await (await f.get(path)).text()).toContain(dictionaries.en["signin.state.cancelled"]);
  expect(await (await f.get("/settings/team")).text()).toContain('name="surface" value="settings"');
  const actor = { channel: "web", ownerId: "owner" } as Parameters<Application["setup"]>[0];
  await expect(f.app.execute(actor, f.command())).rejects.toThrow("authentication_required");
});

test("locked store is blocked before contacting the provider and readiness reads never infer", async () => {
  const f = await fixture({ failRead: true }); f.wake();
  expect(await f.app.providerReadiness(f.auth.actor)).toEqual({ codex: "store-unavailable", grok: "store-unavailable" });
  expect(f.protocol.requests).toHaveLength(0);
  const receipt = await f.app.execute(f.auth.actor, f.command());
  expect(receipt.signIn.state).toBe("store-error"); expect(receipt.approval).toBeUndefined(); expect(f.protocol.requests).toHaveLength(0);
  expect(metadata(f)).not.toContain(tokenSecret);
});

test("cancelling an in-flight store write fences and cleans its late commit", async () => {
  let release!: () => void;
  const writeGate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ writeGate }); f.wake();
  const receipt = await f.app.execute(f.auth.actor, f.command()); f.protocol.result = "success"; await f.clock.advance(1000);
  await f.app.execute(f.auth.actor, f.command("codex", "setup", receipt.signIn.id));
  release(); await flush();
  expect(status(f, receipt).state).toBe("cancelled"); expect(f.values.size).toBe(0); expect(f.requests).toHaveLength(0);
});

test("a long provider grant is capped at ten minutes and a ready outcome survives restart", async () => {
  const f = await fixture({ expiresIn: 900 }); f.wake();
  const pending = await f.app.execute(f.auth.actor, f.command()); expect(pending.signIn.expiresAt).toBe(f.clock.now() + 600_000);
  await f.clock.advance(600_001); expect(status(f, pending).state).toBe("expired");
  const ready = await f.app.execute(f.auth.actor, f.command()); f.protocol.result = "success"; await f.clock.advance(1000);
  expect(status(f, ready).state).toBe("ready");
  await f.app.closeDeviceSignIns(); f.queue.close(); await f.queue.idle(); queues.splice(queues.indexOf(f.queue), 1); f.store.close(); stores.splice(stores.indexOf(f.store), 1);
  const reopened = await fixture({ path: f.path, clock: f.clock }); expect(status(reopened, ready).state).toBe("ready");
});

test("local API authority cannot start a Web-only sign-in; stale/conflicting receipts do no provider work", async () => {
  const f = await fixture(); f.wake();
  f.app.execute(f.auth.actor, { kind: "local_api.set", requestId: crypto.randomUUID(), projectId: null, expectedRevision: 0, payload: { enabled: true } });
  const local = f.app.issueLocalApiActor()!;
  await expect(f.app.execute(local.actor, f.command())).rejects.toThrow("channel_not_authorized");
  const command = f.command(); await f.app.execute(f.auth.actor, command);
  await expect(f.app.execute(f.auth.actor, { ...command, payload: { ...command.payload, provider: "grok" } })).rejects.toThrow("request_id_conflict");
  await expect(f.app.execute(f.auth.actor, { ...f.command(), expectedRevision: 0 })).rejects.toThrow("stale_revision");
  expect(f.protocol.starts).toBe(1);
});

test("both locales render every terminal state with retry and no inline script or raw keys", () => {
  for (const locale of ["th", "en"] as const) for (const state of ["busy", "ready", "expired", "denied", "cancelled", "provider-error", "store-error", "cleanup-required"] as const) {
    const html = withLocale(locale, () => signInPage({ signIn: { id: crypto.randomUUID(), expiresAt: null, state } }, "codex", "settings", "csrf", 0));
    expect(html).toContain(dictionaries[locale][`signin.state.${state}`]);
    expect(html).not.toMatch(/signin\.[a-z]+/); expect(html).not.toMatch(/\son[a-z]+\s*=/i);
    expect(html).toContain('form="sign-in-codex"');
  }
});

async function withSignInDom(run: (dom: {
  dataset: { statusUrl: string; statusPage: string; readyPage: string; deadline: string };
  callbacks: { callback: () => Promise<void>; ms: number }[]; events: Map<string, () => void>; navigated: string[]; reads: string[];
  error: { hidden: boolean }; response: { value: Response | Error }; now: { value: number }; poll(): Promise<void>;
}) => Promise<void>) {
  const callbacks: { callback: () => Promise<void>; ms: number }[] = [], events = new Map<string, () => void>(), navigated: string[] = [], reads: string[] = [];
  const now = { value: 1_900_000_000_000 }, error = { hidden: true }, response = { value: Response.json({ signIn: { state: "pending" } }) as Response | Error };
  const dataset = { statusUrl: "/api/setup/sign-in/codex/00000000-0000-4000-8000-000000000175?surface=setup", statusPage: "/setup/sign-in/codex/00000000-0000-4000-8000-000000000175?surface=setup", readyPage: "/setup?step=connect#connection", deadline: String(now.value + 60_000) };
  const globals = {
    document: { documentElement: { dataset: {} }, getElementById: () => null, querySelector: (selector: string) => selector === "[data-sign-in][data-status-url]" ? { dataset, querySelector: () => error } : null, querySelectorAll: () => [], addEventListener: () => {} },
    window: { setTimeout: (callback: () => Promise<void>, ms: number) => { callbacks.push({ callback, ms }); }, addEventListener: (name: string, callback: () => void) => events.set(name, callback) },
    location: { replace: (path: string) => navigated.push(path) },
    fetch: async (path: string) => { reads.push(path); if (response.value instanceof Error) throw response.value; return response.value.clone(); },
    Date: { now: () => now.value },
    isSecureContext: false,
  };
  const descriptors = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  try {
    for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { value, configurable: true, writable: true });
    await import(`../src/web-assets/app.js?signin=${crypto.randomUUID()}`);
    await run({ dataset, callbacks, events, navigated, reads, error, response, now, poll: async () => { const next = callbacks.shift()!; now.value += next.ms; await next.callback(); } });
  } finally {
    for (const [key, descriptor] of descriptors) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else delete (globalThis as Record<string, unknown>)[key]; }
  }
}

test("JS status enhancement keeps the one-time code on pending, redirects on ready and stops on page exit", async () => {
  await withSignInDom(async dom => {
    await dom.poll(); expect(dom.navigated).toEqual([]); expect(dom.callbacks).toHaveLength(1);
    dom.response.value = Response.json({ signIn: { state: "ready" } }); await dom.poll(); expect(dom.navigated).toEqual([dom.dataset.readyPage]);
    expect(dom.reads).toEqual([dom.dataset.statusUrl, dom.dataset.statusUrl]); expect(JSON.stringify(dom.reads)).not.toContain(code);
  });
  await withSignInDom(async dom => {
    dom.events.get("pagehide")!(); await dom.poll(); expect(dom.reads).toHaveLength(0); expect(dom.callbacks).toHaveLength(0);
  });
});

for (const status of [408, 429, 503]) test(`JS status polling retries HTTP ${status} with backoff and returns to the provider page on ready`, async () => {
  await withSignInDom(async dom => {
    dom.response.value = new Response(null, { status });
    await dom.poll(); expect(dom.navigated).toEqual([]); expect(dom.callbacks[0]!.ms).toBe(3000);
    await dom.poll(); expect(dom.callbacks[0]!.ms).toBe(6000);
    await dom.poll(); expect(dom.callbacks[0]!.ms).toBe(10_000);
    await dom.poll(); expect(dom.callbacks[0]!.ms).toBe(10_000);
    dom.response.value = Response.json({ signIn: { state: "pending" } });
    await dom.poll(); expect(dom.callbacks[0]!.ms).toBe(1500);
    dom.response.value = Response.json({ signIn: { state: "ready" } });
    await dom.poll(); expect(dom.navigated).toEqual([dom.dataset.readyPage]); expect(dom.callbacks).toHaveLength(0); expect(dom.error.hidden).toBe(true);
  });
});

test("JS network failures back off only until the existing deadline", async () => {
  await withSignInDom(async dom => {
    dom.response.value = new TypeError("network unavailable");
    await dom.poll(); expect(dom.callbacks[0]!.ms).toBe(3000);
    dom.now.value = Number(dom.dataset.deadline) - 4000;
    await dom.poll(); expect(dom.callbacks[0]!.ms).toBe(1000);
    const reads = dom.reads.length;
    await dom.poll(); expect(dom.navigated).toEqual([dom.dataset.statusPage]); expect(dom.reads).toHaveLength(reads); expect(dom.callbacks).toHaveLength(0);
  });
});

for (const status of [401, 404]) test(`JS HTTP ${status} shows the server-localized status error with a refresh retry`, async () => {
  await withSignInDom(async dom => {
    dom.response.value = new Response(null, { status });
    await dom.poll(); expect(dom.error.hidden).toBe(false); expect(dom.callbacks).toHaveLength(0);
  });
  for (const locale of ["th", "en"] as const) {
    const html = withLocale(locale, () => signInPage({ signIn: { id: crypto.randomUUID(), state: "pending", expiresAt: 1_900_000_060_000 } }, "codex", "setup", "csrf", 0));
    expect(html).toContain(`data-sign-in-error role="alert" hidden>${dictionaries[locale]["signin.status_error"]} <a href="/setup/sign-in/`);
    expect(html).toContain(dictionaries[locale]["setup.refresh"]);
  }
});

test("a stalled local store read has a bounded blocked outcome and releases the provider", async () => {
  const f = await fixture({ hungRead: true }); f.wake();
  const started = f.app.execute(f.auth.actor, f.command()); await flush(); await f.clock.advance(5001);
  expect((await started).signIn.state).toBe("store-error"); expect(f.protocol.starts).toBe(0);
  const retried = f.app.execute(f.auth.actor, f.command()); await flush(); await f.clock.advance(5001);
  expect((await retried).signIn.state).toBe("store-error");
});

test("quota cards reuse the exact-route check result without another inference", async () => {
  const f = await fixture({ quota: true }); f.wake();
  const command = f.command(); await f.app.execute(f.auth.actor, command); f.protocol.result = "success"; await f.clock.advance(1000);
  f.queue.pump(); await f.queue.idle();
  expect((await f.app.providerReadiness(f.auth.actor)).codex).toBe("quota-exceeded");
  expect(await (await f.get("/setup?step=connect")).text()).toContain(dictionaries.en["signin.readiness.quota"]);
  expect(f.requests).toHaveLength(1);
});

test("store recovery guidance takes precedence over an older exact-route quota observation", async () => {
  const options = { quota: true, failStore: false, uncertain: false };
  const f = await fixture(options); f.wake();
  await f.app.execute(f.auth.actor, f.command()); f.protocol.result = "success"; await f.clock.advance(1000);
  f.queue.pump(); await f.queue.idle();
  expect((await f.app.providerReadiness(f.auth.actor)).codex).toBe("quota-exceeded");
  options.failStore = true; options.uncertain = true;
  await f.app.execute(f.auth.actor, f.command("codex", "settings")); await f.clock.advance(1000);
  expect((await f.app.providerReadiness(f.auth.actor)).codex).toBe("cleanup-required");
  expect(await (await f.get("/settings/team")).text()).toContain(dictionaries.en["signin.recover_store"]);
  expect(f.requests).toHaveLength(1);
});

test("Settings refreshes the selected route check after the setup ceremony without reopening setup", async () => {
  const f = await fixture(); f.wake(); await f.app.execute(f.auth.actor, f.command()); f.protocol.result = "success"; await f.clock.advance(1000);
  f.queue.pump(); await f.queue.idle();
  for (const [kind, payload] of [["setup.connect.continue", {}], ["setup.know", { addressAs: "Owner", selfReference: "Jit", language: "en", particle: "none" }], ["setup.personality.skip", {}], ["setup.complete", {}]] as const) {
    f.app.execute(f.auth.actor, { kind, requestId: crypto.randomUUID(), projectId: null, expectedRevision: f.app.setup(f.auth.actor).revision, payload } as import("../src/setup").SetupCommand);
  }
  const revision = f.app.setup(f.auth.actor).revision;
  await f.app.execute(f.auth.actor, f.command("codex", "settings")); await flush();
  f.queue.pump(); await f.queue.idle();
  expect(f.requests).toHaveLength(2); expect(f.app.setup(f.auth.actor)).toMatchObject({ complete: true, revision });
});
