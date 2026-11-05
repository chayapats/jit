import type { HostClock, HostRunUsage, Model, ToolDefinition } from "schway/host";
import type { ActionRef, ActionSlip, ApprovalInput, Observation, PendingDecisionInput } from "../policy";
import type { FileArtifact, FileReceipt, FileReference } from "../../s16/files/types";
import type { FileSourcePin } from "../file-lineage";

/** Authenticated ordinary text only. Attachments/history are data supplied separately by trusted adapters. */
export interface ConversationTextCommand {
  contract: "s15-conversation/v1";
  requestId: string;
  conversationId: string;
  text: string;
  continuation: { requestId: string; revision: number } | null;
}
/** Explicit file-bearing ingress. Only immutable ready receipts are accepted; bytes confer no authority. */
export interface ConversationFileCommand extends Omit<ConversationTextCommand, "contract" | "continuation"> {
  contract: "s16-conversation/v2"; continuation: null; files: readonly FileReference[];
}
export type ConversationCommand = ConversationTextCommand | ConversationFileCommand;
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
  /** Synchronous idempotent admission under current policy. Reads is a trusted accepted-image count
   * for capacity calculation, not model input, new permission or an override of the owner ceiling. */
  admit(actor: OwnerActor, request: ConversationCommand, intent: ConversationIntent, reads?: { imageInputs: number }):
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
  /** Host-owned bounded evidence projection; outputHash still binds the complete actual tool response. */
  evidenceContent?: (content: string) => string;
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
export interface ConversationEvidence { kind?: "input"; id: string; tool: string; inputHash: string; outputHash: string; content: string; isError: boolean; at: number }
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
  inputEvidence?: ConversationEvidence[];
  fileInputs?: FileReceipt[];
  /** Frozen ingress semantics; enabling memory later never promotes previously accepted file work. */
  fileMemory?: "s16-file-memory/v1";
  artifacts?: FileArtifact[];
  modelCalls: number; toolCalls: number; result: string | null; usage: HostRunUsage | null;
  /** Usage evidence of the latest interpretation run, kept on failure too. Absent before MODEL15-02. */
  interpretationUsage?: HostRunUsage;
  actions: ActionRef[];
  /** Owner-only exact decision/dispatch. It cannot resume a model loop or grant another purpose. */
  decision: { action: ActionRef; decision: "approve" | "deny"; expiresAt: number; observation: Observation | null } | null;
  /** Full typed decision fingerprint; retries cannot reinterpret a changed revision/hash as the old vote. */
  decisionCommandHash?: string;
}
/** Optional protected sourced-memory integration. Model/retrieval data can never enter interpretation authority. */
export interface ConversationMemoryPort<WorkContext> {
  fileContract?: "s16-file-memory/v1";
  prepare(work: WorkContext, request: ConversationRequest, ingress?: { receivedAt: number }): { section: string; retained: NonNullable<ConversationRequest["memory"]>["retained"] };
  guard(work: WorkContext, requestId: string): void;
  observe?(work: WorkContext, request: ConversationRequest, evidence: ConversationEvidence, observations?: readonly ConversationEvidence[]): NonNullable<ConversationRequest["memory"]>["retained"];
  complete(work: WorkContext, requestId: string, text: string): NonNullable<ConversationRequest["memory"]>["retained"] | void;
  artifacts?(work: WorkContext, requestId: string, artifacts: readonly FileArtifact[]): void;
  allowHistory(requestId: string, originalText: string): boolean;
  history?(work: WorkContext, requestId: string, originalText: string): boolean;
  guardHistory?(work: WorkContext, fragments: readonly { id: string; text: string }[]): FileSourcePin[];
  release(requestId: string): void;
}
/** Protected composition explicitly opts in. Scripted model injection is a deterministic test seam only. */
export interface ConversationOptions<OwnerActor, WorkContext> {
  policy: ConversationPolicy<OwnerActor, WorkContext>;
  tools: ConversationToolPort<WorkContext>;
  nativeDirectory: string;
  memory?: ConversationMemoryPort<WorkContext>;
  files?: ConversationFilePort<OwnerActor, WorkContext>;
  clock?: HostClock;
  model?: Model;
  /** Optional separate scripted interpreter; production uses the preapproved public host auth route. */
  interpreterModel?: Model;
  /** Credential owner for CHAT's route hosts: the composition passes its one process credential lifecycle, so CHAT
   * and MODEL15 renewals on the same store share one single-flight token request. */
  routeAuth?: Pick<import("schway/host").HostAuthSelection, "store" | "lifecycle" | "fetch">;
  /** Privacy-only check before the public interpreter stream; it grants no tools or execution scope. */
  guardInterpretation?: (work: WorkContext, request: unknown, files?: readonly FileSourcePin[]) => void;
  /** Protected MODEL15 composition for work execution. Interpretation remains isolated and tool-free. */
  /** `countModelCall` must run before every model stream: it enforces and durably counts `limits.modelCalls`. */
  runWork?: (input: { work: WorkContext; request: ConversationRequest; definitions: readonly ToolDefinition[]; memorySection: string | undefined; signal: AbortSignal; guard(): void; countModelCall(): void; observeInput(evidence: ConversationEvidence): void }) => Promise<{ text: string; usage: HostRunUsage | null }>;
  /** Commit-fault seam for deterministic rollback tests; production leaves it absent. */
  beforeCommit?: () => void;
}
/** Protected file integration. First-slice file work does not retain/retrieve memory or interpreter history. */
export interface ConversationFilePort<OwnerActor, WorkContext> {
  accept(actor: OwnerActor, command: ConversationFileCommand): FileReceipt[];
  guard(work: WorkContext, request: ConversationRequest): void;
  open(work: WorkContext, request: ConversationRequest, input: Parameters<ConversationToolPort<WorkContext>["open"]>[1]): Promise<ConversationTools>;
  complete(work: WorkContext, request: ConversationRequest, evidence: readonly ConversationEvidence[]): FileArtifact[];
}
