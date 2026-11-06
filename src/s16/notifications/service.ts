import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, writeSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../../errors";
import { DurableJournal } from "../../s15/durable-journal";
import { PolicyError } from "../../s15/policy/validation";
import { base64url, encryptPushPayload, generateVapidKey, isP256Point, vapidAuthorization, vapidKey, vapidSubject, type VapidKey } from "./crypto";
import type { DeliveryState, NoticeInput, NoticeKind, NotificationDevice, NotificationLimits, NotificationOwner, NotificationPayload, NotificationServiceOptions, NotificationSettings } from "./types";

/** Product bounds of `s16-notifications/v1`. */
export const notificationLimits: Readonly<NotificationLimits> = Object.freeze({
  devices: 20, endpointBytes: 2048, ttlSeconds: 86400, attempts: 8, backoffMs: 30_000, backoffMaxMs: 3_600_000,
  timeoutMs: 15_000, batch: 32, retentionMs: 7 * 86_400_000, padTo: 256,
});
/** Same-origin in-app destinations a notice may open: the S16 home, a conversation or a routine. */
export const noticePath = /^\/s16(?:\/(?:chat|routines)\/[A-Za-z0-9_-]{1,128})?$/;
const kinds: readonly NoticeKind[] = ["needs_you", "result", "routine"];
const bad = (code: string, status = 400): never => { throw new AppError(code, status); };
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
/** Stable notice identity derived from its source event; the service worker uses it as the notification tag. */
export const noticeId = (source: string) => "nt_" + createHash("sha256").update("s16.notice.v1\n" + source).digest("hex").slice(0, 32);
/** SHA-256 hex of a push endpoint: how a device names itself in status reads without sending its endpoint. */
export const endpointHash = (endpoint: string) => sha256(endpoint);

function record(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) bad("invalid_notification_command");
  const own = Object.keys(value as object);
  if (own.length !== keys.length || own.some(key => !keys.includes(key))) bad("invalid_notification_command");
}

/**
 * Push endpoint check. An endpoint is a browser push service URL (FCM, Mozilla autopush, Apple, WNS): https on the
 * default port with a DNS name, no credentials or fragment, in canonical form. Literal IPs and local names are
 * refused, so a subscription cannot point the service at its own network.
 */
export function validateEndpoint(value: unknown, maxBytes = notificationLimits.endpointBytes): URL {
  if (typeof value !== "string" || !value.isWellFormed() || Buffer.byteLength(value) > maxBytes) return bad("push_endpoint_invalid");
  let url: URL; try { url = new URL(value as string); } catch { return bad("push_endpoint_invalid"); }
  const host = url.hostname.toLowerCase();
  if (url.protocol !== "https:" || url.href !== value || url.username || url.password || url.hash || url.port || !host.includes(".") || host.startsWith("[") || /^[\d.]+$/.test(host)
    || /(?:^|\.)(?:localhost|local|internal|home|lan|intranet|corp)$/.test(host)) bad("push_endpoint_invalid");
  return url;
}

interface SubscriptionRow { id: string; owner_id: string; generation: number; endpoint: string; endpoint_hash: string; p256dh: string; auth: string; key_id: string; expires_at: number | null; created_at: number; updated_at: number }
interface DeliveryRow { notice_id: string; subscription_id: string; state: DeliveryState; attempts: number; next_at: number; code: string | null; updated_at: number; kind: NoticeKind; path: string; created_at: number }

/**
 * `s16-notifications/v1`: protected Web Push for the S15/S16 stack. A per-installation VAPID key is created on first
 * use in a 0600 key file; subscriptions, notices, per-subscription deliveries and producer cursors live in a protected
 * journal. Notices are derived from durable source events and carry only a generic kind and an opaque in-app path;
 * delivering one never approves, decides or starts anything.
 */
export class NotificationService<Actor> {
  readonly journal: DurableJournal;
  readonly limits: NotificationLimits;
  readonly #now: () => number;
  readonly #fetch: (request: Request) => Promise<Response>;
  #key: VapidKey | null = null;
  #delivering: Promise<number> | null = null;
  #stop = new AbortController();
  #closed = false;

  constructor(readonly options: NotificationServiceOptions<Actor>) {
    this.journal = new DurableJournal(options.path, options.installationId, options.create, 0x4e543136);
    this.limits = { ...notificationLimits, ...options.limits };
    this.#now = options.now ?? Date.now;
    this.#fetch = options.fetch ?? (request => fetch(request));
    const db = this.journal.db;
    db.exec(`CREATE TABLE IF NOT EXISTS subscriptions_v1 (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, generation INTEGER NOT NULL, endpoint TEXT NOT NULL UNIQUE, endpoint_hash TEXT NOT NULL UNIQUE,
        p256dh TEXT NOT NULL, auth TEXT NOT NULL, key_id TEXT NOT NULL, expires_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS notices_v1 (id TEXT PRIMARY KEY, source TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, generation INTEGER NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('needs_you','result','routine')), path TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS deliveries_v1 (notice_id TEXT NOT NULL REFERENCES notices_v1(id), subscription_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('pending','sending','sent','failed','gone')), attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, code TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY (notice_id, subscription_id));
      CREATE INDEX IF NOT EXISTS deliveries_v1_due ON deliveries_v1(state, next_at);
      CREATE TABLE IF NOT EXISTS cursors_v1 (name TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
    // A push whose process was lost may have reached the push service. It is sent again under the same notice ID
    // (same Topic and notification tag), so a duplicate push collapses into the one notification it already shows.
    db.query("UPDATE deliveries_v1 SET state='pending', next_at=?, code='push_interrupted' WHERE state='sending'").run(this.#now());
  }
  now(): number { return this.#now(); }

  // ---------------------------------------------------------------- VAPID key
  /** The installation VAPID key, created on first use (0600, exclusive create, no symlinks, single link). */
  #vapid(): VapidKey {
    if (this.#key) return this.#key;
    const path = this.options.keyPath;
    if (!lstatSync(path, { throwIfNoEntry: false })) {
      const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { writeSync(fd, generateVapidKey().privateKey); fsyncSync(fd); } finally { closeSync(fd); }
    }
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const stat = fstatSync(fd); if (!stat.isFile() || stat.size !== 32 || stat.mode & 0o077 || stat.nlink !== 1) bad("vapid_key_unavailable", 503);
      const bytes = Buffer.alloc(32); if (readSync(fd, bytes, 0, 32, 0) !== 32) bad("vapid_key_unavailable", 503);
      return this.#key = vapidKey(bytes);
    } finally { closeSync(fd); }
  }
  /** Base64url public application server key the browser subscribes with. */
  publicKey(): string { return Buffer.from(this.#vapid().publicKey).toString("base64url"); }
  #keyId(): string { return sha256(this.publicKey()).slice(0, 16); }

  // ---------------------------------------------------------------- owner commands and reads
  #owner(actor: Actor): NotificationOwner {
    const owner = this.options.principal(actor);
    // Subscriptions of an earlier owner generation are never reused; drop them on the next owner contact.
    this.#tx(() => { for (const row of this.journal.db.query<{ id: string }, [string, number]>("SELECT id FROM subscriptions_v1 WHERE owner_id<>? OR generation<>?").all(owner.ownerId, owner.generation)) this.#remove(row.id, "owner_changed"); });
    return owner;
  }
  #devices(owner: NotificationOwner): SubscriptionRow[] {
    return this.journal.db.query<SubscriptionRow, [string, number, string]>("SELECT * FROM subscriptions_v1 WHERE owner_id=? AND generation=? AND key_id=? ORDER BY created_at").all(owner.ownerId, owner.generation, this.#keyId());
  }
  /** Current public key and device count. Reading creates the key once and changes nothing else. */
  settings(actor: Actor): NotificationSettings {
    const owner = this.#owner(actor);
    return { contract: "s16-notifications/v1", publicKey: this.publicKey(), devices: this.#devices(owner).length, limit: this.limits.devices };
  }
  /** Whether the device whose endpoint hashes to `hash` is subscribed for this owner under the current key. */
  device(actor: Actor, hash: string): NotificationDevice {
    if (!/^[a-f0-9]{64}$/.test(hash)) bad("invalid_notification_command");
    const owner = this.#owner(actor);
    return { contract: "s16-notification-device/v1", subscribed: this.#devices(owner).some(row => row.endpoint_hash === hash) };
  }
  /**
   * Store or refresh one device subscription. The same endpoint updates in place (one row per device); a new device
   * past the owner bound refuses with `notification_device_limit`. The browser must have subscribed with the current
   * installation key (`notification_key_changed` otherwise).
   */
  subscribe(actor: Actor, raw: unknown): NotificationDevice {
    const owner = this.#owner(actor);
    record(raw, ["publicKey", "subscription"]);
    if (raw.publicKey !== this.publicKey()) bad("notification_key_changed", 409);
    const input = raw.subscription; record(input, ["endpoint", "expirationTime", "keys"]);
    const endpoint = validateEndpoint(input.endpoint, this.limits.endpointBytes).href;
    if (input.expirationTime !== null && (typeof input.expirationTime !== "number" || !Number.isSafeInteger(input.expirationTime) || input.expirationTime <= this.now())) bad("push_subscription_invalid");
    const keys = input.keys; record(keys, ["p256dh", "auth"]);
    let p256dh: Buffer, auth: Buffer;
    try { p256dh = base64url(keys.p256dh as string); auth = base64url(keys.auth as string); } catch { return bad("push_subscription_invalid"); }
    if (!isP256Point(p256dh) || auth.length !== 16) bad("push_subscription_invalid");
    const now = this.now(), hash = endpointHash(endpoint);
    this.#tx(() => {
      const existing = this.journal.db.query<SubscriptionRow, [string]>("SELECT * FROM subscriptions_v1 WHERE endpoint_hash=?").get(hash);
      if (existing) {
        this.journal.db.query("UPDATE subscriptions_v1 SET owner_id=?, generation=?, p256dh=?, auth=?, key_id=?, expires_at=?, updated_at=? WHERE id=?")
          .run(owner.ownerId, owner.generation, p256dh.toString("base64url"), auth.toString("base64url"), this.#keyId(), input.expirationTime as number | null, now, existing.id);
        return;
      }
      // Rows under an older key cannot receive pushes signed by the current one; they free their slot.
      for (const row of this.journal.db.query<{ id: string }, [string]>("SELECT id FROM subscriptions_v1 WHERE key_id<>?").all(this.#keyId())) this.#remove(row.id, "key_changed");
      if (this.#devices(owner).length >= this.limits.devices) bad("notification_device_limit", 409);
      this.journal.db.query("INSERT INTO subscriptions_v1 VALUES (?,?,?,?,?,?,?,?,?,?,?)").run("ns_" + randomBytes(16).toString("hex"), owner.ownerId, owner.generation, endpoint, hash, p256dh.toString("base64url"), auth.toString("base64url"), this.#keyId(), input.expirationTime as number | null, now, now);
    });
    return { contract: "s16-notification-device/v1", subscribed: true };
  }
  /** Remove this device. Idempotent: an unknown endpoint is already unsubscribed. */
  unsubscribe(actor: Actor, raw: unknown): NotificationDevice {
    const owner = this.#owner(actor);
    record(raw, ["endpoint"]);
    if (typeof raw.endpoint !== "string" || Buffer.byteLength(raw.endpoint) > this.limits.endpointBytes) bad("push_endpoint_invalid");
    this.#tx(() => {
      const row = this.journal.db.query<SubscriptionRow, [string]>("SELECT * FROM subscriptions_v1 WHERE endpoint_hash=?").get(endpointHash(raw.endpoint as string));
      if (row && row.owner_id === owner.ownerId && row.generation === owner.generation) this.#remove(row.id, "unsubscribed");
    });
    return { contract: "s16-notification-device/v1", subscribed: false };
  }
  /** Deletes a subscription; its undelivered notices become `gone` so nothing is sent to it later. */
  #remove(subscriptionId: string, code: string): void {
    this.journal.db.query("DELETE FROM subscriptions_v1 WHERE id=?").run(subscriptionId);
    this.journal.db.query("UPDATE deliveries_v1 SET state='gone', code=?, updated_at=? WHERE subscription_id=? AND state IN ('pending','sending')").run(code, this.now(), subscriptionId);
  }

  // ---------------------------------------------------------------- notices
  /**
   * Record one notice for its source, fanned out as one pending delivery per current subscription of that owner.
   * Idempotent by source: returns false when the source already produced a notice (within retention).
   */
  record(input: NoticeInput): boolean {
    if (typeof input.source !== "string" || !input.source || input.source.length > 512 || !kinds.includes(input.kind) || typeof input.path !== "string" || !noticePath.test(input.path)) bad("invalid_notice");
    return this.#tx(() => {
      const id = noticeId(input.source), now = this.now();
      if (this.journal.db.query("SELECT 1 FROM notices_v1 WHERE source=?").get(input.source)) return false;
      this.journal.db.query("INSERT INTO notices_v1 VALUES (?,?,?,?,?,?,?)").run(id, input.source, input.owner.ownerId, input.owner.generation, input.kind, input.path, now);
      for (const row of this.journal.db.query<{ id: string }, [string, number, string]>("SELECT id FROM subscriptions_v1 WHERE owner_id=? AND generation=? AND key_id=?").all(input.owner.ownerId, input.owner.generation, this.#keyId()))
        this.journal.db.query("INSERT INTO deliveries_v1 VALUES (?,?,?,?,?,?,?)").run(id, row.id, "pending", 0, now, null, now);
      return true;
    });
  }
  /** Run every producer once: each batch of notices commits with its producer cursor. Bounded retention pruning follows. */
  observe(): number {
    let added = 0;
    for (const producer of this.options.producers ?? []) {
      this.#tx(() => {
        const stored = this.journal.db.query<{ value: number }, [string]>("SELECT value FROM cursors_v1 WHERE name=?").get(producer.name)?.value ?? null;
        const batch = producer.collect(stored);
        for (const notice of batch.notices) if (this.record(notice)) added++;
        this.journal.db.query("INSERT INTO cursors_v1 VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(producer.name, batch.cursor);
      });
    }
    this.#tx(() => {
      const old = this.now() - this.limits.retentionMs;
      this.journal.db.query("DELETE FROM deliveries_v1 WHERE notice_id IN (SELECT id FROM notices_v1 WHERE created_at<?) AND state NOT IN ('pending','sending')").run(old);
      this.journal.db.query("DELETE FROM notices_v1 WHERE created_at<? AND NOT EXISTS (SELECT 1 FROM deliveries_v1 d WHERE d.notice_id=notices_v1.id)").run(old);
    });
    return added;
  }

  // ---------------------------------------------------------------- delivery
  /** One delivery pass at a time; a call during a pass joins it. Resolves with the number of pushes accepted. */
  deliver(): Promise<number> {
    if (this.#closed) return Promise.resolve(0);
    return this.#delivering ??= this.#pass().finally(() => { this.#delivering = null; });
  }
  async #pass(): Promise<number> {
    let sent = 0;
    for (let round = 0; round < this.limits.batch && !this.#closed; round++) {
      const now = this.now();
      const row = this.journal.db.query<DeliveryRow, [number]>(`SELECT d.*, n.kind, n.path, n.created_at FROM deliveries_v1 d JOIN notices_v1 n ON n.id=d.notice_id
        WHERE d.state='pending' AND d.next_at<=? ORDER BY d.next_at, d.rowid LIMIT 1`).get(now);
      if (!row) break;
      const subscription = this.journal.db.query<SubscriptionRow, [string]>("SELECT * FROM subscriptions_v1 WHERE id=?").get(row.subscription_id);
      const settle = (state: DeliveryState, code: string | null, nextAt = row.next_at) => this.journal.db.query("UPDATE deliveries_v1 SET state=?, code=?, next_at=?, updated_at=? WHERE notice_id=? AND subscription_id=?").run(state, code, nextAt, this.now(), row.notice_id, row.subscription_id);
      if (!subscription) { this.#tx(() => settle("gone", "subscription_removed")); continue; }
      // Every push re-establishes the owner: after a password reset or owner change nothing leaves for the old account.
      if (!this.options.ownerCurrent({ ownerId: subscription.owner_id, generation: subscription.generation })) { this.#tx(() => this.#remove(subscription.id, "owner_changed")); continue; }
      if (subscription.expires_at !== null && subscription.expires_at <= now) { this.#tx(() => this.#remove(subscription.id, "subscription_expired")); continue; }
      if (now - row.created_at >= this.limits.ttlSeconds * 1000) { this.#tx(() => settle("failed", "notice_expired")); continue; }
      let request: Request;
      try { request = this.#request(row, subscription, now); }
      catch { this.#tx(() => settle("failed", "push_request_invalid")); continue; }
      // The attempt commits before the network call; a crash now leaves `sending`, which reopens as pending.
      this.#tx(() => this.journal.db.query("UPDATE deliveries_v1 SET state='sending', attempts=attempts+1, updated_at=? WHERE notice_id=? AND subscription_id=?").run(now, row.notice_id, row.subscription_id));
      const attempts = row.attempts + 1;
      const retry = (code: string, after: number | null = null) => {
        if (attempts >= this.limits.attempts) return settle("failed", "push_retry_exhausted");
        const backoff = Math.min(this.limits.backoffMs * 2 ** (attempts - 1), this.limits.backoffMaxMs);
        settle("pending", code, this.now() + Math.min(Math.max(after ?? backoff, backoff), 6 * 3_600_000));
      };
      let response: Response | null = null;
      try { response = await this.#fetch(request); }
      catch { if (this.#closed) { this.#tx(() => settle("pending", "push_interrupted", this.now())); break; } this.#tx(() => retry("push_unreachable")); continue; }
      await response.body?.cancel().catch(() => {});
      const status = response.status;
      if (status >= 200 && status < 300) { this.#tx(() => settle("sent", null)); sent++; }
      // RFC 8030 §7.3: the subscription expired or was removed by the browser; it is deleted, never retried.
      else if (status === 404 || status === 410) this.#tx(() => { settle("gone", `push_${status}`); this.#remove(subscription.id, "subscription_gone"); });
      else if (status === 429 || status >= 500) this.#tx(() => retry(`push_${status}`, retryAfter(response!.headers.get("retry-after"), this.now())));
      else this.#tx(() => settle("failed", status === 413 ? "push_payload_too_large" : `push_${status}`));
    }
    return sent;
  }
  #request(row: DeliveryRow, subscription: SubscriptionRow, now: number): Request {
    const endpoint = validateEndpoint(subscription.endpoint, this.limits.endpointBytes);
    const payload: NotificationPayload = { v: 1, id: row.notice_id, kind: row.kind, path: row.path };
    const body = encryptPushPayload(Buffer.from(JSON.stringify(payload)), { p256dh: base64url(subscription.p256dh), auth: base64url(subscription.auth) }, { padTo: this.limits.padTo });
    const ttl = Math.max(0, Math.floor(this.limits.ttlSeconds - (now - row.created_at) / 1000));
    const signal = AbortSignal.any([this.#stop.signal, AbortSignal.timeout(this.limits.timeoutMs)]);
    return new Request(endpoint.href, { method: "POST", redirect: "error", signal, body: new Uint8Array(body).buffer, headers: {
      "Content-Type": "application/octet-stream", "Content-Encoding": "aes128gcm", TTL: String(ttl), Urgency: row.kind === "needs_you" ? "high" : "normal",
      // RFC 8030 §5.4: a pending message with the same topic is replaced, so a re-sent notice never queues twice.
      Topic: row.notice_id.slice(3),
      Authorization: vapidAuthorization(this.#vapid(), endpoint.origin, vapidSubject(this.options.origin), now) } });
  }

  /** Delivery rows of one notice, for status and evidence. */
  deliveries(noticeIdValue: string): { subscriptionId: string; state: DeliveryState; attempts: number; code: string | null; nextAt: number }[] {
    return this.journal.db.query<DeliveryRow, [string]>("SELECT * FROM deliveries_v1 WHERE notice_id=? ORDER BY rowid").all(noticeIdValue).map(row => ({ subscriptionId: row.subscription_id, state: row.state, attempts: row.attempts, code: row.code, nextAt: row.next_at }));
  }
  #tx<T>(fn: () => T): T { try { return this.journal.tx(fn); } catch (error) { if (error instanceof PolicyError) throw new AppError(error.code); throw error; } }
  /** Abort an in-flight push (it reopens as pending) and release the journal. */
  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true; this.#stop.abort();
    const pass = this.#delivering; if (pass) await pass.catch(() => {});
    this.journal.close();
  }
}

/** RFC 9110 `Retry-After` as a delay in milliseconds: delay-seconds or a future HTTP date; anything else is ignored. */
function retryAfter(value: string | null, now: number): number | null {
  if (!value) return null;
  if (/^\d{1,9}$/.test(value)) return Number(value) * 1000;
  const at = Date.parse(value);
  return Number.isFinite(at) && at > now ? at - now : null;
}
