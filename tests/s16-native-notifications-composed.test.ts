import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { JitClient } from "../src/s16/client";
import { MobileSession } from "../src/s16/mobile/session";
import { MobileTransport, mobileServiceId, type MobileSecureStore } from "../src/s16/mobile/transport";
import { nativeNotice } from "../src/s16/mobile/notices";
import type { NativePushProvider } from "../src/s16/native-notifications/types";
import { mobileAppFixture } from "./fixtures/s16-mobile-app";
import { mail } from "./fixtures/s15-effects";

const token = "a".repeat(64), hash = (value: string) => createHash("sha256").update(value).digest("hex");
async function fixture(enabled = true) {
  const sent: Parameters<NativePushProvider["send"]>[0][] = [], records = new Map<string, string>();
  const provider: NativePushProvider = { kind: "apns", status: () => Object.assign({ provider: "apns" as const, available: true, code: null }, { privateFixtureMetadata: "MUST_NOT_REACH_CLIENT" }), async send(input) { input.guard(); sent.push(input); return { state: "accepted", code: null }; } };
  let authentications = 0;
  const m = await mobileAppFixture(options => {
    const authenticate = options.owner.authenticate;
    return { ...options, owner: { ...options.owner, authenticate(token) { const result = authenticate(token); authentications++; return result; } }, ...(enabled ? { nativeNotifications: { providers: [provider], resultAfterMs: 0 } } : {}) };
  });
  const store: MobileSecureStore = { async get(key) { return records.get(key) ?? null; }, async set(key, value) { records.set(key, value); }, async delete(key) { records.delete(key); } };
  const transport = new MobileTransport({ origin: m.origin, store, fetch: (url, init) => fetch(url, init) });
  const session = new MobileSession(transport); await session.signIn(m.password);
  const client = new JitClient({ origin: m.origin, fetch: request => transport.fetch(request) }); await client.bootstrap();
  return { m, sent, session, client, records, get authentications() { return authentications; } };
}

test("native push is absent by default and explicit owning composition derives a generic notice from real held work", async () => {
  const off = await fixture(false);
  try {
    expect(off.session.projection.bootstrap!.capabilities).not.toHaveProperty("nativeNotifications");
    expect(existsSync(join(off.m.f.directory, "native-notifications.sqlite"))).toBe(false);
    expect(off.m.f.vmCalls).toEqual([]);
  } finally { await off.m.close(); }
  const f = await fixture();
  try {
    expect(f.session.projection.bootstrap!.capabilities.nativeNotifications).toEqual({ available: true, contract: "s16-native-notifications/v1", providers: [{ provider: "apns", available: true, code: null }] });
    const settings = await f.client.nativeNotificationSettings(); expect(settings.service).toBe(await mobileServiceId(f.m.origin)); expect(settings.devices).toBe(0);
    expect(JSON.stringify(settings)).not.toContain("MUST_NOT_REACH_CLIENT"); expect(f.sent).toEqual([]); expect(f.m.f.vmCalls).toEqual([]);
    const inventory = JSON.parse(readFileSync(join(f.m.f.directory, "composition.json"), "utf8")); expect(inventory.stores).toContain("native-notifications.sqlite");
    expect((await f.client.nativeNotificationSubscription("subscribe", { provider: "apns", token, locale: "th" })).subscribed).toBe(true);
    expect((await f.client.nativeNotificationDevice(hash(token))).subscribed).toBe(true);
    f.m.f.interpretation = { intent: "execute", purposeId: "purpose", resourceIds: ["account"], access: "effect", subject: null };
    f.m.f.script = [{ type: "tool_call", id: "held_native_mail", name: "gmail_prepare_send", arguments: { ...mail(), subject: "PRIVATE_NATIVE_SUBJECT" } }];
    await f.client.send(f.client.prepareMessage("native_notice_conversation", "Send the prepared email to the recipient")); await f.m.f.service.drain();
    f.m.f.service.nativeNotifications!.observe(); await f.m.f.service.nativeNotifications!.deliver();
    expect(f.sent).toHaveLength(1); expect(nativeNotice(f.sent[0]!.payload)).toEqual(f.sent[0]!.payload);
    expect(f.sent[0]!.payload).toMatchObject({ kind: "needs_you", path: "/s16/chat/native_notice_conversation", service: settings.service });
    expect(JSON.stringify(f.sent[0]!.payload)).not.toContain("PRIVATE_NATIVE_SUBJECT"); expect(JSON.stringify(f.sent[0]!.payload)).not.toContain(token); expect(f.m.f.google.sent.size).toBe(0);
    f.m.f.service.nativeNotifications!.observe(); await f.m.f.service.nativeNotifications!.deliver(); expect(f.sent).toHaveLength(1);
    expect((await f.client.nativeNotificationSubscription("unsubscribe", { provider: "apns", token })).subscribed).toBe(false);
    expect((await f.client.nativeNotificationDevice(hash(token))).subscribed).toBe(false);
    const native = readFileSync(join(f.m.f.directory, "native-notifications.sqlite")); expect(native.readUInt32BE(68)).toBe(0x4e503136);
  } finally { await f.m.close(); }
});

test("native HTTP routes retain real password/session, Host, Origin and CSRF checks", async () => {
  const f = await fixture();
  try {
    const login = await fetch(f.m.origin + "/s14/login", { method: "POST", redirect: "manual", headers: { Origin: f.m.origin, "Content-Type": "application/json" }, body: JSON.stringify({ password: f.m.password }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!, csrf = f.m.app.authenticate(cookie.slice("jit_s14=".length)).csrf;
    const url = f.m.origin + "/api/s16/client/native-notifications/subscribe", body = JSON.stringify({ provider: "apns", token, locale: "en" });
    const request = (headers: HeadersInit, method = "POST") => { const exact = new Headers(headers); exact.set("Content-Type", "application/json"); return f.m.f.service.fetch(new Request(url, { method, headers: exact, ...(method === "POST" ? { body } : {}) })); };
    expect((await request({ Origin: f.m.origin, "Content-Type": "application/json" })).status).toBe(401);
    expect((await request({ Cookie: cookie, Origin: "https://foreign.example", "X-CSRF-Token": csrf })).status).toBe(403);
    expect((await request({ Cookie: cookie, Origin: f.m.origin, "X-CSRF-Token": csrf, Host: "foreign.example" })).status).toBe(403);
    expect((await request({ Cookie: cookie, Origin: f.m.origin, "X-CSRF-Token": "forged" })).status).toBe(403);
    const good = await request({ Cookie: cookie, Origin: f.m.origin, "X-CSRF-Token": csrf }); expect(good.status).toBe(200); expect(good.headers.get("cache-control")).toBe("private, no-store");
    const extra = await f.m.f.service.fetch(new Request(url, { method: "POST", headers: { Cookie: cookie, Origin: f.m.origin, "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: JSON.stringify({ provider: "apns", token, locale: "en", action: "approve" }) })); expect(extra.status).toBe(400);
    expect(f.sent).toEqual([]); expect(f.m.f.google.sent.size).toBe(0); expect(f.m.f.vmCalls).toEqual([]);
  } finally { await f.m.close(); }
});

test("native subscribe reauthenticates after streaming and cannot write under a reset owner generation", async () => {
  const f = await fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    const login = await fetch(f.m.origin + "/s14/login", { method: "POST", redirect: "manual", headers: { Origin: f.m.origin, "Content-Type": "application/json" }, body: JSON.stringify({ password: f.m.password }) });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!, csrf = f.m.app.authenticate(cookie.slice("jit_s14=".length)).csrf;
    const count = f.authentications; let requested = false;
    const stream = new ReadableStream<Uint8Array>({ async pull(controller) { if (requested) return; requested = true; entered.resolve(); await release.promise; controller.enqueue(new TextEncoder().encode(JSON.stringify({ provider: "apns", token, locale: "en" }))); controller.close(); } }, { highWaterMark: 0 });
    const response = f.m.f.service.fetch(new Request(f.m.origin + "/api/s16/client/native-notifications/subscribe", { method: "POST", headers: { Cookie: cookie, Origin: f.m.origin, "X-CSRF-Token": csrf, "Content-Type": "application/json" }, body: stream }));
    await entered.promise; expect(f.authentications).toBeGreaterThan(count);
    f.m.store.transaction(tx => tx.run("UPDATE owner SET generation=generation+1 WHERE id='owner'"));
    release.resolve(); expect([401, 403]).toContain((await response).status);
    const devices = f.m.f.service.nativeNotifications!.journal.db.query<{ n: number }, []>("SELECT count(*) AS n FROM native_devices_v1").get()!.n;
    expect(devices).toBe(0); expect(f.sent).toEqual([]); expect(f.m.f.google.sent.size).toBe(0); expect(f.m.f.vmCalls).toEqual([]);
  } finally { release.resolve(); await f.m.close(); }
});

test("native additive selection preserves installed policy and adopts an existing journal after manifest rollback", async () => {
  let enabled = false;
  const provider: NativePushProvider = { kind: "apns", status: () => ({ provider: "apns", available: true, code: null }), async send(input) { input.guard(); return { state: "accepted", code: null }; } };
  const m = await mobileAppFixture(options => ({ ...options, ...(enabled ? { nativeNotifications: { providers: [provider] } } : {}) }));
  try {
    const manifestPath = join(m.f.directory, "composition.json"), before = readFileSync(manifestPath, "utf8"), policy = m.f.service.policy.owner.current(m.f.owner);
    expect(JSON.parse(before).stores).not.toContain("native-notifications.sqlite");
    enabled = true; await m.f.reopen();
    expect(m.f.service.policy.owner.current(m.f.owner)).toEqual(policy);
    const records = new Map<string, string>(), store: MobileSecureStore = { async get(key) { return records.get(key) ?? null; }, async set(key, value) { records.set(key, value); }, async delete(key) { records.delete(key); } };
    const transport = new MobileTransport({ origin: m.origin, store, fetch: (url, init) => fetch(url, init) }); await transport.signIn(m.password);
    const client = new JitClient({ origin: m.origin, fetch: request => transport.fetch(request) }); await client.bootstrap();
    await client.nativeNotificationSubscription("subscribe", { provider: "apns", token, locale: "en" });
    await m.f.service.close(); writeFileSync(manifestPath, before);
    await m.f.reopen(); await client.bootstrap();
    expect((await client.nativeNotificationDevice(hash(token))).subscribed).toBe(true);
    expect(m.f.service.policy.owner.current(m.f.owner)).toEqual(policy); expect(m.f.vmCalls).toEqual([]);
    expect(JSON.parse(readFileSync(manifestPath, "utf8")).stores).toContain("native-notifications.sqlite");
  } finally { await m.close(); }
});
