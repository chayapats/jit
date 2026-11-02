import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync, openSync, readSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { vmFail } from "./validation";
import type { VmEndpoint, VmEvidence, VmMachineFacts } from "./types";

/** Credential-free protected VM registry row. Private keys live in dedicated mode-0600 files. */
export interface VmRegistration {
  id: string; generation: number; endpoint: VmEndpoint; managerId: string | null;
  state: "ready" | "unproven" | "uncertain" | "stopped"; networkCheckedAt: number;
  facts?: VmMachineFacts;
  networkIsolated: boolean; maxSessions: number; reason: string | null; machineIdentity: string | null; boot: string | null;
}
/** Append-only claim/evidence metadata in a separate protected store; never a guest snapshot or S14 migration. */
export class VmStore {
  readonly db: Database;
  constructor(path: string) {
    if (path !== ":memory:") {
      if (!path.startsWith("/")) vmFail("vm_invalid_setup");
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const existing = lstatSync(path, { throwIfNoEntry: false });
      if (existing) {
        if (!existing.isFile() || existing.isSymbolicLink()) vmFail("vm_store_invalid");
        const fd = openSync(path, "r"), header = Buffer.alloc(100);
        try { if (readSync(fd, header, 0, 100, 0) !== 100 || header.subarray(0, 16).toString() !== "SQLite format 3\0" || header.readUInt32BE(68) !== 0x4a495456 || header.readUInt32BE(60) !== 1) vmFail("vm_store_invalid"); }
        finally { closeSync(fd); }
      }
    }
    this.db = new Database(path, { create: true, strict: true });
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA application_id=1246319702; PRAGMA user_version=1; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS vm_registry (id TEXT PRIMARY KEY, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vm_sessions (id TEXT PRIMARY KEY, vm_id TEXT NOT NULL, work_id TEXT NOT NULL,
        attempt_id TEXT NOT NULL, mode TEXT NOT NULL, state TEXT NOT NULL, unit TEXT NOT NULL, generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS vm_claims (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS vm_snapshots (id TEXT PRIMARY KEY, vm_id TEXT NOT NULL, generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS vm_events (sequence INTEGER PRIMARY KEY, vm_id TEXT NOT NULL, kind TEXT NOT NULL, generation INTEGER NOT NULL);
    `);
  }
  /** Synchronous writer boundary; no transaction survives an I/O wait. */
  transaction<T>(run: () => T): T { return this.db.transaction(run).immediate(); }
  /** Reads only this protected registry, never a guest-supplied registration. */
  registration(id: string): VmRegistration {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM vm_registry WHERE id=?").get(id);
    if (!row) vmFail("vm_not_enrolled", 404);
    return JSON.parse(row.data);
  }
  /** Writer-only trusted metadata update. */
  save(row: VmRegistration): void { this.db.query("INSERT INTO vm_registry VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(row.id, JSON.stringify(row)); }
  /** Copies retained metadata; raw command output and command text are never ordinary durable evidence. */
  evidence(sessionId: string): VmEvidence[] {
    return this.db.query<{ data: string }, [string]>("SELECT data FROM vm_claims WHERE session_id=? ORDER BY rowid").all(sessionId).map(r => JSON.parse(r.data));
  }
  /** Records before dispatch and updates facts monotonically under the original operation identity. */
  saveEvidence(evidence: VmEvidence): void {
    this.db.query("INSERT INTO vm_claims VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(evidence.id, evidence.sessionId, JSON.stringify(evidence));
  }
  /** Releases only this process's database connection; unsettled claims remain for explicit reconciliation. */
  close(): void { this.db.close(); }
}
