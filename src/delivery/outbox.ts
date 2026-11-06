import { createHash } from "node:crypto";
import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import { redactRegisteredSecrets } from "../security/secret-fingerprints";
import { commitOutputSource, requireId, requireText } from "../sources";
import type { AppTransaction } from "../store";
import type {
  CommitDeliveryCommand, DeliveryAttention, DeliveryAttempt, DeliveryCommand, DeliveryIntent, DeliveryPage, DeliveryPayload,
  DeliveryReceipt, DeliveryReport, DeliveryResolution, DeliveryRetireReceipt, RetireDeliveryCommand,
} from "./types";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const requestIdOk = (value: string) => /^[a-zA-Z0-9_-]{8,128}$/.test(value);
const dedupeOk = (value: string) => /^[A-Za-z0-9._:/-]{8,160}$/.test(value);

interface CommitInput {
  projectId: string;
  kind: "report" | "reminder";
  text: string;
  dedupeKey: string;
  maxBytes: number;
  expectedProjectRevision?: number;
  /** Domain guard name stored on the intent (for example `pr-alert`); absent for unguarded report/reminder intents. */
  guard?: string;
  /** delivery.attention_levels/v1 classification stored on the intent (identities only). */
  attention?: DeliveryAttention;
}

const attentionItem = /^[a-z][a-z-]{0,23}:[a-z0-9:-]{1,100}$/;
function validAttention(value: DeliveryAttention): boolean {
  return !!value && typeof value === "object" && Object.keys(value).sort().join(",") === "class,item,workGroupId" &&
    (value.class === "needs_owner" || value.class === "informational") &&
    (value.item === null || (typeof value.item === "string" && attentionItem.test(value.item))) &&
    (value.workGroupId === null || (typeof value.workGroupId === "string" && /^[a-f0-9-]{36}$/.test(value.workGroupId)));
}

const guardName = /^[a-z][a-z0-9-]{0,31}$/;

/** Dedupe-key namespaces that always require their guard name on commit. */
const RESERVED_GUARDS: ReadonlyArray<readonly [prefix: string, guard: string]> = Object.freeze([["pr-alert/", "pr-alert"] as const]);

function reservedGuard(dedupeKey: string): string | null {
  return RESERVED_GUARDS.find(([prefix]) => dedupeKey.startsWith(prefix))?.[1] ?? null;
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
 * `delivery.outbox/v1` — local dedupe only. The intent is an in-app notice: nothing in this runtime sends it.
 */
export function commitDeliveryIntent(tx: AppTransaction, input: CommitInput, now: number): DeliveryReceipt {
  requireId(input.projectId);
  if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_commit_time");
  if (input.kind !== "report" && input.kind !== "reminder") throw new AppError("invalid_delivery_command");
  if (!dedupeOk(input.dedupeKey)) throw new AppError("invalid_delivery_command");
  // app.connections/v1: a stored connection value echoed in the text is redacted before anything is committed or sent.
  const text = redactRegisteredSecrets(input.text);
  requireText(text, input.maxBytes);
  if (containsCredential(text) || containsCredential(input.dedupeKey)) throw new AppError("invalid_delivery_payload");
  if (input.guard !== undefined && !guardName.test(input.guard)) throw new AppError("invalid_delivery_command");
  const reserved = reservedGuard(input.dedupeKey);
  if (reserved !== null && input.guard !== reserved) throw new AppError("invalid_delivery_command");
  if (input.attention !== undefined && !validAttention(input.attention)) throw new AppError("invalid_delivery_command");
  const project = tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", input.projectId);
  if (!project) throw new AppError("project_not_found", 404);
  if (input.expectedProjectRevision !== undefined && project.revision !== input.expectedProjectRevision) throw new AppError("stale_revision", 409);
  const existing = tx.get<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE dedupe_key = ?", input.dedupeKey);
  if (existing) {
    const intent = intentOf(existing);
    if (intent.projectId !== input.projectId || intent.payload.kind !== input.kind || intent.payload.text !== text) {
      throw new AppError("delivery_dedupe_conflict", 409);
    }
    return { intent, report: readDeliveryReport(tx, input.projectId, intent.provenance.reportId), created: false };
  }
  const owner = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'");
  if (!owner) throw new AppError("owner_not_configured", 409);
  const reportId = crypto.randomUUID();
  const source = commitOutputSource(tx, { projectId: input.projectId, participantId: "delivery", runId: reportId, text, committedAt: now });
  const report: DeliveryReport = {
    id: reportId, projectId: input.projectId, kind: input.kind, revision: 1, generation: 1, availability: "available",
    text, sourceId: source.sourceId, sourceRevision: source.revision, sourceGeneration: source.generation, committedAt: now,
  };
  tx.run("INSERT INTO delivery_reports VALUES (?, ?, ?)", report.id, report.projectId, JSON.stringify(report));
  const payload: DeliveryPayload = {
    kind: input.kind, text,
    reference: { reportId, revision: 1, generation: 1, sourceId: source.sourceId, sourceRevision: source.revision, sourceGeneration: source.generation },
  };
  const intent: DeliveryIntent = {
    id: crypto.randomUUID(), dedupeKey: input.dedupeKey, projectId: input.projectId, ownerId: "owner",
    authorityGeneration: owner.generation, inputGeneration: 1,
    guard: input.guard ?? null,
    ...(input.attention ? { attention: { ...input.attention }, resolution: null } : {}),
    payload, provenance: {
      reportId, reportRevision: 1, reportGeneration: 1, sourceId: source.sourceId, sourceRevision: source.revision,
      sourceGeneration: source.generation, committedAt: now, authorityGeneration: owner.generation, inputGeneration: 1,
    },
    // ADR 0085: there is no push transport in this runtime. The intent is a durable in-app notice and is never sent.
    status: "waiting", remote: "none", guarantee: "local_dedupe_only", failureReason: null,
    nextAction: "in_app_only", messageRef: null, stale: false, staleReason: null, revision: 1,
    createdAt: now, updatedAt: now,
  };
  tx.run("INSERT INTO delivery_intents (id, dedupe_key, project_id, record_json) VALUES (?, ?, ?, ?)", intent.id, intent.dedupeKey, intent.projectId, JSON.stringify(intent));
  return { intent, report, created: true };
}

function cancelUnsent(tx: AppTransaction, intent: DeliveryIntent, reason: string, now: number, stale = false): boolean {
  // Outcomes recorded by the removed push transport stay recorded: a known rejection is never rewritten as "never sent",
  // and a legacy attempt that had already invoked the sender keeps its unknown outcome.
  if (intent.status === "sent" || intent.status === "unknown" || intent.status === "failed") return false;
  const attempts = listDeliveryAttempts(tx, intent.id);
  if (attempts.some(attempt => attempt.senderInvoked && attempt.outcome === "none")) return false;
  for (const attempt of attempts) {
    if (attempt.outcome === "none" && attempt.state !== "interrupted") {
      attempt.state = "interrupted"; attempt.reason = reason; saveAttempt(tx, attempt);
    }
  }
  intent.status = "cancelled"; intent.failureReason = reason; intent.nextAction = "inspect_cancelled_intent";
  intent.remote = "none"; intent.revision += 1; intent.updatedAt = now;
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
 * already has a legacy sent/unknown/failed outcome stays recorded but is marked visibly stale.
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
 * delivery.attention_levels/v1: the item one intent stood for stopped waiting on the owner (the owner answered from
 * any channel, or the item closed by itself). Unsent work is cancelled with `reason`; a legacy intent whose send
 * already reached the removed transport (sent, unknown, failed, or in flight) keeps its outcome and is marked
 * resolved. This never claims a remote message was withdrawn.
 */
export function resolveDeliveryIntent(
  tx: AppTransaction, projectId: string, intentId: string, reason: DeliveryResolution["reason"], now: number,
): "cancelled" | "resolved" | "unchanged" {
  if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_commit_time");
  if (reason !== "owner_answered" && reason !== "no_longer_waiting") throw new AppError("invalid_delivery_command");
  const intent = readDeliveryIntent(tx, projectId, intentId);
  if (intent.status === "cancelled" || intent.resolution) return "unchanged";
  if (cancelUnsent(tx, intent, reason, now)) return "cancelled";
  intent.resolution = { reason, at: now };
  intent.revision += 1; intent.updatedAt = now;
  saveIntent(tx, intent);
  return "resolved";
}

/**
 * Cancels every unsent intent committed by one configured schedule.
 * Legacy intents already accepted remotely or with an in-flight sender stay recorded; revocation
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
 * Marks a report superseded or deleted and cancels its unsent intents.
 * A legacy send already accepted remotely stays recorded. This does not claim the remote message was withdrawn.
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
  if (command.kind === "delivery.retire") {
    if (!exact(command.payload, ["reportId", "action"]) || !/^[a-f0-9-]{36}$/.test(command.payload.reportId) ||
        !["supersede", "delete"].includes(command.payload.action)) throw new AppError("invalid_delivery_command");
    return digest(JSON.stringify([command.kind, command.projectId, command.expectedRevision, command.payload.reportId, command.payload.action]));
  }
  throw new AppError("invalid_delivery_command");
}

export type { CommitDeliveryCommand, RetireDeliveryCommand };
