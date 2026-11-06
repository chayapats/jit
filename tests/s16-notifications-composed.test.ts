import { afterEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { JitClient, disableNotifications, enableNotifications, notificationStatus, notificationSupport, type NotificationEnvironment } from "../src/s16/client";
import type { ClientBootstrap } from "../src/s16/client/contracts";
import { composedFixture } from "./fixtures/s15-composition";
import { routineFixture, at, type RoutineFixture } from "./fixtures/s16-routines";
import { mail } from "./fixtures/s15-effects";
import { fakePushService, type FakePushService } from "./fixtures/s16-push";

type Fixture = Awaited<ReturnType<typeof composedFixture>>;
const closers: { close(): Promise<void> }[] = [];
afterEach(async () => { for (const fixture of closers.splice(0)) await fixture.close(); });
const origin = "http://localhost:3099";
const transport = (f: Fixture) => async (request: Request) => {
  const url = new URL(request.url);
  return f.request(url.pathname + url.search, request.method, request.method === "POST" ? await request.json() : undefined, Object.fromEntries(request.headers));
};
async function pushFixture(push: FakePushService, settings: { resultAfterMs: number } = { resultAfterMs: 0 }) {
  const f = await composedFixture("default", false, undefined, base => ({ ...base, notifications: { fetch: push.fetch, get resultAfterMs() { return settings.resultAfterMs; } } }));
  closers.push(f); return f;
}

/** Fake browser: a worker that activates asynchronously and a PushManager whose subscriptions are fake push-service devices. */
function fakeBrowser(push: FakePushService, permission = "default", answer = "granted") {
  const registered: unknown[] = [], messages: unknown[] = [], listeners: (() => void)[] = [];
  const worker = { state: "installing", addEventListener(_type: "statechange", listener: () => void) { listeners.push(listener); }, postMessage(message: unknown) { messages.push(message); } };
  type Subscription = { endpoint: string; options: { applicationServerKey: ArrayBuffer | null }; toJSON(): ReturnType<FakePushService["device"]>["subscription"]; unsubscribe(): Promise<boolean> };
  let subscription: Subscription | null = null;
  const subscribeWith = (key: ArrayBuffer | null) => { const device = push.device(); subscription = { endpoint: device.endpoint, options: { applicationServerKey: key }, toJSON: () => device.subscription, async unsubscribe() { subscription = null; return true; } }; return subscription; };
  const registration = { active: null as typeof worker | null, installing: worker as typeof worker | null, waiting: null,
    pushManager: { async getSubscription() { return subscription; }, async subscribe(options: { applicationServerKey: Uint8Array }) { return subscribeWith(options.applicationServerKey.slice().buffer); } } };
  let exists = false;
  const notification = { permission, async requestPermission() { notification.permission = answer; return answer; } };
  const env: NotificationEnvironment = { isSecureContext: true, PushManager: class {}, Notification: notification,
    serviceWorker: {
      async register(script, options) {
        registered.push([script, options]); exists = true;
        setTimeout(() => { worker.state = "activated"; registration.active = worker; registration.installing = null; for (const listener of listeners) listener(); }, 0);
        return registration;
      },
      async getRegistration() { return exists ? registration : undefined; },
    } };
  return { env, registered, messages, get subscription() { return subscription; }, subscribeWith };
}

test("a held request sends one needs-you push with no private content, and approval stays in the conversation", async () => {
  const push = fakePushService(), f = await pushFixture(push), c = new JitClient({ origin, fetch: transport(f) });
  const boot = await c.bootstrap();
  expect(boot.capabilities.notifications).toEqual({ available: true, contract: "s16-notifications/v1", transport: "web_push", serviceWorker: "/s16/sw.js", scope: "/s16/" });
  const browser = fakeBrowser(push);
  expect(notificationSupport(browser.env)).toBe("default");
  expect(await notificationStatus(c, browser.env)).toEqual({ support: "default", enabled: false, code: null });
  expect(await enableNotifications(c, { locale: "th", env: browser.env })).toEqual({ support: "granted", enabled: true, code: null });
  expect(browser.registered).toEqual([["/s16/sw.js", { scope: "/s16/", type: "classic", updateViaCache: "none" }]]);
  expect(browser.messages).toEqual([{ type: "jit-locale", locale: "th" }]);
  expect(await notificationStatus(c, browser.env)).toEqual({ support: "granted", enabled: true, code: null });
  expect((await c.notificationSettings()).devices).toBe(1);
  // The VAPID key lives in its own private file, never in the composition manifest or journal rows.
  const key = readFileSync(join(f.directory, "notifications-vapid.key"));
  expect(key.length).toBe(32); expect(readFileSync(join(f.directory, "composition.json"), "utf8")).toContain("notifications.sqlite");
  expect(readFileSync(join(f.directory, "notifications.sqlite")).includes(key)).toBe(false);

  f.interpretation = { intent: "execute", purposeId: "purpose", resourceIds: ["account"], access: "effect", subject: null };
  f.script = [{ type: "tool_call", id: "email", name: "gmail_prepare_send", arguments: { ...mail(), subject: "Project Narwhal salary sheet" } }];
  const command = c.prepareMessage("conversation", "Email the Project Narwhal salary sheet to recipient@example.test");
  await c.send(command); await f.service.conversation.drain(); await f.service.drain(); await f.service.notifications!.deliver();
  const slip = (await c.snapshot("conversation")).conversation.rows[0]!.slips[0]!;
  expect(slip.state).toBe("pending"); expect(f.google.sent.size).toBe(0);
  expect(push.received).toHaveLength(1);
  const [first] = push.received, payload = JSON.parse(first!.payload);
  expect(Object.keys(payload).sort()).toEqual(["id", "kind", "path", "v"]);
  expect(payload).toMatchObject({ v: 1, kind: "needs_you", path: "/s16/chat/conversation" }); expect(payload.id).toMatch(/^nt_[a-f0-9]{32}$/);
  for (const secret of ["Narwhal", "salary", "recipient@", "Email the", command.requestId, slip.action.id]) expect(first!.payload).not.toContain(secret);
  expect(first!.headers.urgency).toBe("high"); expect(first!.claims.sub).toBe("mailto:jit@localhost");
  // Repeated wakes derive nothing new for the same hold.
  await f.service.drain(); await f.service.drain(); await f.service.notifications!.deliver(); expect(push.received).toHaveLength(1);

  // Only the owner's exact in-conversation decision dispatches; the notice itself never did.
  await c.decide({ contract: "s15-conversation-decision/v1", requestId: "approve_once", conversationId: "conversation", action: { id: slip.action.id, revision: slip.action.revision, actionHash: slip.action.actionHash }, decision: "approve" });
  await f.service.conversation.drain(); await f.service.drain(); await f.service.notifications!.deliver();
  expect(f.google.sent.size).toBe(1);
  expect(push.received.filter(item => JSON.parse(item.payload).kind === "needs_you")).toHaveLength(1);

  // A restart re-reads nothing already observed and sends nothing twice.
  const before = push.received.length;
  await f.reopen(); await f.service.drain(); await f.service.drain(); await f.service.notifications!.deliver();
  expect(push.received.length).toBe(before);
  for (const item of push.received) expect(Object.keys(JSON.parse(item.payload)).sort()).toEqual(["id", "kind", "path", "v"]);
}, 30000);

test("a finished request notifies once after the threshold; a quick reply does not", async () => {
  const push = fakePushService(), settings = { resultAfterMs: 60_000 }, f = await pushFixture(push, settings), c = new JitClient({ origin, fetch: transport(f) });
  await c.bootstrap(); const browser = fakeBrowser(push, "granted");
  expect((await enableNotifications(c, { env: browser.env })).enabled).toBe(true);
  await c.send(c.prepareMessage("conversation", "Run the requested command in the working computer"));
  await f.service.conversation.drain(); await f.service.drain(); await f.service.notifications!.deliver();
  expect((await c.snapshot("conversation")).conversation.rows[0]!.state).toBe("done");
  expect(push.received).toHaveLength(0);
  settings.resultAfterMs = 0; await f.reopen();
  const second = c.prepareMessage("conversation", "Run the requested command again for the Narwhal ledger");
  await c.send(second); await f.service.conversation.drain(); await f.service.drain(); await f.service.notifications!.deliver();
  expect(push.received.map(item => JSON.parse(item.payload))).toEqual([{ v: 1, id: expect.stringMatching(/^nt_/), kind: "result", path: "/s16/chat/conversation" }]);
  expect(push.received[0]!.payload).not.toContain("Narwhal"); expect(push.received[0]!.headers.urgency).toBe("normal");
  await f.service.drain(); await f.service.notifications!.deliver(); expect(push.received).toHaveLength(1);
  // Turning the device off removes it from the service first, then from the browser.
  expect(await disableNotifications(c, { env: browser.env })).toEqual({ support: "granted", enabled: false, code: null });
  expect(browser.subscription).toBeNull(); expect((await c.notificationSettings()).devices).toBe(0);
  await c.send(c.prepareMessage("conversation", "Run it a third time")); await f.service.conversation.drain(); await f.service.drain(); await f.service.notifications!.deliver();
  expect(push.received).toHaveLength(1);
}, 30000);

test("notification routes keep the protected client checks; the worker is public and private-free", async () => {
  const push = fakePushService(), f = await pushFixture(push), device = push.device();
  const csrfHeaders = { cookie: "", origin, "x-csrf-token": "", "content-type": "application/json" };
  const settings = await (await f.request("/api/s16/client/notifications")).json() as { publicKey: string };
  const body = { publicKey: settings.publicKey, subscription: device.subscription };
  const raw = (path: string, init: RequestInit) => f.service.fetch(new Request(origin + path, init));
  expect((await raw("/api/s16/client/notifications", {})).status).toBe(401);
  expect((await f.request("/api/s16/client/notifications/subscribe", "POST", body, { "x-csrf-token": "wrong" })).status).toBe(403);
  expect((await f.request("/api/s16/client/notifications/subscribe", "POST", body, { origin: "https://evil.example" })).status).toBe(403);
  expect((await f.request("/api/s16/client/notifications/subscribe", "POST", body, { "sec-fetch-site": "cross-site" })).status).toBe(403);
  expect((await raw("/api/s16/client/notifications/subscribe", { method: "POST", headers: csrfHeaders, body: JSON.stringify(body) })).status).toBe(401);
  expect((await f.request("/api/s16/client/notifications?x=1")).status).toBe(400);
  expect((await f.request("/api/s16/client/notifications/devices/abc")).status).toBe(404);
  expect((await f.request("/api/s16/client/notifications/subscribe")).status).toBe(405);
  expect((await f.request("/api/s16/client/notifications/subscribe", "POST", { ...body, owner: "x" })).status).toBe(400);
  const ok = await f.request("/api/s16/client/notifications/subscribe", "POST", body);
  expect(ok.status).toBe(200); expect(ok.headers.get("cache-control")).toBe("private, no-store");
  expect(await ok.json()).toEqual({ contract: "s16-notification-device/v1", subscribed: true });

  const worker = await raw("/s16/sw.js", {});
  expect(worker.status).toBe(200);
  expect(worker.headers.get("cache-control")).toBe("no-store"); expect(worker.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
  expect(worker.headers.get("content-security-policy")).toBe("default-src 'none'; img-src 'self'");
  const script = await worker.text();
  for (const text of ["จิตรอคุณอยู่", "Jit needs you", "Jit finished", "งานประจำมีผลใหม่", "notificationclick", "showNotification"]) expect(script).toContain(text);
  expect(script).not.toContain("addEventListener(\"fetch\""); expect(script).not.toContain(settings.publicKey);
  expect((await raw("/s16/sw.js?v=1", {})).status).toBe(405);
  expect((await raw("/s16/sw.js", { method: "POST" })).status).toBe(405);

  // Without the opt-in the capability is absent and the routes refuse; nothing else changes.
  const plain = await composedFixture(); closers.push(plain);
  const boot = await (await plain.request("/api/s16/client/bootstrap")).json() as ClientBootstrap;
  expect(boot.capabilities.notifications).toEqual({ available: false, code: "notifications_unavailable" });
  expect((await plain.request("/api/s16/client/notifications")).status).toBe(503);
  expect(readFileSync(join(plain.directory, "composition.json"), "utf8")).not.toContain("notifications");
}, 30000);

test("non-quiet routine outcomes notify once; a quiet run stays silent", async () => {
  const push = fakePushService();
  const f: RoutineFixture = await routineFixture({ start: at("2026-03-02T08:00:00Z"), notifications: { fetch: push.fetch, resultAfterMs: 0 } }); closers.push(f);
  const service = f.service.notifications!, { publicKey } = service.settings(f.owner);
  service.subscribe(f.owner, { publicKey, subscription: push.device().subscription });
  const quiet = await f.create(f.draft({ quiet: true, schedule: { kind: "interval", minutes: 60 } }));
  f.replies.push({ tools: [{ name: "read", arguments: { path: "status.txt" } }], text: '{"outcome":"no_update"}' });
  f.advance(3600001); await f.wake(); await service.deliver();
  expect((await f.detail(quiet.id)).occurrences[0]).toMatchObject({ state: "quiet" });
  expect(push.received).toHaveLength(0);
  // A run without a successful observation needs the owner.
  f.replies.push({ tools: [{ name: "read", arguments: { path: "../escape" } }], text: '{"outcome":"no_update"}' });
  f.advance(3600000); await f.wake(); await service.deliver();
  expect((await f.detail(quiet.id)).occurrences[0]).toMatchObject({ state: "needs_you" });
  expect(push.received.map(item => JSON.parse(item.payload))).toEqual([{ v: 1, id: expect.stringMatching(/^nt_/), kind: "needs_you", path: "/s16/chat/routine_chat" }]);
  // An ordinary visible result is one routine notice, not also a conversation result notice.
  f.replies.push({ tools: [{ name: "read", arguments: { path: "status.txt" } }], text: "Something changed." });
  f.advance(3600000); await f.wake(); await service.deliver(); await f.wake(); await service.deliver();
  expect((await f.detail(quiet.id)).occurrences[0]).toMatchObject({ state: "succeeded" });
  expect(push.received.map(item => JSON.parse(item.payload).kind)).toEqual(["needs_you", "routine"]);
  for (const item of push.received) expect(item.payload).not.toContain("Morning check");
}, 30000);

test("the client reports unsupported, denied and dismissed devices honestly and replaces a subscription under an old key", async () => {
  const push = fakePushService(), f = await pushFixture(push), c = new JitClient({ origin, fetch: transport(f) }); await c.bootstrap();
  const insecure = fakeBrowser(push); insecure.env.isSecureContext = false;
  expect(notificationSupport(insecure.env)).toBe("unsupported");
  expect(await enableNotifications(c, { env: insecure.env })).toEqual({ support: "unsupported", enabled: false, code: "notifications_unsupported" });
  const noPush = fakeBrowser(push); delete noPush.env.PushManager;
  expect(await notificationStatus(c, noPush.env)).toEqual({ support: "unsupported", enabled: false, code: "notifications_unsupported" });
  const denied = fakeBrowser(push, "denied");
  expect(await enableNotifications(c, { env: denied.env })).toEqual({ support: "denied", enabled: false, code: "notification_permission_denied" });
  expect(denied.registered).toEqual([]);
  const dismissed = fakeBrowser(push, "default", "default");
  expect(await enableNotifications(c, { env: dismissed.env })).toEqual({ support: "default", enabled: false, code: "notification_permission_dismissed" });
  // A browser subscription made with another key is reported, then replaced by enabling again.
  const stale = fakeBrowser(push, "granted");
  await stale.env.serviceWorker!.register("/s16/sw.js", { scope: "/s16/" }); stale.subscribeWith(new Uint8Array(65).fill(4).buffer);
  const old = stale.subscription!.endpoint;
  expect(await notificationStatus(c, stale.env)).toEqual({ support: "granted", enabled: false, code: "notification_key_changed" });
  expect(await enableNotifications(c, { env: stale.env })).toEqual({ support: "granted", enabled: true, code: null });
  expect(stale.subscription!.endpoint).not.toBe(old);
  expect(await notificationStatus(c, stale.env)).toEqual({ support: "granted", enabled: true, code: null });
  // A refused server call is a failed state with its code, not a silent success.
  const offline = new JitClient({ origin, fetch: async () => { throw new TypeError("offline"); } });
  const browser = fakeBrowser(push, "granted");
  expect(await enableNotifications(offline, { env: browser.env })).toEqual({ support: "granted", enabled: false, code: "connection_lost" });
}, 30000);
