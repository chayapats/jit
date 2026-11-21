import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, openSync, readSync, unlinkSync, writeSync, type BigIntStats } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from '../../errors';
import { opsPath, opsSyncDirectory } from '../../s14/ops-files';
import { s16PointEntry, s16PointEntryIdentity } from './point-files';

function refuse(code = 's16_ops_repair_file_invalid'): never { throw new AppError(code, 409); }
/** Local file transition only. The caller must authenticate the independent original current repair plan. */
export interface S16RepairFile {
  target: string; temp: string; parentIdentity: string; tempIdentity: string;
  bytes: number; sha256: string;
}
/** An authenticated immutable candidate member, never an archive-selected destination. */
export interface S16RepairSource { path: string; identity: string; bytes: number; sha256: string }
/** Only the exact original empty inode may grow or acquire its one fixed publication link. */
export function s16RepairFileIdentity(stat: BigIntStats): string { return s16PointEntryIdentity(stat, true); }
/** Private regular custody with only the explicitly enumerated original link counts. */
export function s16RepairFileEntry(path: string, links: readonly bigint[] = [1n], optional = false): BigIntStats | null {
  opsPath(path); const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
  if (!stat) { if (optional) return null; return refuse('s16_ops_repair_owned_file_missing'); }
  if (!stat.isFile() || stat.isSymbolicLink() || process.getuid?.() === undefined || stat.uid !== BigInt(process.getuid!()) || (stat.mode & 0o7777n) !== 0o600n || !links.includes(stat.nlink)) refuse();
  return stat;
}
/** Creates or adopts only a still-empty private fixed-nonce temp before independent plan ownership. */
export function createS16EmptyRepairTemp(path: string): string {
  const existing = s16RepairFileEntry(path, [1n], true);
  if (existing) { if (existing.size !== 0n) refuse('s16_ops_repair_unowned_temp'); }
  else { const fd = openSync(opsPath(path), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); try { fsyncSync(fd); } finally { closeSync(fd); } }
  opsSyncDirectory(dirname(path)); return s16RepairFileIdentity(s16RepairFileEntry(path)!);
}
/** The immutable plan and actual owned names/link counts are per-member durable progress. */
export function inspectS16RepairFile(file: S16RepairFile): { state: 'temp' | 'linked' | 'target'; temp: BigIntStats | null; target: BigIntStats | null } {
  if (dirname(file.target) !== dirname(file.temp) || file.target === file.temp || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 1073741824 || !/^[a-f0-9]{64}$/.test(file.sha256)) refuse();
  if (s16PointEntryIdentity(s16PointEntry(dirname(file.temp), true), true) !== file.parentIdentity) refuse('s16_ops_repair_parent_changed');
  const temp = s16RepairFileEntry(file.temp, [1n, 2n], true), target = s16RepairFileEntry(file.target, [1n, 2n], true);
  if (!temp && !target) refuse('s16_ops_repair_owned_file_missing');
  for (const stat of [temp, target]) if (stat && (s16RepairFileIdentity(stat) !== file.tempIdentity || stat.size > BigInt(file.bytes))) refuse('s16_ops_repair_file_changed');
  if (temp && target) { if (temp.dev !== target.dev || temp.ino !== target.ino || temp.nlink !== 2n || target.nlink !== 2n || temp.size !== BigInt(file.bytes)) refuse('s16_ops_repair_file_changed'); return { state: 'linked', temp, target }; }
  if (temp) { if (temp.nlink !== 1n) refuse(); return { state: 'temp', temp, target: null }; }
  if (!target || target.nlink !== 1n || target.size !== BigInt(file.bytes)) refuse(); return { state: 'target', temp: null, target };
}
/** Streams complete expected bytes without interpreting them; the caller owns their current eligibility. */
export function verifyS16RepairFile(path: string, file: S16RepairFile, links: readonly bigint[] = [1n]): void {
  const before = s16RepairFileEntry(path, links)!;
  if (s16RepairFileIdentity(before) !== file.tempIdentity || before.size !== BigInt(file.bytes)) refuse('s16_ops_repair_file_changed');
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), buffer = Buffer.alloc(65536), digest = createHash('sha256'); let at = 0;
  try { if (s16PointEntryIdentity(before) !== s16PointEntryIdentity(fstatSync(fd, { bigint: true }))) refuse();
    while (at < file.bytes) { const n = readSync(fd, buffer, 0, Math.min(buffer.length, file.bytes - at), at); if (!n) refuse(); digest.update(buffer.subarray(0, n)); at += n; }
    if (readSync(fd, buffer, 0, 1, at) || digest.digest('hex') !== file.sha256 || s16PointEntryIdentity(before) !== s16PointEntryIdentity(fstatSync(fd, { bigint: true })) || s16PointEntryIdentity(before) !== s16PointEntryIdentity(s16RepairFileEntry(path, links)!)) refuse('s16_ops_repair_file_changed');
  } finally { closeSync(fd); }
}
/** Compares the entire existing owned prefix before appending any tail; never truncates or overwrites it. */
export function copyS16RepairPrefix(file: S16RepairFile, source: S16RepairSource, guard: () => void, afterChunk?: () => void): void {
  const check = () => { if ((guard() as unknown) !== undefined) refuse('s16_ops_guard_invalid'); }; check();
  const progress = inspectS16RepairFile(file); if (progress.state !== 'temp') { verifyS16RepairFile(file.target, file, progress.state === 'linked' ? [2n] : [1n]); return; }
  if (source.bytes !== file.bytes || source.sha256 !== file.sha256 || s16PointEntryIdentity(s16PointEntry(source.path)) !== source.identity) refuse('s16_ops_repair_source_changed');
  const input = openSync(source.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); let output: number | undefined;
  const buffer = Buffer.alloc(65536), prefix = Buffer.alloc(65536), originalSize = Number(progress.temp!.size), digest = createHash('sha256'); let at = 0;
  try {
    if (s16PointEntryIdentity(fstatSync(input, { bigint: true })) !== source.identity) refuse('s16_ops_repair_source_changed');
    output = openSync(file.temp, constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (s16PointEntryIdentity(fstatSync(output, { bigint: true })) !== s16PointEntryIdentity(progress.temp!)) refuse('s16_ops_repair_file_changed');
    while (at < file.bytes) {
      const n = readSync(input, buffer, 0, Math.min(buffer.length, file.bytes - at), at); if (!n) refuse('s16_ops_repair_source_changed'); digest.update(buffer.subarray(0, n));
      const compare = Math.max(0, Math.min(n, originalSize - at));
      if (compare && (readSync(output, prefix, 0, compare, at) !== compare || !prefix.subarray(0, compare).equals(buffer.subarray(0, compare)))) refuse('s16_ops_repair_prefix_changed');
      let written = compare;
      while (written < n) { const count = writeSync(output, buffer, written, n - written, at + written); if (!count) refuse('s16_ops_repair_file_changed'); written += count; }
      at += n; if ((afterChunk?.() as unknown) !== undefined) refuse('s16_ops_guard_invalid');
    }
    if (readSync(input, buffer, 0, 1, at) || digest.digest('hex') !== file.sha256 || s16PointEntryIdentity(fstatSync(input, { bigint: true })) !== source.identity || s16PointEntryIdentity(s16PointEntry(source.path)) !== source.identity) refuse('s16_ops_repair_source_changed');
    fsyncSync(output);
  } finally { if (output !== undefined) closeSync(output); closeSync(input); }
  check(); verifyS16RepairFile(file.temp, file); check();
}
/** Atomically adds only an absent target, then retires only the independently planned original temp name. */
export function publishS16RepairFile(file: S16RepairFile, guard: () => void, after?: (boundary: 'linked' | 'published') => void): void {
  const check = () => { if ((guard() as unknown) !== undefined) refuse('s16_ops_guard_invalid'); }; check();
  let progress = inspectS16RepairFile(file);
  if (progress.state === 'temp') { verifyS16RepairFile(file.temp, file); check(); linkSync(file.temp, file.target); opsSyncDirectory(dirname(file.target)); check(); progress = inspectS16RepairFile(file); if (progress.state !== 'linked') refuse(); if ((after?.('linked') as unknown) !== undefined) refuse('s16_ops_guard_invalid'); check(); }
  if (progress.state === 'linked') {
    verifyS16RepairFile(file.target, file, [2n]); verifyS16RepairFile(file.temp, file, [2n]); check();
    if (inspectS16RepairFile(file).state !== 'linked') refuse(); unlinkSync(file.temp); opsSyncDirectory(dirname(file.target)); check();
  }
  if (inspectS16RepairFile(file).state !== 'target') refuse(); verifyS16RepairFile(file.target, file); opsSyncDirectory(dirname(file.target)); check();
  if ((after?.('published') as unknown) !== undefined) refuse('s16_ops_guard_invalid'); check();
}
