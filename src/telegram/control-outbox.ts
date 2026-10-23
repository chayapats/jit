import { AppError } from "../errors";
import type { DeliverySender, DeliverySendResult } from "../delivery/sender";
import { TransactionStore } from "../store";
import { requireText } from "../sources";
import { readBinding } from "./binding";
import { ensureTelegramProjectSchema } from "./schema";

/** A project-free selection/help reply; it never chooses a project on the owner's behalf. */
export interface TelegramControlReply {
  sequence: number; text: string; status: "queued" | "sending" | "sent" | "failed" | "unknown" | "cancelled";
  bindingRevision: number; ownerGeneration: number; chatId: number; attempts: number; deadline: number;
  messageId: number | null; reason: string | null;
}

/** Durable channel-control extension of delivery.outbox/v1, using the same private sender contract. */
export class TelegramControlOutbox {
  constructor(readonly store: TransactionStore, readonly now: () => number) {
    store.transaction(tx => {
      ensureTelegramProjectSchema(tx);
      // An already-invoked send after reconstruction has an uncertain remote result; never resend it.
      tx.run("UPDATE telegram_control_replies SET status = 'unknown', reason = 'interrupted_send' WHERE status = 'sending'");
    });
  }

  /** Commits at most one bounded reply per verified inbox event, without a fabricated project identity. */
  commit(sequence: number, text: string): void {
    requireText(text, 4096);
    if (/bearer\s|authorization\s*:|[0-9]{5,}:[A-Za-z0-9_-]{8,}/i.test(text)) throw new AppError("invalid_delivery_payload");
    this.store.transaction(tx => {
      if (tx.get("SELECT sequence FROM telegram_control_replies WHERE sequence = ?", sequence)) return;
      const binding = readBinding(tx);
      const event = tx.get<{ classification: string; binding_revision: number; telegram_chat_id: number; telegram_user_id: number }>("SELECT classification, binding_revision, telegram_chat_id, telegram_user_id FROM telegram_inbox WHERE sequence = ?", sequence);
      if (!event || event.classification !== "authorized" || binding.state !== "bound" || event.binding_revision !== binding.revision || event.telegram_chat_id !== binding.telegramChatId || event.telegram_user_id !== binding.telegramUserId) throw new AppError("telegram_binding_changed", 409);
      if (tx.get<{ n: number }>("SELECT count(*) AS n FROM telegram_control_replies")!.n >= 1024) throw new AppError("telegram_reply_limit", 409);
      const owner = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'")!;
      tx.run(`INSERT INTO telegram_control_replies (sequence, text, status, binding_revision, owner_generation, chat_id, attempts, deadline, message_id, reason)
        VALUES (?, ?, 'queued', ?, ?, ?, 0, ?, NULL, NULL)`, sequence, text, binding.revision, owner.generation, binding.telegramChatId, this.now() + 86_400_000);
    });
  }

  /** Reads a bounded inspection page; unknown outcomes are visible and never automatically resent. */
  list(after = 0): TelegramControlReply[] {
    if (!Number.isSafeInteger(after) || after < 0) throw new AppError("invalid_cursor");
    return this.store.read(tx => tx.all<TelegramControlReply>(`SELECT sequence, text, status, binding_revision AS bindingRevision,
      owner_generation AS ownerGeneration, chat_id AS chatId, attempts, deadline, message_id AS messageId, reason
      FROM telegram_control_replies WHERE sequence > ? ORDER BY sequence LIMIT 32`, after));
  }

  /** Performs finite fixture sends only after a durable invocation marker and current binding/owner checks. */
  pump(sender: DeliverySender): void {
    for (const row of this.store.read(tx => tx.all<{ sequence: number }>("SELECT sequence FROM telegram_control_replies WHERE status = 'queued' ORDER BY sequence LIMIT 32"))) {
      const input = this.store.transaction(tx => {
        const reply = tx.get<{ text: string; status: string; binding_revision: number; owner_generation: number; chat_id: number; attempts: number; deadline: number }>("SELECT * FROM telegram_control_replies WHERE sequence = ?", row.sequence)!;
        if (reply.status !== "queued") return null;
        const binding = readBinding(tx), owner = tx.get<{ generation: number }>("SELECT generation FROM owner WHERE id = 'owner'");
        if (binding.state !== "bound" || binding.revision !== reply.binding_revision || binding.telegramChatId !== reply.chat_id || owner?.generation !== reply.owner_generation || this.now() >= reply.deadline) {
          tx.run("UPDATE telegram_control_replies SET status = 'cancelled', reason = 'authorization_or_deadline_changed' WHERE sequence = ?", row.sequence);
          return null;
        }
        tx.run("UPDATE telegram_control_replies SET status = 'sending', attempts = attempts + 1 WHERE sequence = ?", row.sequence);
        return { chatId: reply.chat_id, text: reply.text, dedupeKey: `tg:control:${row.sequence}` };
      });
      if (!input) continue;
      let result: DeliverySendResult;
      try {
        const returned = sender.send(input);
        result = returned && typeof returned === "object" ? returned : { outcome: "unknown" };
      } catch { result = { outcome: "unknown" }; }
      this.store.transaction(tx => {
        const reply = tx.get<{ status: string; attempts: number }>("SELECT status, attempts FROM telegram_control_replies WHERE sequence = ?", row.sequence)!;
        if (reply.status !== "sending") return;
        const sent = result.outcome === "sent" && Number.isSafeInteger(result.messageId) && result.messageId > 0;
        const failed = result.outcome === "failed" && ["telegram_unavailable", "telegram_rejected"].includes(result.reason);
        const retry = failed && result.outcome === "failed" && result.reason === "telegram_unavailable" && result.retryable && reply.attempts < 3;
        tx.run("UPDATE telegram_control_replies SET status = ?, message_id = ?, reason = ? WHERE sequence = ?",
          sent ? "sent" : retry ? "queued" : failed ? "failed" : "unknown", sent && result.outcome === "sent" ? result.messageId : null,
          sent ? null : failed && result.outcome === "failed" ? result.reason : "remote_outcome_unknown", row.sequence);
      });
    }
  }
}
