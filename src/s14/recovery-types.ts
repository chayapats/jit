import type { HostRuntime, HostSessionReference } from "schway/host";
import type { Envelope, Route } from "./types";

/** Trusted handler classification; unknown handlers and effects never acquire replay authority from text. */
export type ReplayClass = "replay_safe" | "reconcile_only" | "never_auto";
/** Durable pre-creation correlation scope whose workspace is never selected by model or request data. */
export interface NativeIntent {
  id: string; attemptId: string | null; workId: string | null; grantId: string | null; botId: string | null; computer: boolean; contextId: string | null; route: Route;
  reference: HostSessionReference | null; state: "creating" | "correlated" | "retired" | "deleted" | "not_created" | "unresolved";
  discovered: { reference: HostSessionReference; state: "active" | "retired" | "deleted" }[];
  mode: "retire" | "delete"; reason: string | null;
}
/** Immutable admitted configuration and conservative reservation identity plus separate recovery observations. */
export interface WorkCheckpoint {
  id: string; workId: string; stepId: string | null; fingerprint: string; handlerVersion: string; replay: ReplayClass;
  reservationId: string; evidence: string[]; transport: "not_started" | "unknown" | "settled";
  state: "prepared" | "dispatched" | "committed" | "waiting" | "queued" | "resumed" | "finished";
  reason: string | null; replacementAttemptId: string | null;
}
/** Metadata-only native lifecycle port; discovery cannot submit, reopen, create a model or execute tools. */
export interface NativeRecoveryPort {
  open(intent: NativeIntent): Promise<Pick<HostRuntime, "listSessions" | "retireSession" | "deleteSession" | "close">>;
}
/** Exact owner record of an unknown effect outcome, explicitly distinct from adapter verification. */
export type ReconcileEffectCommand = Envelope<"effect.reconcile", { effectId: string; actionHash: string; outcome: "occurred" | "did_not_occur"; note: string }>;
/** Authenticated recovery command union; resolution never grants retry or execution. */
export type RecoveryCommand = ReconcileEffectCommand;
/** Owner resolution receipt retains the action identity and an explicitly labelled statement. */
export interface RecoveryReceipt { kind: "effect.reconcile"; requestId: string; effect: import("./authority-types").Effect }
/** Owner recovery projection exposes reasons and conservative reservations without starting workers. */
export interface RecoveryView { checkpoints: WorkCheckpoint[]; native: NativeIntent[]; actualUsage: null }
