import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, writeFileSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import { readMonitor } from "./authority";
import { readPollDue, wakeMonitorPoll } from "./poll-due";

/**
 * app.webhook_triggers/v1 — signed webhooks that only wake an existing PR poll early (REL07, ADR 0035, FR-33).
 *
 * The owner creates one trigger per PR monitor: an opaque route id and an HMAC-SHA256 secret shown once. A sender
 * reachable over the VPN posts to `/hooks/pr/<routeId>` with `X-Hub-Signature-256: sha256=<hex>` and a delivery id.
 * A request that passes every check only moves the monitor's next poll earlier ({@link wakeMonitorPoll}); its
 * payload is never parsed, stored, or passed to review input or a model.
 *
 * The secret is stored sealed (AES-256-GCM) under an installation key file `<data>/webhooks/seal.key` (folder 0700,
 * file 0600) that never enters the database, a backup image or an export. Deleting the trigger or revoking the
 * monitor erases the sealed secret.
 */

/** Finite operator limits of the webhook surface. */
export interface WebhookLimits {
  /** Largest request body in bytes. */
  bodyBytes: number;
  /** Requests admitted per route and rate window, counted before the signature check. */
  requests: number;
  windowMs: number;
  /** How long a delivery id stays a duplicate. Older receipts are pruned. */
  dedupeMs: number;
}
export const webhookLimits: WebhookLimits = Object.freeze({ bodyBytes: 32 * 1024, requests: 30, windowMs: 60_000, dedupeMs: 7 * 24 * 60 * 60 * 1000 });

/** Path prefix of the webhook route on the Web listener. */
export const webhookPathPrefix = "/hooks/pr/";
/** Route ids are 128-bit random, base64url. */
export const webhookRouteId = /^[A-Za-z0-9_-]{22}$/;
/** Delivery ids from `X-GitHub-Delivery` or `X-Jit-Delivery`. */
export const webhookDeliveryId = /^[A-Za-z0-9._:-]{1,128}$/;
/** Shown-once secret: `jitwh_` and 32 random bytes in base64url. `redactCredentials` recognises the shape. */
const secretShape = /^jitwh_[A-Za-z0-9_-]{43}$/;

export type WebhookCommandKind = "pr.webhook.create" | "pr.webhook.rotate" | "pr.webhook.delete";
/** Owner command: create, rotate or delete the trigger of one monitor at the trigger revision the owner saw. */
export interface WebhookCommand {
  kind: WebhookCommandKind;
  requestId: string;
  projectId: string;
  /** Trigger revision of the monitor (0 before the first create; it keeps counting across delete and create). */
  expectedRevision: number;
  payload: { monitorId: string };
}

/** Owner view of one monitor's trigger. Never carries the secret or its sealed form. */
export interface WebhookTriggerView {
  monitorId: string;
  state: "none" | "active" | "deleted";
  routeId: string | null;
  /** Path to configure in the sender while active. */
  path: string | null;
  revision: number;
  createdAt: number | null;
  rotatedAt: number | null;
  deletedAt: number | null;
  /** False after a restore from a backup image (secrets are not in images) or when the key file is gone: rotate. */
  secretAvailable: boolean;
}

/** Command result. `secret` is shown exactly once: a replayed receipt answers `secret: null`. */
export interface WebhookReceipt { trigger: WebhookTriggerView; secret: string | null }

const exact = (value: unknown, keys: string[]) =>
  !!value && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value as object, key));

export function isWebhookCommand(command: unknown): command is WebhookCommand {
  const kind = (command as { kind?: unknown } | null)?.kind;
  return kind === "pr.webhook.create" || kind === "pr.webhook.rotate" || kind === "pr.webhook.delete";
}

/** Validates a command and returns its stable identity for receipt replay. */
export function webhookIdentity(command: WebhookCommand): string {
  if (!exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) || !isWebhookCommand(command)
      || typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId)
      || typeof command.projectId !== "string" || !/^[a-f0-9-]{36}$/.test(command.projectId)
      || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0
      || !exact(command.payload, ["monitorId"]) || typeof command.payload.monitorId !== "string"
      || !/^[a-f0-9-]{36}$/.test(command.payload.monitorId)) throw new AppError("invalid_webhook_command");
  return createHash("sha256").update(JSON.stringify([command.kind, command.projectId, command.expectedRevision, command.payload.monitorId])).digest("hex");
}

// ---------------------------------------------------------------------------
// Sealing
// ---------------------------------------------------------------------------

/** Folder of the installation sealing key: `<data>/webhooks/`, `<data>` being the database folder. */
export const webhookKeyDirectory = (databasePath: string) => join(dirname(databasePath), "webhooks");

function realDirectory(path: string): boolean {
  try { const stat = lstatSync(path); return stat.isDirectory() && !stat.isSymbolicLink(); } catch { return false; }
}

/** Reads the 32-byte key without following a symlink, or null when it does not exist or is unusable. */
function readKey(directory: string): Buffer | null {
  if (!realDirectory(directory)) return null;
  const path = join(directory, "seal.key");
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); } catch { return null; }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size !== 32) return null;
    const key = Buffer.alloc(32);
    return readSync(fd, key, 0, 32, 0) === 32 ? key : null;
  } finally { closeSync(fd); }
}

/** Reads the key, creating folder (0700) and key (0600) on first use. A symlinked folder fails closed. */
function sealingKey(directory: string): Buffer {
  const existing = readKey(directory);
  if (existing) return existing;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!realDirectory(directory)) throw new AppError("webhook_key_unavailable", 500);
  chmodSync(directory, 0o700);
  try { lstatSync(join(directory, "seal.key")); throw new AppError("webhook_key_unavailable", 500); }
  catch (error) { if (error instanceof AppError) throw error; }
  const temporary = join(directory, `.seal.key.${randomBytes(6).toString("hex")}`);
  writeFileSync(temporary, randomBytes(32), { mode: 0o600, flag: "wx" });
  chmodSync(temporary, 0o600);
  renameSync(temporary, join(directory, "seal.key"));
  const created = readKey(directory);
  if (!created) throw new AppError("webhook_key_unavailable", 500);
  return created;
}

function seal(directory: string, routeId: string, secret: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", sealingKey(directory), iv);
  cipher.setAAD(Buffer.from(`jit.webhook_triggers.v1:${routeId}`));
  const body = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1.${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
}

/** Opens a sealed secret, or null when it was erased, the key is gone or the value does not authenticate. */
function unseal(directory: string, routeId: string, sealed: string | null): string | null {
  if (!sealed?.startsWith("v1.")) return null;
  const key = readKey(directory);
  if (!key) return null;
  try {
    const raw = Buffer.from(sealed.slice(3), "base64url");
    if (raw.length < 29) return null;
    const decipher = createDecipheriv("aes-256-gcm", key, raw.subarray(0, 12));
    decipher.setAAD(Buffer.from(`jit.webhook_triggers.v1:${routeId}`));
    decipher.setAuthTag(raw.subarray(12, 28));
    const secret = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    return secretShape.test(secret) ? secret : null;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Signature
// ---------------------------------------------------------------------------

/**
 * Verifies `X-Hub-Signature-256: sha256=<64 hex>` over the exact body bytes in constant time.
 * The key is the secret string's UTF-8 bytes, as GitHub and other HMAC senders use it.
 */
export function webhookSignatureValid(secret: string, body: Uint8Array, header: string | null): boolean {
  const match = header === null ? null : /^sha256=([a-f0-9]{64})$/i.exec(header.trim());
  const expected = createHmac("sha256", secret).update(body).digest();
  const supplied = match ? Buffer.from(match[1]!.toLowerCase(), "hex") : Buffer.alloc(32);
  // Always compare, so a missing or malformed header costs the same as a wrong one.
  return timingSafeEqual(expected, supplied) && match !== null;
}

/** The header value a sender computes; exported for tests and sender scripts. */
export function webhookSignature(secret: string, body: Uint8Array | string): string {
  return `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
}

// ---------------------------------------------------------------------------
// Read model and commands
// ---------------------------------------------------------------------------

interface TriggerRow {
  route_id: string; project_id: string; monitor_id: string; revision: number; sealed_secret: string | null;
  created_at: number; rotated_at: number | null; revoked_at: number | null;
}

function latestRow(tx: AppTransaction, projectId: string, monitorId: string): TriggerRow | null {
  return tx.get<TriggerRow>("SELECT * FROM webhook_triggers WHERE project_id = ? AND monitor_id = ? ORDER BY revision DESC LIMIT 1", projectId, monitorId) ?? null;
}

function view(monitorId: string, row: TriggerRow | null, directory: string): WebhookTriggerView {
  if (!row) return { monitorId, state: "none", routeId: null, path: null, revision: 0, createdAt: null, rotatedAt: null, deletedAt: null, secretAvailable: false };
  const active = row.revoked_at === null;
  return {
    monitorId, state: active ? "active" : "deleted", routeId: active ? row.route_id : null,
    path: active ? `${webhookPathPrefix}${row.route_id}` : null, revision: row.revision,
    createdAt: row.created_at, rotatedAt: row.rotated_at, deletedAt: row.revoked_at,
    secretAvailable: active && unseal(directory, row.route_id, row.sealed_secret) !== null,
  };
}

/** Reads the trigger of one monitor in the owner's project. */
export function readWebhookTrigger(tx: AppTransaction, projectId: string, monitorId: string, directory: string): WebhookTriggerView {
  readMonitor(tx, projectId, monitorId);
  return view(monitorId, latestRow(tx, projectId, monitorId), directory);
}

/** Applies a validated owner command inside the caller's write transaction. The receipt carries the new secret. */
export function applyWebhookCommand(tx: AppTransaction, command: WebhookCommand, now: number, directory: string): WebhookReceipt {
  webhookIdentity(command);
  const monitor = readMonitor(tx, command.projectId, command.payload.monitorId);
  const latest = latestRow(tx, command.projectId, monitor.id);
  if ((latest?.revision ?? 0) !== command.expectedRevision) throw new AppError("stale_revision", 409);
  const active = latest && latest.revoked_at === null ? latest : null;
  const revision = command.expectedRevision + 1;
  const secret = () => `jitwh_${randomBytes(32).toString("base64url")}`;
  if (command.kind === "pr.webhook.create") {
    if (monitor.state === "revoked") throw new AppError("pr_monitor_revoked", 409);
    if (active) throw new AppError("webhook_trigger_exists", 409);
    const routeId = randomBytes(16).toString("base64url"), value = secret();
    tx.run("INSERT INTO webhook_triggers (route_id, project_id, monitor_id, revision, sealed_secret, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      routeId, monitor.projectId, monitor.id, revision, seal(directory, routeId, value), now);
    return { trigger: readWebhookTrigger(tx, command.projectId, monitor.id, directory), secret: value };
  }
  if (!active) throw new AppError("webhook_trigger_not_found", 404);
  if (command.kind === "pr.webhook.rotate") {
    if (monitor.state === "revoked") throw new AppError("pr_monitor_revoked", 409);
    const value = secret();
    // The route id stays, so the sender keeps its URL; the old secret stops verifying in this transaction.
    tx.run("UPDATE webhook_triggers SET revision = ?, sealed_secret = ?, rotated_at = ? WHERE route_id = ?",
      revision, seal(directory, active.route_id, value), now, active.route_id);
    return { trigger: readWebhookTrigger(tx, command.projectId, monitor.id, directory), secret: value };
  }
  eraseTrigger(tx, active.route_id, now, revision);
  return { trigger: readWebhookTrigger(tx, command.projectId, monitor.id, directory), secret: null };
}

/** Deletes a trigger: the route stops answering, the sealed secret is erased and its receipts are dropped. */
function eraseTrigger(tx: AppTransaction, routeId: string, now: number, revision: number): void {
  tx.run("DELETE FROM webhook_receipts WHERE route_id = ?", routeId);
  tx.run("UPDATE webhook_triggers SET revision = ?, sealed_secret = NULL, revoked_at = ? WHERE route_id = ?", revision, now, routeId);
}

/** Revoked monitoring deletes its active trigger in the same transaction (called from the monitor revoke). */
export function eraseMonitorWebhooks(tx: AppTransaction, monitorId: string, now: number): void {
  if (!tx.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'webhook_triggers'")) return;
  for (const row of tx.all<{ route_id: string; revision: number }>("SELECT route_id, revision FROM webhook_triggers WHERE monitor_id = ? AND revoked_at IS NULL", monitorId)) {
    eraseTrigger(tx, row.route_id, now, row.revision + 1);
  }
}

/** True when `routeId` names an active trigger. Used before the rate counter so unknown ids open no window. */
export function webhookRouteActive(tx: AppTransaction, routeId: string): boolean {
  return !!tx.get("SELECT 1 FROM webhook_triggers WHERE route_id = ? AND revoked_at IS NULL", routeId);
}

/** One inbound delivery, after the browser, body and rate checks. The body is only hashed, never read. */
export interface WebhookDelivery { routeId: string; deliveryId: string; signature: string | null; body: Uint8Array }

/**
 * Verifies one delivery and, only when every check passes, records its delivery id and wakes the poll.
 * Any refusal throws before the first write, so the caller's transaction rolls back with no state change:
 * unknown route → 404, bad signature → 401 `signature_invalid`, paused or revoked monitor → 409, delivery id seen
 * in the last 7 days → 409 `duplicate_delivery`.
 */
export function acceptWebhookDelivery(tx: AppTransaction, delivery: WebhookDelivery, now: number, directory: string, limits: WebhookLimits = webhookLimits): { dueAt: number } {
  const row = tx.get<TriggerRow>("SELECT * FROM webhook_triggers WHERE route_id = ? AND revoked_at IS NULL", delivery.routeId);
  if (!row) throw new AppError("not_found", 404);
  const secret = unseal(directory, row.route_id, row.sealed_secret);
  if (secret === null || !webhookSignatureValid(secret, delivery.body, delivery.signature)) throw new AppError("signature_invalid", 401);
  if (!webhookDeliveryId.test(delivery.deliveryId)) throw new AppError("delivery_id_required", 400);
  const monitor = readMonitor(tx, row.project_id, row.monitor_id);
  if (monitor.state === "revoked") throw new AppError("pr_monitor_revoked", 409);
  if (monitor.state !== "active") throw new AppError("pr_monitor_not_active", 409);
  const horizon = now - limits.dedupeMs;
  if (tx.get("SELECT 1 FROM webhook_receipts WHERE route_id = ? AND delivery_id = ? AND received_at > ?", row.route_id, delivery.deliveryId, horizon)) {
    throw new AppError("duplicate_delivery", 409);
  }
  // Accepted: prune receipts past the dedupe window, record this delivery id, and move the poll earlier.
  tx.run("DELETE FROM webhook_receipts WHERE received_at <= ?", horizon);
  tx.run("INSERT INTO webhook_receipts (route_id, delivery_id, received_at) VALUES (?, ?, ?)", row.route_id, delivery.deliveryId, now);
  return { dueAt: wakeMonitorPoll(tx, monitor.projectId, monitor.id, now).after };
}

/** The monitor's next poll instant and last poll failure (a reason code) for the owner view. */
export function monitorPollDue(tx: AppTransaction, projectId: string, monitorId: string): { dueAt: number; failure: { reason: string; at: number } | null } {
  const due = readPollDue(tx, readMonitor(tx, projectId, monitorId));
  return { dueAt: due.dueAt, failure: due.failure };
}
