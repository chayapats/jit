import { lstatSync, realpathSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { AppError } from '../errors';

const held = new Map<string, object>(), inodes = new Map<string, object>();
/** Original local path/inode reservation. Bind a freshly created journal before opening its SQLite handle. */
export interface DurableJournalPathReservation { bind(): void; release(): void }
/**
 * Reserves this process's existing journal pathname before opening any journal/SQLite-lock descriptor.
 * POSIX record locks can be released by closing another descriptor for the same inode: a failed second
 * opener must therefore refuse before even a header read. This registry complements the existing OS
 * process lease; it is not cross-process exclusion and never creates, replaces or unlinks a lock file.
 * Release only after both the original journal and its process-lease handles close conclusively.
 */
export function reserveDurableJournalPath(path: string): DurableJournalPathReservation {
  const key = join(realpathSync(dirname(path)), basename(path));
  if (held.has(key)) throw new AppError('runtime_already_open', 409);
  const token = {}; held.set(key, token); let released = false, inode: string | null = null;
  const release = () => {
    if (released) return; if (held.get(key) === token) held.delete(key); if (inode && inodes.get(inode) === token) inodes.delete(inode); released = true;
  };
  const bind = () => {
    if (released) throw new AppError('runtime_already_open', 409);
    const stat = lstatSync(path, { bigint: true }), next = `${stat.dev}:${stat.ino}`;
    if (inode !== null && inode !== next || inodes.has(next) && inodes.get(next) !== token) throw new AppError('runtime_already_open', 409);
    inode = next; inodes.set(next, token);
  };
  try { if (lstatSync(path, { throwIfNoEntry: false })) bind(); } catch (error) { release(); throw error; }
  return Object.freeze({ bind, release });
}
