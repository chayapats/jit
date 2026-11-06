import { afterEach, expect, test } from "bun:test";
import { lstatSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../src/errors";
import { NotificationService, endpointHash, noticeId, validateEndpoint } from "../src/s16/notifications/service";
import type { NoticeInput, NotificationLimits } from "../src/s16/notifications/types";
import { fakePushService, type FakePushService } from "./fixtures/s16-push";

const session = "owner-session";
interface Harness { service: NotificationService<string>; push: FakePushService; now: number; owner: { ownerId: string; generation: number }; emitted: NoticeInput[]; reopen(): void; directory: string }
const harnesses: Harness[] = [];
afterEach(async () => { for (const h of harnesses.splice(0)) { await h.service.close(); rmSync(h.directory, { recursive: true, force: true }); } });

function harness(limits: Partial<NotificationLimits> = {}): Harness {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "jit-push-"))), push = fakePushService();
  const h = { push, now: 1_800_000_000_000, owner: { ownerId: "owner", generation: 1 }, emitted: [] as NoticeInput[], directory } as Harness;
  const open = (create: boolean) => new NotificationService<string>({ path: join(directory, "notifications.sqlite"), installationId: "fixture", create, keyPath: join(directory, "notifications-vapid.key"), origin: "https://jit.example.test",
    now: () => h.now, fetch: push.fetch, limits: { timeoutMs: 5000, ...limits },
    principal: actor => { if (actor !== session) throw new AppError("authentication_required", 401); return { ...h.owner }; },
    ownerCurrent: owner => owner.ownerId === h.owner.ownerId && owner.generation === h.owner.generation,
    // Scripted source: the cursor counts emitted inputs, so a restart never re-reads committed ones.
    producers: [{ name: "scripted", collect: cursor => ({ cursor: h.emitted.length, notices: h.emitted.slice(cursor ?? h.emitted.length) }) }] });
  h.service = open(true);
  // The first pass only places every producer cursor at the current end: enabling never replays history.
  h.emitted.push({ source: "history", owner: { ...h.owner }, kind: "result", path: "/s16" }); h.service.observe();
  h.reopen = () => { void h.service.close(); h.service = open(false); };
  harnesses.push(h); return h;
}
const notice = (h: Harness, source: string, kind: NoticeInput["kind"] = "needs_you", path = "/s16/chat/conversation_1"): NoticeInput => ({ source, owner: { ...h.owner }, kind, path });
const code = (fn: () => unknown) => { try { fn(); } catch (error) { return error instanceof AppError ? [error.code, error.status] : String(error); } return null; };
const deliveryRows = (h: Harness) => h.service.journal.db.query<{ notice_id: string; state: string; attempts: number; next_at: number; code: string | null }, []>("SELECT * FROM deliveries_v1 ORDER BY rowid").all();

test("the VAPID key is created once on first use in a private file and identifies the installation", () => {
  const h = harness();
  expect(lstatSync(join(h.directory, "notifications.sqlite")).mode & 0o077).toBe(0);
  expect(() => lstatSync(join(h.directory, "notifications-vapid.key"))).toThrow();
  const settings = h.service.settings(session);
  expect(settings).toEqual({ contract: "s16-notifications/v1", publicKey: settings.publicKey, devices: 0, limit: 20 });
  expect(settings.publicKey).toMatch(/^B[A-Za-z0-9_-]{86}$/);
  const key = lstatSync(join(h.directory, "notifications-vapid.key"));
  expect(key.mode & 0o777).toBe(0o600); expect(key.size).toBe(32);
  h.reopen(); expect(h.service.settings(session).publicKey).toBe(settings.publicKey);
  // The key never appears in the journal.
  expect(h.service.journal.db.query("SELECT 1 FROM sqlite_master WHERE sql LIKE '%private%'").all()).toEqual([]);
  expect(code(() => h.service.settings("forged"))).toEqual(["authentication_required", 401]);
});

test("subscriptions are validated, stored once per device and bounded per owner", () => {
  const h = harness({ devices: 3 }), { publicKey } = h.service.settings(session), first = h.push.device();
  const subscribe = (subscription: unknown, key = publicKey) => code(() => h.service.subscribe(session, { publicKey: key, subscription }));
  const valid = first.subscription;
  for (const endpoint of ["http://push.example.test/x", "https://127.0.0.1/x", "https://[::1]/x", "https://localhost/x", "https://push.local/x", "https://push.example.test:8443/x", "https://user:pw@push.example.test/x", "https://push.example.test/x#frag", "https://PUSH.example.test/x", `https://push.example.test/${"a".repeat(2100)}`, 42])
    expect(subscribe({ ...valid, endpoint })).toEqual(["push_endpoint_invalid", 400]);
  expect(subscribe({ ...valid, keys: { ...valid.keys, p256dh: Buffer.alloc(65, 4).toString("base64url") } })).toEqual(["push_subscription_invalid", 400]);
  expect(subscribe({ ...valid, keys: { ...valid.keys, auth: Buffer.alloc(15).toString("base64url") } })).toEqual(["push_subscription_invalid", 400]);
  expect(subscribe({ ...valid, keys: { ...valid.keys, auth: "not base64url!" } })).toEqual(["push_subscription_invalid", 400]);
  expect(subscribe({ ...valid, expirationTime: h.now - 1 })).toEqual(["push_subscription_invalid", 400]);
  expect(subscribe({ ...valid, extra: true })).toEqual(["invalid_notification_command", 400]);
  expect(code(() => h.service.subscribe(session, { publicKey, subscription: valid, owner: "someone" }))).toEqual(["invalid_notification_command", 400]);
  expect(subscribe(valid, "B" + "A".repeat(86))).toEqual(["notification_key_changed", 409]);
  expect(code(() => h.service.subscribe("forged", { publicKey, subscription: valid }))).toEqual(["authentication_required", 401]);
  expect(h.service.settings(session).devices).toBe(0);

  expect(h.service.subscribe(session, { publicKey, subscription: valid })).toEqual({ contract: "s16-notification-device/v1", subscribed: true });
  // The same device subscribing again refreshes its row instead of adding one.
  const rotated = h.push.device();
  expect(subscribe({ ...valid, keys: rotated.subscription.keys })).toBeNull();
  expect(h.service.settings(session).devices).toBe(1);
  expect(h.service.device(session, endpointHash(valid.endpoint)).subscribed).toBe(true);
  expect(h.service.device(session, "0".repeat(64)).subscribed).toBe(false);
  expect(code(() => h.service.device(session, "zz"))).toEqual(["invalid_notification_command", 400]);
  expect(subscribe(h.push.device().subscription)).toBeNull(); expect(subscribe(h.push.device().subscription)).toBeNull();
  expect(subscribe(h.push.device().subscription)).toEqual(["notification_device_limit", 409]);
  expect(h.service.unsubscribe(session, { endpoint: valid.endpoint })).toEqual({ contract: "s16-notification-device/v1", subscribed: false });
  expect(h.service.unsubscribe(session, { endpoint: valid.endpoint }).subscribed).toBe(false);
  expect(h.service.device(session, endpointHash(valid.endpoint)).subscribed).toBe(false);
  expect(subscribe(h.push.device().subscription)).toBeNull(); expect(h.service.settings(session).devices).toBe(3);
  // Only canonical https push-service URLs are push endpoints.
  expect(validateEndpoint("https://fcm.googleapis.com/fcm/send/abc").host).toBe("fcm.googleapis.com");
  expect(validateEndpoint("https://web.push.apple.com/QAbc").host).toBe("web.push.apple.com");
});

test("one source yields one notice and one push per device, carrying only an ID, a kind and a path", async () => {
  const h = harness(), { publicKey } = h.service.settings(session), a = h.push.device(), b = h.push.device();
  for (const device of [a, b]) h.service.subscribe(session, { publicKey, subscription: device.subscription });
  expect(h.service.record(notice(h, "needs_you:hold_r1_3"))).toBe(true);
  expect(h.service.record(notice(h, "needs_you:hold_r1_3"))).toBe(false);
  h.emitted.push(notice(h, "needs_you:hold_r1_3"), notice(h, "result:r2", "result"));
  expect(h.service.observe()).toBe(1);
  expect(h.service.observe()).toBe(0);
  expect(await h.service.deliver()).toBe(4);
  expect(await h.service.deliver()).toBe(0);
  expect(h.push.received).toHaveLength(4);
  const id = noticeId("needs_you:hold_r1_3");
  const needs = h.push.received.filter(push => JSON.parse(push.payload).kind === "needs_you");
  expect(needs.map(push => push.endpoint).sort()).toEqual([a.endpoint, b.endpoint].sort());
  for (const push of needs) {
    expect(JSON.parse(push.payload)).toEqual({ v: 1, id, kind: "needs_you", path: "/s16/chat/conversation_1" });
    expect(push.headers).toMatchObject({ "content-encoding": "aes128gcm", "content-type": "application/octet-stream", ttl: "86400", urgency: "high", topic: id.slice(3) });
    expect(push.claims).toEqual({ aud: "https://push.example.test", exp: Math.floor(h.now / 1000) + 12 * 3600, sub: "https://jit.example.test" });
    expect(push.vapidKey).toBe(publicKey);
  }
  const result = h.push.received.find(push => JSON.parse(push.payload).kind === "result")!;
  expect(result.headers.urgency).toBe("normal");
  // Padding makes every payload the same size on the wire, whatever its kind or path.
  expect(new Set(h.push.received.map(push => push.bytes)).size).toBe(1);
  expect(new Set(deliveryRows(h).map(row => row.state))).toEqual(new Set(["sent"]));
  expect(code(() => h.service.record({ ...notice(h, "x"), path: "https://evil.example/s16" }))).toEqual(["invalid_notice", 400]);
  expect(code(() => h.service.record({ ...notice(h, "x"), path: "/s16/chat/../../admin" }))).toEqual(["invalid_notice", 400]);
});

test("transient failures retry with backoff, 410 removes the device and other refusals fail", async () => {
  const h = harness({ attempts: 4 }), { publicKey } = h.service.settings(session), a = h.push.device(), b = h.push.device();
  h.service.subscribe(session, { publicKey, subscription: a.subscription });
  h.service.record(notice(h, "n1"));
  h.push.script.push(503);
  expect(await h.service.deliver()).toBe(0);
  expect(deliveryRows(h)[0]).toMatchObject({ state: "pending", attempts: 1, code: "push_503", next_at: h.now + 30_000 });
  expect(await h.service.deliver()).toBe(0); expect(h.push.received).toHaveLength(1);
  h.now += 30_000; h.push.script.push("throw");
  expect(await h.service.deliver()).toBe(0);
  expect(deliveryRows(h)[0]).toMatchObject({ state: "pending", attempts: 2, code: "push_unreachable", next_at: h.now + 60_000 });
  h.now += 60_000; h.push.script.push({ status: 429, headers: { "retry-after": "600" } });
  await h.service.deliver();
  expect(deliveryRows(h)[0]).toMatchObject({ state: "pending", attempts: 3, code: "push_429", next_at: h.now + 600_000 });
  h.now += 600_000;
  expect(await h.service.deliver()).toBe(1);
  expect(deliveryRows(h)[0]).toMatchObject({ state: "sent", attempts: 4, code: null });
  // All attempts of the one notice used the same identity.
  expect(new Set(h.push.received.map(push => JSON.parse(push.payload).id)).size).toBe(1);

  // Exhaustion: a notice that keeps failing stops after the attempt bound.
  h.service.record(notice(h, "n2"));
  for (let i = 0; i < 4; i++) { h.push.script.push(500); await h.service.deliver(); h.now += 3_600_000; }
  expect(deliveryRows(h)[1]).toMatchObject({ state: "failed", attempts: 4, code: "push_retry_exhausted" });

  // 410: the subscription is deleted, its queued notices become gone, and later notices skip it.
  h.service.subscribe(session, { publicKey, subscription: b.subscription });
  h.service.record(notice(h, "n3")); h.service.record(notice(h, "n4"));
  h.push.script.push(410);
  await h.service.deliver();
  expect(h.service.device(session, endpointHash(a.endpoint)).subscribed).toBe(false);
  const rows = h.service.journal.db.query<{ notice_id: string; subscription_id: string; state: string; code: string }, [string, string]>("SELECT * FROM deliveries_v1 WHERE notice_id IN (?, ?) ORDER BY rowid").all(noticeId("n3"), noticeId("n4"));
  expect(rows.filter(row => row.state === "gone").length).toBe(2);
  expect(rows.filter(row => row.state === "sent").length).toBe(2);
  h.service.record(notice(h, "n5")); await h.service.deliver();
  expect(h.push.received.at(-1)!.endpoint).toBe(b.endpoint); expect(h.service.deliveries(noticeId("n5"))).toHaveLength(1);

  // Any other refusal is final; an expired notice is never sent late.
  h.service.record(notice(h, "n6")); h.push.script.push(400); await h.service.deliver();
  expect(h.service.deliveries(noticeId("n6"))[0]).toMatchObject({ state: "failed", code: "push_400", attempts: 1 });
  h.service.record(notice(h, "n7")); h.push.script.push(503); await h.service.deliver();
  h.now += 86_400_000; const before = h.push.received.length; await h.service.deliver();
  expect(h.push.received.length).toBe(before); expect(h.service.deliveries(noticeId("n7"))[0]).toMatchObject({ state: "failed", code: "notice_expired" });
});

test("restart resumes pending and interrupted deliveries without creating a second notice", async () => {
  const h = harness(), { publicKey } = h.service.settings(session), a = h.push.device();
  h.service.subscribe(session, { publicKey, subscription: a.subscription });
  h.emitted.push(notice(h, "needs_you:hold_r9_1"), notice(h, "result:r10", "result"));
  expect(h.service.observe()).toBe(2);
  // A process lost after committing `sending` for the first notice, before the push service answered.
  h.service.journal.db.query("UPDATE deliveries_v1 SET state='sending', attempts=1 WHERE notice_id=?").run(noticeId("needs_you:hold_r9_1"));
  h.reopen();
  expect(h.service.observe()).toBe(0);
  expect(h.service.record(notice(h, "needs_you:hold_r9_1"))).toBe(false);
  expect(h.service.journal.db.query("SELECT count(*) AS n FROM notices_v1").get()).toEqual({ n: 2 });
  expect(deliveryRows(h).map(row => row.state)).toEqual(["pending", "pending"]);
  expect(deliveryRows(h)[0]!.code).toBe("push_interrupted");
  expect(await h.service.deliver()).toBe(2);
  // The interrupted notice is sent under its original identity (same tag and Topic); nothing else is repeated.
  expect(h.push.received.map(push => JSON.parse(push.payload).id).sort()).toEqual([noticeId("needs_you:hold_r9_1"), noticeId("result:r10")].sort());
  h.reopen(); expect(await h.service.deliver()).toBe(0); expect(h.push.received).toHaveLength(2);
});

test("a changed owner generation removes that owner's devices before anything is pushed", async () => {
  const h = harness(), { publicKey } = h.service.settings(session), a = h.push.device();
  h.service.subscribe(session, { publicKey, subscription: a.subscription });
  h.service.record(notice(h, "n1"));
  h.owner.generation = 2;
  expect(await h.service.deliver()).toBe(0);
  expect(h.push.received).toHaveLength(0);
  expect(h.service.deliveries(noticeId("n1"))[0]).toMatchObject({ state: "gone", code: "owner_changed" });
  expect(h.service.settings(session).devices).toBe(0);
  // Notices for the new owner generation are not fanned out to the old generation's devices.
  h.service.record(notice(h, "n2")); expect(h.service.deliveries(noticeId("n2"))).toEqual([]);
});

test("retention prunes settled notices while keeping deduplication for the retention window", async () => {
  const h = harness(), { publicKey } = h.service.settings(session);
  h.service.subscribe(session, { publicKey, subscription: h.push.device().subscription });
  h.service.record(notice(h, "old")); await h.service.deliver();
  h.now += 6 * 86_400_000; h.service.observe(); expect(h.service.record(notice(h, "old"))).toBe(false);
  h.now += 2 * 86_400_000; h.service.observe();
  expect(h.service.journal.db.query("SELECT count(*) AS n FROM notices_v1").get()).toEqual({ n: 0 });
  expect(h.service.journal.db.query("SELECT count(*) AS n FROM deliveries_v1").get()).toEqual({ n: 0 });
});
