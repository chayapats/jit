import { expect, test } from "bun:test";
import { createDecipheriv, createECDH, createHmac, createPublicKey, verify } from "node:crypto";
import { base64url, encryptPushPayload, generateVapidKey, isP256Point, pushRecordSize, vapidAuthorization, vapidKey, vapidLifetimeSeconds, vapidSubject } from "../src/s16/notifications/crypto";

// RFC 8291 Appendix A.
const vector = {
  plaintext: "When I grow up, I want to be a watermelon",
  senderPrivate: "yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw",
  receiverPrivate: "q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94",
  receiverPublic: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4",
  auth: "BTBZMqHH6r4Tts7J_aSIgg",
  salt: "DGv6ra1nlYgDCS1FRnbzlw",
  body: "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
};
const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();

/** Independent receiver-side RFC 8291 decryption, used to check padded and random-key messages. */
function decrypt(body: Uint8Array, receiverPrivate: Uint8Array, auth: Uint8Array): Buffer {
  const bytes = Buffer.from(body), salt = bytes.subarray(0, 16), rs = bytes.readUInt32BE(16), idlen = bytes[20]!, sender = bytes.subarray(21, 21 + idlen), sealed = bytes.subarray(21 + idlen);
  expect(rs).toBe(pushRecordSize);
  const ecdh = createECDH("prime256v1"); ecdh.setPrivateKey(Buffer.from(receiverPrivate));
  const receiverPublic = ecdh.getPublicKey(), shared = ecdh.computeSecret(sender);
  const ikm = hmac(hmac(auth, shared), Buffer.concat([Buffer.from("WebPush: info\0"), receiverPublic, sender, Buffer.of(1)]));
  const prk = hmac(salt, ikm), key = hmac(prk, Buffer.from("Content-Encoding: aes128gcm\0\x01")).subarray(0, 16), nonce = hmac(prk, Buffer.from("Content-Encoding: nonce\0\x01")).subarray(0, 12);
  const decipher = createDecipheriv("aes-128-gcm", key, nonce); decipher.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - 16)), decipher.final()]);
  let end = plain.length - 1; while (end > 0 && plain[end] === 0) end--;
  expect(plain[end]).toBe(2);
  return plain.subarray(0, end);
}

test("aes128gcm encryption reproduces the RFC 8291 Appendix A message exactly", () => {
  const body = encryptPushPayload(Buffer.from(vector.plaintext), { p256dh: base64url(vector.receiverPublic), auth: base64url(vector.auth) }, { secrets: { privateKey: base64url(vector.senderPrivate), salt: base64url(vector.salt) } });
  expect(body.toString("base64url")).toBe(vector.body);
  expect(decrypt(body, base64url(vector.receiverPrivate), base64url(vector.auth)).toString()).toBe(vector.plaintext);
});

test("padded messages of different lengths have the same wire size and still decrypt", () => {
  const receiver = createECDH("prime256v1"); receiver.generateKeys();
  const subscription = { p256dh: receiver.getPublicKey(), auth: Buffer.alloc(16, 7) };
  const short = encryptPushPayload(Buffer.from('{"kind":"result"}'), subscription, { padTo: 256 });
  const long = encryptPushPayload(Buffer.from('{"kind":"needs_you","path":"/s16/chat/abc"}'), subscription, { padTo: 256 });
  expect(short.length).toBe(long.length);
  expect(decrypt(long, receiver.getPrivateKey(), subscription.auth).toString()).toBe('{"kind":"needs_you","path":"/s16/chat/abc"}');
  // Fresh ephemeral key and salt per message: the same plaintext never produces the same body.
  expect(encryptPushPayload(Buffer.from("x"), subscription).equals(encryptPushPayload(Buffer.from("x"), subscription))).toBe(false);
  expect(() => encryptPushPayload(Buffer.alloc(5000), subscription)).toThrow("push_payload_too_large");
  expect(() => encryptPushPayload(Buffer.from("x"), { p256dh: Buffer.alloc(65, 4), auth: subscription.auth })).toThrow("push_subscription_invalid");
});

test("strict base64url and P-256 point validation", () => {
  expect(base64url("AQID")).toEqual(Buffer.of(1, 2, 3));
  for (const bad of ["AQI=", "AQ+D", "A", "AQ/D", "a b"]) expect(() => base64url(bad)).toThrow("invalid_base64url");
  expect(isP256Point(base64url(vector.receiverPublic))).toBe(true);
  expect(isP256Point(Buffer.alloc(65, 4))).toBe(false); expect(isP256Point(base64url(vector.receiverPublic).subarray(0, 64))).toBe(false);
});

test("VAPID authorization is an ES256 JWT for the push origin that expires within 12 hours", () => {
  const key = generateVapidKey(), now = Date.UTC(2026, 10, 6, 12, 0, 0);
  expect(vapidKey(key.privateKey).publicKey).toEqual(key.publicKey);
  const header = vapidAuthorization(key, "https://push.example.test", vapidSubject("https://jit.example.test"), now);
  const match = /^vapid t=([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+), k=([A-Za-z0-9_-]+)$/.exec(header)!;
  expect(match).not.toBeNull();
  expect(JSON.parse(Buffer.from(match[1]!, "base64url").toString())).toEqual({ typ: "JWT", alg: "ES256" });
  const claims = JSON.parse(Buffer.from(match[2]!, "base64url").toString());
  expect(claims).toEqual({ aud: "https://push.example.test", exp: now / 1000 + vapidLifetimeSeconds, sub: "https://jit.example.test" });
  expect(claims.exp - now / 1000).toBeLessThanOrEqual(24 * 3600);
  expect(base64url(match[4]!)).toEqual(Buffer.from(key.publicKey));
  const point = Buffer.from(key.publicKey), publicKey = createPublicKey({ key: { kty: "EC", crv: "P-256", x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33).toString("base64url") }, format: "jwk" });
  const signature = base64url(match[3]!);
  expect(signature.length).toBe(64);
  expect(verify("sha256", Buffer.from(`${match[1]}.${match[2]}`), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)).toBe(true);
  expect(verify("sha256", Buffer.from(`${match[1]}.${match[2]}x`), { key: publicKey, dsaEncoding: "ieee-p1363" }, signature)).toBe(false);
  // The subject names the installation, never an owner address; an http origin uses a mailto at its host.
  expect(vapidSubject("http://localhost:3099")).toBe("mailto:jit@localhost");
  expect(() => vapidAuthorization(key, "http://push.example.test", "mailto:jit@localhost", now)).toThrow("push_endpoint_invalid");
  expect(() => vapidAuthorization(key, "https://push.example.test/path", "mailto:jit@localhost", now)).toThrow("push_endpoint_invalid");
  expect(() => vapidKey(new Uint8Array(32))).toThrow("vapid_key_invalid");
});
