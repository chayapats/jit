import type { ConversationCommand, ConversationDecisionCommand, ConversationEvent, ConversationReceipt } from "../../s15/conversation/types";
import type { ConversationListEntry, ConversationNeedsYou, ConversationOwnerRow, ConversationOwnerView } from "../../s15/conversation/owner-view";
import type { FileLimits } from "../files/types";

/** Versioned client capabilities describe actual composed operations, never execution authority. */
export interface ClientCapabilities {
  contract: "s16-client-capabilities/v1";
  revision: 1 | 2;
  textMessages: true;
  progress: "control_events";
  exactDecisions: boolean;
  liveSteering: false;
  uploads: { available: false; code: "upload_unavailable" } | { available: true; limits: FileLimits; extensions: string[]; formats?: { extension: string; mime: string; bytes: number }[]; textBytes?: number; unavailableBinary?: "sanitizer_unavailable" | "images_unsupported"; memory: boolean; memoryContract?: "s16-file-memory/v1"; binary?: { limits: typeof import("../files/parser").binaryLimits; images: boolean } };
  artifacts: { available: false; code: "artifact_unavailable" } | { available: true; preview: "escaped_text" };
}
/** Authenticated, no-store bootstrap. CSRF stays in the transport, outside persisted client state. */
export interface ClientBootstrap {
  contract: "s16-client-bootstrap/v1";
  csrf: string;
  capabilities: ClientCapabilities;
  conversations: ConversationListEntry[];
  needsYou: { conversationId: string; entry: ConversationNeedsYou }[];
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
