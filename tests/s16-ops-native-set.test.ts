import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createHost } from 'schway/host';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { readS15RuntimeConfig } from '../src/s15/runtime-config';
import { adoptS16Operations } from '../src/s16/operations/adoption';
import { openS16ControlMaintenance } from '../src/s16/operations/control-maintenance';
import { openS16InstallationLease } from '../src/s16/operations/installation-lease';
import { readS16OperationsFence } from '../src/s16/operations/operations-state';
import type { S16NativeSetOptions } from '../src/s16/operations/native-set';
import { composedFixture } from './fixtures/s15-composition';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const digest = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
const requestId = 'native_original', settings = { attempt: 'first', maxBytes: 4_294_967_296 };
async function fixture(work = true) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-native-set-'))); cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const directory = join(parent, 'state'), configPath = join(parent, 'config.json'), runtimeDirectory = join(directory, 'runtime');
  const configured = { ...s15StageConfig(directory, 'http://localhost:3041'), installationId: 'fixture' };
  writeFileSync(configPath, JSON.stringify(configured), { mode: 0o600 });
  const child = Bun.spawn([process.execPath, 'src/main.ts', 'init', '--s15', '--config', configPath], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]); expect({ exit, error }).toEqual({ exit: 0, error: '' });
  // Disposable fixture setup: replace the unused empty runtime before adoption with real composed
  // owning work at its final absolute paths. This is not a production recovery/activation protocol.
  rmSync(runtimeDirectory, { recursive: true });
  const composed = await composedFixture('default', false, undefined, options => { const { browser: _browser, ...rest } = options; return { ...rest, directory: runtimeDirectory }; }); cleanup.push(() => composed.close());
  if (work) expect((await composed.chat('Run the requested command in the working computer')).state).toBe('completed'); await composed.service.close();
  const config = readS15RuntimeConfig(configPath); adoptS16Operations(config, 'adopt_original', { now: () => 10, id: () => 'a'.repeat(32) });
  const open = () => {
    const fence = join(directory, 'owner/owner.sqlite.ops/fence.json');
    const ctx = openS16ControlMaintenance(config, existsSync(fence) ? { operationFence: readS16OperationsFence(directory) } : {}); cleanup.push(() => ctx.close()); return ctx;
  };
  const start = (kind: 'backup' | 'export' = 'backup') => {
    const ctx = open(), journal = ctx.operations({ id: () => 'b'.repeat(32), now: () => 20 }); journal.begin({ requestId, kind, hash: 'c'.repeat(64) }, journal.read().revision); journal.advance(requestId, journal.read().revision, 'capturing');
    return { ctx, journal, session(options: S16NativeSetOptions = settings) { const session = ctx.nativeSet(requestId, options); cleanup.push(() => session.close()); return session; } };
  };
  return { parent, directory, runtimeDirectory, config, open, start };
}

test('actual composed owning roots publish one protected native set/action with deep verification and original receipt readback', async () => {
  const f = await fixture(), { ctx, journal, session: open } = f.start(), expected = ctx.nativeNamespace().roots;
  expect(expected.some(root => root.kind === 'model')).toBe(true); const session = open(), result = await session.capture();
  expect(result.roots).toBe(expected.length); expect(result.pending).toBe(0);
  const manifestBytes = readFileSync(join(result.directory, 'manifest.json')), manifest = JSON.parse(manifestBytes.toString()), plan = JSON.parse(readFileSync(join(result.directory, 'plan.json'), 'utf8'));
  expect(result.manifestSha256).toBe(digest(manifestBytes)); expect(manifest.operationId).toBe('b'.repeat(32)); expect(plan.capturedAt).toBe(20); expect(plan.roots).toHaveLength(expected.length);
  for (const file of manifest.roots) { const bytes = readFileSync(join(result.directory, file.name)); expect(digest(bytes)).toBe(file.sha256); expect(JSON.parse(bytes.toString()).contract).toBe('s16-native-root/v2'); }
  expect(readdirSync(join(dirname(result.directory), 'quarantine'))).toEqual([]);
  expect(journal.read().requests[0]).toMatchObject({ id: 'b'.repeat(32), createdAt: 20, phase: 'capturing', status: 'running', cohortSha256: null, targetSha256: null, actions: [{ id: result.actionId, state: 'confirmed', kind: 'capture_native', observedSha256: result.manifestSha256 }] });
  expect(await session.capture()).toEqual(result); await session.close(); ctx.close();
  const next = f.open(), retry = next.nativeSet(requestId, settings); cleanup.push(() => retry.close()); expect(await retry.capture()).toEqual(result);
  expect(next.operations().read().requests[0]!.actions).toHaveLength(1); await retry.close(); next.close();
});

test('explicitly empty native custody publishes an empty component without creating native runtime directories', async () => {
  const f = await fixture(false), { session: open } = f.start(), result = await open().capture(); expect(result.roots).toBe(0);
  for (const path of ['native-chat', 'native-model']) expect(existsSync(join(f.runtimeDirectory, path))).toBe(false); expect(existsSync(join(f.directory, 'native-github'))).toBe(false);
});

test.each(['manifest', 'receipt', 'observed'] as const)('lost response after %s resumes the same operation/action without creating native identities or resetting capture time', async boundary => {
  const f = await fixture(), state = f.start(); let armed = true;
  const first = state.session({ ...settings, after(at) { if (armed && at === boundary) { armed = false; throw Error('fixture-response-loss'); } } });
  await expect(first.capture()).rejects.toThrow('fixture-response-loss'); const original = state.journal.read().requests[0]!; expect(original.id).toBe('b'.repeat(32)); expect(original.actions).toHaveLength(1);
  await first.close(); state.ctx.close(); const ctx = f.open(), retry = ctx.nativeSet(requestId, settings); cleanup.push(() => retry.close());
  const result = await retry.capture(); expect(result.actionId).toBe(original.actions[0]!.id);
  const row = ctx.operations().read().requests[0]!; expect(row.actions[0]).toMatchObject({ state: 'confirmed', observedSha256: result.manifestSha256 }); expect(row.createdAt).toBe(20); expect(row.cohortSha256).toBeNull();
  expect(row.actions).toHaveLength(1); await retry.close(); ctx.close();
});

test.each(['intent', 'root', 'manifest', 'receipt'] as const)('actual process death after %s releases OS leases and resumes only the original capture action', async boundary => {
  const f = await fixture(), state = f.start(); state.ctx.close();
  const code = `import {readS15RuntimeConfig} from './src/s15/runtime-config';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance';import {readS16OperationsFence} from './src/s16/operations/operations-state';
const config=readS15RuntimeConfig(${JSON.stringify(join(f.parent, 'config.json'))});const ctx=openS16ControlMaintenance(config,{operationFence:readS16OperationsFence(config.directory)});const session=ctx.nativeSet('${requestId}',{attempt:'first',maxBytes:${settings.maxBytes},after(at){if(at===${JSON.stringify(boundary)})process.kill(process.pid,'SIGKILL');}});await session.capture();throw Error('fixture_did_not_interrupt');`;
  const child = Bun.spawn([process.execPath, '-e', code], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' }), timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try { const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]); expect(error).toBe(''); expect(exit).not.toBe(0); } finally { clearTimeout(timer); }
  const ctx = f.open(), journal = ctx.operations(), before = journal.read().requests[0]!; expect(before.actions[0]!.state).toBe('intent');
  const session = ctx.nativeSet(requestId, settings); cleanup.push(() => session.close()); const result = await session.capture();
  expect(result.actionId).toBe(before.actions[0]!.id); expect(journal.read().requests[0]).toMatchObject({ id: before.id, createdAt: before.createdAt, actions: [{ state: 'confirmed', id: result.actionId }] });
  expect(journal.read().requests[0]!.actions).toHaveLength(1);
});

test.each(['intent', 'plan', 'root'] as const)('known refusal after %s settles only absent set publication and requires an explicit distinct capture attempt', async boundary => {
  const f = await fixture(), state = f.start(); let armed = true;
  const first = state.session({ ...settings, after(at) { if (armed && at === boundary) { armed = false; throw Error('fixture-known-refusal'); } } });
  await expect(first.capture()).rejects.toThrow('fixture-known-refusal'); const row = state.journal.read().requests[0]!;
  expect(row).toMatchObject({ status: 'blocked', actions: [{ kind: 'capture_native', state: 'not_applied', observedSha256: null }] });
  await expect(first.capture()).rejects.toThrow(); await first.close(); state.journal.resume(requestId, state.journal.read().revision);
  const second = state.session({ ...settings, attempt: 'second' }), result = await second.capture(); expect(result.actionId).not.toBe(row.actions[0]!.id); expect(state.journal.read().requests[0]!.actions).toHaveLength(2);
});

test('ordinary export and unadopted/pending phases cannot acquire native backup custody', async () => {
  const f = await fixture(false), state = f.start('export'); expect(() => state.ctx.nativeSet(requestId, settings)).toThrow(expect.objectContaining({ code: 's16_ops_phase_invalid' })); expect(existsSync(join(f.directory, 'operations/native-staging'))).toBe(false);
});

test('the current context retains both exclusions while a native session is owned or its exact async operation is outstanding', async () => {
  const f = await fixture(), state = f.start(), session = state.session(); expect(() => state.ctx.nativeSet(requestId, { ...settings, attempt: 'other' })).toThrow(expect.objectContaining({ code: 's16_ops_native_busy' }));
  const pending = session.capture(); await expect(session.capture()).rejects.toThrow(expect.objectContaining({ code: 's16_ops_native_busy' }));
  expect(() => state.ctx.close()).toThrow(expect.objectContaining({ code: 's16_ops_source_release_unknown' })); expect(() => openS16InstallationLease({ directory: f.directory, mode: 'shared' })).toThrow();
  await expect(session.close()).rejects.toThrow(expect.objectContaining({ code: 's16_ops_native_busy' })); await expect(pending).rejects.toThrow();
  await session.close(); state.ctx.close(); const ctx = f.open(); ctx.close();
});

test('an unknown close during the native opener keeps its original handle and both exclusions until actual disposal can be retried', async () => {
  const f = await fixture(), state = f.start(); state.ctx.close();
  // Isolated module seam over a real public host: fail only disposal after the final opener guard.
  const code = `import {mock} from 'bun:test';import {chmodSync} from 'node:fs';const real=await import('schway/host'),create=real.createHost;let armed=true,allowClose=false,changed;mock.module('schway/host',()=>({...real,async createHost(options){const host=await create(options);if(armed){armed=false;changed=options.sessionDirectory;chmodSync(changed,0o755);return {...host,async close(){if(!allowClose)throw Error('fixture_close_unknown');await host.close();}};}return host;}}));
const {readS15RuntimeConfig}=await import('./src/s15/runtime-config');const {openS16ControlMaintenance}=await import('./src/s16/operations/control-maintenance');const {readS16OperationsFence}=await import('./src/s16/operations/operations-state');const {openS16InstallationLease}=await import('./src/s16/operations/installation-lease');
const config=readS15RuntimeConfig(${JSON.stringify(join(f.parent, 'config.json'))}),ctx=openS16ControlMaintenance(config,{operationFence:readS16OperationsFence(config.directory)}),session=ctx.nativeSet('${requestId}',{attempt:'first',maxBytes:${settings.maxBytes}});let captureCode,closeCode,leaseCode;try{await session.capture();}catch(error){captureCode=error.code;}try{ctx.close();}catch(error){closeCode=error.code;}try{openS16InstallationLease({directory:config.directory,mode:'shared'});}catch(error){leaseCode=error.code;}if(captureCode!=='s16_ops_source_release_unknown'||closeCode!=='s16_ops_source_release_unknown'||!leaseCode||session.released)throw Error('fixture_exclusion_released');let stillHeld=false;try{await session.close();}catch(error){stillHeld=error.code==='s16_ops_source_release_unknown';}if(!stillHeld||session.released)throw Error('fixture_original_disposal_lost');chmodSync(changed,0o700);allowClose=true;await session.close();ctx.close();const retry=openS16ControlMaintenance(config,{operationFence:readS16OperationsFence(config.directory)});retry.close();console.log(JSON.stringify({originalDisposal:'retried',exclusions:'retained_until_disposal'}));`;
  const child = Bun.spawn([process.execPath, '-e', code], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }), timer = setTimeout(() => child.kill('SIGKILL'), 20_000);
  try { const [exit, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); expect({ exit, error }).toEqual({ exit: 0, error: '' }); expect(JSON.parse(out)).toEqual({ originalDisposal: 'retried', exclusions: 'retained_until_disposal' }); } finally { clearTimeout(timer); }
});

test.each(['body', 'manifest', 'plan', 'receipt', 'extra'] as const)('published native set refuses corrupted %s while preserving original action/authority', async kind => {
  const f = await fixture(), state = f.start(), session = state.session(), result = await session.capture();
  const manifest = JSON.parse(readFileSync(join(result.directory, 'manifest.json'), 'utf8'));
  const path = kind === 'body' ? join(result.directory, manifest.roots[0].name) : kind === 'receipt' ? join(dirname(result.directory), 'receipt.json') : join(result.directory, kind === 'extra' ? 'unknown.json' : kind + '.json');
  writeFileSync(path, '{}', { mode: 0o600 }); await expect(session.capture()).rejects.toThrow(); expect(state.journal.read().requests[0]!.actions).toHaveLength(1);
  expect(state.journal.read().requests[0]!.actions[0]).toMatchObject({ state: 'confirmed', observedSha256: result.manifestSha256 });
});

test('unreceipted publication cannot adopt changed native bytes or missing current continuity as archive authority', async () => {
  const f = await fixture(), state = f.start(); let armed = true;
  const session = state.session({ ...settings, after(at) { if (armed && at === 'manifest') { armed = false; throw Error('fixture-publication-loss'); } } });
  await expect(session.capture()).rejects.toThrow(); const root = state.ctx.nativeNamespace().roots[0]!;
  const host = await createHost({ workspaceRoot: join(root.directory, 'workspace'), homeDirectory: join(root.directory, 'home'), sessionDirectory: join(root.directory, 'sessions'), context: { policy: 'strict', systemPrompt: 'Current changed custody fixture.', sections: [] }, tools: { policy: 'exact', definitions: [], hostedLookup: 'off' }, limits: { maxTurns: 1, maxConcurrentTools: 1, contextWindow: 32768, maxInputChars: 1024 } });
  const added = await host.createSession(); await added.close(); await host.close(); await expect(session.capture()).rejects.toThrow(expect.objectContaining({ code: 's16_ops_native_changed' }));
  expect(state.journal.read().requests[0]).toMatchObject({ status: 'unknown', actions: [{ state: 'unknown' }] });
});

test('per-set byte bound fails before publication and leaves original saved native identities unchanged', async () => {
  const f = await fixture(), state = f.start(), before = state.ctx.nativeNamespace().roots, session = state.session({ ...settings, maxBytes: 1 });
  await expect(session.capture()).rejects.toThrow(expect.objectContaining({ code: 's16_ops_capture_bounds' })); expect(state.ctx.nativeNamespace().roots).toEqual(before);
  expect(state.journal.read().requests[0]).toMatchObject({ status: 'blocked', actions: [{ state: 'not_applied' }] });
});

test('more than 256 actual known native roots remain one action/component with an independently bounded manifest', async () => {
  const f = await fixture(false), database = new Database(join(f.runtimeDirectory, 'model.sqlite'), { readwrite: true, create: false });
  // Protocol fixture over the real owning schema, not 300 completed application jobs.
  for (let index = 0; index < 300; index++) {
    const id = 'retained_selection_' + String(index).padStart(4, '0'), root = join(f.runtimeDirectory, 'native-model', id);
    database.query('INSERT INTO records (id,json) VALUES (?,?)').run(id, JSON.stringify({ contract: 's15-model-selection/v1', id, state: 'reconcile_only', session: null }));
    mkdirSync(root, { recursive: true, mode: 0o700 }); for (const name of ['workspace', 'home', 'sessions']) mkdirSync(join(root, name), { mode: 0o700 });
  } database.close(true);
  const state = f.start(), result = await state.session().capture(); expect(result).toMatchObject({ roots: 300, pending: 300 }); expect(state.journal.read().requests[0]!.actions).toHaveLength(1);
  expect(JSON.parse(readFileSync(join(result.directory, 'manifest.json'), 'utf8')).roots).toHaveLength(300);
});

test('a shape-valid nonexistent saved branch refuses deep native-set publication without clearing its original fence', async () => {
  const f = await fixture(), database = new Database(join(f.runtimeDirectory, 'model.sqlite'), { readwrite: true, create: false });
  database.exec("UPDATE records SET json=json_set(json,'$.session.branchId','nonexistent_saved_branch')"); database.close(true);
  const state = f.start(), session = state.session(); await expect(session.capture()).rejects.toThrow(expect.objectContaining({ code: 's16_ops_native_quarantined' }));
  expect(state.journal.read().requests[0]).toMatchObject({ status: 'blocked', actions: [{ state: 'not_applied' }] }); expect(existsSync(join(f.directory, 'owner/owner.sqlite.ops/fence.json'))).toBe(true);
});

test('existing native staging consumes its bounded quota before a new snapshot and is never removed to make room', async () => {
  const f = await fixture(false), staging = join(f.directory, 'operations/native-staging'); mkdirSync(staging, { mode: 0o700 });
  const partial = join(staging, 'retained-partial'); writeFileSync(partial, '', { mode: 0o600 }); truncateSync(partial, 8_589_934_593);
  const state = f.start(); await expect(state.session().capture()).rejects.toThrow(expect.objectContaining({ code: 's16_ops_capture_bounds' })); expect(statSync(partial).size).toBe(8_589_934_593);
  expect(state.journal.read().requests[0]).toMatchObject({ status: 'blocked', actions: [{ state: 'not_applied' }] });
});

test('reconciliation refuses an aliased quarantine child before cleanup and never deletes the current native source', async () => {
  const f = await fixture(), state = f.start(); let stage = '', armed = true;
  const session = state.session({ ...settings, after(at) { if (armed && at === 'manifest') { armed = false; const action = state.journal.read().requests[0]!.actions[0]!.id; stage = join(f.directory, 'operations/native-staging', 'b'.repeat(32), action); throw Error('fixture-reconcile'); } } });
  await expect(session.capture()).rejects.toThrow(); const root = state.ctx.nativeNamespace().roots[0]!; symlinkSync(root.directory, join(stage, 'quarantine', root.id));
  await expect(session.capture()).rejects.toThrow(expect.objectContaining({ code: 's14_ops_path_untrusted' })); expect(existsSync(join(root.directory, 'sessions'))).toBe(true); expect(state.journal.read().requests[0]!.status).toBe('unknown');
});

test.each([false, true])('empty GitHub native discovery retains an unconfirmed attempt but cannot satisfy successful owning evidence (%s)', async required => {
  const f = await fixture(false), attempt = 'github_' + 'e'.repeat(32), root = join(f.directory, 'native-github', attempt);
  // Protocol fixture, including an explicitly empty public inventory; no VM task is run.
  const vm = new Database(join(f.runtimeDirectory, 'vm.sqlite'), { readwrite: true, create: false }); vm.query('INSERT INTO vm_sessions VALUES (?,?,?,?,?,?,?,?)').run('vm_original', 'vm', 'work_original', attempt, 'work', required ? 'closed' : 'unknown', 'fixture_unit', 3); vm.close(true);
  if (required) { const github = new Database(join(f.runtimeDirectory, 'github.sqlite'), { readwrite: true, create: false }); github.query('INSERT INTO records VALUES (?,?,?)').run('selection', 'selection_original', JSON.stringify({ id: 'selection_original', workId: 'work_original', state: 'reviewable', evidence: { source: { ref: 'vm:' + attempt } } })); github.close(true); }
  mkdirSync(root, { recursive: true, mode: 0o700 }); for (const name of ['workspace', 'home', 'sessions']) mkdirSync(join(root, name), { mode: 0o700 });
  const state = f.start(), cap = state.session();
  if (required) await expect(cap.capture()).rejects.toThrow(expect.objectContaining({ code: 's16_ops_native_reconciliation_required' }));
  else expect(await cap.capture()).toMatchObject({ roots: 1, pending: 2 });
});

test('GitHub protocol fixture keeps original unknown VM/work custody and complete uncorrelated native bytes in its protected set', async () => {
  const f = await fixture(false), attempt = 'github_' + 'd'.repeat(32), root = join(f.directory, 'native-github', attempt);
  const db = new Database(join(f.runtimeDirectory, 'vm.sqlite'), { readwrite: true, create: false });
  db.query('INSERT INTO vm_sessions VALUES (?,?,?,?,?,?,?,?)').run('vm_original', 'vm', 'work_original', attempt, 'work', 'unknown', 'fixture_unit', 3); db.close(true);
  mkdirSync(root, { recursive: true, mode: 0o700 }); for (const name of ['workspace', 'home', 'sessions']) mkdirSync(join(root, name), { mode: 0o700 });
  const host = await createHost({ workspaceRoot: join(root, 'workspace'), homeDirectory: join(root, 'home'), sessionDirectory: join(root, 'sessions'), context: { policy: 'strict', systemPrompt: 'Uncertain original GitHub fixture.', sections: [] }, tools: { policy: 'exact', definitions: [], hostedLookup: 'off' }, limits: { maxTurns: 1, maxConcurrentTools: 1, contextWindow: 32768, maxInputChars: 1024 } });
  const original = await host.createSession(), ref = { ...original.reference }; await original.retire(); await original.close(); await host.close();
  const vmBytes = readFileSync(join(f.runtimeDirectory, 'vm.sqlite')), state = f.start(), result = await state.session().capture();
  expect(result).toMatchObject({ roots: 1, pending: 2 }); const manifest = JSON.parse(readFileSync(join(result.directory, 'manifest.json'), 'utf8')), value = JSON.parse(readFileSync(join(result.directory, manifest.roots[0].name), 'utf8'));
  expect(value).toMatchObject({ referenceKind: 'current_custody', savedReferences: [], references: [ref], custody: { kind: 'github', ownerId: attempt, vm: { sessionId: 'vm_original', workId: 'work_original', state: 'unknown', generation: 3 } } });
  expect(readFileSync(join(f.runtimeDirectory, 'vm.sqlite'))).toEqual(vmBytes); expect(state.journal.read().requests[0]!.phase).toBe('capturing');
});
