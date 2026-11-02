import type { HostClock, HostRunUsage, Model, ToolDefinition } from "schway/host";
import type { ActionRef, ActionSlip, ApprovalInput, Observation, PendingDecisionInput } from "../policy";

/** Authenticated ordinary text only. Attachments/history are data supplied separately by trusted adapters. */
export interface ConversationCommand {
  contract: "s15-conversation/v1";
  requestId: string;
  conversationId: string;
  text: string;
  continuation: { requestId: string; revision: number } | null;
}
/** Exact owner decision posted from a reviewed slip. It names one action revision and hash; it is never model output. */
export interface ConversationDecisionCommand {
  contract: "s15-conversation-decision/v1";
  requestId: string;
  conversationId: string;
  action: ActionRef;
  decision: "approve" | "deny";
}
/** Grounded in original owner bytes before any model call; acceptance and proposals confer no work authority. */
export interface ConversationIntent {
  kind: "answer" | "accept" | "inspect" | "execute" | "ambiguous";
  subject: string | null;
  instruction: string;
  /** Frozen before tools; later model/tool/source output can only narrow this ceiling. */
  scope?: ConversationScope;
  /** Known owner condition/mixed scope permits evaluation reads only, pending an explicit owner start. */
  hold?: "conditional" | "mixed_scope";
}
/** Structured isolated interpretation is an untrusted proposal within the current approved catalog. */
export interface ConversationScope { purposeId: string; resourceIds: string[]; access: "read" | "reversible_write" | "effect" }
/** Exact current owner identity returned by the protected authentication service, never by a client body. */
export interface ConversationOwner { id: string; generation: number }
/** Persisted authority reference is data. Only the owning policy service can open a live work context. */
export interface ConversationAuthority {
  id: string;
  purposeId: string;
  policyRevision: number;
  resources: readonly string[];
  route: { provider: "codex" | "grok"; model: string };
  limits: { modelCalls: number; toolCalls: number; outputBytes: number; activeMs: number };
}
/** Policy-only consumer seam. Implementations authenticate/revalidate and reserve finite costs outside the guest. */
export interface ConversationPolicy<OwnerActor, WorkContext> {
  requireOwner(actor: OwnerActor): ConversationOwner;
  /** Preapproved inference-only scope, before any retrieval or tools. Missing finite authority holds. */
  prepareInterpretation(actor: OwnerActor, request: ConversationCommand):
    | { state: "admitted"; authority: ConversationAuthority; purposes: readonly string[]; resources: readonly string[] }
    | { state: "held"; code: string };
  /** Synchronous idempotent admission under current policy; input is grounded owner intent, not model output. */
  admit(actor: OwnerActor, request: ConversationCommand, intent: ConversationIntent):
    | { state: "admitted"; authority: ConversationAuthority }
    | { state: "held" | "proposed"; code: string };
  /** Reopens work authority only; it cannot reconstruct a claimed model/tool dispatch after process loss. */
  open(authority: ConversationAuthority): WorkContext;
  guard(work: WorkContext, stage: "model" | "tool" | "publication"): void;
  /** Charge each actual physical stream, including Schway retries/compaction; never refund unknown usage. */
  reserveModel(work: WorkContext, slot: string): { settle(): void };
  /** Protected owner projections/decisions only. Models and tool closures never receive these methods. */
  actionSlips?(actor: OwnerActor, actions: readonly ActionRef[]): ActionSlip[];
  decidePending?(actor: OwnerActor, input: PendingDecisionInput): void;
  decideAction?(actor: OwnerActor, input: ApprovalInput): void;
  dispatchAction?(authority: ConversationAuthority, action: ActionRef): Promise<Observation>;
  stopWork?(actor: OwnerActor, authority: ConversationAuthority, requestId: string): void;
}
/** A registry entry authored by trusted host code. Model tool hints cannot set its access class. */
export interface ConversationTool {
  access: "read" | "reversible_write" | "effect";
  definition: ToolDefinition;
}
/** Work-scoped VM/broker session. Its tools must guard actual I/O after waits and retain their own effect claims. */
export interface ConversationTools {
  tools: readonly ConversationTool[];
  /** Narrow cleanup only; return does not certify VM/process/effect settlement. */
  cancel(): Promise<void>;
  close(): Promise<void>;
}
/** Trusted VM/broker factory; there is no host-local backend fallback or dynamically installed model tool. */
export interface ConversationToolPort<WorkContext> {
  open(work: WorkContext, input: { mode: "inspect" | "execute"; signal: AbortSignal; guard: () => void; onAction?: (action: ActionRef) => void }): Promise<ConversationTools>;
}
/** Stable receipt acknowledges one durable ingress identity, independently of execution or completion. */
export interface ConversationReceipt { contract: "s15-conversation-receipt/v1"; requestId: string; rootRequestId: string; conversationId: string; receivedAt: number }
/** Control events contain no model/tool payload; result content is read through a fresh publication guard. */
export interface ConversationEvent {
  sequence: number; requestId: string; conversationId: string; at: number;
  kind: "received" | "admitted" | "progress" | "needs_me" | "evidence" | "result" | "stopped" | "decision";
  code: string | null;
}
/** A service-observed tool invocation, never a model-authored citation or claim of success. */
export interface ConversationEvidence { id: string; tool: string; inputHash: string; outputHash: string; content: string; isError: boolean; at: number }
/** Durable request lifecycle. Claimed interrupted work is reconcile-only and is never automatically replayed. */
export interface ConversationRequest {
  receipt: ConversationReceipt; command: ConversationCommand; owner: ConversationOwner;
  /** Latest immutable owner command, distinct from the root command when filling a material hold. */
  interpretationRequest: ConversationCommand;
  revision: number; intent: ConversationIntent;
  state: "accepted" | "proposed" | "held" | "queued" | "running" | "completed" | "blocked" | "reconcile_only" | "stopped";
  code: string | null; authority: ConversationAuthority | null;
  phase: "interpretation" | "work" | "decision";
  interpretation: { authority: ConversationAuthority; purposes: readonly string[]; resources: readonly string[] } | null;
  interpretationCalls: number;
  /** At most four owner clarification continuations; absent fields denote an older retained request. */
  clarifications?: number;
  /** Each admitted interpretation has one fresh native session and one physical model-call claim. */
  interpretationAttempt?: number;
  interpretationCallAttempt?: number;
  /** Durable ingress event sequence: interpretation cannot use subsequently authored context. */
  contextSequence?: number;
  memory?: { retained: { id: string; kind: "fact" | "inference"; category: string; source: { kind: string; id: string; conversationId: string | null; at: number } }[] };
  modelCalls: number; toolCalls: number; result: string | null; usage: HostRunUsage | null;
  actions: ActionRef[];
  /** Owner-only exact decision/dispatch. It cannot resume a model loop or grant another purpose. */
  decision: { action: ActionRef; decision: "approve" | "deny"; expiresAt: number; observation: Observation | null } | null;
}
/** Optional protected sourced-memory integration. Model/retrieval data can never enter interpretation authority. */
export interface ConversationMemoryPort<WorkContext> {
  prepare(work: WorkContext, request: ConversationRequest, ingress?: { receivedAt: number }): { section: string; retained: NonNullable<ConversationRequest["memory"]>["retained"] };
  guard(work: WorkContext, requestId: string): void;
  observe?(work: WorkContext, request: ConversationRequest, evidence: ConversationEvidence): NonNullable<ConversationRequest["memory"]>["retained"];
  complete(work: WorkContext, requestId: string, text: string): void;
  allowHistory(requestId: string, originalText: string): boolean;
  release(requestId: string): void;
}
/** Protected composition explicitly opts in. Scripted model injection is a deterministic test seam only. */
export interface ConversationOptions<OwnerActor, WorkContext> {
  policy: ConversationPolicy<OwnerActor, WorkContext>;
  tools: ConversationToolPort<WorkContext>;
  nativeDirectory: string;
  memory?: ConversationMemoryPort<WorkContext>;
  clock?: HostClock;
  model?: Model;
  /** Optional separate scripted interpreter; production uses the preapproved public host auth route. */
  interpreterModel?: Model;
  /** Privacy-only check before the public interpreter stream; it grants no tools or execution scope. */
  guardInterpretation?: (work: WorkContext, request: unknown) => void;
  /** Protected MODEL15 composition for work execution. Interpretation remains isolated and tool-free. */
  runWork?: (input: { work: WorkContext; request: ConversationRequest; definitions: readonly ToolDefinition[]; memorySection: string | undefined; signal: AbortSignal; guard(): void }) => Promise<{ text: string; usage: HostRunUsage | null }>;
  /** Commit-fault seam for deterministic rollback tests; production leaves it absent. */
  beforeCommit?: () => void;
}
