import { createHash } from "node:crypto";
import { AppError } from "../errors";
import { invalidatePendingJob, jobData } from "../jobs/queue";
import { requireId, requireReference, requireText, type SourceReference } from "../sources";
import type { AppTransaction, TransactionStore } from "../store";
import type { ApplicationRunPort } from "../team/run-port";
import { fenceStaleContexts, lexicalScore, lexicalTerms } from "./context";
import { fenceUnavailableExtractions } from "./extract";
import { deletedClaim, deletedSource, lookupActiveClaim } from "./read";
import type { ClaimReference, MemoryClaim } from "./types";

export const deletePreviewContract = "app.data_deletion_preview/v1" as const;
export const deleteOperationContract = "app.data_deletion_operation/v1" as const;

/** Bounded preview lists; longer lists are truncated and flagged, never silently complete. */
export const deletePreviewBounds = Object.freeze({
  sources: 1000, claims: 2000, contexts: 100, pendingJobs: 500, backups: 50, obligations: 100,
});
/** Preview expiry and native-delete retry ceilings keep delete work bounded and idempotent. */
export const deletePolicy = Object.freeze({ previewMs: 15 * 60 * 1000, maxAttempts: 5 });
/** Replaces withdrawn claim payload with its unavailability marker; identity/lineage stay queryable. */
export const redactedText = "(memory ไม่พร้อมใช้งาน)";
/** One explicit owner-authorized local scope: an exact committed source lineage. */
export interface DeleteScope { kind: "source"; projectId: string; source: SourceReference }

export interface DeletePreviewCommand {
  kind: "memory.delete.preview"; requestId: string; projectId: string; expectedRevision: number;
  payload: { scope: DeleteScope };
}
export interface DeleteConfirmCommand {
  kind: "memory.delete.confirm"; requestId: string; projectId: string; expectedRevision: number;
  payload: { previewId: string; acknowledged: boolean; acknowledgedWholeSession: boolean };
}
export interface DeleteRetryCommand {
  kind: "memory.delete.retry"; requestId: string; projectId: string; expectedRevision: number;
  payload: { operationId: string };
}
export type DeleteCommand = DeletePreviewCommand | DeleteConfirmCommand | DeleteRetryCommand;

export interface DeletionTombstone {
  kind: "source" | "claim"; projectId: string;
  sourceId: string | null; claimId: string | null;
  revision: number; generation: number;
}

export interface DeletionPreview {
  id: string; contract: typeof deletePreviewContract;
  projectId: string; scope: DeleteScope;
  projectRevision: number;
  expiresAt: number; createdAt: number;
  affected: {
    sources: { projectId: string; source: SourceReference }[];
    claims: { projectId: string; reference: ClaimReference }[];
    contexts: { id: string; generation: number; projectId: string; ownerKind: string; ownerId: string }[];
    pendingJobs: { id: string; projectId: string }[];
    nativeSessions: { id: string; generation: number; appState: string }[];
    backups: { id: string; createdAt: number; state: string }[];
    exports: { id: string; projectId: string; createdAt: number }[];
    obligations: { kind: "task" | "decision"; id: string; title: string }[];
  };
  truncated: { sources: boolean; claims: boolean; contexts: boolean; pendingJobs: boolean; backups: boolean; exports: boolean };
  wholeSession: { required: boolean; reason: string | null; sessionScope: string[] };
  note: string;
}

export interface DeletionOperation {
  id: string; contract: typeof deleteOperationContract;
  projectId: string; previewId: string; scope: DeleteScope;
  state: "pending" | "complete" | "failed" | "blocked";
  attempts: number; maxAttempts: number;
  tombstones: DeletionTombstone[];
  contexts: { id: string; generation: number }[];
  backupsRetained: string[];
  residuals: string[];
  reason: string | null; nextAction: string;
  createdAt: number; updatedAt: number;
}

export interface DeletionReceipt { preview: DeletionPreview; duplicate: boolean }
export interface DeletionConfirmReceipt { operation: DeletionOperation; duplicate: boolean }

const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

function requireScope(scope: DeleteScope): void {
  if (!exact(scope, ["kind", "projectId", "source"]) || scope.kind !== "source") throw new AppError("invalid_memory_delete");
  requireId(scope.projectId);
  requireReference(scope.source);
  if (!exact(scope.source, ["sourceId", "revision", "generation"])) throw new AppError("invalid_memory_delete");
}

/** Validates the complete owner delete command before any state is read; receipt deduplication hashes the result. */
export function deleteCommandIdentity(command: DeleteCommand, contextBytes: number): string {
  const encoded = jobData(command, contextBytes);
  if (!exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) throw new AppError("invalid_memory_delete");
  requireId(command.projectId);
  if (command.kind === "memory.delete.preview") {
    if (!exact(command.payload, ["scope"])) throw new AppError("invalid_memory_delete");
    requireScope(command.payload.scope);
    if (command.payload.scope.projectId !== command.projectId) throw new AppError("invalid_memory_delete");
  } else if (command.kind === "memory.delete.confirm") {
    if (!exact(command.payload, ["previewId", "acknowledged", "acknowledgedWholeSession"])) throw new AppError("invalid_memory_delete");
    requireId(command.payload.previewId);
    if (typeof command.payload.acknowledged !== "boolean" || typeof command.payload.acknowledgedWholeSession !== "boolean") {
      throw new AppError("invalid_memory_delete");
    }
  } else if (command.kind === "memory.delete.retry") {
    if (!exact(command.payload, ["operationId"])) throw new AppError("invalid_memory_delete");
    requireId(command.payload.operationId);
  } else throw new AppError("invalid_memory_delete");
  return encoded;
}

/** The durable tombstones for restore replay, ordered by deletion time. */
export function readDeletionLedger(tx: AppTransaction): (DeletionTombstone & { operationId: string; deletedAt: number })[] {
  try {
    return tx.all<{ operation_id: string; project_id: string; kind: "source" | "claim"; source_id: string | null;
      claim_id: string | null; revision: number; generation: number; deletedAt: number }>(
      "SELECT operation_id, project_id, kind, source_id, claim_id, revision, generation, deleted_at AS deletedAt FROM deletion_ledger ORDER BY deleted_at, id")
      .map(row => ({ operationId: row.operation_id, projectId: row.project_id, kind: row.kind,
        sourceId: row.source_id, claimId: row.claim_id, revision: row.revision, generation: row.generation, deletedAt: row.deletedAt }));
  } catch { return []; }
}

export function readDeletionPreview(tx: AppTransaction, projectId: string, previewId: string): DeletionPreview | null {
  requireId(projectId); requireId(previewId);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM deletion_previews WHERE id = ? AND project_id = ?", previewId, projectId);
  return row ? JSON.parse(row.record_json) as DeletionPreview : null;
}

export function readDeletionOperation(tx: AppTransaction, projectId: string, operationId: string): DeletionOperation | null {
  requireId(projectId); requireId(operationId);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM deletion_operations WHERE id = ? AND project_id = ?", operationId, projectId);
  return row ? JSON.parse(row.record_json) as DeletionOperation : null;
}

export function listDeletionOperations(tx: AppTransaction, projectId: string, limit = 50): DeletionOperation[] {
  requireId(projectId);
  return tx.all<{ record_json: string }>("SELECT record_json FROM deletion_operations WHERE project_id = ? ORDER BY rowid DESC LIMIT ?",
    projectId, Math.min(Math.max(limit, 1), 100)).map(row => JSON.parse(row.record_json) as DeletionOperation);
}

const sameSource = (a: SourceReference, b: SourceReference) =>
  a.sourceId === b.sourceId && a.revision === b.revision && a.generation === b.generation;
const sourceKey = (s: SourceReference) => `${s.sourceId}:${s.revision}:${s.generation}`;

function collectClaims(tx: AppTransaction, lineage: SourceReference): { items: { projectId: string; claim: MemoryClaim }[]; truncated: boolean } {
  const rows = tx.all<{ project_id: string; record_json: string }>(
    "SELECT project_id, record_json FROM memory_claims ORDER BY sequence LIMIT ?", deletePreviewBounds.claims + 1);
  const truncated = rows.length > deletePreviewBounds.claims;
  const parsed: { projectId: string; claim: MemoryClaim }[] = [];
  for (const row of rows.slice(0, deletePreviewBounds.claims)) {
    try {
      const claim = JSON.parse(row.record_json) as MemoryClaim;
      if (typeof claim.claimId === "string") parsed.push({ projectId: row.project_id, claim });
    } catch { /* Unreadable rows stay excluded; availability remains authoritative in lookupActiveClaim. */ }
  }
  const direct = parsed.filter(entry => sameSource(entry.claim.source, lineage));
  const affected = new Map<string, { projectId: string; claim: MemoryClaim }>();
  for (const entry of direct) affected.set(entry.claim.claimId, entry);
  for (let grew = true; grew;) {
    grew = false;
    for (const entry of parsed) {
      if (affected.has(entry.claim.claimId)) continue;
      if ([...entry.claim.dependencies, ...entry.claim.conflicts].some(ref => affected.has(ref.claimId))) {
        affected.set(entry.claim.claimId, entry); grew = true;
      }
    }
  }
  return { items: [...affected.values()], truncated };
}

function overlapObligations(tx: AppTransaction, projectId: string, text: string, lineage: SourceReference): DeletionPreview["affected"]["obligations"] {
  const query = lexicalTerms(text), out: DeletionPreview["affected"]["obligations"] = [];
  const clip = (value: string) => Array.from(value).slice(0, 120).join("");
  for (const row of tx.all<{ id: string; title: string; summary: string; sourceId: string }>(
    "SELECT id, title, summary, source_id AS sourceId FROM tasks WHERE project_id = ? AND state IN ('proposed', 'accepted', 'ready_for_review') LIMIT 200", projectId)) {
    if (row.sourceId === lineage.sourceId || lexicalScore(query, `${row.title}\n${row.summary}`) >= 3) {
      out.push({ kind: "task", id: row.id, title: clip(row.title) });
      if (out.length >= deletePreviewBounds.obligations) break;
    }
  }
  for (const row of tx.all<{ id: string; conclusion: string; rationale: string }>(
    "SELECT id, conclusion, rationale FROM owner_decisions WHERE project_id = ? AND superseded_by IS NULL LIMIT 200", projectId)) {
    if (lexicalScore(query, `${row.conclusion}\n${row.rationale}`) >= 3) {
      out.push({ kind: "decision", id: row.id, title: clip(row.conclusion) });
      if (out.length >= deletePreviewBounds.obligations) break;
    }
  }
  return out;
}

function affectedContexts(tx: AppTransaction, claimIds: Set<string>, lineage: SourceReference): { items: DeletionPreview["affected"]["contexts"]; truncated: boolean } {
  const rows = claimIds.size ? tx.all<{ id: string; generation: number; projectId: string; ownerKind: string; ownerId: string }>(
    `SELECT c.id, coalesce(e.generation, 1) AS generation, c.project_id AS projectId, c.owner_kind AS ownerKind, c.owner_id AS ownerId
     FROM memory_context_entries e JOIN memory_contexts c ON c.id = e.context_id
     WHERE (e.kind = 'claim' AND e.entry_id IN (${[...claimIds].map(() => "?").join(",")}))
        OR (e.kind = 'source' AND e.entry_id = ?) GROUP BY c.id LIMIT ${deletePreviewBounds.contexts + 1}`,
    ...claimIds, lineage.sourceId) : [];
  return { items: rows.slice(0, deletePreviewBounds.contexts).map(row => ({ ...row })), truncated: rows.length > deletePreviewBounds.contexts };
}

function pendingCiting(tx: AppTransaction, claimIds: Set<string>, lineage: SourceReference): { items: { id: string; projectId: string }[]; truncated: boolean } {
  const found = new Map<string, { id: string; projectId: string }>();
  let unreadable = 0;
  const pending = "state IN ('queued', 'admitted', 'waiting')";
  const cites = (json: string): boolean => {
    try {
      const parsed = JSON.parse(json) as { dependencies?: { claimId?: unknown }[]; request?: { manifest?: { claims?: { claimId?: unknown }[]; sources?: { reference?: unknown }[] } }; manifest?: { claims?: { claimId?: unknown }[]; sources?: { reference?: unknown }[] }; kind?: unknown };
      const claims: { claimId?: unknown }[] = parsed.request?.manifest?.claims ?? (parsed.kind === "discussion" ? parsed.manifest?.claims ?? [] : []);
      const sources = parsed.request?.manifest?.sources ?? (parsed.kind === "discussion" ? parsed.manifest?.sources ?? [] : []);
      if (claims.some(c => typeof c?.claimId === "string" && claimIds.has(c.claimId))) return true;
      return sources.some(s => {
        const ref = (s as { reference?: SourceReference })?.reference;
        return !!ref && typeof ref.sourceId === "string" && sameSource(ref, lineage);
      });
    } catch { unreadable++; return false; }
  };
  const stream = tx.all<{ projectId: string; jobId: string; json: string }>(
    `SELECT projectId, jobId, json FROM (
       SELECT project_id AS projectId, job_id AS jobId, record_json AS json, rowid AS ordering FROM memory_extractions WHERE job_id IN (SELECT id FROM jobs WHERE ${pending})
       UNION ALL SELECT project_id AS projectId, job_id AS jobId, record_json AS json, rowid AS ordering FROM team_runs WHERE job_id IN (SELECT id FROM jobs WHERE ${pending})
       UNION ALL SELECT project_id AS projectId, job_id AS jobId, record_json AS json, rowid AS ordering FROM coordinator_syntheses WHERE job_id IN (SELECT id FROM jobs WHERE ${pending})
     ) ORDER BY ordering LIMIT ${deletePreviewBounds.pendingJobs + 1}`);
  for (const row of stream) {
    if (found.size >= deletePreviewBounds.pendingJobs) break;
    if (cites(row.json)) found.set(row.jobId, { id: row.jobId, projectId: row.projectId });
  }
  return { items: [...found.values()], truncated: stream.length > deletePreviewBounds.pendingJobs || unreadable > 0 };
}

function citingRuns(tx: AppTransaction, claimIds: Set<string>): { jobId: string; projectId: string; json: string }[] {
  if (!claimIds.size) return [];
  const out: { jobId: string; projectId: string; json: string }[] = [];
  for (const row of tx.all<{ projectId: string; jobId: string; json: string }>(
    "SELECT project_id AS projectId, job_id AS jobId, record_json AS json FROM team_runs LIMIT 2000")) {
    try {
      const parsed = JSON.parse(row.json) as { manifest?: { claims?: { claimId?: unknown }[] } };
      if (parsed.manifest?.claims?.some(c => typeof c?.claimId === "string" && claimIds.has(c.claimId as string))) {
        out.push({ ...row });
      }
    } catch { /* Unreadable runs cannot prove safety; contexts stay listed for fencing. */ }
  }
  return out;
}

function nativeSessionsFor(tx: AppTransaction, claimIds: Set<string>): { id: string; generation: number; appState: string }[] {
  const found = new Map<string, { id: string; generation: number; appState: string }>();
  for (const run of citingRuns(tx, claimIds)) {
    const contextId = tx.get<{ context_id: string }>("SELECT context_id FROM team_runs WHERE job_id = ? AND project_id = ?", run.jobId, run.projectId)?.context_id;
    if (contextId) {
      const state = tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ?", contextId)?.state ?? "missing";
      found.set(`${contextId}:1`, { id: contextId, generation: 1, appState: state });
    }
    for (const row of tx.all<{ json: string }>("SELECT record_json AS json FROM job_attempts WHERE job_id = ?", run.jobId)) {
      try {
        const native = (JSON.parse(row.json) as { native?: { context?: { id: string; generation: number } } }).native?.context;
        if (native) {
          const state = tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", native.id, native.generation)?.state ?? "missing";
          found.set(`${native.id}:${native.generation}`, { id: native.id, generation: native.generation, appState: state });
        }
      } catch { /* Attempts without native references retire nothing. */ }
    }
  }
  return [...found.values()];
}

function retainedBackups(tx: AppTransaction, lineage: SourceReference): { items: DeletionPreview["affected"]["backups"]; truncated: boolean } {
  try {
    const rows = tx.all<{ record_json: string }>("SELECT record_json FROM ops_backups ORDER BY created_at, id LIMIT 100");
    const items: DeletionPreview["affected"]["backups"] = [];
    for (const row of rows) {
      try {
        const manifest = JSON.parse(row.record_json) as { id: string; createdAt: number; state: string; sourceGenerations?: { sourceId: string; revision: number; generation: number }[] };
        if (manifest.sourceGenerations?.some(s => s.sourceId === lineage.sourceId && s.revision === lineage.revision && s.generation === lineage.generation)) {
          items.push({ id: manifest.id, createdAt: manifest.createdAt, state: manifest.state });
        }
      } catch { /* Corrupt manifests stay visible to backup validation, not silently skipped here. */ }
    }
    return { items: items.slice(0, deletePreviewBounds.backups), truncated: items.length > deletePreviewBounds.backups };
  } catch { return { items: [], truncated: false }; }
}

/**
 * Managed export artifacts of this project whose coverage includes the doomed lineage; deletion
 * never edits them. A truncated coverage list cannot prove absence, so such exports are listed
 * conservatively. Failed exports published no artifact and are never listed.
 */
function retainedExports(tx: AppTransaction, projectId: string, lineage: SourceReference, claimIds: Set<string>): { items: DeletionPreview["affected"]["exports"]; truncated: boolean } {
  try {
    const rows = tx.all<{ record_json: string }>("SELECT record_json FROM export_artifacts WHERE project_id = ? ORDER BY created_at, id LIMIT 100", projectId);
    const items: DeletionPreview["affected"]["exports"] = [];
    for (const row of rows) {
      try {
        const manifest = JSON.parse(row.record_json) as { id: string; projectId: string; createdAt: number; state?: string;
          coverage?: { sources?: { sourceId: string; revision: number; generation: number }[]; claims?: { claimId: string }[]; truncated?: boolean } };
        if (manifest.state === "failed") continue;
        const hit = manifest.coverage?.sources?.some(s => s.sourceId === lineage.sourceId && s.revision === lineage.revision && s.generation === lineage.generation)
          ?? false;
        const claimHit = manifest.coverage?.claims?.some(c => claimIds.has(c.claimId)) ?? false;
        if (hit || claimHit || manifest.coverage?.truncated === true) items.push({ id: manifest.id, projectId: manifest.projectId, createdAt: manifest.createdAt });
      } catch { /* Corrupt artifacts stay visible to export validation, not silently skipped here. */ }
    }
    return { items: items.slice(0, deletePreviewBounds.backups), truncated: items.length > deletePreviewBounds.backups };
  } catch { return { items: [], truncated: false }; }
}

const deleteNote = "การลบถอน source ต้นฉบับ เนื้อความ derived ที่อ้างมัน บริบทที่บันทึกไว้และ native session ที่เกี่ยวข้องออกจาก local serving ทั้งหมด " +
  "งานที่รับรอง มติ และการตั้งค่าไม่ถูกเปลี่ยนโดยปริยาย สำรองข้อมูลเดิมยังเก็บข้อมูลที่ถูกลบตาม retention ของมัน ส่วน Telegram/provider copies ไม่ได้ถูกลบโดยคำสั่งนี้";

function sourceText(tx: AppTransaction, projectId: string, lineage: SourceReference): string {
  const row = tx.get<{ text: string | null }>("SELECT content_text AS text FROM source_versions WHERE source_id = ? AND revision = ? AND generation = ?",
    lineage.sourceId, lineage.revision, lineage.generation);
  return row?.text ?? "";
}

/**
 * app.data_lifecycle/v1 preview: revision-bound, expiring deletion preview with bounded
 * collateral lists and truncated flags. Nothing mutates; the owner confirms separately.
 */
export function prepareDeletionPreview(tx: AppTransaction, command: DeletePreviewCommand, projectRevision: number, now: number): DeletionPreview {
  deleteCommandIdentity(command, 65536);
  const scope = command.payload.scope;
  if (projectRevision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  if (deletedSource(tx, scope.source)) throw new AppError("memory_already_deleted", 409);
  const current = tx.get<{ revision: number; generation: number; kind: string; availability: string; topicId?: string }>(
    "SELECT current_revision AS revision, generation, kind, availability FROM sources WHERE id = ? AND project_id = ?",
    scope.source.sourceId, scope.projectId);
  if (!current) throw new AppError("source_not_found", 404);
  if (current.revision !== scope.source.revision || current.generation !== scope.source.generation) {
    throw new AppError("memory_delete_stale_scope", 409);
  }
  if (current.availability !== "available") throw new AppError("memory_delete_unavailable", 409);
  const lineage: SourceReference = { ...scope.source };
  const { items: claimEntries, truncated: claimsTruncated } = collectClaims(tx, lineage);
  const claimIds = new Set(claimEntries.map(entry => entry.claim.claimId));
  const sources = [{ projectId: scope.projectId, source: lineage }];
  const { items: contexts, truncated: contextsTruncated } = affectedContexts(tx, claimIds, lineage);
  const { items: pendingJobs, truncated: pendingTruncated } = pendingCiting(tx, claimIds, lineage);
  const nativeSessions = nativeSessionsFor(tx, claimIds);
  const { items: backups, truncated: backupsTruncated } = retainedBackups(tx, lineage);
  const { items: exports, truncated: exportsTruncated } = retainedExports(tx, scope.projectId, lineage, claimIds);
  const descriptor = tx.get<{ descriptor: string }>("SELECT descriptor_json AS descriptor FROM source_versions WHERE source_id = ? AND revision = ? AND generation = ?",
    lineage.sourceId, lineage.revision, lineage.generation);
  let descriptorKind = "message";
  try { descriptorKind = (JSON.parse(descriptor?.descriptor ?? "{}") as { kind?: string }).kind ?? "message"; } catch { /* Identity stays descriptive. */ }
  const missingNative = nativeSessions.some(session => session.appState === "missing");
  const wholeSession = descriptorKind === "topic"
    ? { required: true as const, reason: "topic_identity_shared" as const, sessionScope: [scope.source.sourceId] }
    : missingNative
      ? { required: true as const, reason: "native_orphan_unresolvable" as const, sessionScope: nativeSessions.filter(s => s.appState === "missing").map(s => `${s.id}:${s.generation}`) }
      : { required: false as const, reason: null as string | null, sessionScope: [] as string[] };
  const preview: DeletionPreview = {
    id: crypto.randomUUID(), contract: deletePreviewContract,
    projectId: command.projectId, scope: { kind: "source", projectId: scope.projectId, source: { ...lineage } },
    projectRevision, expiresAt: now + deletePolicy.previewMs, createdAt: now,
    affected: {
      sources,
      claims: claimEntries.map(entry => ({ projectId: entry.projectId,
        reference: { claimId: entry.claim.claimId, revision: entry.claim.revision, generation: entry.claim.generation } })),
      contexts: contexts.map(c => ({ ...c })),
      pendingJobs,
      nativeSessions,
      backups,
      exports,
      obligations: overlapObligations(tx, scope.projectId, sourceText(tx, scope.projectId, lineage), lineage),
    },
    truncated: { sources: false, claims: claimsTruncated, contexts: contextsTruncated, pendingJobs: pendingTruncated, backups: backupsTruncated, exports: exportsTruncated },
    wholeSession, note: deleteNote,
  };
  tx.run("INSERT INTO deletion_previews (id, project_id, expires_at, record_json) VALUES (?, ?, ?, ?)",
    preview.id, command.projectId, preview.expiresAt, JSON.stringify(preview));
  return preview;
}

/** Replaces quoted copies of just-purged payloads in committed model outputs and delivery
 *  reports (kind `output` lineage). Owner message/topic sources are never rewritten here. */
export function scrubOutputSources(tx: AppTransaction, needles: string[]): void {
  const terms = [...new Set(needles.filter(n => n.length > 0))].slice(0, 500);
  if (!terms.length) return;
  for (const row of tx.all<{ sourceId: string; revision: number; generation: number; text: string }>(
    `SELECT v.source_id AS sourceId, v.revision, v.generation, v.content_text AS text
     FROM source_versions v JOIN sources s ON s.id = v.source_id
     WHERE s.kind = 'output' AND v.content_text IS NOT NULL LIMIT 5000`)) {
    let next = row.text;
    for (const term of terms) {
      if (next.includes(term)) next = next.split(term).join(redactedText);
    }
    if (next !== row.text) {
      tx.run("UPDATE source_versions SET content_text = ? WHERE source_id = ? AND revision = ? AND generation = ?",
        next, row.sourceId, row.revision, row.generation);
    }
  }
}

/** Replaces quoted copies of just-purged payloads in committed model outputs; owner-authored tasks/decisions/deliveries are never rewritten. */
export function scrubFreeTextOccurrences(tx: AppTransaction, needles: string[]): void {
  const terms = [...new Set(needles.filter(n => n.length > 0))].slice(0, 500);
  if (!terms.length) return;
  for (const table of ["team_runs", "coordinator_syntheses", "jobs"] as const) {
    for (const row of tx.all<{ rowid: number; json: string }>(`SELECT rowid, record_json AS json FROM ${table} LIMIT 5000`)) {
      let next = row.json;
      for (const term of terms) {
        if (next.includes(term)) next = next.split(term).join(redactedText);
      }
      if (next !== row.json) tx.run(`UPDATE ${table} SET record_json = ? WHERE rowid = ?`, next, row.rowid);
    }
  }
}

function fenceAffectedJobs(tx: AppTransaction, projectId: string, jobs: { id: string; projectId: string }[], claimIds: Set<string>, now: number): void {
  for (const job of jobs) invalidatePendingJob(tx, job.projectId, job.id, "source_retired", now);
  for (const row of tx.all<{ projectId: string; jobId: string; json: string }>("SELECT project_id AS projectId, job_id AS jobId, record_json AS json FROM team_runs LIMIT 2000")) {
    try {
      const discussion = JSON.parse(row.json) as { kind?: string; manifest?: { claims?: { claimId?: unknown }[] } };
      if (discussion.kind !== "discussion" || !discussion.manifest?.claims?.some(c => typeof c?.claimId === "string" && claimIds.has(c.claimId as string))) continue;
      invalidatePendingJob(tx, row.projectId, row.jobId, "source_retired", now);
    } catch { /* Unreadable pending discussions stay fenced with their parent job below. */ }
  }
  void projectId;
  fenceStaleContexts(tx, now);
}

function scrubManifestTexts(value: unknown, sources: Set<string>, claims: Set<string>): unknown {
  if (Array.isArray(value)) return value.map(item => scrubManifestTexts(item, sources, claims));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.sources) && Array.isArray(record.claims)) {
    return {
      ...record,
      sources: (record.sources as { reference?: SourceReference; text?: unknown }[]).map(source =>
        source?.reference && typeof source.reference.sourceId === "string" && sources.has(sourceKey(source.reference))
          ? { ...source, text: redactedText } : source),
      claims: (record.claims as { claimId?: unknown; text?: unknown }[]).map(claim =>
        typeof claim?.claimId === "string" && claims.has(claim.claimId) ? { ...claim, text: redactedText } : claim),
    };
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, scrubManifestTexts(item, sources, claims)]));
}

function scrubStoredManifests(tx: AppTransaction, sources: Set<string>, claims: Set<string>): void {
  for (const table of ["memory_extractions", "team_runs", "coordinator_syntheses"] as const) {
    for (const row of tx.all<{ rowid: number; json: string }>(`SELECT rowid, record_json AS json FROM ${table} LIMIT 5000`)) {
      let parsed: unknown;
      try { parsed = JSON.parse(row.json); } catch { continue; }
      const scrubbed = scrubManifestTexts(parsed, sources, claims);
      if (JSON.stringify(scrubbed) !== row.json) {
        tx.run(`UPDATE ${table} SET record_json = ? WHERE rowid = ?`, JSON.stringify(scrubbed), row.rowid);
      }
    }
  }
}

function scrubConversationReceipts(tx: AppTransaction, lineage: SourceReference, claimIds: Set<string>): void {
  for (const row of tx.all<{ request_id: string; result: string }>(
    "SELECT request_id, result_json AS result FROM command_receipts WHERE result_json LIKE ? LIMIT 500", `%${lineage.sourceId}%`)) {
    let parsed: unknown;
    try { parsed = JSON.parse(row.result); } catch { continue; }
    let changed = false;
    const visit = (node: unknown): unknown => {
      if (Array.isArray(node)) return node.map(visit);
      if (!node || typeof node !== "object") return node;
      const record = node as Record<string, unknown>;
      const source = record.source as SourceReference | undefined;
      if (source && typeof source.sourceId === "string" && sameSource(source, lineage)) {
        changed = true;
        const next = { ...record };
        if ("text" in next) next.text = null;
        if ("title" in next) next.title = null;
        if ("availability" in next) next.availability = "unavailable";
        return Object.fromEntries(Object.entries(next).map(([key, item]) => [key, key === "source" ? item : visit(item)]));
      }
      // Run-manifest claim entries carry no source field; match them by deleted identity.
      if (typeof record.claimId === "string" && claimIds.has(record.claimId) && "text" in record) {
        changed = true;
        return { ...record, text: redactedText };
      }
      return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, visit(item)]));
    };
    const scrubbed = visit(parsed);
    if (changed) tx.run("UPDATE command_receipts SET result_json = ? WHERE request_id = ?", JSON.stringify(scrubbed), row.request_id);
  }
}

/**
 * app.data_lifecycle/v1 confirm: fences affected attempts, purges app payloads and
 * cached copies, writes identity-only tombstones and opens a per-scope operation.
 * Native sessions retire only through the managed run-port lifecycle (reconcile).
 */
export function confirmDeletion(tx: AppTransaction, command: DeleteConfirmCommand, projectRevision: number, now: number): DeletionConfirmReceipt {
  deleteCommandIdentity(command, 65536);
  const preview = readDeletionPreview(tx, command.projectId, command.payload.previewId);
  if (!preview || preview.projectId !== command.projectId) throw new AppError("memory_delete_stale_preview", 409);
  if (now > preview.expiresAt) throw new AppError("memory_delete_stale_preview", 409);
  if (projectRevision !== command.expectedRevision || projectRevision !== preview.projectRevision) {
    throw new AppError("memory_delete_stale_preview", 409);
  }
  const existing = tx.get<{ record_json: string }>("SELECT record_json FROM deletion_operations WHERE preview_id = ? AND project_id = ?",
    preview.id, command.projectId);
  if (existing) return { operation: JSON.parse(existing.record_json) as DeletionOperation, duplicate: true };
  if (!command.payload.acknowledged) throw new AppError("memory_delete_ambiguous", 409);
  if (preview.wholeSession.required && !command.payload.acknowledgedWholeSession) throw new AppError("memory_delete_ambiguous", 409);
  const lineage = preview.scope.source;
  if (deletedSource(tx, lineage)) throw new AppError("memory_already_deleted", 409);
  const current = tx.get<{ revision: number; generation: number; availability: string }>(
    "SELECT current_revision AS revision, generation, availability FROM sources WHERE id = ? AND project_id = ?",
    lineage.sourceId, preview.scope.projectId);
  if (!current || current.revision !== lineage.revision || current.generation !== lineage.generation) {
    throw new AppError("memory_delete_stale_preview", 409);
  }
  const { items: claimEntries } = collectClaims(tx, lineage);
  const claimIds = new Set(claimEntries.map(entry => entry.claim.claimId));
  const { items: pendingJobs } = pendingCiting(tx, claimIds, lineage);
  fenceAffectedJobs(tx, command.projectId, pendingJobs, claimIds, now);
  for (const project of new Set([preview.scope.projectId, ...claimEntries.map(entry => entry.projectId)])) {
    fenceUnavailableExtractions(tx, project, now);
  }
  // Collect doomed payload texts before purging so quoted copies in committed model
  // outputs can be scrubbed precisely; short needles are skipped to avoid over-redaction.
  const needles = new Set<string>();
  const needle = (value: unknown) => {
    if (typeof value === "string" && Array.from(value).length >= 8) needles.add(value);
  };
  needle(tx.get<{ text: string | null }>("SELECT content_text AS text FROM source_versions WHERE source_id = ? AND revision = ? AND generation = ?",
    lineage.sourceId, lineage.revision, lineage.generation)?.text ?? null);
  // Purge app-owned payloads; identity rows stay so references resolve as unavailable.
  tx.run("UPDATE source_versions SET content_text = NULL WHERE source_id = ? AND revision = ? AND generation = ?",
    lineage.sourceId, lineage.revision, lineage.generation);
  tx.run("UPDATE sources SET availability = 'unavailable' WHERE id = ? AND project_id = ? AND current_revision = ? AND generation = ?",
    lineage.sourceId, preview.scope.projectId, lineage.revision, lineage.generation);
  for (const entry of claimEntries) {
    try {
      const stored = tx.get<{ record_json: string }>("SELECT record_json FROM memory_claims WHERE id = ? AND project_id = ?",
        entry.claim.claimId, entry.projectId)?.record_json;
      if (stored) {
        const claim = JSON.parse(stored) as MemoryClaim;
        needle(claim.text); needle(claim.quote);
        if (claim.status !== "deleted" || claim.text !== redactedText) {
          tx.run("UPDATE memory_claims SET record_json = ? WHERE id = ? AND project_id = ?",
            JSON.stringify({ ...claim, status: "deleted", text: redactedText, quote: redactedText }),
            entry.claim.claimId, entry.projectId);
        }
      }
    } catch { /* Identity tombstones below still deny every lifecycle consumer. */ }
  }
  const sourceKeys = new Set([sourceKey(lineage)]);
  scrubStoredManifests(tx, sourceKeys, claimIds);
  scrubConversationReceipts(tx, lineage, claimIds);
  scrubFreeTextOccurrences(tx, [...needles].slice(0, 500));
  scrubOutputSources(tx, [...needles].slice(0, 500));
  for (const entry of claimEntries) tx.run("DELETE FROM memory_derived_sources WHERE source_id = ?", entry.claim.source.sourceId);
  tx.run("DELETE FROM memory_derived_sources WHERE source_id = ?", lineage.sourceId);
  const operationId = crypto.randomUUID();
  const tombstones: DeletionTombstone[] = [
    { kind: "source", projectId: preview.scope.projectId, sourceId: lineage.sourceId, claimId: null, revision: lineage.revision, generation: lineage.generation },
    ...claimEntries.map(entry => ({ kind: "claim" as const, projectId: entry.projectId, sourceId: null as string | null,
      claimId: entry.claim.claimId, revision: entry.claim.revision, generation: entry.claim.generation })),
  ];
  for (const tombstone of tombstones) {
    tx.run("INSERT OR IGNORE INTO deletion_ledger (id, operation_id, project_id, kind, source_id, claim_id, revision, generation, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(), operationId, tombstone.projectId, tombstone.kind, tombstone.sourceId, tombstone.claimId,
      tombstone.revision, tombstone.generation, now);
  }
  const sessions = nativeSessionsFor(tx, claimIds)
    .filter(session => session.appState !== "deleted")
    .map(session => ({ id: session.id, generation: session.generation }));
  const { items: backups } = retainedBackups(tx, lineage);
  const operation: DeletionOperation = {
    id: operationId, contract: deleteOperationContract,
    projectId: command.projectId, previewId: preview.id,
    scope: { kind: "source", projectId: preview.scope.projectId, source: { ...lineage } },
    state: sessions.length ? "pending" : "complete",
    attempts: 0, maxAttempts: deletePolicy.maxAttempts,
    tombstones, contexts: sessions,
    backupsRetained: backups.map(backup => backup.id),
    residuals: ["telegram_delivery_copies_not_deleted", "provider_session_copies_not_deleted", "retained_backups_require_retention_purge"],
    reason: sessions.length ? "native_sessions_pending_managed_delete" : null,
    nextAction: sessions.length ? "reconcile_managed_delete_then_verify" : "inspect_completed_deletion",
    createdAt: now, updatedAt: now,
  };
  tx.run("INSERT INTO deletion_operations (id, project_id, preview_id, state, attempts, record_json) VALUES (?, ?, ?, ?, ?, ?)",
    operation.id, command.projectId, preview.id, operation.state, 0, JSON.stringify(operation));
  return { operation, duplicate: false };
}

/** Bounded explicit retry of a pending, failed or blocked operation; never resurrects purged payloads. */
export function retryDeletion(tx: AppTransaction, command: DeleteRetryCommand, now: number): DeletionOperation {
  deleteCommandIdentity(command, 65536);
  const operation = readDeletionOperation(tx, command.projectId, command.payload.operationId);
  if (!operation || operation.projectId !== command.projectId) throw new AppError("deletion_not_found", 404);
  if (operation.state === "complete") return operation;
  if (operation.attempts >= operation.maxAttempts) {
    const failed: DeletionOperation = { ...operation, state: "failed", reason: "retry_budget_exhausted",
      nextAction: "inspect_blocked_scope_and_retry_manually", updatedAt: now };
    tx.run("UPDATE deletion_operations SET state = ?, attempts = ?, record_json = ? WHERE id = ?",
      failed.state, failed.attempts, JSON.stringify(failed), failed.id);
    return failed;
  }
  const retried: DeletionOperation = { ...operation, state: "pending", attempts: operation.attempts + 1,
    reason: "retry_requested", nextAction: "reconcile_managed_delete_then_verify", updatedAt: now };
  tx.run("UPDATE deletion_operations SET state = ?, attempts = ?, record_json = ? WHERE id = ?",
    retried.state, retried.attempts, JSON.stringify(retried), retried.id);
  return retried;
}

/** Recomputes one operation from live native state after managed-delete reconciliation. */
export function refreshOperationState(tx: AppTransaction, operationId: string, now: number): DeletionOperation | null {
  const row = tx.get<{ record_json: string; attempts: number }>("SELECT record_json, attempts FROM deletion_operations WHERE id = ?", operationId);
  if (!row) return null;
  const operation = JSON.parse(row.record_json) as DeletionOperation;
  if (operation.state === "complete") return operation;
  let blocked = false;
  for (const context of operation.contexts) {
    const state = tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", context.id, context.generation)?.state;
    if (state === "delete_failed") blocked = true;
    if (state === undefined) blocked = true;
  }
  const remaining = operation.contexts.filter(context =>
    tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", context.id, context.generation)?.state !== "deleted");
  const refreshed: DeletionOperation = {
    ...operation,
    state: remaining.length === 0 ? "complete" : blocked || operation.attempts >= operation.maxAttempts ? (operation.attempts >= operation.maxAttempts ? "failed" : "blocked") : "pending",
    contexts: remaining,
    reason: remaining.length === 0 ? null : operation.attempts >= operation.maxAttempts ? "retry_budget_exhausted"
      : blocked ? "native_delete_blocked_or_missing" : "native_sessions_pending_managed_delete",
    nextAction: remaining.length === 0 ? "inspect_completed_deletion"
      : operation.attempts >= operation.maxAttempts ? "inspect_blocked_scope_and_retry_manually" : "reconcile_managed_delete_then_verify",
    updatedAt: now,
  };
  tx.run("UPDATE deletion_operations SET state = ?, record_json = ? WHERE id = ?", refreshed.state, JSON.stringify(refreshed), refreshed.id);
  return refreshed;
}

/**
 * Service lifecycle helper: drives pending operations through the managed run-port
 * delete path (never native byte edits). Deterministic with scripted ports; bounded
 * attempts keep retries idempotent across restarts.
 */
export async function reconcileDeletions(store: TransactionStore, port: ApplicationRunPort, now: number): Promise<DeletionOperation[]> {
  const pending = store.read(tx => tx.all<{ id: string }>(
    "SELECT id FROM deletion_operations WHERE state IN ('pending', 'blocked') LIMIT 100").map(row => row.id));
  const refreshed: DeletionOperation[] = [];
  for (const id of pending) {
    const operation = store.read(tx => {
      const row = tx.get<{ record_json: string }>("SELECT record_json FROM deletion_operations WHERE id = ?", id);
      return row ? JSON.parse(row.record_json) as DeletionOperation : null;
    });
    if (!operation || operation.state === "complete" || operation.state === "failed") continue;
    // Every reconcile gives pending work one more managed-delete chance; the retry
    // budget only decides the terminal failed marking in refreshOperationState.
    for (const context of operation.contexts) {
      try {
        await port.delete({ ...context });
      } catch { /* A failed managed delete stays retryable; payloads are already purged. */ }
    }
    const next = store.transaction(tx => refreshOperationState(tx, id, now));
    if (next) refreshed.push(next);
  }
  return refreshed;
}

/** Preview expiry sweep; never deletes ledger tombstones or completed operations. */
export function pruneExpiredPreviews(tx: AppTransaction, now: number): number {
  const rows = tx.all<{ id: string }>("SELECT id FROM deletion_previews WHERE expires_at < ? LIMIT 500", now);
  for (const row of rows) tx.run("DELETE FROM deletion_previews WHERE id = ?", row.id);
  return rows.length;
}
