import type { ClientSnapshot } from "./contracts";

/** Ephemeral target generation prevents late responses from crossing conversations or owner sessions. */
export interface ConversationClientState { conversationId: string | null; generation: number; state: "idle" | "loading" | "ready" | "unavailable"; snapshot: ClientSnapshot | null }
/** An empty client retains no private transcript, CSRF, approval or session material. */
export const emptyConversationState = (): ConversationClientState => ({ conversationId: null, generation: 0, state: "idle", snapshot: null });
/** Begin navigation/revalidation by discarding the prior projection; no fetch or command is implied. */
export function beginConversation(state: ConversationClientState, conversationId: string): ConversationClientState {
  return { conversationId, generation: state.generation + 1, state: "loading", snapshot: null };
}
/** Only a matching, monotonic, freshly authorized snapshot can replace displayed content. */
export function receiveConversation(state: ConversationClientState, generation: number, snapshot: ClientSnapshot): ConversationClientState {
  if (generation !== state.generation || snapshot.conversation.conversationId !== state.conversationId || state.state === "unavailable" || state.snapshot && snapshot.conversation.cursor < state.snapshot.conversation.cursor) return state;
  return { ...state, state: "ready", snapshot };
}
/** Clear private content on failed authentication/revalidation; stale in-flight responses stay fenced. */
export function withholdConversation(state: ConversationClientState): ConversationClientState {
  return { ...state, generation: state.generation + 1, state: "unavailable", snapshot: null };
}
