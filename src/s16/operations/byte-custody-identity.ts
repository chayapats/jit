import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { AppError } from '../../errors';

/** Host-only original physical identity; absence is an observation, never a write grant. */
export interface S16ByteCustodyIdentity {
  readonly path: string; readonly kind: 'file' | 'directory' | 'absent'; readonly sha256: string | null;
}
/** Records original identities without treating later directory membership changes as a new inode. */
export function s16ByteCustodyIdentities(entries: ReadonlyMap<string, BigIntStats | null>): readonly S16ByteCustodyIdentity[] {
  let bytes = 2;
  const result: S16ByteCustodyIdentity[] = [];
  for (const [path, stat] of [...entries].sort(([a], [b]) => a.localeCompare(b))) {
    const identity = Object.freeze({ path,
    kind: !stat ? 'absent' as const : stat.isDirectory() ? 'directory' as const : 'file' as const,
    sha256: stat ? createHash('sha256').update(JSON.stringify((stat.isDirectory() ? ['dev', 'ino', 'uid', 'mode'] : ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs']).map(key => String(stat[key as keyof BigIntStats])))).digest('hex') : null });
    if ((bytes += Buffer.byteLength(JSON.stringify(identity)) + 1) > 16777216) throw new AppError('s16_ops_custody_identity_bounds', 409);
    result.push(identity);
  }
  return Object.freeze(result);
}
