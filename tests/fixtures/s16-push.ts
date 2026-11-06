import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";

const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();

/** One fake browser device: its own P-256 key, auth secret and push endpoint at the fake push service. */
export interface FakeDevice { endpoint: string; privateKey: Buffer; publicKey: Buffer; auth: Buffer; subscription: { endpoint: string; expirationTime: null; keys: { p256dh: string; auth: string } } }
export interface ReceivedPush { endpoint: string; headers: Record<string, string>; payload: string; bytes: number; claims: { aud: string; exp: number; sub: string }; vapidKey: string }

/**
 * Controlled push service: records every request, verifies the VAPID JWT signature against the `k=` key, decrypts the
 * RFC 8291 body with the device key, and answers with scripted statuses (default 201).
 */
export function fakePushService(origin = "https://push.example.test") {
  const received: ReceivedPush[] = [], devices = new Map<string, FakeDevice>(), script: (number | "throw" | { status: number; headers: Record<string, string> })[] = [];
  let counter = 0;
  const device = (): FakeDevice => {
    const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
    const endpoint = `${origin}/wpush/v2/device${++counter}_${Math.random().toString(36).slice(2, 10)}`, auth = Buffer.from(Array.from({ length: 16 }, (_, i) => (i * 37 + counter) & 255));
    const value = { endpoint, privateKey: ecdh.getPrivateKey(), publicKey: ecdh.getPublicKey(), auth, subscription: { endpoint, expirationTime: null, keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } } };
    devices.set(endpoint, value); return value;
  };
  const fetch = async (request: Request): Promise<Response> => {
    const next = script.shift() ?? 201;
    if (next === "throw") throw new TypeError("network unreachable");
    const target = devices.get(request.url); if (!target) return new Response(null, { status: 404 });
    const headers = Object.fromEntries(request.headers);
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=([A-Za-z0-9_-]+)$/.exec(headers.authorization ?? "");
    if (!match) throw new Error("missing VAPID authorization");
    const point = Buffer.from(match[4]!, "base64url");
    const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") }, format: "jwk" });
    if (!verify("sha256", Buffer.from(`${match[1]}.${match[2]}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(match[3]!, "base64url"))) throw new Error("bad VAPID signature");
    const body = Buffer.from(await request.arrayBuffer());
    const salt = body.subarray(0, 16), idlen = body[20]!, sender = body.subarray(21, 21 + idlen), sealed = body.subarray(21 + idlen);
    const ecdh = createECDH("prime256v1"); ecdh.setPrivateKey(target.privateKey);
    const ikm = hmac(hmac(target.auth, ecdh.computeSecret(sender)), Buffer.concat([Buffer.from("WebPush: info\0"), target.publicKey, sender, Buffer.of(1)]));
    const prk = hmac(salt, ikm), cek = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
    const decipher = createDecipheriv("aes-128-gcm", cek, nonce); decipher.setAuthTag(sealed.subarray(sealed.length - 16));
    const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
    let end = plain.length - 1; while (end > 0 && plain[end] === 0) end--;
    received.push({ endpoint: request.url, headers, payload: plain.subarray(0, end).toString(), bytes: body.length, claims: JSON.parse(Buffer.from(match[2]!, "base64url").toString()), vapidKey: match[4]! });
    if (typeof next === "object") return new Response(null, { status: next.status, headers: next.headers });
    return new Response(null, { status: next });
  };
  return { origin, received, script, device, fetch, forget(endpoint: string) { devices.delete(endpoint); } };
}
export type FakePushService = ReturnType<typeof fakePushService>;
