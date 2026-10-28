import { AppError } from "../errors";
import type { TelegramBinding } from "./types";
import type { TelegramCallbackQuery, TelegramInboxEvent, TelegramMessage, TelegramUpdate } from "./types";

const numericId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value !== 0;

/** Rejects non-Update payloads before any persistence or offset advance. */
export function requireUpdate(value: unknown): TelegramUpdate {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new AppError("invalid_telegram_update");
  const update = value as TelegramUpdate;
  if (!numericId(update.update_id) || update.update_id < 0) throw new AppError("invalid_telegram_update");
  return update;
}

function isForwarded(message: TelegramMessage): boolean {
  return message.forward_origin != null || message.forward_from != null ||
    message.forward_date != null || message.forward_sender_name != null;
}

function classifyMessage(
  message: TelegramMessage,
  binding: TelegramBinding,
  now: number,
): Pick<TelegramInboxEvent, "telegramUserId" | "telegramChatId" | "messageId" | "callbackId" | "contentKind" | "classification" | "textContent"> {
  const userId = message.from?.id ?? null;
  const chatId = message.chat?.id ?? null;
  const text = typeof message.text === "string" ? message.text.slice(0, 4096) : null;
  const base = {
    telegramUserId: userId, telegramChatId: chatId, messageId: message.message_id ?? null,
    callbackId: null as string | null, contentKind: "message" as const, textContent: text,
  };
  if (!message.chat || message.chat.type !== "private") return { ...base, classification: "group_rejected" };
  if (message.from?.is_bot === true) return { ...base, classification: "bot_origin_rejected" };
  if (isForwarded(message)) return { ...base, classification: "forward_rejected" };
  if (!numericId(userId) || !numericId(chatId)) return { ...base, classification: "unauthorized_sender" };

  if (binding.state === "pending" && binding.challengeNonce && binding.challengeExpiresAt &&
      binding.telegramUserId === userId && binding.telegramChatId === chatId) {
    if (now > binding.challengeExpiresAt) return { ...base, classification: "challenge_mismatch" };
    if (text === binding.challengeNonce || text === `/start ${binding.challengeNonce}`) {
      return { ...base, classification: "challenge_match" };
    }
    return { ...base, classification: "challenge_mismatch" };
  }

  if (binding.state !== "bound" || binding.telegramUserId == null || binding.telegramChatId == null) {
    return { ...base, classification: "unauthorized_sender" };
  }
  if (userId !== binding.telegramUserId) return { ...base, classification: "unauthorized_sender" };
  if (chatId !== binding.telegramChatId) return { ...base, classification: "unauthorized_chat" };
  return { ...base, classification: "authorized" };
}

function classifyCallback(
  query: TelegramCallbackQuery,
  binding: TelegramBinding,
): Pick<TelegramInboxEvent, "telegramUserId" | "telegramChatId" | "messageId" | "callbackId" | "contentKind" | "classification" | "textContent"> {
  const userId = query.from?.id ?? null;
  const chat = query.message?.chat;
  const chatId = chat?.id ?? null;
  const base = {
    telegramUserId: userId, telegramChatId: chatId, messageId: query.message?.message_id ?? null,
    callbackId: typeof query.id === "string" ? query.id.slice(0, 200) : null,
    contentKind: "callback_query" as const,
    textContent: typeof query.data === "string" ? query.data.slice(0, 4096) : null,
  };
  if (query.from?.is_bot === true) return { ...base, classification: "bot_origin_rejected" };
  if (chat && chat.type !== "private") return { ...base, classification: "group_rejected" };
  if (query.message && isForwarded(query.message)) return { ...base, classification: "forward_rejected" };
  if (binding.state !== "bound" || binding.telegramUserId == null || binding.telegramChatId == null) {
    return { ...base, classification: "stale_binding" };
  }
  if (!numericId(userId) || userId !== binding.telegramUserId) return { ...base, classification: "unauthorized_sender" };
  if (!numericId(chatId) || chatId !== binding.telegramChatId) return { ...base, classification: "unauthorized_chat" };
  return { ...base, classification: "authorized" };
}

/** Classifies one Update against the current revisioned binding without granting command authority. */
export function classifyUpdate(update: TelegramUpdate, binding: TelegramBinding, now: number) {
  const message = update.message ?? update.edited_message;
  if (message) return classifyMessage(message, binding, now);
  if (update.callback_query) return classifyCallback(update.callback_query, binding);
  return {
    telegramUserId: null, telegramChatId: null, messageId: null, callbackId: null,
    contentKind: "other" as const, classification: "ignored" as const, textContent: null,
  };
}
