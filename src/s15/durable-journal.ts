import { Database } from 'bun:sqlite';
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { canonical, fail, id } from './policy/validation';

/** Fresh protected opt-in journal with an OS-backed exclusive process lease. This is not an S14
 * migration or an ordinary snapshot. Lost claims survive SIGKILL; opening never recreates missing state. */
export class DurableJournal {
  readonly db: Database;
  #lease: Database;
  #closed = false;
  constructor(path: string, installation: string, create: boolean, applicationId: number) {
    id(installation); if (!isAbsolute(path)) fail('protected_ledger_path_required');
    const existed = existsSync(path);
    if (create && existed) fail('journal_exists');
    if (!create && !existed) fail('continuity_unavailable');
    if (existed) {
      const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) fail('unprotected_ledger');
      const bytes = Buffer.alloc(100), fd = openSync(path, 'r'); let size: number;
      try { size = readSync(fd, bytes, 0, 100, 0); } finally { closeSync(fd); }
      if (size !== 100 || bytes.toString('ascii', 0, 16) !== 'SQLite format 3\0' || bytes.readUInt32BE(68) !== applicationId || bytes.readUInt32BE(60) !== 1) fail('continuity_unavailable');
    }
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lock = path + '.process-lock';
    if (existsSync(lock) && (lstatSync(lock).isSymbolicLink() || (lstatSync(lock).mode & 0o077))) fail('unprotected_ledger');
    try { closeSync(openSync(lock, 'wx', 0o600)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    this.#lease = new Database(lock, { create: false, strict: true });
    try { this.#lease.exec('PRAGMA busy_timeout=10; BEGIN EXCLUSIVE'); }
    catch { this.#lease.close(); fail('runtime_already_open'); }
    try {
      if (create) closeSync(openSync(path, 'wx', 0o600));
      this.db = new Database(path, { create: false, strict: true });
      this.db.exec('PRAGMA synchronous=FULL; PRAGMA busy_timeout=2000; PRAGMA secure_delete=ON');
      if (create) this.db.transaction(() => {
        this.db.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=1;
          CREATE TABLE identity (installation TEXT PRIMARY KEY);
          CREATE TABLE records (id TEXT PRIMARY KEY, json TEXT NOT NULL);
          CREATE TABLE commands (id TEXT PRIMARY KEY, hash TEXT NOT NULL, json TEXT NOT NULL);`);
        this.db.query('INSERT INTO identity VALUES (?)').run(installation);
      }).immediate();
      if (this.db.query<{ installation: string }, []>('SELECT installation FROM identity').get()?.installation !== installation) fail('continuity_unavailable');
    } catch (error) { this.db!?.close(); this.#lease.close(); throw error; }
  }
  /** Every mutation rechecks authority inside this synchronous writer boundary. */
  tx<T>(fn: () => T): T { if (this.#closed) fail('service_closed'); return this.db.transaction(fn).immediate(); }
  get<T>(key: string): T { id(key); const row = this.db.query<{ json: string }, [string]>('SELECT json FROM records WHERE id=?').get(key); if (!row) fail('not_found'); return JSON.parse(row.json) as T; }
  all<T>(): T[] { return this.db.query<{ json: string }, []>('SELECT json FROM records ORDER BY rowid').all().map(row => JSON.parse(row.json) as T); }
  put(key: string, value: unknown): void { id(key); const json = canonical(value); this.db.query('INSERT INTO records VALUES (?,?) ON CONFLICT(id) DO UPDATE SET json=excluded.json').run(key, json); }
  once<T>(key: string, hash: string, action: () => T): T {
    id(key); const old = this.db.query<{ hash: string; json: string }, [string]>('SELECT hash,json FROM commands WHERE id=?').get(key);
    if (old) { if (old.hash !== hash) fail('request_id_conflict'); return JSON.parse(old.json) as T; }
    const count = this.db.query<{ n: number }, []>('SELECT count(*) AS n FROM commands').get()!.n;
    if (count >= 10000) fail('continuity_capacity');
    const result = action(); this.db.query('INSERT INTO commands VALUES (?,?,?)').run(key, hash, canonical(result)); return result;
  }
  /** Active callers must settle or become reconcile-only before shutdown; close never releases their facts. */
  close(): void { if (!this.#closed) { this.#closed = true; this.db.close(); this.#lease.close(); } }
}
