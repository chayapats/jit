import { createHash } from "node:crypto";
import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import { commitDeliveryIntent } from "./outbox";
import type { AttentionClass, DeliveryAttention, DeliveryReceipt } from "./types";

/**
 * delivery.attention_levels/v1 — the owner's per-channel choice of what creates notifications (REL04, ADR 0032, FR-28).
 *
 * One row per channel (schema 35, `attention_levels`). Without a row the level is `needs-me` at revision 0 (S12-D06:
 * team progress stays quiet; owner-configured schedule reports and PR alerts also count as needs_owner); a saved row keeps its
 * level and is never migrated. It changes only through the `attention.set` owner command, which is revisioned per channel and idempotent by request id like every
 * other command. The level filters which delivery intents are *created*; it never hides or deletes reports, decisions
 * or history, and changing it never cancels an intent that already exists.
 */
export type AttentionChannel = "telegram" | "web";
export type AttentionLevel = "all" | "needs-me";
export interface AttentionSetting { channel: AttentionChannel; level: AttentionLevel; revision: number; updatedAt: number | null }
export type AttentionLevels = Record<AttentionChannel, AttentionSetting>;
export interface SetAttentionCommand {
  kind: "attention.set";
  requestId: string;
  projectId: null;
  /** Revision of this channel's row the owner saw (0 before the first save). */
  expectedRevision: number;
  payload: { channel: AttentionChannel; level: AttentionLevel };
}
export interface AttentionReceipt { attention: AttentionSetting }

export const attentionChannels: readonly AttentionChannel[] = Object.freeze(["telegram", "web"]);
export const attentionLevelChoices: readonly AttentionLevel[] = Object.freeze(["all", "needs-me"]);
/**
 * The channel every delivery.outbox/v1 intent goes to. Web/PWA has no push transport (web.pwa/v1), so its level is
 * recorded for the owner but filters nothing until a Web notification channel exists.
 */
export const outboxChannel: AttentionChannel = "telegram";

/** Reads one channel's level, or the default (`needs-me`, revision 0) when the owner never saved one. */
export function readAttentionLevel(tx: AppTransaction, channel: AttentionChannel): AttentionSetting {
  const row = tx.get<{ level: AttentionLevel; revision: number; updated_at: number }>("SELECT level, revision, updated_at FROM attention_levels WHERE channel = ?", channel);
  return row ? { channel, level: row.level, revision: row.revision, updatedAt: row.updated_at } : { channel, level: "needs-me", revision: 0, updatedAt: null };
}

/** Reads both channels' levels. */
export function readAttentionLevels(tx: AppTransaction): AttentionLevels {
  return { telegram: readAttentionLevel(tx, "telegram"), web: readAttentionLevel(tx, "web") };
}

/** Validates a command shape and returns its stable identity for receipt replay. */
export function attentionIdentity(command: SetAttentionCommand): string {
  if (!command || command.kind !== "attention.set" || command.projectId !== null ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
      !command.payload || typeof command.payload !== "object" || Array.isArray(command.payload) ||
      Object.keys(command.payload).sort().join(",") !== "channel,level" ||
      !attentionChannels.includes(command.payload.channel) || !attentionLevelChoices.includes(command.payload.level)) throw new AppError("invalid_attention");
  return createHash("sha256").update(JSON.stringify([command.kind, command.expectedRevision, command.payload.channel, command.payload.level])).digest("hex");
}

/**
 * Applies a validated command inside the caller's write transaction. A stale revision is rejected. Existing intents
 * are not touched: a stricter level only stops new informational intents from being created.
 */
export function writeAttentionLevel(tx: AppTransaction, command: SetAttentionCommand, now: number): AttentionSetting {
  const current = readAttentionLevel(tx, command.payload.channel);
  if (current.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  const next: AttentionSetting = { channel: command.payload.channel, level: command.payload.level, revision: current.revision + 1, updatedAt: now };
  tx.run(`INSERT INTO attention_levels (channel, level, revision, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(channel) DO UPDATE SET level = excluded.level, revision = excluded.revision, updated_at = excluded.updated_at`,
  next.channel, next.level, next.revision, now);
  return next;
}

/** Whether the channel's current level admits a new intent of this class. `needs_owner` always passes. */
export function attentionAdmits(tx: AppTransaction, channel: AttentionChannel, cls: AttentionClass): boolean {
  return cls === "needs_owner" || readAttentionLevel(tx, channel).level === "all";
}

/**
 * Commits a classified intent through `commitDeliveryIntent`, or nothing when the outbox channel's level filters its
 * class. A dedupe key that already has an intent always returns it (replay is never re-filtered), so a level change
 * neither hides nor duplicates an intent that exists. Returns null when the level filtered a new intent; the caller's
 * report, decision or history record is committed regardless.
 */
export function commitAttentionIntent(
  tx: AppTransaction, input: Parameters<typeof commitDeliveryIntent>[1] & { attention: DeliveryAttention }, now: number,
): DeliveryReceipt | null {
  const existing = tx.get("SELECT 1 FROM delivery_intents WHERE dedupe_key = ?", input.dedupeKey);
  if (!existing && !attentionAdmits(tx, outboxChannel, input.attention.class)) return null;
  return commitDeliveryIntent(tx, input, now);
}
