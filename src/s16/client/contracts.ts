import type { ConversationCommand, ConversationDecisionCommand, ConversationEvent, ConversationReceipt } from "../../s15/conversation/types";
import type { ConversationListEntry, ConversationNeedsYou, ConversationOwnerRow, ConversationOwnerView } from "../../s15/conversation/owner-view";
import type { FileArtifact, FileLimits } from "../files/types";

/** Versioned client capabilities describe actual composed operations, never execution authority. */
export interface ClientCapabilities {
  contract: "s16-client-capabilities/v1";
  revision: 1 | 2;
  textMessages: true;
  progress: "control_events";
  exactDecisions: boolean;
  liveSteering: false;
  uploads: { available: false; code: "upload_unavailable" } | { available: true; limits: FileLimits; extensions: string[]; formats?: { extension: string; mime: string; bytes: number }[]; textBytes?: number; unavailableBinary?: "sanitizer_unavailable" | "images_unsupported"; memory: boolean; memoryContract?: "s16-file-memory/v1"; binary?: { limits: typeof import("../files/parser").binaryLimits; images: boolean } };
  /** `library`/`revisions`/`html` are additive: absent on older services, which keep conversation cards only. */
  artifacts: { available: false; code: "artifact_unavailable" } | { available: true; preview: "escaped_text"; library?: "s16-client-artifacts/v1"; revisions?: boolean; html?: "sandboxed_static" };
  /** Additive field: owner memory search/detail/correct/forget over the existing MEM authority. */
  memory?: { available: false; code: "memory_unavailable" } | { available: true; contract: "s16-client-memory/v1" };
  /** Additive field: owner-confirmed routines (`s16-routines/v1`). Reactions list the source kinds this service composes. */
  routines?: { available: false; code: "routines_unavailable" } | { available: true; contract: "s16-client-routines/v1"; reactions: { signed: true; github: true; artifacts: boolean }; feed: true };
  /** Additive field: Web Push notices (`s16-notifications/v1`) and the fixed service worker/scope that receives them. */
  notifications?: { available: false; code: "notifications_unavailable" } | { available: true; contract: "s16-notifications/v1"; transport: "web_push"; serviceWorker: "/s16/sw.js"; scope: "/s16/" };
}
/** Authenticated, no-store bootstrap. CSRF stays in the transport, outside persisted client state. */
export interface ClientBootstrap {
  contract: "s16-client-bootstrap/v1";
  csrf: string;
  capabilities: ClientCapabilities;
  conversations: ConversationListEntry[];
  needsYou: { conversationId: string; entry: ConversationNeedsYou }[];
  /** Additive: unseen non-quiet routine outcomes. Quiet runs never count. */
  routines?: { attention: number };
}
/** Currently authorized owner projection; completion cannot be reconstructed from progress events. */
export interface ClientSnapshot { contract: "s16-client-snapshot/v1"; conversation: ConversationOwnerView }
/** One currently authorized request, including requests older than the bounded conversation window. */
export interface ClientRequest { contract: "s16-client-request/v1"; conversationId: string; receipt: ConversationReceipt; row: ConversationOwnerRow }
/** Monotonic conversation-bound metadata, used only to invalidate and refresh owner projections. */
export interface ClientEvents { contract: "s16-client-events/v1"; conversationId: string; cursor: number; events: ConversationEvent[] }
/** Existing text and exact-decision semantics are retained; file-bearing commands require a new version. */
export type ClientMessage = ConversationCommand;
export type ClientDecision = ConversationDecisionCommand;
export type ClientReceipt = ConversationReceipt;

/** Finite complete JSON response bound shared by the protected adapter and browser/native transport. */
export const clientResponseBytes = 8 * 1024 * 1024;

/** Owner-visible retention scope. A Bot-private item names only that Bot's reference ID. */
export type ClientMemoryScope = { kind: "team" } | { kind: "bot"; botId: string };
/** Retrieval/source state. `withdrawn` is a source fact; `superseded`/`forgotten` are owner commands. */
export type ClientMemoryState = "active" | "superseded" | "forgotten" | "withdrawn";
/**
 * One bounded sourced memory row. It is data only: no field grants execution, approval, account or
 * scope authority. Erased (forgotten/superseded/file-withdrawn) rows keep labels with an empty snippet.
 */
export interface ClientMemoryItem {
  id: string; revision: number;
  kind: "fact" | "inference"; category: "fact" | "preference" | "working_knowledge";
  confirmation: "owner_stated" | "observed" | "unconfirmed";
  state: ClientMemoryState;
  /** Plain text, at most 280 characters, produced only after scope/state filtering. */
  snippet: string;
  scope: ClientMemoryScope;
  source: { kind: "owner_message" | "work" | "historical"; conversationId: string | null; at: number; files: number };
  supersedes: string | null; correction: string | null;
  createdAt: number;
  /** Latest recorded context that included this item; null when unused or recorded before v1 timing. */
  lastUsedAt: number | null;
  /** Retained contexts that included this item. With a null `lastUsedAt`, a positive count means "time unknown". */
  contexts: number;
}
/** Exact search/filter echo. `bot` restricts to items that Bot may retrieve, before any ranking. */
export interface ClientMemoryQuery { q: string; kind: "all" | "fact" | "inference"; category: "all" | "fact" | "preference" | "working_knowledge"; state: "active" | "inactive" | "all"; bot: string | null; offset: number }
/** Bounded owner search page; `bots` lists Bot IDs that own private items, for the filter control. */
export interface ClientMemoryList { contract: "s16-client-memory/v1"; query: ClientMemoryQuery; total: number; limit: 50; items: ClientMemoryItem[]; bots: string[] }
/** Retained application lineage counts. Previously seen remote/model bytes cannot be recalled. */
export interface ClientMemoryUses { contexts: number; summaries: number; artifacts: number; workItems: number }
/** Full owner detail, including the exact source quote, file hashes and correction chain labels. */
export interface ClientMemoryDetail {
  contract: "s16-client-memory-detail/v1";
  item: ClientMemoryItem & { text: string; quote: string };
  files: { sourceId: string; sha256: string; representationSha256: string | null; current: boolean }[];
  /** Older and newer revisions in the correction chain, oldest first, excluding this item. */
  chain: ClientMemoryItem[];
  uses: ClientMemoryUses;
}
/** Existing exact-revision owner commands; impact is a read-only preview of what forget/correct retires. */
export type ClientMemoryCommand =
  | { contract: "s15-memory-command/v1"; requestId: string; kind: "memory.correct"; claim: { id: string; revision: number }; text: string }
  | { contract: "s15-memory-command/v1"; requestId: string; kind: "memory.forget" | "memory.impact"; claim: { id: string; revision: number } };
/** Impact counts mirror MEM's retained lineage, never a claim that downloaded bytes were purged. */
export interface ClientMemoryImpact { claims: number; sources: number; summaries: number; artifacts: number; contexts: number; nativeSessions: number; workItems: number }
export type ClientMemoryResult =
  | { contract: "s15-memory-impact/v1"; claim: { id: string; revision: number }; impact: ClientMemoryImpact }
  | { contract: "s15-memory-receipt/v1"; requestId: string; kind: "memory.correct" | "memory.forget"; claim: { id: string; revision: number } | null; impact: ClientMemoryImpact };

/** Library search echo. `before` is the opaque `createdAt.id` position of the previous page's last item. */
export interface ClientArtifactQuery { q: string; type: "all" | "text" | "markdown" | "csv" | "html"; conversation: string | null; before: string | null }
/**
 * One committed, currently publishable artifact. `label` is the plain producing owner message (at most 120
 * characters); `revision` counts immutable parents; `parent` is the revised artifact, if any. Data only.
 */
export interface ClientArtifactItem { artifact: FileArtifact; conversationId: string; label: string; revision: number; parent: string | null; inputs: number }
/** Bounded newest-first page recomputed under current authorization on every read. */
export interface ClientArtifactList { contract: "s16-client-artifacts/v1"; query: ClientArtifactQuery; limit: 50; items: ClientArtifactItem[]; next: string | null }
/** An exact input of the producing request; `origin` names the parent artifact of a revision input. */
export interface ClientArtifactInput { id: string; name: string; mime: string; bytes: number; sha256: string; origin: string | null }
/**
 * Current provenance and committed revision family (oldest first), at most 256 members: the viewed file, all
 * its ancestors, then the newest others. `familyTotal` counts the whole current family. Preview names the
 * only allowed renderer.
 */
export interface ClientArtifactDetail { contract: "s16-client-artifact/v1"; item: ClientArtifactItem; inputs: ClientArtifactInput[]; revisions: ClientArtifactItem[]; familyTotal: number; preview: "escaped_text" | "sandboxed_html" }
/** Explicit owner command copying one exact committed artifact into a new input of its own conversation. */
export interface ClientArtifactInputCommand { requestId: string; conversationId: string; sha256: string }
export type { RoutineDetail as ClientRoutineDetail, RoutineList as ClientRoutineList, RoutineOptions as ClientRoutineOptions, RoutineProposal as ClientRoutineProposal, RoutineReceipt as ClientRoutineReceipt, RoutineDraft as ClientRoutineDraft, RoutineOccurrence as ClientRoutineOccurrence, RoutineSummary as ClientRoutineSummary, RoutineSourceView as ClientRoutineSource } from "../routines/types";
export type { NotificationSettings as ClientNotificationSettings, NotificationDevice as ClientNotificationDevice, NotificationSubscribeCommand as ClientNotificationSubscribeCommand, NotificationPayload as ClientNotificationPayload, NoticeKind as ClientNoticeKind } from "../notifications/types";
