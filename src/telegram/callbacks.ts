import { createHash } from "node:crypto";
import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import { ensureTelegramProjectSchema } from "./schema";

const digest = (value: string) => createHash("sha256").update(value).digest("hex").slice(0, 8);

export type TelegramCallbackAction = "task.accept" | "task.edit";

export interface TelegramCallbackRef {
  id: string;
  telegramChatId: number;
  bindingRevision: number;
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

export function decodeCallbackData(data: string | null | undefined): string | null {
  if (typeof data !== "string" || !data.startsWith(CALLBACK_PREFIX)) return null;
  const id = data.slice(CALLBACK_PREFIX.length);
  if (!/^[a-f0-9]{8}$/.test(id)) return null;
  return id;
}

function project(row: RefRow): TelegramCallbackRef {
  const parsed = JSON.parse(row.record_json) as Omit<TelegramCallbackRef, "id" | "telegramChatId" | "bindingRevision" | "createdAt" | "expiresAt">;
  return {
    id: row.id, telegramChatId: row.telegram_chat_id, bindingRevision: row.binding_revision,
    createdAt: row.created_at, expiresAt: row.expires_at, ...parsed,
  };
}

export function createCallbackRef(
  tx: AppTransaction,
  input: Omit<TelegramCallbackRef, "id" | "createdAt" | "expiresAt">,
  now: number,
): { ref: TelegramCallbackRef; data: string } {
  ensureTelegramProjectSchema(tx);
  const id = digest(`${input.projectId}:${input.taskId}:${input.proposalId}:${input.action}:${now}`);
  const ref: TelegramCallbackRef = { ...input, id, createdAt: now, expiresAt: now + CALLBACK_TTL_MS };
  tx.run(`INSERT OR REPLACE INTO telegram_callback_refs VALUES (?, ?, ?, ?, ?, ?)`,
    id, input.telegramChatId, input.bindingRevision, JSON.stringify({
      projectId: ref.projectId, topicId: ref.topicId, action: ref.action, taskId: ref.taskId,
      proposalId: ref.proposalId, expectedRevision: ref.expectedRevision, requestId: ref.requestId,
    }), now, ref.expiresAt);
  return { ref, data: encodeRef(ref) };
}

export function readCallbackRef(tx: AppTransaction, id: string, now: number): TelegramCallbackRef {
  ensureTelegramProjectSchema(tx);
  const row = tx.get<RefRow>("SELECT * FROM telegram_callback_refs WHERE id = ?", id);
  if (!row) throw new AppError("telegram_callback_unknown", 404);
  const ref = project(row);
  if (now > ref.expiresAt) throw new AppError("telegram_callback_expired", 409);
  return ref;
}

export function refreshCallbackRef(
  tx: AppTransaction,
  stale: TelegramCallbackRef,
  expectedRevision: number,
  proposalId: string,
  now: number,
): { ref: TelegramCallbackRef; data: string } {
  return createCallbackRef(tx, {
    ...stale, proposalId, expectedRevision, requestId: stale.requestId,
  }, now);
}
