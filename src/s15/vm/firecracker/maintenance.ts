import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../../errors';
import { opsPath } from '../../../s14/ops-files';
import { identity } from '../../conversation/validation';
import { reserveDurableJournalPath, type DurableJournalPathReservation } from '../../durable-ownership';
import { vmCanonical, vmRecord } from '../validation';
import { firecrackerHostCommand, type FirecrackerHostCommand } from './jobs';
import { firecrackerRpcReceipt, type FirecrackerRpcScope } from './rpc';
import type { S16LedgerSource } from '../../../s16/operations/ledger-set';

const reader = Object.freeze({ applicationId: 0x4a46434a, formats: Object.freeze([1]) });
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function refuse(code = 's16_ops_helper_custody_invalid'): never { throw new AppError(code, 409); }
interface Manager { id: string; origin: string; computerId: string; selectionSha256: string }
/** Current original controller intent, never a report of root-helper/VM physical settlement. */
export interface FirecrackerControllerCustody {
  readonly managerId: string; readonly source: string; readonly computerId: string; readonly selectionSha256: string;
  readonly basis: FirecrackerRpcScope['basis'];
  readonly pending: Readonly<{ requestId: string; kind: FirecrackerHostCommand['kind']; state: 'accepted' | 'dispatched' | 'unknown'; commandSha256: string; expectedRevision: number; expectedLaunchId: string | null }> | null;
}
/** Raw existing owning journals under their original process leases; no constructor/recovery or RPC escapes. */
export interface FirecrackerControllerMaintenance {
  readonly sources: readonly S16LedgerSource[];
  readonly controllers: readonly FirecrackerControllerCustody[];
  assertCurrent(): void;
  close(): void;
}
/** Trusted current composition only. The parent retains installation/CHAT exclusion throughout. */
export interface FirecrackerControllerMaintenanceOptions {
  runtimeDirectory: string; installationId: string; vm: Database; guard(): void;
  retain?(capability: FirecrackerControllerMaintenance): void;
}
function entry(path: string, directory = false): BigIntStats {
  opsPath(path); const stat = lstatSync(path, { bigint: true });
  if (stat.uid !== BigInt(process.getuid?.() ?? -1) || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) || stat.mode & (directory ? 0o7077n : 0o7177n)) refuse('s16_ops_path_untrusted'); return stat;
}
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const sameEntry = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.nlink === b.nlink;
const names = (path: string) => readdirSync(path).sort();
/**
 * Binds every registered controller's existing intent journal to actual current VM metadata. Missing,
 * foreign, future or untracked state refuses. No adapter constructor, metadata conversion, credential,
 * helper call, guest command, mutation replay, lock creation or empty-state fallback is performed.
 */
export function openFirecrackerControllerMaintenance(options: FirecrackerControllerMaintenanceOptions): FirecrackerControllerMaintenance {
  const { runtimeDirectory, installationId, vm } = options; identity(installationId);
  const directory = join(runtimeDirectory, 'vm-firecracker'), sources: S16LedgerSource[] = [], controllers: FirecrackerControllerCustody[] = [];
  const opened: Database[] = [], leases: Database[] = [], reservations: DurableJournalPathReservation[] = [], files = new Map<string, BigIntStats>();
  let closed = false, usable = true, originalNames: string[] | null = null, directoryEntry: BigIntStats | null = null;
  const current = () => { if (closed || !usable) refuse('s16_ops_maintenance_closed'); if ((options.guard() as unknown) !== undefined) refuse('s16_ops_guard_invalid'); };
  const close = () => {
    if (closed) return; usable = false; let unknown = false;
    for (const db of [...opened].reverse()) try { db.close(true); } catch { unknown = true; }
    if (unknown) refuse('s16_ops_source_release_unknown');
    for (const db of [...leases].reverse()) try { db.close(true); } catch { unknown = true; }
    if (unknown) refuse('s16_ops_source_release_unknown');
    for (const reservation of reservations) reservation.release(); closed = true;
  };
  const assertCurrent = () => {
    current();
    if (directoryEntry) {
      const stat = entry(directory, true); if (stat.dev !== directoryEntry.dev || stat.ino !== directoryEntry.ino || stat.mode !== directoryEntry.mode || stat.uid !== directoryEntry.uid || JSON.stringify(names(directory)) !== JSON.stringify(originalNames)) refuse('s16_ops_helper_inventory_changed');
    } else if (lstatSync(directory, { throwIfNoEntry: false })) refuse('s16_ops_helper_inventory_changed');
    for (const [path, before] of files) if (!same(before, entry(path))) refuse('s16_ops_image_changed');
    if (leases.some(lease => !lease.inTransaction)) refuse('s16_ops_source_release_unknown');
  };
  const capability = Object.freeze({ sources, controllers, assertCurrent, close });
  try {
    if ((options.retain?.(capability) as unknown) !== undefined) refuse('s16_ops_guard_invalid'); current();
    const attached = vm.query<{ name: string; file: string }, []>('PRAGMA database_list').all();
    if (attached.length !== 1 || attached[0]!.name !== 'main' || attached[0]!.file !== join(runtimeDirectory, 'vm.sqlite') ||
      vm.query<{ application_id: number }, []>('PRAGMA application_id').get()?.application_id !== 0x4a495456 || ![1, 2, 3].includes(vm.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? -1)) refuse();
    const managers: Manager[] = [];
    if (vm.query("SELECT 1 FROM main.sqlite_schema WHERE type='table' AND name='vm_managers'").get()) {
      const bound = vm.query<{ n: number; bytes: number; invalid: number }, []>("SELECT count(*) n,coalesce(sum(length(CAST(data AS BLOB))),0) bytes,coalesce(sum(typeof(id)<>'text' OR length(CAST(id AS BLOB)) NOT BETWEEN 1 AND 128 OR typeof(data)<>'text' OR length(CAST(data AS BLOB))>131072 OR json_valid(data)=0),0) invalid FROM main.vm_managers").get();
      if (!bound || bound.n > 64 || bound.bytes > 8_388_608 || bound.invalid) refuse('s16_ops_helper_bounds');
      const computers = new Set<string>();
      for (const row of vm.query<{ id: string; data: string }, []>("SELECT id,data FROM main.vm_managers WHERE json_extract(data,'$.kind')='firecracker' ORDER BY id LIMIT 65").all()) {
        identity(row.id); const value = vmRecord(JSON.parse(row.data), ['kind', 'origin', 'computerId', 'selectionSha256']);
        const origin = typeof value.origin === 'string' ? new URL(value.origin) : null;
        if (!origin || origin.origin !== value.origin || origin.protocol !== 'http:' || origin.hostname !== '127.0.0.1' || origin.username || origin.password || typeof value.computerId !== 'string' || !/^jit-work(?:-[a-z0-9-]{1,54})?$/.test(value.computerId) || typeof value.selectionSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.selectionSha256) || computers.has(value.computerId)) refuse();
        computers.add(value.computerId); managers.push({ id: row.id, origin: origin.origin, computerId: value.computerId, selectionSha256: value.selectionSha256 });
      }
    }
    const allowed = new Set(managers.flatMap(manager => [manager.id + '.sqlite', manager.id + '.sqlite.process-lock', manager.id + '.sqlite-journal', manager.id + '.sqlite-wal', manager.id + '.sqlite-shm', manager.id + '.sqlite.process-lock-journal']));
    if (lstatSync(directory, { throwIfNoEntry: false })) {
      directoryEntry = entry(directory, true); originalNames = names(directory); if (originalNames.length > 384) refuse('s16_ops_helper_bounds');
      // Local owners refuse before touching their main-header or process-lock descriptors.
      for (const manager of managers) reservations.push(reserveDurableJournalPath(join(directory, manager.id + '.sqlite')));
      if (originalNames.some(name => !allowed.has(name))) refuse('s16_ops_helper_inventory_changed');
      for (const name of originalNames) entry(join(directory, name));
    } else if (managers.length) refuse('s16_ops_source_unavailable');
    for (const manager of managers) {
      current(); const path = join(directory, manager.id + '.sqlite'), lock = path + '.process-lock';
      // Reserve before ANY descriptor: a failed duplicate opener must not close another owner's fd.
      const before = entry(path), beforeLock = entry(lock); if (before.size < 512n || before.size > 1_073_741_824n || beforeLock.size > 1_048_576n) refuse('s16_ops_helper_bounds');
      const lease = new Database(lock, { readwrite: true, create: false, strict: true }); leases.push(lease);
      try { lease.exec('PRAGMA busy_timeout=10; BEGIN EXCLUSIVE'); } catch { refuse('s16_ops_service_active'); }
      if (lease.query('SELECT 1 FROM main.sqlite_schema LIMIT 1').get() || lease.query<{ application_id: number }, []>('PRAGMA application_id').get()?.application_id !== 0 || lease.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version !== 0 || !sameEntry(beforeLock, entry(lock))) refuse();
      const header = Buffer.alloc(100), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
      try { if (!same(before, fstatSync(fd, { bigint: true })) || readSync(fd, header, 0, 100, 0) !== 100 || header.toString('ascii', 0, 16) !== 'SQLite format 3\0' || header.readUInt32BE(68) !== reader.applicationId || header.readUInt32BE(60) !== 1) refuse('s16_ops_reader_unsupported'); } finally { closeSync(fd); }
      const db = new Database(path, { readwrite: true, create: false, strict: true }); opened.push(db); db.exec('PRAGMA trusted_schema=OFF');
      const identities = db.query<{ installation: string }, []>('SELECT installation FROM main.identity LIMIT 2').all();
      // SQLite may undo an uncommitted hot journal here. Bind the original inode, then retain the
      // validated committed image's full attributes; never run the adapter's application recovery.
      if (!sameEntry(before, entry(path)) || db.query<{ application_id: number }, []>('PRAGMA application_id').get()?.application_id !== reader.applicationId || db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version !== 1 || identities.length !== 1 || identities[0]!.installation !== installationId || db.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get()?.quick_check !== 'ok' || db.query('PRAGMA foreign_key_check').get()) refuse();
      const tables = db.query<{ name: string }, []>("SELECT name FROM main.sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name LIMIT 5").all();
      if (tables.map(row => row.name).join(',') !== 'commands,identity,records' || db.query('SELECT 1 FROM main.commands LIMIT 1').get()) refuse();
      const bound = db.query<{ n: number; bytes: number; invalid: number }, []>("SELECT count(*) n,coalesce(sum(length(CAST(json AS BLOB))),0) bytes,coalesce(sum(typeof(id)<>'text' OR length(CAST(id AS BLOB)) NOT BETWEEN 1 AND 128 OR typeof(json)<>'text' OR length(CAST(json AS BLOB))>131072 OR json_valid(json)=0),0) invalid FROM main.records").get();
      if (!bound || bound.n < 2 || bound.n > 256 || bound.bytes > 67_108_864 || bound.invalid) refuse('s16_ops_helper_bounds');
      const rows = new Map(db.query<{ id: string; json: string }, []>('SELECT id,json FROM main.records ORDER BY id LIMIT 257').all().map(row => [row.id, JSON.parse(row.json) as unknown]));
      const binding = vmRecord(rows.get('binding'), ['contract', 'origin', 'computerId', 'selectionSha256', 'basis']);
      if (binding.contract !== 's16-firecracker-client-binding/v1' || binding.origin !== manager.origin || binding.computerId !== manager.computerId || binding.selectionSha256 !== manager.selectionSha256 || !['protected_host', 'protocol_fixture'].includes(binding.basis as string)) refuse();
      const scope: FirecrackerRpcScope = { computerId: manager.computerId, selectionSha256: manager.selectionSha256, basis: binding.basis as FirecrackerRpcScope['basis'] };
      const active = vmRecord(rows.get('active'), ['requestId']); if (active.requestId !== null && (typeof active.requestId !== 'string' || !/^[a-f0-9]{32}$/.test(active.requestId))) refuse();
      let pending: FirecrackerControllerCustody['pending'] = null;
      for (const [id, value] of rows) {
        if (['binding', 'active'].includes(id)) continue;
        const intent = vmRecord(value, ['contract', 'command', 'state', 'receipt']), command = firecrackerHostCommand(intent.command);
        if (intent.contract !== 's16-firecracker-client-intent/v1' || id !== command.requestId || command.computerId !== manager.computerId || command.selectionSha256 !== manager.selectionSha256 || !['accepted', 'dispatched', 'unknown', 'committed', 'not_sent'].includes(intent.state as string)) refuse();
        const receipt = intent.receipt === null ? null : firecrackerRpcReceipt(intent.receipt, scope, command);
        const unsettled = ['accepted', 'dispatched', 'unknown'].includes(intent.state as string);
        if (unsettled !== (active.requestId === id) || intent.state === 'committed' && receipt?.state !== 'committed' || intent.state === 'not_sent' && receipt !== null && receipt.state !== 'not_sent' || ['accepted', 'dispatched'].includes(intent.state as string) && receipt !== null || intent.state === 'unknown' && receipt && ['committed', 'not_sent'].includes(receipt.state)) refuse();
        if (unsettled) pending = Object.freeze({ requestId: id, kind: command.kind, state: intent.state as 'accepted' | 'dispatched' | 'unknown', commandSha256: hash(vmCanonical(command)), expectedRevision: command.expectedRevision, expectedLaunchId: command.expectedLaunchId });
      }
      if ((active.requestId !== null) !== (pending !== null)) refuse();
      const source = 'fc_' + hash(manager.id).slice(0, 32) + '.sqlite';
      sources.push(Object.freeze({ name: source, database: db, reader })); controllers.push(Object.freeze({ managerId: manager.id, source, computerId: manager.computerId, selectionSha256: manager.selectionSha256, basis: scope.basis, pending }));
      files.set(path, entry(path)); files.set(lock, entry(lock));
    }
    if (directoryEntry) {
      originalNames = names(directory); if (originalNames.length > 384 || originalNames.some(name => !allowed.has(name))) refuse('s16_ops_helper_inventory_changed');
      for (const name of originalNames) if (!files.has(join(directory, name))) files.set(join(directory, name), entry(join(directory, name)));
    }
    Object.freeze(sources); Object.freeze(controllers); assertCurrent(); return capability;
  } catch (error) { close(); if (error instanceof AppError) throw error; return refuse(); }
}
