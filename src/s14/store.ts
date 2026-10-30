import { Database, type SQLQueryBindings } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../errors";
import type { AppTransaction } from "../store";

/** Fresh S14 SQLite format identity, distinct from every legacy user_version. */
export const s14ApplicationId = 0x4a495431;
/** Unreleased S14 schema version; unknown formats refuse before writable SQLite opens. */
export const s14SchemaVersion = 3;
/** Safe next action for incompatible stores; no original bytes or sidecars are opened by SQLite. */
export class FreshStateRequired extends AppError {
  readonly nextAction = "choose_a_separate_JIT_S14_DATABASE_keep_legacy_installation";
  constructor() { super("s14_fresh_state_required", 409); }
}
/** Checks a fixed SQLite header through ordinary reads before any write, chmod, worker or native host exists. */
export function inspectS14Store(path: string): "missing" | "s14" {
  if (!existsSync(path)) return "missing";
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 100) throw new FreshStateRequired();
  const fd = openSync(path, "r");
  let header: Buffer;
  try { header = Buffer.alloc(100); if (readSync(fd, header, 0, 100, 0) !== 100) throw new FreshStateRequired(); }
  finally { closeSync(fd); }
  if (header.toString("ascii", 0, 16) !== "SQLite format 3\0" || header.readUInt32BE(68) !== s14ApplicationId || ![2, s14SchemaVersion].includes(header.readUInt32BE(60))) throw new FreshStateRequired();
  return "s14";
}

/** Isolated project-free store; receipts and outbox intents commit under BEGIN IMMEDIATE together. */
export class S14Store {
  #db: Database;
  #tx: AppTransaction;
  constructor(readonly path: string) {
    const state = inspectS14Store(path);
    if (state === "missing") {
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      closeSync(openSync(path, "wx", 0o600));
    }
    this.#db = new Database(path, { create: false, strict: true });
    this.#tx = {
      get: <T>(sql: string, ...args: SQLQueryBindings[]) => this.#db.query(sql).get(...args) as T | null,
      all: <T>(sql: string, ...args: SQLQueryBindings[]) => this.#db.query(sql).all(...args) as T[],
      run: (sql: string, ...args: SQLQueryBindings[]) => { this.#db.query(sql).run(...args); },
    };
    try {
      this.#db.exec("PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA secure_delete=ON");
      if (state === "missing") this.#db.transaction(() => this.#db.exec(`
        CREATE TABLE owner (id TEXT PRIMARY KEY CHECK(id='owner'), password_hash TEXT NOT NULL, generation INTEGER NOT NULL);
        CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, generation INTEGER NOT NULL, expires_at INTEGER NOT NULL);
        CREATE TABLE login_throttle (id INTEGER PRIMARY KEY CHECK(id=1), window_start INTEGER NOT NULL, attempts INTEGER NOT NULL);
        CREATE TABLE installation (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, profile_json TEXT);
        INSERT INTO installation VALUES (1,0,NULL);
        CREATE TABLE bots (id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
        CREATE TABLE conversations (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL REFERENCES bots(id), revision INTEGER NOT NULL);
        CREATE TABLE messages (sequence INTEGER PRIMARY KEY, id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL REFERENCES conversations(id), record_json TEXT NOT NULL);
        CREATE TABLE bot_proposals (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), message_id TEXT NOT NULL REFERENCES messages(id), record_json TEXT NOT NULL);
        CREATE TABLE proposal_versions (proposal_id TEXT NOT NULL REFERENCES bot_proposals(id), revision INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(proposal_id,revision));
        CREATE TABLE reply_outbox (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), message_id TEXT NOT NULL UNIQUE REFERENCES messages(id), record_json TEXT NOT NULL);
        CREATE TABLE command_receipts (owner_id TEXT NOT NULL REFERENCES owner(id), request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL, committed_at INTEGER NOT NULL, PRIMARY KEY(owner_id,request_id));
        CREATE TABLE audit (sequence INTEGER PRIMARY KEY, kind TEXT NOT NULL, request_id TEXT NOT NULL UNIQUE, committed_at INTEGER NOT NULL);
        CREATE TABLE work_items (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), record_json TEXT NOT NULL);
        CREATE TABLE work_grants (id TEXT PRIMARY KEY, work_id TEXT NOT NULL UNIQUE REFERENCES work_items(id), record_json TEXT NOT NULL);
        CREATE TABLE grant_state (grant_id TEXT PRIMARY KEY REFERENCES work_grants(id), generation INTEGER NOT NULL, revoked INTEGER NOT NULL CHECK(revoked IN (0,1)));
        CREATE TABLE grant_usage (grant_id TEXT PRIMARY KEY REFERENCES work_grants(id), attempts INTEGER NOT NULL, steps INTEGER NOT NULL, calls INTEGER NOT NULL, output_bytes INTEGER NOT NULL);
        CREATE TABLE work_queue (work_id TEXT PRIMARY KEY REFERENCES work_items(id), state TEXT NOT NULL CHECK(state IN ('queued','claimed','blocked')));
        CREATE TABLE work_attempts (id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES work_items(id), request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, record_json TEXT NOT NULL, UNIQUE(work_id,request_id));
        CREATE TABLE attempt_usage (attempt_id TEXT PRIMARY KEY REFERENCES work_attempts(id), calls INTEGER NOT NULL);
        CREATE TABLE work_results (attempt_id TEXT PRIMARY KEY REFERENCES work_attempts(id), work_id TEXT NOT NULL REFERENCES work_items(id), content TEXT NOT NULL, committed_at INTEGER NOT NULL);
        CREATE TABLE effects (id TEXT PRIMARY KEY, work_id TEXT NOT NULL REFERENCES work_items(id), attempt_id TEXT NOT NULL REFERENCES work_attempts(id), request_id TEXT NOT NULL, payload_hash TEXT NOT NULL, record_json TEXT NOT NULL, UNIQUE(attempt_id,request_id));
        CREATE TABLE effect_versions (effect_id TEXT NOT NULL REFERENCES effects(id), revision INTEGER NOT NULL, record_json TEXT NOT NULL, PRIMARY KEY(effect_id,revision));
        CREATE TRIGGER immutable_grant BEFORE UPDATE ON work_grants BEGIN SELECT RAISE(ABORT,'immutable_grant'); END;
        CREATE TRIGGER immutable_attempt BEFORE UPDATE ON work_attempts WHEN json_extract(NEW.record_json,'$.snapshot') IS NOT json_extract(OLD.record_json,'$.snapshot') BEGIN SELECT RAISE(ABORT,'immutable_attempt'); END;
        CREATE TRIGGER immutable_effect_action BEFORE UPDATE ON effects WHEN json_extract(NEW.record_json,'$.revision') = json_extract(OLD.record_json,'$.revision') AND (json_extract(NEW.record_json,'$.action') IS NOT json_extract(OLD.record_json,'$.action') OR json_extract(NEW.record_json,'$.actionHash') IS NOT json_extract(OLD.record_json,'$.actionHash') OR json_extract(NEW.record_json,'$.expiresAt') IS NOT json_extract(OLD.record_json,'$.expiresAt')) BEGIN SELECT RAISE(ABORT,'immutable_effect_action'); END;
        PRAGMA application_id=${s14ApplicationId}; PRAGMA user_version=${s14SchemaVersion};
      `)).immediate();
      // The only supported upgrade is additive foundation v2 -> v3; no legacy domain/state is reinterpreted.
      this.#db.transaction(() => {
        this.#db.exec(`
          CREATE TABLE IF NOT EXISTS bot_computers (id TEXT PRIMARY KEY, bot_id TEXT NOT NULL UNIQUE REFERENCES bots(id), record_json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS input_leases (computer_id TEXT PRIMARY KEY REFERENCES bot_computers(id), record_json TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS computer_operations (sequence INTEGER PRIMARY KEY, computer_id TEXT NOT NULL REFERENCES bot_computers(id), generation INTEGER NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('start','stop','reset','delete')), state TEXT NOT NULL CHECK(state IN ('queued','running','done')));
          CREATE TABLE IF NOT EXISTS computer_inputs (request_id TEXT PRIMARY KEY, computer_id TEXT NOT NULL REFERENCES bot_computers(id), process_id TEXT NOT NULL, payload_hash TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('dispatching','succeeded','unknown')));
          CREATE TABLE IF NOT EXISTS computer_attempts (attempt_id TEXT PRIMARY KEY REFERENCES work_attempts(id), computer_id TEXT NOT NULL REFERENCES bot_computers(id), generation INTEGER NOT NULL);
          CREATE TRIGGER IF NOT EXISTS immutable_computer_attempt BEFORE UPDATE ON computer_attempts BEGIN SELECT RAISE(ABORT,'immutable_computer_attempt'); END;
          PRAGMA user_version=${s14SchemaVersion};
        `);
      }).immediate();
      chmodSync(path, 0o600);
    } catch (e) { this.#db.close(); throw e; }
  }
  /** Reads an owner projection without admitting work or performing inference. */
  read<T>(fn: (tx: AppTransaction) => T): T { return this.#db.transaction(() => fn(this.#tx)).deferred(); }
  /** Commits one synchronous receipt/state/outbox transition under the writer lock. */
  transaction<T>(fn: (tx: AppTransaction) => T): T { return this.#db.transaction(() => fn(this.#tx)).immediate(); }
  /** Closes this connection without deleting application, backup or profile data. */
  close(): void { this.#db.close(); }
}
