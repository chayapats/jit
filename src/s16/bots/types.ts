import type { Ref, Selection } from "../../s15/policy";

/**
 * BOT16-01 (`s16-bots/v1`, ADR 0088) persistent Bot contracts. Every field is data: a profile, proposal or export
 * never grants execution, account, recipient or approval authority. Authority stays with POLICY (the standing
 * policy's Bot list and rules), TEAM (resource scope) and the owner's own commands.
 */

/** Owner-visible bounds. A Bot's name and responsibility are owner-confirmed text. */
export const botLimits = Object.freeze({ nameChars: 60, responsibilityChars: 2000, bots: 32, proposals: 64, exportBytes: 16384, excluded: 32 });

/** Where a profile came from. `main` is the installation's main Bot; `configured` is a Bot named by the installed policy. */
export type BotOrigin = "main" | "configured" | "created";
/** Provenance of a created Bot or a proposal; it is never authority. */
export type BotSource =
  | { kind: "owner" }
  | { kind: "chat"; conversationId: string; requestId: string }
  | { kind: "duplicate"; botId: string }
  | { kind: "import" };

/** The exact configuration the owner reviews. `selection: null` uses the installation's default route. */
export interface BotDraft {
  contract: "s16-bot-draft/v1";
  name: string; responsibility: string;
  selection: Selection | null;
  /** Team resources this Bot may not use; everything else follows the team defaults. */
  excluded: string[];
  /** Accepts bounded assignments from other Bots (DELEG16-01). */
  assignments: boolean;
}

/** One stored Bot profile. `ref` is the POLICY catalog identity for Bots this directory owns; restore bumps its generation. */
export interface BotRecord {
  contract: "s16-bot/v1";
  id: string; revision: number; origin: BotOrigin;
  ref: Ref | null;
  name: string; responsibility: string; selection: Selection | null; excluded: string[]; assignments: boolean;
  state: "active" | "archived";
  source: BotSource;
  createdAt: number; updatedAt: number; archivedAt: number | null;
  /** Present while the archive command with this request ID has not finished stopping work and pausing routines. */
  cleanup?: string;
}

/** An approved route choice shown to the owner. */
export interface BotSelectionChoice { selection: Selection; label: string }
/** A team resource shown on a proposal: the new Bot uses it unless it is excluded. */
export interface BotResourceChoice { id: string; label: string; kind: string }

/**
 * `s16-bot-proposal/v1`: one exact pending proposal. `proposalHash` binds the draft, the standing-policy revision
 * and the listed team defaults; any change makes a new proposal that needs its own acceptance.
 */
export interface BotProposal {
  contract: "s16-bot-proposal/v1";
  id: string; draft: BotDraft; source: BotSource;
  policyRevision: number;
  resources: BotResourceChoice[];
  /** Import only: names or references this installation does not have; they were left out of the draft. */
  missing: string[];
  proposalHash: string;
  state: "pending" | "accepted" | "dismissed";
  createdAt: number;
  /** The created Bot once accepted. */
  botId: string | null;
}

/** Owner projection of one Bot. Labels come from the owner's own text; `main` is the installation's main Bot. */
export interface BotView {
  id: string; revision: number; origin: BotOrigin; main: boolean;
  name: string; responsibility: string;
  selection: Selection | null; selectionLabel: string | null;
  /** True when the chosen route is no longer approved and new work uses the installation default. */
  selectionUnavailable: boolean;
  excluded: string[]; assignments: boolean;
  state: "active" | "archived";
  createdAt: number; archivedAt: number | null;
}

/** `s16-client-bots/v1` bounded owner page. Reading it starts, stops or changes nothing. */
export interface BotsView {
  contract: "s16-client-bots/v1";
  bots: BotView[]; proposals: BotProposal[];
  selections: BotSelectionChoice[]; resources: BotResourceChoice[];
  /** Null when Bots can be created; otherwise why not (for example `policy_required`). */
  creation: { available: true } | { available: false; code: string };
}
/** Read-only impact of archiving: what stops now and which routines pause. */
export interface BotImpact { running: { requestId: string; conversationId: string }[]; routines: { id: string; name: string }[] }
/** One Bot with its recent conversations (newest first) and the archive impact. */
export interface BotDetail {
  contract: "s16-client-bot/v1";
  bot: BotView;
  conversations: { conversationId: string; firstMessage: string; latestAt: number; assignment: boolean }[];
  impact: BotImpact;
}

/** `s16-bot-export/v1`: credential-free configuration only; no history, memory, files, computer or account data. */
export interface BotExport {
  contract: "s16-bot-export/v1";
  name: string; responsibility: string;
  model: { provider: string; modelId: string; effort: string } | null;
  excluded: { id: string; label: string }[];
  assignments: boolean;
  exportedAt: number;
}

/** Exact owner commands. Each names its revision or proposal hash; a repeated request ID returns its first result. */
export type BotCommand =
  | { contract: "s16-bot-command/v1"; requestId: string; kind: "bot.accept"; proposalId: string; proposalHash: string }
  | { contract: "s16-bot-command/v1"; requestId: string; kind: "bot.dismiss"; proposalId: string }
  | { contract: "s16-bot-command/v1"; requestId: string; kind: "bot.update"; botId: string; expectedRevision: number; name: string; responsibility: string; selection: Selection | null; assignments: boolean; /** CONN16-01: the exact team resources (connections included) this Bot may not use; absent keeps them. */ excluded?: string[] }
  | { contract: "s16-bot-command/v1"; requestId: string; kind: "bot.archive" | "bot.restore"; botId: string; expectedRevision: number }
  | { contract: "s16-bot-command/v1"; requestId: string; kind: "conversation.bind"; conversationId: string; botId: string };
/** Command result: the affected Bot and proposal, and for an archive what was stopped and paused. */
export interface BotReceipt {
  contract: "s16-bot-receipt/v1"; requestId: string; kind: BotCommand["kind"];
  bot: BotView | null; proposal: BotProposal | null;
  stopped: number; paused: number;
}

/** Bot-to-Bot assignment kinds (DELEG16-01). A temporary worker runs as the assigning Bot and is never persisted. */
export type DelegationKind = "peer" | "temporary";
/** Finite delegation bounds of one originating request. Slices are charged to the parent before the child starts. */
export const delegationLimits = Object.freeze({ perRequest: 6, concurrent: 3, perCall: 3, taskChars: 4000, installationConcurrent: 3 });
