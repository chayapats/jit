import { Database } from 'bun:sqlite';
import { lstatSync, mkdirSync } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { AppError } from '../../errors';
import { opsPath, opsSyncDirectory, opsWrite } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import { observeS16LedgerImage, validateS16LedgerReader, type S16LedgerImage } from './ledger-image';

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
}

/**
 * Captures trusted SQLite handles under simultaneous writer reservations, then durably publishes one
 * private manifest after releasing every reservation and rechecking the outer fence. No source is
 * opened, created, migrated, closed or replayed. This is not an ordinary export or complete backup.
 */
export function captureS16LedgerSet(options: S16LedgerSetOptions): Readonly<S16LedgerSet> {
  identity(options.installationId);
  if (!/^[a-f0-9]{32}$/.test(options.id) || !Array.isArray(options.sources) || !options.sources.length || options.sources.length > 256 || typeof options.guard !== 'function') refuse('s16_ops_capture_invalid');
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
  const target = join(options.directory, options.id), held: Database[] = [], images: S16LedgerSet['images'][number][] = [];
  let bytes = 0, releaseFailed = false;
  const sizes = new Map<Database, number>();
  const current = () => { if ((options.guard() as unknown) !== undefined) refuse('s16_ops_capture_invalid'); };
  try {
    current();
    for (const source of sources) {
      if (source.database.inTransaction) refuse('s16_ops_source_busy');
      if (source.database.query<{ name: string }, []>('PRAGMA database_list').all().some(row => !['main', 'temp'].includes(row.name))) refuse('s16_ops_attached_unsupported');
      if (source.database.query<{ query_only: number }, []>('PRAGMA query_only').get()?.query_only !== 0) refuse('s16_ops_source_not_writable');
      try { source.database.exec('BEGIN IMMEDIATE'); held.push(source.database); } catch { refuse('s16_ops_source_busy'); }
      const db = source.database, applicationId = db.query<{ application_id: number }, []>('PRAGMA application_id').get()?.application_id,
        version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version;
      if (applicationId === undefined || version === undefined || (applicationId >>> 0) !== source.reader.applicationId || !source.reader.formats.includes(version >>> 0)) refuse('s16_ops_reader_unsupported');
      // Read-only/query-only SQLite accepts BEGIN IMMEDIATE without the promised write reservation.
      // A zero-row DML probe requires the actual main writer transaction without changing any row,
      // dirtying a header page, firing row triggers or relying on a temporary database's writability.
      const table = db.query<{ name: string }, []>("SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 1").get();
      if (!table) refuse('s16_ops_source_not_writable');
      try { db.exec(`DELETE FROM main."${table.name.replaceAll('"', '""')}" WHERE 0`); } catch { refuse('s16_ops_source_not_writable'); }
    }
    current();
    let planned = 0;
    for (const source of sources) {
      const db = source.database, pageSize = db.query<{ page_size: number }, []>('PRAGMA page_size').get()?.page_size,
        pages = db.query<{ page_count: number }, []>('PRAGMA page_count').get()?.page_count,
        applicationId = db.query<{ application_id: number }, []>('PRAGMA application_id').get()?.application_id,
        version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version;
      if (applicationId === undefined || version === undefined || (applicationId >>> 0) !== source.reader.applicationId || !source.reader.formats.includes(version >>> 0)) refuse('s16_ops_reader_unsupported');
      const size = pageSize! * pages!;
      if (!Number.isSafeInteger(size) || size < 512 || size > 1_073_741_824 || planned + size > limit) refuse('s16_ops_capture_bounds');
      if (db.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get()?.quick_check !== 'ok' || db.query('PRAGMA foreign_key_check').get()) refuse('s16_ops_continuity_invalid');
      sizes.set(db, size); planned += size;
    }
    try { mkdirSync(target, { mode: 0o700 }); } catch { refuse('s16_ops_point_unavailable'); }
    opsSyncDirectory(options.directory);
    for (const source of sources) {
      current();
      const data = source.database.serialize();
      if (data.byteLength !== sizes.get(source.database) || bytes + data.byteLength > limit) refuse('s16_ops_capture_bounds');
      // SQLite's documented serialized-image conversion; user_version and every source page stay unchanged.
      if (data[18] !== data[19] || ![1, 2].includes(data[18]!)) refuse('s16_ops_image_invalid');
      data[18] = 1; data[19] = 1;
      const path = join(target, source.name);
      opsWrite(path, data);
      const staged = new Database(path, { readonly: true, create: false, strict: true });
      try {
        if (staged.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get()?.quick_check !== 'ok' || staged.query('PRAGMA foreign_key_check').get()) refuse('s16_ops_continuity_invalid');
      } finally { staged.close(true); }
      const image = observeS16LedgerImage(path, { ...source.reader, ownerUid });
      bytes += image.bytes; images.push(Object.freeze({ ...image, name: source.name }));
    }
  } finally {
    for (const database of held.reverse()) { try { database.exec('ROLLBACK'); } catch { releaseFailed = true; } }
    if (releaseFailed) refuse('s16_ops_source_release_unknown');
  }
  current();
  const manifest = Object.freeze({ contract: 's16-ledger-set/v1' as const, scope: 'caller_selected_ledgers' as const,
    validation: 'sqlite_integrity_and_image_hashes' as const,
    installationId: options.installationId, id: options.id, capturedAt, bytes, images: Object.freeze(images) });
  const text = canonical(manifest);
  if (Buffer.byteLength(text) > 131_072) refuse('s16_ops_capture_bounds');
  opsWrite(join(target, 'manifest.json'), text);
  return manifest;
}
