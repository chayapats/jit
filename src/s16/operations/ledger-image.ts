import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, type BigIntStats } from 'node:fs';
import { isAbsolute, normalize } from 'node:path';
import { AppError } from '../../errors';
import { opsPath } from '../../s14/ops-files';

const maximumBytes = 1_073_741_824, blockBytes = 65_536;
function refuse(code: string): never { throw new AppError(code, 409); }

/** Protected owning-reader input, never accepted from model/client/archive metadata. */
export interface S16LedgerImageExpectation {
  applicationId: number;
  formats: readonly number[];
  ownerUid: number;
}
/** Header/hash observation only. No row, identity, consistency, settlement or restore authority is implied. */
export interface S16LedgerImage {
  readonly contract: 's16-ledger-image/v1';
  readonly validation: 'header_and_hash';
  readonly applicationId: number;
  readonly readerVersion: number;
  readonly bytes: number;
  readonly sha256: string;
}
const uint32 = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 0xffff_ffff;
function sameFile(a: BigIntStats, b: BigIntStats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.uid === b.uid && a.mode === b.mode &&
    a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}
function settled(path: string): void {
  for (const suffix of ['-wal', '-shm', '-journal']) if (lstatSync(path + suffix, { throwIfNoEntry: false })) refuse('s16_ops_settlement_required');
}

/**
 * Streams one existing private, single-link SQLite main image without opening a database or returning
 * its contents. The caller owns the aggregate writer lease and full owning-store validation; this
 * bounded observation alone must never authorize backup consistency, admission or state replacement.
 */
export function observeS16LedgerImage(path: string, expected: S16LedgerImageExpectation): Readonly<S16LedgerImage> {
  if (!expected || typeof expected !== 'object' || !uint32(expected.applicationId) || !uint32(expected.ownerUid) || !Array.isArray(expected.formats) ||
    expected.formats.length < 1 || expected.formats.length > 16 || !expected.formats.every(uint32) || new Set(expected.formats).size !== expected.formats.length) refuse('s16_ops_reader_invalid');
  if (typeof path !== 'string' || !isAbsolute(path) || normalize(path) !== path) refuse('s16_ops_path_untrusted');
  let fd: number | undefined;
  try {
    opsPath(path); settled(path);
    const entry = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!entry) refuse('s16_ops_continuity_unavailable');
    if (!entry.isFile() || entry.isSymbolicLink() || entry.nlink !== 1n || entry.uid !== BigInt(expected.ownerUid) || entry.mode & 0o7177n) refuse('s16_ops_path_untrusted');
    if (entry.size < 512n || entry.size > BigInt(maximumBytes)) refuse('s16_ops_image_invalid');
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const before = fstatSync(fd, { bigint: true });
    if (!sameFile(entry, before)) refuse('s16_ops_image_changed');
    const header = Buffer.alloc(100);
    if (readSync(fd, header, 0, header.length, 0) !== header.length || header.toString('ascii', 0, 16) !== 'SQLite format 3\0') refuse('s16_ops_image_invalid');
    const encodedPageSize = header.readUInt16BE(16), pageSize = encodedPageSize === 1 ? 65_536 : encodedPageSize;
    if (pageSize < 512 || pageSize > 65_536 || (pageSize & (pageSize - 1)) !== 0 ||
      header.readUInt32BE(24) !== header.readUInt32BE(92) || !header.readUInt32BE(28) ||
      before.size !== BigInt(pageSize) * BigInt(header.readUInt32BE(28))) refuse('s16_ops_image_invalid');
    const applicationId = header.readUInt32BE(68), readerVersion = header.readUInt32BE(60);
    if (applicationId !== expected.applicationId || !expected.formats.includes(readerVersion)) refuse('s16_ops_reader_unsupported');
    const bytes = Number(before.size), buffer = Buffer.alloc(Math.min(bytes, blockBytes)), digest = createHash('sha256');
    let position = 0;
    while (position < bytes) {
      const length = readSync(fd, buffer, 0, Math.min(buffer.length, bytes - position), position);
      if (!length) refuse('s16_ops_image_changed');
      digest.update(buffer.subarray(0, length)); position += length;
    }
    if (readSync(fd, buffer, 0, 1, position) !== 0) refuse('s16_ops_image_changed');
    settled(path);
    const after = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!after || !sameFile(before, after) || !sameFile(before, fstatSync(fd, { bigint: true }))) refuse('s16_ops_image_changed');
    return Object.freeze({ contract: 's16-ledger-image/v1', validation: 'header_and_hash', applicationId, readerVersion, bytes, sha256: digest.digest('hex') });
  } catch (error) {
    if (error instanceof AppError && error.code.startsWith('s16_ops_')) throw error;
    return refuse('s16_ops_path_untrusted');
  } finally { if (fd !== undefined) closeSync(fd); }
}
