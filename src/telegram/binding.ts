import { createHash } from "node:crypto";
import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import type { TelegramPolicy } from "../config";
import type {
  TelegramBinding, TelegramBindingCommand, TelegramBindingProof, TelegramBindingReceipt, TelegramPollStatus,
} from "./types";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const requestIdOk = (value: string) => /^[a-zA-Z0-9_-]{8,128}$/.test(value);
const numericId = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= Number.MAX_SAFE_INTEGER;
const hintOk = (value: unknown) => value == null || (typeof value === "string" && value.length <= 64 && /^[A-Za-z0-9_]{0,64}$/.test(value));

interface BindingRow {
  revision: number; state: TelegramBinding["state"];
  telegram_user_id: number | null; telegram_chat_id: number | null;
  username_hint: string | null; challenge_nonce: string | null; challenge_expires_at: number | null;
  bound_at: number | null; proof_json: string;
}
interface PollRow {
  next_offset: number; last_poll_at: number | null; last_update_id: number | null;
  gap_state: TelegramPollStatus["gapState"]; gap_noticed_at: number | null; gap_reason: string | null;
}

/** Projects the single installation binding row. */
export function readBinding(tx: AppTransaction): TelegramBinding {
  const row = tx.get<BindingRow>("SELECT * FROM telegram_binding WHERE id = 1");
  if (!row) throw new AppError("telegram_binding_missing", 503);
  return {
    revision: row.revision, state: row.state,
    telegramUserId: row.telegram_user_id, telegramChatId: row.telegram_chat_id,
    usernameHint: row.username_hint, challengeNonce: row.challenge_nonce,
    challengeExpiresAt: row.challenge_expires_at, boundAt: row.bound_at,
    proof: JSON.parse(row.proof_json) as TelegramBindingProof,
  };
}

/** Projects the durable getUpdates cursor and gap flag. */
export function readPoll(tx: AppTransaction, retentionHours: number): TelegramPollStatus {
  const row = tx.get<PollRow>("SELECT * FROM telegram_poll WHERE id = 1");
  if (!row) throw new AppError("telegram_poll_missing", 503);
  return {
    nextOffset: row.next_offset, lastPollAt: row.last_poll_at, lastUpdateId: row.last_update_id,
    gapState: row.gap_state, gapNoticedAt: row.gap_noticed_at, gapReason: row.gap_reason,
    retentionHours,
  };
}

/** Canonical receipt identity for telegram binding commands. */
export function bindingIdentity(command: TelegramBindingCommand): string {
  if (!command || typeof command.requestId !== "string" || !requestIdOk(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
      !command.payload || typeof command.payload !== "object" || Array.isArray(command.payload)) {
    throw new AppError("invalid_telegram_command");
  }
  if (command.kind === "telegram.bind") {
    const payload = command.payload;
    if (Object.keys(payload).some(k => !["telegramUserId", "telegramChatId", "usernameHint"].includes(k)) ||
        !numericId(payload.telegramUserId) || !numericId(payload.telegramChatId) || !hintOk(payload.usernameHint)) {
      throw new AppError("invalid_telegram_command");
    }
    return digest(JSON.stringify([command.kind, command.expectedRevision, payload.telegramUserId, payload.telegramChatId, payload.usernameHint ?? null]));
  }
  if (command.kind === "telegram.confirm") {
    const payload = command.payload;
    if (Object.keys(payload).some(k => !["telegramUserId", "telegramChatId", "challengeNonce"].includes(k)) ||
        !numericId(payload.telegramUserId) || !numericId(payload.telegramChatId) ||
        typeof payload.challengeNonce !== "string" || !/^[a-f0-9]{32}$/.test(payload.challengeNonce)) {
      throw new AppError("invalid_telegram_command");
    }
    return digest(JSON.stringify([command.kind, command.expectedRevision, payload.telegramUserId, payload.telegramChatId, payload.challengeNonce]));
  }
  if (command.kind === "telegram.revoke" || command.kind === "telegram.ack_gap") {
    if (Object.keys(command.payload).length) throw new AppError("invalid_telegram_command");
    return digest(JSON.stringify([command.kind, command.expectedRevision]));
  }
  throw new AppError("invalid_telegram_command");
}

function saveBinding(tx: AppTransaction, binding: TelegramBinding): void {
  tx.run(`UPDATE telegram_binding SET revision = ?, state = ?, telegram_user_id = ?, telegram_chat_id = ?,
    username_hint = ?, challenge_nonce = ?, challenge_expires_at = ?, bound_at = ?, proof_json = ? WHERE id = 1`,
  binding.revision, binding.state, binding.telegramUserId, binding.telegramChatId, binding.usernameHint,
  binding.challengeNonce, binding.challengeExpiresAt, binding.boundAt, JSON.stringify(binding.proof));
}

/** Applies a trusted owner binding mutation inside an open application transaction. */
export function mutateBinding(
  tx: AppTransaction,
  command: TelegramBindingCommand,
  policy: TelegramPolicy,
  now: number,
): TelegramBindingReceipt {
  const current = readBinding(tx);
  if (current.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  let next: TelegramBinding;
  if (command.kind === "telegram.bind") {
    const nonce = crypto.getRandomValues(new Uint8Array(16)).toHex();
    next = {
      revision: current.revision + 1, state: "pending",
      telegramUserId: command.payload.telegramUserId, telegramChatId: command.payload.telegramChatId,
      usernameHint: command.payload.usernameHint ?? null, challengeNonce: nonce,
      challengeExpiresAt: now + policy.challengeSeconds * 1000, boundAt: null,
      proof: { confirmedBy: null, confirmedAt: null, requestId: command.requestId },
    };
  } else if (command.kind === "telegram.confirm") {
    if (current.state !== "pending" || !current.challengeNonce || !current.challengeExpiresAt) {
      throw new AppError("telegram_binding_not_pending", 409);
    }
    if (now > current.challengeExpiresAt) throw new AppError("telegram_challenge_expired", 409);
    if (current.telegramUserId !== command.payload.telegramUserId ||
        current.telegramChatId !== command.payload.telegramChatId ||
        current.challengeNonce !== command.payload.challengeNonce) {
      throw new AppError("telegram_challenge_mismatch", 409);
    }
    next = {
      revision: current.revision + 1, state: "bound",
      telegramUserId: current.telegramUserId, telegramChatId: current.telegramChatId,
      usernameHint: current.usernameHint, challengeNonce: null, challengeExpiresAt: null,
      boundAt: now, proof: { confirmedBy: "owner_web", confirmedAt: now, requestId: command.requestId },
    };
  } else if (command.kind === "telegram.revoke") {
    next = {
      revision: current.revision + 1, state: "unbound",
      telegramUserId: null, telegramChatId: null, usernameHint: null,
      challengeNonce: null, challengeExpiresAt: null, boundAt: null,
      proof: { confirmedBy: null, confirmedAt: null, requestId: command.requestId },
    };
  } else {
    const poll = readPoll(tx, policy.retentionHours);
    if (poll.gapState !== "possible_missing_inputs") throw new AppError("telegram_no_gap", 409);
    tx.run(`UPDATE telegram_poll SET gap_state = 'none', gap_noticed_at = NULL, gap_reason = NULL WHERE id = 1`);
    next = { ...current, revision: current.revision + 1 };
  }
  saveBinding(tx, next);
  return { binding: next, poll: readPoll(tx, policy.retentionHours) };
}

/** Completes a pending challenge from a matching authorized inbound update. */
export function confirmBindingFromChallenge(tx: AppTransaction, now: number, requestId: string): TelegramBinding {
  const current = readBinding(tx);
  if (current.state !== "pending" || !current.challengeNonce) throw new AppError("telegram_binding_not_pending", 409);
  if (current.challengeExpiresAt && now > current.challengeExpiresAt) throw new AppError("telegram_challenge_expired", 409);
  const next: TelegramBinding = {
    revision: current.revision + 1, state: "bound",
    telegramUserId: current.telegramUserId, telegramChatId: current.telegramChatId,
    usernameHint: current.usernameHint, challengeNonce: null, challengeExpiresAt: null,
    boundAt: now, proof: { confirmedBy: "challenge_match", confirmedAt: now, requestId },
  };
  saveBinding(tx, next);
  return next;
}
