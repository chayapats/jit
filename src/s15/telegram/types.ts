import type { ConnectionVault } from '../../exec/connections';
import type { Locale } from '../../i18n';
import type { ConversationCommand, ConversationReceipt, ConversationStore } from '../conversation';
import type { ActionRef, ActionSlip, OwnerActor } from '../policy';
import type { ResponsibilityProjection, ResumeBindingPort, ResumeOwnerSnapshot } from '../work';
import type { S15TelegramStatus } from '../web/types';

/**
 * Telegram Bot API calls the S15 channel uses. A transport is created per bot token by protected composition;
 * CI and tests use a scripted transport and never call the real API. Errors are {@link TelegramTransportError}.
 */
export interface TelegramTransport {
  getMe(signal?: AbortSignal): Promise<{ id: number; is_bot: boolean; username?: string }>;
  /** Long poll. `timeout` is Telegram's server-side wait in seconds; 0 returns immediately. */
  getUpdates(input: { offset: number; timeout: number; allowedUpdates: readonly string[] }, signal?: AbortSignal): Promise<unknown[]>;
  /** Plain text only: no parse mode, so no model or owner text is ever interpreted as formatting or a hidden link. */
  sendMessage(input: { chatId: number; text: string; replyTo: number | null }, signal?: AbortSignal): Promise<{ message_id: number }>;
}

/**
 * A failed Bot API call. `not_sent` is a definite refusal (Telegram answered `ok:false`), so the same outbox
 * part may be sent again later; `unknown` means the message may have been delivered and is never resent.
 */
export class TelegramTransportError extends Error {
  constructor(readonly code: string, readonly outcome: 'not_sent' | 'unknown', readonly retryAfterSeconds: number | null = null) { super(code); this.name = 'TelegramTransportError'; }
}

/** Finite channel limits. Defaults follow Telegram's documented 24-hour update retention and 4096-character messages. */
export interface TelegramLimits {
  /** One-time binding code lifetime. */
  codeTtlMs: number;
  /** Wrong codes accepted while a binding waits before the code is withdrawn. */
  codeAttempts: number;
  /** Telegram keeps undelivered updates for at most this long. */
  retentionMs: number;
  /** A request still running this long gets one short progress notice. */
  progressAfterMs: number;
  /** Minimum spacing between two sends to the bound chat. */
  sendSpacingMs: number;
  /** Long-poll wait in seconds for the background loop. */
  pollTimeoutSeconds: number;
  /** Retry backoff bounds for the background loop. */
  backoffMs: { min: number; max: number };
  /** Notices are derived only for owner work newer than this window. */
  horizonMs: number;
}

/** Durable binding row. Usernames are display-only; only the numeric user and private chat IDs carry identity. */
export type TelegramBinding =
  | { state: 'unbound'; revision: number }
  | { state: 'pending'; revision: number; code: string; expiresAt: number; failures: number; owner: ResumeOwnerSnapshot }
  | { state: 'bound'; revision: number; userId: number; chatId: number; username: string | null; boundAt: number; owner: ResumeOwnerSnapshot };

/** `s15-telegram-state/v1`: bot identity, binding and the durable long-poll cursor. Never the token. */
export interface TelegramState {
  contract: 's15-telegram-state/v1';
  bot: { id: number; username: string } | null;
  binding: TelegramBinding;
  poll: { offset: number; lastPollAt: number | null; code: string | null; failures: number; gap: { since: number; noticedAt: number } | null };
  send: { notBefore: number };
}

/**
 * Protected composition inputs. `principal` verifies the authenticated Web owner for settings commands;
 * `owner` re-establishes the bound owner's authority (process-local, re-verified on every POLICY call) and
 * returns null once the binding or owner generation is no longer current.
 */
export interface TelegramChannelOptions {
  installationId: string; origin: string;
  store: ConversationStore;
  vault: ConnectionVault;
  transport(token: string): TelegramTransport;
  conversation: {
    submit(actor: OwnerActor, command: ConversationCommand): ConversationReceipt;
    publish(actor: OwnerActor, requestId: string, consume: (text: string) => void): void;
    slips(actor: OwnerActor, actions: readonly ActionRef[]): ActionSlip[];
  };
  resumes: ResumeBindingPort<OwnerActor>;
  work: { list(actor: OwnerActor): ResponsibilityProjection[]; project(actor: OwnerActor, id: string): ResponsibilityProjection };
  principal(actor: OwnerActor): ResumeOwnerSnapshot;
  owner(binding: { ownerId: string; generation: number; current(): boolean }): OwnerActor | null;
  locale?(actor: OwnerActor): Locale | null;
  clock: { now(): number; sleep(ms: number, signal?: AbortSignal): Promise<void> };
  limits?: Partial<TelegramLimits>;
  /** Commit-fault seam between inbox persistence and offset advance; production leaves it absent. */
  beforeOffsetAdvance?: () => void;
}

/** CHAN15-01 channel: owner settings commands, durable ingestion, notice derivation and the at-most-once outbox. */
export interface TelegramChannel {
  status(actor: OwnerActor): S15TelegramStatus;
  setToken(actor: OwnerActor, requestId: string, token: string): Promise<void>;
  removeToken(actor: OwnerActor, requestId: string): void;
  startBinding(actor: OwnerActor, requestId: string): void;
  cancelBinding(actor: OwnerActor, requestId: string): void;
  revoke(actor: OwnerActor, requestId: string): void;
  acknowledgeGap(actor: OwnerActor, requestId: string): void;
  /** One getUpdates call: inbox rows commit first, then the offset advances in a separate commit. */
  pollOnce(timeoutSeconds?: number, signal?: AbortSignal): Promise<{ received: number }>;
  /** Submits persisted authorized messages exactly once through the same conversation port as the Web composer. */
  process(): number;
  /** Derives replies, progress, stall reports and held-action notices for the bound chat. Idempotent. */
  observe(): number;
  /** Sends due outbox parts; an interrupted send becomes `unknown` and is never repeated automatically. */
  deliver(signal?: AbortSignal): Promise<number>;
  /** Background poll and send loops with finite backoff; `wake` runs the protected service drain. */
  start(wake: () => Promise<void>): void;
  close(): Promise<void>;
}
