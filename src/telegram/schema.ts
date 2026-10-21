import type { AppTransaction } from "../store";

/**
 * Ensures TG02 tables exist inside an application transaction.
 * Formal `user_version` migration remains reserved for store ownership.
 */
export function ensureTelegramProjectSchema(tx: AppTransaction): void {
  tx.run(`CREATE TABLE IF NOT EXISTS telegram_project_context (
    telegram_chat_id INTEGER PRIMARY KEY,
    revision INTEGER NOT NULL CHECK (revision > 0),
    binding_revision INTEGER NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(id),
    topic_id TEXT NOT NULL,
    updated_at INTEGER NOT NULL,
    FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id)
  )`);
  tx.run(`CREATE TABLE IF NOT EXISTS telegram_callback_refs (
    id TEXT PRIMARY KEY,
    telegram_chat_id INTEGER NOT NULL,
    binding_revision INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`);
  tx.run(`CREATE INDEX IF NOT EXISTS telegram_callback_chat ON telegram_callback_refs(telegram_chat_id, created_at)`);
  tx.run(`CREATE TABLE IF NOT EXISTS telegram_message_commands (
    telegram_chat_id INTEGER NOT NULL,
    message_id INTEGER NOT NULL,
    record_json TEXT NOT NULL,
    committed_at INTEGER NOT NULL,
    PRIMARY KEY (telegram_chat_id, message_id)
  )`);
}
