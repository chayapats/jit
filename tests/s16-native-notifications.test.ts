import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { AppError } from "../src/errors";
import { NativeNotificationService } from "../src/s16/native-notifications/service";
import type { NativePushProvider, NativePushResult } from "../src/s16/native-notifications/types";
import { nativeNotice, nativeNoticeTarget, nativeToken } from "../src/s16/mobile/notices";
import { noticeId } from "../src/s16/notifications/service";
import type { NoticeInput, NoticeProducer } from "../src/s16/notifications/types";

const token = "a".repeat(64), hash = (value: string) => createHash("sha256").update(value).digest("hex");
function fixture(send?: NativePushProvider["send"], producer?: NoticeProducer, root?: string, create = true) {
  const directory = root ?? mkdtempSync(join(tmpdir(), "jit-native-notices-")), actor = Object.freeze({}), calls: Parameters<NativePushProvider["send"]>[0][] = [];
  let now = 1000, generation = 1, available = true;
  const provider: NativePushProvider = { kind: "apns", status: () => ({ provider: "apns", available, code: available ? null : "native_push_credentials_unavailable" }), async send(input) { calls.push(input); return send ? send(input) : (input.guard(), { state: "accepted", code: null }); } };
  const service = new NativeNotificationService({ path: join(directory, "native-notifications.sqlite"), installationId: "fixture", create, origin: "https://jit.example", providers: [provider], principal: owner => { if (owner !== actor) throw new AppError("authentication_required", 401); return { ownerId: "owner", generation }; }, ownerCurrent: owner => owner.ownerId === "owner" && owner.generation === generation, now: () => now, limits: { backoffMs: 10, backoffMaxMs: 100, timeoutMs: 30 }, ...(producer ? { producers: [producer] } : {}) });
  const notice = (source = "controlled_source", path = "/s16/chat/opaque_conversation"): NoticeInput => ({ source, owner: { ownerId: "owner", generation }, kind: "needs_you", path });
  return { service, actor, directory, calls, notice, get now() { return now; }, set now(value: number) { now = value; }, set generation(value: number) { generation = value; }, set available(value: boolean) { available = value; }, async close() { await service.close(); if (!root) rmSync(directory, { recursive: true, force: true }); } };
}

test("native notice validation exposes only opaque registered-service navigation, never action arguments", () => {
  const payload = { v: 1 as const, id: "nt_" + "b".repeat(32), kind: "needs_you" as const, service: "c".repeat(64), path: "/s16/chat/opaque" };
  expect(nativeNotice(JSON.stringify(payload))).toEqual(payload); expect(nativeNoticeTarget(payload)).toEqual({ kind: "conversation", id: "opaque" });
  expect(nativeNoticeTarget({ ...payload, path: "/s16/routines/routine" })).toEqual({ kind: "routine", id: "routine" });
  for (const raw of [{ ...payload, action: "approve" }, { ...payload, credential: "controlled-secret" }, { ...payload, path: "https://foreign.example/s16/chat/opaque" }, { ...payload, path: payload.path + "?approve=true" }, { ...payload, path: payload.path + "#action" }, { ...payload, path: "/s16/chat/%6fpaque" }, { ...payload, path: payload.path + "\n" }, { ...payload, service: "https://jit.example" }]) expect(nativeNotice(raw)).toBeNull();
  expect(nativeNotice({ ...payload, id: payload.id + "\n" })).toBeNull(); expect(nativeNotice({ ...payload, service: payload.service + "\n" })).toBeNull();
  expect(() => nativeToken("apns", "a".repeat(65) + "\n")).toThrow("native_push_token_invalid"); expect(() => nativeToken("fcm", "a".repeat(32) + "\n")).toThrow("native_push_token_invalid");
});

test("native subscription bound, owner generation and generic delivery retain no private payload or receipt token", async () => {
  const f = fixture();
  try {
    expect(() => f.service.settings({})).toThrow("authentication_required");
    for (let index = 0; index < 20; index++) f.service.subscribe(f.actor, { provider: "apns", token: index.toString(16).padStart(64, "0"), locale: "th" });
    expect(() => f.service.subscribe(f.actor, { provider: "apns", token, locale: "en" })).toThrow("notification_device_limit");
    expect(f.service.settings(f.actor)).toMatchObject({ devices: 20, limit: 20, service: hash("https://jit.example") });
    f.service.unsubscribe(f.actor, { provider: "apns", token: "0".repeat(64) }); f.service.subscribe(f.actor, { provider: "apns", token, locale: "en" });
    expect(f.service.record(f.notice())).toBe(true); expect(f.service.record(f.notice())).toBe(false); expect(await f.service.deliver()).toBe(20);
    const wire = f.calls.find(call => call.token === token)!;
    expect(wire.payload).toEqual({ v: 1, id: noticeId("controlled_source"), kind: "needs_you", service: hash("https://jit.example"), path: "/s16/chat/opaque_conversation" });
    expect(JSON.stringify(f.service.settings(f.actor))).not.toContain(token); expect(JSON.stringify(f.service.deliveries(noticeId("controlled_source")))).not.toContain(token);
    f.generation = 2; expect(f.service.device(f.actor, hash(token)).subscribed).toBe(false); expect(f.service.settings(f.actor).devices).toBe(0);
  } finally { await f.close(); }
});

test("native post-OAuth guard makes an unsubscribed or changed-owner delivery inert before external dispatch", async () => {
  for (const change of ["unsubscribe", "owner"] as const) {
    const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let externalSends = 0;
    const f = fixture(async input => { entered.resolve(); await release.promise; input.guard(); externalSends++; return { state: "accepted", code: null }; });
    try {
      f.service.subscribe(f.actor, { provider: "apns", token, locale: "en" }); f.service.record(f.notice());
      const pass = f.service.deliver(); await entered.promise;
      if (change === "unsubscribe") f.service.unsubscribe(f.actor, { provider: "apns", token }); else f.generation = 2;
      release.resolve(); expect(await pass).toBe(0); expect(externalSends).toBe(0); expect(f.service.deliveries(noticeId("controlled_source"))[0]!.state).toBe("gone");
    } finally { release.resolve(); await f.close(); }
  }
});

test("native transient retry uses the same collapse ID, finite attempts and a truthful gone-token outcome", async () => {
  let result: NativePushResult = { state: "retry", code: "native_push_throttled", retryAfterMs: 25 };
  const f = fixture(async input => { input.guard(); return result; });
  try {
    f.service.subscribe(f.actor, { provider: "apns", token, locale: "en" }); f.service.record(f.notice());
    expect(await f.service.deliver()).toBe(0); expect(f.service.deliveries(noticeId("controlled_source"))[0]).toMatchObject({ state: "pending", attempts: 1, nextAt: 1025 });
    expect(await f.service.deliver()).toBe(0); expect(f.calls).toHaveLength(1);
    f.now = 1025; result = { state: "accepted", code: null }; expect(await f.service.deliver()).toBe(1);
    expect(f.calls.map(call => call.payload.id)).toEqual([noticeId("controlled_source"), noticeId("controlled_source")]);
    result = { state: "gone", code: "native_push_token_gone" }; f.service.record(f.notice("second")); expect(await f.service.deliver()).toBe(0);
    expect(f.service.device(f.actor, hash(token)).subscribed).toBe(false); expect(f.service.deliveries(noticeId("second"))[0]!.state).toBe("gone");
  } finally { await f.close(); }
});

test("native close settles promptly even when a provider ignores cancellation, and late guard refuses external I/O", async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let external = 0;
  const f = fixture(async input => { entered.resolve(); await release.promise; input.guard(); external++; return { state: "accepted", code: null }; });
  try {
    f.service.subscribe(f.actor, { provider: "apns", token, locale: "en" }); f.service.record(f.notice());
    const pass = f.service.deliver(); await entered.promise; await f.service.close(); expect(await pass).toBe(0);
    release.resolve(); await Promise.resolve(); expect(external).toBe(0);
  } finally { release.resolve(); await f.close(); }
});

test("native source cursor and notice admission commit together; enabling starts at the current producer end", async () => {
  let end = 3, invalid = false;
  const producer: NoticeProducer = { name: "fixture_events", collect(cursor) { return cursor === null ? { cursor: end, notices: [] } : { cursor: end, notices: cursor < end ? [{ source: "event_" + end, owner: { ownerId: "owner", generation: 1 }, kind: "result", path: invalid ? "/actions/approve" : "/s16/chat/opaque" }] : [] }; } };
  const f = fixture(undefined, producer);
  try {
    f.service.subscribe(f.actor, { provider: "apns", token, locale: "th" }); expect(f.service.observe()).toBe(0);
    end = 4; invalid = true; expect(() => f.service.observe()).toThrow("invalid_notice");
    invalid = false; expect(f.service.observe()).toBe(1); expect(f.service.observe()).toBe(0); expect(await f.service.deliver()).toBe(1);
    expect(f.calls.map(call => call.payload.id)).toEqual([noticeId("event_4")]);
  } finally { await f.close(); }
});

test("native SIGKILL recovery resends only the same generic collapse identity after a durable sending claim", async () => {
  const directory = mkdtempSync(join(tmpdir(), "jit-native-push-crash-"));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, "fixtures/s16-native-push-crash.ts"), directory], { stdout: "pipe", stderr: "pipe" });
  let reopened: ReturnType<typeof fixture> | undefined;
  try {
    const reader = child.stdout.getReader(), decoder = new TextDecoder(); let output = "";
    try { while (!output.includes("\n")) { const next = await reader.read(); if (next.done || output.length > 2048) throw Error("Native crash fixture exited before its durable claim"); output += decoder.decode(next.value, { stream: true }); } }
    finally { reader.releaseLock(); }
    const claim = JSON.parse(output.split("\n")[0]!); expect(claim).toEqual({ state: "sending", id: noticeId("crashed_native_notice") });
    child.kill("SIGKILL"); await child.exited;
    const accepted = await Bun.file(join(directory, "accepted-notice.json")).json(); expect(nativeNotice(accepted)).toEqual(accepted);
    reopened = fixture(undefined, undefined, directory, false);
    expect(reopened.service.deliveries(accepted.id)[0]).toMatchObject({ state: "pending", attempts: 1, code: "native_push_interrupted" });
    expect(await reopened.service.deliver()).toBe(1); expect(reopened.calls).toHaveLength(1); expect(reopened.calls[0]!.payload).toEqual(accepted);
    expect(reopened.service.deliveries(accepted.id)[0]).toMatchObject({ state: "sent", attempts: 2 });
  } finally { child.kill(); await child.exited; await reopened?.close(); rmSync(directory, { recursive: true, force: true }); }
});

test("native retry exhaustion, expiry and disabled credentials are terminal and truthful", async () => {
  const f = fixture(async input => { input.guard(); return { state: "retry", code: "native_push_throttled" }; });
  try {
    f.service.subscribe(f.actor, { provider: "apns", token, locale: "en" }); f.service.record(f.notice());
    for (let attempt = 0; attempt < 8; attempt++) { expect(await f.service.deliver()).toBe(0); f.now = f.service.deliveries(noticeId("controlled_source"))[0]!.nextAt; }
    expect(f.calls).toHaveLength(8); expect(f.service.deliveries(noticeId("controlled_source"))[0]).toMatchObject({ state: "failed", attempts: 8, code: "native_push_retry_exhausted" });
    f.service.record(f.notice("expires")); f.now += 86400000; expect(await f.service.deliver()).toBe(0); expect(f.calls).toHaveLength(8);
    expect(f.service.deliveries(noticeId("expires"))[0]).toMatchObject({ state: "failed", attempts: 0, code: "notice_expired" });
    f.available = false; expect(() => f.service.subscribe(f.actor, { provider: "apns", token: "b".repeat(64), locale: "en" })).toThrow("native_push_unavailable");
    expect(f.service.settings(f.actor).providers[0]).toEqual({ provider: "apns", available: false, code: "native_push_credentials_unavailable" });
  } finally { await f.close(); }
});

test("native reopen refuses missing journal components and releases a failed constructor's process lease", async () => {
  const f = fixture();
  try {
    await f.service.close(); const db = new Database(join(f.directory, "native-notifications.sqlite")); db.exec("DROP TABLE native_devices_v1"); db.close();
    for (let attempt = 0; attempt < 2; attempt++) {
      let error: unknown; try { fixture(undefined, undefined, f.directory, false); } catch (failure) { error = failure; }
      expect(error).toBeDefined(); expect(String(error)).toContain("native_devices_v1"); expect(String(error)).not.toContain("runtime_already_open");
    }
  } finally { await f.close(); }
});
