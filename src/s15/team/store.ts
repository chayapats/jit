import { Database } from "bun:sqlite";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../../errors";
import { identity } from "../conversation/validation";

/**
 * Version-one protected store shared by the TEAM/MEM implementations. Each supplies a distinct
 * application ID and explicit DDL. Existing foreign/older/newer stores refuse before writable open.
 * This is current continuity state, excluded from guest disks and ordinary backup/restore images.
 */
export class ProtectedDataStore {
  readonly db!: Database;
  #lock: Database;
  #closed = false;
  constructor(readonly path: string, installationId: string, create: boolean, applicationId: number, ddl: string) {
    identity(installationId);
    const existing = existsSync(path);
    if (existing) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new AppError("s15_data_store_incompatible", 409);
      const header = Buffer.alloc(100), fd = openSync(path, "r");
      let length: number;
      try { length = readSync(fd, header, 0, 100, 0); } finally { closeSync(fd); }
      if (length < 100 || header.toString("ascii", 0, 16) !== "SQLite format 3\0" || header.readUInt32BE(68) !== applicationId || header.readUInt32BE(60) !== 1) throw new AppError("s15_data_store_incompatible", 409);
    } else if (!create) throw new AppError("continuity_unavailable", 503);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lockPath = `${path}.runtime-lock.sqlite`;
    if (existsSync(lockPath) && lstatSync(lockPath).isSymbolicLink()) throw new AppError("continuity_unavailable", 503);
    try { closeSync(openSync(lockPath, "wx", 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    this.#lock = new Database(lockPath, { create: false, strict: true });
    try { this.#lock.exec("PRAGMA busy_timeout=10; BEGIN EXCLUSIVE"); }
    catch { this.#lock.close(); throw new AppError("s15_data_runtime_already_open", 409); }
    try {
      if (!existing) closeSync(openSync(path, "wx", 0o600));
      this.db = new Database(path, { create: false, strict: true });
      this.db.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000; PRAGMA secure_delete=ON");
      if (!existing) this.transaction(() => {
        this.db.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=1; CREATE TABLE identity (id TEXT PRIMARY KEY); ${ddl}`);
        this.db.query("INSERT INTO identity VALUES (?)").run(installationId);
      });
      if (this.db.query<{ id: string }, []>("SELECT id FROM identity").get()?.id !== installationId) throw new AppError("continuity_unavailable", 503);
    } catch (error) { this.db!?.close(); this.#lock.close(); throw error; }
  }
  /** Atomic synchronous mutation; async callbacks cannot hold or escape this boundary. */
  transaction<T>(action: () => T): T { return this.db.transaction(action).immediate(); }
  /** Explicit finite custody refuses instead of evicting withdrawals, command identities or leases. */
  capacity(): void {
    const page = this.db.query<{ page_count: number }, []>("PRAGMA page_count").get()!.page_count;
    const size = this.db.query<{ page_size: number }, []>("PRAGMA page_size").get()!.page_size;
    if (page * size >= 64 * 1024 * 1024) throw new AppError("continuity_capacity", 409);
  }
  /** The composing host must settle/shut down workers before closing. */
  close(): void { if (!this.#closed) { this.#closed = true; this.db.close(); this.#lock.close(); } }
}

/** TEAM schema v1. Resource/source identities, withdrawals and fences never originate in a guest. */
export const TEAM_SCHEMA_V1 = `
CREATE TABLE resources (id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
CREATE TABLE sources (id TEXT PRIMARY KEY, record_json TEXT NOT NULL);
CREATE TABLE withdrawals (id TEXT PRIMARY KEY, at INTEGER NOT NULL);
CREATE TABLE fences (coordination_key TEXT PRIMARY KEY, generation INTEGER NOT NULL);
CREATE TABLE leases (id TEXT PRIMARY KEY, state TEXT NOT NULL, record_json TEXT NOT NULL);
CREATE TABLE lease_keys (coordination_key TEXT PRIMARY KEY, lease_id TEXT NOT NULL REFERENCES leases(id));
CREATE TABLE commands (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, result_json TEXT NOT NULL);
CREATE TRIGGER immutable_withdrawal_update BEFORE UPDATE ON withdrawals BEGIN SELECT RAISE(ABORT,'immutable_withdrawal'); END;
CREATE TRIGGER immutable_withdrawal_delete BEFORE DELETE ON withdrawals BEGIN SELECT RAISE(ABORT,'immutable_withdrawal'); END;
`;
