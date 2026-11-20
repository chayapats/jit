import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { AppError } from '../../errors';
import { opsPath, opsRead } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import { observeS16LedgerImage, validateS16LedgerReader } from './ledger-image';
import type { S16LedgerSet, S16LedgerSource } from './ledger-set';

function refuse(code = 's16_ops_point_integrity_failed'): never { throw new AppError(code, 409); }
const sha256 = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function exact(value: unknown, keys: readonly string[]): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) refuse();
}
/** The expected hash comes from independent protected receipts, never the candidate's own manifest. */
export interface S16LedgerSetVerification {
  directory: string; installationId: string; id: string; manifestSha256: string;
  readers: ReadonlyArray<Omit<S16LedgerSource, 'database'>>;
}
/** Hash to retain in the outer owning receipt; hashing candidate metadata is not provenance by itself. */
export function s16LedgerSetManifestHash(manifest: Readonly<S16LedgerSet>): string { return sha256(canonical(manifest)); }

/**
 * Verifies an exact private point against independent receipt/reader expectations and real image
 * hashes/integrity. Returns metadata only. Current continuity reconciliation and restore/admission
 * authority are deliberately absent; a valid historical image can never replace those checks.
 */
export function verifyS16LedgerSet(options: S16LedgerSetVerification): Readonly<S16LedgerSet> {
  identity(options.installationId);
  if (!/^[a-f0-9]{32}$/.test(options.id) || !/^[a-f0-9]{64}$/.test(options.manifestSha256) || !Array.isArray(options.readers) || !options.readers.length || options.readers.length > 256) refuse('s16_ops_capture_invalid');
  const ownerUid = process.getuid?.();
  if (ownerUid === undefined || !isAbsolute(options.directory) || normalize(options.directory) !== options.directory) refuse('s16_ops_path_untrusted');
  const readers = (options.readers as S16LedgerSetVerification['readers']).map(reader => {
    if (!reader || typeof reader !== 'object' || !/^[a-z][a-z0-9_-]{0,63}\.sqlite$/.test(reader.name)) refuse('s16_ops_capture_invalid');
    const expected = { ...reader.reader, ownerUid }; validateS16LedgerReader(expected);
    return { name: reader.name, expected: { ...expected, formats: [...expected.formats] } };
  });
  if (new Set(readers.map(reader => reader.name)).size !== readers.length) refuse('s16_ops_capture_invalid');
  const path = join(options.directory, options.id), manifestPath = join(path, 'manifest.json');
  const privateFile = (name: string, directory = false) => {
    opsPath(name); const stat = lstatSync(name);
    if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) || stat.isSymbolicLink() || stat.uid !== ownerUid || stat.mode & (directory ? 0o7077 : 0o7177)) refuse('s16_ops_path_untrusted');
  };
  try {
    privateFile(options.directory, true); privateFile(path, true); privateFile(manifestPath);
    const text = opsRead(manifestPath, 131_072);
    if (sha256(text) !== options.manifestSha256) refuse();
    const parsed: unknown = JSON.parse(text.toString('utf8'));
    exact(parsed, ['contract', 'scope', 'validation', 'installationId', 'id', 'capturedAt', 'bytes', 'images']);
    if (parsed.contract !== 's16-ledger-set/v1' || parsed.scope !== 'caller_selected_ledgers' || parsed.validation !== 'sqlite_integrity_and_image_hashes' ||
      parsed.installationId !== options.installationId || parsed.id !== options.id || !Number.isSafeInteger(parsed.capturedAt) || (parsed.capturedAt as number) < 0 ||
      !Number.isSafeInteger(parsed.bytes) || (parsed.bytes as number) < 512 || (parsed.bytes as number) > 2_147_483_648 || !Array.isArray(parsed.images) || parsed.images.length !== readers.length || canonical(parsed) !== text.toString('utf8')) refuse();
    const expectedNames = readers.map(reader => reader.name).sort();
    if (canonical(readdirSync(path).sort()) !== canonical([...expectedNames, 'manifest.json'].sort())) refuse();
    let bytes = 0;
    const images = parsed.images.map((entry: unknown, index: number) => {
      exact(entry, ['contract', 'validation', 'applicationId', 'readerVersion', 'journalMode', 'bytes', 'sha256', 'name']);
      if (entry.name !== expectedNames[index] || entry.contract !== 's16-ledger-image/v1' || entry.validation !== 'header_and_hash' || entry.journalMode !== 'rollback' ||
        typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)) refuse();
      const reader = readers.find(reader => reader.name === entry.name)!;
      const file = join(path, reader.name), observed = observeS16LedgerImage(file, reader.expected);
      if (canonical({ ...observed, name: reader.name }) !== canonical(entry)) refuse();
      const db = new Database(file, { readonly: true, create: false, strict: true });
      try { if (db.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get()?.quick_check !== 'ok' || db.query('PRAGMA foreign_key_check').get()) refuse(); }
      finally { db.close(true); }
      if (canonical(observeS16LedgerImage(file, reader.expected)) !== canonical(observed)) refuse();
      bytes += observed.bytes; return Object.freeze({ ...observed, name: reader.name });
    });
    if (bytes !== parsed.bytes || sha256(opsRead(manifestPath, 131_072)) !== options.manifestSha256) refuse();
    return Object.freeze({ contract: 's16-ledger-set/v1', scope: 'caller_selected_ledgers', validation: 'sqlite_integrity_and_image_hashes',
      installationId: options.installationId, id: options.id, capturedAt: parsed.capturedAt as number, bytes, images: Object.freeze(images) });
  } catch (error) {
    if (error instanceof AppError && error.code.startsWith('s16_ops_')) throw error;
    return refuse();
  }
}
