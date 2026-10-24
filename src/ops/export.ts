import { createHash } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, readdirSync, renameSync, rmSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../errors";
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
 * `formatVersion`, `data.prReports`, `disclosure`, `failure`, failed records and
 * metadata-only message sources when history is not selected. See docs/contracts/ops-project-export-v1.md.
 */
export const exportFormatVersion = 2 as const;
export const exportRetention = Object.freeze({ maxExports: 20, maxBytes: 32 * 1024 * 1024 });

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
export const exportFailureReasons = ["export_storage_unavailable", "unsafe_export_destination", "export_fenced_by_lifecycle", "export_failed"] as const;
export type ExportFailureReason = typeof exportFailureReasons[number];
/** Where a failed export stopped: building/staging the temp file, publishing it, or committing its registration. */
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
  coverage: { sources: SourceReference[]; claims: ClaimReference[]; truncated: boolean };
  counts: { topics: number; messages: number; tasks: number; decisions: number; claims: number; jobs: number; deliveries: number; prReports: number };
  exclusions: ExportExclusion[];
  missingRefs: { kind: string; id: string; reason: string }[];
  pendingDeletions: string[];
  residuals: { backups: string[]; external: string[] };
  lifecycle: { tombstonesApplied: number; note: string };
  disclosure: ExportDisclosure;
  retention: { maxExports: number; maxBytes: number; pruned: string[] };
}
/** A committed export whose artifact file was published after its lifecycle check. */
export interface ValidExportManifest extends ExportManifestBase { state: "valid"; failure: null; artifact: { path: string; bytes: number; hash: string } }
/** A durable failed export: no artifact exists, coverage is empty and the reason is a bounded code. */
export interface FailedExportManifest extends ExportManifestBase { state: "failed"; failure: ExportFailure; artifact: null }
export type ExportManifest = ValidExportManifest | FailedExportManifest;

export interface ExportReceipt { manifest: ValidExportManifest; duplicate: boolean }
export interface ExportPreview {
  manifest: Omit<ValidExportManifest, "id" | "artifact" | "retention" | "failure"> & { id: null; artifact: null; failure: null };
  counts: ExportManifest["counts"];
}

const residualExternal = ["telegram_delivery_copies_not_exported_or_deleted", "provider_session_copies_not_exported"];
const lifecycleNote = "รวมเฉพาะ generation ที่ยัง active; ที่ถูกลบ/ลืม/แก้อยู่ใน exclusions";
const disclosureFor = (scope: ExportScope): ExportDisclosure => ({ restorableBackup: false, externalCopiesDeleted: false,
  secrets: "excluded", nativeSessions: "excluded", rawHistory: scope.includeHistory ? "included" : "metadata_only" });
const exportFileName = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.json$/;
const exportTempName = /^\.[0-9a-f-]{36}\.json\.tmp-[0-9]+$/;
const secretLike = /bearer\s|authorization\s*:|x-telegram|bot[_ -]?token|[0-9]{5,}:[A-Za-z0-9_-]{8,}/i;

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

export function exportDirFor(databasePath: string): string {
  return `${databasePath}.exports`;
}

/** Normalizes stored manifests; format-1 records predate failure/disclosure fields and always embedded message text. */
function parseManifest(json: string): ExportManifest {
  const raw = JSON.parse(json) as ExportManifest & { formatVersion?: number; failure?: ExportFailure | null; disclosure?: ExportDisclosure };
  if (raw.contract !== exportContract) throw new AppError("export_corrupt", 500);
  const legacy = raw.formatVersion === undefined;
  return { ...raw, formatVersion: raw.formatVersion ?? 1, failure: raw.failure ?? null,
    counts: { ...raw.counts, prReports: raw.counts?.prReports ?? 0 },
    disclosure: raw.disclosure ?? { ...disclosureFor(raw.scope), rawHistory: legacy ? "included" : disclosureFor(raw.scope).rawHistory } } as ExportManifest;
}

export function readExportManifest(tx: AppTransaction, projectId: string, id: string): ExportManifest {
  requireId(projectId); requireId(id);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM export_artifacts WHERE id = ? AND project_id = ?", id, projectId);
  if (!row) throw new AppError("export_not_found", 404);
  return parseManifest(row.record_json);
}

export function listExportArtifacts(tx: AppTransaction, projectId: string, limit = 50): ExportManifest[] {
  requireId(projectId);
  return tx.all<{ record_json: string }>("SELECT record_json FROM export_artifacts WHERE project_id = ? ORDER BY created_at, id LIMIT ?",
    projectId, Math.min(Math.max(limit, 1), 100)).map(row => parseManifest(row.record_json));
}

interface Assembled {
  data: Record<string, unknown>;
  coverage: ExportManifest["coverage"];
  counts: ExportManifest["counts"];
  exclusions: ExportExclusion[];
  missingRefs: ExportManifest["missingRefs"];
}

/**
 * Assembles one project export inside the caller transaction; every included ref is
 * lifecycle-checked here. Deleted payload is absent, forgotten/corrected claims are inactive,
 * forget-retained raw history and message text appear only with `scope.includeHistory`, and
 * delivery text appears only while its own source is available. Format 2 adds `prReports`.
 */
export function assembleExport(tx: AppTransaction, projectId: string, scope: ExportScope): Assembled {
  requireId(projectId);
  const exclusions: ExportExclusion[] = [], missingRefs: ExportManifest["missingRefs"] = [];
  const tombstones = readDeletionLedger(tx).filter(t => t.projectId === projectId);
  const tombstonedSources = new Set(tombstones.filter(t => t.kind === "source").map(t => `${t.sourceId}:${t.revision}:${t.generation}`));
  const tombstonedClaims = new Set(tombstones.filter(t => t.kind === "claim").map(t => t.claimId));
  for (const t of tombstones) {
    exclusions.push(t.kind === "source"
      ? { kind: "source", id: t.sourceId!, reason: "deleted" }
      : { kind: "claim", id: t.claimId!, reason: "deleted" });
  }
  // Topics carry structural titles; deleted titles export as null with availability.
  const topics = tx.all<{ id: string; revision: number; sequence: number; createdAt: number; sourceId: string; sourceRevision: number; sourceGeneration: number }>(
    "SELECT t.id, t.revision, t.sequence, t.created_at AS createdAt, t.source_id AS sourceId, t.source_revision AS sourceRevision, t.source_generation AS sourceGeneration FROM topics t WHERE t.project_id = ? ORDER BY t.sequence LIMIT 1000", projectId)
    .map(row => {
      const reference: SourceReference = { sourceId: row.sourceId, revision: row.sourceRevision, generation: row.sourceGeneration };
      const found = lookupSource(tx, projectId, reference);
      return { id: row.id, projectId, revision: row.revision, sequence: row.sequence, createdAt: row.createdAt,
        title: found.state === "available" ? found.text : null, availability: found.state, source: reference };
    });
  // Raw message history exports only when the scope explicitly includes history.
  const messageRows = scope.includeHistory ? tx.all<{ id: string; topicId: string; sequence: number; committedAt: number; sourceId: string; sourceRevision: number; sourceGeneration: number }>(
    "SELECT id, topic_id AS topicId, sequence, committed_at AS committedAt, source_id AS sourceId, source_revision AS sourceRevision, source_generation AS sourceGeneration FROM messages WHERE project_id = ? ORDER BY topic_id, sequence LIMIT 5000", projectId) : [];
  const messages = messageRows.map(row => {
    const reference: SourceReference = { sourceId: row.sourceId, revision: row.sourceRevision, generation: row.sourceGeneration };
    const found = lookupSource(tx, projectId, reference);
    return { id: row.id, projectId, topicId: row.topicId, sequence: row.sequence, committedAt: row.committedAt,
      text: found.state === "available" ? found.text : null, availability: found.state, source: reference };
  });
  const messageCount = scope.includeHistory ? messages.length
    : tx.get<{ n: number }>("SELECT count(*) AS n FROM messages WHERE project_id = ?", projectId)?.n ?? 0;
  // Owner-authored obligations export as committed; their source links carry availability.
  const tasks = tx.all<{ id: string; task_revision: number; project_id: string; topic_id: string; state: string; proposal_revision: number;
    current_proposal_id: string; title: string; summary: string; source_id: string; source_revision: number; source_generation: number;
    origin: string; acceptance_json: string | null; closed_reason: string | null; completion_policy_json: string;
    completion_json: string | null; pending_reason_json: string | null; superseded_by: string | null; created_at: number; updated_at: number }>(
    "SELECT id, task_revision, project_id, topic_id, state, proposal_revision, current_proposal_id, title, summary, source_id, source_revision, source_generation, origin, acceptance_json, closed_reason, completion_policy_json, completion_json, pending_reason_json, superseded_by, created_at, updated_at FROM tasks WHERE project_id = ? ORDER BY updated_at, id LIMIT 1000", projectId)
    .map(row => ({ ...row, source: { sourceId: row.source_id, revision: row.source_revision, generation: row.source_generation } as SourceReference }));
  const taskModels = tasks.map(task => {
    const source = lookupSource(tx, projectId, task.source);
    return { task, source: source.state === "available"
      ? { state: "available" as const, reference: source.reference }
      : { state: "unavailable" as const, reference: task.source, reason: source.reason } };
  });
  const proposals = tx.all<{ id: string; task_id: string; project_id: string; revision: number; title: string; summary: string;
    source_id: string; source_revision: number; source_generation: number; origin: string; created_at: number }>(
    "SELECT id, task_id, project_id, revision, title, summary, source_id, source_revision, source_generation, origin, created_at FROM task_proposals WHERE project_id = ? ORDER BY task_id, revision LIMIT 2000", projectId)
    .map(row => ({ ...row, source: { sourceId: row.source_id, revision: row.source_revision, generation: row.source_generation } as SourceReference }));
  const events = tx.all<{ taskId: string; projectId: string; kind: string; actorId: string; channel: string; proposalId: string | null; proposalRevision: number | null; reason: string | null; createdAt: number }>(
    `SELECT task_id AS taskId, project_id AS projectId, kind, actor_id AS actorId, channel,
      proposal_id AS proposalId, proposal_revision AS proposalRevision, reason, created_at AS createdAt
     FROM task_events WHERE project_id = ? ORDER BY sequence LIMIT 2000`, projectId);
  // Owner decisions export with evidence availability; model rationales stay as committed post-scrub text.
  const ownerDecisionRows = tx.all<{ id: string; topic_id: string; revision: number; proposal_id: string; proposal_revision: number; option_id: string | null; conclusion: string; rationale: string; created_at: number; superseded_by: string | null }>(
    "SELECT id, topic_id, proposal_id, proposal_revision, option_id, conclusion, rationale, revision, created_at, superseded_by FROM owner_decisions WHERE project_id = ? ORDER BY created_at LIMIT 500", projectId);
  // Proposals carry identity, revision, provenance and owner-decision status beside the committed artifact.
  const decisions = tx.all<{ id: string; topicId: string; discussionId: string; revision: number; synthesisId: string; record_json: string;
    sourceId: string; sourceRevision: number; sourceGeneration: number; createdAt: number }>(
    `SELECT id, topic_id AS topicId, discussion_id AS discussionId, revision, synthesis_id AS synthesisId, record_json,
      source_id AS sourceId, source_revision AS sourceRevision, source_generation AS sourceGeneration, created_at AS createdAt
     FROM decision_proposals WHERE project_id = ? ORDER BY created_at, id LIMIT 500`, projectId)
    .map(row => {
      const artifact = JSON.parse(row.record_json) as unknown;
      const source: SourceReference = { sourceId: row.sourceId, revision: row.sourceRevision, generation: row.sourceGeneration };
      const decided = ownerDecisionRows.find(d => d.proposal_id === row.id && d.proposal_revision === row.revision);
      return { id: row.id, projectId, topicId: row.topicId, discussionId: row.discussionId, revision: row.revision, synthesisId: row.synthesisId,
        status: decided ? (decided.superseded_by ? "decided_superseded" : "decided") : "open", ownerDecisionId: decided?.id ?? null,
        source, sourceAvailability: lookupSource(tx, projectId, source).state, createdAt: row.createdAt,
        artifact };
    });
  // Memory exports only active generations; withdrawn payload is never exported.
  const claimRows = tx.all<{ sequence: number; id: string; revision: number; generation: number; record_json: string }>(
    "SELECT sequence, id, revision, generation, record_json FROM memory_claims WHERE project_id = ? ORDER BY sequence LIMIT 2000", projectId);
  const claims = claimRows.map(row => {
    const reference: ClaimReference = { claimId: row.id, revision: row.revision, generation: row.generation };
    const found = lookupActiveClaim(tx, projectId, reference);
    if (found.state === "available") return { state: "available" as const, claim: found.claim };
    if (!tombstonedClaims.has(row.id)) {
      const parsed = (() => { try { return JSON.parse(row.record_json) as { status?: string }; } catch { return {}; } })();
      exclusions.push({ kind: "claim", id: row.id, reason: parsed.status === "forgotten" ? "forgotten_inactive" : parsed.status === "corrected" ? "corrected_superseded" : found.reason });
    }
    return { state: "unavailable" as const, reference, reason: found.reason };
  });
  // Sources export available text; forgotten raw history only with explicit history scope, deleted never.
  const sourceRows = tx.all<{ sourceId: string; revision: number; generation: number; kind: string; availability: string }>(
    "SELECT id AS sourceId, current_revision AS revision, generation, kind, availability FROM sources WHERE project_id = ? ORDER BY id LIMIT 2000", projectId);
  const sources = sourceRows.map(row => {
    const reference: SourceReference = { sourceId: row.sourceId, revision: row.revision, generation: row.generation };
    const found = lookupSource(tx, projectId, reference);
    if (found.state !== "available") {
      if (!tombstonedSources.has(`${row.sourceId}:${row.revision}:${row.generation}`)) {
        exclusions.push({ kind: "source", id: row.sourceId, reason: found.reason });
      }
      return { state: "unavailable" as const, reference, reason: found.reason };
    }
    const suppressed = tx.get("SELECT 1 FROM memory_suppressed_sources WHERE source_id = ? AND revision = ? AND generation = ?",
      row.sourceId, row.revision, row.generation);
    if (suppressed && !scope.includeHistory) {
      exclusions.push({ kind: "source", id: row.sourceId, reason: "forgotten_raw_history_excluded" });
      return { state: "unavailable" as const, reference, reason: "source_suppressed" };
    }
    // Raw owner message text is history; without the explicit history scope only its identity exports.
    if (row.kind === "message" && !scope.includeHistory) {
      exclusions.push({ kind: "message", id: row.sourceId, reason: "raw_history_not_selected" });
      return { state: "metadata_only" as const, reference, kind: row.kind, text: null };
    }
    return { state: "available" as const, reference, kind: row.kind, text: found.text };
  });
  // Jobs export committed evidence references; missing jobs surface as missing refs, never fabricated.
  const jobs = tx.all<{ record_json: string }>("SELECT record_json FROM jobs WHERE project_id = ? ORDER BY sequence LIMIT 1000", projectId)
    .map(row => {
      const job = JSON.parse(row.record_json) as { id: string; type: string; state: string; reason: string | null; evidence: string | null };
      return { id: job.id, type: job.type, state: job.state, reason: job.reason, evidence: job.evidence };
    });
  // Delivery outbox exports owner-authored texts with send states; unknown sends stay visible.
  // Delivery text exports only while its own committed source is still available; a deleted
  // delivery source never resurrects through the outbox or report copy.
  const deliverySource = (reference: SourceReference | null) => {
    if (!reference) return { state: "unavailable" as const, reason: "source_missing" };
    const found = lookupSource(tx, projectId, reference);
    return found.state === "available" ? { state: "available" as const, text: found.text } : { state: "unavailable" as const, reason: found.reason };
  };
  const deliveries = tx.all<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE project_id = ? ORDER BY sequence LIMIT 1000", projectId)
    .map(row => {
      const intent = JSON.parse(row.record_json) as { id: string; payload: { kind: string; text: string; reference?: { reportId: string; sourceId: string; sourceRevision: number; sourceGeneration: number } }; status: string };
      const ref = intent.payload.reference;
      const reference = ref ? { sourceId: ref.sourceId, revision: ref.sourceRevision, generation: ref.sourceGeneration } : null;
      const found = deliverySource(reference);
      if (found.state !== "available") exclusions.push({ kind: "message", id: intent.id, reason: `delivery_text_${found.reason}` });
      return { id: intent.id, kind: intent.payload.kind, reportId: ref?.reportId ?? null, source: reference,
        text: found.state === "available" ? intent.payload.text : null, availability: found.state, status: intent.status };
    });
  const reports = tx.all<{ record_json: string }>("SELECT record_json FROM delivery_reports WHERE project_id = ? ORDER BY rowid LIMIT 1000", projectId)
    .map(row => {
      const report = JSON.parse(row.record_json) as { id: string; kind: string; revision: number; generation: number; availability: string; text: string;
        sourceId: string; sourceRevision: number; sourceGeneration: number; committedAt: number };
      const reference: SourceReference = { sourceId: report.sourceId, revision: report.sourceRevision, generation: report.sourceGeneration };
      const found = deliverySource(reference);
      if (found.state !== "available") exclusions.push({ kind: "report", id: report.id, reason: `delivery_report_${found.reason}` });
      return { id: report.id, projectId, kind: report.kind, revision: report.revision, generation: report.generation,
        availability: found.state === "available" ? report.availability : "unavailable", text: found.state === "available" ? report.text : null,
        sourceId: report.sourceId, sourceRevision: report.sourceRevision, sourceGeneration: report.sourceGeneration, committedAt: report.committedAt };
    });
  // Missing references: extraction dependencies and task sources that no longer resolve.
  for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM memory_extractions WHERE project_id = ? LIMIT 1000", projectId)) {
    try {
      const extraction = JSON.parse(row.record_json) as { id: string; dependencies?: ClaimReference[] };
      for (const dep of extraction.dependencies ?? []) {
        if (!tx.get("SELECT 1 FROM memory_claims WHERE id = ? AND project_id = ?", dep.claimId, projectId)) {
          missingRefs.push({ kind: "claim", id: dep.claimId, reason: "extraction_dependency_missing" });
        }
      }
    } catch { missingRefs.push({ kind: "extraction", id: "unreadable", reason: "record_unreadable" }); }
  }
  // Coverage lists exactly the payload-bearing refs (bounded); `truncated` means the bound cut it, so delete previews cannot prove absence.
  const includedSources = sources.flatMap(s => s.state === "available" ? [s.reference] : []);
  const includedClaims = claims.flatMap(c => c.state === "available" ? [{ claimId: c.claim.claimId, revision: c.claim.revision, generation: c.claim.generation }] : []);
  const coverageSources = includedSources.slice(0, 500), coverageClaims = includedClaims.slice(0, 500);
  // PR monitors and candidates export as revision/scoped metadata; snapshot blobs stay
  // re-fetchable cache and are referenced by candidate identity, never embedded.
  let pr: { monitors: unknown[]; candidates: unknown[] } = { monitors: [], candidates: [] };
  try {
    const monitors = readMonitors(tx, projectId);
    const candidates = monitors.flatMap(monitor => {
      try { return readCandidates(tx, projectId, monitor.id); } catch { return []; }
    });
    for (const candidate of candidates) {
      if (candidate.status === "superseded") {
        exclusions.push({ kind: "report", id: candidate.id, reason: "superseded_stale" });
      }
    }
    pr = {
      monitors: monitors.map(monitor => ({ id: monitor.id, repository: monitor.repository, state: monitor.state, revision: monitor.revision })),
      candidates: candidates.map(candidate => ({ id: candidate.id, monitorId: candidate.monitorId, pullNumber: candidate.pullNumber,
        baseSha: candidate.baseSha, headSha: candidate.headSha, status: candidate.status, generation: candidate.generation })),
    };
  } catch { pr = { monitors: [], candidates: [] }; }
  // Private PR reports export revision, scope, computed stale flag and validated findings.
  // Snapshot blobs, apiBase and authority generations stay out; secret-like finding text is redacted.
  const prReports = (() => {
    if (!tx.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pr_reports'")) return [];
    try {
      return listReports(tx, projectId).reverse().slice(0, 500).map(report => {
        const hygiene = (finding: typeof report.findings[number]) => finding.validationErrors.includes("payload_hygiene_secret")
          || [finding.title, finding.condition, finding.impact, finding.reasoning].some(text => secretLike.test(text));
        const redacted = "(redacted: payload_hygiene_secret)";
        return {
          id: report.id, projectId, monitorId: report.monitorId, candidateId: report.candidateId,
          repository: { host: report.repository.host, owner: report.repository.owner, name: report.repository.name },
          pullNumber: report.pullNumber, baseSha: report.baseSha, headSha: report.headSha,
          policyVersion: report.policyVersion, reviewPolicyVersion: report.reviewPolicyVersion,
          revision: report.revision, status: report.status, stale: report.stale, staleReason: report.staleReason,
          scope: { requiredRoles: [...report.requiredRoles], analyzedRoles: [...report.analyzedRoles], skippedScope: [...report.skippedScope],
            coverageOverall: report.coverageOverall, enumerationComplete: report.enumerationComplete },
          findings: report.findings.map(finding => hygiene(finding)
            ? { ...finding, title: redacted, condition: redacted, impact: redacted, reasoning: redacted }
            : { ...finding }),
          specialistRuns: report.specialistRuns.map(run => ({ ...run })), synthesis: { ...report.synthesis },
          disagreements: report.disagreements.map(text => secretLike.test(text) ? redacted : text),
          evidence: { snapshotId: report.snapshotId, jobId: report.jobId, attemptId: report.attemptId },
          annotations: readAnnotations(tx, report.id).map(a => ({ id: a.id, revision: a.revision, kind: a.kind, text: secretLike.test(a.text) ? redacted : a.text, createdAt: a.createdAt })),
          createdAt: report.createdAt, updatedAt: report.updatedAt,
        };
      });
    } catch { missingRefs.push({ kind: "pr_report", id: "unreadable", reason: "record_unreadable" }); return []; }
  })();
  // Project identity makes the artifact self-describing without reusing names as authorization.
  const project = tx.get<{ id: string; name: string; revision: number; created_at: number }>(
    "SELECT id, name, revision, created_at FROM projects WHERE id = ?", projectId);
  if (!project) throw new AppError("project_not_found", 404);
  return {
    data: { project: { id: project.id, name: project.name, revision: project.revision, createdAt: project.created_at },
      topics, messages: scope.includeHistory ? messages : [], messageCount, tasks: taskModels, proposals, events, decisions, ownerDecisions: ownerDecisionRows, claims, sources, jobs, deliveries, reports, pr, prReports },
    coverage: { sources: coverageSources, claims: coverageClaims,
      truncated: includedSources.length > coverageSources.length || includedClaims.length > coverageClaims.length },
    counts: { topics: topics.length, messages: messageCount, tasks: tasks.length, decisions: ownerDecisionRows.length, claims: claims.filter(c => c.state === "available").length, jobs: jobs.length, deliveries: deliveries.length, prReports: prReports.length },
    exclusions, missingRefs,
  };
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
  assembled: Pick<Assembled, "coverage" | "counts" | "exclusions" | "missingRefs">): Omit<ExportManifestBase, "retention"> {
  const tombstones = readDeletionLedger(tx).filter(t => t.projectId === input.projectId);
  return {
    contract: exportContract, formatVersion: exportFormatVersion, id: input.id, projectId: input.projectId, createdAt: input.now,
    appSchema: tx.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? exportSchemaVersion,
    scope: { ...input.scope }, projectRevision: input.projectRevision,
    coverage: assembled.coverage, counts: assembled.counts, exclusions: assembled.exclusions, missingRefs: assembled.missingRefs,
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

const storedBytes = (json: string): number => {
  try { return (JSON.parse(json) as ExportManifest).artifact?.bytes ?? 0; } catch { return 0; }
};

/** Retires over-bound registrations in the transaction; returns file paths to remove only after commit. */
function enforceExportRetention(tx: AppTransaction, exportDir: string, projectId: string, incomingBytes: number): { pruned: string[]; files: string[] } {
  const existing = tx.all<{ id: string; record_json: string }>(
    "SELECT id, record_json FROM export_artifacts WHERE project_id = ? ORDER BY created_at, id", projectId);
  let total = incomingBytes + existing.reduce((sum, row) => sum + storedBytes(row.record_json), 0);
  const pruned: string[] = [];
  const retire = (row: { id: string; record_json: string }) => {
    tx.run("DELETE FROM export_artifacts WHERE id = ?", row.id);
    pruned.push(row.id);
    total -= storedBytes(row.record_json);
  };
  const overCount = Math.max(0, existing.length + 1 - exportRetention.maxExports);
  for (const row of existing.slice(0, overCount)) retire(row);
  for (const row of existing.slice(overCount)) {
    if (total <= exportRetention.maxBytes) break;
    retire(row);
  }
  return { pruned, files: pruned.map(id => join(exportDir, `${id}.json`)) };
}

function serviceUid(): number | null {
  try {
    const getuid = (process as unknown as { getuid?: () => number }).getuid;
    return typeof getuid === "function" ? getuid() : null;
  } catch { return null; }
}

/**
 * Creates (0700) or verifies the managed export directory. A symlink, non-directory,
 * group/world-accessible or foreign-owned directory fails closed so no artifact is
 * written through a redirected or shared path.
 */
export function ensureExportDir(dir: string): void {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch { throw new AppError("export_storage_unavailable", 503); }
  let stats: ReturnType<typeof lstatSync>;
  try { stats = lstatSync(dir); } catch { throw new AppError("export_storage_unavailable", 503); }
  const uid = serviceUid();
  if (stats.isSymbolicLink() || !stats.isDirectory() || (stats.mode & 0o077) !== 0 || (uid !== null && stats.uid !== uid)) {
    throw new AppError("unsafe_export_destination", 409);
  }
}

/** Removes unregistered artifacts and stale temp files left by a crash between publish and commit. */
function sweepOrphanExports(tx: AppTransaction, dir: string): void {
  let names: string[];
  try { names = readdirSync(dir).slice(0, 500); } catch { return; }
  for (const name of names) {
    const temp = exportTempName.test(name);
    if (!temp && !exportFileName.test(name)) continue;
    if (!temp && tx.get("SELECT 1 FROM export_artifacts WHERE id = ?", name.slice(0, -".json".length))) continue;
    try { if (!lstatSync(join(dir, name)).isDirectory()) unlinkSync(join(dir, name)); } catch { /* Best-effort orphan cleanup. */ }
  }
}

/** Lifecycle generation of one project's exportable state; any change between assembly and publish fences the artifact. */
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

/** An export registered in the open transaction whose artifact still sits in a private temp file. */
export interface StagedExport {
  manifest: ValidExportManifest;
  tempPath: string;
  finalPath: string;
  dir: string;
  lifecycleMark: string;
  prunedFiles: string[];
  published: boolean;
}

/**
 * Stages one export inside the caller transaction: lifecycle-checks every included ref,
 * writes the artifact to an exclusive 0600 temp file (fsynced), retires over-bound
 * registrations and registers the manifest. Nothing is visible at the final path until
 * {@link publishExport}; callers must {@link discardExport} if the transaction does not commit
 * and {@link finalizeExport} after it commits.
 */
export function stageExport(tx: AppTransaction, input: {
  id: string; now: number; projectId: string; projectRevision: number; scope: ExportScope;
  exportDir: string; note: string;
}): StagedExport {
  requireId(input.id);
  ensureExportDir(input.exportDir);
  sweepOrphanExports(tx, input.exportDir);
  const lifecycleMark = exportLifecycleMark(tx, input.projectId);
  const assembled = assembleExport(tx, input.projectId, input.scope);
  const body = JSON.stringify({ contract: exportContract, formatVersion: exportFormatVersion, exportId: input.id, projectId: input.projectId,
    exportedAt: input.now, scope: input.scope, disclosure: disclosureFor(input.scope), note: input.note, data: assembled.data });
  const bytes = Buffer.byteLength(body);
  const hash = createHash("sha256").update(body).digest("hex");
  const finalPath = join(input.exportDir, `${input.id}.json`);
  const tempPath = join(input.exportDir, `.${input.id}.json.tmp-${process.pid}`);
  let fd: number | null = null;
  try {
    // "wx" is O_CREAT|O_EXCL: an existing file or planted symlink at the temp path fails instead of being followed.
    fd = openSync(tempPath, "wx", 0o600);
    writeSync(fd, body);
    fsyncSync(fd);
  } catch {
    if (fd !== null) { try { closeSync(fd); } catch { /* Closed below. */ } fd = null; }
    try { unlinkSync(tempPath); } catch { /* Temp may not exist. */ }
    throw new AppError("export_storage_unavailable", 503);
  } finally {
    if (fd !== null) closeSync(fd);
  }
  const { pruned, files } = enforceExportRetention(tx, input.exportDir, input.projectId, bytes);
  const manifest: ValidExportManifest = {
    ...manifestBase(tx, input, assembled),
    retention: { maxExports: exportRetention.maxExports, maxBytes: exportRetention.maxBytes, pruned },
    state: "valid", failure: null,
    artifact: { path: finalPath, bytes, hash },
  };
  tx.run("INSERT INTO export_artifacts VALUES (?, ?, ?, ?)", manifest.id, input.projectId, manifest.createdAt, JSON.stringify(manifest));
  return { manifest, tempPath, finalPath, dir: input.exportDir, lifecycleMark, prunedFiles: files, published: false };
}

/**
 * Publishes a staged artifact inside the same open transaction: re-checks the project
 * lifecycle generation (deletion/forget/correction/revision) and that the registration
 * still exists, then atomically renames the temp file into place. A changed generation
 * throws `export_fenced_by_lifecycle`; the caller rolls back and discards.
 */
export function publishExport(tx: AppTransaction, staged: StagedExport): void {
  if (exportLifecycleMark(tx, staged.manifest.projectId) !== staged.lifecycleMark ||
      !tx.get("SELECT 1 FROM export_artifacts WHERE id = ?", staged.manifest.id)) {
    throw new AppError("export_fenced_by_lifecycle", 409);
  }
  ensureExportDir(staged.dir);
  try {
    // rename(2) replaces a planted final-path entry instead of following it.
    renameSync(staged.tempPath, staged.finalPath);
    staged.published = true;
  } catch {
    throw new AppError("export_storage_unavailable", 503);
  }
  try {
    const dirFd = openSync(staged.dir, "r");
    try { fsyncSync(dirFd); } finally { closeSync(dirFd); }
  } catch { /* Directory fsync is best-effort on platforms that refuse it. */ }
}

/** Removes a staged/published artifact whose registration did not commit; never touches other exports. */
export function discardExport(staged: StagedExport): void {
  for (const path of [staged.tempPath, staged.finalPath]) {
    try { unlinkSync(path); } catch { /* Already absent. */ }
  }
}

/** After commit: removes files of registrations retention retired in the committed transaction. */
export function finalizeExport(staged: StagedExport): void {
  removeRetiredExportFiles(staged.prunedFiles);
}

/** Best-effort removal of artifact files whose registrations a committed transaction retired. */
export function removeRetiredExportFiles(paths: readonly string[]): void {
  for (const path of paths) {
    try { if (!lstatSync(path).isDirectory()) rmSync(path); } catch { /* Best-effort; the orphan sweep retries. */ }
  }
}

/**
 * Records a durable failed export (no artifact, empty coverage) so the request has one
 * inspectable logical outcome. Only bounded reason codes are stored, never error text or paths.
 */
export function recordFailedExport(tx: AppTransaction, input: {
  id: string; now: number; projectId: string; projectRevision: number; scope: ExportScope; failure: ExportFailure; exportDir: string;
}): { manifest: FailedExportManifest; prunedFiles: string[] } {
  const empty = { coverage: { sources: [], claims: [], truncated: false },
    counts: { topics: 0, messages: 0, tasks: 0, decisions: 0, claims: 0, jobs: 0, deliveries: 0, prReports: 0 }, exclusions: [], missingRefs: [] };
  tx.run("DELETE FROM export_artifacts WHERE id = ?", input.id);
  // Failed records share the same bounded registry so repeated failures cannot grow it without limit.
  const { pruned, files } = enforceExportRetention(tx, input.exportDir, input.projectId, 0);
  const manifest: FailedExportManifest = {
    ...manifestBase(tx, input, empty),
    retention: { maxExports: exportRetention.maxExports, maxBytes: exportRetention.maxBytes, pruned },
    state: "failed", failure: { ...input.failure }, artifact: null,
  };
  tx.run("INSERT INTO export_artifacts VALUES (?, ?, ?, ?)", manifest.id, input.projectId, manifest.createdAt, JSON.stringify(manifest));
  return { manifest, prunedFiles: files };
}

/** Maps any thrown value to a bounded failure reason; error messages never reach records. */
export function exportFailureReason(error: unknown): ExportFailureReason {
  const code = error instanceof AppError ? error.code : "";
  return (exportFailureReasons as readonly string[]).includes(code) ? code as ExportFailureReason : "export_failed";
}

/** Scans an export artifact for secret material; returns canary hits (empty when clean). */
export function scanExportSecrets(artifactJson: string, canaries: string[]): string[] {
  return canaries.filter(c => c && artifactJson.includes(c));
}

export function artifactBytes(dir: string, id: string): number {
  try { return statSync(join(dir, `${id}.json`)).size; } catch { return -1; }
}

export function ownExportDir(databasePath: string, override?: string): string {
  const dir = override ?? exportDirFor(databasePath);
  if (dirname(dir) === dir || dir.length > 1024) throw new AppError("invalid_export_destination", 500);
  return dir;
}
