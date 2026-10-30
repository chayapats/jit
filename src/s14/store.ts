import { Database, type SQLQueryBindings } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../errors";
import type { AppTransaction } from "../store";

/** Fresh S14 SQLite format identity, distinct from every legacy user_version. */
export const s14ApplicationId = 0x4a495431;
/** Unreleased S14 schema version; unknown formats refuse before writable SQLite opens. */
export const s14SchemaVersion = 1;
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
  if (header.toString("ascii", 0, 16) !== "SQLite format 3\0" || header.readUInt32BE(68) !== s14ApplicationId || header.readUInt32BE(60) !== s14SchemaVersion) throw new FreshStateRequired();
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
        PRAGMA application_id=${s14ApplicationId}; PRAGMA user_version=${s14SchemaVersion};
      `)).immediate();
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
