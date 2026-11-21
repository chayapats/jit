import { Database } from 'bun:sqlite';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../errors';
import { opsPath } from '../../s14/ops-files';
import { s14ApplicationId, s14SchemaVersion } from '../../s14/store';
import { assertS16InstallationLease, type S16InstallationLease } from './installation-lease';

function refuse(code = 's16_ops_control_invalid'): never { throw new AppError(code, 409); }
/**
 * Checks adopted current owner/lifecycle identity through read-only SQLite connections before an
 * owning constructor can mutate headers/schema or open vault state. Ordinary descriptors are never
 * opened on these SQLite inodes, preserving other local SQLite connections' POSIX locks.
 */
export function assertS16OperationsOwnerBinding(lease: S16InstallationLease, directory: string): void {
  assertS16InstallationLease(lease, directory); const binding = lease.operations;
  if (lease.observation) refuse('s16_ops_observation_only');
  if (!binding) return;
  const ownerDirectory = join(directory, 'owner'), ownerPath = join(ownerDirectory, 'owner.sqlite'), opened: Database[] = [];
  const privateEntry = (path: string, directory = false) => {
    opsPath(path); const stat = lstatSync(path), uid = process.getuid?.();
    if (uid === undefined || stat.uid !== uid || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || stat.mode & (directory ? 0o7077 : 0o7177)) refuse();
  };
  try {
    privateEntry(ownerDirectory, true);
    for (const role of [{ path: ownerPath, applicationId: s14ApplicationId, format: s14SchemaVersion, table: 'memory_identity' }, { path: ownerPath + '.lifecycle.sqlite', applicationId: 0, format: 0, table: 'identity' }]) {
      privateEntry(role.path); const db = new Database(role.path, { readonly: true, create: false, strict: true }); opened.push(db); db.exec('PRAGMA busy_timeout=10');
      if (db.query<{ application_id: number }, []>('PRAGMA application_id').get()?.application_id !== role.applicationId || db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version !== role.format) refuse();
      const rows = db.query<{ id: string | null }, []>(`SELECT CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB)) BETWEEN 1 AND 128 THEN id ELSE NULL END AS id FROM ${role.table} LIMIT 2`).all();
      if (rows.length !== 1 || rows[0]!.id !== binding.ownerIdentity) refuse();
    }
    lease.assertCurrent();
  } catch { refuse(); }
  finally {
    let failed = false; for (const db of opened.reverse()) try { db.close(true); } catch { failed = true; }
    if (failed) refuse('s16_ops_source_release_unknown');
  }
}
