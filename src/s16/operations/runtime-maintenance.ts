import { Database } from 'bun:sqlite';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { AppError } from '../../errors';
import { opsPath, opsRead } from '../../s14/ops-files';
import { identity } from '../../s15/conversation/validation';
import { vector } from '../../s15/policy/validation';
import type { S16LedgerSource } from './ledger-set';
import { s16RuntimeReaders } from './runtime-readers';

function refuse(code: string): never { throw new AppError(code, 409); }
const baseStores = ['conversation.sqlite', 'policy.sqlite', 'model.sqlite', 'work.sqlite', 'vm.sqlite', 'team.sqlite', 'memory.sqlite'];
const durable = new Set(['model.sqlite', 'work.sqlite', 'disclosure.sqlite', 'files.sqlite', 'routines.sqlite', 'notifications.sqlite', 'voice.sqlite']);
function sameEntry(a: BigIntStats, b: BigIntStats) { return a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink; }
const auxiliary = (name: string) => name.endsWith('.runtime-lock.sqlite') && Object.hasOwn(s16RuntimeReaders, name.slice(0, -'.runtime-lock.sqlite'.length));
function metadataJson(db: Database, vm: boolean): void {
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 257").all();
  if (tables.length > 256) refuse('s16_ops_continuity_invalid');
  const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  for (const table of tables) {
    const columns = db.query<{ name: string; type: string }, []>(`PRAGMA table_info(${quote(table.name)})`).all();
    for (const column of columns) if (column.type.toUpperCase() === 'TEXT' && (column.name === 'json' || column.name.endsWith('_json') || vm && column.name === 'data')) {
      if (db.query(`SELECT 1 FROM ${quote(table.name)} WHERE ${quote(column.name)} IS NOT NULL AND json_valid(${quote(column.name)})=0 LIMIT 1`).get()) refuse('s16_ops_continuity_invalid');
    }
  }
}
/** Explicit protected operator input, never ordinary client/model/archive paths or declarations. */
export interface S16RuntimeMaintenanceOptions {
  directory: string;
  installationId: string;
  /** Exact current configured browser resource, required if its selected/retained ledger exists. */
  browserResourceId?: string;
}
/** Protected host capability only. No returned handle/row is an ordinary export or execution-plane input. */
export interface S16RuntimeMaintenance {
  readonly sources: readonly S16LedgerSource[];
  readonly selected: readonly string[];
  readonly retained: readonly string[];
  assertCurrent(): void;
  close(): void;
}

/**
 * Opens only existing selected/retained runtime ledgers behind the same OS-released CHAT process
 * lease as composeS15. No owning service boot, model, parser, guest, migration or application replay
 * runs. SQLite may perform its own committed-page recovery; application rows are never initialized.
 * Outer owner/vault/site/helper/native/byte custody remains outside this runtime-only capability.
 */
export function openS16RuntimeMaintenance(options: S16RuntimeMaintenanceOptions): S16RuntimeMaintenance {
  identity(options.installationId);
  const root = options.directory, uid = process.getuid?.();
  if (uid === undefined || !isAbsolute(root) || normalize(root) !== root) refuse('s16_ops_path_untrusted');
  const privateEntry = (path: string, directory = false): BigIntStats => {
    try { opsPath(path); } catch { refuse('s16_ops_path_untrusted'); }
    const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!stat) refuse('s16_ops_continuity_unavailable');
    if ((directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) || stat.isSymbolicLink() || stat.uid !== BigInt(uid) || stat.mode & (directory ? 0o7077n : 0o7177n)) refuse('s16_ops_path_untrusted');
    return stat;
  };
  let lease: Database | undefined, usable = true, closed = false;
  const opened: Database[] = [], entries = new Map<string, BigIntStats>();
  const close = () => {
    if (closed) return; usable = false;
    let failed = false;
    for (const db of [...opened].reverse()) { try { db.close(true); } catch { failed = true; } }
    // Keep the process lease when a source did not close conclusively; a later close may retry it.
    if (failed) refuse('s16_ops_source_release_unknown');
    try { lease?.close(true); } catch { refuse('s16_ops_source_release_unknown'); }
    closed = true;
  };
  try {
    privateEntry(root, true);
    const manifestPath = join(root, 'composition.json'); privateEntry(manifestPath);
    const manifestBytes = opsRead(manifestPath, 16_384), manifest: unknown = JSON.parse(manifestBytes.toString('utf8'));
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest) || Object.keys(manifest).sort().join(',') !== 'contract,installationId,stores') refuse('s16_ops_inventory_changed');
    const declared = manifest as { contract: unknown; installationId: unknown; stores: unknown }, listed = declared.stores;
    if (declared.contract !== 's15-composition/v1' || declared.installationId !== options.installationId || !Array.isArray(listed) ||
      listed.length > 17 || !baseStores.every(name => listed.includes(name)) ||
      listed.some(name => typeof name !== 'string' || !Object.hasOwn(s16RuntimeReaders, name)) || new Set(listed).size !== listed.length) refuse('s16_ops_inventory_changed');
    const selected = [...listed] as string[];
    const names = readdirSync(root), retained = names.filter(name => Object.hasOwn(s16RuntimeReaders, name) && !selected.includes(name));
    for (const name of names) {
      if (name.endsWith('.sqlite') && !Object.hasOwn(s16RuntimeReaders, name) && !auxiliary(name)) refuse('s16_ops_inventory_changed');
    }
    const all = [...selected, ...retained].sort();
    for (const name of all) privateEntry(join(root, name));
    const lockPath = join(root, 'conversation.sqlite.runtime-lock.sqlite'), lockEntry = privateEntry(lockPath);
    lease = new Database(lockPath, { readwrite: true, create: false, strict: true });
    try { lease.exec('PRAGMA busy_timeout=10; BEGIN EXCLUSIVE'); } catch { refuse('s16_ops_service_active'); }
    if (!sameEntry(lockEntry, privateEntry(lockPath))) refuse('s16_ops_image_changed');
    const sources = all.map(name => {
      const path = join(root, name), before = privateEntry(path), reader = s16RuntimeReaders[name]!;
      if (before.size < 512n || before.size > 1_073_741_824n) refuse('s16_ops_image_invalid');
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), header = Buffer.alloc(100);
      try {
        if (!sameEntry(before, fstatSync(fd, { bigint: true })) || readSync(fd, header, 0, 100, 0) !== 100 || header.toString('ascii', 0, 16) !== 'SQLite format 3\0') refuse('s16_ops_image_invalid');
      } finally { closeSync(fd); }
      if (header.readUInt32BE(68) !== reader.applicationId || !reader.formats.includes(header.readUInt32BE(60))) refuse('s16_ops_reader_unsupported');
      const db = new Database(path, { readwrite: true, create: false, strict: true }); opened.push(db);
      db.exec('PRAGMA trusted_schema=OFF');
      const application = db.query<{ application_id: number }, []>('PRAGMA application_id').get()?.application_id,
        version = db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version;
      if (application === undefined || version === undefined || (application >>> 0) !== reader.applicationId || !reader.formats.includes(version >>> 0) || (version >>> 0) < header.readUInt32BE(60)) refuse('s16_ops_reader_unsupported');
      if (name === 'policy.sqlite') {
        const row = db.query<{ json: string }, []>("SELECT json FROM meta WHERE key='installation'").get();
        const charged = db.query<{ json: string }, []>("SELECT json FROM meta WHERE key='charged'").get();
        if (!row || JSON.parse(row.json) !== options.installationId || !charged) refuse('s16_ops_continuity_invalid');
        vector(JSON.parse(charged.json));
      } else if (name === 'browser.sqlite') {
        if (!options.browserResourceId) refuse('s16_ops_source_unavailable'); identity(options.browserResourceId);
        const rows = db.query<{ singleton: number; resource: string; generation: number }, []>('SELECT singleton,resource,generation FROM browser_state LIMIT 2').all();
        if (rows.length !== 1 || rows[0]!.singleton !== 1 || rows[0]!.resource !== options.browserResourceId || !Number.isSafeInteger(rows[0]!.generation) || rows[0]!.generation < 1) refuse('s16_ops_continuity_invalid');
      } else if (name !== 'vm.sqlite') {
        const rows = durable.has(name) ? db.query<{ installation: string }, []>('SELECT installation FROM identity LIMIT 2').all().map(row => row.installation) : db.query<{ id: string }, []>('SELECT id FROM identity LIMIT 2').all().map(row => row.id);
        if (rows.length !== 1 || rows[0] !== options.installationId) refuse('s16_ops_continuity_invalid');
      }
      metadataJson(db, name === 'vm.sqlite');
      const after = privateEntry(path); if (!sameEntry(before, after)) refuse('s16_ops_image_changed'); entries.set(path, after);
      return Object.freeze({ name, database: db, reader });
    });
    const assertCurrent = () => {
      if (!usable || closed || !lease?.inTransaction) refuse('s16_ops_maintenance_closed');
      if (!sameEntry(lockEntry, privateEntry(lockPath)) || !opsRead(manifestPath, 16_384).equals(manifestBytes)) refuse('s16_ops_inventory_changed');
      if (JSON.stringify(readdirSync(root).filter(name => name.endsWith('.sqlite') && !auxiliary(name)).sort()) !== JSON.stringify(all)) refuse('s16_ops_inventory_changed');
      for (const [path, entry] of entries) {
        const current = privateEntry(path);
        if (!sameEntry(entry, current) || entry.size !== current.size || entry.mtimeNs !== current.mtimeNs || entry.ctimeNs !== current.ctimeNs) refuse('s16_ops_image_changed');
      }
    };
    assertCurrent();
    return Object.freeze({ sources: Object.freeze(sources), selected: Object.freeze(selected), retained: Object.freeze(retained), assertCurrent, close });
  } catch (error) {
    close();
    if (error instanceof AppError && error.code.startsWith('s16_ops_')) throw error;
    return refuse('s16_ops_continuity_invalid');
  }
}
