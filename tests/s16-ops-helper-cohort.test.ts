import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { ConnectionVault } from '../src/exec/connections';
import { DurableJournal } from '../src/s15/durable-journal';
import { readS15RuntimeConfig } from '../src/s15/runtime-config';
import { FirecrackerVmManagement } from '../src/s15/vm/firecracker/client';
import { createFirecrackerManagementRelay } from '../src/s15/vm/firecracker/rpc';
import { openS16ControlMaintenance } from '../src/s16/operations/control-maintenance';
import { openS16InstallationLease } from '../src/s16/operations/installation-lease';
import { firecrackerRuntimeFixture } from './fixtures/s15-firecracker-runtime';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const sha = (bytes: Uint8Array) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
async function fixture(mode: 'empty' | 'idle' | 'unknown' | 'absent' = 'unknown') {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-helper-cohort-'))); cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const directory = join(parent, 'state'), configPath = join(parent, 'config.json'); writeFileSync(configPath, JSON.stringify(s15StageConfig(directory, 'http://localhost:3041')), { mode: 0o600 });
  const init = Bun.spawn([process.execPath, 'src/main.ts', 'init', '--s15', '--config', configPath], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exit, error] = await Promise.all([init.exited, new Response(init.stderr).text(), new Response(init.stdout).text()]); expect({ exit, error }).toEqual({ exit: 0, error: '' });
  const config = readS15RuntimeConfig(configPath), host = await firecrackerRuntimeFixture(); cleanup.push(() => host.close());
  const credential = 'fixture_helper_only_' + 'q'.repeat(40), relay = createFirecrackerManagementRelay(host.runtime(), { credential, installationId: config.installationId, port: 0 }); cleanup.push(() => relay.close());
  const managerId = crypto.randomUUID(), journals = join(directory, 'runtime/vm-firecracker'), path = join(journals, managerId + '.sqlite'), operations: string[] = [];
  const transport = (async (input, init) => { operations.push(JSON.parse(String(init?.body)).operation); return fetch(input, init); }) as typeof fetch;
  if (mode !== 'empty') {
    mkdirSync(journals, { mode: 0o700 }); const binding = { kind: 'firecracker', origin: relay.origin, computerId: host.runtime().computerId, selectionSha256: host.runtime().selectionSha256 };
    const vm = new Database(join(directory, 'runtime/vm.sqlite'), { readwrite: true, create: false }); vm.query('INSERT INTO vm_managers VALUES (?,?)').run(managerId, JSON.stringify(binding)); vm.close(true);
    const vault = new ConnectionVault(join(directory, 'vault'), { forbidden: [join(directory, 'runtime')] }); vault.write(managerId, credential);
    let lost = false;
    const client = new FirecrackerVmManagement({ path, create: true, installationId: config.installationId, ...binding, fixture: { basis: 'protocol_fixture' }, credential: () => credential,
      fetch: (async (input, init) => { const response = await transport(input, init); if (mode === 'unknown' && !lost && JSON.parse(String(init?.body)).operation === 'submit') { lost = true; throw Error('fixture_lost_reply'); } return response; }) as typeof fetch });
    try { if (mode === 'unknown') await expect(client.start()).rejects.toMatchObject({ code: 'vm_reconciliation_required' }); } finally { client.close(); }
    if (mode === 'absent') {
      const j = new DurableJournal(path, config.installationId, false, 0x4a46434a), command = host.mutation(15, 'launch');
      j.tx(() => { j.put('active', { requestId: command.requestId }); j.put(command.requestId, { contract: 's16-firecracker-client-intent/v1', command, state: 'dispatched', receipt: null }); }); j.close();
    }
  }
  operations.splice(0);
  const context = openS16ControlMaintenance(config); cleanup.push(() => context.close());
  const options = { fixture: { basis: 'protocol_fixture' as const, fetch: transport, timeoutMs: 1000 } };
  return { directory, config, host, context, options, operations, path, managerId, credential, transport };
}
const changes = (f: Awaited<ReturnType<typeof fixture>>) => f.host.journal().db.query<{ n: number }, []>('SELECT total_changes() n').get()!.n;

test('actual selected control capability reads authenticated current helper custody while preserving original controller uncertainty', async () => {
  const f = await fixture(), before = sha(readFileSync(f.path)), n = changes(f), commands = [...f.host.commands], observation = await f.context.helperCustody(f.options);
  expect(observation.value.helpers).toHaveLength(1); expect(observation.value.helpers[0]!.view.requested!.receipt!.state).toBe('committed'); expect(f.context.firecracker.controllers[0]!.pending!.state).toBe('unknown');
  await observation.assertCurrent(); expect(f.operations).toEqual(['custody', 'custody']); expect(sha(readFileSync(f.path))).toBe(before); expect(changes(f)).toBe(n); expect(f.host.commands).toEqual(commands); expect(f.host.starts()).toBe(1);
  const encoded = JSON.stringify(observation.value); expect(encoded).not.toContain(f.credential); expect(encoded).not.toContain(f.host.root); expect(encoded).not.toContain('invocationId'); expect(Object.isFrozen(observation.value.helpers[0]!.view)).toBe(true);
  await f.host.runtime().submit(f.host.mutation(50, 'stop')); await expect(observation.assertCurrent()).rejects.toMatchObject({ code: 's16_ops_helper_changed' });
  const fresh = await f.context.helperCustody(f.options); expect(fresh.sha256).not.toBe(observation.sha256); expect(sha(readFileSync(f.path))).toBe(before);
});

test('unverified and absent original helper state stays explicit without an inspect, reconcile or submit fallback', async () => {
  const f = await fixture('absent'), before = sha(readFileSync(f.path)), n = changes(f), observation = await f.context.helperCustody(f.options);
  expect(observation.value.helpers[0]!.view.computer.state).toBe('unverified'); expect(observation.value.helpers[0]!.view.requested!.receipt).toBeNull(); expect(f.context.firecracker.controllers[0]!.pending!.state).toBe('dispatched');
  expect(f.operations).toEqual(['custody']); expect(changes(f)).toBe(n); expect(f.host.commands).toEqual([]); expect(sha(readFileSync(f.path))).toBe(before);
  await f.host.runtime().inspect(); await f.host.runtime().submit(f.host.mutation(51, 'launch'));
  const advanced = await f.context.helperCustody(f.options); expect(advanced.value.helpers[0]!.view.requested!.receipt).toBeNull(); expect(f.context.firecracker.controllers[0]!.pending!.state).toBe('dispatched');
});

test('an empty helper cohort never initializes missing vault state or makes a network request', async () => {
  const f = await fixture('empty'), vault = join(f.directory, 'vault'); rmSync(vault, { recursive: true, force: true });
  const observation = await f.context.helperCustody(); expect(observation.value.helpers).toEqual([]); await observation.assertCurrent(); expect(f.operations).toEqual([]); expect(existsSync(vault)).toBe(false);
  f.context.close(); await expect(observation.assertCurrent()).rejects.toThrow();
});

test('missing existing credential storage refuses without mkdir or a remote request', async () => {
  const f = await fixture('idle'), vault = join(f.directory, 'vault'); rmSync(vault, { recursive: true });
  await expect(f.context.helperCustody(f.options)).rejects.toThrow(); expect(existsSync(vault)).toBe(false); expect(f.operations).toEqual([]); expect(f.host.runtime().current().state).toBe('unverified');
});

test('old or unavailable helper custody refuses the complete cohort without calling state or original reconciliation', async () => {
  const f = await fixture('idle'), operations: string[] = [];
  const unavailable = (async (_input, init) => { operations.push(JSON.parse(String(init?.body)).operation); return new Response(null, { status: 503 }); }) as typeof fetch;
  await expect(f.context.helperCustody({ fixture: { basis: 'protocol_fixture', fetch: unavailable } })).rejects.toThrow(); expect(operations).toEqual(['custody']); expect(f.host.runtime().current().state).toBe('unverified');
});

test('a structurally valid foreign original receipt cannot settle or replace the current controller command binding', async () => {
  const f = await fixture(), changed = (async (input, init) => {
    const response = await f.transport(input, init), body = await response.json() as any;
    body.result.requested.receipt.command.kind = 'stop'; body.result.requested.receipt.observation = { state: 'stopped', launchId: null, basis: 'protocol_fixture' }; return Response.json(body);
  }) as typeof fetch;
  await expect(f.context.helperCustody({ fixture: { basis: 'protocol_fixture', fetch: changed } })).rejects.toMatchObject({ code: 's16_ops_helper_original_mismatch' }); expect(f.context.firecracker.controllers[0]!.pending!.state).toBe('unknown'); expect(f.host.starts()).toBe(1);
});

test('injected protocol observations cannot claim native host evidence or activate a default production reader', async () => {
  const f = await fixture('idle'); await expect(f.context.helperCustody()).rejects.toThrow(); expect(f.operations).toEqual([]);
  const forged = (async (input, init) => { const response = await f.transport(input, init), body = await response.json() as any; body.result.basis = 'protected_host'; body.result.computer.basis = 'protected_host'; return Response.json(body); }) as typeof fetch;
  await expect(f.context.helperCustody({ fixture: { basis: 'protocol_fixture', fetch: forged } })).rejects.toThrow(); expect(f.host.runtime().current().state).toBe('unverified');
});

test('pending read retains both current exclusions until its original promise settles and cannot publish after close begins', async () => {
  const f = await fixture('idle'), started = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>();
  const held = (async (input, init) => { started.resolve(); await gate.promise; return f.transport(input, init); }) as typeof fetch;
  const pending = f.context.helperCustody({ fixture: { basis: 'protocol_fixture', fetch: held } }); await started.promise;
  expect(() => f.context.close()).toThrow(expect.objectContaining({ code: 's16_ops_source_release_unknown' })); expect(() => openS16InstallationLease({ directory: f.directory, mode: 'shared' })).toThrow();
  gate.resolve(); await expect(pending).rejects.toThrow(); f.context.close(); const next = openS16ControlMaintenance(f.config); next.close(); expect(f.host.runtime().current().state).toBe('unverified');
});

test('finite custody timeout refuses without changing helper or original controller metadata', async () => {
  const f = await fixture('idle'), before = sha(readFileSync(f.path));
  const stalled = (async (_input, init): Promise<Response> => { await new Promise<void>(resolve => { if (init?.signal?.aborted) resolve(); else init?.signal?.addEventListener('abort', () => resolve(), { once: true }); }); throw Error('aborted_fixture'); }) as typeof fetch;
  await expect(f.context.helperCustody({ fixture: { basis: 'protocol_fixture', fetch: stalled, timeoutMs: 20 } })).rejects.toThrow(); expect(sha(readFileSync(f.path))).toBe(before); expect(f.host.runtime().current().state).toBe('unverified'); f.context.assertCurrent();
});
