import { createHash, randomBytes } from "node:crypto";
import { AppError } from "../../errors";
import { DurableJournal } from "../../s15/durable-journal";
import { PolicyError } from "../../s15/policy/validation";
import { nativeNotice, nativeToken } from "../mobile/notices";
import { mobileOrigin } from "../mobile/transport";
import { noticeId } from "../notifications/service";
import type { DeliveryState, NoticeInput, NotificationOwner } from "../notifications/types";
import type { NativeNotificationDevice, NativeNotificationLimits, NativeNotificationOptions, NativeNotificationSettings, NativeProviderKind, NativePushProvider, NativePushResult } from "./types";

/** Fixed native delivery bounds; fixtures may only narrow timings/counts. Tokens and credentials never enter a receipt. */
export const nativeNotificationLimits: Readonly<NativeNotificationLimits> = Object.freeze({ ttlSeconds: 86400, attempts: 8, backoffMs: 30000, backoffMaxMs: 3600000, timeoutMs: 15000, batch: 32, retentionMs: 7 * 86400000 });
const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const bad = (code: string, status = 400): never => { throw new AppError(code, status); };
function exact(raw: unknown, keys: readonly string[]): asserts raw is Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.getPrototypeOf(raw) !== Object.prototype || Object.keys(raw).sort().join() !== keys.slice().sort().join()) bad("invalid_native_notification_command");
}
interface Device { id: string; owner_id: string; generation: number; provider: NativeProviderKind; token: string; token_hash: string; locale: "en" | "th"; revision: number; created_at: number }
interface Delivery { notice_id: string; device_id: string; state: DeliveryState; attempts: number; next_at: number; code: string | null; kind: NoticeInput["kind"]; path: string; created_at: number; owner_id: string; generation: number }

/** Validate an additive native selection before composition opens or changes any protected store. */
export function nativeNotificationSetup(options: Pick<NativeNotificationOptions<unknown>, "origin" | "providers" | "limits">): NativeNotificationLimits {
  if (mobileOrigin(options.origin) !== options.origin || !Array.isArray(options.providers) || !options.providers.length || options.providers.length > 2 || new Set(options.providers.map(provider => provider.kind)).size !== options.providers.length || options.providers.some(provider => !["apns", "fcm"].includes(provider.kind) || typeof provider.status !== "function" || typeof provider.send !== "function")) bad("native_notification_config_invalid");
  const limits = { ...nativeNotificationLimits, ...options.limits };
  if (Object.keys(limits).length !== Object.keys(nativeNotificationLimits).length || Object.keys(limits).some(key => { const value = limits[key as keyof NativeNotificationLimits]; return !Number.isSafeInteger(value) || value < 1 || value > nativeNotificationLimits[key as keyof NativeNotificationLimits]; })) bad("native_notification_config_invalid");
  return limits;
}

/**
 * Additive `s16-native-notifications/v1` protected journal. Notice admission/cursor commits are atomic; sending is
 * recorded before external I/O and recovery retains the same collapse identity. This never starts or decides work.
 */
export class NativeNotificationService<Actor> {
  readonly journal: DurableJournal;
  readonly service: string;
  readonly limits: NativeNotificationLimits;
  readonly #providers: Map<NativeProviderKind, NativePushProvider>;
  readonly #now: () => number;
  readonly #stop = new AbortController();
  #closed = false;
  #delivering: Promise<number> | null = null;
  constructor(readonly options: NativeNotificationOptions<Actor>) {
    this.limits = nativeNotificationSetup(options);
    this.service = hash(options.origin); this.#providers = new Map(options.providers.map(provider => [provider.kind, provider])); this.#now = options.now ?? Date.now;
    this.journal = new DurableJournal(options.path, options.installationId, options.create, 0x4e503136);
    try {
    if (options.create) this.#tx(() => this.journal.db.exec(`CREATE TABLE native_devices_v1 (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, generation INTEGER NOT NULL, provider TEXT NOT NULL, token TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE, locale TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_notices_v1 (id TEXT PRIMARY KEY, source TEXT NOT NULL UNIQUE, owner_id TEXT NOT NULL, generation INTEGER NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS native_deliveries_v1 (notice_id TEXT NOT NULL, device_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','sending','sent','failed','gone')), attempts INTEGER NOT NULL, next_at INTEGER NOT NULL, code TEXT, updated_at INTEGER NOT NULL, PRIMARY KEY(notice_id, device_id));
      CREATE INDEX IF NOT EXISTS native_deliveries_due_v1 ON native_deliveries_v1(state,next_at);
      CREATE TABLE IF NOT EXISTS native_cursors_v1 (name TEXT PRIMARY KEY, value INTEGER NOT NULL);`));
    // Reopen validates existing state; a missing component is never silently reconstructed.
    for (const query of ["SELECT id,owner_id,generation,provider,token,token_hash,locale,revision,created_at FROM native_devices_v1 LIMIT 0", "SELECT id,source,owner_id,generation,kind,path,created_at FROM native_notices_v1 LIMIT 0", "SELECT notice_id,device_id,state,attempts,next_at,code,updated_at FROM native_deliveries_v1 LIMIT 0", "SELECT name,value FROM native_cursors_v1 LIMIT 0"]) this.journal.db.query(query).get();
    this.#tx(() => {
      this.journal.db.query("UPDATE native_deliveries_v1 SET state='failed',code='native_push_retry_exhausted',updated_at=? WHERE state='sending' AND attempts>=?").run(this.#now(), this.limits.attempts);
      this.journal.db.query("UPDATE native_deliveries_v1 SET state='pending',code='native_push_interrupted',next_at=?,updated_at=? WHERE state='sending'").run(this.#now(), this.#now());
    });
    } catch (error) { this.journal.close(); throw error; }
  }
  #tx<T>(action: () => T): T { try { return this.journal.tx(action); } catch (error) { if (error instanceof PolicyError) throw new AppError(error.code); throw error; } }
  #remove(id: string, code: string): void {
    this.journal.db.query("DELETE FROM native_devices_v1 WHERE id=?").run(id);
    this.journal.db.query("UPDATE native_deliveries_v1 SET state='gone',code=?,updated_at=? WHERE device_id=? AND state IN ('pending','sending')").run(code, this.#now(), id);
  }
  #owner(actor: Actor): NotificationOwner {
    const owner = this.options.principal(actor);
    this.#tx(() => { for (const device of this.journal.db.query<Device, [string, number]>("SELECT * FROM native_devices_v1 WHERE owner_id<>? OR generation<>?").all(owner.ownerId, owner.generation)) this.#remove(device.id, "owner_changed"); });
    return owner;
  }
  #devices(owner: NotificationOwner): Device[] { return this.journal.db.query<Device, [string, number]>("SELECT * FROM native_devices_v1 WHERE owner_id=? AND generation=? ORDER BY created_at").all(owner.ownerId, owner.generation); }
  /** Current capability/device count only. No signing material or token is returned. */
  settings(actor: Actor): NativeNotificationSettings {
    const owner = this.#owner(actor);
    return { contract: "s16-native-notifications/v1", service: this.service, providers: this.providerStatus(), devices: this.#devices(owner).length, limit: 20 };
  }
  /** Public setup facts only; the authenticated bootstrap publishes no token/account or signing reference. */
  providerStatus() { return [...this.#providers.values()].map(provider => { const available = provider.status().available === true; return { provider: provider.kind, available, code: available ? null : "native_push_credentials_unavailable" as const }; }); }
  /** Read-only subscription state for this token hash under the current owner generation. */
  device(actor: Actor, tokenHash: string): NativeNotificationDevice {
    if (typeof tokenHash !== "string" || tokenHash.length !== 64 || !/^[a-f0-9]{64}$/.test(tokenHash)) bad("invalid_native_notification_command");
    const owner = this.#owner(actor); return { contract: "s16-native-notification-device/v1", subscribed: this.#devices(owner).some(device => device.token_hash === tokenHash) };
  }
  #input(raw: unknown, locale: boolean): { provider: NativeProviderKind; token: string; locale: "en" | "th" } {
    exact(raw, locale ? ["provider", "token", "locale"] : ["provider", "token"]);
    if (raw.provider !== "apns" && raw.provider !== "fcm" || locale && raw.locale !== "en" && raw.locale !== "th") bad("invalid_native_notification_command");
    let token: string; try { token = nativeToken(raw.provider as NativeProviderKind, raw.token); } catch { return bad("native_push_token_invalid"); }
    return { provider: raw.provider as NativeProviderKind, token, locale: raw.locale === "en" ? "en" : "th" };
  }
  /** Explicit enable only; a token updates one row and cannot choose a network destination. */
  subscribe(actor: Actor, raw: unknown): NativeNotificationDevice {
    const owner = this.#owner(actor), input = this.#input(raw, true), provider = this.#providers.get(input.provider);
    if (provider?.status().available !== true) bad("native_push_unavailable", 503);
    this.#tx(() => {
      const tokenHash = hash(input.token), existing = this.journal.db.query<Device, [string]>("SELECT * FROM native_devices_v1 WHERE token_hash=?").get(tokenHash);
      if (existing) {
        if (existing.provider !== input.provider) bad("native_push_subscription_conflict", 409);
        this.journal.db.query("UPDATE native_devices_v1 SET locale=?,revision=revision+1 WHERE id=?").run(input.locale, existing.id); return;
      }
      if (this.#devices(owner).length >= 20) bad("notification_device_limit", 409);
      this.journal.db.query("INSERT INTO native_devices_v1 VALUES (?,?,?,?,?,?,?,?,?)").run("nd_" + randomBytes(16).toString("hex"), owner.ownerId, owner.generation, input.provider, input.token, tokenHash, input.locale, 1, this.#now());
    });
    return { contract: "s16-native-notification-device/v1", subscribed: true };
  }
  /** Idempotent current-owner disable works even when its provider is now unavailable. */
  unsubscribe(actor: Actor, raw: unknown): NativeNotificationDevice {
    const owner = this.#owner(actor), input = this.#input(raw, false);
    this.#tx(() => { const device = this.journal.db.query<Device, [string]>("SELECT * FROM native_devices_v1 WHERE token_hash=?").get(hash(input.token)); if (device?.owner_id === owner.ownerId && device.generation === owner.generation && device.provider === input.provider) this.#remove(device.id, "unsubscribed"); });
    return { contract: "s16-native-notification-device/v1", subscribed: false };
  }
  /** One currently published source-derived notice; duplicates retain the same opaque collapse identity. */
  record(input: NoticeInput): boolean {
    if (typeof input.source !== "string" || !input.source || input.source.length > 512) bad("invalid_notice");
    const payload = nativeNotice({ v: 1, id: noticeId(input.source), kind: input.kind, service: this.service, path: input.path });
    if (!payload) return bad("invalid_notice");
    if (!this.options.ownerCurrent(input.owner)) return false;
    return this.#tx(() => {
      if (this.journal.db.query("SELECT 1 FROM native_notices_v1 WHERE source=?").get(input.source)) return false;
      const capacity = this.journal.db.query<{ notices: number; deliveries: number }, []>("SELECT (SELECT count(*) FROM native_notices_v1) AS notices,(SELECT count(*) FROM native_deliveries_v1) AS deliveries").get()!;
      const devices = this.#devices(input.owner);
      if (capacity.notices >= 10000 || capacity.deliveries + devices.length > 200000) bad("native_notification_capacity", 503);
      const now = this.#now(); this.journal.db.query("INSERT INTO native_notices_v1 VALUES (?,?,?,?,?,?,?)").run(payload.id, input.source, input.owner.ownerId, input.owner.generation, input.kind, input.path, now);
      for (const device of devices) this.journal.db.query("INSERT INTO native_deliveries_v1 VALUES (?,?,?,?,?,?,?)").run(payload.id, device.id, "pending", 0, now, null, now);
      return true;
    });
  }
  /** Producer cursors commit with their notices. First collection starts at each owning producer's current end. */
  observe(): number {
    this.#tx(() => { const cutoff = this.#now() - this.limits.retentionMs; this.journal.db.query("DELETE FROM native_deliveries_v1 WHERE notice_id IN (SELECT id FROM native_notices_v1 WHERE created_at<?)").run(cutoff); this.journal.db.query("DELETE FROM native_notices_v1 WHERE created_at<?").run(cutoff); });
    let added = 0;
    for (const producer of this.options.producers ?? []) this.#tx(() => {
      const stored = this.journal.db.query<{ value: number }, [string]>("SELECT value FROM native_cursors_v1 WHERE name=?").get(producer.name)?.value ?? null, batch = producer.collect(stored);
      if (!Number.isSafeInteger(batch.cursor) || batch.cursor < 0 || stored !== null && batch.cursor < stored || batch.notices.length > 256) bad("native_notice_producer_invalid");
      for (const input of batch.notices) if (this.record(input)) added++;
      this.journal.db.query("INSERT INTO native_cursors_v1 VALUES (?,?) ON CONFLICT(name) DO UPDATE SET value=excluded.value").run(producer.name, batch.cursor);
    });
    return added;
  }
  /** Join one finite delivery pass. No Bot request waits for provider acceptance. */
  deliver(): Promise<number> {
    if (this.#closed) return Promise.resolve(0);
    if (this.#delivering) return this.#delivering;
    const pass = this.#deliver(); this.#delivering = pass;
    void pass.finally(() => { if (this.#delivering === pass) this.#delivering = null; }).catch(() => {}); return pass;
  }
  async #deliver(): Promise<number> {
    let sent = 0;
    for (let visited = 0; visited < this.limits.batch && !this.#closed; visited++) {
      const now = this.#now(), row = this.journal.db.query<Delivery, [number]>(`SELECT d.*,n.kind,n.path,n.created_at,n.owner_id,n.generation FROM native_deliveries_v1 d JOIN native_notices_v1 n ON n.id=d.notice_id WHERE d.state='pending' AND d.next_at<=? ORDER BY d.next_at,d.rowid LIMIT 1`).get(now);
      if (!row) break;
      const device = this.journal.db.query<Device, [string]>("SELECT * FROM native_devices_v1 WHERE id=?").get(row.device_id), attempts = row.attempts + 1;
      const settle = (state: DeliveryState, code: string | null, next = row.next_at) => this.journal.db.query("UPDATE native_deliveries_v1 SET state=?,code=?,next_at=?,updated_at=? WHERE notice_id=? AND device_id=? AND state IN ('pending','sending')").run(state, code, next, this.#now(), row.notice_id, row.device_id).changes;
      if (!device) { this.#tx(() => settle("gone", "subscription_removed")); continue; }
      if (!this.options.ownerCurrent({ ownerId: device.owner_id, generation: device.generation }) || row.owner_id !== device.owner_id || row.generation !== device.generation) { this.#tx(() => this.#remove(device.id, "owner_changed")); continue; }
      if (now - row.created_at >= this.limits.ttlSeconds * 1000 || row.attempts >= this.limits.attempts) { this.#tx(() => settle("failed", row.attempts >= this.limits.attempts ? "native_push_retry_exhausted" : "notice_expired")); continue; }
      const provider = this.#providers.get(device.provider);
      if (provider?.status().available !== true) { this.#tx(() => settle("failed", "native_push_unavailable")); continue; }
      const payload = nativeNotice({ v: 1, id: row.notice_id, kind: row.kind, service: this.service, path: row.path });
      if (!payload) { this.#tx(() => settle("failed", "invalid_notice")); continue; }
      this.#tx(() => this.journal.db.query("UPDATE native_deliveries_v1 SET state='sending',attempts=attempts+1,updated_at=? WHERE notice_id=? AND device_id=?").run(now, row.notice_id, row.device_id));
      const signal = AbortSignal.any([this.#stop.signal, AbortSignal.timeout(this.limits.timeoutMs)]);
      const guard = () => {
        signal.throwIfAborted();
        const current = this.journal.db.query<Device, [string]>("SELECT * FROM native_devices_v1 WHERE id=?").get(device.id);
        if (!current || current.revision !== device.revision || current.token_hash !== device.token_hash || !this.options.ownerCurrent({ ownerId: device.owner_id, generation: device.generation }) || this.#now() - row.created_at >= this.limits.ttlSeconds * 1000) bad("native_push_binding_changed", 409);
      };
      let result: NativePushResult;
      try { guard(); result = await abortable(provider.send({ token: device.token, locale: device.locale, payload, ttlSeconds: Math.max(1, Math.floor(this.limits.ttlSeconds - (now - row.created_at) / 1000)), now, signal, guard }), signal); }
      catch (error) {
        if (this.#closed) { this.#tx(() => settle("pending", "native_push_interrupted", this.#now())); break; }
        if (error instanceof AppError && error.code === "native_push_binding_changed") { this.#tx(() => settle("gone", error.code)); continue; }
        result = { state: "retry", code: "native_push_unreachable" };
      }
      this.#tx(() => {
        if (result.state === "accepted") { if (settle("sent", null)) sent++; }
        else if (result.state === "gone") { settle("gone", "native_push_token_gone"); this.#remove(device.id, "native_push_token_gone"); }
        else if (result.state === "failed" || attempts >= this.limits.attempts) settle("failed", attempts >= this.limits.attempts ? "native_push_retry_exhausted" : safeCode(result.code));
        else { const backoff = Math.min(this.limits.backoffMs * 2 ** (attempts - 1), this.limits.backoffMaxMs), after = Number.isFinite(result.retryAfterMs) && result.retryAfterMs! >= 0 ? result.retryAfterMs! : backoff; settle("pending", safeCode(result.code), this.#now() + Math.min(Math.max(backoff, after), 6 * 3600000)); }
      });
    }
    return sent;
  }
  /** Protected diagnostics for tests/operational proof. No device token, credential or private notice text. */
  deliveries(id: string): { state: DeliveryState; attempts: number; code: string | null; nextAt: number }[] {
    return this.journal.db.query<{ state: DeliveryState; attempts: number; code: string | null; next_at: number }, [string]>("SELECT state,attempts,code,next_at FROM native_deliveries_v1 WHERE notice_id=? ORDER BY rowid").all(id).map(row => ({ state: row.state, attempts: row.attempts, code: row.code, nextAt: row.next_at }));
  }
  /** Abort outstanding native provider I/O and close only this additive journal. */
  async close(): Promise<void> {
    if (this.#closed) return; this.#closed = true; this.#stop.abort();
    try { await this.#delivering?.catch(() => {}); for (const provider of this.#providers.values()) try { await provider.close?.(); } catch { console.error(JSON.stringify({ event: "native_push_close_failed", contract: "s16-native-notifications/v1" })); } }
    finally { this.journal.close(); }
  }
}
const safeCode = (value: string | null) => value && /^[a-z][a-z0-9_]{0,127}$/.test(value) ? value : "native_push_failed";
async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const interrupted = new Promise<never>((_, reject) => { abort = () => reject(new Error("native_push_interrupted")); if (signal.aborted) abort(); else signal.addEventListener("abort", abort, { once: true }); });
  try { return await Promise.race([promise, interrupted]); } finally { signal.removeEventListener("abort", abort); }
}
