import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import type { Job, JobData, JobReason, JobStopOutcome } from "./types";

/** Adapter identities and input are persisted before dispatch; none grant app authority. */
export interface AttemptPreparation {
  native: { adapter: string; runId: string; sessionId: string; context: { id: string; generation: number } } | null;
  data: JobData;
}
/** Immutable admission snapshot plus append-only lifecycle evidence; never replaced by a retry. */
export interface JobAttempt extends AttemptPreparation {
  id: string; jobId: string; generation: number; scheduler: string; leaseUntil: number;
  snapshot: Job; createdAt: number;
  state: "prepared" | "dispatched" | "committed" | "interrupted" | "rejected";
  reason: JobReason | null;
  nativeState: "uninspected" | "missing" | "running" | "finished";
  contextState: "none" | "pending" | "retired" | "deleted" | "retire_failed" | "delete_failed";
}
/** Lists one job's inspectable attempts in insertion order, without reviving execution. */
export function readAttempts(tx: AppTransaction, jobId: string): JobAttempt[] {
  return tx.all<{ record_json: string }>("SELECT record_json FROM job_attempts WHERE job_id = ? ORDER BY sequence", jobId).map(row => JSON.parse(row.record_json));
}
/** Reads an exact retained attempt; callers still enforce project scope through its job. */
export function readAttempt(tx: AppTransaction, attemptId: string): JobAttempt {
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM job_attempts WHERE id = ?", attemptId);
  if (!row) throw new AppError("attempt_not_found", 404);
  return JSON.parse(row.record_json);
}
/** Updates lifecycle evidence only; admission snapshots and identity must stay immutable. */
export function saveAttempt(tx: AppTransaction, attempt: JobAttempt): void {
  tx.run("UPDATE job_attempts SET record_json = ? WHERE id = ?", JSON.stringify(attempt), attempt.id);
}
/** Invalidates authority synchronously; cancellation is requested only after this transaction commits. */
export function invalidateJob(tx: AppTransaction, jobId: string, reason: JobReason, now: number, stop = false): JobStopOutcome | null {
  const prior = tx.get<{ stop_json: string | null }>("SELECT stop_json FROM job_authority WHERE job_id = ?", jobId);
  const active = readAttempts(tx, jobId).filter(a => ["prepared", "dispatched"].includes(a.state));
  const outcome: JobStopOutcome | null = stop ? prior?.stop_json ? JSON.parse(prior.stop_json) : {
    requestedAt: now, fencedAt: now, transport: active.some(a => a.state === "dispatched") ? "cancellation_requested" : "not_dispatched",
  } : null;
  tx.run("UPDATE job_authority SET generation = generation + 1, reason = ?, stop_json = coalesce(?, stop_json) WHERE job_id = ?", reason, outcome ? JSON.stringify(outcome) : null, jobId);
  for (const attempt of active) { attempt.state = "interrupted"; attempt.reason = reason; saveAttempt(tx, attempt); }
  return outcome;
}
/** Shared non-model-worker gate; callers additionally compare current work/input policy in the same transaction. */
export function attemptAuthority(tx: AppTransaction, attempt: JobAttempt, now: number): JobReason | null {
  if (!["prepared", "dispatched"].includes(attempt.state)) return attempt.reason ?? "interrupted";
  if (tx.get<{ token: string }>("SELECT token FROM job_scheduler WHERE id = 1")?.token !== attempt.scheduler) return "interrupted";
  if (tx.get<{ generation: number }>("SELECT generation FROM job_authority WHERE job_id = ?", attempt.jobId)?.generation !== attempt.generation) return "authorization_changed";
  if (tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation !== attempt.snapshot.authorization.generation) return "authorization_changed";
  if (now >= attempt.leaseUntil) return now >= attempt.snapshot.deadlineAt ? "deadline" : "lease_expired";
  return null;
}
