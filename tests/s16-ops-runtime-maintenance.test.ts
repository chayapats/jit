import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeS15 } from '../src/s15/composition';
import { DurableJournal } from '../src/s15/durable-journal';
import { captureS16LedgerSet } from '../src/s16/operations/ledger-set';
import { openS16RuntimeMaintenance } from '../src/s16/operations/runtime-maintenance';
import { s16LedgerSetManifestHash, verifyS16LedgerSet } from '../src/s16/operations/verify-ledger-set';
import { operationsFixture } from './fixtures/s16-ops';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() { const f = await operationsFixture(); cleanup.push(() => f.close()); return f; }
const config = (f: Awaited<ReturnType<typeof fixture>>) => ({ directory: f.directory, installationId: 'fixture', browserResourceId: f.options(false).browser!.resource.id });

test('live CHAT process lease excludes operator maintenance before any owning connection is opened', async () => {
  const f = await fixture(), rows = f.service.policy.control.usage();
  expect(() => openS16RuntimeMaintenance(config(f))).toThrow(expect.objectContaining({ code: 's16_ops_service_active' }));
  expect(f.service.policy.control.usage()).toEqual(rows); expect(f.modelPrompts).toHaveLength(0);
});

test('offline maintenance captures all existing runtime state without booting models or replaying application recovery', async () => {
  const f = await fixture(); f.cleanupConfirmed = false; await f.chat('Run the requested command in the working computer');
  const prompts = f.modelPrompts.length; await f.service.close();
  const context = openS16RuntimeMaintenance(config(f)); cleanup.push(() => context.close()); context.assertCurrent();
  expect(context.sources).toHaveLength(17); expect(context.retained).toEqual([]); expect(f.modelPrompts).toHaveLength(prompts);
  const directory = join(f.parent, 'offline-points'); mkdirSync(directory, { mode: 0o700 });
  const point = captureS16LedgerSet({ directory, installationId: 'fixture', id: 'a'.repeat(32), sources: context.sources, guard: context.assertCurrent });
  expect(verifyS16LedgerSet({ directory, id: point.id, installationId: point.installationId, readers: context.sources, manifestSha256: s16LedgerSetManifestHash(point) })).toEqual(point);
  const image = new Database(join(directory, point.id, 'team.sqlite'), { readonly: true, create: false }); cleanup.push(() => image.close(true));
  expect(image.query<{ state: string }, []>('SELECT state FROM leases').all().map(row => row.state)).toContain('unknown');
  expect(f.modelPrompts).toHaveLength(prompts); context.close(); context.close();
  expect(() => context.assertCurrent()).toThrow(expect.objectContaining({ code: 's16_ops_maintenance_closed' }));
});

test('the same retained process lease prevents a fresh service from starting until maintenance closes', async () => {
  const f = await fixture(); await f.service.close(); const context = openS16RuntimeMaintenance(config(f)); cleanup.push(() => context.close());
  await expect(composeS15(f.options(false))).rejects.toThrow(); context.assertCurrent(); context.close();
  await f.reopen(); expect(f.service.maintenanceSources(f.owner)).toHaveLength(17);
});

test('an earlier manifest cannot hide a retained optional ledger from capture', async () => {
  const f = await fixture(); await f.service.close(); const path = join(f.directory, 'composition.json'), manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.stores = manifest.stores.filter((name: string) => name !== 'voice.sqlite'); const previous = JSON.stringify(manifest); writeFileSync(path, previous);
  const context = openS16RuntimeMaintenance(config(f)); cleanup.push(() => context.close());
  expect(context.selected).toHaveLength(16); expect(context.retained).toEqual(['voice.sqlite']); expect(context.sources).toHaveLength(17);
  expect(readFileSync(path, 'utf8')).toBe(previous); expect(context.sources.find(source => source.name === 'voice.sqlite')).toBeDefined();
});

test.each(['missing', 'foreign', 'json', 'charged', 'browser', 'unknown', 'permissions'] as const)('invalid %s state refuses without initializing or replaying any ledger', async kind => {
  const f = await fixture(); await f.service.close(); const path = join(f.directory, 'model.sqlite');
  if (kind === 'missing') renameSync(path, path + '.saved');
  if (kind === 'foreign') {
    const directory = join(f.parent, 'foreign'); mkdirSync(directory, { mode: 0o700 }); const other = new DurableJournal(join(directory, 'model.sqlite'), 'other', true, 0x4a4d5135); other.close();
    renameSync(path, path + '.saved'); renameSync(join(directory, 'model.sqlite'), path);
  }
  if (kind === 'json' || kind === 'charged') {
    const db = new Database(join(f.directory, kind === 'json' ? 'team.sqlite' : 'policy.sqlite'), { readwrite: true, create: false });
    try { if (kind === 'json') db.exec("INSERT INTO sources VALUES ('malformed','not json')"); else db.exec("UPDATE meta SET json='{}' WHERE key='charged'"); } finally { db.close(true); }
  }
  if (kind === 'browser') {
    const db = new Database(join(f.directory, 'browser.sqlite'), { readwrite: true, create: false });
    try { db.exec("UPDATE browser_state SET resource='foreign'"); } finally { db.close(true); }
  }
  if (kind === 'unknown') writeFileSync(join(f.directory, 'future.sqlite'), 'not a selected ledger', { mode: 0o600 });
  if (kind === 'permissions') chmodSync(path, 0o640);
  expect(() => openS16RuntimeMaintenance(config(f))).toThrow(); expect(f.modelPrompts).toHaveLength(0);
  if (kind === 'missing') expect(existsSync(path)).toBe(false);
});

test('a WAL-only future reader refuses without downgrading to the supported main-file header', async () => {
  const f = await fixture(), path = join(f.directory, 'vm.sqlite'); f.service.vmStore.enablePortableState();
  const reader = new Database(path, { readonly: true, create: false }); cleanup.push(() => reader.close(true));
  reader.exec('BEGIN'); reader.query('SELECT * FROM vm_registry').all();
  f.service.vmStore.db.exec('PRAGMA user_version=99'); await f.service.close();
  expect(readFileSync(path).readUInt32BE(60)).toBe(3);
  expect(() => openS16RuntimeMaintenance(config(f))).toThrow(expect.objectContaining({ code: 's16_ops_reader_unsupported' }));
  const db = new Database(join(f.directory, 'vm.sqlite'), { readonly: true, create: false }); cleanup.push(() => db.close(true)); expect(db.query('PRAGMA user_version').get()).toEqual({ user_version: 99 });
});

test.each(['path', 'manifest', 'extra'] as const)('changing the opened %s fences subsequent capture', async kind => {
  const f = await fixture(); await f.service.close(); const context = openS16RuntimeMaintenance(config(f)); cleanup.push(() => context.close());
  if (kind === 'path') { const path = join(f.directory, 'model.sqlite'), bytes = readFileSync(path); renameSync(path, path + '.saved'); writeFileSync(path, bytes, { mode: 0o600 }); }
  if (kind === 'manifest') { const path = join(f.directory, 'composition.json'); writeFileSync(path, readFileSync(path, 'utf8') + '\n'); }
  if (kind === 'extra') writeFileSync(join(f.directory, 'unexpected.sqlite'), 'new unlisted state', { mode: 0o600 });
  expect(() => context.assertCurrent()).toThrow(expect.objectContaining({ code: kind === 'path' ? 's16_ops_image_changed' : 's16_ops_inventory_changed' }));
});

test('absent state is never replaced with a fresh installation', async () => {
  const f = await fixture(); const directory = join(f.parent, 'absent-runtime');
  expect(() => openS16RuntimeMaintenance({ ...config(f), directory })).toThrow(); expect(existsSync(directory)).toBe(false);
  mkdirSync(directory, { mode: 0o700 }); expect(() => openS16RuntimeMaintenance({ ...config(f), directory })).toThrow();
  expect(existsSync(join(directory, 'composition.json'))).toBe(false);
});

test('runtime retirement closes every source while the actual CHAT lock excludes another process and service boot', async () => {
  const f = await fixture(); await f.service.close(); const context = openS16RuntimeMaintenance(config(f)); cleanup.push(() => context.close());
  const before = context.sources.map(source => source.database.serialize()); expect(() => context.assertExclusion()).toThrow(expect.objectContaining({ code: 's16_ops_sources_not_retired' }));
  context.retireSources(); context.retireSources(); context.assertExclusion(); expect(() => context.assertCurrent()).toThrow();
  for (const [index, source] of context.sources.entries()) {
    expect(() => source.database.query('SELECT 1').get()).toThrow();
    const reader = new Database(join(f.directory, source.name), { readonly: true, create: false }); try { expect(reader.serialize()).toEqual(before[index]!); } finally { reader.close(true); }
  }
  const lock = join(f.directory, 'conversation.sqlite.runtime-lock.sqlite');
  const child = Bun.spawnSync([process.execPath, '-e', `import {Database} from 'bun:sqlite';const db=new Database(${JSON.stringify(lock)},{readwrite:true,create:false});let blocked=false;try{db.exec('PRAGMA busy_timeout=10; BEGIN EXCLUSIVE');}catch{blocked=true;}finally{db.close(true);}console.log(JSON.stringify({blocked}));`], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
  expect({ exit: child.exitCode, error: child.stderr.toString(), result: JSON.parse(child.stdout.toString()) }).toEqual({ exit: 0, error: '', result: { blocked: true } });
  await expect(composeS15(f.options(false))).rejects.toThrow(); context.assertExclusion(); context.close(); await f.reopen(); expect(f.service.maintenanceSources(f.owner)).toHaveLength(17);
});

test('unknown runtime retirement retains its original lock and can finish only the same source disposal', async () => {
  const f = await fixture(); await f.service.close(); const context = openS16RuntimeMaintenance(config(f)); cleanup.push(() => context.close());
  const database = context.sources[0]!.database, close = database.close.bind(database); database.close = () => { throw Error('fixture_retirement_close_unknown'); };
  try { expect(() => context.retireSources()).toThrow(expect.objectContaining({ code: 's16_ops_source_release_unknown' })); expect(() => context.assertExclusion()).toThrow(); await expect(composeS15(f.options(false))).rejects.toThrow(); }
  finally { database.close = close; }
  context.retireSources(); context.assertExclusion(); context.close(); await f.reopen();
});
