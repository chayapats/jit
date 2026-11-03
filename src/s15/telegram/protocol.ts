import { createHash, randomInt, timingSafeEqual } from 'node:crypto';
import { containsCredential } from '../../security/credentials';
import { containsRegisteredSecret } from '../../security/secret-fingerprints';
import type { TelegramBinding } from './types';

/** Bot API token shape (`<bot id>:<secret>`). Checked before any network call; never echoed. */
export const tokenPattern = /^\d{5,16}:[A-Za-z0-9_-]{30,64}$/;
/** Telegram's per-message text limit, counted here in UTF-16 code units, which is never more than Telegram's count. */
export const messageLimit = 4096;
export const allowedUpdates = Object.freeze(['message', 'edited_message', 'callback_query']);
const alphabet = 'ABCDEFGHJKMNPQRSTVWXYZ23456789';

const numeric = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value !== 0;
const digest = (...parts: (string | number)[]) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');

/** Fresh one-time binding code: 12 characters from an unambiguous alphabet (about 59 bits). */
export function bindingCode(): string { return Array.from({ length: 12 }, () => alphabet[randomInt(alphabet.length)]).join(''); }
/** `ABCD-EFGH-JKMN` for display; the owner may type it with or without separators. */
export const displayCode = (code: string) => code.replace(/(.{4})(?=.)/g, '$1-');
/** Strips `/start`, spaces and dashes and upper-cases; returns null when the text is not shaped like a code. */
export function codeCandidate(text: string): string | null {
  const value = text.trim().replace(/^\/start(?:@[A-Za-z0-9_]{1,64})?\s*/i, '').replace(/[\s-]/g, '').toUpperCase();
  return /^[A-Z0-9]{12}$/.test(value) ? value : null;
}
/** Constant-time comparison of a candidate with the pending code. */
export function codeMatches(candidate: string, code: string): boolean {
  const a = Buffer.from(candidate), b = Buffer.from(code);
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Stable conversation request ID for one update of one bot: a crash/replay submits at most once. */
export const requestIdFor = (botId: number, updateId: number) => 'tg' + digest('s15.telegram.request.v1', botId, updateId).slice(0, 40);
/** Stable conversation for the bound private chat. */
export const conversationIdFor = (chatId: number) => 'tg' + digest('s15.telegram.conversation.v1', chatId).slice(0, 32);
/** Credential-shaped text: a registered connection secret fingerprint or a known credential pattern. */
export const credentialShaped = (text: string) => containsRegisteredSecret(text) || containsCredential(text);

/** What one update is, after classification against the current binding. Nothing here is authority by itself. */
export interface ClassifiedUpdate {
  updateId: number;
  kind: 'text' | 'unsupported' | 'credential' | 'edit' | 'callback' | 'other';
  classification: 'authorized' | 'binding_code' | 'unauthorized_sender' | 'unauthorized_chat' | 'group_rejected' | 'forward_rejected' | 'bot_origin_rejected' | 'stale_code' | 'ignored';
  userId: number | null; chatId: number | null; messageId: number | null; replyTo: number | null;
  /** Owner text for an authorized or code message; null for refused, media and credential-shaped updates. */
  text: string | null;
  /** Display-only hint for the binding page. */
  username: string | null;
}

type Message = Record<string, unknown> & { message_id?: unknown; from?: { id?: unknown; is_bot?: unknown; username?: unknown }; chat?: { id?: unknown; type?: unknown }; text?: unknown; reply_to_message?: { message_id?: unknown } };
const forwarded = (m: Message) => m.forward_origin != null || m.forward_from != null || m.forward_from_chat != null || m.forward_date != null || m.forward_sender_name != null || m.is_automatic_forward === true || m.via_bot != null;
const media = ['photo', 'document', 'voice', 'video', 'audio', 'sticker', 'animation', 'video_note', 'contact', 'location', 'venue', 'poll', 'dice', 'story', 'paid_media', 'game', 'invoice'];

/** Returns the numeric update ID, or null for a payload that is not a Telegram Update. */
export function updateId(value: unknown): number | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const id = (value as { update_id?: unknown }).update_id;
  return typeof id === 'number' && Number.isSafeInteger(id) && id >= 0 ? id : null;
}

/**
 * Classifies one update against the current binding (ADR 0013 rules on the S15 store): only a private, human,
 * non-forwarded message whose numeric sender and chat equal the bound IDs is authorized. Quotes, replies and
 * entities add nothing; a code binds only while pending and only from a private human chat.
 */
export function classify(value: unknown, binding: TelegramBinding, now: number): ClassifiedUpdate {
  const id = updateId(value)!, update = value as { message?: Message; edited_message?: Message; callback_query?: unknown };
  const base: ClassifiedUpdate = { updateId: id, kind: 'other', classification: 'ignored', userId: null, chatId: null, messageId: null, replyTo: null, text: null, username: null };
  if (update.callback_query) return { ...base, kind: 'callback' };
  const message = update.message ?? update.edited_message;
  if (!message || typeof message !== 'object') return base;
  const userId = numeric(message.from?.id) ? message.from!.id as number : null, chatId = numeric(message.chat?.id) ? message.chat!.id as number : null;
  const raw = typeof message.text === 'string' ? message.text : null;
  const kind: ClassifiedUpdate['kind'] = update.edited_message && !update.message ? 'edit' : raw === null || media.some(name => message[name] != null) ? 'unsupported' : 'text';
  const seen = { ...base, kind, userId, chatId, messageId: numeric(message.message_id) ? message.message_id as number : null, replyTo: numeric(message.reply_to_message?.message_id) ? message.reply_to_message!.message_id as number : null,
    username: typeof message.from?.username === 'string' && /^[A-Za-z0-9_]{1,64}$/.test(message.from.username) ? message.from.username : null };
  const refuse = (classification: ClassifiedUpdate['classification']) => ({ ...seen, classification, text: null });
  if (message.chat?.type !== 'private' || chatId === null) return refuse('group_rejected');
  if (!message.from || message.from.is_bot === true || userId === null) return refuse('bot_origin_rejected');
  if (message.sender_chat != null || userId !== chatId) return refuse('unauthorized_chat');
  if (forwarded(message)) return refuse('forward_rejected');
  const candidate = kind === 'text' && raw !== null ? codeCandidate(raw) : null;
  if (binding.state === 'pending' && candidate !== null) return codeMatches(candidate, binding.code) && now <= binding.expiresAt ? { ...seen, classification: 'binding_code', text: null } : refuse('stale_code');
  if (binding.state !== 'bound') return refuse(candidate !== null ? 'stale_code' : 'unauthorized_sender');
  if (userId !== binding.userId) return refuse('unauthorized_sender');
  if (chatId !== binding.chatId) return refuse('unauthorized_chat');
  if (kind === 'text' && raw !== null && credentialShaped(raw)) return { ...seen, kind: 'credential', classification: 'authorized', text: null };
  return { ...seen, classification: 'authorized', text: kind === 'text' ? raw!.slice(0, 16384) : null };
}

/**
 * Splits plain text into parts within Telegram's limit, preferring line breaks and never cutting a surrogate
 * pair. Each part is sent at most once under its own stable outbox ID.
 */
export function splitText(text: string, limit = messageLimit): string[] {
  const parts: string[] = [];
  let rest = text.trim() || '…';
  while (rest.length > limit) {
    let cut = rest.lastIndexOf('\n', limit);
    if (cut < limit / 2) cut = rest.lastIndexOf(' ', limit);
    if (cut < limit / 2) cut = limit;
    const code = rest.charCodeAt(cut - 1);
    if (code >= 0xd800 && code <= 0xdbff) cut--;
    parts.push(rest.slice(0, cut).trimEnd()); rest = rest.slice(cut).trimStart();
  }
  parts.push(rest);
  return parts.filter(Boolean);
}
