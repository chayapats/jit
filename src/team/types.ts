import type { JobLimits } from "../jobs/types";
import type { SourceReference } from "../sources";

/** An atomic selected subscription route; the auth reference names configured access and never contains credentials. */
export interface RoleRoute { provider: "grok" | "codex"; model: string; authRoute: string }
/** One owner-configured responsibility, independent of a model, session or execution permission. */
export interface Role {
  id: string; sequence: number; revision: number; name: string; kind: "specialist" | "coordinator";
  responsibility: string; enabled: boolean; route: RoleRoute | null; createdAt: number; updatedAt: number;
}
/** The complete winning route and the revisioned layer that supplied it, without inferred live readiness. */
export interface EffectiveRoleRoute {
  route: RoleRoute | null;
  layer: "project_role" | "project_default" | "owner_role" | "owner_default" | "missing";
  ownerRevision: number; projectRevision: number; roleRevision: number;
  status: "unverified" | "blocked"; nextAction: string;
}
/** Finite service configuration ceilings; these values do not claim measured host or provider capacity. */
export interface TeamPolicy { roleLimit: number; responsibilityBytes: number; sourceLimit: number; contextBytes: number }
/** An opaque independently owned context whose generation is permanently fenced by retirement. */
export interface ManagedContextReference { id: string; generation: number }
/** Explicit provenance and revisions for untrusted retained material, separate from trusted instructions. */
export interface RunSourceManifest {
  sources: readonly { projectId: string; reference: SourceReference; text: string }[];
  claims: readonly { projectId: string; claimId: string; revision: number; generation: number; text: string }[];
}
/** Service-owned read tools that later consumers may select explicitly; preview and dispatch select none. */
export type ApplicationReadTool = "project.read" | "source.read" | "memory.read";
/** The immutable scope/configuration and finite authority supplied to one application run invocation. */
export interface ApplicationRunRequest {
  runId: string; projectId: string; topicId: string; roleId: string; purpose: string;
  route: RoleRoute; configuration: { ownerRevision: number; projectRevision: number; roleRevision: number };
  context: ManagedContextReference;
  fence: { jobId: string; generation: number; ownerGeneration: number };
  instructions: { operator: readonly string[]; responsibility: string };
  manifest: RunSourceManifest;
  tools: readonly ApplicationReadTool[];
  policy: { genericExecution: false; arbitraryFetch: false; hostedLookup: false; repositoryDiscovery: false };
  limits: JobLimits;
}
/** Normalized reasons retain incomplete/blocked/cancelled states without raw provider diagnostics or route fallback. */
export type RunReason = "complete" | "unknown_model" | "route_unavailable" | "quota" | "needs_login" | "cancelled"
  | "max_rounds" | "budget_exhausted" | "invalid_result" | "context_retired";
/** Usage reports are finite nonnegative measurements, distinct from permission to spend any resource. */
export interface ApplicationRunUsage {
  calls: number; rounds: number; hops: number; contextTokens: number; outputTokens: number; retries: number; wallMs: number;
}
/** Opaque adapter-owned session identity, never a native file path or provider wire object. */
export interface ApplicationSessionReference { adapter: string; id: string; context: ManagedContextReference }
/** A normalized final result whose evidence mode prevents scripted work from claiming live inference. */
export interface ApplicationRunOutcome {
  state: "complete" | "incomplete" | "blocked" | "error";
  reason: RunReason; mode: "fixture" | "production"; output: string | null;
  usage: ApplicationRunUsage; session: ApplicationSessionReference | null;
}
/** Finite typed observations carry no credential, authorization-changing command or raw SDK event. */
export type ApplicationRunEvent = { kind: "started"; runId: string; context: ManagedContextReference }
  | { kind: "progress"; runId: string; text: string }
  | { kind: "finished"; runId: string; outcome: ApplicationRunOutcome };

/** Owner-visible participation state for one role inside a logical discussion. */
export type ParticipationState = "queued" | "running" | "completed" | "blocked" | "stopped" | "skipped" | "excluded";
/** Router stop reasons are finite and never invent new billing/provider authority. */
export type RouterStopReason = "complete" | "max_rounds" | "budget_exhausted";
/** One role's attributed analysis slot under a discussion; peer output is never trusted instruction. */
export interface DiscussionParticipation {
  roleId: string; roleName: string; runId: string; jobId: string; purpose: string;
  state: ParticipationState; route: RoleRoute | null; output: SourceReference | null;
  reason: string | null; nextAction: string | null;
  progress: { text: string; provisional: true } | null;
}
/** Bounded scripted router evidence retained with the discussion; unknown roles never become jobs. */
export interface DiscussionRouter {
  rounds: number; selected: string[]; silent: string[]; stopReason: RouterStopReason; evidence: string;
}
/** One owner-authorized logical discussion over a frozen source snapshot. */
export interface Discussion {
  kind: "discussion";
  id: string; projectId: string; topicId: string; purpose: string; jobId: string;
  revision: number; createdAt: number; updatedAt: number;
  manifest: RunSourceManifest; limits: JobLimits;
  router: DiscussionRouter; participations: DiscussionParticipation[];
  coverageGap: string[];
}
/** Independent specialist analysis run bound to one discussion and one managed context. */
export interface SpecialistRun {
  kind: "specialist";
  id: string; discussionId: string; projectId: string; topicId: string; roleId: string; roleName: string; jobId: string;
  request: ApplicationRunRequest; mode: "fixture"; createdAt: number;
  outcome: ApplicationRunOutcome | null; source: SourceReference | null;
  progress: { text: string; provisional: true } | null;
}

/** Owner mutations use shared durable receipts; saving configuration never starts a run. */
export type TeamCommand = {
  kind: "role.save"; requestId: string; projectId: null; expectedRevision: number;
  payload: { roleId: string | null; name: string; kind: Role["kind"]; responsibility: string; enabled: boolean; route: RoleRoute | null };
} | {
  kind: "route.save"; requestId: string; projectId: string | null; expectedRevision: number;
  payload: { roleId: string | null; route: RoleRoute | null };
} | {
  kind: "role.preview"; requestId: string; projectId: string; expectedRevision: number;
  payload: { roleId: string; topicId: string; purpose: string; sources: SourceReference[]; limits: JobLimits };
} | {
  kind: "team.dispatch"; requestId: string; projectId: string; expectedRevision: number;
  payload: { topicId: string; purpose: string; sources: SourceReference[]; include: string[]; exclude: string[]; limits: JobLimits };
} | {
  kind: "team.control"; requestId: string; projectId: string; expectedRevision: number;
  payload: { discussionId: string; action: "include" | "exclude" | "skip" | "stop"; roleId: string };
};
/** A durable fixture run records immutable configuration separately from current effective settings. */
export interface RolePreview {
  id: string; projectId: string; topicId: string; roleId: string; roleName: string; jobId: string;
  request: ApplicationRunRequest; mode: "fixture"; createdAt: number;
  outcome: ApplicationRunOutcome | null; source: SourceReference | null;
}
/** Owner-visible command result is acknowledged only together with its audit and receipt. */
export interface TeamReceipt { revision: number; role?: Role; preview?: RolePreview; discussion?: Discussion }

/** A role that produced no citable result; the coordinator must show this gap and must not call it consensus. */
export interface SynthesisGap { roleId: string; roleName: string; reason: string }
/** One allowed specialist result revision. Model text cannot add roles or routes here. */
export interface SynthesisCitation { roleId: string; roleName: string; route: RoleRoute | null; reference: SourceReference }
/** One option inside a coordinator recommendation. It is not an owner decision. */
export interface SynthesisOption { id: string; label: string; rationale: string; citations: SynthesisCitation[] }
/** The committed recommendation. `recommendationOnly` stays true; consensus is false when specialists disagree or a gap remains. */
export interface SynthesisArtifact {
  disagreement: boolean; consensus: boolean; recommendationOnly: true;
  options: SynthesisOption[]; missing: SynthesisGap[]; question: string;
}
/** One immutable proposal revision produced by a citation-checked synthesis. */
export interface DecisionProposal {
  id: string; projectId: string; topicId: string; discussionId: string; revision: number; synthesisId: string;
  artifact: SynthesisArtifact; source: SourceReference; createdAt: number;
}
/** Product state of one coordinator synthesis run. Complete is distinct from an owner decision. */
export type SynthesisState = "queued" | "running" | "complete" | "incomplete" | "failed" | "cancelled";
/** The latest coordinator run for a discussion. Fixture output is not itself the proposal. */
export interface CoordinatorSynthesis {
  id: string; projectId: string; topicId: string; discussionId: string; jobId: string; baseRevision: number;
  state: SynthesisState; reason: string | null; createdAt: number; updatedAt: number;
}
/** An owner-selected conclusion. It cites the proposal revision the owner saw and is separate from the recommendation. */
export interface OwnerDecision {
  id: string; projectId: string; topicId: string; proposalId: string; proposalRevision: number; revision: number;
  actorId: "owner"; channel: "web"; optionId: string | null; conclusion: string; rationale: string;
  sourceLinks: SourceReference[]; supersededBy: string | null; createdAt: number;
}
/** A source link resolved against the registry. Unavailable content is not replaced. */
export interface ResolvedEvidence {
  reference: SourceReference; roleId: string | null; roleName: string | null; route: RoleRoute | null;
  state: "available" | "unavailable"; reason: string | null; text: string | null;
}
/** One retained owner decision together with the proposal and evidence it resolved. */
export interface DecisionHistoryEntry { decision: OwnerDecision; proposal: DecisionProposal; evidence: ResolvedEvidence[] }
/**
 * app.decision_read_model/v1
 * Topic-scoped projection of the current proposal, synthesis status, owner history and evidence availability.
 */
export interface DecisionReadModel {
  synthesis: CoordinatorSynthesis | null; proposal: DecisionProposal | null; proposalEvidence: ResolvedEvidence[];
  decisions: DecisionHistoryEntry[]; currentDecision: DecisionHistoryEntry | null;
}
/**
 * app.decision_commands/v1
 * Owner commands for synthesis admission, acceptance and supersession. Model text is not a member of this union.
 */
export type DecisionCommand = {
  kind: "decision.synthesize"; requestId: string; projectId: string; expectedRevision: number;
  payload: { discussionId: string; limits: JobLimits };
} | {
  kind: "decision.accept"; requestId: string; projectId: string; expectedRevision: number;
  payload: { proposalId: string; optionId: string | null; conclusion: string; rationale: string };
} | {
  kind: "decision.supersede"; requestId: string; projectId: string; expectedRevision: number;
  payload: { decisionId: string; proposalId: string; optionId: string | null; conclusion: string; rationale: string };
};
/** Receipt returned only after the decision transaction commits. A replay returns the original value. */
export interface DecisionReceipt { revision: number; synthesis?: CoordinatorSynthesis; proposal?: DecisionProposal; decision?: OwnerDecision }
