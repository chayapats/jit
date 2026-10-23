import { requireId } from "../sources";
import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import { ensureTelegramProjectSchema } from "./schema";

export type TelegramCallbackAction = "task.accept" | "task.edit";

export interface TelegramCallbackRef {
  id: string;
  telegramChatId: number;
  bindingRevision: number;
  contextRevision: number;
  projectId: string;
  topicId: string;
  action: TelegramCallbackAction;
  taskId: string;
  proposalId: string;
  expectedRevision: number;
  requestId: string;
  createdAt: number;
  expiresAt: number;
}

interface RefRow { id: string; telegram_chat_id: number; binding_revision: number; record_json: string; created_at: number; expires_at: number }

const CALLBACK_PREFIX = "tg/1/";
const CALLBACK_TTL_MS = 86_400_000;

function encodeRef(ref: TelegramCallbackRef): string {
  return `${CALLBACK_PREFIX}${ref.id}`;
}

/** Decodes a bounded opaque reference; content carries no owner authority. */
export function decodeCallbackData(data: string | null | undefined): string | null {
  if (typeof data !== "string" || !data.startsWith(CALLBACK_PREFIX)) return null;
  const id = data.slice(CALLBACK_PREFIX.length);
  if (!/^[a-f0-9]{32}$/.test(id)) return null;
  return id;
}

function project(row: RefRow): TelegramCallbackRef {
  const parsed = JSON.parse(row.record_json) as Omit<TelegramCallbackRef, "id" | "telegramChatId" | "bindingRevision" | "createdAt" | "expiresAt">;
  return {
    id: row.id, telegramChatId: row.telegram_chat_id, bindingRevision: row.binding_revision,
    createdAt: row.created_at, expiresAt: row.expires_at, ...parsed,
  };
}

/** Stores a revisioned callback bound to one owner chat, context and proposal. */
export function createCallbackRef(
  tx: AppTransaction,
  input: Omit<TelegramCallbackRef, "id" | "createdAt" | "expiresAt">,
  now: number,
): { ref: TelegramCallbackRef; data: string } {
  ensureTelegramProjectSchema(tx);
  for (const id of [input.projectId, input.topicId, input.taskId, input.proposalId]) requireId(id);
  tx.run("DELETE FROM telegram_callback_refs WHERE expires_at <= ?", now);
  if (tx.get<{ n: number }>("SELECT count(*) AS n FROM telegram_callback_refs")!.n >= 4096) throw new AppError("telegram_callback_limit", 409);
  const id = crypto.randomUUID().replaceAll("-", "");
  const ref: TelegramCallbackRef = { ...input, id, createdAt: now, expiresAt: now + CALLBACK_TTL_MS };
  tx.run(`INSERT INTO telegram_callback_refs VALUES (?, ?, ?, ?, ?, ?)`,
    id, input.telegramChatId, input.bindingRevision, JSON.stringify({
      projectId: ref.projectId, topicId: ref.topicId, contextRevision: ref.contextRevision, action: ref.action, taskId: ref.taskId,
      proposalId: ref.proposalId, expectedRevision: ref.expectedRevision, requestId: ref.requestId,
    }), now, ref.expiresAt);
  return { ref, data: encodeRef(ref) };
}

/** Reads an unexpired stored callback without extending its lifetime. */
export function readCallbackRef(tx: AppTransaction, id: string, now: number): TelegramCallbackRef {
  const row = tx.get<RefRow>("SELECT * FROM telegram_callback_refs WHERE id = ?", id);
  if (!row) throw new AppError("telegram_callback_unknown", 404);
  const ref = project(row);
  if (now >= ref.expiresAt) throw new AppError("telegram_callback_expired", 409);
  return ref;
}

/** Issues a fresh proposal reference and request identity after a stale callback. */
export function refreshCallbackRef(
  tx: AppTransaction,
  stale: TelegramCallbackRef,
  expectedRevision: number,
  proposalId: string,
  now: number,
): { ref: TelegramCallbackRef; data: string } {
  return createCallbackRef(tx, {
    ...stale, proposalId, expectedRevision, requestId: `tg-cb-accept-${proposalId}`,
  }, now);
}
