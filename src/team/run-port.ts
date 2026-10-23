import type { ApplicationRunEvent, ApplicationRunOutcome, ApplicationRunRequest, ManagedContextReference } from "./types";

/** Lifecycle acknowledgments distinguish fenced replay prevention from actual adapter-owned deletion. */
export type ManagedContextOutcome = { state: "retired" | "deleted"; context: ManagedContextReference }
  | { state: "retire_failed"; context: ManagedContextReference; nextAction: "retry_managed_retire" }
  | { state: "delete_failed"; context: ManagedContextReference; nextAction: "retry_managed_delete" };

/** Native evidence is separate from application acceptance and carries no result to publish. */
export interface NativeRunInspection {
  adapter: string; runId: string; sessionId: string; context: ManagedContextReference;
  state: "running" | "finished"; contextState: "active" | "retired" | "deleted" | "delete_failed";
}
/** Application-owned integration contract; the adapter owns native execution/session lifecycle, never app authority. */
export interface ApplicationRunPort {
  /** Stable adapter identity for attempt ledgers and reconciliation matching. */
  readonly adapter: "scripted" | "schway";
  /** Performs one bounded invocation on the exact supplied route; cancellation never authorizes fallback or late commits. */
  invoke(request: ApplicationRunRequest, signal: AbortSignal, observe: (event: ApplicationRunEvent) => void): Promise<ApplicationRunOutcome>;
  /** Paginates adapter-owned run/session references after restart, including native orphans. */
  inspectRuns(after?: number): Promise<{ items: NativeRunInspection[]; nextAfter: number | null }>;
  /** Fences an independently owned context against all future replay, including already-started work. */
  retire(context: ManagedContextReference): Promise<ManagedContextOutcome>;
  /** Deletes only through the adapter's managed lifecycle and reports a visible failure instead of editing native bytes. */
  delete(context: ManagedContextReference): Promise<ManagedContextOutcome>;
}
