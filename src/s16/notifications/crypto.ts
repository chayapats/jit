import { createCipheriv, createECDH, createHmac, createPrivateKey, randomBytes, sign } from "node:crypto";
import { AppError } from "../../errors";

/** RFC 8188 record size used for every push message: one record, so the whole payload must fit in it. */
export const pushRecordSize = 4096;
const tagBytes = 16, headerBytes = 16 + 4 + 1 + 65;
/** Largest plaintext (including padding) one 4096-byte aes128gcm record carries: rs − tag − delimiter. */
export const pushMaxPlaintext = pushRecordSize - tagBytes - 1;

const hmac = (key: Uint8Array, data: Uint8Array) => createHmac("sha256", key).update(data).digest();
const concat = (...parts: Uint8Array[]) => Buffer.concat(parts.map(part => Buffer.from(part.buffer, part.byteOffset, part.byteLength)));
const text = (value: string) => Buffer.from(value, "latin1");

/** Strict unpadded base64url (RFC 4648 §5) decoding; anything else is refused instead of guessed. */
export function base64url(value: string): Buffer {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]*$/.test(value) || value.length % 4 === 1) throw new AppError("invalid_base64url");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new AppError("invalid_base64url");
  return bytes;
}

/** True when `bytes` is an uncompressed point on P-256 (SEC1 0x04 ‖ X ‖ Y). Decoding performs the curve check. */
export function isP256Point(bytes: Uint8Array): boolean {
  if (bytes.length !== 65 || bytes[0] !== 0x04) return false;
  try { const probe = createECDH("prime256v1"); probe.generateKeys(); probe.computeSecret(bytes); return true; } catch { return false; }
}

/** Ephemeral sender material, injectable only so the RFC 8291 Appendix A vector can be reproduced exactly. */
export interface PushSenderSecrets { privateKey: Uint8Array; salt: Uint8Array }

/**
 * RFC 8291 message encryption with RFC 8188 `aes128gcm`: ECDH(P-256) with the subscription key, HKDF-SHA256 keyed by
 * the subscription auth secret, AES-128-GCM, one record of {@link pushRecordSize} bytes. `padTo` pads the plaintext
 * with the RFC 8188 delimiter and zeros so every message of a kind has the same length on the wire. Returns the
 * complete request body (header ‖ ciphertext).
 */
export function encryptPushPayload(payload: Uint8Array, subscription: { p256dh: Uint8Array; auth: Uint8Array }, options: { padTo?: number; secrets?: PushSenderSecrets } = {}): Buffer {
  if (!isP256Point(subscription.p256dh) || subscription.auth.length !== 16) throw new AppError("push_subscription_invalid");
  const padded = Math.max(payload.length, options.padTo ?? 0);
  if (padded > pushMaxPlaintext) throw new AppError("push_payload_too_large");
  const ecdh = createECDH("prime256v1");
  if (options.secrets) ecdh.setPrivateKey(Buffer.from(options.secrets.privateKey)); else ecdh.generateKeys();
  const senderPublic = ecdh.getPublicKey(), salt = options.secrets ? Buffer.from(options.secrets.salt) : randomBytes(16);
  if (salt.length !== 16) throw new AppError("push_salt_invalid");
  const shared = ecdh.computeSecret(Buffer.from(subscription.p256dh));
  // RFC 8291 §3.3–3.4: IKM = HKDF(auth, ecdh, "WebPush: info" ‖ 0 ‖ ua_public ‖ as_public, 32).
  const ikm = hmac(hmac(subscription.auth, shared), concat(text("WebPush: info\0"), subscription.p256dh, senderPublic, Uint8Array.of(1)));
  // RFC 8188 §2.2–2.3: one PRK from the salt, then a 16-byte CEK and a 12-byte nonce (record sequence 0).
  const prk = hmac(salt, ikm);
  const key = hmac(prk, concat(text("Content-Encoding: aes128gcm\0"), Uint8Array.of(1))).subarray(0, 16);
  const nonce = hmac(prk, concat(text("Content-Encoding: nonce\0"), Uint8Array.of(1))).subarray(0, 12);
  const plaintext = Buffer.alloc(padded + 1); plaintext.set(payload, 0); plaintext[payload.length] = 0x02;
  const cipher = createCipheriv("aes-128-gcm", key, nonce);
  const sealed = concat(cipher.update(plaintext), cipher.final(), cipher.getAuthTag());
  const header = Buffer.alloc(headerBytes);
  salt.copy(header, 0); header.writeUInt32BE(pushRecordSize, 16); header[20] = senderPublic.length; senderPublic.copy(header, 21);
  return concat(header, sealed);
}

/** Per-installation VAPID identity (RFC 8292). `publicKey` is the 65-byte uncompressed point the browser subscribes with. */
export interface VapidKey { privateKey: Uint8Array; publicKey: Uint8Array }

/** Derives the public point of a raw 32-byte P-256 private scalar; refuses a scalar outside the curve order. */
export function vapidKey(privateKey: Uint8Array): VapidKey {
  if (privateKey.length !== 32) throw new AppError("vapid_key_invalid");
  const ecdh = createECDH("prime256v1");
  try { ecdh.setPrivateKey(Buffer.from(privateKey)); } catch { throw new AppError("vapid_key_invalid"); }
  return { privateKey: Uint8Array.from(privateKey), publicKey: Uint8Array.from(ecdh.getPublicKey()) };
}

/** Left-pads a big-endian scalar to 32 bytes: OpenSSL drops leading zero bytes (about 1 key in 256). */
export function scalar32(value: Uint8Array): Uint8Array {
  if (value.length > 32) throw new AppError("vapid_key_invalid");
  const out = new Uint8Array(32); out.set(value, 32 - value.length); return out;
}

/** Fresh random VAPID key pair. */
export function generateVapidKey(): VapidKey { const ecdh = createECDH("prime256v1"); ecdh.generateKeys(); return vapidKey(scalar32(ecdh.getPrivateKey())); }

/** Longest token lifetime Jit signs; RFC 8292 §2 caps `exp` at 24 hours and push services may require less. */
export const vapidLifetimeSeconds = 12 * 3600;

/**
 * RFC 8292 `Authorization: vapid t=<JWT>, k=<key>` for one push service origin. The ES256 JWT carries only `aud`
 * (the push service origin), `exp` (≤ {@link vapidLifetimeSeconds} from `now`) and `sub` (an installation contact,
 * never the owner's address).
 */
export function vapidAuthorization(key: VapidKey, audience: string, subject: string, now: number): string {
  const aud = new URL(audience);
  if (aud.protocol !== "https:" || aud.origin !== audience) throw new AppError("push_endpoint_invalid");
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const unsigned = `${encode({ typ: "JWT", alg: "ES256" })}.${encode({ aud: audience, exp: Math.floor(now / 1000) + vapidLifetimeSeconds, sub: subject })}`;
  const point = Buffer.from(key.publicKey);
  const jwk = { kty: "EC", crv: "P-256", d: Buffer.from(key.privateKey).toString("base64url"), x: point.subarray(1, 33).toString("base64url"), y: point.subarray(33, 65).toString("base64url") };
  const signature = sign("sha256", Buffer.from(unsigned), { key: createPrivateKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363" });
  return `vapid t=${unsigned}.${signature.toString("base64url")}, k=${point.toString("base64url")}`;
}

/**
 * RFC 8292 `sub` contact derived from the installation origin: the origin itself when it is https, otherwise a
 * `mailto:` at its host. It identifies the installation to push services and never names the owner.
 */
export function vapidSubject(origin: string): string {
  const url = new URL(origin);
  return url.protocol === "https:" ? url.origin : `mailto:jit@${url.hostname}`;
}
