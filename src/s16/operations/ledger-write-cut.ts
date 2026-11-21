import { Database } from 'bun:sqlite';
import { AppError } from '../../errors';
import { validateS16LedgerReader } from './ledger-image';
import type { S16LedgerSource } from './ledger-set';

const maximumBytes = 2147483648;
const actualCuts = new WeakMap<S16LedgerWriteCut, { sources: readonly S16LedgerSource[]; assertCurrent(): void }>();
function refuse(code: string): never { throw new AppError(code, 409); }
/** Actual owning source reservations only; this is neither a complete cohort nor activation authority. */
export interface S16LedgerWriteCut {
  readonly sources: readonly S16LedgerSource[];
  readonly released: boolean;
  /** Returns one bounded current serialized image with only SQLite's journal-mode conversion. */
  serialize(name: string): Buffer;
  assertCurrent(): void;
  /** Retries original reservation disposal; unknown rollback keeps this capability unreleased. */
  close(): void;
}
/** Trusted current handles only. A synchronous guard must not mutate sources or retain async work. */
export interface S16LedgerWriteCutOptions {
  sources: readonly S16LedgerSource[]; guard(): void; maxBytes?: number;
  /** Registers disposal before the first reservation, including an opener that subsequently fails. */
  retain?(cut: S16LedgerWriteCut): void;
}
/** Requires the original live cut over these exact handles; a caller-created object or transaction is insufficient. */
export function assertS16LedgerWriteCutFor(cut: S16LedgerWriteCut, sources: readonly S16LedgerSource[], options: { subset?: true } = {}): void {
  const actual = cut && typeof cut === 'object' ? actualCuts.get(cut) : undefined;
  if (!actual || sources.length > 256 || !options.subset && sources.length !== actual.sources.length || new Set(sources.map(source => source.name)).size !== sources.length || new Set(sources.map(source => source.database)).size !== sources.length || sources.some(source => !actual.sources.some(held => held.name === source.name && held.database === source.database))) refuse('s16_ops_source_cut_invalid');
  actual.assertCurrent();
}
/**
 * Holds a simultaneous actual main-database writer cut without writing source pages or opening an
 * owning application. The caller must retain/close the original cut before releasing process leases.
 */
export function openS16LedgerWriteCut(options: S16LedgerWriteCutOptions): S16LedgerWriteCut {
  const limit = options.maxBytes ?? maximumBytes, ownerUid = process.getuid?.();
  if (ownerUid === undefined) refuse('s16_ops_path_untrusted');
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximumBytes || !Array.isArray(options.sources) || !options.sources.length || options.sources.length > 256) refuse('s16_ops_capture_invalid');
  const sources: S16LedgerSource[] = (options.sources as readonly S16LedgerSource[]).map(source => {
    if (!source || typeof source !== 'object' || !(source.database instanceof Database) || !/^[a-z][a-z0-9_-]{0,63}\.sqlite$/.test(source.name)) refuse('s16_ops_capture_invalid');
    validateS16LedgerReader({ ...source.reader, ownerUid });
    return Object.freeze({ ...source, reader: Object.freeze({ ...source.reader, formats: Object.freeze([...source.reader.formats]) }) });
  }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
  if (new Set(sources.map(source => source.name)).size !== sources.length || new Set(sources.map(source => source.database)).size !== sources.length) refuse('s16_ops_capture_invalid');
  const held: Database[] = [], sizes = new Map<string, number>(), stamps = new Map<Database, { changes: number; schema: number; application: number; version: number }>(); let released = false, ready = false;
  const guard = () => { if ((options.guard() as unknown) !== undefined) refuse('s16_ops_capture_invalid'); };
  const assertCurrent = () => {
    if (released || !ready) refuse('s16_ops_source_cut_closed'); guard();
    if (held.some(database => !database.inTransaction)) refuse('s16_ops_source_cut_lost');
    for (const [database, before] of stamps) {
      const changes = database.query<{ n: number }, []>('SELECT total_changes() n').get()!.n, schema = database.query<{ schema_version: number }, []>('PRAGMA main.schema_version').get()!.schema_version;
      const application = database.query<{ application_id: number }, []>('PRAGMA main.application_id').get()!.application_id, version = database.query<{ user_version: number }, []>('PRAGMA main.user_version').get()!.user_version;
      if (changes !== before.changes || schema !== before.schema || application !== before.application || version !== before.version) refuse('s16_ops_source_cut_changed');
    }
  };
  const close = () => {
    if (released) return; ready = false; let failed = false;
    for (const database of [...held].reverse()) try { if (database.inTransaction) database.exec('ROLLBACK'); } catch { failed = true; }
    if (failed) refuse('s16_ops_source_release_unknown'); released = true;
  };
  const cut: S16LedgerWriteCut = Object.freeze<S16LedgerWriteCut>({ sources: Object.freeze(sources), get released() { return released; }, assertCurrent, close, serialize(name) {
    assertCurrent(); const source = sources.find(source => source.name === name), size = sizes.get(name); if (!source || size === undefined) refuse('s16_ops_source_unavailable');
    const data = source.database.serialize(); if (data.byteLength !== size) refuse('s16_ops_capture_bounds');
    if (data[18] !== data[19] || ![1, 2].includes(data[18]!)) refuse('s16_ops_image_invalid');
    // SQLite's documented serialized-image conversion, shared with complete SQL capture.
    data[18] = 1; data[19] = 1; assertCurrent(); return data;
  } });
  actualCuts.set(cut, { sources, assertCurrent });
  try {
    guard(); if ((options.retain?.(cut) as unknown) !== undefined) refuse('s16_ops_guard_invalid'); guard();
    for (const source of sources) {
      const database = source.database;
      if (database.inTransaction) refuse('s16_ops_source_busy');
      if (database.query<{ name: string }, []>('PRAGMA database_list').all().some(row => !['main', 'temp'].includes(row.name))) refuse('s16_ops_attached_unsupported');
      if (database.query<{ query_only: number }, []>('PRAGMA query_only').get()?.query_only !== 0) refuse('s16_ops_source_not_writable');
      try { database.exec('BEGIN IMMEDIATE'); held.push(database); } catch { refuse('s16_ops_source_busy'); }
      const application = database.query<{ application_id: number }, []>('PRAGMA application_id').get()?.application_id, version = database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version;
      if (application === undefined || version === undefined || (application >>> 0) !== source.reader.applicationId || !source.reader.formats.includes(version >>> 0)) refuse('s16_ops_reader_unsupported');
      const table = database.query<{ name: string }, []>("SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 1").get();
      if (!table) refuse('s16_ops_source_not_writable');
      // BEGIN IMMEDIATE alone also succeeds on read-only handles. Zero-row main DML proves writability.
      try { database.exec(`DELETE FROM main."${table.name.replaceAll('"', '""')}" WHERE 0`); } catch { refuse('s16_ops_source_not_writable'); }
    }
    guard(); let total = 0;
    for (const { database, reader, name } of sources) {
      const application = database.query<{ application_id: number }, []>('PRAGMA application_id').get()?.application_id, version = database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version;
      if (application === undefined || version === undefined || (application >>> 0) !== reader.applicationId || !reader.formats.includes(version >>> 0)) refuse('s16_ops_reader_unsupported');
      const size = database.query<{ page_count: number }, []>('PRAGMA page_count').get()!.page_count * database.query<{ page_size: number }, []>('PRAGMA page_size').get()!.page_size;
      if (!Number.isSafeInteger(size) || size < 512 || size > 1073741824 || (total += size) > limit) refuse('s16_ops_capture_bounds');
      if (database.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get()?.quick_check !== 'ok' || database.query('PRAGMA foreign_key_check').get()) refuse('s16_ops_continuity_invalid');
      sizes.set(name, size);
      stamps.set(database, { changes: database.query<{ n: number }, []>('SELECT total_changes() n').get()!.n, schema: database.query<{ schema_version: number }, []>('PRAGMA main.schema_version').get()!.schema_version, application, version });
    }
    ready = true; assertCurrent(); return cut;
  } catch (error) { close(); throw error; }
}
