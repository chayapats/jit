# Attempt fencing, v1

Owner: Jit #9 (JOB02). Contract: `jobs.attempt_fence/v1`. Implementation: `src/jobs/attempts.ts`, `src/jobs/queue.ts`, `src/jobs/types.ts`, `src/application.ts`. Requires schema v5 and the JOB02 run-port extension for native work. FR-07/15/16/18, NFR-05/10/12; read alongside [session reconciliation](session-reconcile-v1.md) and [ADR 0012](../adr/0012-attempt-fencing-and-reconciliation.md).

## Exact public surface

```ts
interface AttemptPreparation {
  native: { adapter: string; runId: string; sessionId: string;
    context: { id: string; generation: number } } | null;
  data: JobData;
}
interface JobAttempt extends AttemptPreparation {
  id: string; jobId: string; generation: number; scheduler: string; leaseUntil: number;
  snapshot: Job; createdAt: number;
  state: "prepared" | "dispatched" | "committed" | "interrupted" | "rejected";
  reason: JobReason | null;
  nativeState: "uninspected" | "missing" | "running" | "finished";
  contextState: "none" | "pending" | "retired" | "deleted" | "retire_failed" | "delete_failed";
}
readAttempts(tx: AppTransaction, jobId: string): JobAttempt[];
readAttempt(tx: AppTransaction, attemptId: string): JobAttempt;
saveAttempt(tx: AppTransaction, attempt: JobAttempt): void;
attemptAuthority(tx: AppTransaction, attempt: JobAttempt, now: number): JobReason | null;
invalidateJob(tx: AppTransaction, jobId: string, reason: JobReason,
  now: number, stop?: boolean): JobStopOutcome | null;

// Additions to trusted WorkDefinition / WorkContext:
WorkDefinition.replay?: "read" | "mutation" | "send";
WorkDefinition.prepare?(tx: AppTransaction, job: Job, generation: number): AttemptPreparation;
WorkDefinition.isCurrent?(tx: AppTransaction, job: Job, attempt: JobAttempt): boolean;
WorkContext.attempt: Readonly<JobAttempt>;
WorkContext.commit(outcome: WorkOutcome, mutate?: (tx: AppTransaction) => void): boolean;
// SchedulerOptions.leaseMs?: number; defaults to 60,000, positive and at most 3,600,000.

JobQueue.invalidate(tx: AppTransaction, projectId: string, jobId: string,
  reason: "revoked" | "superseded" | "source_retired" | "context_retired"): void;
JobQueue.cancelFenced(): void;

interface StopJobCommand {
  kind: "job.stop"; requestId: string; projectId: string; expectedRevision: number;
  payload: { jobId: string };
}
interface JobStopOutcome {
  requestedAt: number; fencedAt: number;
  transport: "not_dispatched" | "cancellation_requested" | "observed_stopped" | "unknown";
}
// JobReceipt adds stop?: JobStopOutcome.
// Application.execute(actor, StopJobCommand): JobReceipt via the JobCommand overload.
```

These internal transaction functions require trusted service callers. `saveAttempt` updates lifecycle evidence only; callers must preserve identity, native/data fields, lease and admission snapshot. Worker-visible values are isolated copies. A worker/model cannot grant authority by editing them. The low-level `attemptAuthority` predicate checks scheduler token, generation, original owner generation, lifecycle and lease; producers use `WorkContext.commit`, which also checks current work configuration, immutable input/authorization/route snapshots, project input validation and the work-specific source/context predicate in that same writer transaction.

## Persistence and commit

Admission atomically spends declared usage, advances generation and inserts a prepared attempt with immutable job/input/configuration/authorization snapshot, lease and preallocated native run/session/context references. Non-model work records `native: null`. `prepare` must be synchronous, bounded and free of native dispatch; it is a trusted registration callback, never owner/model-supplied code. The scripted preview stores its exact run request in attempt data. A separate dispatch transaction checks the fence before invoking the adapter.

`commit` runs the trusted producer callback only for a valid succeeded outcome and live authority. Callback state (such as attributed sources/messages, future tasks/memory/outbox), job evidence/state and attempt result commit together or all roll back. Repeated callbacks return false without invoking the producer again. The ordinary returned WorkOutcome uses the same gate. A committed attempt records a bounded step outcome, including waiting/yield/failure; it does not necessarily mean job success, accepted task or external delivery.

Revocation adapters must change standing authorization/source/supersession state and call `invalidate` for affected jobs in the same app transaction, then call `cancelFenced` after commit. This seam does not implement monitoring, schedules or memory correction policies. The owner stop path performs the same fence with receipt/audit and invokes cancellation only after a successful commit. Lease expiry, shutdown and scheduler takeover also fence before cancelling or permitting further admission. Expired leases are not renewed implicitly. Stalled transports continue to occupy admission until settlement; a proven-dead local scheduler may be reclaimed, but remote cancellation remains uncertain.

## Owner boundary and recovery

`POST /api/projects/:projectId/jobs/:jobId/stop` (or native form path without `/api`) accepts only requestId, expectedRevision and the existing CSRF proof. Owner session, Origin, CSRF, project scope, revision, global receipt deduplication and audit rules still apply. A running stop acknowledges fenced authority plus cancellation requested, never instant remote termination. Its historical receipt is immutable. `Application.job(actor, projectId, jobId)` / the existing GET job API adds current `stop`, retained `attempts` and matching `reconciliations`; the owner job detail shows stop uncertainty, interrupted attempts and lifecycle blockers.

On takeover an unobserved requested stop becomes transport unknown. Local promise settlement or separately inspected native finished evidence can record observed stopped; neither authorizes a result. A queued/pre-dispatch stop records not dispatched. Terminal completed jobs cannot be cancelled retroactively.

Explicit resume can restart interrupted work only when `replay: "read"` was declared, inputs/configuration are still current, old native contexts have successful retirement/deletion acknowledgments, and retry/usage/wall budgets remain. Each admission gets a new attempt, native run and context. Reservations are never refunded after uncertainty. Mutation/send/unspecified interrupted work rejects with job_requires_manual_reconciliation. No automatic replay or task acceptance exists.

## Deterministic evidence

`tests/jobs.test.ts` covers pre-dispatch snapshot/lease persistence, generic non-model producer atomicity and rollback, stop receipt replay/rollback/order of abort, late workers after revocation/supersession/source/context retirement/owner reset/input changes/lease expiry, takeover with a still-running old callback, fresh read attempts, mutation/send/unspecified refusal, exhausted retries, scheduler contention and admission/receipt process-kill tests. `tests/team.test.ts` verifies exact persisted native request references, attributed-output fencing and the cross-store crash matrix. No live providers, physical reboot or external sends are exercised.
