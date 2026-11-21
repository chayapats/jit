import { Database } from 'bun:sqlite';
import { lstatSync, mkdirSync, opendirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isAbsolute, join, normalize } from 'node:path';
import { AppError } from '../../errors';
import { opsPath, opsSyncDirectory, opsWrite } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import { observeS16LedgerImage, validateS16LedgerReader, type S16LedgerImage } from './ledger-image';
import { verifyS16PayloadSources } from './payload-set';
import { openS16LedgerWriteCut, type S16LedgerWriteCut } from './ledger-write-cut';

const maximumBytes = 2_147_483_648;
function refuse(code: string): never { throw new AppError(code, 409); }
/** Owning protected connection and reviewed reader, never a path/handle supplied by the execution plane. */
export interface S16LedgerSource {
  name: string;
  database: Database;
  reader: { applicationId: number; formats: readonly number[] };
}
/** A selected SQLite cut only; installation completeness and restore authority remain with the coordinator. */
export interface S16LedgerSet {
  contract: 's16-ledger-set/v1';
  scope: 'caller_selected_ledgers';
  validation: 'sqlite_integrity_and_image_hashes';
  installationId: string;
  id: string;
  capturedAt: number;
  bytes: number;
  images: ReadonlyArray<Readonly<S16LedgerImage> & { readonly name: string }>;
}
/** Protected capture controls. The synchronous guard must recheck the owning maintenance/owner/config fence. */
export interface S16LedgerSetOptions {
  directory: string; installationId: string; id: string; sources: readonly S16LedgerSource[];
  guard(): void;
  now?: () => number;
  maxBytes?: number;
  /** Original protected staging only: compare every existing image to a fresh complete current cut; never overwrite. */
  resume?: true;
  /** Existing authenticated publication only: compare current sources and refuse every missing member. */
  verifyOnly?: true;
}

/**
 * Captures trusted SQLite handles under simultaneous writer reservations, then durably publishes one
 * private manifest after releasing every reservation and rechecking the outer fence. No source is
 * opened, created, migrated, closed or replayed. This is not an ordinary export or complete backup.
 */
export function captureS16LedgerSet(options: S16LedgerSetOptions): Readonly<S16LedgerSet> {
  identity(options.installationId);
  if (!/^[a-f0-9]{32}$/.test(options.id) || !Array.isArray(options.sources) || !options.sources.length || options.sources.length > 256 || typeof options.guard !== 'function' || options.resume !== undefined && options.resume !== true || options.verifyOnly !== undefined && (options.verifyOnly !== true || !options.resume)) refuse('s16_ops_capture_invalid');
  const limit = options.maxBytes ?? maximumBytes;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumBytes) refuse('s16_ops_capture_invalid');
  const ownerUid = process.getuid?.();
  if (ownerUid === undefined) refuse('s16_ops_path_untrusted');
  const sources: S16LedgerSource[] = (options.sources as readonly S16LedgerSource[]).map(source => {
    if (!source || typeof source !== 'object') refuse('s16_ops_capture_invalid');
    const reader = { ...source.reader, ownerUid }; validateS16LedgerReader(reader);
    return { ...source, reader: { ...reader, formats: [...reader.formats] } };
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (sources.some(source => !/^[a-z][a-z0-9_-]{0,63}\.sqlite$/.test(source.name) || !(source.database instanceof Database)) ||
    new Set(sources.map(source => source.name)).size !== sources.length || new Set(sources.map(source => source.database)).size !== sources.length) refuse('s16_ops_capture_invalid');
  if (!isAbsolute(options.directory) || normalize(options.directory) !== options.directory) refuse('s16_ops_path_untrusted');
  try {
    opsPath(options.directory);
    const directory = lstatSync(options.directory);
    if (!directory.isDirectory() || directory.isSymbolicLink() || directory.uid !== ownerUid || directory.mode & 0o7077) refuse('s16_ops_path_untrusted');
  } catch { return refuse('s16_ops_path_untrusted'); }
  const capturedAt = (options.now ?? Date.now)();
  if (!Number.isSafeInteger(capturedAt) || capturedAt < 0) refuse('s16_ops_capture_invalid');
  const target = join(options.directory, options.id), images: S16LedgerSet['images'][number][] = [];
  let bytes = 0, cut: S16LedgerWriteCut | undefined;
  let targetEntry: ReturnType<typeof lstatSync> | undefined;
  const current = () => {
    if ((options.guard() as unknown) !== undefined) refuse('s16_ops_capture_invalid');
    if (targetEntry) { const now = lstatSync(target); if (!now.isDirectory() || now.isSymbolicLink() || now.uid !== ownerUid || now.mode & 0o7077 || now.ino !== targetEntry.ino || now.dev !== targetEntry.dev || now.mode !== targetEntry.mode) refuse('s16_ops_image_changed'); }
  };
  const inventory = () => { const names = new Set([...sources.map(source => source.name), 'manifest.json']), dir = opendirSync(target); let count = 0;
    try { for (;;) { const item = dir.readSync(); if (!item) break; if (++count > sources.length + 1 || !names.has(item.name)) refuse('s16_ops_inventory_changed'); } } finally { dir.closeSync(); } };
  try {
    current();
    cut = openS16LedgerWriteCut({ sources, guard: current, maxBytes: limit });
    if (lstatSync(target, { throwIfNoEntry: false })) { if (!options.resume) refuse('s16_ops_point_unavailable'); }
    else { if (options.verifyOnly) refuse('s16_ops_point_unavailable'); try { mkdirSync(target, { mode: 0o700 }); } catch { refuse('s16_ops_point_unavailable'); } }
    targetEntry = lstatSync(target); current(); inventory();
    opsSyncDirectory(options.directory);
    for (const source of sources) {
      current();
      const data = cut.serialize(source.name);
      if (bytes + data.byteLength > limit) refuse('s16_ops_capture_bounds');
      const path = join(target, source.name);
      if (lstatSync(path, { throwIfNoEntry: false })) {
        const existing = observeS16LedgerImage(path, { ...source.reader, ownerUid });
        if (existing.bytes !== data.byteLength || existing.sha256 !== createHash('sha256').update(data).digest('hex')) refuse('s16_ops_image_changed');
      } else { if (options.verifyOnly) refuse('s16_ops_image_changed'); opsWrite(path, data); }
      const staged = new Database(path, { readonly: true, create: false, strict: true });
      try {
        if (staged.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get()?.quick_check !== 'ok' || staged.query('PRAGMA foreign_key_check').get()) refuse('s16_ops_continuity_invalid');
      } finally { staged.close(true); }
      const image = observeS16LedgerImage(path, { ...source.reader, ownerUid });
      bytes += image.bytes; images.push(Object.freeze({ ...image, name: source.name }));
    }
  } finally {
    cut?.close();
  }
  current();
  const manifest = Object.freeze({ contract: 's16-ledger-set/v1' as const, scope: 'caller_selected_ledgers' as const,
    validation: 'sqlite_integrity_and_image_hashes' as const,
    installationId: options.installationId, id: options.id, capturedAt, bytes, images: Object.freeze(images) });
  const text = canonical(manifest);
  if (Buffer.byteLength(text) > 131_072) refuse('s16_ops_capture_bounds');
  const path = join(target, 'manifest.json'); current(); inventory();
  if (lstatSync(path, { throwIfNoEntry: false })) verifyS16PayloadSources([{ name: 'manifest', path, bytes: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') }], current);
  else { if (options.verifyOnly) refuse('s16_ops_image_changed'); opsWrite(path, text); }
  current(); inventory();
  return manifest;
}
