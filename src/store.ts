import { Database, type SQLQueryBindings } from "bun:sqlite";
import { chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const schemaVersion = 1;

/** Synchronous SQL operations scoped to an application transaction. */
export interface AppTransaction {
  get<T>(sql: string, ...bindings: SQLQueryBindings[]): T | null;
  all<T>(sql: string, ...bindings: SQLQueryBindings[]): T[];
  run(sql: string, ...bindings: SQLQueryBindings[]): void;
}

/** Local transaction store; state, receipts and audit entries commit or roll back together. */
export class TransactionStore {
  #db: Database;
  #tx: AppTransaction;

  constructor(readonly path: string) {
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
      if (version < schemaVersion) {
        this.#db.transaction(() => {
          // A second opener may have migrated while this connection waited for the writer.
          const current = this.#tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
          if (current === schemaVersion) return;
          if (current !== 0) throw new Error("Unsupported migration source");
          if (existing) {
            const snapshot = `${path}.pre-v0-${crypto.randomUUID()}.sqlite`;
            const fd = openSync(snapshot, "wx", 0o600);
            try { writeFileSync(fd, this.#db.serialize()); fsyncSync(fd); } finally { closeSync(fd); }
          }
          this.#db.exec(`
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
        }).immediate();
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

  /** Closes this connection; committed commands remain available after reopening. */
  close(): void { this.#db.close(); }
}
