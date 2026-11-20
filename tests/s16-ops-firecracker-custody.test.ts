import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { readS15RuntimeConfig } from '../src/s15/runtime-config';
import { DurableJournal } from '../src/s15/durable-journal';
import { FirecrackerVmManagement, type FirecrackerClientOptions } from '../src/s15/vm/firecracker/client';
import { createFirecrackerManagementRelay } from '../src/s15/vm/firecracker/rpc';
import { openS16ControlMaintenance } from '../src/s16/operations/control-maintenance';
import { openS16InstallationLease } from '../src/s16/operations/installation-lease';
import { captureS16LedgerSet } from '../src/s16/operations/ledger-set';
import { s16LedgerSetManifestHash, verifyS16LedgerSet } from '../src/s16/operations/verify-ledger-set';
import { firecrackerRuntimeFixture } from './fixtures/s15-firecracker-runtime';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (value: Uint8Array) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
async function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-helper-custody-'))); cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const directory = join(parent, 'state'), configPath = join(parent, 'config.json');
  writeFileSync(configPath, JSON.stringify(s15StageConfig(directory, 'http://localhost:3041')), { mode: 0o600 });
  const init = Bun.spawn([process.execPath, 'src/main.ts', 'init', '--s15', '--config', configPath], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exit, error] = await Promise.all([init.exited, new Response(init.stderr).text(), new Response(init.stdout).text()]); expect({ exit, error }).toEqual({ exit: 0, error: '' });
  const config = readS15RuntimeConfig(configPath), runtime = join(directory, 'runtime'), vmPath = join(runtime, 'vm.sqlite'), journals = join(runtime, 'vm-firecracker');
  function vm(action: (db: Database) => void) { const db = new Database(vmPath, { readwrite: true, create: false }); try { action(db); } finally { db.close(true); } }
  const open = () => { const ctx = openS16ControlMaintenance(config); cleanup.push(() => ctx.close()); return ctx; };
  function add(state: 'accepted' | 'dispatched' | 'unknown' | 'committed' | 'not_sent' | null = 'unknown', extra: Partial<FirecrackerClientOptions> = {}) {
    mkdirSync(journals, { recursive: true, mode: 0o700 }); const managerId = crypto.randomUUID(), path = join(journals, managerId + '.sqlite');
    const options: FirecrackerClientOptions = { path, create: true, installationId: config.installationId, origin: 'http://127.0.0.1:3142', computerId: 'jit-work-fixture', selectionSha256: 'a'.repeat(64), fixture: { basis: 'protocol_fixture' }, credential() { throw Error('maintenance_must_not_read_credentials'); }, ...extra };
    const client = new FirecrackerVmManagement(options); client.close();
    vm(db => { db.exec('CREATE TABLE IF NOT EXISTS vm_managers (id TEXT PRIMARY KEY,data TEXT NOT NULL)'); db.query('INSERT INTO vm_managers VALUES (?,?)').run(managerId, JSON.stringify({ kind: 'firecracker', origin: options.origin, computerId: options.computerId, selectionSha256: options.selectionSha256 })); });
    const command = { contract: 's16-firecracker-host-command/v1' as const, requestId: 'b'.repeat(32), computerId: options.computerId, selectionSha256: options.selectionSha256, expectedRevision: 1, expectedLaunchId: null, kind: 'launch' as const };
    if (state) {
      const journal = new DurableJournal(path, config.installationId, false, 0x4a46434a, { records: 256, bytes: 64 * 1048576 });
      journal.tx(() => {
        journal.put('active', { requestId: ['accepted', 'dispatched', 'unknown'].includes(state) ? command.requestId : null });
        journal.put(command.requestId, { contract: 's16-firecracker-client-intent/v1', command, state, receipt: state === 'committed' ? { command, revision: 2, state: 'committed', observation: { state: 'running', launchId: command.requestId, basis: 'protocol_fixture' } } : null });
      }); journal.close();
    }
    return { managerId, path, options, command, mutate(action: (db: Database) => void) { const db = new Database(path, { readwrite: true, create: false }); try { action(db); } finally { db.close(true); } } };
  }
  return { parent, directory, runtime, vmPath, journals, config, vm, add, open };
}

test('selected controller journals join the actual current control cohort without constructor recovery, credentials or copied process leases', async () => {
  const f = await fixture(), original = f.add(), before = readFileSync(original.path), ctx = f.open();
  expect(ctx.firecracker.controllers).toHaveLength(1); expect(ctx.firecracker.controllers[0]).toMatchObject({ managerId: original.managerId, computerId: original.options.computerId, pending: { requestId: original.command.requestId, state: 'unknown', kind: 'launch' } });
  const sources = ctx.sources, directory = join(f.parent, 'cohort'); mkdirSync(directory, { mode: 0o700 });
  expect(Object.isFrozen(sources)).toBe(true); expect(sources.length).toBe(ctx.outer.length + ctx.runtime.sources.length + 1);
  const options = { directory, id: 'c'.repeat(32), installationId: f.config.installationId, sources, guard: ctx.assertCurrent }, manifest = captureS16LedgerSet(options);
  expect(verifyS16LedgerSet({ ...options, readers: sources.map(({ name, reader }) => ({ name, reader })), manifestSha256: s16LedgerSetManifestHash(manifest) })).toEqual(manifest);
  expect(manifest.images.map(row => row.name)).toContain(ctx.firecracker.controllers[0]!.source); expect(readdirSync(join(directory, options.id)).some(name => name.includes('process-lock'))).toBe(false);
  expect(readFileSync(original.path)).toEqual(before); ctx.assertCurrent(); expect(Object.isFrozen(ctx.firecracker.controllers[0]!.pending)).toBe(true);
  expect(() => new FirecrackerVmManagement({ ...original.options, create: false })).toThrow(expect.objectContaining({ code: 'runtime_already_open' })); ctx.assertCurrent();
  const childOptions = { path: original.path, create: false, installationId: original.options.installationId, origin: original.options.origin, computerId: original.options.computerId, selectionSha256: original.options.selectionSha256, fixture: { basis: 'protocol_fixture' } };
  const child = Bun.spawnSync([process.execPath, '-e', `import {FirecrackerVmManagement} from './src/s15/vm/firecracker/client';let code='incorrectly_opened';try{const client=new FirecrackerVmManagement({...${JSON.stringify(childOptions)},credential(){throw Error('unexpected_credential');}});client.close();}catch(error){code=error.code;}console.log(JSON.stringify({code}));`], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
  expect({ exit: child.exitCode, error: child.stderr.toString() }).toEqual({ exit: 0, error: '' }); expect(JSON.parse(child.stdout.toString())).toEqual({ code: 'runtime_already_open' }); ctx.assertCurrent();
});

test('committed WAL controller continuity copies its logical owning rows while preserving source WAL custody', async () => {
  const f = await fixture(), original = f.add(), writer = new Database(original.path, { readwrite: true, create: false }); cleanup.push(() => writer.close(true));
  writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0'); writer.query("UPDATE records SET json=json_set(json,'$.command.expectedRevision',2) WHERE id=?").run(original.command.requestId);
  expect(existsSync(original.path + '-wal')).toBe(true); const ctx = f.open(), directory = join(f.parent, 'wal-cohort'); mkdirSync(directory, { mode: 0o700 });
  expect(ctx.firecracker.controllers[0]!.pending!.expectedRevision).toBe(2);
  const options = { directory, id: 'f'.repeat(32), installationId: f.config.installationId, sources: ctx.sources, guard: ctx.assertCurrent };
  const captured = captureS16LedgerSet(options); expect(verifyS16LedgerSet({ ...options, readers: options.sources.map(({ name, reader }) => ({ name, reader })), manifestSha256: s16LedgerSetManifestHash(captured) })).toEqual(captured);
  expect(existsSync(original.path + '-wal')).toBe(true); ctx.assertCurrent();
});

test('actual process death with a dirty uncommitted journal recovers committed pages without adapter state conversion', async () => {
  const f = await fixture(), original = f.add(), before = hash(readFileSync(original.path));
  const child = Bun.spawn([process.execPath, '-e', `import {DurableJournal} from './src/s15/durable-journal';const journal=new DurableJournal(${JSON.stringify(original.path)},${JSON.stringify(f.config.installationId)},false,0x4a46434a,{records:256,bytes:67108864});journal.db.exec('PRAGMA cache_size=1; PRAGMA cache_spill=1; BEGIN IMMEDIATE');const value=JSON.stringify({uncommitted:'x'.repeat(100000)});journal.db.query('UPDATE records SET json=? WHERE id=?').run(value,'${original.command.requestId}');for(let i=0;i<80;i++)journal.db.query('INSERT INTO records VALUES (?,?)').run('torn_'+i,value);process.kill(process.pid,'SIGKILL');`], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]); expect(error).toBe(''); expect(exit).not.toBe(0); expect(existsSync(original.path + '-journal')).toBe(true);
  expect(hash(readFileSync(original.path))).not.toBe(before);
  const ctx = f.open(); expect(ctx.firecracker.controllers[0]!.pending).toMatchObject({ requestId: original.command.requestId, state: 'unknown', expectedRevision: 1 }); expect(hash(readFileSync(original.path))).toBe(before); ctx.assertCurrent();
});

test.each(['accepted', 'dispatched', 'unknown', 'committed', 'not_sent'] as const)('raw maintenance preserves the actual original %s state instead of running adapter recovery', async state => {
  const f = await fixture(), original = f.add(state), before = hash(readFileSync(original.path)), ctx = f.open();
  const observed: string | null = ctx.firecracker.controllers[0]!.pending?.state ?? null;
  expect(observed).toBe(['accepted', 'dispatched', 'unknown'].includes(state) ? state : null);
  expect(hash(readFileSync(original.path))).toBe(before); ctx.close(); expect(hash(readFileSync(original.path))).toBe(before);
});

test('an explicitly absent auxiliary namespace remains absent while an original empty directory stays guarded', async () => {
  const f = await fixture(); let ctx = f.open(); expect(ctx.firecracker.sources).toEqual([]); expect(existsSync(f.journals)).toBe(false); ctx.close();
  mkdirSync(f.journals, { mode: 0o700 }); ctx = f.open(); expect(ctx.firecracker.controllers).toEqual([]); writeFileSync(join(f.journals, 'unknown'), '', { mode: 0o600 }); expect(() => ctx.assertCurrent()).toThrow();
});

test.each(['missing', 'lock-missing', 'future', 'foreign', 'binding', 'active', 'receipt', 'extra-row', 'oversized', 'mode', 'untracked', 'unowned'] as const)('invalid auxiliary %s refuses without initialization, replay or loss of parent exclusion', async kind => {
  const f = await fixture(), original = f.add();
  if (kind === 'missing') unlinkSync(original.path);
  if (kind === 'lock-missing') unlinkSync(original.path + '.process-lock');
  if (kind === 'future') original.mutate(db => db.exec('PRAGMA user_version=99'));
  if (kind === 'foreign') original.mutate(db => db.exec("UPDATE identity SET installation='foreign'"));
  if (kind === 'binding') original.mutate(db => db.exec("UPDATE records SET json=json_set(json,'$.selectionSha256','foreign') WHERE id='binding'"));
  if (kind === 'active') original.mutate(db => db.exec("UPDATE records SET json='{\"requestId\":null}' WHERE id='active'"));
  if (kind === 'receipt') original.mutate(db => db.query('UPDATE records SET json=json_set(json,\'$.state\',\'committed\') WHERE id=?').run(original.command.requestId));
  if (kind === 'extra-row') original.mutate(db => db.query('INSERT INTO records VALUES (?,?)').run('unrecognized', '{}'));
  if (kind === 'oversized') original.mutate(db => db.query('UPDATE records SET json=? WHERE id=?').run(JSON.stringify({ invalid: 'x'.repeat(131072) }), original.command.requestId));
  if (kind === 'mode') chmodSync(original.path, 0o644);
  if (kind === 'untracked') writeFileSync(join(f.journals, 'unknown.sqlite'), '', { mode: 0o600 });
  if (kind === 'unowned') f.vm(db => db.exec('DELETE FROM vm_managers'));
  await expect(Promise.resolve().then(() => f.open())).rejects.toThrow();
  if (kind === 'missing') expect(existsSync(original.path)).toBe(false); if (kind === 'lock-missing') expect(existsSync(original.path + '.process-lock')).toBe(false);
  const lease = openS16InstallationLease({ directory: f.directory, mode: 'shared' }); lease.close();
});

test('a live actual controller process lease excludes raw maintenance before its journal/header is opened', async () => {
  const f = await fixture(), original = f.add(), client = new FirecrackerVmManagement({ ...original.options, create: false }); cleanup.push(() => client.close());
  expect(readdirSync(f.journals)).toContain(original.managerId + '.sqlite.process-lock-journal');
  expect(() => f.open()).toThrow(expect.objectContaining({ code: 'runtime_already_open' })); expect(client.pending()).toBe(true); client.close(); const ctx = f.open(); ctx.assertCurrent();
});

test('unknown auxiliary close retains original handles and installation/CHAT exclusion until the original disposal succeeds', async () => {
  const f = await fixture(), original = f.add(), ctx = f.open(), db = ctx.firecracker.sources[0]!.database, close = db.close.bind(db); db.close = () => { throw Error('fixture_close_unknown'); };
  try {
    expect(() => ctx.close()).toThrow(expect.objectContaining({ code: 's16_ops_source_release_unknown' })); expect(() => openS16InstallationLease({ directory: f.directory, mode: 'shared' })).toThrow();
    expect(() => new FirecrackerVmManagement({ ...original.options, create: false })).toThrow(expect.objectContaining({ code: 'runtime_already_open' })); expect(ctx.outer[0]!.database.query('SELECT 1').get()).toBeDefined();
  } finally { db.close = close; }
  ctx.close(); const client = new FirecrackerVmManagement({ ...original.options, create: false }); client.close();
});

test('ordinary controller close fences admission but can retry the original unknown journal disposal', async () => {
  const f = await fixture(), original = f.add(), client = new FirecrackerVmManagement({ ...original.options, create: false }); cleanup.push(() => client.close());
  const close = Database.prototype.close; let armed = true;
  Database.prototype.close = function(this: Database, ...args: Parameters<Database['close']>) {
    let path = ''; try { path = this.query<{ file: string }, []>('PRAGMA database_list').get()?.file ?? ''; } catch { /* Already conclusively closed. */ }
    if (path === original.path && armed) { armed = false; throw Error('fixture_client_close_unknown'); } return close.apply(this, args);
  };
  try {
    expect(() => client.close()).toThrow(expect.objectContaining({ code: 'runtime_release_unknown' })); expect(() => client.pending()).toThrow();
    expect(() => f.open()).toThrow(expect.objectContaining({ code: 'runtime_already_open' })); client.close(); const ctx = f.open(); ctx.assertCurrent();
  } finally { Database.prototype.close = close; client.close(); }
});

test('actual owning RPC response loss stays original/unknown through cohort capture, then normal readback recovers without another launch', async () => {
  const host = await firecrackerRuntimeFixture(); cleanup.push(() => host.close()); const credential = 'fixture_controller_only_' + 'd'.repeat(32), f = await fixture();
  const relay = createFirecrackerManagementRelay(host.runtime(), { credential, installationId: f.config.installationId, port: 0 }); cleanup.push(() => relay.close());
  const operations: string[] = []; let lost = false;
  const transport = (async (input, init) => { const operation = JSON.parse(String(init?.body)).operation; operations.push(operation); const response = await fetch(input, init); if (!lost && operation === 'submit') { lost = true; throw Error('fixture_response_loss'); } return response; }) as typeof fetch;
  const original = f.add(null, { origin: relay.origin, computerId: host.runtime().computerId, selectionSha256: host.runtime().selectionSha256, credential: () => credential, fetch: transport });
  let client = new FirecrackerVmManagement({ ...original.options, create: false }); cleanup.push(() => client.close()); await expect(client.start()).rejects.toMatchObject({ code: 'vm_reconciliation_required' }); expect(host.starts()).toBe(1); client.close();
  const calls = [...operations], before = hash(readFileSync(original.path)), ctx = f.open(); expect(ctx.firecracker.controllers[0]!.pending?.state).toBe('unknown');
  const directory = join(f.parent, 'actual-cohort'); mkdirSync(directory, { mode: 0o700 }); captureS16LedgerSet({ directory, id: 'e'.repeat(32), installationId: f.config.installationId, sources: ctx.sources, guard: ctx.assertCurrent }); ctx.close();
  expect(operations).toEqual(calls); expect(hash(readFileSync(original.path))).toBe(before); expect(host.starts()).toBe(1);
  client = new FirecrackerVmManagement({ ...original.options, create: false }); expect((await client.inspect()).state).toBe('running'); expect(client.pending()).toBe(false); expect(host.starts()).toBe(1); expect(operations.filter(value => value === 'submit')).toHaveLength(1);
});
