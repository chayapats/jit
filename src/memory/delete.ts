import { createHash } from "node:crypto";
import { lstatSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { AppError } from "../errors";
import { readDeliveryReport, retireDeliveryReport } from "../delivery/outbox";
import { invalidatePendingJob, jobData } from "../jobs/queue";
import { validateManifestRecord, verifyBackupArtifacts } from "../ops/backup";
import { readExportManifest } from "../ops/export";
import { lookupSource, requireId, requireReference, type SourceReference } from "../sources";
import type { AppTransaction, TransactionStore } from "../store";
import { isRoleProposalView, redactRoleProposals, redactRoleProposalView } from "../team/role-proposals";
import type { ApplicationRunPort } from "../team/run-port";
import { fenceStaleContexts, lexicalScore, lexicalTerms } from "./context";
import { fenceUnavailableExtractions } from "./extract";
import { deletedSource, ledgerQueryFailed, lookupActiveClaim } from "./read";
import type { ClaimReference, MemoryClaim } from "./types";

export const deletePreviewContract = "app.data_deletion_preview/v1" as const;
export const deleteOperationContract = "app.data_deletion_operation/v1" as const;

/** Bounded preview lists. Truncating any list that confirmation acts on is a named blocker, never silently complete. */
export const deletePreviewBounds = Object.freeze({
  sources: 1000, claims: 2000, contexts: 100, pendingJobs: 500, nativeSessions: 100, backups: 50, exports: 50, obligations: 100, taskProposals: 200, taskEvidence: 200, deliveries: 500,
});
/** Inventory scans page through whole tables; a table past `scanRows` blocks confirmation instead of hiding rows. */
export const deleteInventoryPolicy = Object.freeze({ scanRows: 200_000, page: 500, closureRounds: 32, chunk: 400 });
/**
 * Quoted-copy fallback for copies without durable provenance: payloads of at least `minChars` characters are
 * scrubbed in deterministic chunks; more than `maxTerms` distinct payloads, or a shorter payload that appears in
 * an unlinked record, is a named preview blocker rather than a silent skip.
 */
export const deleteScrubPolicy = Object.freeze({ minChars: 8, maxTerms: 4000, chunk: 500 });
/** Preview expiry and the total managed-delete pass budget (owner retry and automatic reconcile share it). */
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

/** app.deletion_ledger/v1 entry: identity and lineage revision only, never payload or actor secrets. */
export interface DeletionTombstone {
  kind: "source" | "claim"; projectId: string;
  sourceId: string | null; claimId: string | null;
  revision: number; generation: number;
}

/** Entries a managed native session holds outside the deletion scope; whole-session deletion removes them too. */
export interface DeletionSessionCollateral {
  sources: { projectId: string; source: SourceReference }[];
  claims: { projectId: string; claimId: string }[];
}

/**
 * One managed native session bound to work that cited the deleted lineage (directly, through an
 * affected claim or through a derived output). The run port has no selective erase, so a dispatched
 * session is always deleted whole; its `collateral` lists what else that removes.
 */
export interface DeletionNativeSession {
  id: string; generation: number; appState: string;
  jobIds: string[]; dispatched: boolean; selectiveErase: false;
  collateral: DeletionSessionCollateral;
}

export interface DeletionPreview {
  id: string; contract: typeof deletePreviewContract;
  projectId: string; scope: DeleteScope;
  projectRevision: number;
  expiresAt: number; createdAt: number;
  affected: {
    /** The scope lineage plus every descendant output (recorded memory derivation or run output). */
    sources: { projectId: string; source: SourceReference; relation: "scope" | "derived_output" | "quoted_copy" }[];
    claims: { projectId: string; reference: ClaimReference }[];
    contexts: { id: string; generation: number; projectId: string; ownerKind: string; ownerId: string }[];
    pendingJobs: { id: string; projectId: string }[];
    nativeSessions: DeletionNativeSession[];
    /**
     * Every recorded whole-store snapshot (bounded by retention); `coverage` when its manifest names affected data.
     * `state` is the verified artifact integrity (never the persisted manifest state), or `unchecked` without a backup dir.
     */
    backups: { id: string; createdAt: number; state: "verified" | "incomplete" | "unchecked"; reason: string | null; evidence: "coverage" | "whole_store_snapshot" }[];
    /** App-owned export artifacts confirmation purges: every non-failed export of an affected project, or a coverage match elsewhere. */
    exports: { id: string; projectId: string; createdAt: number; evidence: "coverage" | "affected_project" }[];
    /**
     * Owner tasks/decisions linked by lineage, lexical overlap or an exact quoted copy of an affected payload, by identity
     * and revision only (no title or other payload is persisted). Deletion never completes or cancels them. An active
     * task or current decision holding a copy is `blocked_owner_copy` (a named blocker until the owner edits, closes or
     * supersedes it); a superseded decision's copy is `redacted`; everything else is `retained_unchanged`.
     */
    obligations: { kind: "task" | "decision"; id: string; revision: number; evidence: "lineage" | "lexical" | "quoted_copy";
      effect: "retained_unchanged" | "blocked_owner_copy" | "redacted" }[];
    /**
     * Task proposal revisions whose exact source generation is affected. Historical (or inactive-task) proposal
     * payloads are redacted; the current proposal of an active task is a named blocker (edit or close the task first).
     */
    taskProposals: { taskId: string; taskState: string; proposalId: string; revision: number; current: boolean;
      evidence: "provenance" | "quoted_text"; effect: "redacted" | "blocked_active_task" }[];
    /**
     * Task completion evidence artifacts whose exact source generation is affected. The latest artifact of an active
     * task decides its readiness, so deleting it would silently downgrade the task: a named blocker until the owner
     * completes, cancels or supersedes the task. Older or closed-task artifacts keep their identity and read unavailable.
     */
    taskEvidence: { taskId: string; taskState: string; taskRevision: number; artifactId: string; revision: number; latest: boolean;
      effect: "blocked_active_task" | "reference_unavailable" }[];
    /**
     * Local delivery copies: linked by provenance (the report's own source generation is affected, including
     * schedule summaries of derived outputs) or holding an exact quoted copy. Confirm deletes the report, cancels
     * unsent intents and redacts local text; sent/unknown intents keep their delivery-state metadata.
     */
    deliveries: { intentId: string; reportId: string; projectId: string; status: string;
      evidence: "provenance" | "quoted_text"; effect: "cancel_and_redact" | "redact_keep_state" }[];
  };
  truncated: { sources: boolean; claims: boolean; contexts: boolean; pendingJobs: boolean; nativeSessions: boolean; backups: boolean; exports: boolean; obligations: boolean; taskProposals: boolean; taskEvidence: boolean; deliveries: boolean };
  /** Required whenever deletion removes a whole native session holding collateral, a shared topic identity or an unresolvable orphan. */
  wholeSession: { required: boolean; reason: string | null; reasons: string[]; sessionScope: string[] };
  /** Named conditions that disable confirmation (truncated/unreadable inventory, scan ceiling). */
  blockers: string[];
  /** Canonical SHA-256 of affected identities, revisions and lifecycle states; confirmation recomputes and compares it. */
  inventoryDigest: string;
  note: string;
}

/** Per-native-context deletion record; completed entries are kept as evidence. */
export interface DeletionContextScope {
  id: string; generation: number;
  state: "pending" | "deleted" | "delete_failed" | "retire_failed" | "missing";
  attempts: number; reason: string | null; nextAction: string; updatedAt: number;
}

/**
 * One app-owned export the operation purges. Format-2 (`sqlite`) artifacts are deleted with their registry and
 * body rows inside the confirm transaction; only format-1 `legacy_file` rows have a file, purged after commit.
 */
export interface DeletionExportScope {
  id: string; projectId: string; storage: "sqlite" | "legacy_file" | "none"; path: string;
  state: "pending" | "purged" | "failed";
  attempts: number; reason: string | null; updatedAt: number;
}

/** Non-native scopes: active-local purge versus retained/external copies this command does not erase. */
export interface DeletionLocalScope {
  scope: "app_store" | "retained_backups" | "local_exports" | "external_copies";
  state: "purged" | "pending" | "failed" | "retained" | "none" | "not_attempted";
  detail: string;
}

export interface DeletionOperation {
  id: string; contract: typeof deleteOperationContract;
  projectId: string; previewId: string; scope: DeleteScope;
  state: "pending" | "complete" | "failed" | "blocked";
  /** Managed-delete passes consumed (automatic reconcile and owner retry share one budget). */
  attempts: number; maxAttempts: number;
  tombstones: DeletionTombstone[];
  contexts: DeletionContextScope[];
  /** App-owned export files holding affected data; the operation is never complete while one remains. */
  exports: DeletionExportScope[];
  scopes: DeletionLocalScope[];
  backupsRetained: string[];
  residuals: string[];
  reason: string | null; nextAction: string;
  createdAt: number; updatedAt: number;
}

/** Trusted service-owned locations the inventory may inspect (never read from persisted JSON). */
export interface DeletionEnvironment { backupDir?: string }

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

/** The durable tombstones for restore replay, ordered by deletion time. Fails closed (`deletion_ledger_unavailable`)
 *  on any current-schema ledger error; only a pre-migration store without the table reads as empty. */
export function readDeletionLedger(tx: AppTransaction): (DeletionTombstone & { operationId: string; deletedAt: number })[] {
  try {
    return tx.all<{ operation_id: string; project_id: string; kind: "source" | "claim"; source_id: string | null;
      claim_id: string | null; revision: number; generation: number; deletedAt: number }>(
      "SELECT operation_id, project_id, kind, source_id, claim_id, revision, generation, deleted_at AS deletedAt FROM deletion_ledger ORDER BY deleted_at, id")
      .map(row => ({ operationId: row.operation_id, projectId: row.project_id, kind: row.kind,
        sourceId: row.source_id, claimId: row.claim_id, revision: row.revision, generation: row.generation, deletedAt: row.deletedAt }));
  } catch (error) { ledgerQueryFailed(tx, error); return []; }
}

export function readDeletionPreview(tx: AppTransaction, projectId: string, previewId: string): DeletionPreview | null {
  requireId(projectId); requireId(previewId);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM deletion_previews WHERE id = ? AND project_id = ?", previewId, projectId);
  return row ? JSON.parse(row.record_json) as DeletionPreview : null;
}

/** Normalizes operations persisted before per-scope records existed; missing evidence reads as pending, never deleted. */
function normalizeOperation(raw: DeletionOperation): DeletionOperation {
  const contexts = (raw.contexts ?? []).map(context => ({
    id: context.id, generation: context.generation,
    state: context.state ?? "pending", attempts: context.attempts ?? 0, reason: context.reason ?? null,
    nextAction: context.nextAction ?? "reconcile_managed_delete_then_verify", updatedAt: context.updatedAt ?? raw.updatedAt,
  } satisfies DeletionContextScope));
  const normalized = { ...raw, contexts, exports: (raw.exports ?? []).map(entry => ({ ...entry, storage: entry.storage ?? "legacy_file" as const })) };
  return { ...normalized, scopes: localScopes(normalized) };
}

function readOperationRow(tx: AppTransaction, operationId: string): DeletionOperation | null {
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM deletion_operations WHERE id = ?", operationId);
  return row ? normalizeOperation(JSON.parse(row.record_json) as DeletionOperation) : null;
}

export function readDeletionOperation(tx: AppTransaction, projectId: string, operationId: string): DeletionOperation | null {
  requireId(projectId); requireId(operationId);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM deletion_operations WHERE id = ? AND project_id = ?", operationId, projectId);
  return row ? normalizeOperation(JSON.parse(row.record_json) as DeletionOperation) : null;
}

export function listDeletionOperations(tx: AppTransaction, projectId: string, limit = 50): DeletionOperation[] {
  requireId(projectId);
  return tx.all<{ record_json: string }>("SELECT record_json FROM deletion_operations WHERE project_id = ? ORDER BY rowid DESC LIMIT ?",
    projectId, Math.min(Math.max(limit, 1), 100)).map(row => normalizeOperation(JSON.parse(row.record_json) as DeletionOperation));
}

function saveOperation(tx: AppTransaction, operation: DeletionOperation): void {
  tx.run("UPDATE deletion_operations SET state = ?, attempts = ?, record_json = ? WHERE id = ?",
    operation.state, operation.attempts, JSON.stringify(operation), operation.id);
}

const validReference = (value: unknown): value is SourceReference => {
  const ref = value as SourceReference | null;
  return !!ref && typeof ref === "object" && typeof ref.sourceId === "string" &&
    Number.isSafeInteger(ref.revision) && Number.isSafeInteger(ref.generation);
};
const sameSource = (a: SourceReference, b: SourceReference) =>
  a.sourceId === b.sourceId && a.revision === b.revision && a.generation === b.generation;
const sourceKey = (s: SourceReference) => `${s.sourceId}:${s.revision}:${s.generation}`;
const contextKey = (c: { id: string; generation: number }) => `${c.id}:${c.generation}`;
const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += deleteInventoryPolicy.chunk) out.push(items.slice(i, i + deleteInventoryPolicy.chunk));
  return out;
};
const marks = (count: number) => Array.from({ length: count }, () => "?").join(",");

/**
 * Pages a whole table by rowid. With a ceiling, a table past `scanRows` records a named blocker
 * instead of silently dropping later rows; mutation passes run without a ceiling.
 */
function scanTable<T>(tx: AppTransaction, table: string, columns: string, visit: (row: T) => void,
  ceiling: { blockers: Set<string> } | null, where = "", params: (string | number)[] = []): void {
  let after = 0, seen = 0;
  for (;;) {
    const rows = tx.all<T & { rowid_: number }>(
      `SELECT rowid AS rowid_, ${columns} FROM ${table} WHERE rowid > ?${where ? ` AND (${where})` : ""} ORDER BY rowid LIMIT ?`,
      after, ...params, deleteInventoryPolicy.page);
    for (const row of rows) {
      if (ceiling && ++seen > deleteInventoryPolicy.scanRows) { ceiling.blockers.add(`inventory_scan_ceiling:${table}`); return; }
      visit(row);
    }
    if (rows.length < deleteInventoryPolicy.page) return;
    after = rows.at(-1)!.rowid_;
  }
}

/** A run/request manifest shape: the only places cited source/claim payload copies live. */
interface ManifestLike { sources: { projectId?: unknown; reference?: unknown; text?: unknown }[]; claims: { projectId?: unknown; claimId?: unknown; text?: unknown }[] }

function manifestsIn(value: unknown, out: ManifestLike[] = [], depth = 0): ManifestLike[] {
  if (depth > 8 || !value || typeof value !== "object") return out;
  if (Array.isArray(value)) { for (const item of value) manifestsIn(item, out, depth + 1); return out; }
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.sources) && Array.isArray(record.claims)) out.push(record as unknown as ManifestLike);
  for (const item of Object.values(record)) if (item && typeof item === "object") manifestsIn(item, out, depth + 1);
  return out;
}

/** Everything one job's durable records say about what it cited, which runs it produced and which native contexts it owns. */
interface JobEvidence {
  jobId: string; projectId: string;
  manifests: ManifestLike[]; runIds: Set<string>;
  contexts: Map<string, { id: string; generation: number }>;
  dispatched: Set<string>;
  extractionSources: SourceReference[];
  /** A run/synthesis/attempt record was unreadable or carried no structurally valid manifest: what it cited is unknown. */
  opaque: boolean;
}

interface ClaimRow { projectId: string; claim: MemoryClaim }
interface SourceEntry { projectId: string; source: SourceReference; relation: "scope" | "derived_output" | "quoted_copy" }
interface ContextRow { id: string; generation: number; projectId: string; ownerKind: string; ownerId: string }

interface Inventory {
  sources: Map<string, SourceEntry>;
  claims: Map<string, ClaimRow>;
  contexts: Map<string, ContextRow>;
  pendingJobs: { id: string; projectId: string; state: string }[];
  sessions: DeletionNativeSession[];
  backups: DeletionPreview["affected"]["backups"];
  exports: DeletionPreview["affected"]["exports"];
  obligations: DeletionPreview["affected"]["obligations"];
  taskProposals: DeletionPreview["affected"]["taskProposals"];
  taskEvidence: DeletionPreview["affected"]["taskEvidence"];
  deliveries: DeletionPreview["affected"]["deliveries"];
  /** Payload texts for the quoted-copy fallback; internal to the transaction, never persisted in a preview. */
  scrub: { long: string[]; short: string[] };
  blockers: Set<string>;
}

function jobEvidence(tx: AppTransaction, blockers: Set<string>): Map<string, JobEvidence> {
  const jobs = new Map<string, JobEvidence>();
  const entry = (jobId: string, projectId: string) => {
    let found = jobs.get(jobId);
    if (!found) {
      found = { jobId, projectId, manifests: [], runIds: new Set(), contexts: new Map(), dispatched: new Set(), extractionSources: [], opaque: false };
      jobs.set(jobId, found);
    }
    return found;
  };
  const addContext = (target: JobEvidence, value: unknown) => {
    const context = value as { id?: unknown; generation?: unknown } | null;
    if (context && typeof context.id === "string" && Number.isSafeInteger(context.generation)) {
      target.contexts.set(contextKey(context as { id: string; generation: number }), { id: context.id, generation: context.generation as number });
    }
  };
  const parse = (table: string, json: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(json) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    } catch { /* Fail closed below. */ }
    blockers.add(`unreadable_record:${table}`);
    return null;
  };
  for (const table of ["team_runs", "coordinator_syntheses"] as const) {
    scanTable<{ id: string; projectId: string; jobId: string; contextId: string; json: string }>(tx, table,
      "id, project_id AS projectId, job_id AS jobId, context_id AS contextId, record_json AS json", row => {
        const target = entry(row.jobId, row.projectId);
        target.contexts.set(`${row.contextId}:1`, { id: row.contextId, generation: 1 });
        if (table === "team_runs") target.runIds.add(row.id);
        const parsed = parse(table, row.json);
        if (!parsed) { target.opaque = true; return; }
        const found = manifestsIn(parsed);
        if (!found.length || !found.every(validManifest)) target.opaque = true;
        target.manifests.push(...found);
        const request = parsed.request as { runId?: unknown } | undefined;
        if (typeof request?.runId === "string") target.runIds.add(request.runId);
      }, { blockers });
  }
  scanTable<{ projectId: string; jobId: string; sourceId: string; revision: number; generation: number; json: string }>(tx, "memory_extractions",
    "project_id AS projectId, job_id AS jobId, source_id AS sourceId, source_revision AS revision, source_generation AS generation, record_json AS json", row => {
      const target = entry(row.jobId, row.projectId);
      target.extractionSources.push({ sourceId: row.sourceId, revision: row.revision, generation: row.generation });
      const parsed = parse("memory_extractions", row.json);
      if (!parsed) { target.opaque = true; return; }
      // The queued request's context is a placeholder; native contexts come only from admitted attempts.
      const found = manifestsIn(parsed.request);
      // The extraction source alone does not prove what else the request cited (dependencies, claims).
      if (!found.length || !found.every(validManifest)) target.opaque = true;
      target.manifests.push(...found);
    }, { blockers });
  scanTable<{ jobId: string; projectId: string | null; json: string }>(tx, "job_attempts",
    "job_id AS jobId, (SELECT project_id FROM jobs WHERE jobs.id = job_attempts.job_id) AS projectId, record_json AS json", row => {
      const parsed = parse("job_attempts", row.json);
      const target = entry(row.jobId, row.projectId ?? "");
      if (!parsed) { target.opaque = true; return; }
      const data = parsed.data as { runId?: unknown } | null | undefined;
      const found = manifestsIn(data);
      // A native run attempt's data is its request: without a valid manifest its session content is unknown.
      if ((parsed.native as { context?: unknown } | null | undefined)?.context && (!found.length || !found.every(validManifest))) target.opaque = true;
      target.manifests.push(...found);
      if (typeof data?.runId === "string") target.runIds.add(data.runId);
      // The attempt's native reference is the authoritative managed session identity.
      const native = (parsed.native as { context?: unknown } | null | undefined)?.context as { id?: unknown; generation?: unknown } | null | undefined;
      addContext(target, native);
      if (parsed.transport && parsed.transport !== "none" && native && typeof native.id === "string" && Number.isSafeInteger(native.generation)) {
        target.dispatched.add(contextKey(native as { id: string; generation: number }));
      }
    }, { blockers });
  return jobs;
}

/** Bounded, structurally valid manifest: every source has an exact reference and every claim an id. */
function validManifest(manifest: ManifestLike): boolean {
  return manifest.sources.length <= 256 && manifest.claims.length <= 256 &&
    manifest.sources.every(s => !!s && validReference(s.reference)) && manifest.claims.every(c => !!c && typeof c.claimId === "string");
}

function cites(manifest: ManifestLike, sources: Map<string, SourceEntry>, claims: Map<string, ClaimRow>): boolean {
  return manifest.sources.some(s => validReference(s?.reference) && sources.has(sourceKey(s.reference))) ||
    manifest.claims.some(c => typeof c?.claimId === "string" && claims.has(c.claimId));
}

function jobCites(job: JobEvidence, sources: Map<string, SourceEntry>, claims: Map<string, ClaimRow>): boolean {
  return job.extractionSources.some(s => sources.has(sourceKey(s))) || job.manifests.some(m => cites(m, sources, claims));
}

function addDerived(tx: AppTransaction, sources: Map<string, SourceEntry>, row: { sourceId: string; projectId: string; revision: number; generation: number }): void {
  const ref = { sourceId: row.sourceId, revision: row.revision, generation: row.generation };
  if (sources.has(sourceKey(ref)) || deletedSource(tx, ref)) return;
  sources.set(sourceKey(ref), { projectId: row.projectId, source: ref, relation: "derived_output" });
}

/**
 * Builds the complete affected inventory for one lineage: claims (direct plus dependency/conflict
 * closure), memory contexts, descendant outputs (recorded memory derivation and run outputs, resolved
 * by lineage, not text), citing jobs and their managed native sessions, retained copies and obligations.
 * Unreadable rows and scan ceilings become named blockers; nothing relevant is silently omitted.
 */
function buildInventory(tx: AppTransaction, scope: DeleteScope, env: DeletionEnvironment = {}): Inventory {
  const blockers = new Set<string>();
  const lineage: SourceReference = { ...scope.source };
  const sources = new Map<string, SourceEntry>([[sourceKey(lineage), { projectId: scope.projectId, source: lineage, relation: "scope" }]]);
  const claims = new Map<string, ClaimRow>();
  const contexts = new Map<string, ContextRow>();
  const claimRows: ClaimRow[] = [];
  scanTable<{ projectId: string; json: string }>(tx, "memory_claims", "project_id AS projectId, record_json AS json", row => {
    try {
      const claim = JSON.parse(row.json) as MemoryClaim;
      if (typeof claim?.claimId !== "string") throw new Error("unreadable");
      claimRows.push({ projectId: row.projectId, claim });
    } catch { blockers.add("unreadable_record:memory_claims"); }
  }, { blockers });
  const jobs = jobEvidence(tx, blockers);
  const intents = deliveryIntentRows(tx, blockers);
  const occurrenceLinks: { output: SourceReference; intentId: string }[] = [];
  scanTable<{ json: string }>(tx, "job_schedule_occurrences", "record_json AS json", row => {
    try {
      const occurrence = JSON.parse(row.json) as { outputSource?: unknown; deliveryIntentId?: unknown };
      if (validReference(occurrence.outputSource) && typeof occurrence.deliveryIntentId === "string") {
        occurrenceLinks.push({ output: occurrence.outputSource, intentId: occurrence.deliveryIntentId });
      }
    } catch { blockers.add("unreadable_record:job_schedule_occurrences"); }
  }, { blockers });
  const ownerTaskTexts = ownerTextCopySources(tx);
  const payloadTexts: string[] = [], textSeen = new Set<string>();
  for (let round = 0; ; round++) {
    if (round >= deleteInventoryPolicy.closureRounds) { blockers.add("inventory_closure_ceiling"); break; }
    const before = sources.size + claims.size;
    for (let grew = true; grew;) {
      grew = false;
      for (const entry of claimRows) {
        if (claims.has(entry.claim.claimId)) continue;
        const direct = validReference(entry.claim.source) && sources.has(sourceKey(entry.claim.source));
        const related = [...(entry.claim.dependencies ?? []), ...(entry.claim.conflicts ?? [])].some(ref => claims.has(ref?.claimId));
        if (direct || related) { claims.set(entry.claim.claimId, entry); grew = true; }
      }
    }
    const sourceIds = new Map<string, number[]>();
    for (const entry of sources.values()) sourceIds.set(entry.source.sourceId, [...(sourceIds.get(entry.source.sourceId) ?? []), entry.source.revision]);
    const lookups: [string, string[]][] = [["source", [...sourceIds.keys()]], ["claim", [...claims.keys()]]];
    for (const [kind, ids] of lookups) {
      for (const batch of chunks(ids)) {
        for (const row of tx.all<ContextRow & { entryId: string; revision: number }>(
          `SELECT c.id, c.project_id AS projectId, c.owner_kind AS ownerKind, c.owner_id AS ownerId, e.entry_id AS entryId, e.revision
           FROM memory_context_entries e JOIN memory_contexts c ON c.id = e.context_id WHERE e.kind = ? AND e.entry_id IN (${marks(batch.length)})`,
          kind, ...batch)) {
          if (kind === "source" && !sourceIds.get(row.entryId)?.includes(row.revision)) continue;
          contexts.set(row.id, { id: row.id, generation: 1, projectId: row.projectId, ownerKind: row.ownerKind, ownerId: row.ownerId });
        }
      }
    }
    for (const batch of chunks([...contexts.keys()])) {
      for (const row of tx.all<{ sourceId: string; projectId: string; revision: number; generation: number }>(
        `SELECT d.source_id AS sourceId, d.project_id AS projectId, s.current_revision AS revision, s.generation
         FROM memory_derived_sources d JOIN sources s ON s.id = d.source_id WHERE d.context_id IN (${marks(batch.length)})`, ...batch)) addDerived(tx, sources, row);
    }
    const runIds = new Set<string>();
    for (const job of jobs.values()) if (jobCites(job, sources, claims)) for (const runId of job.runIds) runIds.add(runId);
    for (const batch of chunks([...runIds])) {
      for (const row of tx.all<{ sourceId: string; projectId: string; revision: number; generation: number }>(
        `SELECT s.id AS sourceId, s.project_id AS projectId, v.revision, v.generation FROM source_versions v JOIN sources s ON s.id = v.source_id
         WHERE s.kind = 'output' AND json_extract(v.attribution_json, '$.runId') IN (${marks(batch.length)})`, ...batch)) addDerived(tx, sources, row);
    }
    // A schedule summary of an affected output was delivered through its own report source: that copy is a descendant.
    for (const link of occurrenceLinks) {
      const intent = intents.get(link.intentId);
      if (intent && sources.has(sourceKey(link.output))) addDerived(tx, sources, { projectId: intent.projectId, ...intent.source });
    }
    // A source committed from owner task/decision wording that quotes an affected payload verbatim is a copy of it.
    if (ownerTaskTexts.length) {
      const long = (value: unknown) => typeof value === "string" && value !== redactedText && Array.from(value).length >= deleteScrubPolicy.minChars;
      for (const entry of sources.values()) {
        if (textSeen.has(`s:${sourceKey(entry.source)}`)) continue;
        textSeen.add(`s:${sourceKey(entry.source)}`);
        const text = sourceText(tx, entry.source);
        if (long(text)) payloadTexts.push(text);
      }
      for (const entry of claims.values()) {
        if (textSeen.has(`c:${entry.claim.claimId}`)) continue;
        textSeen.add(`c:${entry.claim.claimId}`);
        for (const value of [entry.claim.text, entry.claim.quote]) if (long(value)) payloadTexts.push(value as string);
      }
      for (const owned of ownerTaskTexts) {
        const key = sourceKey(owned.source);
        if (sources.has(key) || deletedSource(tx, owned.source) || !payloadTexts.some(text => owned.text.includes(text))) continue;
        sources.set(key, { projectId: owned.projectId, source: owned.source, relation: "quoted_copy" });
      }
    }
    if (sources.size + claims.size === before) break;
  }
  const citing = [...jobs.values()].filter(job => jobCites(job, sources, claims));
  const pendingJobs: Inventory["pendingJobs"] = [];
  for (const job of citing) {
    const row = tx.get<{ state: string; projectId: string }>("SELECT state, project_id AS projectId FROM jobs WHERE id = ?", job.jobId);
    if (row && ["queued", "admitted", "waiting"].includes(row.state)) pendingJobs.push({ id: job.jobId, projectId: row.projectId, state: row.state });
  }
  const sessions = new Map<string, DeletionNativeSession & { claimKeys: Set<string>; sourceKeys: Set<string> }>();
  for (const job of citing) {
    for (const context of job.contexts.values()) {
      const key = contextKey(context);
      let session = sessions.get(key);
      if (!session) {
        const appState = tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", context.id, context.generation)?.state ?? "missing";
        session = { id: context.id, generation: context.generation, appState, jobIds: [], dispatched: false, selectiveErase: false,
          collateral: { sources: [], claims: [] }, claimKeys: new Set(), sourceKeys: new Set() };
        sessions.set(key, session);
      }
      if (!session.jobIds.includes(job.jobId)) session.jobIds.push(job.jobId);
      if (job.dispatched.has(key)) session.dispatched = true;
      for (const manifest of job.manifests) {
        for (const s of manifest.sources) {
          if (!validReference(s?.reference) || sources.has(sourceKey(s.reference)) || session.sourceKeys.has(sourceKey(s.reference))) continue;
          session.sourceKeys.add(sourceKey(s.reference));
          session.collateral.sources.push({ projectId: typeof s.projectId === "string" ? s.projectId : job.projectId,
            source: { sourceId: s.reference.sourceId, revision: s.reference.revision, generation: s.reference.generation } });
        }
        for (const c of manifest.claims) {
          if (typeof c?.claimId !== "string" || claims.has(c.claimId) || session.claimKeys.has(c.claimId)) continue;
          session.claimKeys.add(c.claimId);
          session.collateral.claims.push({ projectId: typeof c.projectId === "string" ? c.projectId : job.projectId, claimId: c.claimId });
        }
      }
    }
  }
  const allSources = [...sources.values()];
  const inventory: Inventory = {
    sources, claims, contexts, pendingJobs,
    sessions: [...sessions.values()].map(({ claimKeys: _c, sourceKeys: _s, ...session }) => session),
    backups: retainedBackups(tx, allSources, blockers, env),
    exports: retainedExports(tx, allSources, [...claims.values()], blockers),
    obligations: obligationsFor(tx, scope, allSources, blockers),
    taskProposals: taskProposalsFor(tx, allSources, blockers),
    taskEvidence: taskEvidenceFor(tx, allSources, blockers),
    deliveries: [],
    scrub: { long: [], short: [] },
    blockers,
  };
  inventory.scrub = payloadNeedles(tx, allSources, [...claims.values()], inventory.taskProposals);
  if (inventory.scrub.long.length > deleteScrubPolicy.maxTerms) blockers.add("scrub_set_exceeds_bound");
  else for (const blocker of unreadableScrubTargets(tx, inventory.scrub.long)) blockers.add(blocker);
  const keys = new Set(allSources.map(entry => sourceKey(entry.source)));
  for (const intent of intents.values()) {
    const linked = keys.has(sourceKey(intent.source));
    if (!linked && !inventory.scrub.long.some(term => intent.text.includes(term))) continue;
    inventory.deliveries.push({ intentId: intent.id, reportId: intent.reportId, projectId: intent.projectId, status: intent.status,
      evidence: linked ? "provenance" : "quoted_text", effect: TERMINAL_DELIVERY.has(intent.status) ? "redact_keep_state" : "cancel_and_redact" });
  }
  if (inventory.scrub.short.length && shortPayloadCopied(tx, inventory.scrub.short, keys, new Set(citing.map(job => job.jobId)),
    new Set(inventory.deliveries.map(d => d.intentId)), new Set(inventory.deliveries.map(d => d.reportId)))) blockers.add("short_payload_unlinked_copy");
  ownerCopies(tx, inventory);
  // Lists confirmation acts on (or the owner must see in full) block when they exceed display bounds; backups are disclosure only.
  const sizes: [string, number, number][] = [["sources", sources.size, deletePreviewBounds.sources], ["claims", claims.size, deletePreviewBounds.claims],
    ["contexts", contexts.size, deletePreviewBounds.contexts], ["pendingJobs", pendingJobs.length, deletePreviewBounds.pendingJobs],
    ["nativeSessions", inventory.sessions.length, deletePreviewBounds.nativeSessions], ["exports", inventory.exports.length, deletePreviewBounds.exports],
    ["obligations", inventory.obligations.length, deletePreviewBounds.obligations],
    ["taskProposals", inventory.taskProposals.length, deletePreviewBounds.taskProposals],
    ["taskEvidence", inventory.taskEvidence.length, deletePreviewBounds.taskEvidence],
    ["deliveries", inventory.deliveries.length, deletePreviewBounds.deliveries]];
  for (const [name, size, bound] of sizes) if (size > bound) blockers.add(`inventory_truncated:${name}`);
  return inventory;
}

/** Settled transport outcomes the outbox never cancels (`cancelUnsent`); deletion only redacts their text. */
const TERMINAL_DELIVERY: ReadonlySet<string> = new Set(["sent", "unknown", "failed"]);

interface DeliveryIntentRow { id: string; projectId: string; reportId: string; status: string; text: string; source: SourceReference }

function deliveryIntentRows(tx: AppTransaction, blockers: Set<string>): Map<string, DeliveryIntentRow> {
  const out = new Map<string, DeliveryIntentRow>();
  scanTable<{ id: string; projectId: string; json: string }>(tx, "delivery_intents", "id, project_id AS projectId, record_json AS json", row => {
    try {
      const intent = JSON.parse(row.json) as { status: string; payload: { text: string };
        provenance: { reportId: string; sourceId: string; sourceRevision: number; sourceGeneration: number } };
      const source = { sourceId: intent.provenance.sourceId, revision: intent.provenance.sourceRevision, generation: intent.provenance.sourceGeneration };
      if (!validReference(source) || typeof intent.payload?.text !== "string" || typeof intent.provenance.reportId !== "string") throw new Error("unreadable");
      out.set(row.id, { id: row.id, projectId: row.projectId, reportId: intent.provenance.reportId, status: intent.status, text: intent.payload.text, source });
    } catch { blockers.add("unreadable_record:delivery_intents"); }
  }, { blockers });
  return out;
}

/** Every affected payload text (sources, claim text/quote, redacted task proposals), split at the quoted-copy threshold. */
function payloadNeedles(tx: AppTransaction, sources: SourceEntry[], claims: ClaimRow[], proposals: DeletionPreview["affected"]["taskProposals"]): Inventory["scrub"] {
  const all = new Set<string>();
  const add = (value: unknown) => { if (typeof value === "string" && value.length > 0 && value !== redactedText) all.add(value); };
  for (const entry of sources) add(sourceText(tx, entry.source));
  for (const entry of claims) { add(entry.claim.text); add(entry.claim.quote); }
  for (const proposal of proposals.filter(p => p.effect === "redacted")) {
    const row = tx.get<{ title: string; summary: string }>("SELECT title, summary FROM task_proposals WHERE id = ?", proposal.proposalId);
    add(row?.title); add(row?.summary);
  }
  const sorted = [...all].sort();
  return { long: sorted.filter(v => Array.from(v).length >= deleteScrubPolicy.minChars), short: sorted.filter(v => Array.from(v).length < deleteScrubPolicy.minChars) };
}

/**
 * Whether a short payload (too short to scrub without over-redaction) appears in a record that provenance-based
 * cleanup does not cover: unrelated outputs, deliveries, proposals or job records of non-citing jobs.
 */
function shortPayloadCopied(tx: AppTransaction, short: string[], affected: Set<string>, citingJobs: Set<string>, intents: Set<string>, reports: Set<string>): boolean {
  const forms = short.flatMap(term => [term, JSON.stringify(term).slice(1, -1)]);
  const hit = (text: string | null) => !!text && forms.some(term => text.includes(term));
  let found = false;
  const visit = <T,>(table: string, columns: string, test: (row: T) => boolean, where = "") => {
    if (!found) scanTable<T>(tx, table, columns, row => { if (!found && test(row)) found = true; }, null, where);
  };
  visit<{ sourceId: string; revision: number; generation: number; text: string }>("source_versions", "source_id AS sourceId, revision, generation, content_text AS text",
    row => !affected.has(sourceKey(row)) && hit(row.text), "content_text IS NOT NULL AND source_id IN (SELECT id FROM sources WHERE kind = 'output')");
  visit<{ id: string; json: string }>("delivery_intents", "id, record_json AS json", row => !intents.has(row.id) && hit(row.json));
  visit<{ id: string; json: string }>("delivery_reports", "id, record_json AS json", row => !reports.has(row.id) && hit(row.json));
  visit<{ sourceId: string; revision: number; generation: number; json: string }>("decision_proposals",
    "source_id AS sourceId, source_revision AS revision, source_generation AS generation, record_json AS json", row => !affected.has(sourceKey(row)) && hit(row.json));
  visit<{ id: string; json: string }>("jobs", "id, record_json AS json", row => !citingJobs.has(row.id) && hit(row.json));
  for (const table of ["job_attempts", "team_runs", "coordinator_syntheses"]) {
    visit<{ jobId: string; json: string }>(table, "job_id AS jobId, record_json AS json", row => !citingJobs.has(row.jobId) && hit(row.json));
  }
  // Owner task/decision text is never partially scrubbed for a short payload: an unlinked copy there blocks too.
  visit<{ sourceId: string; revision: number; generation: number; text: string }>("task_proposals",
    "source_id AS sourceId, source_revision AS revision, source_generation AS generation, title || char(10) || summary AS text", row => !affected.has(sourceKey(row)) && hit(row.text));
  visit<{ text: string }>("owner_decisions", "conclusion || char(10) || rationale AS text", row => hit(row.text));
  return found;
}

function obligationsFor(tx: AppTransaction, scope: DeleteScope, sources: SourceEntry[], blockers: Set<string>): DeletionPreview["affected"]["obligations"] {
  const out = new Map<string, DeletionPreview["affected"]["obligations"][number]>();
  const add = (kind: "task" | "decision", id: string, revision: number, evidence: "lineage" | "lexical") => {
    if (!out.has(`${kind}:${id}`) || evidence === "lineage") out.set(`${kind}:${id}`, { kind, id, revision, evidence, effect: "retained_unchanged" });
  };
  const active = "state IN ('proposed', 'accepted', 'ready_for_review')";
  for (const batch of chunks([...new Set(sources.map(s => s.source.sourceId))])) {
    for (const row of tx.all<{ id: string; revision: number }>(
      `SELECT id, task_revision AS revision FROM tasks WHERE ${active} AND source_id IN (${marks(batch.length)})`, ...batch)) add("task", row.id, row.revision, "lineage");
    for (const row of tx.all<{ id: string; revision: number }>(
      `SELECT d.id, d.revision FROM owner_decisions d JOIN decision_proposals p ON p.id = d.proposal_id
       WHERE d.superseded_by IS NULL AND p.source_id IN (${marks(batch.length)})`, ...batch)) add("decision", row.id, row.revision, "lineage");
  }
  // Lexical overlap is disclosure only; every active row is checked, not a prefix.
  const query = lexicalTerms(sourceText(tx, scope.source));
  scanTable<{ id: string; title: string; summary: string; revision: number }>(tx, "tasks", "id, title, summary, task_revision AS revision", row => {
    if (lexicalScore(query, `${row.title}\n${row.summary}`) >= 3) add("task", row.id, row.revision, "lexical");
  }, { blockers }, `project_id = ? AND ${active}`, [scope.projectId]);
  scanTable<{ id: string; conclusion: string; rationale: string; revision: number }>(tx, "owner_decisions", "id, conclusion, rationale, revision", row => {
    if (lexicalScore(query, `${row.conclusion}\n${row.rationale}`) >= 3) add("decision", row.id, row.revision, "lexical");
  }, { blockers }, "project_id = ? AND superseded_by IS NULL", [scope.projectId]);
  return [...out.values()];
}

/**
 * Owner topic sources committed from owner task/decision wording, in any project, by exact reference and whatever
 * their availability (supersession only fences a decision source; its payload stays until deleted): the text source
 * of an `origin: "owner"` task proposal, and the `memory_decision_sources` source of an owner decision.
 */
function ownerTextCopySources(tx: AppTransaction): { projectId: string; source: SourceReference; text: string }[] {
  const out = new Map<string, { projectId: string; source: SourceReference; text: string }>();
  const collect = (sql: string) => {
    for (const row of tx.all<{ sourceId: string; projectId: string; revision: number; generation: number; text: string }>(sql)) {
      const source = { sourceId: row.sourceId, revision: row.revision, generation: row.generation };
      out.set(sourceKey(source), { projectId: row.projectId, source, text: row.text });
    }
  };
  collect(`SELECT p.source_id AS sourceId, s.project_id AS projectId, p.source_revision AS revision, p.source_generation AS generation, v.content_text AS text
     FROM task_proposals p JOIN sources s ON s.id = p.source_id
     JOIN source_versions v ON v.source_id = p.source_id AND v.revision = p.source_revision AND v.generation = p.source_generation
     WHERE p.origin = 'owner' AND v.content_text IS NOT NULL`);
  try {
    collect(`SELECT d.source_id AS sourceId, d.project_id AS projectId, d.source_revision AS revision, d.source_generation AS generation, v.content_text AS text
       FROM memory_decision_sources d
       JOIN source_versions v ON v.source_id = d.source_id AND v.revision = d.source_revision AND v.generation = d.source_generation
       WHERE v.content_text IS NOT NULL`);
  } catch (error) { if (!(error instanceof Error) || !/no such table/.test(error.message)) throw error; }
  return [...out.values()];
}

const activeTaskStates = ["proposed", "accepted", "ready_for_review"];
/** Whether owner text holds an exact copy of any long affected payload (also across the joined fields). */
const holdsCopy = (terms: string[], fields: string[]) => terms.some(term => fields.join("\n").includes(term));
/** Replaces every long payload copy in owner text; a copy spanning fields redacts all of them. */
function replaceTerms(terms: string[], fields: string[]): string[] {
  const next = fields.map(field => terms.reduce((text, term) => text.includes(term) ? text.split(term).join(redactedText) : text, field));
  return holdsCopy(terms, next) ? next.map(() => redactedText) : next;
}

/**
 * Long payload texts of affected sources and claims. Unlike the scrub set it excludes redacted proposal text, so an
 * owner's current task wording that merely survives from an older revision is not mistaken for a deleted copy.
 */
function ownerCopyTerms(tx: AppTransaction, inventory: Pick<Inventory, "sources" | "claims">): string[] {
  const all = new Set<string>();
  const add = (value: unknown) => {
    if (typeof value === "string" && value !== redactedText && Array.from(value).length >= deleteScrubPolicy.minChars) all.add(value);
  };
  for (const entry of inventory.sources.values()) add(sourceText(tx, entry.source));
  for (const entry of inventory.claims.values()) { add(entry.claim.text); add(entry.claim.quote); }
  return [...all].sort();
}

/**
 * Owner task/decision copies of the affected payload set (exact, at least `minChars`), in any project. A task
 * proposal is a copy when its title/summary quote a payload; the current proposal of an active task is the existing
 * `active_task_current_proposal` blocker, any other is redacted at confirm. A current decision quoting a payload adds
 * `owner_decision_copy:<id>`; a superseded one is redacted. Nothing payload-bearing enters the preview.
 */
function ownerCopies(tx: AppTransaction, inventory: Inventory): void {
  const terms = ownerCopyTerms(tx, inventory);
  const linked = new Set(inventory.taskProposals.map(p => p.proposalId));
  const mark = (kind: "task" | "decision", id: string, revision: number, effect: "blocked_owner_copy" | "redacted",
    evidence: "lineage" | "quoted_copy" = "quoted_copy") => {
    const at = inventory.obligations.findIndex(o => o.kind === kind && o.id === id);
    const entry = { kind, id, revision, evidence, effect };
    if (at >= 0) inventory.obligations[at] = entry; else inventory.obligations.push(entry);
  };
  // A blocked current proposal (linked by provenance) is an owner task copy too: disclose its obligation as blocked.
  for (const proposal of inventory.taskProposals.filter(p => p.effect === "blocked_active_task")) {
    const row = tx.get<{ title: string; summary: string; revision: number }>(
      "SELECT p.title, p.summary, t.task_revision AS revision FROM task_proposals p JOIN tasks t ON t.id = p.task_id WHERE p.id = ?", proposal.proposalId);
    if (row) mark("task", proposal.taskId, row.revision, "blocked_owner_copy", holdsCopy(terms, [row.title, row.summary]) ? "quoted_copy" : "lineage");
  }
  if (!terms.length) return;
  scanTable<{ id: string; taskId: string; revision: number; title: string; summary: string }>(tx, "task_proposals",
    "id, task_id AS taskId, revision, title, summary", row => {
      if (linked.has(row.id) || !holdsCopy(terms, [row.title, row.summary])) return;
      const task = tx.get<{ state: string; currentId: string; revision: number }>(
        "SELECT state, current_proposal_id AS currentId, task_revision AS revision FROM tasks WHERE id = ?", row.taskId);
      const current = task?.currentId === row.id, active = activeTaskStates.includes(task?.state ?? "");
      const effect = current && active ? "blocked_active_task" as const : "redacted" as const;
      if (effect === "blocked_active_task") {
        inventory.blockers.add(`active_task_current_proposal:${row.taskId}`);
        mark("task", row.taskId, task!.revision, "blocked_owner_copy");
      }
      inventory.taskProposals.push({ taskId: row.taskId, taskState: task?.state ?? "missing", proposalId: row.id, revision: row.revision,
        current, evidence: "quoted_text", effect });
    }, { blockers: inventory.blockers });
  scanTable<{ id: string; revision: number; conclusion: string; rationale: string; supersededBy: string | null }>(tx, "owner_decisions",
    "id, revision, conclusion, rationale, superseded_by AS supersededBy", row => {
      if (!holdsCopy(terms, [row.conclusion, row.rationale])) return;
      if (row.supersededBy === null) inventory.blockers.add(`owner_decision_copy:${row.id}`);
      mark("decision", row.id, row.revision, row.supersededBy === null ? "blocked_owner_copy" : "redacted");
    }, { blockers: inventory.blockers });
}

/** Every task proposal revision (current or historical) citing an affected exact source generation. */
function taskProposalsFor(tx: AppTransaction, sources: SourceEntry[], blockers: Set<string>): DeletionPreview["affected"]["taskProposals"] {
  const keys = new Set(sources.map(entry => sourceKey(entry.source)));
  const out: DeletionPreview["affected"]["taskProposals"] = [];
  for (const batch of chunks([...new Set(sources.map(entry => entry.source.sourceId))])) {
    for (const row of tx.all<{ id: string; taskId: string; revision: number; sourceId: string; sourceRevision: number; sourceGeneration: number;
      state: string | null; currentId: string | null }>(
      `SELECT p.id, p.task_id AS taskId, p.revision, p.source_id AS sourceId, p.source_revision AS sourceRevision, p.source_generation AS sourceGeneration,
         t.state, t.current_proposal_id AS currentId FROM task_proposals p LEFT JOIN tasks t ON t.id = p.task_id
       WHERE p.source_id IN (${marks(batch.length)})`, ...batch)) {
      if (!keys.has(sourceKey({ sourceId: row.sourceId, revision: row.sourceRevision, generation: row.sourceGeneration }))) continue;
      const current = row.currentId === row.id;
      const active = ["proposed", "accepted", "ready_for_review"].includes(row.state ?? "");
      const effect = current && active ? "blocked_active_task" as const : "redacted" as const;
      if (effect === "blocked_active_task") blockers.add(`active_task_current_proposal:${row.taskId}`);
      out.push({ taskId: row.taskId, taskState: row.state ?? "missing", proposalId: row.id, revision: row.revision, current, evidence: "provenance", effect });
    }
  }
  return out;
}

/** Every task evidence artifact citing an affected exact source generation; the latest one of an active task blocks. */
function taskEvidenceFor(tx: AppTransaction, sources: SourceEntry[], blockers: Set<string>): DeletionPreview["affected"]["taskEvidence"] {
  const keys = new Set(sources.map(entry => sourceKey(entry.source)));
  const out: DeletionPreview["affected"]["taskEvidence"] = [];
  for (const batch of chunks([...new Set(sources.map(entry => entry.source.sourceId))])) {
    for (const row of tx.all<{ id: string; taskId: string; revision: number; sourceId: string; sourceRevision: number; sourceGeneration: number;
      state: string | null; taskRevision: number | null; latestRevision: number }>(
      `SELECT e.id, e.task_id AS taskId, e.revision, e.source_id AS sourceId, e.source_revision AS sourceRevision, e.source_generation AS sourceGeneration,
         t.state, t.task_revision AS taskRevision,
         (SELECT max(l.revision) FROM task_evidence_artifacts l WHERE l.task_id = e.task_id) AS latestRevision
       FROM task_evidence_artifacts e LEFT JOIN tasks t ON t.id = e.task_id
       WHERE e.source_id IN (${marks(batch.length)})`, ...batch)) {
      if (!keys.has(sourceKey({ sourceId: row.sourceId, revision: row.sourceRevision, generation: row.sourceGeneration }))) continue;
      const latest = row.revision === row.latestRevision;
      const active = ["proposed", "accepted", "ready_for_review"].includes(row.state ?? "");
      const effect = latest && active ? "blocked_active_task" as const : "reference_unavailable" as const;
      if (effect === "blocked_active_task") blockers.add(`active_task_evidence:${row.taskId}`);
      out.push({ taskId: row.taskId, taskState: row.state ?? "missing", taskRevision: row.taskRevision ?? 0, artifactId: row.id,
        revision: row.revision, latest, effect });
    }
  }
  return out;
}

/**
 * Backups are whole-store snapshots and retention is bounded, so every recorded backup is listed as possibly
 * retaining the data; manifest coverage (a bounded prefix) and wall-clock order are never proof of absence.
 * Unreadable manifests are named blockers.
 */
function retainedBackups(tx: AppTransaction, sources: SourceEntry[], blockers: Set<string>, env: DeletionEnvironment): DeletionPreview["affected"]["backups"] {
  const keys = new Set(sources.map(s => sourceKey(s.source)));
  const items: DeletionPreview["affected"]["backups"] = [];
  try {
    scanTable<{ json: string }>(tx, "ops_backups", "record_json AS json", row => {
      let manifest;
      try { manifest = validateManifestRecord(JSON.parse(row.json)); } catch { blockers.add("unreadable_record:ops_backups"); return; }
      const listed = Array.isArray(manifest.sourceGenerations) && manifest.sourceGenerations.some(s => validReference(s) && keys.has(sourceKey(s)));
      let state: "verified" | "incomplete" | "unchecked" = "unchecked", reason: string | null = "integrity_not_verified";
      if (env.backupDir) {
        try {
          const verdict = verifyBackupArtifacts(manifest, env.backupDir);
          state = verdict.state === "verified" ? "verified" : "incomplete"; reason = verdict.reason;
        } catch { state = "incomplete"; reason = "manifest_unverifiable"; }
      }
      items.push({ id: manifest.id, createdAt: manifest.createdAt, state, reason, evidence: listed ? "coverage" : "whole_store_snapshot" });
    }, { blockers });
  } catch (error) { if (!(error instanceof Error) || !/no such table/.test(error.message)) throw error; }
  return items;
}

/**
 * App-owned export artifacts confirmation purges: every non-failed export of an affected project, plus any other
 * export whose coverage names affected data. Export coverage describes resolver-emitted sources only, while raw
 * task/proposal/decision text is serialized too, so complete-but-nonmatching coverage is never proof of absence;
 * exports are regenerable and retention-bounded. Failed exports published no artifact.
 */
function retainedExports(tx: AppTransaction, sources: SourceEntry[], claims: ClaimRow[], blockers: Set<string>): DeletionPreview["affected"]["exports"] {
  const keys = new Set(sources.map(s => sourceKey(s.source)));
  const claimIds = new Set(claims.map(c => c.claim.claimId));
  const projects = new Set([...sources.map(entry => entry.projectId), ...claims.map(entry => entry.projectId)]);
  const items: DeletionPreview["affected"]["exports"] = [];
  try {
    scanTable<{ id: string; projectId: string }>(tx, "export_artifacts", "id, project_id AS projectId", row => {
      let manifest;
      try { manifest = readExportManifest(tx, row.projectId, row.id); }
      catch { blockers.add("unreadable_record:export_artifacts"); return; }
      if (manifest.state === "failed") return;
      const coverage = manifest.coverage as { sources?: SourceReference[]; claims?: { claimId: string }[] } | undefined;
      const listed = (Array.isArray(coverage?.sources) && coverage.sources.some(s => validReference(s) && keys.has(sourceKey(s)))) ||
        (Array.isArray(coverage?.claims) && coverage.claims.some(c => claimIds.has(c?.claimId)));
      if (listed || projects.has(row.projectId)) {
        items.push({ id: row.id, projectId: row.projectId, createdAt: manifest.createdAt, evidence: listed ? "coverage" : "affected_project" });
      }
    }, { blockers });
  } catch (error) { if (!(error instanceof Error) || !/no such table/.test(error.message)) throw error; }
  return items;
}

/**
 * Removes one export registration and its SQLite body in the caller transaction. Format-2 artifacts are gone
 * when this commits; a format-1 `legacy_file` row returns its recorded path for the post-commit file purge.
 */
function dropExportRegistration(tx: AppTransaction, projectId: string, id: string, now: number, reason: string): DeletionExportScope {
  let storage: DeletionExportScope["storage"] = "none", path = "";
  try {
    const manifest = readExportManifest(tx, projectId, id);
    if (manifest.artifact?.storage === "legacy_file") { storage = "legacy_file"; path = manifest.artifact.path; }
    else if (manifest.artifact?.storage === "sqlite") storage = "sqlite";
  } catch {
    // Unparseable rows cannot prove where their bytes are: treat as a legacy file so purge fails closed.
    storage = "legacy_file";
  }
  try { tx.run("DELETE FROM export_artifact_bodies WHERE id = ?", id); }
  catch (error) { if (!(error instanceof Error) || !/no such table/.test(error.message)) throw error; }
  tx.run("DELETE FROM export_artifacts WHERE id = ?", id);
  return storage === "legacy_file"
    ? { id, projectId, storage, path, state: "pending", attempts: 0, reason, updatedAt: now }
    : { id, projectId, storage, path: "", state: "purged", attempts: 0, reason: null, updatedAt: now };
}

/** Whole-session requirement: shared topic identity, unresolvable orphans, or dispatched sessions holding collateral. */
function wholeSessionFor(tx: AppTransaction, scope: DeleteScope, sessions: DeletionNativeSession[]): DeletionPreview["wholeSession"] {
  const reasons: string[] = [], sessionScope: string[] = [];
  const descriptor = tx.get<{ descriptor: string }>("SELECT descriptor_json AS descriptor FROM source_versions WHERE source_id = ? AND revision = ? AND generation = ?",
    scope.source.sourceId, scope.source.revision, scope.source.generation);
  let descriptorKind = "message";
  try { descriptorKind = (JSON.parse(descriptor?.descriptor ?? "{}") as { kind?: string }).kind ?? "message"; } catch { /* Identity stays descriptive. */ }
  if (descriptorKind === "topic") { reasons.push("topic_identity_shared"); sessionScope.push(`topic:${scope.source.sourceId}`); }
  const live = sessions.filter(session => session.appState !== "deleted");
  const missing = live.filter(session => session.appState === "missing");
  if (missing.length) {
    reasons.push("native_orphan_unresolvable");
    for (const session of missing) sessionScope.push(`context:${contextKey(session)}`);
  }
  const shared = live.filter(session => session.appState !== "missing" && session.dispatched &&
    (session.collateral.sources.length > 0 || session.collateral.claims.length > 0));
  if (shared.length) {
    reasons.push("native_session_collateral");
    for (const session of shared) {
      sessionScope.push(`context:${contextKey(session)}`);
      for (const s of session.collateral.sources) sessionScope.push(`source:${s.projectId}/${sourceKey(s.source)}`);
      for (const c of session.collateral.claims) sessionScope.push(`claim:${c.projectId}/${c.claimId}`);
    }
  }
  return { required: reasons.length > 0, reason: reasons[0] ?? null, reasons, sessionScope };
}

/** Canonical digest of everything confirmation acts on; any identity, revision or lifecycle change forces a fresh preview. */
function inventoryDigest(tx: AppTransaction, scope: DeleteScope, inventory: Inventory, wholeSession: DeletionPreview["wholeSession"]): string {
  const sorted = (items: string[]) => [...items].sort();
  const availability = (entry: SourceEntry) => tx.get<{ availability: string }>("SELECT availability FROM sources WHERE id = ?", entry.source.sourceId)?.availability ?? "missing";
  const canonical = {
    scope: `${scope.projectId}/${sourceKey(scope.source)}`,
    sources: sorted([...inventory.sources.values()].map(e => `${e.projectId}/${sourceKey(e.source)}/${e.relation}/${availability(e)}`)),
    claims: sorted([...inventory.claims.values()].map(e => `${e.projectId}/${e.claim.claimId}:${e.claim.revision}:${e.claim.generation}/${e.claim.status}`)),
    contexts: sorted([...inventory.contexts.keys()]),
    pendingJobs: sorted(inventory.pendingJobs.map(j => `${j.id}/${j.state}`)),
    sessions: sorted(inventory.sessions.map(s => `${contextKey(s)}/${s.appState}/${s.dispatched}/${sorted(s.jobIds).join(",")}/` +
      `${sorted(s.collateral.sources.map(c => sourceKey(c.source))).join(",")}/${sorted(s.collateral.claims.map(c => c.claimId)).join(",")}`)),
    obligations: sorted(inventory.obligations.map(o => `${o.kind}/${o.id}/${o.revision}/${o.evidence}/${o.effect}`)),
    taskProposals: sorted(inventory.taskProposals.map(p => `${p.taskId}/${p.proposalId}/${p.revision}/${p.taskState}/${p.current}/${p.evidence}/${p.effect}`)),
    taskEvidence: sorted(inventory.taskEvidence.map(e => `${e.taskId}/${e.taskRevision}/${e.taskState}/${e.artifactId}/${e.revision}/${e.latest}/${e.effect}`)),
    deliveries: sorted(inventory.deliveries.map(d => `${d.intentId}/${d.reportId}/${d.status}/${d.evidence}`)),
    backups: sorted(inventory.backups.map(b => `${b.id}/${b.state}`)),
    exports: sorted(inventory.exports.map(e => e.id)),
    blockers: sorted([...inventory.blockers]),
    wholeSession: sorted(wholeSession.sessionScope),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

const deleteNote = "การลบถอน source ต้นฉบับ output ที่สืบทอดจากมัน เนื้อความ derived ที่อ้างมัน บริบทที่บันทึกไว้และ native session ที่เกี่ยวข้องออกจาก local serving ทั้งหมด " +
  "native session ลบได้ทั้ง session เท่านั้น งานที่รับรอง มติ และการตั้งค่าไม่ถูกเปลี่ยนโดยปริยาย สำรองข้อมูลเดิมยังเก็บข้อมูลที่ถูกลบตาม retention ของมัน ส่วน Telegram/provider copies ไม่ได้ถูกลบโดยคำสั่งนี้ และไม่ใช่การลบเชิง forensic";

function sourceText(tx: AppTransaction, lineage: SourceReference): string {
  const row = tx.get<{ text: string | null }>("SELECT content_text AS text FROM source_versions WHERE source_id = ? AND revision = ? AND generation = ?",
    lineage.sourceId, lineage.revision, lineage.generation);
  return row?.text ?? "";
}

function bounded<T>(items: T[], bound: number): { items: T[]; truncated: boolean } {
  return { items: items.slice(0, bound), truncated: items.length > bound };
}

/**
 * app.data_lifecycle/v1 preview: revision-bound, expiring deletion preview over the complete affected
 * inventory, with an inventory digest and named blockers. Nothing mutates; the owner confirms separately.
 */
export function prepareDeletionPreview(tx: AppTransaction, command: DeletePreviewCommand, projectRevision: number, now: number, env: DeletionEnvironment = {}): DeletionPreview {
  deleteCommandIdentity(command, 65536);
  const scope = command.payload.scope;
  if (projectRevision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  if (deletedSource(tx, scope.source)) throw new AppError("memory_already_deleted", 409);
  const current = tx.get<{ revision: number; generation: number; availability: string }>(
    "SELECT current_revision AS revision, generation, availability FROM sources WHERE id = ? AND project_id = ?",
    scope.source.sourceId, scope.projectId);
  if (!current) throw new AppError("source_not_found", 404);
  if (current.revision !== scope.source.revision || current.generation !== scope.source.generation) {
    throw new AppError("memory_delete_stale_scope", 409);
  }
  if (current.availability !== "available") throw new AppError("memory_delete_unavailable", 409);
  const inventory = buildInventory(tx, scope, env);
  const sources = bounded([...inventory.sources.values()], deletePreviewBounds.sources);
  const claims = bounded([...inventory.claims.values()], deletePreviewBounds.claims);
  const contexts = bounded([...inventory.contexts.values()], deletePreviewBounds.contexts);
  const pendingJobs = bounded(inventory.pendingJobs, deletePreviewBounds.pendingJobs);
  const sessions = bounded(inventory.sessions, deletePreviewBounds.nativeSessions);
  const backups = bounded(inventory.backups, deletePreviewBounds.backups);
  const exports = bounded(inventory.exports, deletePreviewBounds.exports);
  const obligations = bounded(inventory.obligations, deletePreviewBounds.obligations);
  const taskProposals = bounded(inventory.taskProposals, deletePreviewBounds.taskProposals);
  const taskEvidence = bounded(inventory.taskEvidence, deletePreviewBounds.taskEvidence);
  const deliveries = bounded(inventory.deliveries, deletePreviewBounds.deliveries);
  const wholeSession = wholeSessionFor(tx, scope, inventory.sessions);
  const preview: DeletionPreview = {
    id: crypto.randomUUID(), contract: deletePreviewContract,
    projectId: command.projectId, scope: { kind: "source", projectId: scope.projectId, source: { ...scope.source } },
    projectRevision, expiresAt: now + deletePolicy.previewMs, createdAt: now,
    affected: {
      sources: sources.items.map(entry => ({ projectId: entry.projectId, source: { ...entry.source }, relation: entry.relation })),
      claims: claims.items.map(entry => ({ projectId: entry.projectId,
        reference: { claimId: entry.claim.claimId, revision: entry.claim.revision, generation: entry.claim.generation } })),
      contexts: contexts.items.map(c => ({ ...c })),
      pendingJobs: pendingJobs.items.map(job => ({ id: job.id, projectId: job.projectId })),
      nativeSessions: sessions.items,
      backups: backups.items,
      exports: exports.items,
      obligations: obligations.items,
      taskProposals: taskProposals.items,
      taskEvidence: taskEvidence.items,
      deliveries: deliveries.items,
    },
    truncated: { sources: sources.truncated, claims: claims.truncated, contexts: contexts.truncated, pendingJobs: pendingJobs.truncated,
      nativeSessions: sessions.truncated, backups: backups.truncated, exports: exports.truncated, obligations: obligations.truncated,
      taskProposals: taskProposals.truncated, taskEvidence: taskEvidence.truncated, deliveries: deliveries.truncated },
    wholeSession,
    blockers: [...inventory.blockers].sort(),
    inventoryDigest: inventoryDigest(tx, scope, inventory, wholeSession),
    note: deleteNote,
  };
  tx.run("INSERT INTO deletion_previews (id, project_id, expires_at, record_json) VALUES (?, ?, ?, ?)",
    preview.id, command.projectId, preview.expiresAt, JSON.stringify(preview));
  return preview;
}

/** Replaces quoted copies of just-purged payloads in committed model outputs and delivery
 *  reports (kind `output` lineage). Owner message/topic sources are never rewritten here. */
export function scrubOutputSources(tx: AppTransaction, needles: string[]): void {
  const terms = [...new Set(needles.filter(n => n.length > 0))].sort();
  if (!terms.length) return;
  scanTable<{ sourceId: string; revision: number; generation: number; text: string }>(tx, "source_versions",
    "source_id AS sourceId, revision, generation, content_text AS text", row => {
      let next = row.text;
      for (const term of terms) if (next.includes(term)) next = next.split(term).join(redactedText);
      if (next !== row.text) {
        tx.run("UPDATE source_versions SET content_text = ? WHERE source_id = ? AND revision = ? AND generation = ?",
          next, row.sourceId, row.revision, row.generation);
      }
    }, null, "content_text IS NOT NULL AND source_id IN (SELECT id FROM sources WHERE kind = 'output')");
}

/** JSON records that may quote a purged payload without durable provenance (the quoted-copy fallback targets). */
const FREE_TEXT_TABLES = [["team_runs", "record_json"], ["coordinator_syntheses", "record_json"], ["jobs", "record_json"],
  ["job_attempts", "record_json"], ["decision_proposals", "record_json"], ["command_receipts", "result_json"]] as const;
/** Keys whose string values are structural identifiers or enums, never quoted payload; they are never rewritten. */
const STRUCTURAL_KEY = /^(?:id|ids|kind|type|state|status|code|reason_code)$|(?:Id|Ids|_id|_ids)$/;

/** Raw and JSON-escaped forms of every non-empty term (escaped forms reach JSON nested inside string values). */
const scrubForms = (needles: string[]) =>
  [...new Set(needles.filter(n => n.length > 0).flatMap(n => [n, JSON.stringify(n).slice(1, -1)]))].sort();

/**
 * Replaces every term inside string values only, recursively. Object keys, numbers, booleans and
 * values under structural keys ({@link STRUCTURAL_KEY}) are preserved, so a payload equal to a schema
 * key such as `projectId` can never corrupt a record's structure.
 */
function redactStringValues(value: unknown, terms: string[], key: string | null = null): unknown {
  // app.role_proposals/v1 records follow their typed rule: Jit text only, routes and owner revisions untouched.
  const rewrite = (text: string) => terms.reduce((next, term) => next.includes(term) ? next.split(term).join(redactedText) : next, text);
  if (key === "roleProposals") return redactRoleProposals(value, rewrite).value;
  // A role.proposal.* receipt snapshot: owner revisions stay exact so a replay matches what accept would save.
  if (key === "proposal" && isRoleProposalView(value)) return redactRoleProposalView(value, rewrite).value;
  if (typeof value === "string") {
    if (key !== null && STRUCTURAL_KEY.test(key)) return value;
    let next = value;
    for (const term of terms) if (next.includes(term)) next = next.split(term).join(redactedText);
    return next;
  }
  if (Array.isArray(value)) return value.map(item => redactStringValues(item, terms, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, redactStringValues(item, terms, name)]));
  }
  return value;
}

/**
 * Names (`unreadable_record:<table>`) every quoted-copy target table holding a record that mentions a
 * term but is not parseable JSON. Deletion previews add these as blockers, because such a record can
 * only be redacted by raw substring replacement, which this module never does.
 */
export function unreadableScrubTargets(tx: AppTransaction, needles: string[]): string[] {
  const terms = scrubForms(needles);
  const out = new Set<string>();
  if (!terms.length) return [];
  for (const [table, column] of FREE_TEXT_TABLES) {
    try {
      scanTable<{ json: string }>(tx, table, `${column} AS json`, row => {
        if (out.has(`unreadable_record:${table}`) || !terms.some(term => row.json.includes(term))) return;
        try { JSON.parse(row.json); } catch { out.add(`unreadable_record:${table}`); }
      }, null);
    } catch (error) {
      if (!(error instanceof Error) || !/no such table/.test(error.message)) throw error;
    }
  }
  return [...out].sort();
}

/** Replaces quoted copies of just-purged payloads in committed model outputs, job/attempt records, model-generated
 *  proposals and command receipts; owner tasks/decisions are handled by the inventory. Each record is parsed and
 *  only its string values are rewritten ({@link redactStringValues}); a record that mentions a term but is not
 *  parseable JSON is never raw-replaced: this throws `unreadable_record` (previews block on it first). */
export function scrubFreeTextOccurrences(tx: AppTransaction, needles: string[]): void {
  const terms = scrubForms(needles);
  if (!terms.length) return;
  for (const [table, column] of FREE_TEXT_TABLES) {
    try {
      scanTable<{ json: string }>(tx, table, `${column} AS json`, row => {
        if (!terms.some(term => row.json.includes(term))) return;
        let parsed: unknown;
        try { parsed = JSON.parse(row.json); } catch { throw new AppError("unreadable_record", 409, { table }); }
        const next = JSON.stringify(redactStringValues(parsed, terms));
        if (next !== JSON.stringify(parsed)) tx.run(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`, next, (row as unknown as { rowid_: number }).rowid_);
      }, null);
    } catch (error) {
      // Older quarantined schemas may predate a table; a missing table holds no copy.
      if (!(error instanceof Error) || !/no such table/.test(error.message)) throw error;
    }
  }
}

function scrubManifestTexts(value: unknown, sources: Set<string>, claims: Set<string>): unknown {
  if (Array.isArray(value)) return value.map(item => scrubManifestTexts(item, sources, claims));
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  if (Array.isArray(record.sources) && Array.isArray(record.claims)) {
    return Object.fromEntries(Object.entries({
      ...record,
      sources: (record.sources as { reference?: SourceReference; text?: unknown }[]).map(source =>
        validReference(source?.reference) && sources.has(sourceKey(source.reference)) ? { ...source, text: redactedText } : source),
      claims: (record.claims as { claimId?: unknown; text?: unknown }[]).map(claim =>
        typeof claim?.claimId === "string" && claims.has(claim.claimId) ? { ...claim, text: redactedText } : claim),
    }).map(([key, item]) => [key, key === "sources" || key === "claims" ? item : scrubManifestTexts(item, sources, claims)]));
  }
  return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, scrubManifestTexts(item, sources, claims)]));
}

/** Redacts cited payload copies in every durable manifest holder, including job attempts the owner job API reads. */
function scrubStoredManifests(tx: AppTransaction, sources: Set<string>, claims: Set<string>): void {
  for (const table of ["memory_extractions", "team_runs", "coordinator_syntheses", "job_attempts"] as const) {
    scanTable<{ json: string; rowid_: number }>(tx, table, "record_json AS json", row => {
      let parsed: unknown;
      try { parsed = JSON.parse(row.json); } catch { return; }
      const scrubbed = JSON.stringify(scrubManifestTexts(parsed, sources, claims));
      if (scrubbed !== JSON.stringify(parsed)) tx.run(`UPDATE ${table} SET record_json = ? WHERE rowid = ?`, scrubbed, row.rowid_);
    }, null);
  }
}

function scrubConversationReceipts(tx: AppTransaction, sources: SourceEntry[], claimIds: Set<string>): void {
  const keys = new Set(sources.map(s => sourceKey(s.source)));
  for (const entry of sources) {
    scanTable<{ request_id: string; result: string }>(tx, "command_receipts", "request_id, result_json AS result", row => {
      let parsed: unknown;
      try { parsed = JSON.parse(row.result); } catch { return; }
      let changed = false;
      const visit = (node: unknown): unknown => {
        if (Array.isArray(node)) return node.map(visit);
        if (!node || typeof node !== "object") return node;
        const record = node as Record<string, unknown>;
        const source = record.source as SourceReference | undefined;
        if (validReference(source) && keys.has(sourceKey(source))) {
          changed = true;
          const next = { ...record };
          if ("text" in next) next.text = null;
          if ("title" in next) next.title = null;
          if ("summary" in next) next.summary = null;
          if ("availability" in next) next.availability = "unavailable";
          return Object.fromEntries(Object.entries(next).map(([key, item]) => [key, key === "source" ? item : visit(item)]));
        }
        // Run-manifest entries carry `reference`/`claimId` instead of `source`; match them by deleted identity.
        if ("text" in record && ((validReference(record.reference) && keys.has(sourceKey(record.reference))) ||
            (typeof record.claimId === "string" && claimIds.has(record.claimId)))) {
          changed = true;
          return { ...record, text: redactedText };
        }
        return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, visit(item)]));
      };
      const scrubbed = visit(parsed);
      if (changed) tx.run("UPDATE command_receipts SET result_json = ? WHERE request_id = ?", JSON.stringify(scrubbed), row.request_id);
    }, null, "result_json LIKE ?", [`%${entry.source.sourceId}%`]);
  }
}

/** Replaces the local payload text of one delivery report and its intent; status, attempts and provenance stay. */
function redactDeliveryText(tx: AppTransaction, intentId: string, reportId: string): void {
  const intent = tx.get<{ json: string }>("SELECT record_json AS json FROM delivery_intents WHERE id = ?", intentId);
  if (intent) {
    const parsed = JSON.parse(intent.json) as { payload: { text: string } };
    tx.run("UPDATE delivery_intents SET record_json = ? WHERE id = ?", JSON.stringify({ ...parsed, payload: { ...parsed.payload, text: redactedText } }), intentId);
  }
  const report = tx.get<{ json: string }>("SELECT record_json AS json FROM delivery_reports WHERE id = ?", reportId);
  if (report) tx.run("UPDATE delivery_reports SET record_json = ? WHERE id = ?", JSON.stringify({ ...JSON.parse(report.json), text: redactedText }), reportId);
}

/**
 * Redacts the producing run's copies of each purged derived output (run outcome/progress, and the
 * structured proposal artifact rendered from a synthesis output), matched by lineage rather than text.
 */
function redactDerivedRuns(tx: AppTransaction, sources: SourceEntry[]): void {
  const runOf = (entry: SourceEntry) => tx.get<{ runId: string | null }>(
    "SELECT json_extract(attribution_json, '$.runId') AS runId FROM source_versions WHERE source_id = ? AND revision = ? AND generation = ?",
    entry.source.sourceId, entry.source.revision, entry.source.generation)?.runId;
  const derived = sources.filter(entry => entry.relation === "derived_output");
  const runIds = new Set<string>(), replyRunIds = new Set<string>(), purgedReplies = new Set<string>();
  for (const entry of sources) {
    const runId = runOf(entry);
    if (typeof runId !== "string") continue;
    if (entry.relation === "derived_output") runIds.add(runId);
    // app.role_proposals/v1: a Jit reply output purged in any relation (also the owner's own scope) takes the
    // proposals parsed from it, so its cards cannot outlive the deleted reply.
    replyRunIds.add(runId);
  }
  for (const table of runIds.size || replyRunIds.size ? ["team_runs", "coordinator_syntheses"] as const : []) {
    scanTable<{ json: string; rowid_: number }>(tx, table, "record_json AS json", row => {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(row.json) as Record<string, unknown>; } catch { return; }
      const runId = (parsed.request as { runId?: unknown } | undefined)?.runId;
      const matches = (ids: Set<string>) => ids.has(parsed.id as string) || (typeof runId === "string" && ids.has(runId));
      if (!matches(runIds) && !(table === "team_runs" && parsed.kind === "jit_reply" && matches(replyRunIds))) return;
      if (parsed.kind === "jit_reply" && Array.isArray(parsed.roleProposals) && parsed.roleProposals.length) purgedReplies.add(parsed.id as string);
      const outcome = parsed.outcome as { output?: unknown } | null | undefined;
      const proposals = redactRoleProposals(parsed.roleProposals, () => redactedText);
      const next = { ...parsed, ...(outcome && typeof outcome.output === "string" ? { outcome: { ...outcome, output: redactedText } } : {}),
        ...("progress" in parsed ? { progress: null } : {}), ...(proposals.changed ? { roleProposals: proposals.value } : {}) };
      if (JSON.stringify(next) !== JSON.stringify(parsed)) tx.run(`UPDATE ${table} SET record_json = ? WHERE rowid = ?`, JSON.stringify(next), row.rowid_);
    }, null);
  }
  // The `proposal` snapshots in role.proposal.* receipts of those replies take the same lineage rule, so a replay
  // cannot return text the record no longer holds; owner revisions and routes stay exact.
  for (const replyId of purgedReplies) {
    scanTable<{ json: string; rowid_: number }>(tx, "command_receipts", "result_json AS json", row => {
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(row.json) as Record<string, unknown>; } catch { return; }
      if (!isRoleProposalView(parsed.proposal) || parsed.proposal.replyId !== replyId) return;
      const view = redactRoleProposalView(parsed.proposal, () => redactedText);
      if (view.changed) tx.run("UPDATE command_receipts SET result_json = ? WHERE rowid = ?", JSON.stringify({ ...parsed, proposal: view.value }), row.rowid_);
    }, null, "result_json LIKE ?", [`%${replyId}%`]);
  }
  for (const entry of derived) {
    for (const row of tx.all<{ id: string; json: string }>("SELECT id, record_json AS json FROM decision_proposals WHERE source_id = ? AND source_revision = ? AND source_generation = ?",
      entry.source.sourceId, entry.source.revision, entry.source.generation)) {
      try {
        const artifact = JSON.parse(row.json) as { question?: unknown; options?: { label?: unknown; rationale?: unknown }[] };
        const next = { ...artifact, question: redactedText,
          options: (artifact.options ?? []).map(option => ({ ...option, label: redactedText, rationale: redactedText })) };
        tx.run("UPDATE decision_proposals SET record_json = ? WHERE id = ?", JSON.stringify(next), row.id);
      } catch { /* Unreadable artifacts expose nothing parseable; their source is already unavailable. */ }
    }
  }
}

function localScopes(operation: Pick<DeletionOperation, "tombstones" | "backupsRetained" | "exports">): DeletionLocalScope[] {
  const sources = operation.tombstones.filter(t => t.kind === "source").length, claims = operation.tombstones.length - sources;
  const exports = operation.exports;
  const exportState: DeletionLocalScope["state"] = !exports.length ? "none" : exports.some(e => e.state === "failed") ? "failed"
    : exports.some(e => e.state === "pending") ? "pending" : "purged";
  return [
    { scope: "app_store", state: "purged", detail: `${sources} source generations and ${claims} claims purged; manifests, attempts and receipts redacted` },
    operation.backupsRetained.length
      ? { scope: "retained_backups", state: "retained", detail: `${operation.backupsRetained.length} backups may keep the deleted data until retention purge` }
      : { scope: "retained_backups", state: "none", detail: "no recorded backup was taken after this data was committed" },
    { scope: "local_exports", state: exportState, detail: exports.length
      ? `${exports.filter(e => e.state === "purged").length}/${exports.length} affected export artifacts purged` : "no local export holds this data" },
    { scope: "external_copies", state: "not_attempted", detail: "Telegram delivery and provider session copies are not deleted by this command" },
  ];
}

/**
 * app.data_lifecycle/v1 confirm: recomputes the inventory and rejects a changed digest (stale preview)
 * or any blocker, then fences affected attempts and native contexts before purging app payloads,
 * descendants and cached copies, writes identity-only tombstones and opens a per-scope operation.
 * Native sessions are deleted only through the managed run-port lifecycle (reconcile).
 */
export function confirmDeletion(tx: AppTransaction, command: DeleteConfirmCommand, projectRevision: number, now: number, env: DeletionEnvironment = {}): DeletionConfirmReceipt {
  deleteCommandIdentity(command, 65536);
  const preview = readDeletionPreview(tx, command.projectId, command.payload.previewId);
  if (!preview || preview.projectId !== command.projectId) throw new AppError("memory_delete_stale_preview", 409);
  // A duplicate confirmation is the same logical operation: it is answered before expiry, revision,
  // acknowledgement and scope checks, which only gate creating a new operation.
  const existing = tx.get<{ record_json: string }>("SELECT record_json FROM deletion_operations WHERE preview_id = ? AND project_id = ?",
    preview.id, command.projectId);
  if (existing) return { operation: normalizeOperation(JSON.parse(existing.record_json) as DeletionOperation), duplicate: true };
  if (now > preview.expiresAt) throw new AppError("memory_delete_stale_preview", 409);
  if (projectRevision !== command.expectedRevision || projectRevision !== preview.projectRevision) {
    throw new AppError("memory_delete_stale_preview", 409);
  }
  if (!command.payload.acknowledged) throw new AppError("memory_delete_ambiguous", 409);
  if (preview.wholeSession.required && !command.payload.acknowledgedWholeSession) throw new AppError("memory_delete_ambiguous", 409);
  const lineage = preview.scope.source;
  if (deletedSource(tx, lineage)) throw new AppError("memory_already_deleted", 409);
  const current = tx.get<{ revision: number; generation: number; availability: string }>(
    "SELECT current_revision AS revision, generation, availability FROM sources WHERE id = ? AND project_id = ?",
    lineage.sourceId, preview.scope.projectId);
  if (!current || current.revision !== lineage.revision || current.generation !== lineage.generation || current.availability !== "available") {
    throw new AppError("memory_delete_stale_preview", 409);
  }
  const inventory = buildInventory(tx, preview.scope, env);
  if (typeof preview.inventoryDigest !== "string" ||
      inventoryDigest(tx, preview.scope, inventory, wholeSessionFor(tx, preview.scope, inventory.sessions)) !== preview.inventoryDigest) {
    throw new AppError("memory_delete_stale_preview", 409);
  }
  if (preview.blockers?.length || inventory.blockers.size) throw new AppError("memory_delete_blocked", 409);
  const sources = [...inventory.sources.values()];
  const claimEntries = [...inventory.claims.values()];
  const claimIds = new Set(inventory.claims.keys());
  // Owner copy terms are read before any payload is purged.
  const ownerTerms = ownerCopyTerms(tx, inventory);
  // Fence first: pending/in-flight attempts lose commit authority and native contexts stop accepting replay.
  for (const job of inventory.pendingJobs) invalidatePendingJob(tx, job.projectId, job.id, "source_retired", now);
  const sessions = inventory.sessions.filter(session => session.appState !== "deleted");
  for (const session of sessions) {
    tx.run("UPDATE team_contexts SET state = 'retired' WHERE id = ? AND generation = ? AND state = 'active'", session.id, session.generation);
  }
  // Purge app-owned payloads of the scope and every descendant output; identity rows stay so references resolve as unavailable.
  for (const entry of sources) {
    tx.run("UPDATE source_versions SET content_text = NULL WHERE source_id = ? AND revision = ? AND generation = ?",
      entry.source.sourceId, entry.source.revision, entry.source.generation);
    tx.run("UPDATE sources SET availability = 'unavailable' WHERE id = ? AND project_id = ? AND current_revision = ? AND generation = ?",
      entry.source.sourceId, entry.projectId, entry.source.revision, entry.source.generation);
  }
  for (const entry of claimEntries) {
    try {
      const stored = tx.get<{ record_json: string }>("SELECT record_json FROM memory_claims WHERE id = ? AND project_id = ?",
        entry.claim.claimId, entry.projectId)?.record_json;
      if (stored) {
        const claim = JSON.parse(stored) as MemoryClaim;
        if (claim.status !== "deleted" || claim.text !== redactedText) {
          tx.run("UPDATE memory_claims SET record_json = ? WHERE id = ? AND project_id = ?",
            JSON.stringify({ ...claim, status: "deleted", text: redactedText, quote: redactedText }),
            entry.claim.claimId, entry.projectId);
        }
      }
    } catch { /* Identity tombstones below still deny every lifecycle consumer. */ }
  }
  // Retained task proposal copies of a deleted source generation lose their payload; inactive tasks whose
  // current proposal it was lose the mirrored title/summary. Active current proposals were blockers above.
  for (const proposal of inventory.taskProposals.filter(p => p.effect === "redacted")) {
    let title = redactedText, summary = redactedText;
    if (proposal.evidence === "quoted_text") {
      const row = tx.get<{ title: string; summary: string }>("SELECT title, summary FROM task_proposals WHERE id = ?", proposal.proposalId);
      if (row) [title, summary] = replaceTerms(ownerTerms, [row.title, row.summary]) as [string, string];
    }
    tx.run("UPDATE task_proposals SET title = ?, summary = ? WHERE id = ?", title, summary, proposal.proposalId);
    if (proposal.current) tx.run("UPDATE tasks SET title = ?, summary = ? WHERE id = ? AND current_proposal_id = ?", title, summary, proposal.taskId, proposal.proposalId);
  }
  // Superseded owner decisions quoting the payload lose the copy; current ones were blockers above.
  for (const decision of inventory.obligations.filter(o => o.kind === "decision" && o.effect === "redacted")) {
    const row = tx.get<{ conclusion: string; rationale: string }>("SELECT conclusion, rationale FROM owner_decisions WHERE id = ?", decision.id);
    if (!row) continue;
    const [conclusion, rationale] = replaceTerms(ownerTerms, [row.conclusion, row.rationale]) as [string, string];
    tx.run("UPDATE owner_decisions SET conclusion = ?, rationale = ? WHERE id = ?", conclusion, rationale, decision.id);
  }
  redactDerivedRuns(tx, sources);
  scrubStoredManifests(tx, new Set(sources.map(entry => sourceKey(entry.source))), claimIds);
  scrubConversationReceipts(tx, sources, claimIds);
  // Local delivery copies: delete the report (cancelling unsent intents), then redact the local payload text
  // while sent/unknown/failed intents keep their delivery-state metadata.
  for (const delivery of inventory.deliveries) {
    try {
      const report = readDeliveryReport(tx, delivery.projectId, delivery.reportId);
      if (report.availability === "available") retireDeliveryReport(tx, delivery.projectId, delivery.reportId, "delete", report.revision, now);
    } catch (error) { if (!(error instanceof AppError) || error.code !== "delivery_report_not_found") throw error; }
    redactDeliveryText(tx, delivery.intentId, delivery.reportId);
  }
  // Quoted-copy fallback: the complete (blocker-bounded) payload set, in deterministic chunks.
  for (let i = 0; i < inventory.scrub.long.length; i += deleteScrubPolicy.chunk) {
    const chunk = inventory.scrub.long.slice(i, i + deleteScrubPolicy.chunk);
    scrubFreeTextOccurrences(tx, chunk);
    scrubOutputSources(tx, chunk);
  }
  // Purged sources/claims now fence any remaining automatic context or extraction that cited them.
  fenceStaleContexts(tx, now);
  for (const project of new Set([...sources.map(entry => entry.projectId), ...claimEntries.map(entry => entry.projectId)])) {
    fenceUnavailableExtractions(tx, project, now);
  }
  const operationId = crypto.randomUUID();
  const tombstones: DeletionTombstone[] = [
    ...sources.map(entry => ({ kind: "source" as const, projectId: entry.projectId, sourceId: entry.source.sourceId as string | null, claimId: null as string | null,
      revision: entry.source.revision, generation: entry.source.generation })),
    ...claimEntries.map(entry => ({ kind: "claim" as const, projectId: entry.projectId, sourceId: null as string | null,
      claimId: entry.claim.claimId as string | null, revision: entry.claim.revision, generation: entry.claim.generation })),
  ];
  for (const tombstone of tombstones) {
    tx.run("INSERT OR IGNORE INTO deletion_ledger (id, operation_id, project_id, kind, source_id, claim_id, revision, generation, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
      crypto.randomUUID(), operationId, tombstone.projectId, tombstone.kind, tombstone.sourceId, tombstone.claimId,
      tombstone.revision, tombstone.generation, now);
  }
  // App-owned exports: SQLite artifacts (registry + body rows) are deleted in this transaction; format-1
  // legacy files are purged right after commit.
  const exports = inventory.exports.map(entry => dropExportRegistration(tx, entry.projectId, entry.id, now, "awaiting_legacy_file_purge"));
  const contexts: DeletionContextScope[] = sessions.map(session => ({
    id: session.id, generation: session.generation,
    state: session.appState === "missing" ? "missing" : "pending", attempts: 0,
    reason: session.appState === "missing" ? "native_context_missing" : "awaiting_managed_delete",
    nextAction: "reconcile_managed_delete_then_verify", updatedAt: now,
  }));
  const backupsRetained = inventory.backups.map(backup => backup.id);
  const operation: DeletionOperation = aggregate({
    id: operationId, contract: deleteOperationContract,
    projectId: command.projectId, previewId: preview.id,
    scope: { kind: "source", projectId: preview.scope.projectId, source: { ...lineage } },
    state: "pending", attempts: 0, maxAttempts: deletePolicy.maxAttempts,
    tombstones, contexts, exports, scopes: [],
    backupsRetained,
    residuals: ["telegram_delivery_copies_not_deleted", "provider_session_copies_not_deleted", "retained_backups_require_retention_purge"],
    reason: null, nextAction: "", createdAt: now, updatedAt: now,
  }, now);
  tx.run("INSERT INTO deletion_operations (id, project_id, preview_id, state, attempts, record_json) VALUES (?, ?, ?, ?, ?, ?)",
    operation.id, command.projectId, preview.id, operation.state, 0, JSON.stringify(operation));
  return { operation, duplicate: false };
}

/** Derives the operation state from its per-scope records; never claims completion beyond deleted/purged evidence. */
function aggregate(raw: DeletionOperation, now: number): DeletionOperation {
  const operation = { ...raw, exports: raw.exports ?? [] };
  const scoped = (next: DeletionOperation) => ({ ...next, scopes: localScopes(next), updatedAt: now });
  const native = operation.contexts.filter(context => context.state !== "deleted");
  const files = operation.exports.filter(entry => entry.state !== "purged");
  if (!native.length && !files.length) return scoped({ ...operation, state: "complete", reason: null, nextAction: "inspect_completed_deletion" });
  if (native.length && operation.attempts >= operation.maxAttempts) {
    return scoped({ ...operation, state: "failed", reason: "retry_budget_exhausted", nextAction: "inspect_blocked_scope_and_retry_manually" });
  }
  if (files.some(entry => entry.state === "failed")) {
    return scoped({ ...operation, state: "failed", reason: "export_purge_failed", nextAction: "remove_export_artifact_manually_then_verify" });
  }
  if (native.some(context => context.state !== "pending")) {
    return scoped({ ...operation, state: "blocked", reason: "native_delete_blocked_or_missing", nextAction: "retry_managed_delete" });
  }
  return native.length
    ? scoped({ ...operation, state: "pending", reason: "native_sessions_pending_managed_delete", nextAction: "reconcile_managed_delete_then_verify" })
    : scoped({ ...operation, state: "pending", reason: "local_exports_pending_purge", nextAction: "purge_local_exports" });
}

/** Marks scopes whose context the managed lifecycle already deleted (by another operation or adapter) as deleted. */
function syncDeletedContexts(tx: AppTransaction, operation: DeletionOperation, now: number): DeletionOperation {
  return { ...operation, contexts: operation.contexts.map(context => context.state !== "deleted" &&
    tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", context.id, context.generation)?.state === "deleted"
    ? { ...context, state: "deleted" as const, reason: null, nextAction: "none", updatedAt: now } : context) };
}

/**
 * Owner retry: re-arms a pending/blocked operation for the next managed-delete pass without consuming
 * budget itself; the pass reserves the attempt. An exhausted budget stays failed. Never resurrects purged payloads.
 */
export function retryDeletion(tx: AppTransaction, command: DeleteRetryCommand, now: number): DeletionOperation {
  deleteCommandIdentity(command, 65536);
  const operation = readDeletionOperation(tx, command.projectId, command.payload.operationId);
  if (!operation || operation.projectId !== command.projectId) throw new AppError("deletion_not_found", 404);
  if (operation.state === "complete") return operation;
  const synced = aggregate(syncDeletedContexts(tx, operation, now), now);
  if (synced.state === "complete" || synced.state === "failed") { saveOperation(tx, synced); return synced; }
  const retried: DeletionOperation = { ...synced, state: "pending", reason: "retry_requested", nextAction: "reconcile_managed_delete_then_verify", updatedAt: now };
  saveOperation(tx, retried);
  return retried;
}

/** Recomputes one operation from live native state without consuming budget or dispatching anything. */
export function refreshOperationState(tx: AppTransaction, operationId: string, now: number): DeletionOperation | null {
  const operation = readOperationRow(tx, operationId);
  if (!operation || operation.state === "complete") return operation;
  const refreshed = aggregate(syncDeletedContexts(tx, operation, now), now);
  saveOperation(tx, refreshed);
  return refreshed;
}

/** Atomically reserves one budgeted pass; refuses at the budget and persists retry_budget_exhausted. */
function reservePass(tx: AppTransaction, operationId: string, now: number): { operation: DeletionOperation | null; dispatch: DeletionContextScope[] } {
  const operation = readOperationRow(tx, operationId);
  if (!operation || operation.state === "complete" || operation.state === "failed") return { operation, dispatch: [] };
  const synced = aggregate(syncDeletedContexts(tx, operation, now), now);
  if (synced.state === "complete" || synced.state === "failed" || synced.contexts.every(context => context.state === "deleted")) {
    saveOperation(tx, synced); return { operation: synced, dispatch: [] };
  }
  const reserved: DeletionOperation = {
    ...synced, attempts: synced.attempts + 1,
    contexts: synced.contexts.map(context => context.state === "deleted" ? context
      : { ...context, attempts: context.attempts + 1, nextAction: "await_managed_delete", updatedAt: now }),
    reason: "managed_delete_in_progress", nextAction: "await_managed_delete", updatedAt: now,
  };
  saveOperation(tx, reserved);
  return { operation: reserved, dispatch: reserved.contexts.filter(context => context.state !== "deleted") };
}

type PassOutcome = { id: string; generation: number; state: DeletionContextScope["state"]; reason: string | null; nextAction: string };

function settlePass(tx: AppTransaction, operationId: string, outcomes: PassOutcome[], now: number): DeletionOperation | null {
  const operation = readOperationRow(tx, operationId);
  if (!operation) return null;
  const byKey = new Map(outcomes.map(outcome => [contextKey(outcome), outcome]));
  const updated = syncDeletedContexts(tx, { ...operation, contexts: operation.contexts.map(context => {
    const outcome = byKey.get(contextKey(context));
    return outcome && context.state !== "deleted"
      ? { ...context, state: outcome.state, reason: outcome.reason, nextAction: outcome.nextAction, updatedAt: now } : context;
  }) }, now);
  const settled = aggregate(updated, now);
  saveOperation(tx, settled);
  return settled;
}

/** The only root format-1 export files were written under (`<database>.exports`); format-2 artifacts have no files. */
export function defaultExportRoot(store: TransactionStore): string { return resolve(`${store.path}.exports`); }

/**
 * Removes one export artifact only as `<authorized root>/<id>.json`. The persisted path is never used as a
 * deletion target: it must equal that location (otherwise `export_outside_authorized_root`), and the entry
 * must be a regular file, not a symlink (`export_path_untrusted`). A missing file is already purged.
 */
function removeExportFile(entry: DeletionExportScope, exportRoot: string): void {
  requireId(entry.id);
  if (entry.storage === "sqlite" || entry.storage === "none") return;
  const root = resolve(exportRoot);
  if (!entry.path || resolve(entry.path) !== join(root, `${entry.id}.json`)) throw new AppError("export_outside_authorized_root");
  let target: string;
  try { target = join(realpathSync(root), `${entry.id}.json`); } catch { return; /* No root, no file under it. */ }
  let stat;
  try { stat = lstatSync(target); } catch { return; }
  if (!stat.isFile()) throw new AppError("export_path_untrusted");
  rmSync(target);
}

/**
 * Purges pending app-owned export files for one operation (or every pending/blocked operation), outside
 * any transaction, then records per-file outcomes. Each file has its own bounded attempt count; files are
 * never recreated and a failure keeps the operation from reading as complete.
 */
export function purgeDeletedExports(store: TransactionStore, now: number, operationId?: string, exportRoot = defaultExportRoot(store)): DeletionOperation[] {
  const ids = operationId ? [operationId] : store.read(tx => tx.all<{ id: string }>(
    "SELECT id FROM deletion_operations WHERE state IN ('pending', 'blocked') ORDER BY rowid LIMIT 100").map(row => row.id));
  const results: DeletionOperation[] = [];
  for (const id of ids) {
    const operation = store.read(tx => readOperationRow(tx, id));
    if (!operation || !operation.exports.some(entry => entry.state === "pending")) continue;
    const outcomes = new Map<string, { ok: boolean; reason: string | null }>();
    for (const entry of operation.exports.filter(item => item.state === "pending")) {
      try { removeExportFile(entry, exportRoot); outcomes.set(entry.id, { ok: true, reason: null }); }
      catch (error) { outcomes.set(entry.id, { ok: false, reason: error instanceof AppError ? error.code : "export_file_purge_failed" }); }
    }
    const settled = store.transaction(tx => {
      const current = readOperationRow(tx, id);
      if (!current) return null;
      const next = aggregate({ ...current, exports: current.exports.map(entry => {
        const outcome = outcomes.get(entry.id);
        if (!outcome || entry.state !== "pending") return entry;
        const attempts = entry.attempts + 1;
        return outcome.ok ? { ...entry, state: "purged" as const, attempts, reason: null, updatedAt: now }
          : { ...entry, state: attempts >= current.maxAttempts ? "failed" as const : "pending" as const, attempts, reason: outcome.reason, updatedAt: now };
      }) }, now);
      saveOperation(tx, next);
      return next;
    });
    if (settled) results.push(settled);
  }
  return results;
}

/**
 * Idempotent startup reconstruction for operations persisted before export scopes existed (no `exports`
 * field). Their frozen preview and coverage cannot be trusted as complete, so every live export of a
 * tombstoned project (plus any the preview listed) becomes a pending purge scope, its registration is
 * removed, and a `complete` operation is downgraded until the files are purged. Returns operations changed.
 */
export function reconstructLegacyExportScopes(store: TransactionStore, now: number): number {
  return store.transaction(tx => {
    let changed = 0;
    for (const row of tx.all<{ id: string; json: string }>("SELECT id, record_json AS json FROM deletion_operations")) {
      let raw: DeletionOperation;
      try { raw = JSON.parse(row.json) as DeletionOperation; } catch { continue; }
      if (Array.isArray((raw as { exports?: unknown }).exports)) continue;
      const preview = tx.get<{ json: string }>("SELECT record_json AS json FROM deletion_previews WHERE id = ?", raw.previewId);
      let listed = new Set<string>();
      try { listed = new Set((JSON.parse(preview?.json ?? "{}") as DeletionPreview).affected?.exports?.map(e => e.id) ?? []); } catch { /* Projects below still apply. */ }
      const projects = new Set((raw.tombstones ?? []).map(t => t.projectId));
      const exports: DeletionExportScope[] = [];
      for (const live of tx.all<{ id: string; projectId: string }>("SELECT id, project_id AS projectId FROM export_artifacts")) {
        if (!listed.has(live.id) && !projects.has(live.projectId)) continue;
        exports.push(dropExportRegistration(tx, live.projectId, live.id, now, "legacy_operation_reconstructed"));
      }
      const next = aggregate({ ...normalizeOperation(raw), exports }, now);
      saveOperation(tx, next);
      changed++;
    }
    return changed;
  });
}

/**
 * Service lifecycle helper: one budgeted pass per pending/blocked operation through the managed
 * run-port delete path (never native byte edits). Each pass reserves an attempt before dispatch, so
 * restarts and owner retries share `maxAttempts`; reservations are never refunded after uncertainty.
 */
export async function reconcileDeletions(store: TransactionStore, port: ApplicationRunPort, now: number,
  exportRoot = defaultExportRoot(store)): Promise<DeletionOperation[]> {
  reconstructLegacyExportScopes(store, now);
  const pending = store.read(tx => tx.all<{ id: string }>(
    "SELECT id FROM deletion_operations WHERE state IN ('pending', 'blocked') ORDER BY rowid LIMIT 100").map(row => row.id));
  const results: DeletionOperation[] = [];
  for (const id of pending) {
    purgeDeletedExports(store, now, id, exportRoot);
    const { operation, dispatch } = store.transaction(tx => reservePass(tx, id, now));
    if (!dispatch.length) { if (operation) results.push(operation); continue; }
    const outcomes: PassOutcome[] = [];
    for (const context of dispatch) {
      try {
        const outcome = await port.delete({ id: context.id, generation: context.generation });
        outcomes.push(outcome.state === "deleted"
          ? { id: context.id, generation: context.generation, state: "deleted", reason: null, nextAction: "none" }
          : outcome.state === "retire_failed"
            ? { id: context.id, generation: context.generation, state: "retire_failed", reason: "managed_retire_failed", nextAction: outcome.nextAction }
            : outcome.state === "delete_failed"
              ? { id: context.id, generation: context.generation, state: "delete_failed", reason: "managed_delete_failed", nextAction: outcome.nextAction }
              : { id: context.id, generation: context.generation, state: "pending", reason: "managed_delete_unacknowledged", nextAction: "retry_managed_delete" });
      } catch (error) {
        const missing = error instanceof AppError && error.code === "context_not_found";
        outcomes.push({ id: context.id, generation: context.generation, state: missing ? "missing" : "delete_failed",
          reason: missing ? "native_context_missing" : error instanceof AppError ? error.code : "managed_delete_error",
          nextAction: missing ? "inspect_missing_native_context" : "retry_managed_delete" });
      }
    }
    const next = store.transaction(tx => settlePass(tx, id, outcomes, now));
    if (next) results.push(next);
  }
  return results;
}

/**
 * Lifecycle-safe projection of persisted run manifests for owner APIs: cited source/claim text whose
 * lifecycle is no longer available (deleted, suppressed, corrected, retired) is replaced by the marker.
 */
export function lifecycleSafeManifests<T>(tx: AppTransaction, value: T): T {
  const visit = (node: unknown, depth: number): unknown => {
    if (depth > 8 || !node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(item => visit(item, depth + 1));
    const record = node as Record<string, unknown>;
    const next = Object.fromEntries(Object.entries(record).map(([key, item]) => [key, visit(item, depth + 1)]));
    if (Array.isArray(record.sources) && Array.isArray(record.claims)) {
      next.sources = (record.sources as { projectId?: unknown; reference?: unknown; text?: unknown }[]).map(source => {
        if (!source || typeof source !== "object" || !("text" in source)) return source;
        try {
          if (typeof source.projectId === "string" && validReference(source.reference) &&
              lookupSource(tx, source.projectId, source.reference).state === "available") return source;
        } catch { /* Unresolvable references fail closed. */ }
        return { ...source, text: redactedText };
      });
      next.claims = (record.claims as { projectId?: unknown; claimId?: unknown; revision?: unknown; generation?: unknown; text?: unknown }[]).map(claim => {
        if (!claim || typeof claim !== "object" || !("text" in claim)) return claim;
        try {
          if (typeof claim.projectId === "string" && typeof claim.claimId === "string" &&
              lookupActiveClaim(tx, claim.projectId, { claimId: claim.claimId, revision: claim.revision as number, generation: claim.generation as number }).state === "available") return claim;
        } catch { /* Unresolvable references fail closed. */ }
        return { ...claim, text: redactedText };
      });
    }
    return next;
  };
  return visit(value, 0) as T;
}

/** Preview expiry sweep; never deletes ledger tombstones or completed operations. */
export function pruneExpiredPreviews(tx: AppTransaction, now: number): number {
  const rows = tx.all<{ id: string }>("SELECT id FROM deletion_previews WHERE expires_at < ? LIMIT 500", now);
  for (const row of rows) tx.run("DELETE FROM deletion_previews WHERE id = ?", row.id);
  return rows.length;
}

/**
 * ops.quarantined_restore/v1 replay hook: applies the lineage-bound copy redaction a confirm performs
 * (producing-run outputs, stored manifests and conversation receipts) to tombstones replayed from the
 * installation lifecycle ledger into a quarantined image. Identity-only input; dispatches nothing.
 */
export function redactReplayedLineage(tx: AppTransaction, sources: { projectId: string; source: SourceReference }[], claimIds: Set<string>): void {
  // Ledger tombstones do not record their relation; derived-run lookup is a no-op for sources without a producing run.
  const entries: SourceEntry[] = sources.map(entry => ({ projectId: entry.projectId, source: { ...entry.source }, relation: "derived_output" }));
  redactDerivedRuns(tx, entries);
  scrubStoredManifests(tx, new Set(entries.map(entry => sourceKey(entry.source))), claimIds);
  scrubConversationReceipts(tx, entries, claimIds);
}

/** One managed native context and what its owning work cited, relative to a lifecycle ledger. */
export interface ContextCitation { id: string; generation: number; projectId: string; cites: "deleted" | "unknown" | "suppressed" }

/**
 * ops.quarantined_restore/v1 replay and validation hook over the same job evidence the deletion
 * inventory uses (team runs, coordinator syntheses, memory extractions and job attempts, with their
 * managed native contexts). A context is `deleted` when its work cited a deleted source generation or
 * claim, `unknown` when any of its records is unreadable or lacks a structurally valid manifest (fail
 * closed: treated like deleted), `suppressed` when it cited forgotten material. Unaffected contexts are
 * omitted. Inventory blockers (unreadable rows, scan ceilings) are returned and must block activation.
 */
export function contextCitations(tx: AppTransaction, deleted: { sources: Set<string>; claims: Set<string> },
  suppressed: { sources: Set<string>; claims: Set<string> }): { contexts: ContextCitation[]; blockers: string[] } {
  const blockers = new Set<string>();
  const jobs = jobEvidence(tx, blockers);
  const rank = { suppressed: 1, unknown: 2, deleted: 3 } as const;
  const found = new Map<string, ContextCitation>();
  const hits = (job: JobEvidence, set: { sources: Set<string>; claims: Set<string> }) =>
    job.extractionSources.some(s => set.sources.has(sourceKey(s))) || job.manifests.some(m =>
      m.sources.some(s => validReference(s?.reference) && set.sources.has(sourceKey(s.reference))) ||
      m.claims.some(c => typeof c?.claimId === "string" && set.claims.has(c.claimId)));
  for (const job of jobs.values()) {
    if (!job.contexts.size) continue;
    const opaque = job.opaque || (!job.manifests.length && !job.extractionSources.length);
    const verdict: ContextCitation["cites"] | null = hits(job, deleted) ? "deleted" : opaque ? "unknown" : hits(job, suppressed) ? "suppressed" : null;
    if (!verdict) continue;
    for (const context of job.contexts.values()) {
      const current = found.get(context.id);
      if (!current || rank[verdict] > rank[current.cites]) found.set(context.id, { id: context.id, generation: context.generation, projectId: job.projectId, cites: verdict });
    }
  }
  return { contexts: [...found.values()], blockers: [...blockers].sort() };
}
