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

/** Preview caps: lists longer than these are truncated and flagged, never silently complete. */
export const impactPreviewBounds = Object.freeze({ dependents: 2000, contexts: 100, pendingJobs: 500 });

/** Caps a preview list; `truncated` tells the owner the shown items are a lower bound. */
export function capped<T>(rows: T[], limit: number): { items: T[]; truncated: boolean } {
  return rows.length > limit ? { items: rows.slice(0, limit), truncated: true } : { items: rows, truncated: false };
}

function pendingReferencing(tx: AppTransaction, originProjectId: string, affected: ReadonlySet<string>): { jobs: { id: string; projectId: string }[]; truncated: boolean } {
  const found = new Map<string, { id: string; projectId: string }>();
  const pending = "state IN ('queued', 'admitted', 'waiting')";
  const cites = (json: string): boolean => {
    try {
      const parsed = JSON.parse(json) as {
        kind?: string; dependencies?: ClaimReference[];
        request?: { manifest?: { claims?: { projectId: string; claimId: string }[] } };
        manifest?: { claims?: { projectId: string; claimId: string }[] };
      };
      if (parsed.dependencies?.some(ref => affected.has(ref.claimId))) return true;
      const manifest = parsed.request?.manifest ?? (parsed.kind === "discussion" ? parsed.manifest : undefined);
      return !!manifest?.claims?.some(entry => entry.projectId === originProjectId && affected.has(entry.claimId));
    } catch { return false; /* Corrupt rows fail closed elsewhere; impact stays silent here. */ }
  };
  const collect = (table: string): void => {
    if (found.size > impactPreviewBounds.pendingJobs) return;
    for (const row of tx.all<{ projectId: string; jobId: string; json: string }>(
      `SELECT project_id AS projectId, job_id AS jobId, record_json AS json FROM ${table} WHERE job_id IN (SELECT id FROM jobs WHERE ${pending})`)) {
      if (cites(row.json)) found.set(row.jobId, { id: row.jobId, projectId: row.projectId });
      if (found.size > impactPreviewBounds.pendingJobs) break;
    }
  };
  collect("memory_extractions"); collect("team_runs"); collect("coordinator_syntheses");
  const jobs = [...found.values()];
  return jobs.length > impactPreviewBounds.pendingJobs
    ? { jobs: jobs.slice(0, impactPreviewBounds.pendingJobs), truncated: true }
    : { jobs, truncated: false };
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
  let dependentsTruncated = false;
  for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM memory_claims WHERE project_id = ?", projectId)) {
    if (dependents.length > impactPreviewBounds.dependents) { dependentsTruncated = true; break; }
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
  const dependentIds = new Set([reference.claimId, ...dependents.map(item => item.reference.claimId)]);
  const listed = capped(dependents, impactPreviewBounds.dependents);
  const contextRows = tx.all<{ id: string; projectId: string; ownerKind: string; ownerId: string }>(
    `SELECT c.id, c.project_id AS projectId, c.owner_kind AS ownerKind, c.owner_id AS ownerId FROM memory_contexts c
     JOIN memory_context_entries e ON e.context_id = c.id WHERE e.kind = 'claim' AND e.entry_id = ? AND e.origin_project_id = ?`,
    reference.claimId, projectId);
  const listedContexts = capped(contextRows, impactPreviewBounds.contexts);
  const pending = claim.state === "available" ? pendingReferencing(tx, projectId, dependentIds) : { jobs: [], truncated: false };
  return { claim, correction, dependents: listed.items, contexts: listedContexts.items, pendingJobs: pending.jobs,
    truncated: { dependents: dependentsTruncated || listed.truncated, contexts: listedContexts.truncated, pendingJobs: pending.truncated },
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
 * so the shared stale-context fence cannot see them. Affected discussions are driven from
 * the indexed memory_context_entries (no row cap, any owning project): a discussion whose
 * recorded context cited the corrected claim — directly or through a now-unavailable
 * dependent — is fenced with its specialist participations under its own project. The next
 * run must assemble a fresh context from active memory before any result can commit.
 */
function fenceCorrectedDiscussions(tx: AppTransaction, projectId: string, claimId: string, now: number): void {
  const pending = "j.state IN ('queued', 'admitted', 'waiting')";
  const rows = tx.all<{ projectId: string; jobId: string; json: string }>(
    `SELECT r.project_id AS projectId, r.job_id AS jobId, r.record_json AS json FROM memory_context_entries e
     JOIN memory_contexts c ON c.id = e.context_id
     JOIN team_runs r ON r.id = c.owner_id
     JOIN jobs j ON j.id = r.job_id
     WHERE c.owner_kind = 'discussion' AND ${pending} AND e.kind = 'claim' AND e.entry_id = ? AND e.origin_project_id = ?`,
    claimId, projectId);
  for (const row of rows) {
    let discussion: Discussion;
    try {
      discussion = JSON.parse(row.json) as Discussion;
      if (discussion.kind !== "discussion" || !discussion.manifest) continue;
    } catch { continue; }
    const stale = (entry: { projectId: string; claimId: string; revision: number; generation: number }) =>
      lookupActiveClaim(tx, entry.projectId, { claimId: entry.claimId, revision: entry.revision, generation: entry.generation }).state !== "available";
    if (!discussion.manifest.claims.some(entry => stale(entry))) continue;
    invalidatePendingJob(tx, row.projectId, discussion.jobId, "source_retired", now);
    for (const participation of discussion.participations) invalidatePendingJob(tx, row.projectId, participation.jobId, "source_retired", now);
  }
}
