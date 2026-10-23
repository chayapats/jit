import { AppError } from "../errors";
import { invalidatePendingJob, jobData } from "../jobs/queue";
import { requireId, requireReference, requireText } from "../sources";
import type { AppTransaction } from "../store";
import type { Discussion } from "../team/types";
import { fenceStaleContexts } from "./context";
import { fenceUnavailableExtractions } from "./extract";
import { eligibleMemorySource, lookupActiveClaim, requireClaimReference } from "./read";
import type {
  ClaimLookup, ClaimReference, CorrectMemoryCommand, CorrectionImpact, MemoryClaim, MemoryCorrection,
} from "./types";

const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/** Validates the complete owner command before any state is read; receipt deduplication hashes the result. */
export function correctionIdentity(command: CorrectMemoryCommand, contextBytes: number): string {
  const encoded = jobData(command, contextBytes);
  if (!exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) || command.kind !== "memory.correct" ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1 ||
      !exact(command.payload, ["claim", "text", "quote", "source", "reason"])) throw new AppError("invalid_memory_correction");
  requireId(command.projectId);
  requireClaimReference(command.payload.claim);
  requireText(command.payload.text, 2048); requireText(command.payload.quote, 2048); requireText(command.payload.reason, 500);
  requireReference(command.payload.source);
  if (!exact(command.payload.source, ["sourceId", "revision", "generation"])) throw new AppError("invalid_memory_correction");
  return encoded;
}

/** The durable correction for one claim revision, or null when it was never corrected. */
export function readCorrection(tx: AppTransaction, projectId: string, claimId: string): MemoryCorrection | null {
  requireId(projectId); requireId(claimId);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM memory_corrections WHERE project_id = ? AND claim_id = ?", projectId, claimId);
  return row ? JSON.parse(row.record_json) as MemoryCorrection : null;
}

function pendingReferencing(tx: AppTransaction, projectId: string, claimId: string): { id: string; projectId: string }[] {
  const found = new Map<string, { id: string; projectId: string }>();
  const pending = "state IN ('queued', 'admitted', 'waiting')";
  for (const row of tx.all<{ projectId: string; jobId: string; json: string }>(
    `SELECT project_id AS projectId, job_id AS jobId, record_json AS json FROM memory_extractions WHERE job_id IN (SELECT id FROM jobs WHERE ${pending}) LIMIT 500`)) {
    try {
      const extraction = JSON.parse(row.json) as { dependencies?: ClaimReference[] };
      if (extraction.dependencies?.some(ref => ref.claimId === claimId)) found.set(row.jobId, { id: row.jobId, projectId: row.projectId });
    } catch { /* Corrupt rows fail closed elsewhere; impact stays silent here. */ }
  }
  for (const row of tx.all<{ projectId: string; jobId: string; json: string }>(
    `SELECT project_id AS projectId, job_id AS jobId, record_json AS json FROM team_runs WHERE job_id IN (SELECT id FROM jobs WHERE ${pending}) LIMIT 500`)) {
    try {
      const parsed = JSON.parse(row.json) as { kind?: string; request?: { manifest?: { claims?: { claimId: string }[] } }; manifest?: { claims?: { claimId: string }[] } };
      const referenced = parsed.request?.manifest?.claims ?? (parsed.kind === "discussion" ? parsed.manifest?.claims : undefined);
      if (referenced?.some(claim => claim.claimId === claimId)) found.set(row.jobId, { id: row.jobId, projectId: row.projectId });
    } catch { /* See above. */ }
  }
  for (const row of tx.all<{ projectId: string; jobId: string; json: string }>(
    `SELECT project_id AS projectId, job_id AS jobId, record_json AS json FROM coordinator_syntheses WHERE job_id IN (SELECT id FROM jobs WHERE ${pending}) LIMIT 500`)) {
    try {
      const request = (JSON.parse(row.json) as { request?: { manifest?: { claims?: { claimId: string }[] } } }).request;
      if (request?.manifest?.claims?.some(claim => claim.claimId === claimId)) found.set(row.jobId, { id: row.jobId, projectId: row.projectId });
    } catch { /* See above. */ }
  }
  return [...found.values()].filter(job => job.projectId === projectId);
}

/**
 * app.memory_correction/v1 inspector preview: the exact claim, its existing correction,
 * same-project dependents, recorded run contexts that used it and pending jobs that would fence.
 */
export function correctionImpact(tx: AppTransaction, projectId: string, reference: ClaimReference): CorrectionImpact {
  requireId(projectId); requireClaimReference(reference);
  const claim = lookupActiveClaim(tx, projectId, reference);
  const correction = readCorrection(tx, projectId, reference.claimId);
  const dependents: CorrectionImpact["dependents"] = [];
  for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM memory_claims WHERE project_id = ? LIMIT 2000", projectId)) {
    try {
      const candidate = JSON.parse(row.record_json) as MemoryClaim;
      if (candidate.claimId === reference.claimId) continue;
      if ([...candidate.dependencies, ...candidate.conflicts].some(ref => ref.claimId === reference.claimId)) {
        const live = lookupActiveClaim(tx, projectId, { claimId: candidate.claimId, revision: candidate.revision, generation: candidate.generation });
        dependents.push({ projectId, reference: { claimId: candidate.claimId, revision: candidate.revision, generation: candidate.generation },
          text: live.state === "available" ? live.claim.text : null });
      }
    } catch { /* Skip unreadable rows; availability stays authoritative in lookupActiveClaim. */ }
  }
  const contexts = tx.all<{ id: string; projectId: string; ownerKind: string; ownerId: string }>(
    `SELECT c.id, c.project_id AS projectId, c.owner_kind AS ownerKind, c.owner_id AS ownerId FROM memory_contexts c
     JOIN memory_context_entries e ON e.context_id = c.id WHERE e.kind = 'claim' AND e.entry_id = ? AND e.origin_project_id = ? LIMIT 100`,
    reference.claimId, projectId);
  return { claim, correction, dependents, contexts,
    pendingJobs: claim.state === "available" ? pendingReferencing(tx, projectId, reference.claimId) : [],
    note: "การแก้ไม่เปลี่ยนงาน มติ บทบาท หรือสิทธิ์ที่รับรองแล้ว งานที่ค้างอยู่จะถูก fence และบริบทเดิมไม่ถูกใช้อ้างอิงอีก" };
}

export interface CorrectionResult { correction: MemoryCorrection; replacement: ClaimReference }

/**
 * app.memory_correction/v1
 * Supersedes one exact active claim revision with an owner-approved replacement sourced from one
 * committed non-derived source. Derived claims stay untouched: they lose active lineage through
 * the shared active-generation query, so later answers and contexts cannot reuse the old revision.
 * Queued and running work that admitted the old revision is fenced in the same transaction;
 * native session retirement continues through the existing jobs.session_reconcile lifecycle.
 * Tasks, decisions, roles and standing authorizations are never modified here.
 */
export function prepareCorrection(tx: AppTransaction, command: CorrectMemoryCommand, contextBytes: number, ownerRevision: number, projectRevision: number, now: number): CorrectionResult {
  correctionIdentity(command, contextBytes);
  const p = command.payload;
  if (projectRevision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  if (readCorrection(tx, command.projectId, p.claim.claimId)) throw new AppError("memory_already_corrected", 409);
  const found = lookupActiveClaim(tx, command.projectId, p.claim);
  if (found.state !== "available") throw new AppError("memory_correction_unavailable", 409);
  const target = found.claim;
  const source = eligibleMemorySource(tx, command.projectId, p.source);
  if (!source.text.includes(p.quote)) throw new AppError("memory_correction_unavailable", 409);
  const kind = source.attribution.kind === "owner" && p.text === p.quote ? "explicit_fact" : "inference";
  const correctionId = crypto.randomUUID();
  const replacement: MemoryClaim = { claimId: crypto.randomUUID(), revision: 1, generation: 1,
    projectId: command.projectId, extractionId: target.extractionId, kind, text: p.text, quote: p.quote,
    source: { ...p.source }, dependencies: [], conflicts: [], status: "active", createdAt: now, decision: null };
  const corrected: MemoryClaim = { ...target, status: "corrected", correctionId, replacement: { claimId: replacement.claimId, revision: 1, generation: 1 } };
  const correction: MemoryCorrection = { id: correctionId, projectId: command.projectId, claimId: target.claimId,
    fromRevision: target.revision, fromGeneration: target.generation,
    replacement: { claimId: replacement.claimId, revision: 1, generation: 1 },
    correction: { ...p.source }, quote: p.quote, reason: p.reason,
    ownerRevision, projectRevision, createdAt: now };
  tx.run("INSERT INTO memory_claims (id, project_id, extraction_id, revision, generation, record_json) VALUES (?, ?, ?, 1, 1, ?)",
    replacement.claimId, command.projectId, replacement.extractionId, JSON.stringify(replacement));
  tx.run("UPDATE memory_claims SET record_json = ? WHERE id = ? AND project_id = ?", JSON.stringify(corrected), target.claimId, command.projectId);
  tx.run("INSERT INTO memory_corrections (id, project_id, claim_id, record_json) VALUES (?, ?, ?, ?)",
    correction.id, command.projectId, target.claimId, JSON.stringify(correction));
  fenceStaleContexts(tx, now);
  fenceCorrectedDiscussions(tx, command.projectId, target.claimId, now);
  fenceUnavailableExtractions(tx, command.projectId, now);
  return { correction, replacement: { claimId: replacement.claimId, revision: 1, generation: 1 } };
}

/**
 * Discussions store their assembled manifest at the top level (not under `.request`),
 * so the shared stale-context fence cannot see them. A discussion whose manifest still
 * cites the corrected claim is fenced here with its specialist participations; the next
 * run must assemble a fresh context from active memory before any result can commit.
 */
function fenceCorrectedDiscussions(tx: AppTransaction, projectId: string, claimId: string, now: number): void {
  for (const row of tx.all<{ projectId: string; json: string }>(
    "SELECT project_id AS projectId, record_json AS json FROM team_runs LIMIT 2000")) {
    if (row.projectId !== projectId) continue;
    let discussion: Discussion;
    try {
      discussion = JSON.parse(row.json) as Discussion;
      if (discussion.kind !== "discussion" || !discussion.manifest) continue;
    } catch { continue; }
    const cites = discussion.manifest.claims.some(claim => claim.claimId === claimId);
    if (!cites) continue;
    const stale = (entry: { projectId: string; claimId: string; revision: number; generation: number }) =>
      lookupActiveClaim(tx, entry.projectId, { claimId: entry.claimId, revision: entry.revision, generation: entry.generation }).state !== "available";
    if (!discussion.manifest.claims.some(entry => stale(entry))) continue;
    invalidatePendingJob(tx, row.projectId, discussion.jobId, "source_retired", now);
    for (const participation of discussion.participations) invalidatePendingJob(tx, row.projectId, participation.jobId, "source_retired", now);
  }
}
