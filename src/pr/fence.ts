import { AppError } from "../errors";
import { invalidatePendingJob } from "../jobs/queue";
import type { AppTransaction } from "../store";
import { ensurePrSchema } from "./schema";
import type { ReviewCandidate } from "./types";

/** Lifecycle events that fence PR work for one candidate. */
export type PrFenceReason = "revoked" | "superseded" | "source_retired";

const PR_WORK = ["pr.snapshot", "pr.review"] as const;

/**
 * Nonterminal `pr.snapshot` / `pr.review` jobs for one candidate, found by
 * job input rather than `candidate.jobId` (which holds only the snapshot job).
 */
export function activePrJobIds(tx: AppTransaction, projectId: string, candidateId: string, types: readonly string[] = PR_WORK): string[] {
  return tx.all<{ id: string; type: string }>(
    "SELECT json_extract(record_json, '$.id') AS id, json_extract(record_json, '$.type') AS type FROM jobs WHERE project_id = ? AND state IN ('queued', 'admitted', 'waiting') AND json_extract(record_json, '$.input.candidateId') = ?",
    projectId, candidateId,
  ).filter(row => types.includes(row.type)).map(row => row.id);
}

/**
 * Fences every active snapshot/review job of one candidate inside the caller's
 * lifecycle transaction. Callers with a live queue invoke `queue.cancelFenced()`
 * after the transaction commits so in-flight transports stop.
 */
export function fencePrCandidateWork(tx: AppTransaction, projectId: string, candidateId: string, reason: PrFenceReason, now: number): string[] {
  const ids = activePrJobIds(tx, projectId, candidateId);
  for (const id of ids) invalidatePendingJob(tx, projectId, id, reason, now);
  return ids;
}

/** Fences active `pr.review` jobs of one candidate (see `fencePrCandidateWork`). */
export function fencePrReviewJobs(tx: AppTransaction, projectId: string, candidateId: string, reason: PrFenceReason, now: number): string[] {
  const ids = activePrJobIds(tx, projectId, candidateId, ["pr.review"]);
  for (const id of ids) invalidatePendingJob(tx, projectId, id, reason, now);
  return ids;
}

/**
 * Retires a candidate's snapshot evidence: the candidate becomes durably stale
 * with `staleReason: "source_retired"` (retained reports read stale for that
 * reason), and active snapshot/review work is fenced in the same transaction.
 * The snapshot row is kept as history. Call `queue.cancelFenced()` after commit.
 */
export function retirePrSnapshot(tx: AppTransaction, projectId: string, candidateId: string, now: number): { candidate: ReviewCandidate; fencedJobs: string[] } {
  ensurePrSchema(tx);
  if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_commit_time");
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM pr_candidates WHERE id = ? AND project_id = ?", candidateId, projectId);
  if (!row) throw new AppError("pr_candidate_not_found", 404);
  const candidate = JSON.parse(row.record_json) as ReviewCandidate;
  candidate.status = "stale";
  candidate.staleReason = "source_retired";
  candidate.updatedAt = Math.max(candidate.updatedAt, now);
  tx.run("UPDATE pr_candidates SET status = ?, record_json = ? WHERE id = ?", candidate.status, JSON.stringify(candidate), candidate.id);
  return { candidate, fencedJobs: fencePrCandidateWork(tx, projectId, candidateId, "source_retired", now) };
}
