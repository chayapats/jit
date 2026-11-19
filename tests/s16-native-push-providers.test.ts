import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, connect, type ServerHttp2Stream, type IncomingHttpHeaders } from "node:http2";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { nativePushProviders, validateNativeProviders } from "../src/s16/native-notifications/providers";
import type { NativePushProvider } from "../src/s16/native-notifications/types";

const payload = { v: 1 as const, id: "nt_" + "b".repeat(32), kind: "needs_you" as const, service: "c".repeat(64), path: "/s16/chat/opaque" };
const input = (token = "a".repeat(64)): Parameters<NativePushProvider["send"]>[0] => ({ token, locale: "th", payload, ttlSeconds: 60, now: 1700000000000, signal: AbortSignal.timeout(2000), guard() {} });
const decode = (part: string) => JSON.parse(Buffer.from(part, "base64url").toString());
function keys() {
  const root = mkdtempSync(join(tmpdir(), "jit-native-provider-"));
  const ec = generateKeyPairSync("ec", { namedCurve: "prime256v1" }), rsa = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const apns = join(root, "apns.p8"), fcm = join(root, "service-account.json");
  writeFileSync(apns, ec.privateKey.export({ format: "pem", type: "pkcs8" }), { mode: 0o600 });
  writeFileSync(fcm, JSON.stringify({ type: "service_account", project_id: "fixture-project", private_key_id: "synthetic_key_id", private_key: rsa.privateKey.export({ format: "pem", type: "pkcs8" }), client_email: "fixture@fixture-project.iam.gserviceaccount.com", token_uri: "https://oauth2.googleapis.com/token" }), { mode: 0o600 });
  return { root, ec, rsa, apns, fcm, config: { apns: { keyPath: apns, keyId: "ABCDEFGHIJ", teamId: "KLMNOPQRST", topic: "io.jit.mobile", environment: "sandbox" as const }, fcm: { credentialsPath: fcm, projectId: "fixture-project" } } };
}

test("direct APNs uses one fixed-host HTTP/2 connection, real ES256 JWT and generic localized collapse payload", async () => {
  const k = keys(), calls: { headers: IncomingHttpHeaders; body: unknown }[] = [], authorities: string[] = [];
  const server = createServer();
  server.on("stream", (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
    const chunks: Buffer[] = []; stream.on("data", chunk => chunks.push(Buffer.from(chunk))); stream.on("end", () => { calls.push({ headers, body: JSON.parse(Buffer.concat(chunks).toString()) }); stream.respond({ ":status": 200 }); stream.end(); });
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve)); const address = server.address() as { port: number };
  const provider = nativePushProviders({ apns: k.config.apns }, { connect: authority => { authorities.push(authority); return connect("http://127.0.0.1:" + address.port); } })[0]!;
  try {
    expect(provider.status()).toEqual({ provider: "apns", available: true, code: null });
    expect(await provider.send(input())).toEqual({ state: "accepted", code: null }); expect(await provider.send(input())).toEqual({ state: "accepted", code: null });
    expect(authorities).toEqual(["https://api.sandbox.push.apple.com"]); expect(calls).toHaveLength(2);
    const headers = calls[0]!.headers, jwt = String(headers.authorization).slice("bearer ".length).split(".");
    expect(decode(jwt[0]!)).toEqual({ alg: "ES256", kid: "ABCDEFGHIJ" }); expect(decode(jwt[1]!)).toEqual({ iss: "KLMNOPQRST", iat: 1700000000 });
    const signature = Buffer.from(jwt[2]!, "base64url"); expect(signature.length).toBe(64);
    expect(verify("sha256", Buffer.from(jwt[0] + "." + jwt[1]), { key: k.ec.publicKey, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
    expect(headers[":path"]).toBe("/3/device/" + "a".repeat(64)); expect(headers["apns-topic"]).toBe("io.jit.mobile"); expect(headers["apns-collapse-id"]).toBe(payload.id); expect(headers).not.toHaveProperty("cookie");
    expect(calls[0]!.body).toMatchObject({ aps: { alert: { title: "Jit" } }, jit: payload });
    expect(calls[1]!.headers.authorization).toBe(headers.authorization);
    const before = calls.length; await expect(provider.send({ ...input(), payload: { ...payload, path: "https://foreign.example" } })).rejects.toMatchObject({ code: "native_push_request_invalid" }); expect(calls).toHaveLength(before);
  } finally { await provider.close?.(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(k.root, { recursive: true, force: true }); }
});

test("direct FCM mints a real fixed-audience RS256 assertion, then uses only its OAuth token and original generic metadata", async () => {
  const k = keys(), requests: { url: string; headers: Headers; body: string }[] = [];
  let release!: () => void; const held = new Promise<void>(resolve => { release = resolve; }); let first = true;
  const provider = nativePushProviders({ fcm: k.config.fcm }, { async fetch(request) {
    requests.push({ url: request.url, headers: request.headers, body: await request.text() });
    if (request.url === "https://oauth2.googleapis.com/token") { if (first) { first = false; await held; } return Response.json({ access_token: "synthetic_fixture_access_token", token_type: "Bearer", expires_in: 3600 }); }
    return Response.json({ name: "projects/fixture-project/messages/accepted" });
  } })[0]!;
  try {
    const mutable = { ...payload }, sending = provider.send({ ...input("synthetic_fcm_token_".repeat(5)), payload: mutable });
    mutable.path = "/s16/chat/changed_after_gesture"; release(); expect(await sending).toEqual({ state: "accepted", code: null });
    expect(requests.map(request => request.url)).toEqual(["https://oauth2.googleapis.com/token", "https://fcm.googleapis.com/v1/projects/fixture-project/messages:send"]);
    const assertion = new URLSearchParams(requests[0]!.body).get("assertion")!.split(".");
    expect(decode(assertion[0]!)).toEqual({ alg: "RS256", typ: "JWT", kid: "synthetic_key_id" });
    expect(decode(assertion[1]!)).toEqual({ iss: "fixture@fixture-project.iam.gserviceaccount.com", scope: "https://www.googleapis.com/auth/firebase.messaging", aud: "https://oauth2.googleapis.com/token", iat: 1700000000, exp: 1700003600 });
    expect(verify("sha256", Buffer.from(assertion[0] + "." + assertion[1]), k.rsa.publicKey, Buffer.from(assertion[2]!, "base64url"))).toBe(true);
    expect(requests[0]!.headers.has("authorization")).toBe(false); expect(requests[1]!.headers.get("authorization")).toBe("Bearer synthetic_fixture_access_token"); expect(requests[1]!.headers.has("cookie")).toBe(false);
    const body = JSON.parse(requests[1]!.body); expect(JSON.parse(body.message.data.jit)).toEqual(payload); expect(body.message.android.notification.tag).toBe(payload.id);
    expect(await provider.send(input("synthetic_fcm_token_".repeat(5)))).toEqual({ state: "accepted", code: null }); expect(requests.filter(request => request.url.includes("oauth2")).length).toBe(1);
  } finally { release(); await provider.close?.(); rmSync(k.root, { recursive: true, force: true }); }
});

test("native provider signing-file change is latched unavailable, and config cannot choose an endpoint or embedded key", async () => {
  const k = keys(); let calls = 0;
  const provider = nativePushProviders({ fcm: k.config.fcm }, { async fetch() { calls++; return Response.json({}); } })[0]!;
  try {
    expect(provider.status().available).toBe(true); chmodSync(k.fcm, 0o644); expect(provider.status().available).toBe(false); chmodSync(k.fcm, 0o600); expect(provider.status().available).toBe(false);
    await expect(provider.send(input("synthetic_fcm_token_".repeat(5)))).rejects.toMatchObject({ code: "native_push_credentials_unavailable" }); expect(calls).toBe(0);
    expect(() => validateNativeProviders({ fcm: { ...k.config.fcm, endpoint: "https://127.0.0.1/private" } })).toThrow("native_notification_config_invalid");
    expect(() => validateNativeProviders({ apns: { ...k.config.apns, privateKey: "controlled-key-must-not-enter-config" } })).toThrow("native_notification_config_invalid");
    let getter = 0; const config = Object.defineProperty({}, "fcm", { enumerable: true, get() { getter++; return k.config.fcm; } });
    expect(() => validateNativeProviders(config)).toThrow("native_notification_config_invalid"); expect(getter).toBe(0);
  } finally { await provider.close?.(); rmSync(k.root, { recursive: true, force: true }); }
});

test("FCM rechecks the owning dispatch fence after OAuth and never sends to a removed device", async () => {
  const k = keys(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let current = true, sends = 0;
  const provider = nativePushProviders({ fcm: k.config.fcm }, { async fetch(request) {
    if (request.url.includes("oauth2")) { entered.resolve(); await release.promise; return Response.json({ access_token: "synthetic_fixture_access_token", token_type: "Bearer", expires_in: 3600 }); }
    sends++; return Response.json({ name: "projects/fixture-project/messages/accepted" });
  } })[0]!;
  try {
    const send = provider.send({ ...input("synthetic_fcm_token_".repeat(5)), guard() { if (!current) throw new Error("controlled_owner_changed"); } });
    await entered.promise; current = false; release.resolve(); await expect(send).rejects.toThrow("controlled_owner_changed"); expect(sends).toBe(0);
  } finally { release.resolve(); await provider.close?.(); rmSync(k.root, { recursive: true, force: true }); }
});

test("FCM refuses a cross-project success receipt and bounds a stalled response even when body cancellation never settles", async () => {
  const k = keys(); let stalled = false, cancelled = false, sends = 0;
  const provider = nativePushProviders({ fcm: k.config.fcm }, { async fetch(request) {
    if (request.url.includes("oauth2")) return Response.json({ access_token: "synthetic_fixture_access_token", token_type: "Bearer", expires_in: 3600 });
    sends++;
    if (!stalled) return Response.json({ name: "projects/foreign-project/messages/wrong" });
    return new Response(new ReadableStream({ start() {}, cancel() { cancelled = true; return new Promise(() => {}); } }), { headers: { "Content-Type": "application/json" } });
  } })[0]!;
  try {
    expect((await provider.send(input("synthetic_fcm_token_".repeat(5)))).state).toBe("failed");
    stalled = true; await expect(provider.send({ ...input("synthetic_fcm_token_".repeat(5)), signal: AbortSignal.timeout(20) })).rejects.toMatchObject({ code: "native_push_interrupted" });
    expect(cancelled).toBe(true); expect(sends).toBe(2);
  } finally { await provider.close?.(); rmSync(k.root, { recursive: true, force: true }); }
});

test("FCM OAuth throttling retains Retry-After and a refused redirect starts no messaging request", async () => {
  const k = keys();
  try {
    for (const status of [429, 302]) {
      let requests = 0;
      const provider = nativePushProviders({ fcm: k.config.fcm }, { async fetch(request, init) { requests++; expect(request.url).toBe("https://oauth2.googleapis.com/token"); expect(request.redirect).toBe("error"); expect(init).toEqual({ credentials: "omit", redirect: "error" }); return new Response(null, { status, headers: { "Retry-After": "5", Location: "https://foreign.example/credential-collector" } }); } })[0]!;
      try { const result = await provider.send(input("synthetic_fcm_token_".repeat(5))); expect(result.state).toBe(status === 429 ? "retry" : "failed"); if (status === 429) expect(result.retryAfterMs).toBe(5000); expect(requests).toBe(1); }
      finally { await provider.close?.(); }
    }
  } finally { rmSync(k.root, { recursive: true, force: true }); }
});
