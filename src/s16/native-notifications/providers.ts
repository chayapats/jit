import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { createHash, createPrivateKey, createPublicKey, sign, type KeyObject } from "node:crypto";
import { connect, type ClientHttp2Session, type IncomingHttpHeaders } from "node:http2";
import { isAbsolute } from "node:path";
import { AppError } from "../../errors";
import { dictionaries, type Locale } from "../../i18n";
import { nativeNotice, nativeToken } from "../mobile/notices";
import type { NativeProvidersConfig, NativePushProvider, NativePushResult, NativeProviderKind, NativeProviderStatus } from "./types";

const oauth = "https://oauth2.googleapis.com/token", scope = "https://www.googleapis.com/auth/firebase.messaging";
type Input = Parameters<NativePushProvider["send"]>[0];
const failed = (code = "native_push_failed"): NativePushResult => ({ state: "failed", code });
const unavailable = (): never => { throw new AppError("native_push_credentials_unavailable", 503); };
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const fingerprint = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
/** Trusted fixture transports only. Runtime JSON cannot provide a fetch function or connection factory. */
export type NativeProviderFetch = (request: Request, init: { credentials: "omit"; redirect: "error" }) => Promise<Response>;
/** Fixture-only network seams; protected runtime configuration cannot select these functions. */
export interface NativeProviderTransports { fetch?: NativeProviderFetch; connect?: (origin: string) => ClientHttp2Session }

/** Validate the operator's fixed endpoints/signing references before composition; never reads a credential. */
export function validateNativeProviders(raw: unknown): asserts raw is NativeProvidersConfig {
  const object = (value: unknown, keys: string[]): value is Record<string, unknown> => !!value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype && Reflect.ownKeys(value).every(key => { const descriptor = Object.getOwnPropertyDescriptor(value, key)!; return typeof key === "string" && keys.includes(key) && descriptor.enumerable && "value" in descriptor; });
  const path = (value: unknown) => typeof value === "string" && value.length <= 4096 && isAbsolute(value) && !/[\u0000-\u001f]/.test(value);
  if (!object(raw, ["apns", "fcm"]) || !raw.apns && !raw.fcm) throw new AppError("native_notification_config_invalid");
  if (raw.apns !== undefined) {
    const a = raw.apns;
    if (!object(a, ["keyPath", "keyId", "teamId", "topic", "environment"]) || !path(a.keyPath) || typeof a.keyId !== "string" || !/^[A-Z0-9]{10}$/.test(a.keyId) || a.keyId.length !== 10 || typeof a.teamId !== "string" || !/^[A-Z0-9]{10}$/.test(a.teamId) || a.teamId.length !== 10 || typeof a.topic !== "string" || !/^[A-Za-z0-9.-]{1,255}$/.test(a.topic) || /[\r\n]/.test(a.topic) || !["sandbox", "production"].includes(String(a.environment))) throw new AppError("native_notification_config_invalid");
  }
  if (raw.fcm !== undefined) {
    const f = raw.fcm;
    if (!object(f, ["credentialsPath", "projectId"]) || !path(f.credentialsPath) || typeof f.projectId !== "string" || !/^[a-z][a-z0-9-]{4,28}[a-z0-9]$/.test(f.projectId) || /[\r\n]/.test(f.projectId)) throw new AppError("native_notification_config_invalid");
  }
}
function protectedBytes(path: string): Buffer {
  let fd: number | undefined;
  try {
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd), uid = process.geteuid?.();
    if (!stat.isFile() || stat.mode & 0o077 || stat.nlink !== 1 || stat.size < 1 || stat.size > 65536 || uid !== undefined && stat.uid !== uid && stat.uid !== 0) unavailable();
    const buffer = Buffer.alloc(65537); let length = 0;
    while (length < buffer.length) { const read = readSync(fd, buffer, length, buffer.length - length, null); if (!read) break; length += read; }
    const current = lstatSync(path);
    if (length !== stat.size || length > 65536 || current.isSymbolicLink() || current.ino !== stat.ino || current.dev !== stat.dev || fstatSync(fd).size !== stat.size) { buffer.fill(0); return unavailable(); }
    return buffer.subarray(0, length);
  } catch { return unavailable(); } finally { if (fd !== undefined) closeSync(fd); }
}
interface Loaded { key: KeyObject; fingerprint: string; email?: string; kid?: string }
function signingFile(path: string, kind: NativeProviderKind, project?: string): Loaded {
  const bytes = protectedBytes(path);
  try {
    const pin = fingerprint(bytes);
    if (kind === "apns") {
      const key = createPrivateKey(bytes), publicKey = createPublicKey(key).export({ format: "jwk" });
      if (key.asymmetricKeyType !== "ec" || publicKey.crv !== "P-256") return unavailable();
      return { key, fingerprint: pin };
    }
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (value.type !== "service_account" || value.project_id !== project || typeof value.private_key !== "string" || typeof value.client_email !== "string" || value.client_email.length > 320 || /[^\x21-\x7e]/.test(value.client_email) || !/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+\.gserviceaccount\.com$/.test(value.client_email) || value.token_uri !== undefined && value.token_uri !== oauth || value.universe_domain !== undefined && value.universe_domain !== "googleapis.com" || value.private_key_id !== undefined && (typeof value.private_key_id !== "string" || !/^[a-zA-Z0-9_-]{1,256}$/.test(value.private_key_id) || /[\r\n]/.test(value.private_key_id))) return unavailable();
    const key = createPrivateKey(value.private_key); value.private_key = "";
    const publicKey = createPublicKey(key).export({ format: "jwk" }), modulus = Buffer.from(publicKey.n ?? "", "base64url"), bits = (modulus.length - 1) * 8 + (32 - Math.clz32(modulus[0] ?? 0));
    if (key.asymmetricKeyType !== "rsa" || bits < 2048 || bits > 8192) return unavailable();
    return { key, fingerprint: pin, email: value.client_email, ...(value.private_key_id ? { kid: value.private_key_id } : {}) };
  } catch { return unavailable(); } finally { bytes.fill(0); }
}
abstract class Provider implements NativePushProvider {
  abstract readonly kind: NativeProviderKind;
  protected credential: Loaded | null;
  protected closed = false;
  constructor(readonly path: string, kind: NativeProviderKind, project?: string) { try { this.credential = signingFile(path, kind, project); } catch { this.credential = null; } }
  status(): NativeProviderStatus {
    let available = false;
    if (!this.closed && this.credential) { let bytes: Buffer | undefined; try { bytes = protectedBytes(this.path); available = fingerprint(bytes) === this.credential.fingerprint; } catch {} finally { bytes?.fill(0); } }
    if (!available && !this.closed) this.close();
    return { provider: this.kind, available, code: available ? null : "native_push_credentials_unavailable" };
  }
  protected guard(input: Input): void { input.signal.throwIfAborted(); input.guard(); if (!this.status().available) unavailable(); }
  protected prepare(input: Input): Input {
    const payload = nativeNotice(input.payload);
    if (!payload || !Number.isSafeInteger(input.now) || input.now < 0 || !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 86400 || !["en", "th"].includes(input.locale)) throw new AppError("native_push_request_invalid");
    return { ...input, payload, token: nativeToken(this.kind, input.token), signal: AbortSignal.any([input.signal, AbortSignal.timeout(15000)]) };
  }
  abstract send(input: Input): Promise<NativePushResult>;
  close(): void { this.closed = true; this.credential = null; }
}
function copy(locale: Locale, kind: Input["payload"]["kind"]): { title: string; body: string } {
  const dictionary = dictionaries[locale];
  return { title: dictionary["s16.mobile.noticeTitle"], body: dictionary[kind === "needs_you" ? "s16.mobile.noticeNeedsYou" : kind === "result" ? "s16.mobile.noticeResult" : "s16.mobile.noticeRoutine"] };
}
async function race<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const stopped = new Promise<never>((_, reject) => { abort = () => reject(new AppError("native_push_interrupted", 503)); if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([promise, stopped]); } finally { signal.removeEventListener("abort", abort); }
}
const retryAfter = (value: string | null | undefined, now: number): number | undefined => { if (!value) return; if (/^\d{1,9}$/.test(value)) return Math.min(21600000, Number(value) * 1000); const at = Date.parse(value); return Number.isFinite(at) && at > now ? Math.min(21600000, at - now) : undefined; };
function result(status: number, body: unknown, provider: NativeProviderKind, now: number, retry?: string | null): NativePushResult {
  const json = body as { reason?: unknown; error?: { details?: { errorCode?: unknown }[] } } | null;
  if (provider === "apns" && (status === 410 || status === 400 && ["BadDeviceToken", "DeviceTokenNotForTopic"].includes(String(json?.reason))) || provider === "fcm" && Array.isArray(json?.error?.details) && json!.error!.details!.some(detail => detail.errorCode === "UNREGISTERED")) return { state: "gone", code: "native_push_token_gone" };
  if (status === 429 || status >= 500) { const after = retryAfter(retry, now); return { state: "retry", code: status === 429 ? "native_push_throttled" : "native_push_unavailable", ...(after !== undefined ? { retryAfterMs: after } : {}) }; }
  return failed(status >= 300 && status < 400 ? "native_push_redirect_refused" : status === 401 || status === 403 ? "native_push_authorization_failed" : "native_push_rejected");
}
function json(bytes: Buffer): unknown { try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { return null; } }
class AuthorizationError extends Error { constructor(readonly result: NativePushResult) { super(result.code ?? "native_push_authorization_failed"); } }

class Apns extends Provider {
  readonly kind = "apns" as const;
  #client: ClientHttp2Session | null = null;
  #ready: Promise<ClientHttp2Session> | null = null;
  #jwt: { at: number; token: string } | null = null;
  constructor(readonly config: NonNullable<NativeProvidersConfig["apns"]>, readonly connection: (origin: string) => ClientHttp2Session) { super(config.keyPath, "apns"); }
  async #connection(signal: AbortSignal): Promise<ClientHttp2Session> {
    if (!this.#client || this.#client.destroyed || this.#client.closed) {
      const client = this.connection(this.config.environment === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com"); this.#client = client;
      this.#ready = new Promise((resolve, reject) => { client.once("connect", () => resolve(client)); client.once("error", reject); client.once("close", () => reject(new AppError("native_push_unreachable", 503))); });
      client.on("error", () => { if (!client.destroyed) client.destroy(); });
      client.on("goaway", () => client.close());
      client.once("close", () => { if (this.#client === client) { this.#client = null; this.#ready = null; } });
    }
    try { return await race(this.#ready!, signal); } catch (error) { this.#client?.destroy(); throw error; }
  }
  #authorization(now: number): string {
    if (this.#jwt && now >= this.#jwt.at && now - this.#jwt.at < 1800000) return this.#jwt.token;
    const head = encode({ alg: "ES256", kid: this.config.keyId }), claims = encode({ iss: this.config.teamId, iat: Math.floor(now / 1000) }), unsigned = head + "." + claims;
    const signature = sign("sha256", Buffer.from(unsigned), { key: this.credential!.key, dsaEncoding: "ieee-p1363" });
    if (signature.length !== 64) return unavailable();
    const token = unsigned + "." + signature.toString("base64url"); this.#jwt = { at: now, token }; return token;
  }
  async send(raw: Input): Promise<NativePushResult> {
    const input = this.prepare(raw); this.guard(input); const client = await this.#connection(input.signal); this.guard(input);
    const alert = copy(input.locale, input.payload.kind), payload = Buffer.from(JSON.stringify({ aps: { alert, sound: "default" }, jit: input.payload }));
    if (payload.length > 4096) return failed("native_push_payload_limit");
    const headers = { ":method": "POST", ":path": "/3/device/" + input.token, "apns-topic": this.config.topic, "apns-push-type": "alert", "apns-priority": input.payload.kind === "needs_you" ? "10" : "5", "apns-expiration": String(Math.floor(input.now / 1000) + input.ttlSeconds), "apns-collapse-id": input.payload.id, authorization: "bearer " + this.#authorization(input.now), "content-type": "application/json" };
    this.guard(input);
    const reply = await new Promise<{ status: number; body: Buffer; retry: string | null }>((resolve, reject) => {
      const request = client.request(headers); let status = 0, retry: string | null = null, size = 0, chunks: Buffer[] = [];
      const abort = () => { request.destroy(); reject(new AppError("native_push_interrupted", 503)); };
      input.signal.addEventListener("abort", abort, { once: true });
      request.once("response", (response: IncomingHttpHeaders) => { status = Number(response[":status"]); retry = typeof response["retry-after"] === "string" ? response["retry-after"] : null; });
      request.on("data", (chunk: Buffer) => { size += chunk.length; if (size > 65536) { request.destroy(); reject(new AppError("native_push_response_limit", 503)); } else chunks.push(Buffer.from(chunk)); });
      request.once("error", () => reject(new AppError("native_push_unreachable", 503)));
      request.once("end", () => resolve({ status, body: Buffer.concat(chunks), retry }));
      request.once("close", () => { input.signal.removeEventListener("abort", abort); chunks = []; if (!request.readableEnded) reject(new AppError("native_push_unreachable", 503)); });
      if (input.signal.aborted) abort(); else request.end(payload);
    });
    return reply.status === 200 ? { state: "accepted", code: null } : result(reply.status, json(reply.body), "apns", input.now, reply.retry);
  }
  override close(): void { super.close(); this.#jwt = null; this.#client?.destroy(); this.#client = null; this.#ready = null; }
}

async function fetchJson(fetcher: NativeProviderFetch, request: Request): Promise<{ status: number; body: unknown; retry: string | null }> {
  // Bun 1.4.2's Request.credentials getter does not retain "omit". Set actual dispatch flags explicitly as well.
  const pending = fetcher(request, { credentials: "omit", redirect: "error" }); let accepted = false;
  void pending.then(response => { if (request.signal.aborted && !accepted) void response.body?.cancel().catch(() => {}); }, () => {});
  const response = await race(pending, request.signal); accepted = true;
  if (response.redirected || response.status >= 300 && response.status < 400) { await response.body?.cancel().catch(() => {}); return { status: 302, body: null, retry: null }; }
  const reader = response.body?.getReader(); if (!reader) return { status: response.status, body: null, retry: response.headers.get("retry-after") };
  const chunks: Buffer[] = []; let size = 0;
  try { while (true) { const next = await race(reader.read(), request.signal); if (next.done) break; size += next.value.length; if (size > 65536) throw new AppError("native_push_response_limit", 503); chunks.push(Buffer.from(next.value)); } }
  finally { void reader.cancel().catch(() => {}); }
  return { status: response.status, body: json(Buffer.concat(chunks)), retry: response.headers.get("retry-after") };
}
class Fcm extends Provider {
  readonly kind = "fcm" as const;
  #token: { value: string; expires: number; issued: number } | null = null;
  constructor(readonly config: NonNullable<NativeProvidersConfig["fcm"]>, readonly fetcher: NativeProviderFetch) { super(config.credentialsPath, "fcm", config.projectId); }
  async #authorization(input: Input): Promise<string> {
    if (this.#token && input.now >= this.#token.issued && input.now < this.#token.expires - 60000) return this.#token.value;
    const unsigned = encode({ alg: "RS256", typ: "JWT", ...(this.credential!.kid ? { kid: this.credential!.kid } : {}) }) + "." + encode({ iss: this.credential!.email, scope, aud: oauth, iat: Math.floor(input.now / 1000), exp: Math.floor(input.now / 1000) + 3600 });
    const assertion = unsigned + "." + sign("sha256", Buffer.from(unsigned), this.credential!.key).toString("base64url");
    this.guard(input);
    const response = await fetchJson(this.fetcher, new Request(oauth, { method: "POST", redirect: "error", credentials: "omit", signal: input.signal, headers: { "Content-Type": "application/x-www-form-urlencoded", "Cache-Control": "no-store" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }).toString() }));
    this.guard(input); const body = response.body as { access_token?: unknown; token_type?: unknown; expires_in?: unknown } | null;
    if (response.status !== 200) throw new AuthorizationError(response.status === 429 || response.status >= 500 ? result(response.status, response.body, "fcm", input.now, response.retry) : failed("native_push_authorization_failed"));
    if (!body || typeof body.access_token !== "string" || body.access_token.length > 8192 || !body.access_token.length || /[^\x21-\x7e]/.test(body.access_token) || body.token_type !== "Bearer" || !Number.isSafeInteger(body.expires_in) || (body.expires_in as number) < 1 || (body.expires_in as number) > 3600) throw new AuthorizationError(failed("native_push_response_invalid"));
    this.#token = { value: body.access_token, expires: input.now + (body.expires_in as number) * 1000, issued: input.now }; return body.access_token;
  }
  async send(raw: Input): Promise<NativePushResult> {
    const input = this.prepare(raw); this.guard(input); let authorization: string;
    try { authorization = await this.#authorization(input); } catch (error) { if (error instanceof AuthorizationError) return error.result; throw error; }
    this.guard(input);
    const body = { message: { token: input.token, notification: copy(input.locale, input.payload.kind), data: { jit: JSON.stringify(input.payload) }, android: { ttl: input.ttlSeconds + "s", priority: input.payload.kind === "needs_you" ? "HIGH" : "NORMAL", notification: { channel_id: "jit-work", tag: input.payload.id } } } };
    const response = await fetchJson(this.fetcher, new Request(`https://fcm.googleapis.com/v1/projects/${this.config.projectId}/messages:send`, { method: "POST", redirect: "error", credentials: "omit", signal: input.signal, headers: { Authorization: "Bearer " + authorization, "Content-Type": "application/json", "Cache-Control": "no-store" }, body: JSON.stringify(body) }));
    const receipt = response.body as { name?: unknown } | null;
    if (response.status === 200 && typeof receipt?.name === "string" && receipt.name.startsWith(`projects/${this.config.projectId}/messages/`) && receipt.name.length <= 1024 && !/[\u0000-\u0020]/.test(receipt.name)) return { state: "accepted", code: null };
    if (response.status === 401) this.#token = null;
    return result(response.status, response.body, "fcm", input.now, response.retry);
  }
  override close(): void { super.close(); this.#token = null; }
}
/** Fixed-host direct native push providers; invalid/missing protected files expose capability failure only. */
export function nativePushProviders(config: NativeProvidersConfig, transports: NativeProviderTransports = {}): NativePushProvider[] {
  validateNativeProviders(config);
  return [...(config.apns ? [new Apns(Object.freeze({ ...config.apns }), transports.connect ?? (origin => connect(origin, { minVersion: "TLSv1.2" })))] : []), ...(config.fcm ? [new Fcm(Object.freeze({ ...config.fcm }), transports.fetch ?? ((request, init) => fetch(request, init)))] : [])];
}
