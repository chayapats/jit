import type { ScreenControlState, ScreenView } from "./screen";

/** ADR 0092 row h; no reason or card carries a credential or grants another action. */
export type ComputerNeedsYouReason = "sign_in" | "verify" | "captcha";
/** Protected context comes from the placed work, never from the model operation. */
export interface ComputerNeedsYouPost {
  requestId: string; conversationId: string; ownerGeneration: number; vmGeneration: number; vmId: string;
  reason: ComputerNeedsYouReason; origin: string;
}
/** Outcome supplied as untrusted work-prompt data, separately from memory or execution authority. */
export interface ComputerScreenOutcome {
  cardId: string; origin: string; reason: ComputerNeedsYouReason;
  outcome: "resumed" | "declined" | "expired"; generation: number;
}
/** Protected host scheduling proof, derived from a committed screen event rather than a new owner message. */
export interface ComputerScreenResumption {
  cardId: string; requestId: string; conversationId: string; vmId: string; ownerGeneration: number; generation: number;
}
/** Actual scheduling/publication facts, independent of the sign-in outcome. */
export interface ComputerContinuationView { state: "pending" | "queued" | "running" | "completed" | "held" | "stopped" | "covered" | "unknown"; requestId: string | null; code: string | null }
/** Current authenticated owner card. Screen events, rather than cached card updates, determine the outcome. */
export interface ComputerNeedsYouCard extends ComputerNeedsYouPost {
  id: string; createdAt: number; expiresAt: number;
  continuation?: ComputerContinuationView;
  state: "pending" | "void" | ComputerScreenOutcome["outcome"];
  code: string | null;
  generation: number | null; screenState: ScreenControlState | null; canWatch: boolean; canDecline: boolean;
}
/** Explicit owner watch/decline. Text in chat cannot call this protected command. */
export interface ComputerNeedsYouCommand {
  contract: "s16-computer-needs-you/v1"; requestId: string; conversationId: string; cardId: string;
  kind: "watch" | "decline"; generation: number;
}
/** A watch takes control before returning the screen view; it sends no browser or owner-input batch. */
export interface ComputerNeedsYouResult { contract: "s16-computer-needs-you-result/v1"; card: ComputerNeedsYouCard; screen: ScreenView | null }
