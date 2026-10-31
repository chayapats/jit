import type { ScheduleRecurrence, SummaryOutcome, WallResolution } from "../jobs/schedules";
import type { ScopePolicy, StartPayload } from "./authority-types";
import type { Bot, Envelope, Route } from "./types";

/** Exact finite standing instruction selected by the authenticated owner, independent of task acceptance. */
export interface RoutinePurpose extends Omit<StartPayload, "task" | "expiresAt"> {
  timezone: string;
  recurrence: ScheduleRecurrence;
  misfire: "coalesce";
  occurrenceBudget: number;
  endsAt: number;
}
/** Immutable capture plus separately revisioned dispatch state; source content cannot edit either. */
export interface Routine {
  id: string;
  revision: number;
  generation: number;
  state: "active" | "paused" | "revoked" | "exhausted" | "blocked";
  reason: string | null;
  capture: { command: EnableRoutineCommand; ownerGeneration: number; bots: Bot[]; routes: Route[]; scopes: ScopePolicy[] };
  occurrencesRemaining: number;
  cursor: { lastInstant: number | null; lastRevision: number | null };
  createdAt: number;
}
/** One deduplicated occurrence; missed instants never materialize an unbounded backlog. */
export interface RoutineOccurrence {
  id: string;
  routineId: string;
  generation: number;
  /** Trusted admission origin; absent in records written before UX14-02 gap closure. */
  trigger?: "owner" | "schedule";
  scheduledInstant: number;
  missed: { from: number; to: number; count: number } | null;
  resolution: WallResolution;
  workId: string | null;
  state: "running" | "complete" | "failed" | "stopped";
  outcome: SummaryOutcome["kind"] | "needs_owner" | null;
  reason: string | null;
  proposals: string[];
  createdAt: number;
}
/** Enables one exact standing capture and finite occurrence budget at the conversation revision. */
export type EnableRoutineCommand = Envelope<"routine.enable", RoutinePurpose>;
/** Exact owner dispatch control never changes a captured purpose, resource or budget. */
export type ControlRoutineCommand = Envelope<"routine.pause" | "routine.resume" | "routine.revoke" | "routine.run-now" | "routine.delete", { routineId: string }>;
/** app.routine-grants/v1 authenticated owner ingress. */
export type RoutineCommand = EnableRoutineCommand | ControlRoutineCommand;
/** Atomic standing-authority receipt; queries separately report current occurrence settlement. */
export interface RoutineReceipt { kind: RoutineCommand["kind"]; requestId: string; routine: Routine }
/** Owner history includes quiet, failed and stopped runs without starting any work. */
export interface RoutineView { routine: Routine; nextRun: number | null; history: RoutineOccurrence[] }
/** Bounded per-routine attention aggregate over actual open work, independent of recent notice history. */
export interface RoutineAttentionSummary {
  routine: Routine;
  decisions: { count: number; at: number | null };
  settled: RoutineOccurrence | null;
  report: RoutineOccurrence | null;
  delivery: "failed" | "unknown" | null;
}
/** A grouped in-app notice has local dedupe and a separate honest optional transport outcome. */
export interface AttentionNotice {
  id: string;
  revision: number;
  groupId: string;
  class: "needs_owner" | "informational";
  reason: "routine_report" | "routine_failed" | "owner_decision";
  workId: string | null;
  proposalIds: string[];
  state: "queued" | "claimed" | "sent" | "failed" | "unknown" | "cancelled";
  remote: "none" | "accepted" | "rejected" | "uncertain";
  guarantee: "local_dedupe_only";
  retriesRemaining: number;
  nextAttemptAt: number;
  resolvedAt: number | null;
  createdAt: number;
}
/** Deterministic optional transport seam; production uses only the durable in-app surface. */
export interface AttentionPort { send(notice: AttentionNotice): Promise<"sent" | "unavailable" | "rejected" | "unknown"> }
/** Owner attention policy changes future intent creation only; existing history is unaffected. */
export type AttentionCommand = Envelope<"attention.set", { level: "all" | "needs-me" }> | Envelope<"attention.acknowledge", { noticeId: string }>;
/** Revision-bound in-app attention policy receipt. */
export interface AttentionReceipt { kind: AttentionCommand["kind"]; requestId: string; setting?: AttentionSetting; notice?: AttentionNotice }
/** In-app attention defaults to needs-me, including explicitly requested routine reports. */
export interface AttentionSetting { id: "in_app"; revision: number; level: "all" | "needs-me" }
