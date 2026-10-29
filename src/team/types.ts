import type { JobLimits } from "../jobs/types";
import type { SourceReference } from "../sources";
import type { RoutingSelection } from "./routing";

/** Registered work types; the authoritative jobs record carries the type, never the run JSON. */
export const discussionWorkId = "team.discussion";
export const specialistWorkId = "team.specialist-analysis";
export const coordinatorSynthesisWorkId = "team.coordinator-synthesis";

/** An atomic selected subscription route; the auth reference names configured access and never contains credentials. */
export interface RoleRoute { provider: "grok" | "codex"; model: string; authRoute: string }
/** One owner-configured responsibility, independent of a model, session or execution permission. */
export interface Role {
  /** Set by role.archive; archived roles are invisible to readTeam. Absent or null means active. */
  archivedAt?: number | null;
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
  /** app.memory_context/v1 layer labels; absent for runs that never assembled memory context. */
  context?: MemoryContextLayout;
}
/** Current authoritative project state copied from app.project_continuity/v1 at assembly; never derived memory. */
export interface ContextConstraint {
  kind: "task" | "decision"; id: string; revision: number; topicId: string;
  /** Task lifecycle state, or `current` for the live owner decision of a topic. */
  state: "proposed" | "accepted" | "ready_for_review" | "current";
  text: string; truncated: boolean; source: SourceReference;
}
/** Trust layer of one manifest claim; cross_project claims are always inferences for the requesting project. */
export interface ContextClaimLayer {
  layer: "explicit_preference" | "inference"; scope: "project" | "cross_project";
  kind: "explicit_fact" | "inference"; source: SourceReference;
  conflicts: readonly { claimId: string; revision: number; generation: number }[];
}
/**
 * app.memory_context/v1 policy 1 layout. `manifest.sources` are source evidence, `claims[i]` labels
 * `manifest.claims[i]`, and the persisted app.context_provenance/v1 record `recordId` holds exact revisions.
 */
export interface MemoryContextLayout {
  version: 1; recordId: string; policy: 1;
  constraints: readonly ContextConstraint[];
  claims: readonly ContextClaimLayer[];
  omitted: { constraints: number; claims: number; unavailable: number; budget: boolean; loopGuard: boolean };
  derivation: { inputDepth: number };
  /** app.context_packet/v1 labelled sections; absent on contexts assembled before the packet existed. */
  packet?: ContextPacket;
}

/** app.context_packet/v1 section names, always in this order (ADR 0034). */
export const contextPacketSections = [
  "purpose", "responsibilities", "current_request", "pinned_decisions", "constraints", "recent_messages", "summary", "memory_claims",
] as const;
export type ContextPacketSectionName = typeof contextPacketSections[number];
/**
 * One live owner decision copied from committed `owner_decisions` at assembly: the run topic's live decision first,
 * then the live decisions of the project's other topics. Text is never clipped; it is owner state, not memory.
 */
export interface PinnedDecision {
  id: string; revision: number; topicId: string; scope: "topic" | "project";
  conclusion: string; rationale: string; source: SourceReference;
}
/**
 * The packet's versioned summary: the newest committed scheduled summary of the run topic. Its text is the
 * manifest source at `index`; `sourceIds` are the sources that summary run itself was given.
 */
export interface ContextPacketSummary {
  summaryRevision: number; index: number; source: SourceReference; sourceIds: string[];
  /** Memory derivation depth of the summary output; the run output inherits it. */
  depth: number;
}
/** One packet section and how much of it the run received. */
export interface ContextPacketSection {
  order: number; name: ContextPacketSectionName;
  /** included: every candidate; trimmed: some dropped; dropped: none fit; empty: nothing to add; withheld: not given to this run type. */
  state: "included" | "trimmed" | "dropped" | "empty" | "withheld";
  items: number; bytes: number;
}
/** One recorded reason a packet section lost candidates. A pinned decision never appears here. */
export interface ContextPacketOmission {
  section: Exclude<ContextPacketSectionName, "pinned_decisions">;
  reason: "budget" | "ceiling" | "loop_guard" | "unavailable" | "run_policy";
  items: number;
}
/**
 * app.context_packet/v1: the labelled layout every run's context is rebuilt from, using committed tables only.
 * Pinned decisions have no count cap and are never trimmed; when they alone exceed the run's context bytes the run
 * is not admitted (`context_too_large`). Other sections are trimmed bottom-up, and every trim is an omission record.
 */
export interface ContextPacket {
  contract: "app.context_packet/v1"; version: 1;
  sections: ContextPacketSection[];
  pinned: PinnedDecision[];
  summary: ContextPacketSummary | null;
  /** Indexes into `manifest.sources` for the current request and the recent topic messages. */
  sourceIndexes: { currentRequest: number[]; recentMessages: number[] };
  omissions: ContextPacketOmission[];
  /** Request bytes the packet sections 4–8 could use, the pinned decision bytes, and the bytes they used in total. */
  budget: { bytes: number; pinned: number; used: number };
}
/** Service-owned read tools that later consumers may select explicitly; preview and dispatch select none. */
export type ApplicationReadTool = "project.read" | "source.read" | "memory.read";
/**
 * exec.run_tools/v1 (EXE05, ADR 0036): the execution grant of one run, computed at admission from the effective access
 * level of the project and the run's role, and frozen in the attempt snapshot. `null` (and a missing field on records
 * written before EXE05) admits no execution tool. Model output, sources and tool results never change it.
 */
export interface RunExecutionGrant { level: "workspace" | "full"; boxProjectId: string }
/** The immutable scope/configuration and finite authority supplied to one application run invocation. */
export interface ApplicationRunRequest {
  runId: string; projectId: string; topicId: string; roleId: string; purpose: string;
  route: RoleRoute; configuration: { ownerRevision: number; projectRevision: number; roleRevision: number };
  context: ManagedContextReference;
  fence: { jobId: string; generation: number; ownerGeneration: number };
  instructions: { operator: readonly string[]; responsibility: string };
  manifest: RunSourceManifest;
  tools: readonly ApplicationReadTool[];
  /**
   * Host-process policy: no generic execution, fetch, hosted lookup or discovery ever runs in the Jit process. Box
   * execution is the separate `execution` grant, whose tools run only inside the project's execution box.
   */
  policy: { genericExecution: false; arbitraryFetch: false; hostedLookup: false; repositoryDiscovery: false };
  /** exec.run_tools/v1: the frozen execution grant; `null` or absent means no execution tool is admitted. */
  execution?: RunExecutionGrant | null;
  limits: JobLimits;
}
/** Normalized reasons retain incomplete/blocked/cancelled states without raw provider diagnostics or route fallback. */
export type RunReason = "complete" | "unknown_model" | "route_unavailable" | "quota" | "needs_login" | "cancelled"
  | "max_rounds" | "budget_exhausted" | "invalid_result" | "context_retired";
/** Usage reports are finite nonnegative measurements, distinct from permission to spend any resource. */
export interface ApplicationRunUsage {
  calls: number; rounds: number; hops: number; contextTokens: number; outputTokens: number; retries: number; wallMs: number;
  /**
   * True when any provider token counter was unreported; totals are then
   * partial, never measured zero. Absent on pre-bridge records, which predate
   * production runs and therefore carry exact fixture accounting (read as false).
   */
  tokensUnknown?: boolean;
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
/** Status of one specialist result. `incomplete` is assigned by the service only and is never accepted from a model. */
export type SpecialistResultStatus = "done" | "partial" | "blocked" | "failed" | "incomplete";
/**
 * app.specialist_results/v2 (ADR 0033): one specialist's normalized result. `blocked` carries exactly one `unblock`
 * action; every other status has `unblock: null`. Evidence references are manifest sources of the run. Output that
 * does not match the closed shape is `incomplete` with its bounded `raw` text kept for inspection; it never counts as
 * done. A result is analysis only: it grants no authority and creates no task or decision.
 */
export interface SpecialistResultV2 {
  version: 2; status: SpecialistResultStatus; result: string;
  evidence: SourceReference[] | "none"; unblock: string | null; raw: string | null;
}
/**
 * Read-only status of one committed specialist result. v2 records carry their normalized result; a v1 record from
 * before app.specialist_results/v2 is derived from its outcome (complete → done) and is never rewritten.
 */
export interface ParticipationResult { version: 1 | 2; status: SpecialistResultStatus; unblock: string | null }
/** One role's attributed analysis slot under a discussion; peer output is never trusted instruction. */
export interface DiscussionParticipation {
  roleId: string; roleName: string; runId: string; jobId: string; purpose: string;
  state: ParticipationState; route: RoleRoute | null; output: SourceReference | null;
  reason: string | null; nextAction: string | null;
  progress: { text: string; provisional: true } | null;
  /** Status of the committed result; null while none is committed. Absent on participations stored before v2. */
  result?: ParticipationResult | null;
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
  /**
   * app.dispatch_allowance/v1: set when a Jit dispatch proposal started this discussion, either under the owner's
   * standing allowance (with the allowance revision that admitted it) or after the owner accepted the proposal card.
   * Absent for discussions the owner started from the dispatch form.
   */
  origin?: DiscussionOrigin;
  /** Set by `team.stop_all`; a stopped team gets no automatic team reply. */
  stoppedAll?: boolean;
  /**
   * app.specialist_results/v2: roles the Jit dispatch named but did not call again, because their latest result for
   * this same request is blocked. The team reply and synthesis show them as `result_blocked` gaps; each `runId` names
   * the blocked run whose record holds the unblock action. A role the owner includes later leaves this list, and
   * readers skip any held role that is also a participant.
   */
  held?: { roleId: string; roleName: string; runId: string }[];
  /** app.routing_selection/v1: the fixed rule or model selection that chose a Jit-dispatched discussion's roles. */
  selection?: RoutingSelection;
  /** delivery.attention_levels/v1: the work group of the Jit reply that started this discussion; absent otherwise. */
  workGroupId?: string | null;
}
/** Who authorized a discussion that a Jit dispatch proposal asked for. Model output is never the authority. */
export interface DiscussionOrigin {
  kind: "standing-allowance" | "owner-accepted"; proposalId: string; replyId: string; allowanceRevision: number;
}
/** Independent specialist analysis run bound to one discussion and one managed context. */
export interface SpecialistRun {
  kind: "specialist";
  id: string; discussionId: string; projectId: string; topicId: string; roleId: string; roleName: string; jobId: string;
  request: ApplicationRunRequest; mode: "fixture" | "production"; createdAt: number;
  outcome: ApplicationRunOutcome | null; source: SourceReference | null;
  progress: { text: string; provisional: true } | null;
  /**
   * app.specialist_results/v2: the normalized result, set when a complete outcome commits; null otherwise. Absent on
   * v1 records, which stay as written and are read through a derived view.
   */
  result?: SpecialistResultV2 | null;
  /** Evidence references the model gave that are not manifest sources of this run; they were dropped. */
  droppedEvidence?: number;
  /** app.communication_policy/v1 version sent with this run. Absent on records written before the policy. */
  policyVersion?: number;
}

/** Owner mutations use shared durable receipts; saving configuration never starts a run. */
export type TeamCommand = {
  kind: "role.save"; requestId: string; projectId: null; expectedRevision: number;
  payload: { roleId: string | null; name: string; kind: Role["kind"]; responsibility: string; enabled: boolean; route: RoleRoute | null };
} | {
  kind: "role.archive"; requestId: string; projectId: null; expectedRevision: number;
  payload: { roleId: string };
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
} | {
  /** Stops every role still queued, running or waiting, plus the team reply, through the same controls and fences. */
  kind: "team.stop_all"; requestId: string; projectId: string; expectedRevision: number;
  payload: { discussionId: string };
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
export interface SynthesisGap {
  roleId: string; roleName: string; reason: string;
  /** app.specialist_results/v2: the specialist run of a `result_blocked` gap, whose record holds the unblock action. */
  runId?: string;
  /** Read model only: the unblock action, read from that run record when shown. Never stored. */
  unblock?: string | null;
}
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
  sourceLinks: SourceReference[];
  /** Replacement decision ID, or project:<id> when explicit whole-project deletion closes this decision. */
  supersededBy: string | null; createdAt: number;
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
