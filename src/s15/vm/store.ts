import { Database } from "bun:sqlite";
import { chmodSync, lstatSync, mkdirSync, openSync, readSync, closeSync } from "node:fs";
import { dirname } from "node:path";
import { vmFail } from "./validation";
import type { VmBackendProfile, VmEndpoint, VmEvidence, VmMachineFacts, VmPhysicalBinding } from "./types";
import { vmPhysicalBinding } from "./binding";

/** Credential-free protected VM registry row. Private keys live in dedicated mode-0600 files. */
export interface VmRegistration {
  id: string; generation: number; endpoint: VmEndpoint; managerId: string | null;
  state: "ready" | "unproven" | "uncertain" | "stopped"; networkCheckedAt: number;
  facts?: VmMachineFacts;
  /** Last independently bound manager profile/resources; guest inventory never supplies these ceilings. */
  backend?: { profile: VmBackendProfile; cpuCount: number; memoryBytes: number; diskBytes: number };
  /** Enrollment binding to the NIC observed independently through the management adapter. Missing is unproven. */
  bindingMac?: string;
  /** Format-2 physical binding; exclusive with legacy bindingMac. */
  binding?: VmPhysicalBinding;
  networkIsolated: boolean; maxSessions: number; reason: string | null; machineIdentity: string | null; boot: string | null;
}
/** Append-only claim/evidence metadata in a separate protected store; never a guest snapshot or S14 migration. */
export class VmStore {
  readonly db: Database;
  readonly #path: string;
  readonly #listeners = new Set<(row: VmRegistration, previous: VmRegistration | null) => void>();
  /** Synchronous lifecycle invalidation; no protected stream survives a VM fence/stop/restore. */
  onChange(listener: (row: VmRegistration, previous: VmRegistration | null) => void): () => void { this.#listeners.add(listener); return () => this.#listeners.delete(listener); }
  constructor(path: string) {
    this.#path = path;
    let existingFile = false;
    if (path !== ":memory:") {
      if (!path.startsWith("/")) vmFail("vm_invalid_setup");
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
      const existing = lstatSync(path, { throwIfNoEntry: false });
      if (existing) {
        existingFile = true;
        if (!existing.isFile() || existing.isSymbolicLink()) vmFail("vm_store_invalid");
        const fd = openSync(path, "r"), header = Buffer.alloc(100);
        try { if (readSync(fd, header, 0, 100, 0) !== 100 || header.subarray(0, 16).toString() !== "SQLite format 3\0" || header.readUInt32BE(68) !== 0x4a495456 || ![1, 2, 3].includes(header.readUInt32BE(60))) vmFail("vm_store_invalid"); }
        finally { closeSync(fd); }
      }
    }
    this.db = new Database(path, { create: true, strict: true });
    const format = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    if (![1, 2, 3].includes(format) && (format !== 0 || existingFile)) { this.db.close(); vmFail("vm_store_invalid"); }
    if (format === 0) this.db.exec("PRAGMA user_version=1");
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA application_id=1246319702; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
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
  /**
   * Monotonically enables physical bindings before enrollment. Must run outside a transaction. The
   * checkpoint must reach the actual database header before any format-2 row is written, so the old
   * format-1 reader refuses even when a previous composition manifest is restored. Busy readers refuse
   * adoption; a WAL-only version is insufficient. This does not enable portable-state ancestry yet.
   */
  enableVsockBindings(): void {
    if (this.db.inTransaction) vmFail("vm_store_format_required");
    const format = this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
    if (![1, 2, 3].includes(format)) vmFail("vm_store_invalid");
    if (format === 1) this.db.exec("PRAGMA user_version=2");
    if (this.#path !== ":memory:") {
      const result = this.db.query<{ busy: number; log: number; checkpointed: number }, []>("PRAGMA wal_checkpoint(TRUNCATE)").get();
      if (!result || result.busy !== 0) vmFail("vm_store_format_required");
    }
    this.assertVsockFormat();
  }
  private assertVsockFormat(): void {
    if (![2, 3].includes(this.db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version)) vmFail("vm_store_format_required");
    if (this.#path === ":memory:") return;
    const fd = openSync(this.#path, "r"), header = Buffer.alloc(100);
    try { if (readSync(fd, header, 0, 100, 0) !== 100 || ![2, 3].includes(header.readUInt32BE(60))) vmFail("vm_store_format_required"); }
    finally { closeSync(fd); }
  }
  /** Explicit monotonic portable-state adoption. The checkpointed header precedes ancestry and guest bytes. */
  enablePortableState(): void {
    if (this.db.inTransaction) vmFail('vm_store_format_required');
    const format = this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version;
    if (![1, 2, 3].includes(format)) vmFail('vm_store_invalid'); if (format < 3) this.db.exec('PRAGMA user_version=3');
    if (this.#path !== ':memory:') { const r = this.db.query<{ busy: number }, []>('PRAGMA wal_checkpoint(TRUNCATE)').get(); if (!r || r.busy) vmFail('vm_store_format_required'); }
    this.assertPortableState();
  }
  /** Actual on-disk reader fence, checked again at every portable guest mutation dispatch. */
  assertPortableState(): void {
    if (this.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version !== 3) vmFail('vm_store_format_required');
    if (this.#path === ':memory:') return; const fd = openSync(this.#path, 'r'), header = Buffer.alloc(100);
    try { if (readSync(fd, header, 0, 100, 0) !== 100 || header.readUInt32BE(60) !== 3) vmFail('vm_store_format_required'); } finally { closeSync(fd); }
  }
  /** A protected import stamp must pre-exist every guest write. Guest/model receipts cannot create it. */
  assertPortableImport(id: string, scope: { vmId: string; workId: string; attemptId: string; generation: number }, treeSha256: unknown): void {
    this.assertPortableState();
    const row = this.db.query<{ data: string; state: string }, [string]>('SELECT data,state FROM vm_working_imports WHERE id=?').get(id);
    if (!row || row.state !== 'dispatched') vmFail('vm_portable_unknown', 409);
    const saved = JSON.parse(row.data) as { treeSha256: string; destination: { vmId: string; workId: string; attemptId: string; generation: number } }, d = saved.destination;
    if (saved.treeSha256 !== treeSha256 || d.vmId !== scope.vmId || d.workId !== scope.workId || d.attemptId !== scope.attemptId || d.generation !== scope.generation) vmFail('vm_portable_scope', 403);
  }
  /** Reads only this protected registry, never a guest-supplied registration. */
  registration(id: string): VmRegistration {
    const row = this.db.query<{ data: string }, [string]>("SELECT data FROM vm_registry WHERE id=?").get(id);
    if (!row) vmFail("vm_not_enrolled", 404);
    return JSON.parse(row.data);
  }
  /** Writer-only trusted metadata update. */
  save(row: VmRegistration): void {
    if (row.binding !== undefined) {
      if (!vmPhysicalBinding(row)) vmFail("vm_identity_unproven");
      this.assertVsockFormat();
    }
    const prior = this.db.query<{ data: string }, [string]>("SELECT data FROM vm_registry WHERE id=?").get(row.id);
    this.db.query("INSERT INTO vm_registry VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(row.id, JSON.stringify(row));
    for (const listener of this.#listeners) listener(row, prior ? JSON.parse(prior.data) : null);
  }
  /** Copies retained metadata; raw command output and command text are never ordinary durable evidence. */
  evidence(sessionId: string): VmEvidence[] {
    return this.db.query<{ data: string }, [string]>("SELECT data FROM vm_claims WHERE session_id=? ORDER BY rowid").all(sessionId).map(r => JSON.parse(r.data));
  }
  /** Records before dispatch and updates facts monotonically under the original operation identity. */
  saveEvidence(evidence: VmEvidence): void {
    const previous = this.db.query<{ data: string }, [string]>("SELECT data FROM vm_claims WHERE id=?").get(evidence.id);
    if (previous) {
      const old: VmEvidence = JSON.parse(previous.data), rank = { unsettled: 0, guest_scope_empty: 1, vm_stopped: 2 };
      if (rank[old.execution] > rank[evidence.execution]) evidence = { ...evidence, execution: old.execution };
    }
    this.db.query("INSERT INTO vm_claims VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data").run(evidence.id, evidence.sessionId, JSON.stringify(evidence));
  }
  /** Releases only this process's database connection; unsettled claims remain for explicit reconciliation. */
  close(): void { this.db.close(); }
}
