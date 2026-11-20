import { Database } from 'bun:sqlite';
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { AppError } from '../../errors';
import { opsPath, opsRead, opsSyncDirectory, opsWrite } from '../../s14/ops-files';
import { canonical } from '../../s15/conversation/validation';

const applicationId = 0x4a4f3136;
function refuse(code = 's16_ops_installation_lease_invalid'): never { throw new AppError(code, 409); }
interface ProcessLease {
  mode: 'shared' | 'exclusive'; references: number;
  assertCurrent(): void; release(): void;
}
const processLeases = new Map<string, ProcessLease>(), opening = new Set<string>();
function reference(lease: ProcessLease): S16InstallationLease {
  lease.references++; let closed = false;
  return Object.freeze({ mode: lease.mode, assertCurrent() {
    if (closed) refuse('s16_ops_installation_lease_closed'); lease.assertCurrent();
  }, close() {
    if (closed) return;
    if (lease.references === 1) lease.release(); // An unknown close must retain the original reference.
    lease.references--; closed = true;
  } });
}
/** Protected process lifetime only. A lease is never serialized, copied into an image or used as actor authority. */
export interface S16InstallationLease {
  readonly mode: 'shared' | 'exclusive';
  /** Requires the same private retained inode and the original live SQLite transaction. */
  assertCurrent(): void;
  /** Releases only this connection; failure stays unknown and may be retried without unlinking the file. */
  close(): void;
}
/** Trusted explicit installation root. Only selected CLI first adoption may create a new lease. */
export interface S16InstallationLeaseOptions { directory: string; mode: 'shared' | 'exclusive'; create?: boolean }
function entry(path: string, directory = false): BigIntStats {
  try {
    opsPath(path); const stat = lstatSync(path, { bigint: true }), uid = process.getuid?.();
    if (uid === undefined || stat.uid !== BigInt(uid) || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) || stat.mode & (directory ? 0o7077n : 0o7177n)) refuse();
    return stat;
  } catch { return refuse(); }
}
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && (a.isDirectory() && b.isDirectory() || a.nlink === b.nlink);

/**
 * Holds a rollback-journal SQLite shared read or exclusive maintenance lease over one retained private
 * inode. No existing file is initialized, replaced, downgraded or deleted; no application state opens.
 * Selected commands may share a lease, while maintenance excludes every participating command.
 */
export function openS16InstallationLease(options: S16InstallationLeaseOptions): S16InstallationLease {
  const root = options.directory;
  if (!isAbsolute(root) || normalize(root) !== root || !['shared', 'exclusive'].includes(options.mode) || options.mode === 'exclusive' && options.create) refuse();
  const parent = entry(root, true), path = join(root, 's16-operations.lock.sqlite'), receipt = join(root, 's16-operations.lease.json');
  const processKey = `${parent.dev}:${parent.ino}`, held = processLeases.get(processKey);
  if (held) {
    if (held.mode !== 'shared' || options.mode !== 'shared') refuse('s16_ops_installation_busy');
    held.assertCurrent(); return reference(held);
  }
  if (opening.has(processKey)) refuse('s16_ops_installation_busy');
  opening.add(processKey);
  let fresh = false, database: Database | undefined, closed = false;
  try {
    if (options.create && !lstatSync(receipt, { throwIfNoEntry: false })) {
      try { const fd = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); closeSync(fd); fresh = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') refuse(); }
    }
    const original = entry(path);
    const expectedReceipt = canonical({ contract: 's16-installation-lease/v1', dev: original.dev.toString(), ino: original.ino.toString() });
    if (!fresh) { entry(receipt); if (opsRead(receipt, 1024).toString('utf8') !== expectedReceipt) refuse(); }
    if (original.size > 1_048_576n) refuse();
    if (!fresh) {
      if (original.size < 100n) refuse();
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), header = Buffer.alloc(100);
      try {
        if (!same(original, fstatSync(fd, { bigint: true })) || readSync(fd, header, 0, 100, 0) !== 100 || header.toString('ascii', 0, 16) !== 'SQLite format 3\0' ||
          header.readUInt32BE(68) !== applicationId || header.readUInt32BE(60) !== 1 || header[18] !== 1 || header[19] !== 1) refuse();
      } finally { closeSync(fd); }
    }
    database = new Database(path, { readwrite: true, create: false, strict: true });
    database.exec('PRAGMA busy_timeout=10');
    if (fresh) {
      database.exec(`PRAGMA synchronous=FULL; BEGIN EXCLUSIVE; PRAGMA application_id=${applicationId}; PRAGMA user_version=1; CREATE TABLE lease(id INTEGER PRIMARY KEY CHECK(id=1)); INSERT INTO lease VALUES(1); COMMIT`);
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); try { if (!same(original, fstatSync(fd, { bigint: true }))) refuse(); fsyncSync(fd); } finally { closeSync(fd); }
      opsSyncDirectory(root);
      // Retain independent inode binding so a missing lock cannot be silently initialized on a later boot.
      opsWrite(receipt, expectedReceipt);
    }
    const receiptEntry = entry(receipt);
    if (!same(original, entry(path)) || !same(parent, entry(root, true))) refuse();
    if (database.query<{ application_id: number }, []>('PRAGMA application_id').get()?.application_id !== applicationId || database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version !== 1 || database.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()?.journal_mode !== 'delete') refuse();
    try {
      database.exec(options.mode === 'exclusive' ? 'BEGIN EXCLUSIVE' : 'BEGIN DEFERRED');
      // BEGIN DEFERRED alone holds no SHARED lock. Reading the singleton establishes and retains it.
      const rows = database.query<{ id: number }, []>('SELECT id FROM lease LIMIT 2').all();
      if (rows.length !== 1 || rows[0]!.id !== 1) refuse();
    } catch (error) {
      if (error instanceof AppError) throw error;
      refuse('s16_ops_installation_busy');
    }
    const owned = database, retained = entry(path);
    const assertCurrent = () => {
      if (closed || !owned.inTransaction) refuse('s16_ops_installation_lease_closed');
      const current = entry(path);
      if (!same(original, current) || retained.size !== current.size || retained.mtimeNs !== current.mtimeNs || retained.ctimeNs !== current.ctimeNs || !same(parent, entry(root, true)) || !same(receiptEntry, entry(receipt)) || opsRead(receipt, 1024).toString('utf8') !== expectedReceipt) refuse('s16_ops_installation_lease_changed');
    };
    assertCurrent();
    const shared: ProcessLease = { mode: options.mode, references: 0, assertCurrent, release() {
      try { owned.close(true); } catch { return refuse('s16_ops_source_release_unknown'); }
      closed = true; processLeases.delete(processKey);
    } };
    processLeases.set(processKey, shared); opening.delete(processKey);
    return reference(shared);
  } catch (error) {
    try { database?.close(true); } catch { return refuse('s16_ops_source_release_unknown'); }
    opening.delete(processKey);
    if (error instanceof AppError && error.code.startsWith('s16_ops_')) throw error;
    if (['SQLITE_BUSY', 'SQLITE_LOCKED'].includes((error as { code?: string })?.code ?? '')) refuse('s16_ops_installation_busy');
    return refuse();
  }
}
