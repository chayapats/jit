import type { MemoryPacket } from "./memory-types";
import type { OwnerCommand } from "./owner-commands";

/** Non-secret exact owner-configured model selection; readiness is never inferred from configuration. */
export interface Route { id: string; provider: "codex" | "grok"; model: string }
/** Explicit Bot ceiling; opaque resource identities never name host paths or website profiles. */
export interface Capabilities { tools: string[]; resources: string[] }
/** Persistent participant with no inherited accounts, computer, profile or execution authority. */
export interface Bot { id: string; revision: number; generation: number; enabled: boolean; name: string; responsibility: string; routeId: string; capabilities: Capabilities; computerId: null; profileId: null }
/** Durable conversational scope whose membership confers no execution authority. */
export interface Conversation { id: string; revision: number; botId: string }
/** One immutable conversational message; untrusted text never renders authority controls. */
export interface Message { id: string; conversationId: string; role: "owner" | "bot"; text: string; createdAt: number; /** Owner projection only; retained text is excluded from future model context. */ contextState?: "withdrawn" }
/** Revisioned service-validated suggestion anchored to an actual Bot reply, with no granted capabilities. */
export interface BotProposal { id: string; conversationId: string; messageId: string; revision: number; author: "bot" | "owner"; proposerBotId: string; state: "proposed" | "accepted" | "rejected"; name: string; responsibility: string; routeId: string | null; dropped: string[]; botId: string | null }
/** Bounded chat outbox entry; interrupted inference is visible and never automatically replayed. */
export interface Reply { id: string; conversationId: string; messageId: string; state: "queued" | "running" | "succeeded" | "blocked"; reason: string | null; snapshot: ChatInput }
/** Immutable, credential-free chat input; this port cannot issue commands or access tools. */
export interface ChatInput { route: Route; language: "th" | "en"; ownerName: string; bot: Bot; messages: Message[]; memory?: MemoryPacket }
/** Untrusted model response; suggestions are data until exact owner acceptance. */
export interface ChatOutput { text: string; proposal?: unknown; task?: unknown; memory?: unknown }
/** One bounded inference adapter; production uses only schway/host and deterministic tests inject scripts. */
export interface ChatPort { reply(input: ChatInput, signal: AbortSignal): Promise<ChatOutput> }
/** Opaque server-issued owner principal; a structural copy is rejected. */
export interface OwnerActor { readonly ownerId: "owner" }
/** Revision and retry envelope shared by every typed authenticated owner command. */
export interface Envelope<K extends string, P> { kind: K; requestId: string; expectedRevision: number; payload: P }
/** Project-free owner setup; the local provisioning credential must already authenticate this command. */
export type SetupCommand = Envelope<"setup", { ownerName: string; language: "th" | "en"; routeId: string; capabilities: Capabilities }>;
/** Conversational intake only; text, @mentions and classifier output cannot start work. */
export type MessageCommand = Envelope<"message.post", { conversationId: string; text: string }>;
/** Exact proposal acceptance grants only the capabilities explicitly selected by the authenticated owner. */
export type AcceptBotCommand = Envelope<"bot.proposal.accept", { proposalId: string; capabilities: Capabilities }>;
/** Exact proposal rejection has no execution side effect. */
export type RejectBotCommand = Envelope<"bot.proposal.reject", { proposalId: string }>;
/** Owner edits append a proposal revision without changing or creating a permanent Bot. */
export type ReviseBotCommand = Envelope<"bot.proposal.revise", { proposalId: string; name: string; responsibility: string; routeId: string }>;
/** app.bots/v1 and app.conversations/v2 authenticated command union. */
export type BotCommand = SetupCommand | MessageCommand | AcceptBotCommand | RejectBotCommand | ReviseBotCommand | OwnerCommand;
/** Atomic command result; duplicate retry keys return the original committed snapshot. */
export interface BotReceipt { requestId: string; kind: BotCommand["kind"]; bot?: Bot; conversation?: Conversation; message?: Message; reply?: Reply; proposal?: BotProposal; preferences?: { revision: number; language: "th" | "en"; theme: "system" | "light" | "dark" } }
/** Owner query projection backing setup, chat, proposals and team, with exact mutation revisions. */
export interface Home { revision: number; owner: { name: string; language: "th" | "en"; theme?: "system" | "light" | "dark" } | null; routes: Route[]; bots: Bot[]; conversations: Conversation[]; proposals: BotProposal[]; replies: Reply[] }
/** Immutable configured policy ceilings; configuration alone proves no live provider or host support. */
export interface Policy { routes: Route[]; tools: string[]; resources: string[] }
