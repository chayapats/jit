import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import type { Job, JobData, JobReason, JobStopOutcome } from "./types";

/** Adapter identities and input are persisted before dispatch; none grant app authority. */
export interface AttemptPreparation {
  native: { adapter: string; runId: string; sessionId: string; context: { id: string; generation: number } } | null;
  data: JobData;
  /**
   * exec.run_tools/v1: the execution level this attempt was granted at admission, for the role that runs it. Every
   * reservation and result commit re-checks it (`authorization_changed` once the effective level falls below it or the
   * project is halted). Absent for attempts without execution.
   */
  execution?: { level: "workspace" | "full"; roleId: string | null };
}
/** Immutable admission snapshot plus append-only lifecycle evidence; never replaced by a retry. */
export interface JobAttempt extends AttemptPreparation {
  id: string; jobId: string; generation: number; scheduler: string; leaseUntil: number;
  snapshot: Job; createdAt: number;
  state: "prepared" | "dispatched" | "committed" | "interrupted" | "rejected";
  reason: JobReason | null;
  nativeState: "uninspected" | "missing" | "running" | "finished";
  contextState: "none" | "pending" | "retired" | "deleted" | "retire_failed" | "delete_failed";
  /** Transport engagement is independent of attempt commit/yield; settled only when the worker finalizes. */
  transport: "none" | "dispatched" | "settled";
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
/** Attempts whose in-flight or recovered transport has not settled yet. */
export function unsettledTransportAttempts(tx: AppTransaction, jobId: string): JobAttempt[] {
  return readAttempts(tx, jobId).filter(attempt => {
    if (attempt.transport === "dispatched") return true;
    if (attempt.transport === "settled" || attempt.transport === "none") return false;
    // Pre-transport-field rows: leaving prepared implies dispatch that never settled in-process.
    return attempt.nativeState !== "uninspected" && ["dispatched", "interrupted", "rejected", "committed"].includes(attempt.state);
  });
}
/** True only when every watched stop attempt has settled transport evidence. */
export function stopFullyObserved(tx: AppTransaction, stop: JobStopOutcome): boolean {
  if (!Array.isArray(stop.attemptIds) || stop.attemptIds.length === 0) return false;
  return stop.attemptIds.every(id => {
    try { return readAttempt(tx, id).transport === "settled"; }
    catch { return false; }
  });
}
/** Early yield/wait commits are not terminal app output; their managed contexts still need retirement. */
export function isEarlyBoundCommit(attempt: JobAttempt): boolean {
  return attempt.state === "committed" && ["yielded", "quota", "needs_login", "route_unavailable"].includes(attempt.reason ?? "");
}
/** Invalidates authority synchronously; cancellation is requested only after this transaction commits. */
export function invalidateJob(tx: AppTransaction, jobId: string, reason: JobReason, now: number, stop = false): JobStopOutcome | null {
  const prior = tx.get<{ stop_json: string | null }>("SELECT stop_json FROM job_authority WHERE job_id = ?", jobId);
  const attempts = readAttempts(tx, jobId);
  const active = attempts.filter(a => ["prepared", "dispatched"].includes(a.state));
  const unsettled = unsettledTransportAttempts(tx, jobId);
  const needsCancel = unsettled.length > 0 || active.some(a => a.state === "dispatched");
  const outcome: JobStopOutcome | null = stop ? prior?.stop_json ? JSON.parse(prior.stop_json) : {
    requestedAt: now, fencedAt: now,
    transport: needsCancel ? "cancellation_requested" : "not_dispatched",
    attemptIds: [...new Set([...unsettled, ...active.filter(a => a.state === "dispatched")].map(a => a.id))],
  } : null;
  tx.run("UPDATE job_authority SET generation = generation + 1, reason = ?, stop_json = coalesce(?, stop_json) WHERE job_id = ?", reason, outcome ? JSON.stringify(outcome) : null, jobId);
  for (const attempt of active) {
    // Preserve that dispatch happened so a later owner stop after restart cannot claim not_dispatched.
    if (attempt.state === "dispatched") {
      if (attempt.nativeState === "uninspected") attempt.nativeState = attempt.native ? "running" : "missing";
      if (attempt.transport === "none") attempt.transport = "dispatched";
    }
    attempt.state = "interrupted"; attempt.reason = reason; saveAttempt(tx, attempt);
  }
  return outcome;
}
/** Inputs for the shared lease and generation fence used by job and delivery attempts. */
export interface AttemptFence {
  state: string;
  activeStates: readonly string[];
  scheduler: string;
  currentScheduler: string | null;
  generation: number;
  authorityGeneration: number | null;
  ownerGeneration: number;
  currentOwnerGeneration: number | null;
  now: number;
  leaseUntil: number;
  deadlineAt: number;
}

/**
 * `jobs.attempt_fence/v1` lease gate shared with `delivery.outbox/v1`.
 * A denial means this worker must not start a new effect. It does not prove an in-flight external send was prevented.
 */
export function fenceDenied(input: AttemptFence): JobReason | null {
  if (!input.activeStates.includes(input.state)) return "interrupted";
  if (input.currentScheduler !== input.scheduler) return "interrupted";
  if (input.authorityGeneration !== input.generation) return "authorization_changed";
  if (input.currentOwnerGeneration !== input.ownerGeneration) return "authorization_changed";
  if (input.now >= input.leaseUntil) return input.now >= input.deadlineAt ? "deadline" : "lease_expired";
  return null;
}

/** Shared non-model-worker gate; callers additionally compare current work/input policy in the same transaction. */
export function attemptAuthority(tx: AppTransaction, attempt: JobAttempt, now: number): JobReason | null {
  if (!["prepared", "dispatched"].includes(attempt.state)) return attempt.reason ?? "interrupted";
  return fenceDenied({
    state: attempt.state,
    activeStates: ["prepared", "dispatched"],
    scheduler: attempt.scheduler,
    currentScheduler: tx.get<{ token: string }>("SELECT token FROM job_scheduler WHERE id = 1")?.token ?? null,
    generation: attempt.generation,
    authorityGeneration: tx.get<{ generation: number }>("SELECT generation FROM job_authority WHERE job_id = ?", attempt.jobId)?.generation ?? null,
    ownerGeneration: attempt.snapshot.authorization.generation,
    currentOwnerGeneration: tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")?.generation ?? null,
    now,
    leaseUntil: attempt.leaseUntil,
    deadlineAt: attempt.snapshot.deadlineAt,
  });
}
