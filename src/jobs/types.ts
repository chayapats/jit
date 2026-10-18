import type { JobAttempt, AttemptPreparation } from "./attempts";
import type { AppTransaction } from "../store";

/** JSON data accepted as a bounded work input or checkpoint, never executable authority. */
export type JobData = null | boolean | number | string | JobData[] | { [key: string]: JobData };
/** Positive per-job ceilings; reservations spend these before invoking work. */
export interface JobLimits {
  roles: number; calls: number; rounds: number; hops: number;
  contextTokens: number; outputTokens: number; retries: number; wallMs: number;
}
/** Nonnegative usage reserved atomically before a registered adapter spends it. */
export type JobUsage = Partial<Omit<JobLimits, "wallMs">>;
/** Finite installation admission policy; defaults are development values, not capacity evidence. */
export interface JobPolicy {
  revision: number; queueLimit: number; concurrency: number; routeConcurrency: number;
  inputBytes: number; outputBytes: number; maximum: JobLimits;
}
/** Non-secret selected execution references, preserved across waits without fallback. */
export interface JobRoute { provider: string; model: string | null; authRoute: string }
/** Durable job states separate queueing, actual admission, external waits and terminal outcomes. */
export type JobState = "queued" | "admitted" | "waiting" | "succeeded" | "blocked" | "partial" | "failed";
/** Safe finite reason codes instead of raw adapter/store diagnostics. */
export type JobReason = "queued" | "running" | "complete" | "yielded" | "quota" | "needs_login" | "route_unavailable"
  | "cancelled" | "revoked" | "superseded" | "source_retired" | "context_retired" | "lease_expired" | "budget_exhausted" | "deadline" | "worker_failed" | "interrupted" | "configuration_changed" | "authorization_changed" | "input_changed";
/** Committed owner-visible work, its immutable scope/configuration, and remaining reservation budgets. */
export interface Job {
  id: string; projectId: string; revision: number; type: string; purpose: string;
  priority: "interactive" | "background"; inputRevision: number; input: JobData;
  authorization: { ownerId: "owner"; generation: number; requestId: string };
  configuration: { revision: number; policyRevision: number; fingerprint: string }; route: JobRoute;
  limits: JobLimits; remaining: JobLimits; state: JobState; reason: JobReason; nextAction: string;
  occupiesAdmission: boolean;
  createdAt: number; updatedAt: number; deadlineAt: number; steps: number;
  checkpoint: JobData; evidence: string | null;
}
/** Explicit owner start authorization for one registered work type, separate from task acceptance. */
export interface EnqueueJobCommand {
  kind: "job.enqueue"; requestId: string; projectId: string; expectedRevision: number;
  payload: { type: string; configurationRevision: number; policyRevision: number; purpose: string; inputRevision: number;
    input: JobData; priority: "interactive" | "background"; limits: JobLimits };
}
/** Explicit continuation of a waiting job on its original route and remaining budgets. */
export interface ResumeJobCommand {
  kind: "job.resume"; requestId: string; projectId: string; expectedRevision: number; payload: { jobId: string };
}
/** Job mutations share global owner command receipts with project and conversation commands. */
export interface StopJobCommand {
  kind: "job.stop"; requestId: string; projectId: string; expectedRevision: number; payload: { jobId: string };
}
/** Stop acknowledgment records authority separately from observed transport termination. */
export interface JobStopOutcome {
  requestedAt: number; fencedAt: number;
  transport: "not_dispatched" | "cancellation_requested" | "observed_stopped" | "unknown";
  /** Attempts whose transport must settle before stop can become observed_stopped. */
  attemptIds: string[];
}
export type JobCommand = EnqueueJobCommand | ResumeJobCommand | StopJobCommand;
/** A receipt acknowledges the job snapshot only after its transaction commits. */
export interface JobReceipt { job: Job; stop?: JobStopOutcome }
/** A trusted adapter's bounded step outcome; waiting never implies a replacement route. */
export type WorkOutcome = { state: "succeeded"; evidence: string }
  | { state: "yield"; checkpoint: JobData }
  | { state: "waiting"; reason: "quota" | "needs_login" | "route_unavailable"; checkpoint?: JobData }
  | { state: "failed"; reason: "worker_failed"; evidence?: string };
/** A trusted work step receives cancellation and an atomic reservation port, not owner command authority. */
export interface WorkContext {
  job: Readonly<Job>; attempt: Readonly<JobAttempt>; signal: AbortSignal;
  /** Atomically gates service-owned output/tasks/memory/outbox changes and the app result; native finish is insufficient. */
  commit(outcome: WorkOutcome, mutate?: (tx: AppTransaction) => void): boolean;
  /** Reserves finite usage before spending it; rejection grants no call or retry authority. */
  reserve(usage: JobUsage): void;
}
/** Process-owned work registration; user/model data cannot register code or change its exact route. */
export interface WorkDefinition {
  id: string; title: string; revision: number; route: JobRoute; cost: JobUsage;
  /** Only explicitly read-only interrupted work may be resumed; unspecified/mutation/send require manual resolution. */
  replay?: "read" | "mutation" | "send";
  /** Captures native identities and immutable adapter input inside admission, before any dispatch. */
  prepare?(tx: AppTransaction, job: Job, generation: number): AttemptPreparation;
  /** Rechecks source/context freshness inside each reservation and result transaction. */
  isCurrent?(tx: AppTransaction, job: Job, attempt: JobAttempt): boolean;
  /** Validates immutable input scope without changing state or contacting a provider. */
  validate(input: JobData, scope: { projectId: string; projectRevision: number; inputRevision: number }): boolean;
  /** Performs one reserved step, honors cancellation and returns bounded evidence without route fallback. */
  run(context: WorkContext): Promise<WorkOutcome> | WorkOutcome;
}
/** Only this owner-validated transaction port may acknowledge queue commands. */
export interface JobCommandPort {
  execute(tx: AppTransaction, command: JobCommand, generation: number, now: number): JobReceipt;
}
