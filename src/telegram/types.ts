/** Owner-facing Telegram binding commands share the application receipt namespace. */
export type TelegramBindingCommand =
  | { kind: "telegram.bind"; requestId: string; expectedRevision: number; payload: {
      telegramUserId: number; telegramChatId: number; usernameHint?: string | null;
    } }
  | { kind: "telegram.confirm"; requestId: string; expectedRevision: number; payload: {
      telegramUserId: number; telegramChatId: number; challengeNonce: string;
    } }
  | { kind: "telegram.revoke"; requestId: string; expectedRevision: number; payload: Record<string, never> }
  | { kind: "telegram.ack_gap"; requestId: string; expectedRevision: number; payload: Record<string, never> };

/** Stable numeric owner binding; usernames are display hints only. */
export interface TelegramBinding {
  revision: number;
  state: "unbound" | "pending" | "bound";
  telegramUserId: number | null;
  telegramChatId: number | null;
  usernameHint: string | null;
  challengeNonce: string | null;
  challengeExpiresAt: number | null;
  boundAt: number | null;
  proof: TelegramBindingProof;
}

/** Revisioned confirmation that the Web owner explicitly accepted numeric IDs. */
export interface TelegramBindingProof {
  confirmedBy: "owner_web" | "challenge_match" | null;
  confirmedAt: number | null;
  requestId: string | null;
}

/** Durable long-poll cursor and possible input-gap visibility. */
export interface TelegramPollStatus {
  nextOffset: number;
  lastPollAt: number | null;
  lastUpdateId: number | null;
  gapState: "none" | "possible_missing_inputs";
  gapNoticedAt: number | null;
  gapReason: string | null;
  retentionHours: number;
}

/** One logical inbox event retained before Telegram offset acknowledgment. */
export interface TelegramInboxEvent {
  sequence: number;
  updateId: number;
  telegramUserId: number | null;
  telegramChatId: number | null;
  messageId: number | null;
  callbackId: string | null;
  contentKind: "message" | "callback_query" | "other";
  classification:
    | "authorized"
    | "unauthorized_sender"
    | "unauthorized_chat"
    | "group_rejected"
    | "forward_rejected"
    | "bot_origin_rejected"
    | "stale_binding"
    | "challenge_match"
    | "challenge_mismatch"
    | "ignored";
  bindingRevision: number;
  textContent: string | null;
  status: "persisted" | "processing" | "processed" | "failed";
  failureReason: string | null;
  processAttempts: number;
  committedAt: number;
  processedAt: number | null;
}

/** Receipt returned only after binding mutation, receipt and audit commit together. */
export interface TelegramBindingReceipt {
  binding: TelegramBinding;
  poll: TelegramPollStatus;
}

/** Owner-facing status projection suitable for a future Web surface. */
export interface TelegramStatus {
  binding: TelegramBinding;
  poll: TelegramPollStatus;
  unauthorizedCount: number;
  failedCount: number;
  pendingAuthorizedCount: number;
  botCredentialConfigured: boolean;
  nextAction: string;
}

/** Bounded page of inbox events for owner inspection. */
export interface TelegramEventPage {
  items: TelegramInboxEvent[];
  hasMore: boolean;
  nextAfter: number;
}

/** Scripted Bot API getUpdates transport; live network clients are out of TG01 scope. */
export interface TelegramUpdateTransport {
  getUpdates(offset: number): Promise<TelegramUpdate[]>;
}

/** Minimal Update fields required for durable classification; extras are ignored. */
export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

export interface TelegramUser {
  id: number;
  is_bot?: boolean;
  username?: string;
}

export interface TelegramChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel" | string;
}

export interface TelegramMessage {
  message_id: number;
  date?: number;
  text?: string;
  from?: TelegramUser;
  chat: TelegramChat;
  forward_origin?: unknown;
  forward_from?: unknown;
  forward_date?: number;
  forward_sender_name?: string;
}

export interface TelegramCallbackQuery {
  id: string;
  from: TelegramUser;
  chat_instance?: string;
  data?: string;
  message?: TelegramMessage;
}
