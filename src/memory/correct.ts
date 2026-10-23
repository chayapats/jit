import { AppError } from "../errors";
import { invalidatePendingJob, jobData } from "../jobs/queue";
import { requireId, requireReference, requireText } from "../sources";
import type { AppTransaction } from "../store";
import type { Discussion } from "../team/types";
import { discussionWorkId } from "../team/dispatch";
import { contextCurrent, fenceStaleContexts } from "./context";
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
  let unreadable = 0;
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
    } catch { unreadable++; return false; /* Unreadable rows count as incomplete, never as clean. */ }
  };
  // Remaining-budget LIMITs bound every SQL input: the pending total never exceeds the cap.
  const tables = ["memory_extractions", "team_runs", "coordinator_syntheses"];
  for (const table of tables) {
    const remaining = impactPreviewBounds.pendingJobs + 1 - found.size;
    if (remaining <= 0) break;
    for (const row of tx.all<{ projectId: string; jobId: string; json: string }>(
      `SELECT project_id AS projectId, job_id AS jobId, record_json AS json FROM ${table} WHERE job_id IN (SELECT id FROM jobs WHERE ${pending}) LIMIT ${remaining}`)) {
      if (cites(row.json)) found.set(row.jobId, { id: row.jobId, projectId: row.projectId });
    }
  }
  const jobs = [...found.values()];
  return jobs.length > impactPreviewBounds.pendingJobs || unreadable > 0
    ? { jobs: jobs.slice(0, impactPreviewBounds.pendingJobs), truncated: true }
    : { jobs, truncated: false };
}

/**
 * Bounded transitive closure over one project's claim lineage: every claim reachable from
 * the corrected root through dependencies/conflicts, computed inside a fixed SQL window.
 * The window is ordered by insertion sequence so truncation is deterministic; callers
 * propagate `truncated` to every count derived from this set.
 */
function collectDependents(tx: AppTransaction, projectId: string, rootId: string): { dependents: CorrectionImpact["dependents"]; affected: Set<string>; truncated: boolean } {
  const window = tx.all<{ record_json: string }>(
    "SELECT record_json FROM memory_claims WHERE project_id = ? ORDER BY sequence LIMIT ?",
    projectId, impactPreviewBounds.dependents + 1);
  const truncated = window.length > impactPreviewBounds.dependents;
  const parsed: MemoryClaim[] = [];
  for (const row of window) {
    try {
      const candidate = JSON.parse(row.record_json) as MemoryClaim;
      if (typeof candidate.claimId === "string") parsed.push(candidate);
    } catch { /* Skip unreadable rows; availability stays authoritative in lookupActiveClaim. */ }
  }
  const affected = new Set([rootId]);
  for (let grew = true; grew;) {
    grew = false;
    for (const candidate of parsed) {
      if (affected.has(candidate.claimId)) continue;
      if ([...candidate.dependencies, ...candidate.conflicts].some(ref => affected.has(ref.claimId))) {
        affected.add(candidate.claimId); grew = true;
      }
    }
  }
  const dependents: CorrectionImpact["dependents"] = [];
  for (const candidate of parsed) {
    if (candidate.claimId === rootId || !affected.has(candidate.claimId)) continue;
    if (dependents.length >= impactPreviewBounds.dependents) break;
    const live = lookupActiveClaim(tx, projectId, { claimId: candidate.claimId, revision: candidate.revision, generation: candidate.generation });
    dependents.push({ projectId, reference: { claimId: candidate.claimId, revision: candidate.revision, generation: candidate.generation },
      text: live.state === "available" ? live.claim.text : null });
  }
  return { dependents, affected, truncated };
}

/**
 * app.memory_correction/v1 inspector preview: the exact claim, its existing correction,
 * same-project dependents, recorded run contexts that used it and pending jobs that would fence.
 */
export function correctionImpact(tx: AppTransaction, projectId: string, reference: ClaimReference): CorrectionImpact {
  requireId(projectId); requireClaimReference(reference);
  const claim = lookupActiveClaim(tx, projectId, reference);
  const correction = readCorrection(tx, projectId, reference.claimId);
  const { dependents, affected, truncated: dependentsTruncated } = collectDependents(tx, projectId, reference.claimId);
  const placeholders = [...affected].map(() => "?").join(",");
  const contextRows = affected.size ? tx.all<{ id: string; projectId: string; ownerKind: string; ownerId: string }>(
    `SELECT c.id, c.project_id AS projectId, c.owner_kind AS ownerKind, c.owner_id AS ownerId FROM memory_contexts c
     JOIN memory_context_entries e ON e.context_id = c.id
     WHERE e.kind = 'claim' AND e.origin_project_id = ? AND e.entry_id IN (${placeholders}) ORDER BY c.sequence LIMIT ?`,
    projectId, ...affected, impactPreviewBounds.contexts + 1) : [];
  const listedContexts = capped(contextRows, impactPreviewBounds.contexts);
  const pending = claim.state === "available" ? pendingReferencing(tx, projectId, affected) : { jobs: [], truncated: false };
  const incomplete = dependentsTruncated;
  return { claim, correction, dependents, contexts: listedContexts.items, pendingJobs: pending.jobs,
    truncated: { dependents: dependentsTruncated, contexts: incomplete || listedContexts.truncated, pendingJobs: incomplete || pending.truncated },
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
  fenceStaleDiscussions(tx, now);
  fenceUnavailableExtractions(tx, command.projectId, now);
  return { correction, replacement: { claimId: replacement.claimId, revision: 1, generation: 1 } };
}

/**
 * Every pending top-level discussion is evaluated with the shared context-current query,
 * which recursively resolves each cited claim in its origin project. This fences discussions
 * that selected only a transitively-invalidated dependent, discussions in other projects,
 * and discussions whose stored JSON is corrupt (failed closed: an unreadable pending
 * discussion can never prove it is safe to run, so its parent job loses commit authority).
 * Specialist/synthesis rows are left to their own request-based fences; participation jobs
 * are fenced here as belt-and-braces, tolerating unparseable entries because the parent
 * fence already revokes the discussion's authority.
 */
function fenceStaleDiscussions(tx: AppTransaction, now: number): void {
  const pending = "j.state IN ('queued', 'admitted', 'waiting')";
  const rows = tx.all<{ projectId: string; jobId: string; json: string; jobJson: string }>(
    `SELECT r.project_id AS projectId, r.job_id AS jobId, r.record_json AS json, j.record_json AS jobJson
     FROM team_runs r JOIN jobs j ON j.id = r.job_id WHERE ${pending}`);
  for (const row of rows) {
    let discussion: Discussion | null = null;
    try { discussion = JSON.parse(row.json) as Discussion; } catch { /* Failed closed below. */ }
    if (discussion && discussion.kind !== "discussion") continue;
    if (!discussion && !isDiscussionJob(row.jobJson)) continue;
    const stale = !discussion?.manifest || contextCurrent(tx, row.projectId, discussion.manifest) !== null;
    if (!stale) continue;
    invalidatePendingJob(tx, row.projectId, row.jobId, "source_retired", now);
    const participations = Array.isArray(discussion?.participations) ? discussion.participations : [];
    for (const participation of participations) {
      try {
        if (participation && typeof participation.jobId === "string") invalidatePendingJob(tx, row.projectId, participation.jobId, "source_retired", now);
      } catch { /* Parent fence already revokes authority; a broken participation id stays fenced with it. */ }
    }
  }
}

function isDiscussionJob(jobJson: string): boolean {
  try {
    return (JSON.parse(jobJson) as { type?: string }).type === discussionWorkId;
  } catch { return false; }
}
