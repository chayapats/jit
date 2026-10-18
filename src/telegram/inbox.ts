import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import type { TelegramPolicy } from "../config";
import { classifyUpdate, requireUpdate } from "./protocol";
import { confirmBindingFromChallenge, readBinding, readPoll } from "./binding";
import type { TelegramEventPage, TelegramInboxEvent, TelegramUpdate } from "./types";

interface InboxRow {
  sequence: number; update_id: number; telegram_user_id: number | null; telegram_chat_id: number | null;
  message_id: number | null; callback_id: string | null; content_kind: TelegramInboxEvent["contentKind"];
  classification: TelegramInboxEvent["classification"]; binding_revision: number; text_content: string | null;
  raw_json: string; status: TelegramInboxEvent["status"]; failure_reason: string | null;
  process_attempts: number; committed_at: number; processed_at: number | null;
}

function project(row: InboxRow): TelegramInboxEvent {
  return {
    sequence: row.sequence, updateId: row.update_id, telegramUserId: row.telegram_user_id,
    telegramChatId: row.telegram_chat_id, messageId: row.message_id, callbackId: row.callback_id,
    contentKind: row.content_kind, classification: row.classification, bindingRevision: row.binding_revision,
    textContent: row.text_content, status: row.status, failureReason: row.failure_reason,
    processAttempts: row.process_attempts, committedAt: row.committed_at, processedAt: row.processed_at,
  };
}

/** Reads a bounded owner-inspection page without mutating project state. */
export function readEvents(tx: AppTransaction, after: number, size: number, classification?: string): TelegramEventPage {
  if (!Number.isSafeInteger(after) || after < 0) throw new AppError("invalid_cursor");
  const rows = classification
    ? tx.all<InboxRow>(`SELECT * FROM telegram_inbox WHERE sequence > ? AND classification = ? ORDER BY sequence LIMIT ?`,
      after, classification, size + 1)
    : tx.all<InboxRow>(`SELECT * FROM telegram_inbox WHERE sequence > ? ORDER BY sequence LIMIT ?`, after, size + 1);
  return {
    items: rows.slice(0, size).map(project),
    hasMore: rows.length > size,
    nextAfter: rows.slice(0, size).at(-1)?.sequence ?? after,
  };
}

function boundedRaw(update: TelegramUpdate, bytes: number): string {
  const raw = JSON.stringify(update);
  if (Buffer.byteLength(raw) > bytes) throw new AppError("telegram_update_too_large");
  return raw;
}

/**
 * Persists classified inbox rows for a getUpdates batch before any offset advance.
 * Duplicate update_id values reuse the existing logical event without mutating project state.
 */
export function persistUpdates(
  tx: AppTransaction,
  updates: unknown[],
  policy: TelegramPolicy,
  now: number,
): { events: TelegramInboxEvent[]; maxUpdateId: number | null } {
  const binding = readBinding(tx);
  const events: TelegramInboxEvent[] = [];
  let maxUpdateId: number | null = null;
  for (const item of updates) {
    const update = requireUpdate(item);
    maxUpdateId = maxUpdateId == null ? update.update_id : Math.max(maxUpdateId, update.update_id);
    const existing = tx.get<InboxRow>("SELECT * FROM telegram_inbox WHERE update_id = ?", update.update_id);
    if (existing) { events.push(project(existing)); continue; }
    const classified = classifyUpdate(update, binding, now);
    const raw = boundedRaw(update, policy.inboxBytes);
    tx.run(`INSERT INTO telegram_inbox (
      update_id, telegram_user_id, telegram_chat_id, message_id, callback_id, content_kind, classification,
      binding_revision, text_content, raw_json, status, failure_reason, process_attempts, committed_at, processed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'persisted', NULL, 0, ?, NULL)`,
    update.update_id, classified.telegramUserId, classified.telegramChatId, classified.messageId, classified.callbackId,
    classified.contentKind, classified.classification, binding.revision, classified.textContent, raw, now);
    if (classified.classification === "challenge_match") {
      const requestId = `tg-challenge-${update.update_id}`;
      confirmBindingFromChallenge(tx, now, requestId);
      tx.run("INSERT INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', 'telegram.confirm', ?, 'telegram', ?)",
        requestId, now);
    }
    const row = tx.get<InboxRow>("SELECT * FROM telegram_inbox WHERE update_id = ?", update.update_id)!;
    events.push(project(row));
  }
  return { events, maxUpdateId };
}

/** Advances the durable getUpdates offset only after inbox rows for those updates exist. */
export function advanceOffset(tx: AppTransaction, maxUpdateId: number, now: number): void {
  if (!Number.isSafeInteger(maxUpdateId) || maxUpdateId < 0) throw new AppError("invalid_telegram_offset");
  const poll = readPoll(tx, 24);
  // Monotonic: duplicate replay of already-acknowledged updates must not move the cursor backward.
  const next = Math.max(poll.nextOffset, maxUpdateId + 1);
  const lastUpdateId = Math.max(poll.lastUpdateId ?? -1, maxUpdateId);
  tx.run(`UPDATE telegram_poll SET next_offset = ?, last_poll_at = ?, last_update_id = ? WHERE id = 1`,
    next, now, lastUpdateId);
}

/** Marks downtime beyond Telegram's retention window as a possible missing-input gap. */
export function noticeRetentionGap(tx: AppTransaction, policy: TelegramPolicy, now: number): boolean {
  const poll = readPoll(tx, policy.retentionHours);
  if (poll.lastPollAt == null) {
    tx.run(`UPDATE telegram_poll SET last_poll_at = ? WHERE id = 1`, now);
    return false;
  }
  const limitMs = policy.retentionHours * 3_600_000;
  if (now - poll.lastPollAt <= limitMs) {
    tx.run(`UPDATE telegram_poll SET last_poll_at = ? WHERE id = 1`, now);
    return false;
  }
  if (poll.gapState !== "possible_missing_inputs") {
    tx.run(`UPDATE telegram_poll SET gap_state = 'possible_missing_inputs', gap_noticed_at = ?, gap_reason = ?, last_poll_at = ? WHERE id = 1`,
      now, "poll_interval_exceeded_telegram_retention", now);
  } else {
    tx.run(`UPDATE telegram_poll SET last_poll_at = ? WHERE id = 1`, now);
  }
  return true;
}

/**
 * Bounded local processing for authorized inbox events.
 * TG01 retains untrusted content; it does not execute project commands.
 */
export function processPersisted(
  tx: AppTransaction,
  policy: TelegramPolicy,
  now: number,
  onAuthorized?: (event: TelegramInboxEvent) => void,
): TelegramInboxEvent[] {
  const rows = tx.all<InboxRow>(
    `SELECT * FROM telegram_inbox WHERE status IN ('persisted', 'failed') AND process_attempts < ? ORDER BY sequence LIMIT 32`,
    policy.processAttempts);
  const out: TelegramInboxEvent[] = [];
  for (const row of rows) {
    const attempts = row.process_attempts + 1;
    tx.run(`UPDATE telegram_inbox SET status = 'processing', process_attempts = ? WHERE sequence = ?`, attempts, row.sequence);
    try {
      const event = project({ ...row, status: "processing", process_attempts: attempts });
      if (event.classification === "authorized") onAuthorized?.(event);
      // Inbound text remains untrusted content until a later application command boundary.
      tx.run(`UPDATE telegram_inbox SET status = 'processed', processed_at = ?, failure_reason = NULL WHERE sequence = ?`,
        now, row.sequence);
      out.push(project(tx.get<InboxRow>("SELECT * FROM telegram_inbox WHERE sequence = ?", row.sequence)!));
    } catch (error) {
      const reason = error instanceof AppError ? error.code : "telegram_process_failed";
      const status = attempts >= policy.processAttempts ? "failed" : "persisted";
      tx.run(`UPDATE telegram_inbox SET status = ?, failure_reason = ?, processed_at = ? WHERE sequence = ?`,
        status, reason, now, row.sequence);
      out.push(project(tx.get<InboxRow>("SELECT * FROM telegram_inbox WHERE sequence = ?", row.sequence)!));
    }
  }
  return out;
}

/** Counts owner-visible inspection buckets without projecting raw secrets. */
export function inboxCounts(tx: AppTransaction): { unauthorizedCount: number; failedCount: number; pendingAuthorizedCount: number } {
  const unauthorized = tx.get<{ n: number }>(
    `SELECT count(*) AS n FROM telegram_inbox WHERE classification IN (
      'unauthorized_sender','unauthorized_chat','group_rejected','forward_rejected','bot_origin_rejected','stale_binding','challenge_mismatch'
    )`)!.n;
  const failed = tx.get<{ n: number }>(`SELECT count(*) AS n FROM telegram_inbox WHERE status = 'failed'`)!.n;
  const pending = tx.get<{ n: number }>(
    `SELECT count(*) AS n FROM telegram_inbox WHERE classification = 'authorized' AND status IN ('persisted','failed')`)!.n;
  return { unauthorizedCount: unauthorized, failedCount: failed, pendingAuthorizedCount: pending };
}
