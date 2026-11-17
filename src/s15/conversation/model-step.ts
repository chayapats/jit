import type { ConversationRequest } from "./types";

/** A continuation keeps its work ID while starting a fresh MODEL step/native session, never an old claim. */
export function conversationModelStepId(request: Pick<ConversationRequest, "computerContinuation" | "receipt">): string {
  return request.computerContinuation ? `continuation_${request.receipt.rootRequestId}` : "conversation";
}
