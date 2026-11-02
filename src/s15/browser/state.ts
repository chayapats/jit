import { Database } from 'bun:sqlite';
import type { ActionRef } from '../policy';
import { chmodSync, existsSync } from 'node:fs';
import { BrowserError } from './validation';

/** Minimal protected continuity outside the browser profile. A crash after arming an effect is
 * reconcile-only, even if the browser/profile is restored. No cookies, URLs or payloads are stored.
 */
export function browserContinuity(path: string, create: boolean, resource: string) {
  if (existsSync(path) === create) throw new BrowserError('continuity_unavailable');
  const db = new Database(path, { create, readwrite: true });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;');
  if (create) {
    db.exec('CREATE TABLE browser_state (singleton INTEGER PRIMARY KEY CHECK(singleton=1), resource TEXT NOT NULL, generation INTEGER NOT NULL, uncertain TEXT)');
    db.query('INSERT INTO browser_state VALUES (1,?,1,NULL)').run(resource);
    chmodSync(path, 0o600);
  }
  const read = () => {
    const row = db.query('SELECT * FROM browser_state WHERE singleton=1').get() as { resource: string; generation: number; uncertain: string | null } | null;
    if (!row || row.resource !== resource || !Number.isSafeInteger(row.generation) || row.generation < 1) throw new BrowserError('continuity_unavailable');
    return row;
  };
  try { read(); } catch (e) { db.close(); throw e; }
  const advance = db.transaction(() => { const row = read(); if (!Number.isSafeInteger(row.generation + 1)) throw new BrowserError('continuity_unavailable'); db.query('UPDATE browser_state SET generation=? WHERE singleton=1').run(row.generation + 1); return row.generation + 1; });
  return {
    advance: () => advance.immediate(),
    generation: () => read().generation,
    uncertain(): ActionRef | null { const value = read().uncertain; return value ? JSON.parse(value) as ActionRef : null; },
    arm(action: ActionRef) { const serialized = JSON.stringify(action); db.transaction(() => { if (read().uncertain) throw new BrowserError('reconciliation_required'); db.query('UPDATE browser_state SET uncertain=? WHERE singleton=1').run(serialized); }).immediate(); },
    settle(action: ActionRef) { db.transaction(() => { if (read().uncertain !== JSON.stringify(action)) throw new BrowserError('continuity_unavailable'); db.query('UPDATE browser_state SET uncertain=NULL WHERE singleton=1').run(); }).immediate(); },
    close() { db.close(); },
  };
}
