import type { AppTransaction } from "../store";
import type { Bot, Envelope, Route } from "./types";
import type { EvidenceRequirement, ReportProposal } from "./report-types";
import type { SchedulerLimits, GraphPlanner, StepGap, StepInput } from "./graph-types";
import type { MemoryRef } from "./memory-types";

/** Scoped immutable identity; neither variant can carry a filesystem path or ambient account. */
export interface ScopeRef { kind: "resource" | "share"; id: string; revision: number }
/** Trusted current resource/share policy supplied atomically by its owning service, never by a model. */
export interface ScopePolicy { ref: ScopeRef; active: boolean; ownerBotId: string; receiverBotId: string | null; workId: string | null; tools: string[]; snapshot: { id: string; revision: number; hash: string } }
/** Read-only integration port for later resource/share slices; missing policy refuses every resource. */
export interface ScopePort { current(tx: AppTransaction, ref: ScopeRef): ScopePolicy | null }
/** Explicit finite limits; counters are reservations and unknown actual usage is never represented as zero. */
export interface WorkLimits { attempts: number; steps: number; calls: number; outputBytes: number; wallMs: number; concurrency: number; reads: number }
/** Immutable owner grant snapshot; revocation and reservations live in separate rows. */
export interface WorkGrant { id: string; workId: string; revision: number; generation: number; ownerGeneration: number; requestId: string; command: StartWorkCommand; purpose: string; bots: Bot[]; routes: Route[]; tools: string[]; scopes: ScopePolicy[]; limits: WorkLimits; createdAt: number; expiresAt: number }
/** Retained obligation; result is the latest committed attempt ID, never an inline result body. Acceptance grants no execution. */
export interface Work { id: string; revision: number; conversationId: string; sourceMessageId: string | null; /** Exact committed task source, pinned at acceptance and checked at every start/use. */ source?: MemoryRef; title: string; purpose: string; completionRule: string; state: "proposed" | "accepted" | "queued" | "running" | "waiting" | "ready" | "blocked" | "stopping" | "stopped"; reason: string | null; grantId: string | null; result: string | null; createdAt: number }
/** Explicit start parameters; selected Bot and task revisions are checked in the receipt transaction. */
export interface StartPayload { conversationId: string; task: { id: string; revision: number } | null; title: string; purpose: string; completionRule: string; bots: { id: string; revision: number }[]; tools: string[]; scopes: ScopeRef[]; limits: WorkLimits; expiresAt: number; requiredEvidence?: EvidenceRequirement[] }
/** Obligation-only owner acceptance of a typed service proposal. */
export type AcceptTaskCommand = Envelope<"task.accept", { taskId: string }>;
/** Atomic creation of work, finite grant and durable queue intent from explicit owner authority. */
export type StartWorkCommand = Envelope<"work.start", StartPayload>;
/** Immediate fencing of named work; open transports keep stopping visible until settlement. */
export type StopWorkCommand = Envelope<"work.stop", { workId: string }>;
/** Exact single-use owner decision; the displayed hash is checked as well as the current revision. */
export type ApprovalCommand = Envelope<"approval.decide", { effectId: string; actionHash: string; decision: "approve" | "deny" }>;
/** app.work-grants/v1 and app.effect-approval/v2 owner command union. */
export type AuthorityCommand = AcceptTaskCommand | StartWorkCommand | StopWorkCommand | ApprovalCommand;
/** Atomic authority receipt shared by JSON and form ingress. */
export interface AuthorityReceipt { kind: AuthorityCommand["kind"]; requestId: string; work?: Work; grant?: WorkGrant; effect?: Effect }
/** Service-selected admission narrowing; no field can increase the originating grant. */
export interface Admission { botId: string; tools: string[]; scopes: ScopeRef[]; input: string; calls: number; outputBytes: number }
/** Immutable admission plus separate lifecycle evidence; routes, resources and grant generation are pinned. */
export interface Attempt { id: string; workId: string; requestId: string; parentId: string | null; snapshot: { grant: WorkGrant; bot: Bot; route: Route; tools: string[]; scopes: ScopePolicy[]; input: string; calls: number; outputBytes: number }; memoryId?: string; step?: { id: string; handler: "research" | "synthesis"; inputs: StepInput[]; gaps: StepGap[] }; state: "running" | "waiting" | "committed" | "settled" | "interrupted"; reason: string | null; createdAt: number }
/** One exact consequential action; no shell/browser/MCP fallback or always-allow mode exists. */
export interface EffectAction { kind: "send" | "publish" | "push" | "payment" | "delete"; destination: string; content: string }
/** Durable action ledger revision and outcome; unknown is reconcile-only and never claimable again. */
export interface Effect { id: string; revision: number; workId: string; attemptId: string; botId: string; action: EffectAction; actionHash: string; expiresAt: number; state: "pending" | "approved" | "denied" | "expired" | "executing" | "succeeded" | "failed" | "unknown" | "changed"; resolution?: { basis: "owner_statement"; outcome: "occurred" | "did_not_occur"; note: string; recordedAt: number }; reason: string | null; supported: boolean }
/** Worker result is evidence for owner review, not an automatic claim that the completion rule is fulfilled. */
export interface WorkOutput { state: "ready" | "waiting"; text: string; report?: ReportProposal; proposals?: unknown }
/** Immutable result evidence stored outside capped records, bounded by the originating attempt's output reservation. */
export interface WorkResult extends Pick<WorkOutput, "state" | "text"> { attemptId: string; workId: string; committedAt: number }
/** Trusted bounded internal handler; production foundation offers only tool-free analysis over schway/host. */
export interface WorkExecutor { run(attempt: Attempt, signal: AbortSignal): Promise<WorkOutput> }
/** Reviewed external adapter contract; production foundation configures none and tests use no-send fixtures. */
export type EffectPerformer = (action: EffectAction, allowed: () => void) => Promise<"succeeded" | "failed" | "unknown">;
/** Deterministic trusted scope/worker seams; callers cannot install these through HTTP or model text. */
export interface AuthorityOptions { scopes?: ScopePort; executor?: WorkExecutor; effects?: Partial<Record<EffectAction["kind"], EffectPerformer>>; scheduler?: SchedulerLimits; planner?: GraphPlanner }
/** Query projection for grants, tasks, attempts, exact approval cards and separately stored bounded result bodies. */
export interface WorkView { work: Work; grant: WorkGrant | null; authority: { generation: number; revoked: boolean } | null; reservations: { attempts: number; steps: number; calls: number; outputBytes: number; reads: number } | null; actualUsage: null; attempts: Attempt[]; effects: Effect[]; results: WorkResult[] }
