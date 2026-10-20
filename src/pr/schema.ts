import type { AppTransaction } from "../store";

/**
 * Ensures PR01 tables exist inside an application transaction.
 * Formal `user_version` migration remains reserved for store ownership; tests and
 * trusted callers invoke this before monitor/candidate mutations.
 */
export function ensurePrSchema(tx: AppTransaction): void {
  tx.run(`CREATE TABLE IF NOT EXISTS pr_monitors (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    state TEXT NOT NULL CHECK (state IN ('active', 'paused', 'revoked')),
    record_json TEXT NOT NULL,
    UNIQUE (project_id, id)
  )`);
  tx.run(`CREATE INDEX IF NOT EXISTS pr_monitor_project ON pr_monitors(project_id, revision)`);
  tx.run(`CREATE TABLE IF NOT EXISTS pr_poll_checkpoints (
    monitor_id TEXT PRIMARY KEY REFERENCES pr_monitors(id),
    record_json TEXT NOT NULL
  )`);
  tx.run(`CREATE TABLE IF NOT EXISTS pr_candidates (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id),
    monitor_id TEXT NOT NULL REFERENCES pr_monitors(id),
    dedupe_key TEXT NOT NULL,
    generation INTEGER NOT NULL CHECK (generation > 0),
    status TEXT NOT NULL,
    record_json TEXT NOT NULL,
    UNIQUE (project_id, dedupe_key)
  )`);
  tx.run(`CREATE INDEX IF NOT EXISTS pr_candidate_monitor ON pr_candidates(monitor_id, generation)`);
  tx.run(`CREATE INDEX IF NOT EXISTS pr_candidate_pr ON pr_candidates(project_id, monitor_id)`);
  tx.run(`CREATE TABLE IF NOT EXISTS pr_snapshots (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL UNIQUE REFERENCES pr_candidates(id),
    record_json TEXT NOT NULL
  )`);
}
