import type { Bot, Capabilities, Envelope } from "./types";
import type { MemoryImpact } from "./memory-types";

/** Exact owner-authored policy proposal; neither creation nor model output widens a permanent Bot. */
export interface CapabilityProposal {
  id: string;
  revision: number;
  botId: string;
  botRevision: number;
  botGeneration: number;
  ownerGeneration: number;
  action: "capabilities" | "reenable";
  capabilities: Capabilities;
  hash: string;
  state: "proposed" | "accepted" | "superseded" | "discarded";
}
/** Durable Bot transition; disabling authority precedes actual transport/computer/native settlement. */
export interface BotLifecycle {
  botId: string;
  generation: number;
  state: "active" | "stopping" | "retired" | "deleting" | "deleted";
  target: "active" | "retired" | "deleted";
  stage: "fenced" | "data" | "computer" | "native" | "complete";
  reason: string | null;
}
/** Owner-readable exact identity impact; it grants no authority and contains no source/native payload. */
export interface BotLifecyclePreview {
  bot: Bot;
  lifecycle: BotLifecycle;
  action: "retire" | "delete";
  retain: { history: boolean; evidence: boolean };
  data: Omit<MemoryImpact, "claim">;
  conversations: { id: string; revision: number }[];
  work: { id: string; revision: number }[];
  shares: { id: string; revision: number; kind: "memory" | "snapshot" }[];
  computer: { id: string; revision: number; generation: number; workspaceId: string; profileId: string } | null;
  native: { id: string; state: string; mode: string; cleanup: "retire" | "delete" }[];
  routines: { id: string; revision: number; generation: number; state: string }[];
  withdrawals: { kind: string; id: string; mode: string }[];
  personal: { reads: string[]; drafts: { id: string; revision: number; hash: string }[] };
  retainedEffects: { id: string; revision: number; actionHash: string; state: string }[];
  retainedLineage: "identity_hashes_and_independent_originals";
  disclosedKnowledge: "cannot_recall";
  hash: string;
}
/** Exact owner proposal creation is a draft, with no policy mutation or account grant. */
export type ProposeCapabilitiesCommand = Envelope<"bot.capabilities.propose" | "bot.reenable.propose", { botId: string; capabilities: Capabilities }>;
/** Exact current proposal acceptance changes only the named Bot ceiling and fences old authority. */
export type AcceptCapabilitiesCommand = Envelope<"bot.capabilities.accept" | "bot.capabilities.discard", { proposalId: string; proposalHash: string }>;
/** Retirement explicitly retains local history/evidence while disabling work and routine dispatch. */
export type RetireBotCommand = Envelope<"bot.retire", { botId: string; previewHash: string; retain: { history: true; evidence: true } }>;
/** Destructive Bot-data withdrawal requires the exact current lifecycle preview; computer reset stays separate. */
export type DeleteBotCommand = Envelope<"bot.delete", { botId: string; previewHash: string }>;
/** app.bot-lifecycle/v1 owner command union extends app.bots/v1. */
export type BotLifecycleCommand = ProposeCapabilitiesCommand | AcceptCapabilitiesCommand | RetireBotCommand | DeleteBotCommand;
/** Logical owner receipt describes committed transition intent rather than settled cleanup. */
export interface BotLifecycleReceipt { kind: BotLifecycleCommand["kind"]; requestId: string; bot?: Bot; proposal?: CapabilityProposal; lifecycle?: BotLifecycle }
/** Trusted fault-injection seam observes already committed cleanup stages and never enters HTTP or model input. */
export interface BotLifecycleOptions { afterStage?: (stage: BotLifecycle["stage"], botId: string) => void }
