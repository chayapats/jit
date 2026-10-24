import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { closeSync, constants, lstatSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import { lookupSource, requireId } from "../sources";
import type { AppTransaction } from "../store";
import { lookupActiveClaim } from "../memory/read";
import { readDeletionLedger } from "../memory/delete";
import { listReports, readAnnotations, readCandidates, readMonitors } from "../pr";
import type { ClaimReference } from "../memory/types";
import type { SourceReference } from "../sources";

export const exportContract = "ops.project_export/v1" as const;
/** Fallback application schema when PRAGMA user_version is unreadable. */
export const exportSchemaVersion = 20;
/**
 * Artifact/manifest format revision inside `ops.project_export/v1`. Format 2 adds
 * `formatVersion`, `data.prReports`, `disclosure`, `completeness`, `failure`, failed records
 * and metadata-only message sources when history is not selected. See docs/contracts/ops-project-export-v1.md.
 */
export const exportFormatVersion = 2 as const;
/** Per-project bounds on valid exports (count and total artifact bytes); `maxBytes` is also the ceiling for one artifact. Failed records are bounded separately by `maxExports`. */
export const exportRetention = Object.freeze({ maxExports: 20, maxBytes: 32 * 1024 * 1024 });
/** Per-collection read bounds; anything beyond a bound is reported in `completeness`, never silently dropped. */
export const exportCollectionBounds = Object.freeze({
  topics: 1000, messages: 5000, tasks: 1000, proposals: 2000, events: 2000, decisions: 500, ownerDecisions: 500,
  claims: 2000, sources: 2000, jobs: 1000, deliveries: 1000, reports: 1000, prMonitors: 100, prCandidates: 2000, prReports: 500, extractions: 1000,
});
/** Bounded coverage list size kept on each manifest for delete previews. */
export const exportCoverageBound = 500;

export interface ExportScope { includeHistory: boolean }

export interface CreateExportCommand {
  kind: "export.create";
  requestId: string;
  projectId: string;
  expectedRevision: number;
  payload: { includeHistory: boolean; note: string };
}
export type ExportCommand = CreateExportCommand;

/** Bounded, secret-free failure codes a durable failed export may carry. */
export const exportFailureReasons = ["export_storage_unavailable", "export_fenced_by_lifecycle", "export_too_large", "export_failed"] as const;
export type ExportFailureReason = typeof exportFailureReasons[number];
/** Where a failed export stopped: building the artifact, the lifecycle fence before publication, or the committing write. */
export interface ExportFailure { reason: ExportFailureReason; stage: "stage" | "publish" | "commit" }

export interface ExportExclusion { kind: "source" | "claim" | "job" | "report" | "context" | "message"; id: string; reason: string }
/** What an ordinary export never is and never contains; restated on every manifest. */
export interface ExportDisclosure {
  restorableBackup: false;
  externalCopiesDeleted: false;
  secrets: "excluded";
  nativeSessions: "excluded";
  rawHistory: "included" | "metadata_only";
}
/** One bounded collection: how many rows the artifact holds versus how many exist. */
export interface ExportCollectionCompleteness { included: number; total: number; truncated: boolean }
interface ExportManifestBase {
  contract: typeof exportContract;
  /** 1 for records written before format 2 (normalized on read); 2 for current writers. */
  formatVersion: number;
  id: string;
  projectId: string;
  createdAt: number;
  appSchema: number;
  scope: ExportScope;
  projectRevision: number;
  /** Exact source/claim generations whose payload text is in the artifact; `truncated` when the list hit {@link exportCoverageBound}. */
  coverage: { sources: SourceReference[]; claims: ClaimReference[]; truncated: boolean };
  /** Rows included in the artifact per kind (never totals; see `completeness`). */
  counts: { topics: number; messages: number; tasks: number; decisions: number; claims: number; jobs: number; deliveries: number; prReports: number };
  /** Included/total/truncated for every bounded collection; `complete` is false when any collection was truncated. */
  completeness: { complete: boolean; collections: Record<string, ExportCollectionCompleteness> };
  exclusions: ExportExclusion[];
  missingRefs: { kind: string; id: string; reason: string }[];
  pendingDeletions: string[];
  residuals: { backups: string[]; external: string[] };
  lifecycle: { tombstonesApplied: number; note: string };
  disclosure: ExportDisclosure;
  retention: { maxExports: number; maxBytes: number; pruned: string[] };
}
/**
 * Artifact reference. Format 2 stores the bytes in SQLite beside the registration and serves
 * them only through the owner-authenticated download path. Format-1 records kept a plain file
 * written without fsync; they read back as `legacy_file` with `directorySync: "legacy_unverified"`.
 */
export type ExportArtifactRef =
  | { storage: "sqlite"; bytes: number; hash: string; downloadPath: string }
  | { storage: "legacy_file"; path: string; bytes: number; hash: string; directorySync: "legacy_unverified" };
/** A committed export: its artifact exists iff this row is valid. */
export interface ValidExportManifest extends ExportManifestBase { state: "valid"; failure: null; artifact: ExportArtifactRef }
/** A durable failed export: no artifact exists, coverage is empty and the reason is a bounded code. */
export interface FailedExportManifest extends ExportManifestBase { state: "failed"; failure: ExportFailure; artifact: null }
export type ExportManifest = ValidExportManifest | FailedExportManifest;

export interface ExportReceipt { manifest: ValidExportManifest; duplicate: boolean }
export interface ExportPreview {
  manifest: Omit<ValidExportManifest, "id" | "artifact" | "retention" | "failure"> & { id: null; artifact: null; failure: null };
  counts: ExportManifest["counts"];
}

/** Installation limits an Application may tighten (tests use small ceilings). */
export interface ExportLimits { maxExports: number; maxBytes: number }

const residualExternal = ["telegram_delivery_copies_not_exported_or_deleted", "provider_session_copies_not_exported"];
const lifecycleNote = "รวมเฉพาะ generation ที่ยัง active; ที่ถูกลบ/ลืม/แก้อยู่ใน exclusions";
const disclosureFor = (scope: ExportScope): ExportDisclosure => ({ restorableBackup: false, externalCopiesDeleted: false,
  secrets: "excluded", nativeSessions: "excluded", rawHistory: scope.includeHistory ? "included" : "metadata_only" });
/**
 * Credential shapes that never leave through PR-derived or delivery text. One detector for the whole
 * service: the shared `containsCredential` (src/security/credentials.ts) plus the export-only
 * `x-api-key` header form.
 */
export function exportSecretLike(value: string): boolean {
  return containsCredential(value) || /x-api-key/i.test(value);
}
const redacted = "(redacted: payload_hygiene_secret)";

/** Deep-copies a JSON projection, replacing every credential-shaped string with a redaction marker. */
export function sanitizeExportStrings<T>(value: T): T {
  if (typeof value === "string") return (exportSecretLike(value) ? redacted : value) as T;
  if (Array.isArray(value)) return value.map(item => sanitizeExportStrings(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeExportStrings(item)])) as T;
  }
  return value;
}

/** Owner-authenticated download path serving one artifact from its committed row. */
export const downloadPath = (projectId: string, id: string) => `/projects/${projectId}/exports/${id}/artifact`;

const exact = (value: unknown, keys: string[]) =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export function exportIdentity(command: ExportCommand): string {
  if (!command || typeof command !== "object" || !exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) ||
      command.kind !== "export.create" || typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1 ||
      !exact(command.payload, ["includeHistory", "note"]) || typeof command.payload.includeHistory !== "boolean" ||
      typeof command.payload.note !== "string" || Buffer.byteLength(command.payload.note) > 500 || !command.payload.note.isWellFormed()) {
    throw new AppError("invalid_export_command");
  }
  requireId(command.projectId);
  return createHash("sha256").update(JSON.stringify([command.kind, command.projectId, command.expectedRevision, command.payload])).digest("hex");
}

const emptyCompleteness = (): ExportManifestBase["completeness"] => ({ complete: true, collections: {} });

/**
 * Normalizes stored manifests. Format-1 records (written by the pre-format-2 writer) predate
 * failure/disclosure/completeness, always embedded message text and stored their artifact as
 * a plain file without any fsync, so their artifact reads back as `legacy_file` with
 * `directorySync: "legacy_unverified"`.
 */
function parseStored(json: string): ExportManifest {
  const raw = JSON.parse(json) as Omit<ExportManifest, "artifact"> & { formatVersion?: number; failure?: ExportFailure | null; disclosure?: ExportDisclosure;
    completeness?: ExportManifestBase["completeness"]; artifact: (Partial<ExportArtifactRef> & { path?: string; bytes: number; hash: string }) | null };
  if (raw.contract !== exportContract) throw new AppError("export_corrupt", 500);
  const legacy = raw.formatVersion === undefined;
  const artifact: ExportArtifactRef | null = !raw.artifact ? null
    : raw.artifact.storage === "sqlite" ? { storage: "sqlite", bytes: raw.artifact.bytes, hash: raw.artifact.hash, downloadPath: downloadPath(raw.projectId, raw.id) }
    : { storage: "legacy_file", path: raw.artifact.path ?? "", bytes: raw.artifact.bytes, hash: raw.artifact.hash, directorySync: "legacy_unverified" };
  return { ...raw, formatVersion: raw.formatVersion ?? 1, failure: raw.failure ?? null,
    counts: { ...raw.counts, prReports: raw.counts?.prReports ?? 0 },
    completeness: raw.completeness ?? { ...emptyCompleteness(), complete: !legacy },
    artifact,
    disclosure: raw.disclosure ?? { ...disclosureFor(raw.scope), rawHistory: legacy ? "included" : disclosureFor(raw.scope).rawHistory } } as ExportManifest;
}

/** Reads one registered export (valid or failed). Pruned or deleted exports are `export_not_found`. */
export function readExportManifest(tx: AppTransaction, projectId: string, id: string): ExportManifest {
  requireId(projectId); requireId(id);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM export_artifacts WHERE id = ? AND project_id = ?", id, projectId);
  if (!row) throw new AppError("export_not_found", 404);
  return parseStored(row.record_json);
}

/** Lists valid and failed exports for one project, oldest first. */
export function listExportArtifacts(tx: AppTransaction, projectId: string, limit = 50): ExportManifest[] {
  requireId(projectId);
  return tx.all<{ record_json: string }>("SELECT record_json FROM export_artifacts WHERE project_id = ? ORDER BY created_at, rowid LIMIT ?",
    projectId, Math.min(Math.max(limit, 1), 100)).map(row => parseStored(row.record_json));
}

/**
 * Reads the committed artifact bytes of one valid export and verifies its sha256. Format-2
 * bytes come from the same SQLite row family as the registration, so an artifact exists iff
 * its committed row is valid. Legacy format-1 files are read without following symlinks.
 */
export function readExportArtifact(tx: AppTransaction, projectId: string, id: string): { manifest: ValidExportManifest; body: Uint8Array } {
  const manifest = readExportManifest(tx, projectId, id);
  if (manifest.state !== "valid") throw new AppError("export_failed_no_artifact", 409);
  let body: Uint8Array;
  if (manifest.artifact.storage === "sqlite") {
    const row = hasBodies(tx) ? tx.get<{ body: Uint8Array }>("SELECT body FROM export_artifact_bodies WHERE id = ?", id) : null;
    if (!row) throw new AppError("export_corrupt", 500);
    body = row.body;
  } else {
    try {
      const fd = openSync(manifest.artifact.path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { body = readFileSync(fd); } finally { closeSync(fd); }
    } catch { throw new AppError("export_artifact_unavailable", 410); }
  }
  if (body.length !== manifest.artifact.bytes || createHash("sha256").update(body).digest("hex") !== manifest.artifact.hash) {
    throw new AppError("export_corrupt", 500);
  }
  return { manifest, body };
}

interface Assembled {
  data: Record<string, unknown>;
  coverage: ExportManifestBase["coverage"];
  counts: ExportManifestBase["counts"];
  completeness: ExportManifestBase["completeness"];
  exclusions: ExportExclusion[];
  missingRefs: ExportManifestBase["missingRefs"];
}

/** Outcome of the single scope-aware payload resolver every text-bearing key uses. */
type ResolvedText =
  | { state: "available"; text: string }
  | { state: "metadata_only" | "unavailable"; text: null; reason: string };

/**
 * Assembles one project export inside the caller transaction. Every payload-bearing key
 * (topic titles, messages, sources, delivery outbox/report text) goes through one resolver
 * that applies deletion, memory suppression and the history scope; claims go through the
 * active-generation lookup. Deleted payload is absent, forgotten/corrected claims are
 * inactive, forget-retained raw history and owner message text appear only with
 * `scope.includeHistory`. Every collection is bounded and reported in `completeness`.
 * PR-derived strings are sanitized for credential shapes. Format 2 adds `prReports`.
 */
export function assembleExport(tx: AppTransaction, projectId: string, scope: ExportScope): Assembled {
  requireId(projectId);
  const project = tx.get<{ id: string; name: string; revision: number; created_at: number }>(
    "SELECT id, name, revision, created_at FROM projects WHERE id = ?", projectId);
  if (!project) throw new AppError("project_not_found", 404);
  const bounds = exportCollectionBounds;
  const exclusions: ExportExclusion[] = [], missingRefs: ExportManifestBase["missingRefs"] = [];
  const collections: Record<string, ExportCollectionCompleteness> = {};
  const total = (table: string) => tx.get<{ n: number }>(`SELECT count(*) AS n FROM ${table} WHERE project_id = ?`, projectId)?.n ?? 0;
  const bounded = <T>(name: string, totalRows: number, rows: T[]): T[] => {
    collections[name] = { included: rows.length, total: totalRows, truncated: totalRows > rows.length };
    return rows;
  };
  const tombstones = readDeletionLedger(tx).filter(t => t.projectId === projectId);
  const tombstonedSources = new Set(tombstones.filter(t => t.kind === "source").map(t => `${t.sourceId}:${t.revision}:${t.generation}`));
  const tombstonedClaims = new Set(tombstones.filter(t => t.kind === "claim").map(t => t.claimId));
  for (const t of tombstones) {
    exclusions.push(t.kind === "source"
      ? { kind: "source", id: t.sourceId!, reason: "deleted" }
      : { kind: "claim", id: t.claimId!, reason: "deleted" });
  }
  const emitted = new Map<string, SourceReference>();
  const refKey = (reference: SourceReference) => `${reference.sourceId}:${reference.revision}:${reference.generation}`;
  /** The one scope-aware resolver: deletion, suppression and history scope apply to every payload key. */
  const resolve = (reference: SourceReference | null): ResolvedText => {
    if (!reference) return { state: "unavailable", text: null, reason: "source_missing" };
    if (tombstonedSources.has(refKey(reference))) return { state: "unavailable", text: null, reason: "deleted" };
    const found = lookupSource(tx, projectId, reference);
    if (found.state !== "available") return { state: "unavailable", text: null, reason: found.reason };
    if (!scope.includeHistory) {
      if (tx.get("SELECT 1 FROM memory_suppressed_sources WHERE project_id = ? AND source_id = ? AND revision = ? AND generation = ?",
        projectId, reference.sourceId, reference.revision, reference.generation)) {
        return { state: "unavailable", text: null, reason: "forgotten_raw_history_excluded" };
      }
      if (found.current.kind === "message") return { state: "metadata_only", text: null, reason: "raw_history_not_selected" };
    }
    emitted.set(refKey(reference), { ...reference });
    return { state: "available", text: found.text };
  };
  const availability = (resolved: ResolvedText) => resolved.state === "available" ? "available" : resolved.state === "metadata_only" ? "metadata_only" : "unavailable";

  // Topics carry structural titles through the same resolver.
  const topics = bounded("topics", total("topics"), tx.all<{ id: string; revision: number; sequence: number; createdAt: number; sourceId: string; sourceRevision: number; sourceGeneration: number }>(
    "SELECT id, revision, sequence, created_at AS createdAt, source_id AS sourceId, source_revision AS sourceRevision, source_generation AS sourceGeneration FROM topics WHERE project_id = ? ORDER BY sequence LIMIT ?", projectId, bounds.topics))
    .map(row => {
      const reference: SourceReference = { sourceId: row.sourceId, revision: row.sourceRevision, generation: row.sourceGeneration };
      const resolved = resolve(reference);
      return { id: row.id, projectId, revision: row.revision, sequence: row.sequence, createdAt: row.createdAt,
        title: resolved.text, availability: availability(resolved), source: reference };
    });
  // Raw message history exports only when the scope explicitly includes history.
  const messageTotal = total("messages");
  const messages = scope.includeHistory
    ? bounded("messages", messageTotal, tx.all<{ id: string; topicId: string; sequence: number; committedAt: number; sourceId: string; sourceRevision: number; sourceGeneration: number }>(
      "SELECT id, topic_id AS topicId, sequence, committed_at AS committedAt, source_id AS sourceId, source_revision AS sourceRevision, source_generation AS sourceGeneration FROM messages WHERE project_id = ? ORDER BY topic_id, sequence LIMIT ?", projectId, bounds.messages))
      .map(row => {
        const reference: SourceReference = { sourceId: row.sourceId, revision: row.sourceRevision, generation: row.sourceGeneration };
        const resolved = resolve(reference);
        return { id: row.id, projectId, topicId: row.topicId, sequence: row.sequence, committedAt: row.committedAt,
          text: resolved.text, availability: availability(resolved), source: reference };
      })
    : (collections.messages = { included: 0, total: messageTotal, truncated: false }, []);
  // Owner-authored obligations export as committed; their source links carry availability.
  const tasks = bounded("tasks", total("tasks"), tx.all<{ id: string; task_revision: number; project_id: string; topic_id: string; state: string; proposal_revision: number;
    current_proposal_id: string; title: string; summary: string; source_id: string; source_revision: number; source_generation: number;
    origin: string; acceptance_json: string | null; closed_reason: string | null; completion_policy_json: string;
    completion_json: string | null; pending_reason_json: string | null; superseded_by: string | null; created_at: number; updated_at: number }>(
    "SELECT id, task_revision, project_id, topic_id, state, proposal_revision, current_proposal_id, title, summary, source_id, source_revision, source_generation, origin, acceptance_json, closed_reason, completion_policy_json, completion_json, pending_reason_json, superseded_by, created_at, updated_at FROM tasks WHERE project_id = ? ORDER BY updated_at, id LIMIT ?", projectId, bounds.tasks))
    .map(row => ({ ...row, source: { sourceId: row.source_id, revision: row.source_revision, generation: row.source_generation } as SourceReference }));
  const taskModels = tasks.map(task => {
    const source = lookupSource(tx, projectId, task.source);
    return { task, source: source.state === "available"
      ? { state: "available" as const, reference: source.reference }
      : { state: "unavailable" as const, reference: task.source, reason: source.reason } };
  });
  const proposals = bounded("proposals", total("task_proposals"), tx.all<{ id: string; task_id: string; project_id: string; revision: number; title: string; summary: string;
    source_id: string; source_revision: number; source_generation: number; origin: string; created_at: number }>(
    "SELECT id, task_id, project_id, revision, title, summary, source_id, source_revision, source_generation, origin, created_at FROM task_proposals WHERE project_id = ? ORDER BY task_id, revision LIMIT ?", projectId, bounds.proposals))
    .map(row => ({ ...row, source: { sourceId: row.source_id, revision: row.source_revision, generation: row.source_generation } as SourceReference }));
  const events = bounded("events", total("task_events"), tx.all<{ taskId: string; projectId: string; kind: string; actorId: string; channel: string; proposalId: string | null; proposalRevision: number | null; reason: string | null; createdAt: number }>(
    `SELECT task_id AS taskId, project_id AS projectId, kind, actor_id AS actorId, channel,
      proposal_id AS proposalId, proposal_revision AS proposalRevision, reason, created_at AS createdAt
     FROM task_events WHERE project_id = ? ORDER BY sequence LIMIT ?`, projectId, bounds.events));
  // Owner decisions export as committed; proposals carry identity, revision, provenance and status.
  const ownerDecisionRows = bounded("ownerDecisions", total("owner_decisions"), tx.all<{ id: string; topic_id: string; revision: number; proposal_id: string; proposal_revision: number; option_id: string | null; conclusion: string; rationale: string; created_at: number; superseded_by: string | null }>(
    "SELECT id, topic_id, proposal_id, proposal_revision, option_id, conclusion, rationale, revision, created_at, superseded_by FROM owner_decisions WHERE project_id = ? ORDER BY created_at, id LIMIT ?", projectId, bounds.ownerDecisions));
  const decisions = bounded("decisions", total("decision_proposals"), tx.all<{ id: string; topicId: string; discussionId: string; revision: number; synthesisId: string; record_json: string;
    sourceId: string; sourceRevision: number; sourceGeneration: number; createdAt: number }>(
    `SELECT id, topic_id AS topicId, discussion_id AS discussionId, revision, synthesis_id AS synthesisId, record_json,
      source_id AS sourceId, source_revision AS sourceRevision, source_generation AS sourceGeneration, created_at AS createdAt
     FROM decision_proposals WHERE project_id = ? ORDER BY created_at, id LIMIT ?`, projectId, bounds.decisions))
    .map(row => {
      const artifact = JSON.parse(row.record_json) as unknown;
      const source: SourceReference = { sourceId: row.sourceId, revision: row.sourceRevision, generation: row.sourceGeneration };
      const decided = ownerDecisionRows.find(d => d.proposal_id === row.id && d.proposal_revision === row.revision);
      return { id: row.id, projectId, topicId: row.topicId, discussionId: row.discussionId, revision: row.revision, synthesisId: row.synthesisId,
        status: decided ? (decided.superseded_by ? "decided_superseded" : "decided") : "open", ownerDecisionId: decided?.id ?? null,
        source, sourceAvailability: lookupSource(tx, projectId, source).state, createdAt: row.createdAt, artifact };
    });
  // Memory exports only active generations; withdrawn payload is never exported.
  const claims = bounded("claims", total("memory_claims"), tx.all<{ sequence: number; id: string; revision: number; generation: number; record_json: string }>(
    "SELECT sequence, id, revision, generation, record_json FROM memory_claims WHERE project_id = ? ORDER BY sequence LIMIT ?", projectId, bounds.claims))
    .map(row => {
      const reference: ClaimReference = { claimId: row.id, revision: row.revision, generation: row.generation };
      const found = lookupActiveClaim(tx, projectId, reference);
      if (found.state === "available") return { state: "available" as const, claim: found.claim };
      if (!tombstonedClaims.has(row.id)) {
        const parsed = (() => { try { return JSON.parse(row.record_json) as { status?: string }; } catch { return {}; } })();
        exclusions.push({ kind: "claim", id: row.id, reason: parsed.status === "forgotten" ? "forgotten_inactive" : parsed.status === "corrected" ? "corrected_superseded" : found.reason });
      }
      return { state: "unavailable" as const, reference, reason: found.reason };
    });
  // Sources export through the resolver: available text, identity-only history, or nothing.
  const sources = bounded("sources", total("sources"), tx.all<{ sourceId: string; revision: number; generation: number; kind: string }>(
    "SELECT id AS sourceId, current_revision AS revision, generation, kind FROM sources WHERE project_id = ? ORDER BY id LIMIT ?", projectId, bounds.sources))
    .map(row => {
      const reference: SourceReference = { sourceId: row.sourceId, revision: row.revision, generation: row.generation };
      const resolved = resolve(reference);
      // Service output sources (delivery/alert text, run output) pass the shared credential sanitizer.
      if (resolved.state === "available") return { state: "available" as const, reference, kind: row.kind, text: row.kind === "output" && resolved.text !== null ? sanitizeExportStrings(resolved.text) : resolved.text };
      if (resolved.reason !== "deleted") {
        exclusions.push({ kind: resolved.state === "metadata_only" ? "message" : "source", id: row.sourceId, reason: resolved.reason });
      }
      return resolved.state === "metadata_only"
        ? { state: "metadata_only" as const, reference, kind: row.kind, text: null }
        : { state: "unavailable" as const, reference, reason: resolved.reason === "forgotten_raw_history_excluded" ? "source_suppressed" : resolved.reason };
    });
  // Jobs export committed evidence references; missing jobs surface as missing refs, never fabricated.
  const jobs = bounded("jobs", total("jobs"), tx.all<{ record_json: string }>("SELECT record_json FROM jobs WHERE project_id = ? ORDER BY sequence LIMIT ?", projectId, bounds.jobs))
    .map(row => {
      const job = JSON.parse(row.record_json) as { id: string; type: string; state: string; reason: string | null; evidence: string | null };
      return { id: job.id, type: job.type, state: job.state, reason: job.reason, evidence: job.evidence };
    });
  // Delivery outbox/report text exports only when the resolver releases its own committed source.
  const deliveries = bounded("deliveries", total("delivery_intents"), tx.all<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE project_id = ? ORDER BY sequence LIMIT ?", projectId, bounds.deliveries))
    .map(row => {
      const intent = JSON.parse(row.record_json) as { id: string; payload: { kind: string; text: string; reference?: { reportId: string; sourceId: string; sourceRevision: number; sourceGeneration: number } }; status: string };
      const ref = intent.payload.reference;
      const reference = ref ? { sourceId: ref.sourceId, revision: ref.sourceRevision, generation: ref.sourceGeneration } : null;
      const resolved = resolve(reference);
      if (resolved.state !== "available") exclusions.push({ kind: "message", id: intent.id, reason: `delivery_text_${resolved.reason}` });
      return { id: intent.id, kind: intent.payload.kind, reportId: ref?.reportId ?? null, source: reference,
        text: resolved.state === "available" ? sanitizeExportStrings(intent.payload.text) : null, availability: availability(resolved), status: intent.status };
    });
  const reports = bounded("reports", total("delivery_reports"), tx.all<{ record_json: string }>("SELECT record_json FROM delivery_reports WHERE project_id = ? ORDER BY rowid LIMIT ?", projectId, bounds.reports))
    .map(row => {
      const report = JSON.parse(row.record_json) as { id: string; kind: string; revision: number; generation: number; availability: string; text: string;
        sourceId: string; sourceRevision: number; sourceGeneration: number; committedAt: number };
      const reference: SourceReference = { sourceId: report.sourceId, revision: report.sourceRevision, generation: report.sourceGeneration };
      const resolved = resolve(reference);
      if (resolved.state !== "available") exclusions.push({ kind: "report", id: report.id, reason: `delivery_report_${resolved.reason}` });
      return { id: report.id, projectId, kind: report.kind, revision: report.revision, generation: report.generation,
        availability: resolved.state === "available" ? report.availability : availability(resolved), text: resolved.state === "available" ? sanitizeExportStrings(report.text) : null,
        sourceId: report.sourceId, sourceRevision: report.sourceRevision, sourceGeneration: report.sourceGeneration, committedAt: report.committedAt };
    });
  // Missing references: extraction dependencies that no longer resolve (bounded scan, disclosed).
  for (const row of bounded("extractions", total("memory_extractions"), tx.all<{ record_json: string }>(
    "SELECT record_json FROM memory_extractions WHERE project_id = ? ORDER BY rowid LIMIT ?", projectId, bounds.extractions))) {
    try {
      const extraction = JSON.parse(row.record_json) as { id: string; dependencies?: ClaimReference[] };
      for (const dep of extraction.dependencies ?? []) {
        if (!tx.get("SELECT 1 FROM memory_claims WHERE id = ? AND project_id = ?", dep.claimId, projectId)) {
          missingRefs.push({ kind: "claim", id: dep.claimId, reason: "extraction_dependency_missing" });
        }
      }
    } catch { missingRefs.push({ kind: "extraction", id: "unreadable", reason: "record_unreadable" }); }
  }
  const pr = assemblePr(tx, projectId, bounded, exclusions, missingRefs);
  // Coverage lists exactly the payload-bearing refs emitted above (bounded); `truncated`
  // means the bound cut the list, so delete previews treat the export conservatively.
  const includedSources = [...emitted.values()];
  const includedClaims = claims.flatMap(c => c.state === "available" ? [{ claimId: c.claim.claimId, revision: c.claim.revision, generation: c.claim.generation }] : []);
  const coverageSources = includedSources.slice(0, exportCoverageBound), coverageClaims = includedClaims.slice(0, exportCoverageBound);
  return {
    data: { project: { id: project.id, name: project.name, revision: project.revision, createdAt: project.created_at },
      topics, messages, messageCount: messageTotal, tasks: taskModels, proposals, events, decisions, ownerDecisions: ownerDecisionRows,
      claims, sources, jobs, deliveries, reports, pr: { monitors: pr.monitors, candidates: pr.candidates }, prReports: pr.reports },
    coverage: { sources: coverageSources, claims: coverageClaims,
      truncated: includedSources.length > coverageSources.length || includedClaims.length > coverageClaims.length },
    counts: { topics: topics.length, messages: messages.length, tasks: tasks.length, decisions: ownerDecisionRows.length,
      claims: claims.filter(c => c.state === "available").length, jobs: jobs.length, deliveries: deliveries.length, prReports: pr.reports.length },
    completeness: { complete: Object.values(collections).every(c => !c.truncated), collections },
    exclusions, missingRefs,
  };
}

/**
 * PR monitors, candidates and private reports (`pr.private_report/v1`): revision, scope,
 * computed stale flag, validated findings, evidence refs and owner annotations. Projections
 * are explicit allowlists (no snapshot blobs, apiBase or authority generations); every string
 * then passes {@link sanitizeExportStrings} and the serialized projection is re-scanned.
 */
function assemblePr(tx: AppTransaction, projectId: string, bounded: <T>(name: string, total: number, rows: T[]) => T[],
  exclusions: ExportExclusion[], missingRefs: ExportManifestBase["missingRefs"]): { monitors: unknown[]; candidates: unknown[]; reports: unknown[] } {
  if (!tx.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pr_monitors'")) return { monitors: [], candidates: [], reports: [] };
  const bounds = exportCollectionBounds;
  let monitors: unknown[] = [], candidates: unknown[] = [], reports: unknown[] = [];
  try {
    const allMonitors = readMonitors(tx, projectId);
    const shownMonitors = bounded("prMonitors", allMonitors.length, allMonitors.slice(0, bounds.prMonitors));
    const allCandidates = shownMonitors.flatMap(monitor => {
      try { return readCandidates(tx, projectId, monitor.id); } catch { return []; }
    });
    const shownCandidates = bounded("prCandidates", allCandidates.length, allCandidates.slice(0, bounds.prCandidates));
    for (const candidate of shownCandidates) {
      if (candidate.status === "superseded") exclusions.push({ kind: "report", id: candidate.id, reason: "superseded_stale" });
    }
    monitors = shownMonitors.map(monitor => ({ id: monitor.id, repository: { host: monitor.repository.host, owner: monitor.repository.owner, name: monitor.repository.name },
      state: monitor.state, revision: monitor.revision }));
    candidates = shownCandidates.map(candidate => ({ id: candidate.id, monitorId: candidate.monitorId, pullNumber: candidate.pullNumber,
      baseSha: candidate.baseSha, headSha: candidate.headSha, status: candidate.status, generation: candidate.generation }));
  } catch { missingRefs.push({ kind: "pr_monitor", id: "unreadable", reason: "record_unreadable" }); }
  if (tx.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pr_reports'")) {
    try {
      const all = listReports(tx, projectId).reverse();
      reports = bounded("prReports", all.length, all.slice(0, bounds.prReports)).map(report => ({
        id: report.id, projectId, monitorId: report.monitorId, candidateId: report.candidateId,
        repository: { host: report.repository.host, owner: report.repository.owner, name: report.repository.name },
        pullNumber: report.pullNumber, baseSha: report.baseSha, headSha: report.headSha,
        policyVersion: report.policyVersion, reviewPolicyVersion: report.reviewPolicyVersion,
        revision: report.revision, status: report.status, stale: report.stale, staleReason: report.staleReason,
        scope: { requiredRoles: [...report.requiredRoles], analyzedRoles: [...report.analyzedRoles], skippedScope: [...report.skippedScope],
          coverageOverall: report.coverageOverall, enumerationComplete: report.enumerationComplete },
        findings: report.findings.map(finding => {
          // A finding the validator flagged for payload hygiene loses all free text, not just the matching field.
          const flagged = finding.validationErrors.includes("payload_hygiene_secret");
          const text = (value: string) => flagged ? redacted : value;
          return { id: finding.id, title: text(finding.title), category: finding.category, severity: finding.severity,
            location: { path: text(finding.location.path), line: finding.location.line },
            condition: text(finding.condition), impact: text(finding.impact), reasoning: text(finding.reasoning),
            evidenceType: finding.evidenceType, evidenceRef: finding.evidenceRef === null ? null : text(finding.evidenceRef),
            status: finding.status, validationErrors: [...finding.validationErrors] };
        }),
        specialistRuns: report.specialistRuns.map(run => ({ role: run.role, state: run.state, reason: run.reason })),
        synthesis: { state: report.synthesis.state, reason: report.synthesis.reason },
        disagreements: [...report.disagreements],
        evidence: { snapshotId: report.snapshotId, jobId: report.jobId, attemptId: report.attemptId },
        annotations: readAnnotations(tx, report.id).map(a => ({ id: a.id, revision: a.revision, kind: a.kind, text: a.text, createdAt: a.createdAt })),
        createdAt: report.createdAt, updatedAt: report.updatedAt,
      }));
    } catch { missingRefs.push({ kind: "pr_report", id: "unreadable", reason: "record_unreadable" }); reports = []; }
  }
  const projection = sanitizeExportStrings({ monitors, candidates, reports });
  // Defense in depth: the serialized projection must carry no credential shape at all.
  if (exportSecretLike(JSON.stringify(projection))) throw new AppError("export_failed", 500);
  return projection;
}

function pendingDeletionIds(tx: AppTransaction, projectId: string): string[] {
  try {
    return tx.all<{ id: string }>("SELECT id FROM deletion_operations WHERE project_id = ? AND state IN ('pending', 'blocked') LIMIT 20", projectId).map(r => r.id);
  } catch { return []; }
}

function residualBackups(tx: AppTransaction, projectId: string): string[] {
  try {
    const projectSources = new Set(tx.all<{ id: string }>("SELECT id FROM sources WHERE project_id = ?", projectId).map(r => r.id));
    const out: string[] = [];
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM ops_backups ORDER BY created_at, id LIMIT 100")) {
      try {
        const manifest = JSON.parse(row.record_json) as { id: string; sourceGenerations?: { sourceId: string }[] };
        if (manifest.sourceGenerations?.some(s => projectSources.has(s.sourceId))) out.push(manifest.id);
      } catch { /* Corrupt manifests stay visible to backup validation. */ }
    }
    return out;
  } catch { return []; }
}

function manifestBase(tx: AppTransaction, input: { id: string; now: number; projectId: string; projectRevision: number; scope: ExportScope },
  assembled: Pick<Assembled, "coverage" | "counts" | "completeness" | "exclusions" | "missingRefs">): Omit<ExportManifestBase, "retention"> {
  const tombstones = readDeletionLedger(tx).filter(t => t.projectId === input.projectId);
  return {
    contract: exportContract, formatVersion: exportFormatVersion, id: input.id, projectId: input.projectId, createdAt: input.now,
    appSchema: tx.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? exportSchemaVersion,
    scope: { ...input.scope }, projectRevision: input.projectRevision,
    coverage: assembled.coverage, counts: assembled.counts, completeness: assembled.completeness,
    exclusions: assembled.exclusions, missingRefs: assembled.missingRefs,
    pendingDeletions: pendingDeletionIds(tx, input.projectId),
    residuals: { backups: residualBackups(tx, input.projectId), external: [...residualExternal] },
    lifecycle: { tombstonesApplied: tombstones.length, note: lifecycleNote },
    disclosure: disclosureFor(input.scope),
  };
}

/** Reads a preview of what an export would publish (selected scope + expected revision), without creating any artifact. */
export function exportPreview(tx: AppTransaction, projectId: string, scope: ExportScope, projectRevision: number): ExportPreview {
  const assembled = assembleExport(tx, projectId, scope);
  const base = manifestBase(tx, { id: "", now: 0, projectId, projectRevision, scope }, assembled);
  return { manifest: { ...base, id: null, state: "valid", failure: null, artifact: null }, counts: assembled.counts };
}

/** Artifact bytes live beside registrations; deleting a registration cascades to its bytes. */
export function ensureExportBodies(tx: AppTransaction): void {
  tx.run(`CREATE TABLE IF NOT EXISTS export_artifact_bodies (
    id TEXT PRIMARY KEY REFERENCES export_artifacts(id) ON DELETE CASCADE,
    body BLOB NOT NULL
  )`);
}
function hasBodies(tx: AppTransaction): boolean {
  return !!tx.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'export_artifact_bodies'");
}

/** Lifecycle generation of one project's exportable state; a change between assembly and publication fences the artifact. */
export function exportLifecycleMark(tx: AppTransaction, projectId: string): string {
  const parts = [
    tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", projectId)?.revision ?? null,
    tx.all("SELECT id, kind, revision, generation FROM deletion_ledger WHERE project_id = ? ORDER BY id", projectId),
    tx.all("SELECT id, state FROM deletion_operations WHERE project_id = ? ORDER BY id", projectId),
    tx.all("SELECT suppression_id, source_id, revision, generation FROM memory_suppressed_sources WHERE project_id = ? ORDER BY suppression_id, source_id", projectId),
    tx.all("SELECT id, current_revision, generation, availability FROM sources WHERE project_id = ? ORDER BY id", projectId),
    tx.all("SELECT id, revision, generation, json_extract(record_json, '$.status') AS status FROM memory_claims WHERE project_id = ? ORDER BY sequence", projectId),
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** An assembled, size-checked artifact not yet registered; nothing is visible until {@link registerExport}. */
export interface BuiltExport {
  input: { id: string; now: number; projectId: string; projectRevision: number; scope: ExportScope };
  assembled: Assembled;
  body: Uint8Array;
  hash: string;
  lifecycleMark: string;
  limits: ExportLimits;
}

/**
 * Builds one export inside the caller transaction: takes the lifecycle mark, assembles and
 * lifecycle-checks every included ref, and rejects artifacts above `limits.maxBytes`
 * (`export_too_large`). Writes nothing.
 */
export function buildExport(tx: AppTransaction, input: {
  id: string; now: number; projectId: string; projectRevision: number; scope: ExportScope; note: string; limits?: ExportLimits;
}): BuiltExport {
  requireId(input.id);
  const limits = input.limits ?? exportRetention;
  const lifecycleMark = exportLifecycleMark(tx, input.projectId);
  const assembled = assembleExport(tx, input.projectId, input.scope);
  const body = Buffer.from(JSON.stringify({ contract: exportContract, formatVersion: exportFormatVersion, exportId: input.id, projectId: input.projectId,
    exportedAt: input.now, scope: input.scope, disclosure: disclosureFor(input.scope), note: input.note, data: assembled.data }));
  if (body.length > limits.maxBytes) throw new AppError("export_too_large", 413);
  return { input: { id: input.id, now: input.now, projectId: input.projectId, projectRevision: input.projectRevision, scope: { ...input.scope } },
    assembled, body, hash: createHash("sha256").update(body).digest("hex"), lifecycleMark, limits };
}

const storedBytes = (json: string): number => {
  try { return (JSON.parse(json) as { artifact?: { bytes?: number } | null }).artifact?.bytes ?? 0; } catch { return 0; }
};
const storedState = (json: string): string => {
  try { return (JSON.parse(json) as { state?: string }).state ?? "valid"; } catch { return "valid"; }
};

/** Deletes registrations (bytes cascade); a legacy format-1 file is unlinked first so no data file outlives its row. */
function retire(tx: AppTransaction, row: { id: string; record_json: string }): void {
  try {
    const raw = JSON.parse(row.record_json) as { formatVersion?: number; artifact?: { path?: string } | null };
    if (raw.formatVersion === undefined && raw.artifact?.path) {
      try { if (!lstatSync(raw.artifact.path).isDirectory()) unlinkSync(raw.artifact.path); } catch { /* Already absent. */ }
    }
  } catch { /* Corrupt rows are still retired. */ }
  if (hasBodies(tx)) tx.run("DELETE FROM export_artifact_bodies WHERE id = ?", row.id);
  tx.run("DELETE FROM export_artifacts WHERE id = ?", row.id);
}

/**
 * Publishes a built export in the same transaction that will commit it: re-checks the
 * lifecycle mark (`export_fenced_by_lifecycle` on any change), inserts the valid registration
 * and its bytes, then applies retention computed from that final outcome (oldest valid
 * exports beyond `maxExports` or `maxBytes`, never the new one). A rollback undoes all of it.
 */
export function registerExport(tx: AppTransaction, built: BuiltExport): ValidExportManifest {
  const { input, limits } = built;
  if (exportLifecycleMark(tx, input.projectId) !== built.lifecycleMark) throw new AppError("export_fenced_by_lifecycle", 409);
  ensureExportBodies(tx);
  // Bytes whose registration was removed without the cascade (foreign keys off) never stay retained.
  tx.run("DELETE FROM export_artifact_bodies WHERE id NOT IN (SELECT id FROM export_artifacts)");
  const valid = tx.all<{ id: string; record_json: string }>(
    "SELECT id, record_json FROM export_artifacts WHERE project_id = ? ORDER BY created_at, rowid", input.projectId)
    .filter(row => storedState(row.record_json) === "valid");
  let count = valid.length + 1, bytes = built.body.length + valid.reduce((sum, row) => sum + storedBytes(row.record_json), 0);
  const victims: { id: string; record_json: string }[] = [];
  for (const row of valid) {
    if (count <= limits.maxExports && bytes <= limits.maxBytes) break;
    victims.push(row); count -= 1; bytes -= storedBytes(row.record_json);
  }
  const manifest: ValidExportManifest = {
    ...manifestBase(tx, input, built.assembled),
    retention: { maxExports: limits.maxExports, maxBytes: limits.maxBytes, pruned: victims.map(v => v.id) },
    state: "valid", failure: null,
    artifact: { storage: "sqlite", bytes: built.body.length, hash: built.hash, downloadPath: downloadPath(input.projectId, input.id) },
  };
  tx.run("INSERT INTO export_artifacts VALUES (?, ?, ?, ?)", manifest.id, input.projectId, manifest.createdAt, JSON.stringify(manifest));
  tx.run("INSERT INTO export_artifact_bodies (id, body) VALUES (?, ?)", manifest.id, built.body);
  for (const victim of victims) retire(tx, victim);
  return manifest;
}

/**
 * Records a durable failed export (no artifact, empty coverage) so the request has one
 * inspectable logical outcome. Only bounded reason codes are stored, never error text.
 * Failed records are bounded among themselves and never retire a valid export.
 */
export function recordFailedExport(tx: AppTransaction, input: {
  id: string; now: number; projectId: string; projectRevision: number; scope: ExportScope; failure: ExportFailure; limits?: ExportLimits;
}): FailedExportManifest {
  const limits = input.limits ?? exportRetention;
  const empty = { coverage: { sources: [], claims: [], truncated: false },
    counts: { topics: 0, messages: 0, tasks: 0, decisions: 0, claims: 0, jobs: 0, deliveries: 0, prReports: 0 },
    completeness: emptyCompleteness(), exclusions: [], missingRefs: [] };
  const failed = tx.all<{ id: string; record_json: string }>(
    "SELECT id, record_json FROM export_artifacts WHERE project_id = ? ORDER BY created_at, rowid", input.projectId)
    .filter(row => storedState(row.record_json) === "failed" && row.id !== input.id);
  const victims = failed.slice(0, Math.max(0, failed.length + 1 - limits.maxExports));
  for (const victim of victims) retire(tx, victim);
  const manifest: FailedExportManifest = {
    ...manifestBase(tx, input, empty),
    retention: { maxExports: limits.maxExports, maxBytes: limits.maxBytes, pruned: victims.map(v => v.id) },
    state: "failed", failure: { ...input.failure }, artifact: null,
  };
  tx.run("INSERT INTO export_artifacts VALUES (?, ?, ?, ?)", manifest.id, input.projectId, manifest.createdAt, JSON.stringify(manifest));
  return manifest;
}

/** Current state of a registration for request replays: valid, failed, or null once pruned/deleted. */
export function exportRegistration(tx: AppTransaction, id: string): ExportManifest | null {
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM export_artifacts WHERE id = ?", id);
  if (!row) return null;
  try { return parseStored(row.record_json); } catch { return null; }
}

/** Maps any thrown value to a bounded failure reason; error messages never reach records. */
export function exportFailureReason(error: unknown): ExportFailureReason {
  const code = error instanceof AppError ? error.code : String((error as { code?: unknown })?.code ?? "");
  if (code.startsWith("SQLITE_FULL") || code.startsWith("SQLITE_IOERR")) return "export_storage_unavailable";
  return (exportFailureReasons as readonly string[]).includes(code) ? code as ExportFailureReason : "export_failed";
}

/**
 * Removes every export registration and artifact byte from a database snapshot destined for
 * a backup, then VACUUMs so freed pages carry no artifact text. Backups therefore never hold
 * export artifacts, and a restore cannot resurrect content deleted after the export.
 */
export function stripExportsFromSnapshot(bytes: Uint8Array): Uint8Array {
  // A WAL-mode image (header bytes 18/19 = 2) cannot be opened in memory; edit a rollback-journal copy
  // and restore the original header bytes afterwards.
  const copy = Uint8Array.from(bytes);
  const [write, read] = [copy[18], copy[19]];
  if (copy.length >= 100) { copy[18] = 1; copy[19] = 1; }
  const db = Database.deserialize(copy);
  try {
    const has = (name: string) => !!db.query("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
    if (!has("export_artifacts")) return bytes;
    if (has("export_artifact_bodies")) db.exec("DELETE FROM export_artifact_bodies");
    db.exec("DELETE FROM export_artifacts");
    db.exec("VACUUM");
    const stripped = Uint8Array.from(db.serialize());
    if (stripped.length >= 100 && write !== undefined && read !== undefined) { stripped[18] = write; stripped[19] = read; }
    return stripped;
  } finally { db.close(); }
}

/** Scans an export artifact for secret material; returns canary hits (empty when clean). */
export function scanExportSecrets(artifactJson: string, canaries: string[]): string[] {
  return canaries.filter(c => c && artifactJson.includes(c));
}

