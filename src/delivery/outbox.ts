import { createHash } from "node:crypto";
import { AppError } from "../errors";
import { fenceDenied } from "../jobs/attempts";
import { containsCredential } from "../security/credentials";
import { commitOutputSource, requireId, requireText } from "../sources";
import type { AppTransaction } from "../store";
import { TransactionStore } from "../store";
import { upgradeFenced } from "../ops/upgrade-fence";
import { readBinding } from "../telegram/binding";
import type { DeliverySender, DeliverySendResult } from "./sender";
import type {
  CommitDeliveryCommand, DeliveryAttempt, DeliveryCommand, DeliveryIntent, DeliveryPage, DeliveryPayload,
  DeliveryReceipt, DeliveryReport, DeliveryResendReceipt, DeliveryRetireReceipt, ResendDeliveryCommand, RetireDeliveryCommand,
} from "./types";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const requestIdOk = (value: string) => /^[a-zA-Z0-9_-]{8,128}$/.test(value);
const dedupeOk = (value: string) => /^[A-Za-z0-9._:/-]{8,160}$/.test(value);
const DEFAULT_SAFE_RETRIES = 2;

/** Phases a deterministic test can interrupt after the corresponding local commit. */
export type DeliveryCrashPhase = "after_claim" | "after_remote_accept" | "before_response_commit";

/** Clock, lease and fixture sender for one local delivery worker. */
export interface DeliveryWorkerOptions {
  now?: () => number;
  pid?: number;
  isAlive?: (pid: number) => boolean;
  leaseMs?: number;
  sender: DeliverySender;
  crash?: (phase: DeliveryCrashPhase) => void;
}

interface CommitInput {
  projectId: string;
  kind: "report" | "reminder";
  text: string;
  dedupeKey: string;
  maxBytes: number;
  maxSafeRetries?: number;
  expectedProjectRevision?: number;
  /** Registered send-time currentness guard name; absent for unguarded report/reminder intents. */
  guard?: string;
}

/**
 * Verdict of a send-time currentness guard. `hold` keeps the intent waiting (for example while
 * monitoring is paused); otherwise a non-current intent is cancelled before send and marked stale.
 */
export type DeliveryCurrentness = { current: true } | { current: false; reason: string; hold?: boolean };

/** Domain recheck run inside the claim/send transaction immediately before the sender is invoked. */
export type DeliveryGuard = (tx: AppTransaction, intent: DeliveryIntent) => DeliveryCurrentness;

const guardName = /^[a-z][a-z0-9-]{0,31}$/;
const guards = new Map<string, DeliveryGuard>();

/**
 * Dedupe-key namespaces that always require their guard, including legacy intents committed before
 * the `guard` field existed. Static so the outbox fails closed even when the owning module never loaded.
 */
const RESERVED_GUARDS: ReadonlyArray<readonly [prefix: string, guard: string]> = Object.freeze([["pr-alert/", "pr-alert"] as const]);

function reservedGuard(dedupeKey: string): string | null {
  return RESERVED_GUARDS.find(([prefix]) => dedupeKey.startsWith(prefix))?.[1] ?? null;
}

/**
 * Registers the process-wide send-time currentness guard for intents committed with `guard: name`.
 * Owning domains (for example `pr.private_alerts/v1`) register at module load. Re-registering a name
 * replaces the previous check. An intent whose guard is not registered waits rather than sends.
 */
export function registerDeliveryGuard(name: string, check: DeliveryGuard): void {
  if (!guardName.test(name) || typeof check !== "function") throw new AppError("invalid_delivery_command");
  guards.set(name, check);
}

function guardVerdict(tx: AppTransaction, intent: DeliveryIntent): DeliveryCurrentness {
  const reserved = reservedGuard(intent.dedupeKey);
  // A legacy guardless intent in a reserved namespace is upgraded in memory; the next save persists it.
  if (reserved !== null && intent.guard !== reserved) intent.guard = reserved;
  const name = intent.guard ?? null;
  if (name === null) return { current: true };
  const check = guards.get(name);
  if (!check) return { current: false, reason: "currentness_unavailable", hold: true };
  try {
    const verdict = check(tx, intent);
    if (verdict?.current === true) return verdict;
    if (verdict?.current === false && typeof verdict.reason === "string" && /^[a-z0-9_]{1,64}$/.test(verdict.reason)) return verdict;
    return { current: false, reason: "currentness_unavailable", hold: true };
  } catch {
    return { current: false, reason: "currentness_unavailable", hold: true };
  }
}

function exact(value: unknown, keys: string[]): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.keys(value).every(key => keys.includes(key)) && keys.every(key => Object.hasOwn(value, key));
}

function intentOf(row: { record_json: string }): DeliveryIntent {
  return JSON.parse(row.record_json) as DeliveryIntent;
}
function attemptOf(row: { record_json: string }): DeliveryAttempt {
  return JSON.parse(row.record_json) as DeliveryAttempt;
}
function reportOf(row: { record_json: string }): DeliveryReport {
  return JSON.parse(row.record_json) as DeliveryReport;
}

function saveIntent(tx: AppTransaction, intent: DeliveryIntent): void {
  tx.run("UPDATE delivery_intents SET record_json = ? WHERE id = ?", JSON.stringify(intent), intent.id);
}
function saveAttempt(tx: AppTransaction, attempt: DeliveryAttempt): void {
  tx.run("UPDATE delivery_attempts SET record_json = ? WHERE id = ?", JSON.stringify(attempt), attempt.id);
}
function saveReport(tx: AppTransaction, report: DeliveryReport): void {
  tx.run("UPDATE delivery_reports SET record_json = ? WHERE id = ?", JSON.stringify(report), report.id);
}

/** Reads one project-scoped report. Missing rows are not treated as delivered. */
export function readDeliveryReport(tx: AppTransaction, projectId: string, reportId: string): DeliveryReport {
  requireId(projectId); requireId(reportId);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM delivery_reports WHERE id = ? AND project_id = ?", reportId, projectId);
  if (!row) throw new AppError("delivery_report_not_found", 404);
  return reportOf(row);
}

/** Reads one logical intent without sending or leasing it. */
export function readDeliveryIntent(tx: AppTransaction, projectId: string, intentId: string): DeliveryIntent {
  requireId(projectId); requireId(intentId);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE id = ? AND project_id = ?", intentId, projectId);
  if (!row) throw new AppError("delivery_not_found", 404);
  return intentOf(row);
}

/** Lists intents in commit order. This read never claims or sends. */
export function listDeliveryIntents(tx: AppTransaction, projectId: string, after: number, limit: number): DeliveryPage {
  requireId(projectId);
  if (!Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new AppError("invalid_cursor");
  const rows = tx.all<{ sequence: number; record_json: string }>(
    "SELECT sequence, record_json FROM delivery_intents WHERE project_id = ? AND sequence > ? ORDER BY sequence LIMIT ?",
    projectId, after, limit + 1);
  const page = rows.slice(0, limit);
  return { items: page.map(intentOf), hasMore: rows.length > limit, nextAfter: page.at(-1)?.sequence ?? after };
}

/** Lists fenced attempts for one intent in creation order. */
export function listDeliveryAttempts(tx: AppTransaction, intentId: string): DeliveryAttempt[] {
  requireId(intentId);
  return tx.all<{ record_json: string }>("SELECT record_json FROM delivery_attempts WHERE intent_id = ? ORDER BY sequence", intentId).map(attemptOf);
}

/**
 * Commits one report and one logical outbox intent in the caller's transaction.
 * The same dedupe key returns the existing intent. Rollback removes both the report and the intent.
 * `delivery.outbox/v1` — local dedupe only; this function does not send and does not claim exactly-once delivery.
 */
export function commitDeliveryIntent(tx: AppTransaction, input: CommitInput, now: number): DeliveryReceipt {
  requireId(input.projectId);
  if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_commit_time");
  if (input.kind !== "report" && input.kind !== "reminder") throw new AppError("invalid_delivery_command");
  if (!dedupeOk(input.dedupeKey)) throw new AppError("invalid_delivery_command");
  requireText(input.text, input.maxBytes);
  if (containsCredential(input.text) || containsCredential(input.dedupeKey)) throw new AppError("invalid_delivery_payload");
  if (input.guard !== undefined && !guardName.test(input.guard)) throw new AppError("invalid_delivery_command");
  const reserved = reservedGuard(input.dedupeKey);
  if (reserved !== null && input.guard !== reserved) throw new AppError("invalid_delivery_command");
  const retries = input.maxSafeRetries ?? DEFAULT_SAFE_RETRIES;
  if (!Number.isSafeInteger(retries) || retries < 0 || retries > 5) throw new AppError("invalid_delivery_command");
  const project = tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", input.projectId);
  if (!project) throw new AppError("project_not_found", 404);
  if (input.expectedProjectRevision !== undefined && project.revision !== input.expectedProjectRevision) throw new AppError("stale_revision", 409);
  const existing = tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE dedupe_key = ?", input.dedupeKey);
  if (existing) {
    const intent = intentOf(existing);
    if (intent.projectId !== input.projectId || intent.payload.kind !== input.kind || intent.payload.text !== input.text) {
      throw new AppError("delivery_dedupe_conflict", 409);
    }
    return { intent, report: readDeliveryReport(tx, input.projectId, intent.provenance.reportId), created: false };
  }
  const owner = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'");
  if (!owner) throw new AppError("owner_not_configured", 409);
  const binding = readBinding(tx);
  const bound = binding.state === "bound" && binding.telegramChatId !== null;
  const reportId = crypto.randomUUID();
  const source = commitOutputSource(tx, { projectId: input.projectId, participantId: "delivery", runId: reportId, text: input.text, committedAt: now });
  const report: DeliveryReport = {
    id: reportId, projectId: input.projectId, kind: input.kind, revision: 1, generation: 1, availability: "available",
    text: input.text, sourceId: source.sourceId, sourceRevision: source.revision, sourceGeneration: source.generation, committedAt: now,
  };
  tx.run("INSERT INTO delivery_reports VALUES (?, ?, ?)", report.id, report.projectId, JSON.stringify(report));
  const payload: DeliveryPayload = {
    kind: input.kind, text: input.text,
    reference: { reportId, revision: 1, generation: 1, sourceId: source.sourceId, sourceRevision: source.revision, sourceGeneration: source.generation },
  };
  const intent: DeliveryIntent = {
    id: crypto.randomUUID(), dedupeKey: input.dedupeKey, projectId: input.projectId, ownerId: "owner", channel: "telegram",
    authorityGeneration: owner.generation, inputGeneration: 1, bindingRevision: bound ? binding.revision : null,
    guard: input.guard ?? null,
    payload, provenance: {
      reportId, reportRevision: 1, reportGeneration: 1, sourceId: source.sourceId, sourceRevision: source.revision,
      sourceGeneration: source.generation, committedAt: now, authorityGeneration: owner.generation, inputGeneration: 1,
    },
    status: bound ? "queued" : "waiting", remote: "none", guarantee: "local_dedupe_only", failureReason: null,
    nextAction: bound ? "wait_for_delivery" : "wait_for_channel_binding", messageRef: null, stale: false, staleReason: null,
    revision: 1, attemptGeneration: 0, settledGeneration: null, safeRetriesRemaining: retries, retryable: false,
    createdAt: now, updatedAt: now,
  };
  tx.run("INSERT INTO delivery_intents (id, dedupe_key, project_id, record_json) VALUES (?, ?, ?, ?)", intent.id, intent.dedupeKey, intent.projectId, JSON.stringify(intent));
  return { intent, report, created: true };
}

function cancelUnsent(tx: AppTransaction, intent: DeliveryIntent, reason: string, now: number, stale = false): boolean {
  // Terminal transport outcomes stay recorded: a known rejection is never rewritten as "never sent".
  if (intent.status === "sent" || intent.status === "unknown" || intent.status === "failed") return false;
  const attempts = listDeliveryAttempts(tx, intent.id);
  if (attempts.some(attempt => attempt.senderInvoked && attempt.outcome === "none")) return false;
  for (const attempt of attempts) {
    if (attempt.outcome === "none" && attempt.state !== "interrupted") {
      attempt.state = "interrupted"; attempt.reason = reason; saveAttempt(tx, attempt);
    }
  }
  intent.status = "cancelled"; intent.failureReason = reason; intent.nextAction = "inspect_cancelled_intent";
  intent.retryable = false; intent.remote = "none"; intent.revision += 1; intent.updatedAt = now;
  if (stale) { intent.stale = true; intent.staleReason = reason; }
  saveIntent(tx, intent);
  return true;
}

/**
 * Quarantine-only: rewrites the stored text of one legacy `pr-alert/` intent with `scrub` (`redactCredentials`) across the
 * intent payload, its delivery report and the report's source version, inside the caller's
 * transaction. Status, remote outcome, attempts and failure reasons are left untouched. The passed
 * `intent` object is updated in place so a caller holding it saves the scrubbed text. Returns
 * whether anything changed.
 */
export function scrubDeliveryIntentText(tx: AppTransaction, intent: DeliveryIntent, scrub: (text: string) => string): boolean {
  let changed = false;
  const text = scrub(intent.payload.text);
  if (text !== intent.payload.text) {
    intent.payload = { ...intent.payload, text };
    saveIntent(tx, intent);
    changed = true;
  }
  let report: DeliveryReport | null = null;
  try { report = readDeliveryReport(tx, intent.projectId, intent.provenance.reportId); } catch { report = null; }
  if (report) {
    const reportText = scrub(report.text);
    if (reportText !== report.text) { report.text = reportText; saveReport(tx, report); changed = true; }
    // In-place source rewrite applies only to quarantined legacy pr-alert intents (PR03); no other caller may use it.
    const version = tx.get<{ text: string | null }>("SELECT content_text AS text FROM source_versions WHERE source_id = ? AND revision = ? AND generation = ?",
      report.sourceId, report.sourceRevision, report.sourceGeneration);
    if (version?.text) {
      const sourceText = scrub(version.text);
      if (sourceText !== version.text) {
        tx.run("UPDATE source_versions SET content_text = ? WHERE source_id = ? AND revision = ? AND generation = ?",
          sourceText, report.sourceId, report.sourceRevision, report.sourceGeneration);
        changed = true;
      }
    }
  }
  return changed;
}

/**
 * Retires one logical intent because its domain source is no longer current.
 * Unsent work is cancelled and marked stale with `reason`. With `markSettledStale`, an intent that
 * already has a sent/unknown/failed outcome stays recorded but is marked visibly stale; an in-flight
 * send is left for `recordDeliveryResult`, whose guard recheck marks the landed result stale.
 * This never claims a remote message was withdrawn.
 */
export function retireDeliveryIntent(
  tx: AppTransaction, projectId: string, intentId: string, reason: string, now: number,
  options: { markSettledStale: boolean },
): "cancelled" | "marked_stale" | "unchanged" {
  if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_commit_time");
  if (!/^[a-z0-9_]{1,64}$/.test(reason)) throw new AppError("invalid_delivery_command");
  const intent = readDeliveryIntent(tx, projectId, intentId);
  if (intent.status === "cancelled") return "unchanged";
  if (cancelUnsent(tx, intent, reason, now, true)) return "cancelled";
  if (!options.markSettledStale || intent.stale) return "unchanged";
  if (!["sent", "unknown", "failed"].includes(intent.status)) return "unchanged";
  intent.stale = true; intent.staleReason = reason; intent.revision += 1; intent.updatedAt = now;
  saveIntent(tx, intent);
  return "marked_stale";
}

/**
 * Cancels every unsent intent committed by one configured schedule.
 * Intents already accepted remotely or with an in-flight sender stay recorded; revocation
 * never claims an external send was withdrawn. Used by `jobs.configured_schedules/v1`
 * revoke/edit fencing inside the same owner transaction that fences schedule attempts.
 */
export function cancelScheduleIntents(tx: AppTransaction, scheduleId: string, reason: string, now: number): string[] {
  if (typeof scheduleId !== "string" || !/^[a-f0-9-]{36}$/.test(scheduleId)) throw new AppError("invalid_schedule_command");
  if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_commit_time");
  const cancelled: string[] = [];
  for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE dedupe_key LIKE 'schedule/' || ? || '/%' ORDER BY sequence", scheduleId)) {
    const intent = intentOf(row);
    if (cancelUnsent(tx, intent, reason, now)) cancelled.push(intent.id);
  }
  return cancelled;
}

/**
 * Marks a report superseded or deleted and cancels intents that have not invoked the sender.
 * A send already accepted remotely stays recorded. This does not claim the remote message was withdrawn.
 */
export function retireDeliveryReport(tx: AppTransaction, projectId: string, reportId: string, action: "supersede" | "delete", expectedRevision: number, now: number): DeliveryRetireReceipt {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(expectedRevision)) throw new AppError("invalid_delivery_command");
  const report = readDeliveryReport(tx, projectId, reportId);
  if (report.revision !== expectedRevision) throw new AppError("stale_revision", 409);
  if (report.availability !== "available") throw new AppError("delivery_report_not_current", 409);
  report.availability = action === "delete" ? "deleted" : "superseded";
  report.revision += 1;
  saveReport(tx, report);
  if (action === "delete") tx.run("UPDATE sources SET availability = 'unavailable' WHERE id = ? AND project_id = ?", report.sourceId, projectId);
  const cancelledIntentIds: string[] = [];
  for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE project_id = ? ORDER BY sequence", projectId)) {
    const intent = intentOf(row);
    if (intent.provenance.reportId !== reportId) continue;
    if (cancelUnsent(tx, intent, action === "delete" ? "source_deleted" : "source_superseded", now)) cancelledIntentIds.push(intent.id);
  }
  return { report, cancelledIntentIds };
}

/**
 * Authorizes one new delivery attempt for an intent that already has a terminal or uncertain outcome.
 * The receipt warns that a duplicate external message is possible. This does not send by itself.
 */
export function resendDeliveryIntent(tx: AppTransaction, projectId: string, intentId: string, expectedRevision: number, now: number): DeliveryResendReceipt {
  if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_delivery_command");
  const intent = readDeliveryIntent(tx, projectId, intentId);
  if (intent.revision !== expectedRevision) throw new AppError("stale_revision", 409);
  if (!["failed", "unknown", "sent"].includes(intent.status)) throw new AppError("delivery_not_resendable", 409);
  const previous = listDeliveryAttempts(tx, intent.id).at(-1) ?? null;
  const owner = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'");
  if (!owner || owner.generation !== intent.authorityGeneration) throw new AppError("authorization_changed", 409);
  const report = readDeliveryReport(tx, projectId, intent.provenance.reportId);
  if (report.availability !== "available") throw new AppError("delivery_report_not_current", 409);
  intent.attemptGeneration += 1;
  const attempt: DeliveryAttempt = {
    id: crypto.randomUUID(), intentId: intent.id, generation: intent.attemptGeneration, scheduler: "",
    leaseUntil: 0, deadlineAt: 0, ownerGeneration: owner.generation, bindingRevision: null,
    state: "authorized", senderInvoked: false, outcome: "none", reason: null, messageRef: null, chatId: null, stale: false,
    linkedFrom: previous?.id ?? null, createdAt: now,
  };
  tx.run("INSERT INTO delivery_attempts (id, intent_id, record_json) VALUES (?, ?, ?)", attempt.id, attempt.intentId, JSON.stringify(attempt));
  intent.status = "queued"; intent.remote = "none"; intent.retryable = false; intent.nextAction = "wait_for_delivery";
  intent.failureReason = null; intent.revision += 1; intent.updatedAt = now;
  saveIntent(tx, intent);
  return { intent, attempt, warning: "duplicates_possible" };
}

/** Canonical identity for delivery command receipts. Extra fields are rejected rather than ignored. */
export function deliveryCommandIdentity(command: DeliveryCommand, maxBytes: number): string {
  if (!exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) || !requestIdOk(command.requestId) ||
      !/^[a-f0-9-]{36}$/.test(command.projectId) || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
    throw new AppError("invalid_delivery_command");
  }
  if (command.kind === "delivery.commit") {
    if (!exact(command.payload, ["kind", "text", "dedupeKey"])) throw new AppError("invalid_delivery_command");
    requireText(command.payload.text, maxBytes);
    if (command.payload.kind !== "report" && command.payload.kind !== "reminder") throw new AppError("invalid_delivery_command");
    if (!dedupeOk(command.payload.dedupeKey)) throw new AppError("invalid_delivery_command");
    return digest(JSON.stringify([command.kind, command.projectId, command.expectedRevision, command.payload.kind, command.payload.text, command.payload.dedupeKey]));
  }
  if (command.kind === "delivery.resend") {
    if (!exact(command.payload, ["intentId"]) || !/^[a-f0-9-]{36}$/.test(command.payload.intentId)) throw new AppError("invalid_delivery_command");
    return digest(JSON.stringify([command.kind, command.projectId, command.expectedRevision, command.payload.intentId]));
  }
  if (command.kind === "delivery.retire") {
    if (!exact(command.payload, ["reportId", "action"]) || !/^[a-f0-9-]{36}$/.test(command.payload.reportId) ||
        !["supersede", "delete"].includes(command.payload.action)) throw new AppError("invalid_delivery_command");
    return digest(JSON.stringify([command.kind, command.projectId, command.expectedRevision, command.payload.reportId, command.payload.action]));
  }
  throw new AppError("invalid_delivery_command");
}

type GateDecision = { ok: true; chatId: number; bindingRevision: number } | { ok: false; reason: string; wait: boolean; stale?: boolean; nextAction?: string };

function gate(tx: AppTransaction, intent: DeliveryIntent): GateDecision {
  const owner = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation ?? null;
  if (owner !== intent.authorityGeneration) return { ok: false, reason: "authorization_changed", wait: false };
  let report: DeliveryReport;
  try { report = readDeliveryReport(tx, intent.projectId, intent.provenance.reportId); }
  catch { return { ok: false, reason: "source_deleted", wait: false }; }
  if (report.availability === "superseded") return { ok: false, reason: "source_superseded", wait: false };
  if (report.availability !== "available") return { ok: false, reason: "source_deleted", wait: false };
  const source = tx.get<{ availability: string }>("SELECT availability FROM sources WHERE id = ? AND project_id = ?", report.sourceId, intent.projectId);
  if (source?.availability !== "available") return { ok: false, reason: "source_deleted", wait: false };
  // Domain currentness runs before the channel check so a stale intent is retired even while unbound.
  const verdict = guardVerdict(tx, intent);
  if (!verdict.current) {
    return verdict.hold
      ? { ok: false, reason: verdict.reason, wait: true, nextAction: "wait_for_current_source" }
      : { ok: false, reason: verdict.reason, wait: false, stale: true };
  }
  const binding = readBinding(tx);
  if (binding.state !== "bound" || binding.telegramChatId === null) {
    return intent.bindingRevision === null
      ? { ok: false, reason: "not_bound", wait: true }
      : { ok: false, reason: "binding_revoked", wait: false };
  }
  if (intent.bindingRevision !== null && binding.revision !== intent.bindingRevision) return { ok: false, reason: "binding_revoked", wait: false };
  return { ok: true, chatId: binding.telegramChatId, bindingRevision: binding.revision };
}

function staleReason(tx: AppTransaction, intent: DeliveryIntent, attempt: DeliveryAttempt): string | null {
  const owner = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation ?? null;
  if (owner !== attempt.ownerGeneration) return "authorization_changed";
  try {
    const report = readDeliveryReport(tx, intent.projectId, intent.provenance.reportId);
    if (report.availability === "superseded") return "source_superseded";
    if (report.availability !== "available") return "source_deleted";
  } catch { return "source_deleted"; }
  const binding = readBinding(tx);
  if (attempt.bindingRevision !== null && (binding.state !== "bound" || binding.revision !== attempt.bindingRevision)) return "binding_revoked";
  const verdict = guardVerdict(tx, intent);
  if (!verdict.current) return verdict.reason;
  return null;
}

/**
 * Applies a transport result for one attempt.
 * A newer settled generation is left as-is. Revoke or supersede during the send keeps the actual or unknown outcome and marks it stale.
 */
export function recordDeliveryResult(tx: AppTransaction, attemptId: string, result: DeliverySendResult, now: number): DeliveryIntent {
  requireId(attemptId);
  if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_commit_time");
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM delivery_attempts WHERE id = ?", attemptId);
  if (!row) throw new AppError("delivery_attempt_not_found", 404);
  const attempt = attemptOf(row);
  const intent = readDeliveryIntent(tx, tx.get<{ project_id: string }>("SELECT project_id FROM delivery_intents WHERE id = ?", attempt.intentId)!.project_id, attempt.intentId);
  if (attempt.outcome !== "none") return intent;
  if (intent.settledGeneration !== null && intent.settledGeneration > attempt.generation) {
    attempt.state = "interrupted"; attempt.reason = "stale_result"; saveAttempt(tx, attempt);
    return readDeliveryIntent(tx, intent.projectId, intent.id);
  }
  const stale = staleReason(tx, intent, attempt);
  let outcome: DeliveryAttempt["outcome"] = "unknown";
  let reason: string | null = "unknown_transport";
  let remote: DeliveryIntent["remote"] = "uncertain";
  let status: DeliveryIntent["status"] = "unknown";
  let nextAction = "inspect_unknown_then_explicit_resend";
  let messageRef: DeliveryIntent["messageRef"] = null;
  let retryable = false;
  if (result.outcome === "sent" && Number.isSafeInteger(result.messageId) && result.messageId > 0 && attempt.chatId !== null) {
    outcome = "sent"; reason = null; remote = "accepted"; status = "sent"; nextAction = "inspect_sent_message";
    messageRef = { chatId: attempt.chatId, messageId: result.messageId };
  } else if (result.outcome === "failed" && (result.reason === "telegram_rejected" || result.reason === "telegram_unavailable")) {
    outcome = "failed"; reason = result.reason; remote = "rejected"; status = "failed"; nextAction = "inspect_failure";
    retryable = result.retryable === true && result.reason === "telegram_unavailable" && stale === null;
  }
  attempt.state = "settled"; attempt.outcome = outcome; attempt.reason = reason; attempt.messageRef = messageRef; attempt.stale = stale !== null;
  saveAttempt(tx, attempt);
  if (retryable) intent.safeRetriesRemaining = Math.max(0, intent.safeRetriesRemaining - 1);
  const retry = retryable && intent.safeRetriesRemaining > 0;
  if (retry) {
    intent.status = "queued"; intent.remote = "none"; intent.failureReason = null; intent.nextAction = "wait_for_delivery"; intent.retryable = true;
  } else {
    intent.status = status; intent.remote = remote; intent.failureReason = reason; intent.messageRef = messageRef; intent.retryable = false;
    intent.nextAction = outcome === "failed" && result.outcome === "failed" && result.retryable === true && intent.safeRetriesRemaining === 0 ? "safe_retry_limit_reached" : nextAction;
  }
  intent.stale = stale !== null; intent.staleReason = stale;
  intent.settledGeneration = attempt.generation; intent.revision += 1; intent.updatedAt = now;
  saveIntent(tx, intent);
  return readDeliveryIntent(tx, intent.projectId, intent.id);
}

/**
 * One local worker that claims fenced delivery attempts and records honest send outcomes.
 * Unknown results stay visible and are not retried. Safe failures retry only while the intent's remaining budget allows it.
 */
export class DeliveryWorker {
  #token = crypto.randomUUID();
  #pid: number;
  #now: () => number;
  #leaseMs: number;
  #closed = false;
  #sender: DeliverySender;
  #crash?: DeliveryWorkerOptions["crash"];

  constructor(readonly store: TransactionStore, options: DeliveryWorkerOptions) {
    this.#pid = options.pid ?? process.pid;
    if (!Number.isSafeInteger(this.#pid) || this.#pid < 1 || this.#pid > 2_147_483_647) throw new AppError("invalid_delivery_command");
    this.#now = options.now ?? Date.now;
    this.#leaseMs = options.leaseMs ?? 60_000;
    if (!Number.isSafeInteger(this.#leaseMs) || this.#leaseMs < 1 || this.#leaseMs > 3_600_000) throw new AppError("invalid_delivery_command");
    if (typeof options.sender?.send !== "function") throw new AppError("invalid_delivery_command");
    this.#sender = options.sender;
    this.#crash = options.crash;
    const alive = options.isAlive ?? ((pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } });
    this.store.transaction(tx => {
      const owner = tx.get<{ token: string; pid: number }>("SELECT token, pid FROM delivery_worker WHERE id = 1");
      if (owner && alive(owner.pid)) throw new AppError("delivery_worker_unavailable", 503);
      tx.run("INSERT OR REPLACE INTO delivery_worker VALUES (1, ?, ?)", this.#token, this.#pid);
      this.#reconcile(tx);
    });
  }

  /** Drops this worker's lease ownership so a later process can reconcile attempts. */
  close(): void {
    this.#closed = true;
    this.store.transaction(tx => {
      if (tx.get<{ token: string }>("SELECT token FROM delivery_worker WHERE id = 1")?.token === this.#token) {
        tx.run("DELETE FROM delivery_worker WHERE id = 1");
      }
    });
  }

  /**
   * Claims at most one ready intent. A second call while that lease is held returns null.
   * Unbound channels stay waiting. Revoked bindings and deleted sources cancel unsent work.
   */
  claimNext(): DeliveryAttempt | null {
    // Delivery stays disabled while an ops.schema_migrations/v1 upgrade holds the fence.
    if (upgradeFenced(this.store.path)) return null;
    return this.store.transaction(tx => this.#claim(tx));
  }

  /**
   * Sends one claimed attempt. The sender is invoked only after `senderInvoked` commits.
   * A crash after that point reopens as unknown. A crash before it can be claimed again.
   */
  sendClaimed(attemptId: string): DeliveryIntent {
    requireId(attemptId);
    // Never invoke the sender under an upgrade fence; the claim stays retryable.
    if (upgradeFenced(this.store.path)) throw new AppError("upgrade_in_progress", 409);
    const prepared = this.store.transaction(tx => {
      if (this.#closed || !this.#owns(tx)) throw new AppError("delivery_worker_unavailable", 503);
      const row = tx.get<{ record_json: string }>("SELECT record_json FROM delivery_attempts WHERE id = ?", attemptId);
      if (!row) throw new AppError("delivery_attempt_not_found", 404);
      const attempt = attemptOf(row);
      const intent = readDeliveryIntent(tx, tx.get<{ project_id: string }>("SELECT project_id FROM delivery_intents WHERE id = ?", attempt.intentId)!.project_id, attempt.intentId);
      if (attempt.senderInvoked || attempt.state !== "claimed" || attempt.scheduler !== this.#token) throw new AppError("delivery_attempt_not_claimed", 409);
      const decision = gate(tx, intent);
      if (!decision.ok) {
        if (decision.wait) {
          intent.status = "waiting"; intent.nextAction = decision.nextAction ?? "wait_for_channel_binding"; intent.updatedAt = this.#time(); saveIntent(tx, intent);
        } else cancelUnsent(tx, intent, decision.reason, this.#time(), decision.stale === true);
        return null;
      }
      attempt.senderInvoked = true; attempt.state = "sending"; attempt.bindingRevision = decision.bindingRevision; attempt.chatId = decision.chatId;
      saveAttempt(tx, attempt);
      intent.status = "claimed"; intent.updatedAt = this.#time(); saveIntent(tx, intent);
      return { attempt, chatId: decision.chatId, text: intent.payload.text, dedupeKey: intent.dedupeKey };
    });
    if (!prepared) return this.#readAttemptIntent(attemptId);
    let result: DeliverySendResult;
    try { result = this.#sender.send({ chatId: prepared.chatId, text: prepared.text, dedupeKey: prepared.dedupeKey }); }
    catch { result = { outcome: "unknown" }; }
    this.#crash?.("after_remote_accept");
    return this.store.transaction(tx => {
      this.#crash?.("before_response_commit");
      return recordDeliveryResult(tx, prepared.attempt.id, result, this.#time());
    });
  }

  /** Claims and sends until no ready intent remains, bounded so a safe retry cannot loop without a budget. */
  pump(): DeliveryIntent[] {
    const results: DeliveryIntent[] = [];
    for (let count = 0; count < 32; count += 1) {
      const attempt = this.claimNext();
      if (!attempt) return results;
      this.#crash?.("after_claim");
      results.push(this.sendClaimed(attempt.id));
    }
    return results;
  }

  #readAttemptIntent(attemptId: string): DeliveryIntent {
    return this.store.read(tx => {
      const attempt = attemptOf(tx.get<{ record_json: string }>("SELECT record_json FROM delivery_attempts WHERE id = ?", attemptId)!);
      const projectId = tx.get<{ project_id: string }>("SELECT project_id FROM delivery_intents WHERE id = ?", attempt.intentId)!.project_id;
      return readDeliveryIntent(tx, projectId, attempt.intentId);
    });
  }

  #claim(tx: AppTransaction): DeliveryAttempt | null {
    if (this.#closed || !this.#owns(tx)) return null;
    const now = this.#time();
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM delivery_intents ORDER BY sequence")) {
      const intent = intentOf(row);
      const attempts = listDeliveryAttempts(tx, intent.id);
      const active = [...attempts].reverse().find(attempt => attempt.outcome === "none" && attempt.state !== "interrupted");
      if (active?.senderInvoked) continue;
      if (active && active.state === "claimed") {
        const denied = fenceDenied({
          state: active.state, activeStates: ["claimed", "sending"], scheduler: active.scheduler, currentScheduler: this.#token,
          generation: active.generation, authorityGeneration: intent.attemptGeneration, ownerGeneration: active.ownerGeneration,
          currentOwnerGeneration: tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation ?? null,
          now, leaseUntil: active.leaseUntil, deadlineAt: active.deadlineAt,
        });
        if (!denied) continue;
        active.state = "interrupted"; active.reason = denied; saveAttempt(tx, active);
        if (intent.status === "claimed") { intent.status = "queued"; intent.nextAction = "wait_for_delivery"; intent.updatedAt = now; saveIntent(tx, intent); }
      }
      if (!["queued", "waiting", "failed"].includes(intent.status) && active?.state !== "authorized") continue;
      if (intent.status === "failed" && !intent.retryable) continue;
      const decision = gate(tx, intent);
      if (!decision.ok) {
        if (decision.wait) {
          const nextAction = decision.nextAction ?? "wait_for_channel_binding";
          if (intent.status !== "waiting" || intent.nextAction !== nextAction) {
            intent.status = "waiting"; intent.nextAction = nextAction; intent.updatedAt = now; saveIntent(tx, intent);
          }
          continue;
        }
        cancelUnsent(tx, intent, decision.reason, now, decision.stale === true);
        continue;
      }
      const ownerGeneration = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")!.generation;
      let attempt = active?.state === "authorized" ? active : null;
      if (!attempt) {
        intent.attemptGeneration += 1;
        attempt = {
          id: crypto.randomUUID(), intentId: intent.id, generation: intent.attemptGeneration, scheduler: this.#token,
          leaseUntil: now + this.#leaseMs, deadlineAt: now + this.#leaseMs, ownerGeneration, bindingRevision: decision.bindingRevision,
          state: "claimed", senderInvoked: false, outcome: "none", reason: null, messageRef: null, chatId: null, stale: false, linkedFrom: null, createdAt: now,
        };
        tx.run("INSERT INTO delivery_attempts (id, intent_id, record_json) VALUES (?, ?, ?)", attempt.id, attempt.intentId, JSON.stringify(attempt));
      } else {
        attempt.scheduler = this.#token; attempt.leaseUntil = now + this.#leaseMs; attempt.deadlineAt = now + this.#leaseMs;
        attempt.ownerGeneration = ownerGeneration; attempt.bindingRevision = decision.bindingRevision; attempt.state = "claimed";
        saveAttempt(tx, attempt);
      }
      intent.status = "claimed"; intent.nextAction = "wait_for_delivery"; intent.updatedAt = now; saveIntent(tx, intent);
      return attempt;
    }
    return null;
  }

  #reconcile(tx: AppTransaction): void {
    const now = this.#time();
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM delivery_attempts ORDER BY sequence")) {
      const attempt = attemptOf(row);
      if (attempt.outcome !== "none" || attempt.state === "interrupted" || attempt.state === "authorized") continue;
      const projectId = tx.get<{ project_id: string }>("SELECT project_id FROM delivery_intents WHERE id = ?", attempt.intentId)?.project_id;
      if (!projectId) continue;
      const intent = readDeliveryIntent(tx, projectId, attempt.intentId);
      if (attempt.senderInvoked) {
        if (intent.settledGeneration !== null && intent.settledGeneration > attempt.generation) {
          attempt.state = "interrupted"; attempt.reason = "stale_result"; saveAttempt(tx, attempt); continue;
        }
        recordDeliveryResult(tx, attempt.id, { outcome: "unknown" }, now);
        continue;
      }
      attempt.state = "interrupted"; attempt.reason = "interrupted"; saveAttempt(tx, attempt);
      if (intent.status === "claimed" && (intent.settledGeneration === null || intent.settledGeneration < attempt.generation)) {
        intent.status = "queued"; intent.nextAction = "wait_for_delivery"; intent.updatedAt = now; saveIntent(tx, intent);
      }
    }
  }

  #owns(tx: AppTransaction): boolean {
    return tx.get<{ token: string }>("SELECT token FROM delivery_worker WHERE id = 1")?.token === this.#token;
  }
  #time(): number {
    const now = this.#now();
    if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_commit_time");
    return now;
  }
}

export type { CommitDeliveryCommand, ResendDeliveryCommand, RetireDeliveryCommand };
