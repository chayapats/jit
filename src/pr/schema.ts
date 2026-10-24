import type { AppTransaction } from "../store";

/**
 * Ensures PR01 tables exist inside an application transaction.
 * Formal `user_version` migration remains reserved for store ownership; tests and
 * trusted callers invoke this before monitor/candidate mutations.
 * PR02 adds `pr_reports` + `pr_report_annotations` under the same pattern.
 * PR03 adds `pr_alert_policies` (versioned owner policy), `pr_alert_decisions`
 * (append-only evaluation records) and `pr_alerts` (intent -> report/finding links), additively.
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
  tx.run(`CREATE TABLE IF NOT EXISTS pr_reports (
    id TEXT PRIMARY KEY,
    candidate_id TEXT NOT NULL UNIQUE REFERENCES pr_candidates(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    monitor_id TEXT NOT NULL REFERENCES pr_monitors(id),
    status TEXT NOT NULL CHECK (status IN ('running', 'complete_clean', 'complete_findings', 'partial', 'incomplete', 'failed')),
    record_json TEXT NOT NULL
  )`);
  tx.run(`CREATE INDEX IF NOT EXISTS pr_report_monitor ON pr_reports(project_id, monitor_id)`);
  tx.run(`CREATE INDEX IF NOT EXISTS pr_report_candidate ON pr_reports(candidate_id)`);
  tx.run(`CREATE TABLE IF NOT EXISTS pr_report_annotations (
    id TEXT PRIMARY KEY,
    report_id TEXT NOT NULL REFERENCES pr_reports(id),
    revision INTEGER NOT NULL CHECK (revision > 0),
    record_json TEXT NOT NULL,
    UNIQUE (report_id, revision)
  )`);
  tx.run(`CREATE INDEX IF NOT EXISTS pr_report_annotation_report ON pr_report_annotations(report_id, revision)`);
  tx.run(`CREATE TABLE IF NOT EXISTS pr_alert_policies (
    project_id TEXT NOT NULL REFERENCES projects(id),
    version INTEGER NOT NULL CHECK (version > 0),
    record_json TEXT NOT NULL,
    PRIMARY KEY (project_id, version)
  )`);
  tx.run(`CREATE TABLE IF NOT EXISTS pr_alert_decisions (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    id TEXT NOT NULL UNIQUE,
    project_id TEXT NOT NULL REFERENCES projects(id),
    report_id TEXT NOT NULL REFERENCES pr_reports(id),
    digest TEXT NOT NULL,
    record_json TEXT NOT NULL
  )`);
  tx.run(`CREATE INDEX IF NOT EXISTS pr_alert_decision_report ON pr_alert_decisions(report_id, sequence)`);
  tx.run(`CREATE TABLE IF NOT EXISTS pr_alerts (
    intent_id TEXT PRIMARY KEY REFERENCES delivery_intents(id),
    project_id TEXT NOT NULL REFERENCES projects(id),
    report_id TEXT NOT NULL REFERENCES pr_reports(id),
    finding_id TEXT NOT NULL,
    candidate_id TEXT NOT NULL,
    monitor_id TEXT NOT NULL,
    policy_version INTEGER NOT NULL CHECK (policy_version > 0),
    record_json TEXT NOT NULL
  )`);
  tx.run(`CREATE INDEX IF NOT EXISTS pr_alert_report ON pr_alerts(report_id, finding_id)`);
  tx.run(`CREATE INDEX IF NOT EXISTS pr_alert_candidate ON pr_alerts(candidate_id)`);
  tx.run(`CREATE INDEX IF NOT EXISTS pr_alert_monitor ON pr_alerts(monitor_id)`);
}
