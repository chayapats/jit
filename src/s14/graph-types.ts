import type { Admission, WorkGrant } from "./authority-types";
import type { ExternalEvidence } from "./parallel-types";
import type { Envelope } from "./types";

/** Finite scheduler ceilings; a route means the provider credential route, not a model alias. */
export interface SchedulerLimits { global: number; route: number; bot: number; computer: number }
/** Admission ceiling holding a queued lane; work is the immutable grant concurrency ceiling. */
export type QueueCeiling = keyof SchedulerLimits | "work";
/** Trusted handler registry keys; model-proposed nodes cannot install executable handlers. */
export type StepHandler = "research" | "synthesis";
/** A proposed finite assignment that can only narrow its originating grant. */
export interface StepProposal extends Admission { id: string; handler: StepHandler; dependsOn: string[] }
/** Immutable service-validated graph configuration bound to the original owner grant. */
export interface WorkGraph { id: string; revision: number; grantId: string; priority: "interactive" | "background"; nodes: StepProposal[] }
/** Durable lane and phase starts; null means unobserved, and cancellation alone never sets transport settledAt. */
export interface WorkStep {
  id: string; workId: string; revision: number; nodeId: string; botId: string; handler: StepHandler;
  state: "queued" | "waiting_evidence" | "running" | "stopping" | "committed" | "failed" | "cancelled" | "blocked";
  queuedAt: number | null; waitingAt: number | null; queueCeiling: QueueCeiling | null;
  reason: string | null; attemptId: string | null; startedAt: number | null; settledAt: number | null;
}
/** Committed dependency input, labelled as untrusted data and carrying its source lineage. */
export interface StepInput { stepId: string; attemptId: string; sourceId: string; text: string; evidence: ExternalEvidence[] }
/** An explicit missing dependency; successful sibling evidence remains independently committed. */
export interface StepGap { stepId: string; reason: string }
/** Owner-only read model for actual lanes, capacity, conservative usage and dependency waits. */
export interface GraphView { graph: WorkGraph; steps: WorkStep[]; active: number; concurrency: number; limits: SchedulerLimits; actualUsage: null }
/** Exact lane cancellation under existing authority; this creates no replacement run or wider grant. */
export type StopStepCommand = Envelope<"work.step.stop", { workId: string; stepId: string }>;
/** Bounded owner settings used as explicit defaults by future work-mode forms. */
export interface WorkDefaults { id: "work"; revision: number; concurrency: number; wallMs: number; reads: number }
/** Owner-only default changes affect future commands and never mutate existing grants. */
export type WorkDefaultsCommand = Envelope<"work.defaults.set", { concurrency: number; wallMs: number; reads: number }>;
/** Scheduler commands share the authenticated receipt/audit boundary. */
export type GraphCommand = StopStepCommand | WorkDefaultsCommand;
/** Bounded identities/state returned by scheduler commands; no result body enters a receipt. */
export interface GraphReceipt { kind: GraphCommand["kind"]; requestId: string; step?: WorkStep; conversationId?: string; defaults?: WorkDefaults }
/** Trusted graph source receives a frozen grant and cannot change its authority or priority. */
export type GraphPlanner = (grant: WorkGrant) => StepProposal[];
