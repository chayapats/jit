import { lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../errors';
import { s16PointEntry } from './point-files';

/** Combined original recovery staging bounds; observations never delete or evict bytes. */
export const s16RecoveryLimits = Object.freeze({ bytes: 12884901888, nodes: 250000, depth: 32, file: 1073741824 });
/** Enumerates a bounded fixed private namespace without following entries. */
export function s16RecoveryNames(path: string, limit: number): string[] {
  const result: string[] = [], directory = opendirSync(path);
  try { for (;;) { const next = directory.readSync(); if (!next) break; if (result.length >= limit) throw new AppError('s16_ops_recovery_bounds', 409); result.push(next.name); } }
  finally { directory.closeSync(); } return result.sort();
}
/** Accounts every present original stage member before ingestion; native artifacts stay opaque. */
export function s16RecoveryUsage(root: string): { bytes: number; nodes: number } {
  let bytes = 0, nodes = 0;
  const visit = (path: string, depth: number) => {
    if (++nodes > s16RecoveryLimits.nodes || depth > s16RecoveryLimits.depth) throw new AppError('s16_ops_recovery_bounds', 409);
    const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) { s16PointEntry(path, true); for (const name of s16RecoveryNames(path, s16RecoveryLimits.nodes - nodes)) visit(join(path, name), depth + 1); }
    else { const file = s16PointEntry(path); if (file.size > BigInt(s16RecoveryLimits.file) || (bytes += Number(file.size)) > s16RecoveryLimits.bytes) throw new AppError('s16_ops_recovery_bounds', 409); }
  }; visit(root, 0); return { bytes, nodes };
}
