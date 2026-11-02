import type { HostClock, HostRunUsage, Model, ToolDefinition } from "schway/host";

/** Authenticated ordinary text only. Attachments/history are data supplied separately by trusted adapters. */
export interface ConversationCommand {
  contract: "s15-conversation/v1";
  requestId: string;
  conversationId: string;
  text: string;
  continuation: { requestId: string; revision: number } | null;
}
/** Grounded in original owner bytes before any model call; acceptance and proposals confer no work authority. */
export interface ConversationIntent {
  kind: "answer" | "accept" | "inspect" | "execute" | "ambiguous";
  subject: string | null;
  instruction: string;
}
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
  /** Synchronous idempotent admission under current policy; input is grounded owner intent, not model output. */
  admit(actor: OwnerActor, request: ConversationCommand, intent: ConversationIntent):
    | { state: "admitted"; authority: ConversationAuthority }
    | { state: "held" | "proposed"; code: string };
  /** Reopens work authority only; it cannot reconstruct a claimed model/tool dispatch after process loss. */
  open(authority: ConversationAuthority): WorkContext;
  guard(work: WorkContext, stage: "model" | "tool" | "publication"): void;
  /** Charge each actual physical stream, including Schway retries/compaction; never refund unknown usage. */
  reserveModel(work: WorkContext, slot: string): void;
}
/** A registry entry authored by trusted host code. Model tool hints cannot set its access class. */
export interface ConversationTool {
  access: "read" | "write";
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
  open(work: WorkContext, input: { mode: "inspect" | "execute"; signal: AbortSignal; guard: () => void }): Promise<ConversationTools>;
}
/** Stable receipt acknowledges one durable ingress identity, independently of execution or completion. */
export interface ConversationReceipt { contract: "s15-conversation-receipt/v1"; requestId: string; rootRequestId: string; conversationId: string; receivedAt: number }
/** Control events contain no model/tool payload; result content is read through a fresh publication guard. */
export interface ConversationEvent {
  sequence: number; requestId: string; conversationId: string; at: number;
  kind: "received" | "admitted" | "progress" | "needs_me" | "evidence" | "result" | "stopped";
  code: string | null;
}
/** A service-observed tool invocation, never a model-authored citation or claim of success. */
export interface ConversationEvidence { id: string; tool: string; inputHash: string; outputHash: string; content: string; isError: boolean; at: number }
/** Durable request lifecycle. Claimed interrupted work is reconcile-only and is never automatically replayed. */
export interface ConversationRequest {
  receipt: ConversationReceipt; command: ConversationCommand; owner: ConversationOwner;
  revision: number; intent: ConversationIntent;
  state: "accepted" | "proposed" | "held" | "queued" | "running" | "completed" | "blocked" | "reconcile_only" | "stopped";
  code: string | null; authority: ConversationAuthority | null;
  modelCalls: number; toolCalls: number; result: string | null; usage: HostRunUsage | null;
}
/** Protected composition explicitly opts in. Scripted model injection is a deterministic test seam only. */
export interface ConversationOptions<OwnerActor, WorkContext> {
  policy: ConversationPolicy<OwnerActor, WorkContext>;
  tools: ConversationToolPort<WorkContext>;
  nativeDirectory: string;
  clock?: HostClock;
  model?: Model;
  /** Commit-fault seam for deterministic rollback tests; production leaves it absent. */
  beforeCommit?: () => void;
}
