import { Database, type SQLQueryBindings } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { commitDecisionMemorySource, retireDecisionMemorySource } from "./memory/decision-sources";

/** Current application schema revision. Service packaging pins and checks this value. */
export const schemaVersion = 33;

/**
 * Installation-scoped state that never round-trips through backup images and
 * is preserved from the live store on every activation (`swapFrom`). Order is
 * parent-first for inserts. ops.backup_manifest/v1 excludes these from images.
 * `lifecycle_ledger`/`lifecycle_checkpoint` (schema 23, app.deletion_ledger/v1)
 * are the installation lifecycle ledger: a restore or upgrade activation can
 * therefore never roll back current tombstones or suppressions.
 * `schedule_feed` (schema 30, app.schedule_feed/v1) holds the feed token hash,
 * so a restore can never revive a rotated or turned-off feed URL.
 */
export const installationScopedTables = Object.freeze(["owner", "sessions", "login_throttle", "ops_backups", "lifecycle_ledger", "lifecycle_checkpoint", "schedule_feed"] as const);

/** Synchronous SQL operations scoped to an application transaction. */
export interface AppTransaction {
  get<T>(sql: string, ...bindings: SQLQueryBindings[]): T | null;
  all<T>(sql: string, ...bindings: SQLQueryBindings[]): T[];
  run(sql: string, ...bindings: SQLQueryBindings[]): void;
}

/**
 * Schema inspection: the `user_version` of an existing installation database,
 * or null when no database exists yet. Never creates, migrates or writes
 * database content (ops.schema_migrations/v1 preflight and boot gates); SQLite
 * may create its WAL index sibling to read a WAL-mode file.
 */
export function inspectStoreSchema(path: string): number | null {
  if (!existsSync(path) || statSync(path).size === 0) return null;
  const db = new Database(path, { readwrite: true, create: false, strict: true });
  try { return (db.query("PRAGMA user_version").get() as { user_version: number }).user_version; }
  finally { db.close(); }
}

/** Store opening options. */
export interface StoreOptions {
  /**
   * When false, an existing installation at an older schema is opened as-is
   * instead of being migrated in place. Only the owner-authorized staged
   * upgrade (ops.schema_migrations/v1) migrates an installation, and it does so
   * on a staged copy. New (empty) databases are always initialized.
   */
  migrateExisting?: boolean;
}

/** Local transaction store; state, receipts and audit entries commit or roll back together. */
export class TransactionStore {
  #db: Database;
  #tx: AppTransaction;

  constructor(readonly path: string, options: StoreOptions = {}) {
    const existing = existsSync(path) && statSync(path).size > 0;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.#db = new Database(path, { create: true, strict: true });
    this.#tx = {
      get: <T>(sql: string, ...args: SQLQueryBindings[]) => this.#db.query(sql).get(...args) as T | null,
      all: <T>(sql: string, ...args: SQLQueryBindings[]) => this.#db.query(sql).all(...args) as T[],
      run: (sql: string, ...args: SQLQueryBindings[]) => { this.#db.query(sql).run(...args); },
    };
    try {
      const version = this.#tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
      if (version > schemaVersion) throw new Error("Database schema is newer than this application");
      this.#db.exec("PRAGMA busy_timeout = 2000; PRAGMA foreign_keys = ON;");
      if (version < schemaVersion && (options.migrateExisting !== false || !existing)) {
        // SQLite table rebuilds must not delete referenced parents with enforcement enabled.
        this.#db.exec("PRAGMA foreign_keys = OFF;");
        this.#db.transaction(() => {
          // A second opener may have migrated while this connection waited for the writer.
          const current = this.#tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
          if (current === schemaVersion) return;
          if (![0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 31, 32].includes(current)) throw new Error("Unsupported migration source");
          if (existing) {
            const snapshot = `${path}.pre-v${current}-${crypto.randomUUID()}.sqlite`;
            const fd = openSync(snapshot, "wx", 0o600);
            try { writeFileSync(fd, this.#db.serialize()); fsyncSync(fd); } finally { closeSync(fd); }
          }
          if (current === 0) this.#db.exec(`
            CREATE TABLE owner (
              id TEXT PRIMARY KEY CHECK (id = 'owner'), password_hash TEXT NOT NULL,
              generation INTEGER NOT NULL CHECK (generation > 0)
            );
            CREATE TABLE sessions (
              token_hash TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES owner(id),
              generation INTEGER NOT NULL, expires_at INTEGER NOT NULL
            );
            CREATE TABLE login_throttle (
              id INTEGER PRIMARY KEY CHECK (id = 1), window_start INTEGER NOT NULL,
              attempts INTEGER NOT NULL CHECK (attempts >= 0)
            );
            CREATE TABLE app_state (
              id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL
            );
            INSERT INTO app_state VALUES (1, 0);
            CREATE TABLE projects (
              id TEXT PRIMARY KEY, name TEXT NOT NULL, revision INTEGER NOT NULL,
              created_at INTEGER NOT NULL
            );
            CREATE TABLE project_groups (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL UNIQUE REFERENCES projects(id)
            );
            CREATE TABLE command_receipts (
              actor_id TEXT NOT NULL, request_id TEXT NOT NULL, payload_hash TEXT NOT NULL,
              result_json TEXT NOT NULL, committed_at INTEGER NOT NULL,
              PRIMARY KEY (actor_id, request_id)
            );
            CREATE TABLE audit (
              id INTEGER PRIMARY KEY, actor_id TEXT NOT NULL, command_kind TEXT NOT NULL,
              request_id TEXT NOT NULL, project_id TEXT NOT NULL, committed_at INTEGER NOT NULL,
              UNIQUE (actor_id, request_id)
            );
            PRAGMA user_version = 1;
          `);
          if (current < 2) this.#db.exec(`
            CREATE UNIQUE INDEX project_group_identity ON project_groups(project_id, id);
            CREATE TABLE sources (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
              kind TEXT NOT NULL CHECK (kind IN ('topic', 'message', 'output', 'external')),
              current_revision INTEGER NOT NULL CHECK (current_revision > 0),
              generation INTEGER NOT NULL CHECK (generation > 0),
              availability TEXT NOT NULL CHECK (availability IN ('available', 'unavailable')),
              UNIQUE (project_id, id)
            );
            CREATE TABLE source_versions (
              source_id TEXT NOT NULL REFERENCES sources(id), revision INTEGER NOT NULL CHECK (revision > 0),
              generation INTEGER NOT NULL CHECK (generation > 0), descriptor_json TEXT NOT NULL,
              attribution_json TEXT NOT NULL, content_text TEXT, committed_at INTEGER NOT NULL,
              PRIMARY KEY (source_id, revision, generation)
            );
            CREATE TABLE topics (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL, group_id TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK (revision > 0), sequence INTEGER NOT NULL CHECK (sequence > 0),
              message_sequence INTEGER NOT NULL CHECK (message_sequence >= 0), created_at INTEGER NOT NULL,
              attribution_json TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE,
              source_revision INTEGER NOT NULL, source_generation INTEGER NOT NULL,
              UNIQUE (project_id, id), UNIQUE (project_id, sequence),
              FOREIGN KEY (project_id, group_id) REFERENCES project_groups(project_id, id),
              FOREIGN KEY (project_id, source_id) REFERENCES sources(project_id, id),
              FOREIGN KEY (source_id, source_revision, source_generation) REFERENCES source_versions(source_id, revision, generation)
            );
            CREATE TABLE messages (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL, topic_id TEXT NOT NULL,
              sequence INTEGER NOT NULL CHECK (sequence > 0), committed_at INTEGER NOT NULL,
              attribution_json TEXT NOT NULL, source_id TEXT NOT NULL UNIQUE,
              source_revision INTEGER NOT NULL, source_generation INTEGER NOT NULL,
              UNIQUE (project_id, topic_id, sequence),
              FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id),
              FOREIGN KEY (project_id, source_id) REFERENCES sources(project_id, id),
              FOREIGN KEY (source_id, source_revision, source_generation) REFERENCES source_versions(source_id, revision, generation)
            );
            PRAGMA user_version = 2;
          `);
          if (current < 3) this.#db.exec(`
            CREATE TABLE job_scheduler (
              id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL,
              pid INTEGER NOT NULL CHECK (pid > 0)
            );
            CREATE TABLE jobs (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id),
              queue_order INTEGER NOT NULL, priority INTEGER NOT NULL CHECK (priority IN (0, 1)),
              state TEXT NOT NULL, occupies INTEGER NOT NULL CHECK (occupies IN (0, 1)),
              route_key TEXT NOT NULL, record_json TEXT NOT NULL
            );
            CREATE INDEX job_admission ON jobs(state, priority DESC, queue_order);
            CREATE INDEX job_project ON jobs(project_id, sequence);
            CREATE UNIQUE INDEX job_queue_order ON jobs(queue_order);
            CREATE INDEX job_slots ON jobs(route_key) WHERE occupies = 1;
            PRAGMA user_version = 3;
          `);
          if (current < 4) this.#db.exec(`
            CREATE TABLE team_state (id INTEGER PRIMARY KEY CHECK (id = 1), revision INTEGER NOT NULL, route_json TEXT);
            INSERT INTO team_state VALUES (1, 0, NULL);
            CREATE TABLE roles (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL);
            CREATE TABLE project_team (project_id TEXT PRIMARY KEY REFERENCES projects(id), revision INTEGER NOT NULL, route_json TEXT, overrides_json TEXT NOT NULL);
            CREATE TABLE team_contexts (id TEXT PRIMARY KEY, generation INTEGER NOT NULL CHECK (generation > 0), state TEXT NOT NULL CHECK (state IN ('active', 'retired', 'delete_failed', 'deleted')));
            CREATE TABLE team_runs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL REFERENCES projects(id), job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id), context_id TEXT NOT NULL UNIQUE REFERENCES team_contexts(id), record_json TEXT NOT NULL);
            CREATE INDEX team_run_project ON team_runs(project_id, sequence);
            PRAGMA user_version = 4;
          `);
          if (current < 5) this.#db.exec(`
            CREATE TABLE job_authority (job_id TEXT PRIMARY KEY REFERENCES jobs(id), generation INTEGER NOT NULL, reason TEXT, stop_json TEXT);
            INSERT INTO job_authority SELECT id, 1, NULL, NULL FROM jobs;
            CREATE TABLE job_attempts (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, job_id TEXT NOT NULL REFERENCES jobs(id), record_json TEXT NOT NULL);
            CREATE INDEX job_attempt_job ON job_attempts(job_id, sequence);
            CREATE TABLE job_reconciliation (id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
            PRAGMA user_version = 5;
          `);
          if (current < 6) this.#db.exec(`
            CREATE TABLE telegram_binding (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              revision INTEGER NOT NULL CHECK (revision > 0),
              state TEXT NOT NULL CHECK (state IN ('unbound', 'pending', 'bound')),
              telegram_user_id INTEGER, telegram_chat_id INTEGER,
              username_hint TEXT, challenge_nonce TEXT, challenge_expires_at INTEGER,
              bound_at INTEGER, proof_json TEXT NOT NULL
            );
            INSERT INTO telegram_binding VALUES (1, 1, 'unbound', NULL, NULL, NULL, NULL, NULL, NULL, '{}');
            CREATE TABLE telegram_poll (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              next_offset INTEGER NOT NULL CHECK (next_offset >= 0),
              last_poll_at INTEGER, last_update_id INTEGER,
              gap_state TEXT NOT NULL CHECK (gap_state IN ('none', 'possible_missing_inputs')),
              gap_noticed_at INTEGER, gap_reason TEXT
            );
            INSERT INTO telegram_poll VALUES (1, 0, NULL, NULL, 'none', NULL, NULL);
            CREATE TABLE telegram_inbox (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              update_id INTEGER NOT NULL UNIQUE,
              telegram_user_id INTEGER, telegram_chat_id INTEGER,
              message_id INTEGER, callback_id TEXT,
              content_kind TEXT NOT NULL,
              classification TEXT NOT NULL,
              binding_revision INTEGER NOT NULL,
              text_content TEXT, raw_json TEXT NOT NULL,
              status TEXT NOT NULL CHECK (status IN ('persisted', 'processing', 'processed', 'failed')),
              failure_reason TEXT,
              process_attempts INTEGER NOT NULL CHECK (process_attempts >= 0),
              committed_at INTEGER NOT NULL,
              processed_at INTEGER
            );
            CREATE INDEX telegram_inbox_status ON telegram_inbox(status, sequence);
            CREATE INDEX telegram_inbox_class ON telegram_inbox(classification, sequence);
            PRAGMA user_version = 6;
          `);
          if (current < 7) this.#db.exec(`
            CREATE TABLE delivery_reports (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id), record_json TEXT NOT NULL
            );
            CREATE INDEX delivery_report_project ON delivery_reports(project_id);
            CREATE TABLE delivery_intents (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, dedupe_key TEXT NOT NULL UNIQUE,
              project_id TEXT NOT NULL REFERENCES projects(id), record_json TEXT NOT NULL
            );
            CREATE INDEX delivery_intent_project ON delivery_intents(project_id, sequence);
            CREATE TABLE delivery_attempts (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              intent_id TEXT NOT NULL REFERENCES delivery_intents(id), record_json TEXT NOT NULL
            );
            CREATE INDEX delivery_attempt_intent ON delivery_attempts(intent_id, sequence);
            CREATE TABLE delivery_worker (
              id INTEGER PRIMARY KEY CHECK (id = 1), token TEXT NOT NULL, pid INTEGER NOT NULL CHECK (pid > 0)
            );
            PRAGMA user_version = 7;
          `);
          if (current < 8) this.#db.exec(`
            CREATE TABLE coordinator_syntheses (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL,
              discussion_id TEXT NOT NULL,
              job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
              context_id TEXT NOT NULL UNIQUE REFERENCES team_contexts(id),
              base_revision INTEGER NOT NULL CHECK (base_revision >= 0),
              state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'complete', 'incomplete', 'failed', 'cancelled')),
              reason TEXT,
              record_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id)
            );
            CREATE INDEX coordinator_synthesis_discussion ON coordinator_syntheses(discussion_id, created_at);
            CREATE TABLE decision_proposals (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL,
              discussion_id TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK (revision > 0),
              synthesis_id TEXT NOT NULL REFERENCES coordinator_syntheses(id),
              record_json TEXT NOT NULL,
              source_id TEXT NOT NULL REFERENCES sources(id),
              source_revision INTEGER NOT NULL CHECK (source_revision > 0),
              source_generation INTEGER NOT NULL CHECK (source_generation > 0),
              created_at INTEGER NOT NULL,
              UNIQUE (discussion_id, revision),
              FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id)
            );
            CREATE INDEX decision_proposal_topic ON decision_proposals(project_id, topic_id, created_at);
            CREATE TABLE owner_decisions (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL,
              proposal_id TEXT NOT NULL REFERENCES decision_proposals(id),
              proposal_revision INTEGER NOT NULL CHECK (proposal_revision > 0),
              revision INTEGER NOT NULL CHECK (revision > 0),
              actor_id TEXT NOT NULL CHECK (actor_id = 'owner'),
              channel TEXT NOT NULL CHECK (channel = 'web'),
              option_id TEXT,
              conclusion TEXT NOT NULL,
              rationale TEXT NOT NULL,
              source_links_json TEXT NOT NULL,
              superseded_by TEXT,
              created_at INTEGER NOT NULL,
              UNIQUE (project_id, topic_id, revision),
              FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id)
            );
            CREATE INDEX owner_decision_topic ON owner_decisions(project_id, topic_id, created_at);
            CREATE UNIQUE INDEX owner_decision_live ON owner_decisions(project_id, topic_id) WHERE superseded_by IS NULL;
            PRAGMA user_version = 8;
          `);
          if (current < 9) this.#db.exec(`
            CREATE TABLE tasks (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL,
              state TEXT NOT NULL CHECK (state IN ('proposed', 'accepted', 'dismissed', 'cancelled')),
              proposal_revision INTEGER NOT NULL CHECK (proposal_revision > 0),
              current_proposal_id TEXT NOT NULL,
              title TEXT NOT NULL,
              summary TEXT NOT NULL,
              source_id TEXT NOT NULL REFERENCES sources(id),
              source_revision INTEGER NOT NULL CHECK (source_revision > 0),
              source_generation INTEGER NOT NULL CHECK (source_generation > 0),
              origin TEXT NOT NULL CHECK (origin IN ('owner', 'validated_output')),
              acceptance_json TEXT,
              closed_reason TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id)
            );
            CREATE INDEX task_project ON tasks(project_id, updated_at, id);
            CREATE TABLE task_proposals (
              id TEXT PRIMARY KEY,
              task_id TEXT NOT NULL REFERENCES tasks(id),
              project_id TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK (revision > 0),
              title TEXT NOT NULL,
              summary TEXT NOT NULL,
              source_id TEXT NOT NULL REFERENCES sources(id),
              source_revision INTEGER NOT NULL CHECK (source_revision > 0),
              source_generation INTEGER NOT NULL CHECK (source_generation > 0),
              origin TEXT NOT NULL CHECK (origin IN ('owner', 'validated_output')),
              created_at INTEGER NOT NULL,
              UNIQUE (task_id, revision)
            );
            CREATE INDEX task_proposal_project ON task_proposals(project_id, task_id);
            CREATE TABLE task_events (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id TEXT NOT NULL REFERENCES tasks(id),
              project_id TEXT NOT NULL,
              kind TEXT NOT NULL CHECK (kind IN ('proposed', 'edited', 'dismissed', 'accepted', 'cancelled')),
              actor_id TEXT NOT NULL CHECK (actor_id = 'owner'),
              channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram')),
              proposal_id TEXT,
              proposal_revision INTEGER,
              reason TEXT,
              created_at INTEGER NOT NULL
            );
            CREATE INDEX task_event_task ON task_events(task_id, sequence);
            PRAGMA user_version = 9;
          `);
          if (current < 10) {
            const defaultPolicy = '{"kind":"owner_confirmed","workType":"user_task"}';
            this.#db.exec(`
            CREATE TABLE tasks_v10 (
              id TEXT PRIMARY KEY,
              task_revision INTEGER NOT NULL CHECK (task_revision > 0),
              project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL,
              state TEXT NOT NULL CHECK (state IN ('proposed', 'accepted', 'ready_for_review', 'completed', 'dismissed', 'cancelled', 'superseded')),
              proposal_revision INTEGER NOT NULL CHECK (proposal_revision > 0),
              current_proposal_id TEXT NOT NULL,
              title TEXT NOT NULL,
              summary TEXT NOT NULL,
              source_id TEXT NOT NULL,
              source_revision INTEGER NOT NULL CHECK (source_revision > 0),
              source_generation INTEGER NOT NULL CHECK (source_generation > 0),
              origin TEXT NOT NULL CHECK (origin IN ('owner', 'validated_output')),
              acceptance_json TEXT,
              closed_reason TEXT,
              completion_policy_json TEXT NOT NULL,
              completion_json TEXT,
              pending_reason_json TEXT,
              superseded_by TEXT,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id),
              FOREIGN KEY (source_id) REFERENCES sources(id)
            );
            INSERT INTO tasks_v10 (
              id, task_revision, project_id, topic_id, state, proposal_revision, current_proposal_id, title, summary,
              source_id, source_revision, source_generation, origin, acceptance_json, closed_reason,
              completion_policy_json, completion_json, pending_reason_json, superseded_by, created_at, updated_at
            )
            SELECT id, proposal_revision, project_id, topic_id, state, proposal_revision, current_proposal_id, title, summary,
              source_id, source_revision, source_generation, origin, acceptance_json, closed_reason,
              '${defaultPolicy}', NULL, NULL, NULL, created_at, updated_at
            FROM tasks;
            DROP TABLE tasks;
            ALTER TABLE tasks_v10 RENAME TO tasks;
            CREATE INDEX task_project ON tasks(project_id, updated_at, id);
            CREATE TABLE task_events_v10 (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              task_id TEXT NOT NULL REFERENCES tasks(id),
              project_id TEXT NOT NULL,
              kind TEXT NOT NULL CHECK (kind IN ('proposed', 'edited', 'dismissed', 'accepted', 'cancelled', 'completed', 'reopened', 'superseded', 'policy_changed', 'ready_for_review')),
              actor_id TEXT NOT NULL CHECK (actor_id = 'owner'),
              channel TEXT NOT NULL CHECK (channel IN ('web', 'telegram')),
              proposal_id TEXT,
              proposal_revision INTEGER,
              reason TEXT,
              created_at INTEGER NOT NULL
            );
            INSERT INTO task_events_v10 (sequence, task_id, project_id, kind, actor_id, channel, proposal_id, proposal_revision, reason, created_at)
            SELECT sequence, task_id, project_id, kind, actor_id, channel, proposal_id, proposal_revision, reason, created_at FROM task_events;
            DROP TABLE task_events;
            ALTER TABLE task_events_v10 RENAME TO task_events;
            CREATE INDEX task_event_task ON task_events(task_id, sequence);
            CREATE TABLE task_evidence_artifacts (
              id TEXT PRIMARY KEY,
              proposal_id TEXT NOT NULL REFERENCES task_proposals(id),
              task_id TEXT NOT NULL REFERENCES tasks(id),
              project_id TEXT NOT NULL REFERENCES projects(id),
              revision INTEGER NOT NULL CHECK (revision > 0),
              work_type TEXT NOT NULL CHECK (work_type IN ('analysis', 'review', 'reminder')),
              outcome TEXT NOT NULL CHECK (outcome IN ('complete', 'partial', 'failed', 'unknown')),
              delivery_state TEXT CHECK (delivery_state IN ('sent', 'failed', 'unknown')),
              source_id TEXT NOT NULL,
              source_revision INTEGER NOT NULL CHECK (source_revision > 0),
              source_generation INTEGER NOT NULL CHECK (source_generation > 0),
              record_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              UNIQUE (task_id, revision),
              FOREIGN KEY (task_id) REFERENCES tasks(id)
            );
            CREATE INDEX task_evidence_project ON task_evidence_artifacts(project_id, task_id, revision);
            PRAGMA user_version = 10;
          `);
          }
          if (current < 11) this.#db.exec(`
            CREATE TABLE memory_decision_sources (
              decision_id TEXT PRIMARY KEY REFERENCES owner_decisions(id), project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL, decision_revision INTEGER NOT NULL, source_id TEXT NOT NULL UNIQUE REFERENCES sources(id),
              source_revision INTEGER NOT NULL, source_generation INTEGER NOT NULL,
              FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id)
            );
            CREATE TABLE memory_extractions (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              project_id TEXT NOT NULL REFERENCES projects(id), job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
              source_id TEXT NOT NULL REFERENCES sources(id), source_revision INTEGER NOT NULL,
              source_generation INTEGER NOT NULL, extractor TEXT NOT NULL, policy INTEGER NOT NULL,
              record_json TEXT NOT NULL,
              UNIQUE(project_id, source_id, source_revision, source_generation, extractor, policy)
            );
            CREATE INDEX memory_extraction_project ON memory_extractions(project_id, sequence);
            CREATE TABLE memory_claims (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              project_id TEXT NOT NULL REFERENCES projects(id), extraction_id TEXT NOT NULL REFERENCES memory_extractions(id),
              revision INTEGER NOT NULL CHECK(revision > 0), generation INTEGER NOT NULL CHECK(generation > 0),
              record_json TEXT NOT NULL
            );
            CREATE INDEX memory_claim_project ON memory_claims(project_id, sequence);
            PRAGMA user_version = 11;
          `);
          if (current < 11) {
            for (const decision of this.#tx.all<{ id: string; projectId: string; topicId: string; revision: number; conclusion: string; rationale: string; createdAt: number; supersededBy: string | null }>(
              "SELECT id, project_id AS projectId, topic_id AS topicId, revision, conclusion, rationale, created_at AS createdAt, superseded_by AS supersededBy FROM owner_decisions")) {
              commitDecisionMemorySource(this.#tx, decision);
              if (decision.supersededBy) retireDecisionMemorySource(this.#tx, decision.projectId, decision.id);
            }
          }
          if (current < 12) this.#db.exec(`
            CREATE TABLE memory_contexts (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              project_id TEXT NOT NULL REFERENCES projects(id), topic_id TEXT NOT NULL,
              owner_kind TEXT NOT NULL CHECK(owner_kind IN ('discussion', 'synthesis')), owner_id TEXT NOT NULL,
              record_json TEXT NOT NULL,
              UNIQUE(owner_kind, owner_id),
              FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id)
            );
            CREATE TABLE memory_context_entries (
              context_id TEXT NOT NULL REFERENCES memory_contexts(id), origin_project_id TEXT NOT NULL REFERENCES projects(id),
              kind TEXT NOT NULL CHECK(kind IN ('source', 'claim', 'task', 'decision')), entry_id TEXT NOT NULL,
              revision INTEGER NOT NULL, generation INTEGER,
              PRIMARY KEY (context_id, kind, entry_id)
            );
            CREATE INDEX memory_context_entry_lookup ON memory_context_entries(kind, entry_id);
            CREATE TABLE memory_derived_sources (
              source_id TEXT PRIMARY KEY REFERENCES sources(id), project_id TEXT NOT NULL REFERENCES projects(id),
              context_id TEXT NOT NULL REFERENCES memory_contexts(id), depth INTEGER NOT NULL CHECK(depth > 0)
            );
            PRAGMA user_version = 12;
          `);
          if (current < 13) this.#db.exec(`
            CREATE TABLE memory_corrections (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
              claim_id TEXT NOT NULL REFERENCES memory_claims(id), record_json TEXT NOT NULL
            );
            CREATE INDEX memory_correction_project ON memory_corrections(project_id, claim_id);
            PRAGMA user_version = 13;
          `);
          if (current < 14) this.#db.exec(`
            CREATE TABLE memory_suppressions (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
              claim_id TEXT NOT NULL REFERENCES memory_claims(id), record_json TEXT NOT NULL
            );
            CREATE INDEX memory_suppression_project ON memory_suppressions(project_id, claim_id);
            CREATE TABLE memory_suppressed_claims (
              suppression_id TEXT NOT NULL REFERENCES memory_suppressions(id),
              project_id TEXT NOT NULL REFERENCES projects(id),
              claim_id TEXT NOT NULL REFERENCES memory_claims(id),
              PRIMARY KEY (suppression_id, claim_id)
            );
            CREATE INDEX memory_suppressed_claim_lookup ON memory_suppressed_claims(claim_id);
            CREATE TABLE memory_suppressed_sources (
              suppression_id TEXT NOT NULL REFERENCES memory_suppressions(id),
              project_id TEXT NOT NULL REFERENCES projects(id),
              source_id TEXT NOT NULL REFERENCES sources(id),
              revision INTEGER NOT NULL CHECK (revision > 0),
              generation INTEGER NOT NULL CHECK (generation > 0),
              PRIMARY KEY (suppression_id, source_id, revision, generation)
            );
            CREATE INDEX memory_suppressed_source_lookup ON memory_suppressed_sources(source_id, revision, generation);
            PRAGMA user_version = 14;
          `);
          if (current < 15) this.#db.exec(`
            CREATE TABLE job_schedules (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              project_id TEXT NOT NULL REFERENCES projects(id), record_json TEXT NOT NULL
            );
            CREATE INDEX job_schedule_project ON job_schedules(project_id, sequence);
            CREATE TABLE job_schedule_occurrences (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              schedule_id TEXT NOT NULL REFERENCES job_schedules(id), revision INTEGER NOT NULL CHECK(revision > 0),
              scheduled_instant INTEGER NOT NULL, job_id TEXT NOT NULL UNIQUE REFERENCES jobs(id),
              record_json TEXT NOT NULL,
              UNIQUE(schedule_id, revision, scheduled_instant)
            );
            CREATE INDEX job_schedule_occurrence_schedule ON job_schedule_occurrences(schedule_id, scheduled_instant);
            CREATE TABLE memory_contexts_v15 (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
              project_id TEXT NOT NULL REFERENCES projects(id), topic_id TEXT NOT NULL,
              owner_kind TEXT NOT NULL CHECK(owner_kind IN ('discussion', 'synthesis', 'schedule')), owner_id TEXT NOT NULL,
              record_json TEXT NOT NULL,
              UNIQUE(owner_kind, owner_id),
              FOREIGN KEY (project_id, topic_id) REFERENCES topics(project_id, id)
            );
            INSERT INTO memory_contexts_v15 SELECT sequence, id, project_id, topic_id, owner_kind, owner_id, record_json FROM memory_contexts;
            DROP TABLE memory_contexts;
            ALTER TABLE memory_contexts_v15 RENAME TO memory_contexts;
            PRAGMA user_version = 15;
          `);
          if (current < 16) this.#db.exec(`
            CREATE TABLE IF NOT EXISTS ops_backups (
              id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, record_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS ops_backup_created ON ops_backups(created_at);
            PRAGMA user_version = 16;
          `);
          if (current < 17) this.#db.exec(`
            CREATE TABLE IF NOT EXISTS deletion_previews (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
              expires_at INTEGER NOT NULL, record_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS deletion_preview_project ON deletion_previews(project_id, expires_at);
            CREATE TABLE IF NOT EXISTS deletion_ledger (
              id TEXT PRIMARY KEY, operation_id TEXT NOT NULL, project_id TEXT NOT NULL REFERENCES projects(id),
              kind TEXT NOT NULL CHECK (kind IN ('source', 'claim')),
              source_id TEXT, claim_id TEXT,
              revision INTEGER NOT NULL CHECK (revision > 0), generation INTEGER NOT NULL CHECK (generation > 0),
              deleted_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS deletion_ledger_lookup ON deletion_ledger(kind, source_id, claim_id);
            CREATE INDEX IF NOT EXISTS deletion_ledger_operation ON deletion_ledger(operation_id);
            CREATE TABLE IF NOT EXISTS deletion_operations (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
              preview_id TEXT NOT NULL, state TEXT NOT NULL CHECK (state IN ('pending', 'complete', 'failed', 'blocked')),
              attempts INTEGER NOT NULL CHECK (attempts >= 0), record_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS deletion_operation_preview ON deletion_operations(preview_id);
            CREATE INDEX IF NOT EXISTS deletion_operation_project ON deletion_operations(project_id);
            PRAGMA user_version = 17;
          `);
          if (current < 18) this.#db.exec(`
            CREATE TABLE IF NOT EXISTS export_artifacts (
              id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id),
              created_at INTEGER NOT NULL, record_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS export_artifact_project ON export_artifacts(project_id, created_at);
            PRAGMA user_version = 18;
          `);
          if (current < 19) this.#db.exec(`
            CREATE TABLE IF NOT EXISTS upgrade_journal (
              id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, state TEXT NOT NULL,
              record_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS upgrade_journal_state ON upgrade_journal(state, created_at);
            PRAGMA user_version = 19;
          `);
          if (current < 20) this.#db.exec(`
            CREATE TABLE IF NOT EXISTS restore_quarantines (
              id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, state TEXT NOT NULL,
              record_json TEXT NOT NULL
            );
            CREATE INDEX IF NOT EXISTS restore_quarantine_state ON restore_quarantines(state, created_at);
            PRAGMA user_version = 20;
          `);
          if (current < 21) this.#db.exec(`
            CREATE TABLE IF NOT EXISTS schway_native_refs (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              run_id TEXT NOT NULL UNIQUE,
              context_id TEXT NOT NULL,
              generation INTEGER NOT NULL CHECK (generation > 0),
              session_id TEXT NOT NULL,
              branch_id TEXT NOT NULL,
              state TEXT NOT NULL CHECK (state IN ('running', 'finished')),
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS schway_native_ref_context ON schway_native_refs(context_id, generation);
            PRAGMA user_version = 21;
          `);
          if (current < 22) {
            // PR02 report history: a candidate keeps every committed review (rerun, policy upgrade),
            // so the lazily created pr_reports table drops its candidate uniqueness, preserving rows.
            if (this.#tx.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pr_reports'")) this.#db.exec(`
              CREATE TABLE pr_reports_v22 (
                id TEXT PRIMARY KEY,
                candidate_id TEXT NOT NULL REFERENCES pr_candidates(id),
                project_id TEXT NOT NULL REFERENCES projects(id),
                monitor_id TEXT NOT NULL REFERENCES pr_monitors(id),
                status TEXT NOT NULL CHECK (status IN ('running', 'complete_clean', 'complete_findings', 'partial', 'incomplete', 'failed')),
                record_json TEXT NOT NULL
              );
              INSERT INTO pr_reports_v22 (rowid, id, candidate_id, project_id, monitor_id, status, record_json)
                SELECT rowid, id, candidate_id, project_id, monitor_id, status, record_json FROM pr_reports;
              DROP TABLE pr_reports;
              ALTER TABLE pr_reports_v22 RENAME TO pr_reports;
              CREATE INDEX IF NOT EXISTS pr_report_monitor ON pr_reports(project_id, monitor_id);
              CREATE INDEX IF NOT EXISTS pr_report_candidate ON pr_reports(candidate_id);
            `);
            this.#db.exec("PRAGMA user_version = 22;");
          }
          if (current < 23) this.#db.exec(`
            -- app.deletion_ledger/v1 installation lifecycle ledger (OPS02): append-only, identity-only
            -- deletion and suppression entries written by triggers in the same transaction as every
            -- deletion/forget commit. Installation-scoped: excluded from backup images and preserved
            -- from live on every activation, so a restore point can never roll it back.
            CREATE TABLE IF NOT EXISTS lifecycle_ledger (
              sequence INTEGER PRIMARY KEY AUTOINCREMENT,
              kind TEXT NOT NULL CHECK (kind IN ('deletion', 'suppression', 'suppressed_claim', 'suppressed_source')),
              entry_key TEXT NOT NULL UNIQUE,
              subject TEXT NOT NULL,
              project_id TEXT NOT NULL,
              record_json TEXT NOT NULL,
              recorded_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS lifecycle_ledger_subject ON lifecycle_ledger(kind, subject);
            CREATE TABLE IF NOT EXISTS lifecycle_checkpoint (
              id INTEGER PRIMARY KEY CHECK (id = 1), head INTEGER NOT NULL, count INTEGER NOT NULL,
              digest TEXT NOT NULL, written_at INTEGER NOT NULL, path TEXT NOT NULL
            );
            CREATE TRIGGER IF NOT EXISTS lifecycle_ledger_deletion AFTER INSERT ON deletion_ledger BEGIN
              INSERT OR IGNORE INTO lifecycle_ledger (kind, entry_key, subject, project_id, record_json, recorded_at) VALUES ('deletion', 'deletion:' || NEW.id,
                CASE NEW.kind WHEN 'source' THEN 'source:' || NEW.source_id || ':' || NEW.revision || ':' || NEW.generation ELSE 'claim:' || NEW.claim_id END,
                NEW.project_id,
                json_object('id', NEW.id, 'operationId', NEW.operation_id, 'projectId', NEW.project_id, 'kind', NEW.kind, 'sourceId', NEW.source_id,
                  'claimId', NEW.claim_id, 'revision', NEW.revision, 'generation', NEW.generation, 'deletedAt', NEW.deleted_at),
                NEW.deleted_at);
            END;
            CREATE TRIGGER IF NOT EXISTS lifecycle_ledger_suppression AFTER INSERT ON memory_suppressions BEGIN
              INSERT OR IGNORE INTO lifecycle_ledger (kind, entry_key, subject, project_id, record_json, recorded_at) VALUES ('suppression', 'suppression:' || NEW.id,
                'claim:' || NEW.claim_id, NEW.project_id,
                json_object('id', NEW.id, 'projectId', NEW.project_id, 'claimId', NEW.claim_id,
                  'fromRevision', json_extract(NEW.record_json, '$.fromRevision'), 'fromGeneration', json_extract(NEW.record_json, '$.fromGeneration'),
                  'createdAt', coalesce(json_extract(NEW.record_json, '$.createdAt'), 0)),
                coalesce(json_extract(NEW.record_json, '$.createdAt'), 0));
            END;
            CREATE TRIGGER IF NOT EXISTS lifecycle_ledger_suppressed_claim AFTER INSERT ON memory_suppressed_claims BEGIN
              INSERT OR IGNORE INTO lifecycle_ledger (kind, entry_key, subject, project_id, record_json, recorded_at) VALUES ('suppressed_claim',
                'suppressed_claim:' || NEW.suppression_id || ':' || NEW.claim_id, 'claim:' || NEW.claim_id, NEW.project_id,
                json_object('suppressionId', NEW.suppression_id, 'projectId', NEW.project_id, 'claimId', NEW.claim_id),
                coalesce((SELECT json_extract(record_json, '$.createdAt') FROM memory_suppressions WHERE id = NEW.suppression_id), 0));
            END;
            CREATE TRIGGER IF NOT EXISTS lifecycle_ledger_suppressed_source AFTER INSERT ON memory_suppressed_sources BEGIN
              INSERT OR IGNORE INTO lifecycle_ledger (kind, entry_key, subject, project_id, record_json, recorded_at) VALUES ('suppressed_source',
                'suppressed_source:' || NEW.suppression_id || ':' || NEW.source_id || ':' || NEW.revision || ':' || NEW.generation,
                'source:' || NEW.source_id || ':' || NEW.revision || ':' || NEW.generation, NEW.project_id,
                json_object('suppressionId', NEW.suppression_id, 'projectId', NEW.project_id, 'sourceId', NEW.source_id, 'revision', NEW.revision, 'generation', NEW.generation),
                coalesce((SELECT json_extract(record_json, '$.createdAt') FROM memory_suppressions WHERE id = NEW.suppression_id), 0));
            END;
            -- Backfill existing history in commit order so an upgraded installation's ledger covers it.
            INSERT OR IGNORE INTO lifecycle_ledger (kind, entry_key, subject, project_id, record_json, recorded_at)
              SELECT 'deletion', 'deletion:' || id,
                CASE kind WHEN 'source' THEN 'source:' || source_id || ':' || revision || ':' || generation ELSE 'claim:' || claim_id END, project_id,
                json_object('id', id, 'operationId', operation_id, 'projectId', project_id, 'kind', kind, 'sourceId', source_id,
                  'claimId', claim_id, 'revision', revision, 'generation', generation, 'deletedAt', deleted_at), deleted_at
              FROM deletion_ledger ORDER BY rowid;
            INSERT OR IGNORE INTO lifecycle_ledger (kind, entry_key, subject, project_id, record_json, recorded_at)
              SELECT 'suppression', 'suppression:' || id, 'claim:' || claim_id, project_id,
                json_object('id', id, 'projectId', project_id, 'claimId', claim_id,
                  'fromRevision', json_extract(record_json, '$.fromRevision'), 'fromGeneration', json_extract(record_json, '$.fromGeneration'),
                  'createdAt', coalesce(json_extract(record_json, '$.createdAt'), 0)), coalesce(json_extract(record_json, '$.createdAt'), 0)
              FROM memory_suppressions ORDER BY rowid;
            INSERT OR IGNORE INTO lifecycle_ledger (kind, entry_key, subject, project_id, record_json, recorded_at)
              SELECT 'suppressed_claim', 'suppressed_claim:' || c.suppression_id || ':' || c.claim_id, 'claim:' || c.claim_id, c.project_id,
                json_object('suppressionId', c.suppression_id, 'projectId', c.project_id, 'claimId', c.claim_id),
                coalesce(json_extract(s.record_json, '$.createdAt'), 0)
              FROM memory_suppressed_claims c LEFT JOIN memory_suppressions s ON s.id = c.suppression_id ORDER BY c.rowid;
            INSERT OR IGNORE INTO lifecycle_ledger (kind, entry_key, subject, project_id, record_json, recorded_at)
              SELECT 'suppressed_source', 'suppressed_source:' || c.suppression_id || ':' || c.source_id || ':' || c.revision || ':' || c.generation,
                'source:' || c.source_id || ':' || c.revision || ':' || c.generation, c.project_id,
                json_object('suppressionId', c.suppression_id, 'projectId', c.project_id, 'sourceId', c.source_id, 'revision', c.revision, 'generation', c.generation),
                coalesce(json_extract(s.record_json, '$.createdAt'), 0)
              FROM memory_suppressed_sources c LEFT JOIN memory_suppressions s ON s.id = c.suppression_id ORDER BY c.rowid;
            PRAGMA user_version = 23;
          `);
          // A populated rebuilt graph must retain every reference; empty legacy fixture stores have no task graph to check.
          if (this.#tx.get("SELECT 1 FROM tasks LIMIT 1") && this.#tx.all("PRAGMA foreign_key_check").length) throw new Error("Migration foreign key check failed");
          if (current < 24) this.#db.exec(`
            -- ui.preferences/v1 (UX01): the owner's interface theme and language. One row, owner
            -- configuration without credentials; absent until the owner first saves a choice.
            CREATE TABLE IF NOT EXISTS owner_preferences (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              revision INTEGER NOT NULL CHECK (revision > 0),
              theme TEXT NOT NULL CHECK (theme IN ('system', 'dark', 'light')),
              language TEXT NOT NULL CHECK (language IN ('auto', 'th', 'en')),
              updated_at INTEGER NOT NULL
            );
            PRAGMA user_version = 24;
          `);
          if (current < 25) this.#db.exec(`
            -- app.persona/v1 (BOT01): immutable owner-authored persona revisions; the highest is current.
            CREATE TABLE IF NOT EXISTS persona_revisions (
              revision INTEGER PRIMARY KEY CHECK (revision > 0),
              record_json TEXT NOT NULL,
              created_at INTEGER NOT NULL
            );
            -- app.jit_reply/v1 (BOT01): one identity-only row per owner message. An admitted reply names its
            -- team_runs record (kind jit_reply); otherwise reason says why no job was admitted. cursor is the
            -- installation-wide change order the topic event stream replays from.
            CREATE TABLE IF NOT EXISTS jit_replies (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL REFERENCES topics(id),
              message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
              run_id TEXT UNIQUE REFERENCES team_runs(id),
              -- The committed reply message, set when the reply commits; lets a page resolve replies by either message.
              reply_message_id TEXT UNIQUE REFERENCES messages(id),
              -- The committed reply's output source, the start of its lineage for later replies and forgets.
              reply_source_id TEXT UNIQUE REFERENCES sources(id),
              reason TEXT CHECK (reason IN ('no_route', 'scheduler_unavailable', 'queue_full', 'context_too_large')),
              cursor INTEGER NOT NULL UNIQUE,
              created_at INTEGER NOT NULL,
              CHECK ((run_id IS NULL) = (reason IS NOT NULL))
            );
            CREATE INDEX IF NOT EXISTS jit_reply_topic ON jit_replies(project_id, topic_id, cursor);
            -- Identity-only manifest citations of each reply (app.memory_suppression/v1 lineage); never text.
            CREATE TABLE IF NOT EXISTS jit_reply_sources (
              reply_id TEXT NOT NULL REFERENCES jit_replies(id),
              project_id TEXT NOT NULL REFERENCES projects(id),
              source_id TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK (revision > 0),
              generation INTEGER NOT NULL CHECK (generation > 0),
              PRIMARY KEY (reply_id, source_id, revision, generation)
            );
            CREATE INDEX IF NOT EXISTS jit_reply_source_lineage ON jit_reply_sources(source_id, revision, generation);
            PRAGMA user_version = 25;
          `);
          if (current < 26) this.#db.exec(`
            -- app.setup/v1 (BOT02): owner setup progress ("ตั้งจิต"), one row; absent until the first setup command.
            -- Configuration only: the route, persona and language it sets live in their own tables.
            CREATE TABLE IF NOT EXISTS setup_state (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              revision INTEGER NOT NULL CHECK (revision > 0),
              record_json TEXT NOT NULL,
              completed_at INTEGER
            );
            -- app.general_space/v1 (BOT02, ADR 0031): the installation's one system project of kind general, its
            -- first topic and the setup greeting. The singleton id and the unique project allow exactly one.
            CREATE TABLE IF NOT EXISTS general_space (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
              topic_id TEXT NOT NULL REFERENCES topics(id),
              greeting_message_id TEXT UNIQUE REFERENCES messages(id),
              created_at INTEGER NOT NULL
            );
            PRAGMA user_version = 26;
          `);
          // Every change to a reply's job (admission, reservation, wait, stop, deadline, commit) moves the reply to
          // the end of the change order, so the event stream replays transitions the queue makes alone. Every real
          // store has jobs (schema 3); partial legacy fixtures without it have no jobs to watch.
          if (current < 25 && this.#tx.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'jobs'")) this.#db.exec(`
            CREATE TRIGGER IF NOT EXISTS jit_reply_job_change AFTER UPDATE OF state, record_json ON jobs
            WHEN json_extract(NEW.record_json, '$.type') = 'team.jit-reply' AND NEW.record_json IS NOT OLD.record_json BEGIN
              UPDATE jit_replies SET cursor = (SELECT coalesce(max(cursor), 0) + 1 FROM jit_replies)
              WHERE run_id = (SELECT id FROM team_runs WHERE job_id = NEW.id);
            END;
          `);
          if (current < 27) this.#db.exec(`
            -- app.dispatch_allowance/v1 (BOT04): immutable owner-set allowance revisions per project; the highest is
            -- current. No row means the product default (revision 0).
            CREATE TABLE IF NOT EXISTS dispatch_allowance_revisions (
              project_id TEXT NOT NULL REFERENCES projects(id),
              revision INTEGER NOT NULL CHECK (revision > 0),
              enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
              max_roles INTEGER NOT NULL CHECK (max_roles BETWEEN 1 AND 100),
              created_at INTEGER NOT NULL,
              PRIMARY KEY (project_id, revision)
            );
            -- One dispatch proposal per Jit reply that named specialists. Identities, state and validated role ids
            -- only; model text is never stored here. admitted rows name the allowance revision that admitted them.
            CREATE TABLE IF NOT EXISTS dispatch_proposals (
              id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL REFERENCES topics(id),
              reply_id TEXT NOT NULL UNIQUE REFERENCES jit_replies(id),
              revision INTEGER NOT NULL CHECK (revision > 0),
              state TEXT NOT NULL CHECK (state IN ('admitted', 'proposed', 'accepted', 'dismissed', 'empty')),
              admission TEXT CHECK (admission IN ('standing_allowance', 'owner')),
              allowance_revision INTEGER NOT NULL CHECK (allowance_revision >= 0),
              discussion_id TEXT UNIQUE REFERENCES team_runs(id),
              team_reply_id TEXT UNIQUE REFERENCES jit_replies(id),
              record_json TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL,
              CHECK ((discussion_id IS NULL) = (admission IS NULL))
            );
            CREATE INDEX IF NOT EXISTS dispatch_proposal_topic ON dispatch_proposals(project_id, topic_id, created_at);
            PRAGMA user_version = 27;
          `);
          if (current < 28) this.#db.exec(`
            -- app.topic_promotion/v1 (BOT05, ADR 0031): one row per promoted General space topic. Identities only: the
            -- origin topic at its exact revision, the continuation project and topic, and the continuation's first
            -- record (an identity-only external source and its message). An origin is promoted at most once.
            CREATE TABLE IF NOT EXISTS topic_promotions (
              id TEXT PRIMARY KEY,
              origin_project_id TEXT NOT NULL REFERENCES projects(id),
              origin_topic_id TEXT NOT NULL UNIQUE REFERENCES topics(id),
              origin_topic_revision INTEGER NOT NULL CHECK (origin_topic_revision > 0),
              origin_message_sequence INTEGER NOT NULL CHECK (origin_message_sequence >= 0),
              project_id TEXT NOT NULL UNIQUE REFERENCES projects(id),
              topic_id TEXT NOT NULL UNIQUE REFERENCES topics(id),
              link_message_id TEXT NOT NULL UNIQUE REFERENCES messages(id),
              link_source_id TEXT NOT NULL UNIQUE REFERENCES sources(id),
              link_source_revision INTEGER NOT NULL CHECK (link_source_revision > 0),
              link_source_generation INTEGER NOT NULL CHECK (link_source_generation > 0),
              reply_id TEXT NOT NULL REFERENCES jit_replies(id),
              proposal_id TEXT NOT NULL UNIQUE,
              proposal_revision INTEGER NOT NULL CHECK (proposal_revision > 0),
              created_at INTEGER NOT NULL,
              CHECK (project_id != origin_project_id)
            );
            -- Chat-first home (BOT05): a topic title derived from a chat's first message is a separate owner source;
            -- this lineage makes deleting that message delete the derived title too (app.data_lifecycle/v1).
            CREATE TABLE IF NOT EXISTS chat_title_sources (
              title_source_id TEXT PRIMARY KEY REFERENCES sources(id),
              project_id TEXT NOT NULL REFERENCES projects(id),
              topic_id TEXT NOT NULL UNIQUE REFERENCES topics(id),
              message_source_id TEXT NOT NULL REFERENCES sources(id)
            );
            CREATE INDEX IF NOT EXISTS chat_title_message ON chat_title_sources(message_source_id);
            -- app.general_space/v1: the General space is never deleted or pointed at another project or topic, and its
            -- project is never deleted, whatever path writes.
            CREATE TRIGGER IF NOT EXISTS general_space_keep BEFORE DELETE ON general_space BEGIN
              SELECT RAISE(ABORT, 'general_space_protected');
            END;
            CREATE TRIGGER IF NOT EXISTS general_space_fixed BEFORE UPDATE OF id, project_id, topic_id ON general_space
            WHEN NEW.id IS NOT OLD.id OR NEW.project_id IS NOT OLD.project_id OR NEW.topic_id IS NOT OLD.topic_id BEGIN
              SELECT RAISE(ABORT, 'general_space_protected');
            END;
            CREATE TRIGGER IF NOT EXISTS general_project_keep BEFORE DELETE ON projects
            WHEN EXISTS (SELECT 1 FROM general_space WHERE project_id = OLD.id) BEGIN
              SELECT RAISE(ABORT, 'general_space_protected');
            END;
            PRAGMA user_version = 28;
          `);
          if (current < 29) this.#db.exec(`
            -- app.local_api/v1 (REL06, ADR 0035): one installation-wide row; no row means the API is off (revision 0).
            -- Only the owner command local_api.set writes it. The token is never stored here: it lives in owner-only
            -- files under <data>/local-api/ and rotates on every start.
            CREATE TABLE IF NOT EXISTS local_api_settings (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              revision INTEGER NOT NULL CHECK (revision > 0),
              enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
              updated_at INTEGER NOT NULL
            );
            PRAGMA user_version = 29;
          `);
          if (current < 30) this.#db.exec(`
            -- app.schedule_feed/v1 (REL08, ADR 0035): the owner's one read-only .ics feed. Only the SHA-256 of the
            -- feed token is stored; the row is installation-scoped, so no backup image carries it and activation
            -- keeps the live row, and a restore can never bring back a rotated or turned-off feed URL.
            CREATE TABLE IF NOT EXISTS schedule_feed (
              id INTEGER PRIMARY KEY CHECK (id = 1),
              revision INTEGER NOT NULL CHECK (revision > 0),
              token_hash TEXT CHECK (token_hash IS NULL OR (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*')),
              include_purpose INTEGER NOT NULL CHECK (include_purpose IN (0, 1)),
              token_created_at INTEGER,
              updated_at INTEGER NOT NULL,
              CHECK ((token_hash IS NULL) = (token_created_at IS NULL))
            );
            PRAGMA user_version = 30;
          `);
          if (current < 31) this.#db.exec(`
            -- app.access_level/v1 (EXE01, ADR 0037): append-only owner revisions of a project's execution access level.
            -- No row means revision 0, which is 'read'. channel records which owner channel committed the revision.
            CREATE TABLE IF NOT EXISTS project_access_revisions (
              project_id TEXT NOT NULL REFERENCES projects(id),
              revision INTEGER NOT NULL CHECK (revision > 0),
              level TEXT NOT NULL CHECK (level IN ('read', 'workspace', 'full')),
              channel TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              PRIMARY KEY (project_id, revision)
            );
            -- Restrict-only per-role overrides; a NULL level clears the override so the role follows its project.
            CREATE TABLE IF NOT EXISTS role_access_overrides (
              project_id TEXT NOT NULL REFERENCES projects(id),
              role_id TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK (revision > 0),
              level TEXT CHECK (level IS NULL OR level IN ('read', 'workspace', 'full')),
              channel TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              PRIMARY KEY (project_id, role_id, revision)
            );
            -- The kill switch: append-only halt/resume revisions; the latest row decides whether execution is halted.
            CREATE TABLE IF NOT EXISTS execution_halts (
              project_id TEXT NOT NULL REFERENCES projects(id),
              revision INTEGER NOT NULL CHECK (revision > 0),
              halted INTEGER NOT NULL CHECK (halted IN (0, 1)),
              channel TEXT NOT NULL,
              reason TEXT,
              created_at INTEGER NOT NULL,
              PRIMARY KEY (project_id, revision)
            );
            PRAGMA user_version = 31;
          `);
          if (current < 32) this.#db.exec(`
            -- app.webhook_triggers/v1 (REL07, ADR 0035): one active signed trigger per PR monitor. The HMAC secret is
            -- stored only sealed (AES-256-GCM under an installation key file outside the database) and is nulled on
            -- delete, on monitor revoke and in every backup image. Receipts keep delivery identities only, never a payload.
            CREATE TABLE IF NOT EXISTS webhook_triggers (
              route_id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id),
              monitor_id TEXT NOT NULL,
              revision INTEGER NOT NULL CHECK (revision > 0),
              sealed_secret TEXT,
              created_at INTEGER NOT NULL,
              rotated_at INTEGER,
              revoked_at INTEGER,
              UNIQUE (monitor_id, revision)
            );
            CREATE UNIQUE INDEX IF NOT EXISTS webhook_trigger_active ON webhook_triggers(monitor_id) WHERE revoked_at IS NULL;
            CREATE TABLE IF NOT EXISTS webhook_receipts (
              route_id TEXT NOT NULL REFERENCES webhook_triggers(route_id),
              delivery_id TEXT NOT NULL,
              received_at INTEGER NOT NULL,
              PRIMARY KEY (route_id, delivery_id)
            );
            CREATE INDEX IF NOT EXISTS webhook_receipt_age ON webhook_receipts(received_at);
            -- Service-owned PR poll schedule: when the service loop next runs pollMonitorCatchUp for a monitor.
            -- A webhook may only move due_at earlier; the poll result stays the source of truth.
            CREATE TABLE IF NOT EXISTS pr_poll_due (
              monitor_id TEXT PRIMARY KEY,
              project_id TEXT NOT NULL REFERENCES projects(id),
              due_at INTEGER NOT NULL,
              last_polled_at INTEGER,
              woken_at INTEGER,
              -- The last poll that threw, as a bounded reason code only; cleared by the next successful poll.
              last_failure TEXT,
              last_failed_at INTEGER
            );
            PRAGMA user_version = 32;
          `);
          if (current < 33) this.#db.exec(`
            -- exec.box_runtime/v1 (EXE03, ADR 0036): append-only owner box resets; no row means box reset revision 0.
            -- The box itself, its workspace and its output never enter the database.
            CREATE TABLE IF NOT EXISTS execution_box_resets (
              project_id TEXT NOT NULL REFERENCES projects(id),
              revision INTEGER NOT NULL CHECK (revision > 0),
              wipe_workspace INTEGER NOT NULL CHECK (wipe_workspace IN (0, 1)),
              channel TEXT NOT NULL,
              created_at INTEGER NOT NULL,
              PRIMARY KEY (project_id, revision)
            );
            PRAGMA user_version = 33;
          `);
        }).immediate();
        this.#db.exec("PRAGMA foreign_keys = ON;");
      }
      this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      chmodSync(path, 0o600);
    } catch (error) {
      this.#db.close();
      throw error;
    }
  }

  /** Reads a synchronous projection from one consistent SQLite snapshot. */
  read<T>(query: (tx: AppTransaction) => T): T {
    return this.#db.transaction(() => {
      const result = query(this.#tx);
      if (result instanceof Promise) throw new Error("Application reads must be synchronous");
      return result;
    }).deferred();
  }

  /** Serializes a synchronous mutation and acknowledges only a successful SQLite commit. */
  transaction<T>(mutate: (tx: AppTransaction) => T): T {
    return this.#db.transaction(() => {
      const result = mutate(this.#tx);
      if (result instanceof Promise) throw new Error("Application transactions must be synchronous");
      return result;
    }).immediate();
  }

  /** Consistent app snapshot bytes after a WAL checkpoint; never copies a live WAL blindly. */
  snapshotBytes(): Uint8Array {
    try { this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* Checkpoint best-effort; serialize stays consistent. */ }
    return this.#db.serialize();
  }

  /**
   * Activates a staged image by atomically replacing this database file with
   * validated bytes and reopening the same store handle. The replacement image
   * is fully built before the live file changes: installation-scoped tables
   * ({@link installationScopedTables}: credentials and the managed backup
   * registry) are copied from the live store into the image, scheduler and
   * delivery claims are cleared, and the result is written to a sibling file,
   * fsynced and renamed over the live path. A crash therefore leaves either the
   * complete previous database or the complete activated one, never a mix.
   * Callers record durable activation intent first (ops.schema_migrations/v1
   * keeps it outside the database) and reconcile it on reopen.
   */
  swapFrom(sourcePath: string): void {
    const source = new Uint8Array(readFileSync(sourcePath));
    // Credentials never round-trip through images (ops.backup_manifest/v1):
    // the activated database keeps exactly the live installation's owner
    // verifier, browser sessions and login throttle. A live store without an
    // owner activates without one, so the owner runs credential setup.
    // The managed backup registry likewise stays the live installation's: an
    // image never rolls back which backups exist or which files they own.
    const preserved = installationScopedTables.map(table => {
      try { return { table, rows: this.#db.query(`SELECT * FROM "${table}" ORDER BY rowid`).all() as Record<string, SQLQueryBindings>[], present: true }; }
      catch { return { table, rows: [] as Record<string, SQLQueryBindings>[], present: false }; }
    });
    // A WAL-mode header cannot be deserialized; the reopened file re-enables WAL.
    if (source.length >= 20) { source[18] = 1; source[19] = 1; }
    let bytes: Uint8Array;
    const image = Database.deserialize(source, { strict: true });
    try {
      image.exec("PRAGMA foreign_keys = OFF;");
      const tables = new Set((image.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(r => r.name));
      image.transaction(() => {
        // Scheduler and delivery-worker claims belong to the pre-swap boot; a stale claim
        // must never authorize work after activation. The service reboots and reconciles.
        for (const table of ["job_scheduler", "delivery_worker"]) if (tables.has(table)) image.exec(`DELETE FROM "${table}"`);
        // Children before parents on delete (sessions reference owner), parents first on insert.
        for (const { table } of [...preserved].reverse()) if (tables.has(table)) image.exec(`DELETE FROM "${table}"`);
        for (const { table, rows, present } of preserved) {
          // Images predating the table get it (empty) from migration.
          if (!present || !tables.has(table)) continue;
          for (const row of rows) {
            const columns = Object.keys(row);
            image.query(`INSERT INTO "${table}" (${columns.map(c => `"${c}"`).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`)
              .run(...columns.map(c => row[c]!));
          }
        }
      })();
      bytes = image.serialize();
    } finally {
      image.close();
    }
    const temp = `${this.path}.swap-${crypto.randomUUID()}`;
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
    try { this.#db.exec("PRAGMA wal_checkpoint(TRUNCATE);"); } catch { /* Best-effort checkpoint before close. */ }
    this.#db.close();
    // Stale WAL siblings must never be replayed onto the replacement file.
    for (const suffix of ["-wal", "-shm"]) {
      try { rmSync(`${this.path}${suffix}`); } catch { /* Absent after a clean close. */ }
    }
    renameSync(temp, this.path);
    try { const dir = openSync(dirname(this.path), "r"); try { fsyncSync(dir); } finally { closeSync(dir); } } catch { /* Directory fsync is best-effort on some filesystems. */ }
    const reopened = new Database(this.path, { create: true, strict: true });
    try {
      reopened.exec("PRAGMA busy_timeout = 2000; PRAGMA foreign_keys = ON;");
      reopened.exec("PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;");
      chmodSync(this.path, 0o600);
    } catch (error) {
      reopened.close();
      throw error;
    }
    this.#db = reopened;
    this.#tx = {
      get: <T>(sql: string, ...args: SQLQueryBindings[]): T | null => this.#db.query(sql).get(...args) as T | null,
      all: <T>(sql: string, ...args: SQLQueryBindings[]): T[] => this.#db.query(sql).all(...args) as T[],
      run: (sql: string, ...args: SQLQueryBindings[]): void => { this.#db.query(sql).run(...args); },
    };
  }

  /** Closes this connection; committed commands remain available after reopening. */
  close(): void { this.#db.close(); }
}
