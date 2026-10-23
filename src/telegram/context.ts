import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import { ensureTelegramProjectSchema } from "./schema";

export interface TelegramProjectContext {
  telegramChatId: number;
  revision: number;
  bindingRevision: number;
  projectId: string;
  topicId: string;
  updatedAt: number;
}

interface ContextRow {
  telegram_chat_id: number; revision: number; binding_revision: number;
  project_id: string; topic_id: string; updated_at: number;
}

function project(row: ContextRow): TelegramProjectContext {
  return {
    telegramChatId: row.telegram_chat_id, revision: row.revision, bindingRevision: row.binding_revision,
    projectId: row.project_id, topicId: row.topic_id, updatedAt: row.updated_at,
  };
}

/** Reads the exact current chat context; names are never selectors. */
export function readProjectContext(tx: AppTransaction, telegramChatId: number): TelegramProjectContext | null {
  const row = tx.get<ContextRow>("SELECT * FROM telegram_project_context WHERE telegram_chat_id = ?", telegramChatId);
  return row ? project(row) : null;
}

/** Changes one context using its expected revision, rejecting ambiguous replacement. */
export function mutateProjectContext(
  tx: AppTransaction,
  telegramChatId: number,
  bindingRevision: number,
  expectedRevision: number | null,
  projectId: string,
  topicId: string,
  now: number,
): TelegramProjectContext {
  ensureTelegramProjectSchema(tx);
  const topic = tx.get<{ id: string }>("SELECT id FROM topics WHERE project_id = ? AND id = ?", projectId, topicId);
  if (!topic) throw new AppError("topic_not_found", 404, { projectId, topicId });
  const current = tx.get<ContextRow>("SELECT * FROM telegram_project_context WHERE telegram_chat_id = ?", telegramChatId);
  if (current) {
    if (expectedRevision === null && current.project_id === projectId && current.topic_id === topicId && current.binding_revision === bindingRevision) return project(current);
    if (expectedRevision === null || current.revision !== expectedRevision) {
      throw new AppError("stale_revision", 409, { revision: current.revision, path: `/telegram/context/${telegramChatId}` });
    }
    const revision = current.revision + 1;
    tx.run(`UPDATE telegram_project_context SET revision = ?, binding_revision = ?, project_id = ?, topic_id = ?, updated_at = ? WHERE telegram_chat_id = ?`,
      revision, bindingRevision, projectId, topicId, now, telegramChatId);
    return project(tx.get<ContextRow>("SELECT * FROM telegram_project_context WHERE telegram_chat_id = ?", telegramChatId)!);
  }
  if (expectedRevision != null && expectedRevision !== 0) throw new AppError("stale_revision", 409);
  tx.run(`INSERT INTO telegram_project_context VALUES (?, 1, ?, ?, ?, ?)`,
    telegramChatId, bindingRevision, projectId, topicId, now);
  return project(tx.get<ContextRow>("SELECT * FROM telegram_project_context WHERE telegram_chat_id = ?", telegramChatId)!);
}

export interface ProjectChoice { id: string; name: string; revision: number }

/** Lists installation projects for explicit owner selection; names never authorize. */
export function listProjectChoices(tx: AppTransaction, limit: number): ProjectChoice[] {
  return tx.all<ProjectChoice>(`SELECT p.id, p.name, p.revision FROM projects p ORDER BY p.created_at, p.id LIMIT ?`, limit);
}
