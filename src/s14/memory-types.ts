import type { Envelope } from "./types";

/** Exact immutable source, claim or decision content identity; guessed IDs confer no access. */
export interface MemoryRef { id: string; revision: number; generation: number }
/** Sourced snapshot; suppression retains original text for owner inspection while deletion removes it. */
export interface MemorySource extends MemoryRef {
  botId: string; conversationId: string; attribution: "owner" | "bot" | "external";
  text: string | null; derived: MemoryRef[]; createdAt: number;
  /** Access revisions used by this source's Bot, including transitive claim dependencies. */
  access?: MemoryPacket["access"];
}
/** Retained assertion with conservative dependencies; a fact records an owner statement rather than objective truth. */
export interface MemoryClaim extends MemoryRef {
  botId: string; conversationId: string; source: MemoryRef; kind: "fact" | "inference";
  text: string; quote: string; dependencies: MemoryRef[]; conflicts: MemoryRef[]; createdAt: number;
  /** Original extractor access revisions; republication cannot revive a revoked derivative. */
  access?: MemoryPacket["access"];
}
/** Revisioned owner publication policy, separate from the immutable claim content revision. */
export interface MemoryAccess { id: string; revision: number; shared: boolean; publishedBy: "owner" | null; changedAt: number }
/** Explicit nontransitive share of one immutable claim to a receiver with a named resource ceiling. */
export interface MemoryShare { id: string; revision: number; claim: MemoryRef; receiverBotId: string; expiresAt: number; active: boolean }
/** Current authenticated owner decision; memory extraction cannot create one. */
export interface MemoryDecision extends MemoryRef { conversationId: string; key: string; text: string; source: MemoryRef; pinned?: boolean }
/** Recorded bounded input with pinned decisions and currentness checks before tools and publication. */
export interface MemoryPacket {
  id: string; botId: string; botRevision: number; botGeneration: number; ownerGeneration: number;
  conversationId: string; workId: string | null; attemptId: string | null; createdAt: number;
  sources: MemoryRef[]; claims: MemoryClaim[]; decisions: MemoryDecision[];
  access: { id: string; revision: number; shareId: string | null; shareRevision: number | null }[];
  omitted: number; bytes: number; state: "current" | "retired";
}
/** Unavailable projections intentionally exclude withdrawn or unauthorized claim payload. */
export type MemoryLookup = { state: "available"; claim: MemoryClaim; access: MemoryAccess } | { state: "unavailable"; reference: MemoryRef; reason: string };
/** Owner-authored fact retained privately in its conversation's Bot scope. */
export type RememberCommand = Envelope<"memory.remember", { conversationId: string; text: string }>;
/** Exact correction replaces the selected assertion and withdraws its dependent lineage. */
export type CorrectMemoryCommand = Envelope<"memory.correct", { claim: MemoryRef; text: string }>;
/** Scoped lifecycle command whose preview is available through the owner query surface. */
export type WithdrawMemoryCommand = Envelope<"memory.forget" | "memory.delete", { claim: MemoryRef }>;
/** Only authenticated owner publication can make a private assertion available to the team. */
export type PublishMemoryCommand = Envelope<"memory.publish" | "memory.revoke", { claim: MemoryRef }>;
/** Exact immutable share; the receiver must also carry this scope in its bounded work grant. */
export type ShareMemoryCommand = Envelope<"memory.share", { claim: MemoryRef; scopeId: string; receiverBotId: string; expiresAt: number }>;
/** Owner decisions are pinned from live rows on every fresh context assembly. */
export type SetMemoryDecisionCommand = Envelope<"memory.decision.set", { conversationId: string; key: string; text: string }>;
/** Unpins an exact current decision without deleting its retained owner source. */
export type UnpinMemoryDecisionCommand = Envelope<"memory.decision.unpin", { decision: MemoryRef }>;
/** app.memory-scope/v2 typed authenticated owner command union. */
export type MemoryCommand = RememberCommand | CorrectMemoryCommand | WithdrawMemoryCommand | PublishMemoryCommand | ShareMemoryCommand | SetMemoryDecisionCommand | UnpinMemoryDecisionCommand;
/** Credential-free mutation receipt; lifecycle commands retain identities rather than withdrawn payload. */
export interface MemoryReceipt { kind: MemoryCommand["kind"]; requestId: string; claim?: MemoryRef; access?: MemoryAccess; share?: MemoryShare; decision?: MemoryRef; withdrawn?: number }
/** Owner-only lifecycle label for a returned claim or source; it carries identities and never withdrawn payload. */
export interface MemoryWithdrawal { kind: "claim" | "source"; id: string; mode: "corrected" | "forgotten" | "deleted"; source: MemoryRef | null }
/** Owner impact preview with no authority and no mutation. */
export interface MemoryImpact { claim: MemoryRef; claims: MemoryRef[]; sources: MemoryRef[]; contexts: string[]; reports: { id: string; workId: string; revision: number }[]; artifacts: string[]; names: { bots: { id: string; name: string }[]; work: { id: string; title: string }[]; omittedBots: number; omittedWork: number }; nativePolicy: "fresh_sessions_retire_on_close" }
