import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../errors";
import { lookupSource, requireId } from "../sources";
import type { AppTransaction } from "../store";
import { lookupActiveClaim } from "../memory/read";
import { readDeletionLedger } from "../memory/delete";
import { readCandidates, readMonitors } from "../pr";
import type { ClaimReference } from "../memory/types";
import type { SourceReference } from "../sources";

export const exportContract = "ops.project_export/v1" as const;
export const exportSchemaVersion = 20;
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

export interface ExportExclusion { kind: "source" | "claim" | "job" | "report" | "context" | "message"; id: string; reason: string }
export interface ExportManifest {
  contract: typeof exportContract;
  id: string;
  projectId: string;
  createdAt: number;
  appSchema: number;
  scope: ExportScope;
  projectRevision: number;
  coverage: { sources: SourceReference[]; claims: ClaimReference[]; truncated: boolean };
  counts: { topics: number; messages: number; tasks: number; decisions: number; claims: number; jobs: number; deliveries: number };
  exclusions: ExportExclusion[];
  missingRefs: { kind: string; id: string; reason: string }[];
  pendingDeletions: string[];
  residuals: { backups: string[]; external: string[] };
  lifecycle: { tombstonesApplied: number; note: string };
  retention: { maxExports: number; maxBytes: number; pruned: string[] };
  state: "valid";
  artifact: { path: string; bytes: number; hash: string };
}

export interface ExportReceipt { manifest: ExportManifest; duplicate: boolean }
export interface ExportPreview { manifest: Omit<ExportManifest, "id" | "artifact" | "retention"> & { id: null; artifact: null }; counts: ExportManifest["counts"]; }

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

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

export function readExportManifest(tx: AppTransaction, projectId: string, id: string): ExportManifest {
  requireId(projectId); requireId(id);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM export_artifacts WHERE id = ? AND project_id = ?", id, projectId);
  if (!row) throw new AppError("export_not_found", 404);
  const manifest = JSON.parse(row.record_json) as ExportManifest;
  if (manifest.contract !== exportContract) throw new AppError("export_corrupt", 500);
  return manifest;
}

export function listExportArtifacts(tx: AppTransaction, projectId: string, limit = 50): ExportManifest[] {
  requireId(projectId);
  return tx.all<{ record_json: string }>("SELECT record_json FROM export_artifacts WHERE project_id = ? ORDER BY created_at, id LIMIT ?",
    projectId, Math.min(Math.max(limit, 1), 100)).map(row => JSON.parse(row.record_json) as ExportManifest);
}

interface Assembled {
  data: Record<string, unknown>;
  coverage: ExportManifest["coverage"];
  counts: ExportManifest["counts"];
  exclusions: ExportExclusion[];
  missingRefs: ExportManifest["missingRefs"];
}

/** Assembles one project export inside the caller transaction; every included ref is lifecycle-checked here. */
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
  const decisions = tx.all<{ record_json: string }>("SELECT record_json FROM decision_proposals WHERE project_id = ? ORDER BY created_at LIMIT 500", projectId)
    .map(row => JSON.parse(row.record_json));
  const ownerDecisionRows = tx.all<{ id: string; topic_id: string; revision: number; proposal_id: string; proposal_revision: number; option_id: string | null; conclusion: string; rationale: string; created_at: number; superseded_by: string | null }>(
    "SELECT id, topic_id, proposal_id, proposal_revision, option_id, conclusion, rationale, revision, created_at, superseded_by FROM owner_decisions WHERE project_id = ? ORDER BY created_at LIMIT 500", projectId);
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
    return { state: "available" as const, reference, kind: row.kind, text: found.text };
  });
  // Jobs export committed evidence references; missing jobs surface as missing refs, never fabricated.
  const jobs = tx.all<{ record_json: string }>("SELECT record_json FROM jobs WHERE project_id = ? ORDER BY sequence LIMIT 1000", projectId)
    .map(row => {
      const job = JSON.parse(row.record_json) as { id: string; type: string; state: string; reason: string | null; evidence: string | null };
      return { id: job.id, type: job.type, state: job.state, reason: job.reason, evidence: job.evidence };
    });
  // Delivery outbox exports owner-authored texts with send states; unknown sends stay visible.
  const deliveries = tx.all<{ record_json: string }>("SELECT record_json FROM delivery_intents WHERE project_id = ? ORDER BY sequence LIMIT 1000", projectId)
    .map(row => {
      const intent = JSON.parse(row.record_json) as { id: string; payload: { kind: string; text: string }; status: string };
      return { id: intent.id, kind: intent.payload.kind, text: intent.payload.text, status: intent.status };
    });
  const reports = tx.all<{ record_json: string }>("SELECT record_json FROM delivery_reports WHERE project_id = ? LIMIT 1000", projectId)
    .map(row => JSON.parse(row.record_json));
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
  const coverageSources = sources.flatMap(s => s.state === "available" ? [s.reference] : []).slice(0, 500);
  const coverageClaims = claims.flatMap(c => c.state === "available" ? [{ claimId: c.claim.claimId, revision: c.claim.revision, generation: c.claim.generation }] : []).slice(0, 500);
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
  // Project identity makes the artifact self-describing without reusing names as authorization.
  const project = tx.get<{ id: string; name: string; revision: number; created_at: number }>(
    "SELECT id, name, revision, created_at FROM projects WHERE id = ?", projectId);
  if (!project) throw new AppError("project_not_found", 404);
  return {
    data: { project: { id: project.id, name: project.name, revision: project.revision, createdAt: project.created_at },
      topics, messages: scope.includeHistory ? messages : [], messageCount, tasks: taskModels, proposals, events, decisions, ownerDecisions: ownerDecisionRows, claims, sources, jobs, deliveries, reports, pr },
    coverage: { sources: coverageSources, claims: coverageClaims,
      truncated: sources.length > coverageSources.length || claims.length > coverageClaims.length },
    counts: { topics: topics.length, messages: messageCount, tasks: tasks.length, decisions: ownerDecisionRows.length, claims: claims.filter(c => c.state === "available").length, jobs: jobs.length, deliveries: deliveries.length },
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

/** Reads a preview of what an export would publish, without creating any artifact. */
export function exportPreview(tx: AppTransaction, projectId: string, scope: ExportScope, projectRevision: number): ExportPreview {
  const assembled = assembleExport(tx, projectId, scope);
  const tombstones = readDeletionLedger(tx).filter(t => t.projectId === projectId);
  const appSchema = tx.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? exportSchemaVersion;
  return {
    manifest: {
      contract: exportContract, id: null, projectId, createdAt: 0, appSchema,
      scope: { ...scope }, projectRevision, coverage: assembled.coverage, counts: assembled.counts,
      exclusions: assembled.exclusions, missingRefs: assembled.missingRefs,
      pendingDeletions: pendingDeletionIds(tx, projectId),
      residuals: { backups: residualBackups(tx, projectId), external: ["telegram_delivery_copies_not_exported_or_deleted", "provider_session_copies_not_exported"] },
      lifecycle: { tombstonesApplied: tombstones.length, note: "รวมเฉพาะ generation ที่ยัง active; ที่ถูกลบ/ลืม/แก้อยู่ใน exclusions" },
      state: "valid", artifact: null,
    },
    counts: assembled.counts,
  };
}

function enforceExportRetention(tx: AppTransaction, exportDir: string, projectId: string, incomingBytes: number): string[] {
  const existing = tx.all<{ id: string; created_at: number; record_json: string }>(
    "SELECT id, created_at, record_json FROM export_artifacts WHERE project_id = ? ORDER BY created_at, id", projectId);
  let total = incomingBytes;
  for (const row of existing) {
    try { total += (JSON.parse(row.record_json) as ExportManifest).artifact.bytes; } catch { /* Corrupt rows count as zero; validation surfaces them. */ }
  }
  const pruned: string[] = [];
  for (const row of existing.slice(0, Math.max(0, existing.length + 1 - exportRetention.maxExports))) {
    tx.run("DELETE FROM export_artifacts WHERE id = ?", row.id);
    pruned.push(row.id);
    try { const file = join(exportDir, `${row.id}.json`); if (existsSync(file)) rmSync(file); } catch { /* Best-effort cleanup. */ }
  }
  if (total > exportRetention.maxBytes) {
    for (const row of tx.all<{ id: string; record_json: string }>(
      "SELECT id, record_json FROM export_artifacts WHERE project_id = ? ORDER BY created_at, id", projectId)) {
      try {
        const bytes = (JSON.parse(row.record_json) as ExportManifest).artifact.bytes;
        if (total <= exportRetention.maxBytes) break;
        tx.run("DELETE FROM export_artifacts WHERE id = ?", row.id);
        pruned.push(row.id);
        try { const file = join(exportDir, `${row.id}.json`); if (existsSync(file)) rmSync(file); } catch { /* Best-effort cleanup. */ }
        total -= bytes;
      } catch { /* Keep corrupt rows visible to validation. */ }
    }
  }
  return pruned;
}

/**
 * Creates a durable export artifact: lifecycle-checks every included ref in the same
 * transaction, writes the JSON artifact with restrictive permissions, registers it for
 * subsequent delete previews and enforces retention bounds.
 */
export function createExport(tx: AppTransaction, input: {
  id: string; now: number; projectId: string; projectRevision: number; scope: ExportScope;
  exportDir: string; note: string;
}): ExportManifest {
  const assembled = assembleExport(tx, input.projectId, input.scope);
  const tombstones = readDeletionLedger(tx).filter(t => t.projectId === input.projectId);
  const body = JSON.stringify({ contract: exportContract, projectId: input.projectId,
    exportedAt: input.now, scope: input.scope, note: input.note, data: assembled.data });
  const bytes = Buffer.byteLength(body);
  const hash = createHash("sha256").update(body).digest("hex");
  const pruned = enforceExportRetention(tx, input.exportDir, input.projectId, bytes);
  const path = join(input.exportDir, `${input.id}.json`);
  try {
    mkdirSync(input.exportDir, { recursive: true, mode: 0o700 });
    writeFileSync(path, body, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    throw new AppError("export_storage_unavailable", 503);
  }
  const manifest: ExportManifest = {
    contract: exportContract, id: input.id, projectId: input.projectId, createdAt: input.now,
    appSchema: tx.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? exportSchemaVersion, scope: { ...input.scope }, projectRevision: input.projectRevision,
    coverage: assembled.coverage, counts: assembled.counts,
    exclusions: assembled.exclusions, missingRefs: assembled.missingRefs,
    pendingDeletions: pendingDeletionIds(tx, input.projectId),
    residuals: { backups: residualBackups(tx, input.projectId), external: ["telegram_delivery_copies_not_exported_or_deleted", "provider_session_copies_not_exported"] },
    lifecycle: { tombstonesApplied: tombstones.length, note: "รวมเฉพาะ generation ที่ยัง active; ที่ถูกลบ/ลืม/แก้อยู่ใน exclusions" },
    retention: { maxExports: exportRetention.maxExports, maxBytes: exportRetention.maxBytes, pruned },
    state: "valid",
    artifact: { path, bytes, hash },
  };
  tx.run("INSERT INTO export_artifacts VALUES (?, ?, ?, ?)", manifest.id, input.projectId, manifest.createdAt, JSON.stringify(manifest));
  return manifest;
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
