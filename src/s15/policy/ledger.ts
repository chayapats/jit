import { Database } from 'bun:sqlite';
import { existsSync, lstatSync, openSync, readSync, closeSync, chmodSync } from 'node:fs';
import { canonical, fail } from './validation';
import { isAbsolute } from 'node:path';

const applicationId = 0x4a503135; // Policy continuity only; not the future S15 application format.
/** Protected current ledger, not a backup projection. Explicit creation refuses every existing/foreign file. */
export class PolicyLedger {
  readonly db: Database;
  constructor(path: string, create: boolean, installationId: string) {
    if (!isAbsolute(path)) fail('protected_ledger_path_required');
    if (create) { const fd = openSync(path, 'wx', 0o600); closeSync(fd); }
    else {
      if (!existsSync(path)) fail('continuity_unavailable');
      const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) fail('unprotected_ledger');
      const fd = openSync(path, 'r'); const header = Buffer.alloc(100); let size: number;
      try { size = readSync(fd, header, 0, 100, 0); } finally { closeSync(fd); }
      if (size !== 100 || header.toString('ascii', 0, 16) !== 'SQLite format 3\0' || header.readUInt32BE(68) !== applicationId || header.readUInt32BE(60) !== 1) fail('continuity_unavailable');
    }
    this.db = new Database(path, { strict: true });
    try {
      this.db.exec('PRAGMA busy_timeout=2000; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL; PRAGMA secure_delete=ON;');
      if (create) {
        this.db.transaction(() => {
          this.db.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=1;
            CREATE TABLE meta (key TEXT PRIMARY KEY, json TEXT NOT NULL);
            CREATE TABLE policies (revision INTEGER PRIMARY KEY, json TEXT NOT NULL);
            CREATE TABLE proposals (hash TEXT PRIMARY KEY, json TEXT NOT NULL);
            CREATE TABLE receipts (id TEXT PRIMARY KEY, hash TEXT NOT NULL, json TEXT NOT NULL);
            CREATE TABLE works (id TEXT PRIMARY KEY, json TEXT NOT NULL, revoked INTEGER NOT NULL DEFAULT 0);
            CREATE TABLE actions (id TEXT NOT NULL, revision INTEGER NOT NULL, effect_key TEXT NOT NULL, json TEXT NOT NULL, PRIMARY KEY(id,revision));
            CREATE TABLE slots (effect_key TEXT PRIMARY KEY, action_id TEXT NOT NULL, revision INTEGER NOT NULL, proposal_hash TEXT NOT NULL);
            CREATE TABLE approvals (id TEXT PRIMARY KEY, action_id TEXT NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL);
            CREATE TABLE reservations (id TEXT PRIMARY KEY, dedupe TEXT UNIQUE NOT NULL, hash TEXT NOT NULL, json TEXT NOT NULL);
            CREATE TABLE model_dispatches (reservation_id TEXT PRIMARY KEY, claimed_at INTEGER NOT NULL);
            CREATE TABLE recovery_reads (reservation_id TEXT PRIMARY KEY, action_id TEXT NOT NULL, active INTEGER NOT NULL, observation TEXT);
            CREATE UNIQUE INDEX recovery_single_active ON recovery_reads(active) WHERE active=1;
            CREATE TABLE read_claims (id TEXT PRIMARY KEY, work_id TEXT NOT NULL, request_id TEXT NOT NULL, dispatched INTEGER NOT NULL DEFAULT 0, json TEXT NOT NULL, observation TEXT, result_hash TEXT, UNIQUE(work_id,request_id));
            CREATE TABLE claims (effect_key TEXT PRIMARY KEY, action_id TEXT UNIQUE NOT NULL, payment_key TEXT UNIQUE, reservation_id TEXT NOT NULL, json TEXT NOT NULL);
            CREATE TABLE observations (seq INTEGER PRIMARY KEY, action_id TEXT NOT NULL, json TEXT NOT NULL);
            CREATE TABLE recurring_usage (id TEXT PRIMARY KEY, count INTEGER NOT NULL, amount_minor TEXT NOT NULL, last_at INTEGER NOT NULL);
          `);
          this.put('installation', installationId); this.put('charged', { attempts: 0, steps: 0, calls: 0, reads: 0, outputBytes: 0, activeMs: 0, spendMinor: '0' }); this.put('policyRevoked', false);
        }).immediate();
        chmodSync(path, 0o600);
      }
      if (this.meta<string>('installation') !== installationId || this.meta('charged') === null) fail('continuity_unavailable');
    } catch (error) { this.db.close(); throw error; }
  }
  tx<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  get<T>(sql: string, ...params: (string | number)[]): T | null { return this.db.query(sql).get(...params) as T | null; }
  all<T>(sql: string, ...params: (string | number)[]): T[] { return this.db.query(sql).all(...params) as T[]; }
  run(sql: string, ...params: (string | number | null)[]): void { this.db.query(sql).run(...params); }
  meta<T>(key: string): T | null { const r = this.get<{ json: string }>('SELECT json FROM meta WHERE key=?', key); return r ? JSON.parse(r.json) as T : null; }
  put(key: string, value: unknown): void { this.run('INSERT INTO meta VALUES (?,?) ON CONFLICT(key) DO UPDATE SET json=excluded.json', key, canonical(value)); }
}
