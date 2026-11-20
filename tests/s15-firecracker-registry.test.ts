import { afterEach, expect, test } from 'bun:test';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { AppError } from '../src/errors';
import { ConnectionVault } from '../src/exec/connections';
import { VmManagers } from '../src/s15/vm/managers';
import { VmStore } from '../src/s15/vm/store';
import { FirecrackerVmManagement } from '../src/s15/vm/firecracker/client';
import { createFirecrackerManagementRelay } from '../src/s15/vm/firecracker/rpc';
import { firecrackerRuntimeFixture } from './fixtures/s15-firecracker-runtime';
import { webFixture } from './fixtures/s15-web';
import type { S15WebComputer } from '../src/s15/web';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const credential = 'registry_private_' + 'r'.repeat(32), installationId = 'installation-fc-registry';
async function fixture() {
  const f = await firecrackerRuntimeFixture(); cleanup.push(() => f.close());
  const relay = createFirecrackerManagementRelay(f.runtime(), { credential, installationId, port: 0 }); cleanup.push(() => relay.close());
  const root = realpathSync(dirname(f.path)), store = new VmStore(join(root, 'controller.sqlite')); cleanup.push(() => store.close());
  const owner = {}, vault = new ConnectionVault(join(root, 'vault'), { forbidden: [f.root, f.recovery] });
  const options = { store, vault, requireOwner(actor: object) { if (actor !== owner) throw new AppError('authentication_required', 401); }, firecracker: { directory: join(root, 'clients'), installationId, fixture: { basis: 'protocol_fixture' as const } } };
  let managers = new VmManagers(options); cleanup.push(() => managers.close());
  const input = { kind: 'firecracker' as const, origin: relay.origin, computerId: f.runtime().computerId, selectionSha256: f.runtime().selectionSha256, token: credential };
  return { ...f, relay, root, store, owner, vault, input, options, managers: () => managers, reopen() { managers.close(); managers = new VmManagers(options); return managers; } };
}

test('actual registry persists a single pinned adapter, isolates its credential and reopens its original controller journal', async () => {
  const f = await fixture(), managers = f.managers(); managers.register(f.owner, { kind: 'lima', instance: 'jit-work-older' }); const { managerId } = managers.register(f.owner, f.input);
  expect(managers.unbound(() => true)).toBe(managerId);
  expect(managers.get(managerId)).toBeInstanceOf(FirecrackerVmManagement); expect(f.vault.read(managerId)).toBe(credential);
  const metadata = f.store.db.query<{ data: string }, [string]>('SELECT data FROM vm_managers WHERE id=?').get(managerId)!.data;
  expect(metadata).not.toContain(credential); expect(readFileSync(join(f.root, 'clients', `${managerId}.sqlite`)).includes(Buffer.from(credential))).toBe(false);
  await managers.startPrepared(f.owner, managerId); expect((await managers.get(managerId)!.inspect()).state).toBe('running'); expect(f.starts()).toBe(1);
  const reopened = f.reopen(); expect(reopened.unbound(() => true)).toBe(managerId); expect(reopened.unbound(id => id !== managerId)).not.toBe(managerId);
  expect((await reopened.get(managerId)!.inspect()).state).toBe('running'); await reopened.startPrepared(f.owner, managerId); expect(f.starts()).toBe(1);
});

test('same-binding credential update retains one manager and cannot create a physical alias or retarget it', () => {
  const fPromise = fixture(); return fPromise.then(f => {
    const m = f.managers(), first = m.register(f.owner, f.input), updated = m.register(f.owner, { ...f.input, token: 'replacement_' + 's'.repeat(32) });
    expect(updated).toEqual(first); expect(m.size).toBe(1); expect(f.vault.read(first.managerId)).toBe('replacement_' + 's'.repeat(32));
    expect(() => m.register(f.owner, { ...f.input, selectionSha256: 'f'.repeat(64) })).toThrow(); expect(m.size).toBe(1);
    expect(() => m.register({}, f.input)).toThrow(expect.objectContaining({ code: 'authentication_required' })); expect(f.starts()).toBe(0);
  });
});

test('enrolled adapters cannot use the pre-enrollment start path to bypass the owning VM service', async () => {
  const f = await fixture(), m = f.managers(), { managerId } = m.register(f.owner, f.input); await m.startPrepared(f.owner, managerId);
  const machine = await m.get(managerId)!.inspect(); f.store.enableVsockBindings();
  f.store.save({ id: 'already-enrolled', generation: 1, endpoint: { host: '127.0.0.1', port: machine.sshEndpoint!.port, user: 'jit', identityFile: '/protected/vm-key', knownHostsFile: '/protected/vm-known' }, managerId,
    state: 'ready', networkCheckedAt: 1, binding: machine.binding!, networkIsolated: true, maxSessions: 2, reason: null, machineIdentity: machine.identity, boot: machine.boot });
  await expect(m.startPrepared(f.owner, managerId)).rejects.toMatchObject({ code: 'vm_already_enrolled' }); expect(f.starts()).toBe(1);
});

test('owner Web setup crosses the real registry/client/root RPC and keeps credential/error fields write-only', async () => {
  const f = await fixture(), m = f.managers(); let managerId: string | null = null;
  const status = { id: 'working', generation: 1, state: 'ready' as const, networkIsolated: true, recoveryAvailable: true, activeSessions: 0, maxSessions: 2, reason: null, capabilities: [], facts: null };
  const computer: S15WebComputer<{ ownerId: string }> = { vmId: 'working', get managerId() { return managerId; }, hypervisor: null,
    status: () => status, begin: async () => ({ setupId: 'setup', publicKey: 'fixture-public-key', command: 'fixture-only enrollment' }), checkMachine: async () => { throw Error('unused'); }, useMachine: async () => { throw Error('unused'); }, snapshots: () => [],
    pool: { members: () => [{ id: 'working', isDefault: true, local: true, drained: false, activeSessions: 0, capacity: 2, works: 0, status }], drain() {}, nextId: () => 'second-computer',
      registerManager(_actor, input) { managerId = m.register(f.owner, input).managerId; }, preparedManager: () => managerId ? { id: managerId } : null,
      startPrepared: (_actor, id) => m.startPrepared(f.owner, id) } };
  const web = webFixture(() => ({ computer })); cleanup.push(() => web.cleanup());
  const before = await (await web.get('/resources/computer', { 'accept-language': 'en' })).text(); expect(before).toContain('A prepared Firecracker computer'); expect(before).toContain('Guest network, browser and desktop are unavailable');
  const csrf = await web.post('/s15/forms/computer/manager', { csrf: 'bad', ...f.input }); expect(csrf.status).toBe(403); expect(m.size).toBe(0);
  const registered = await web.post('/s15/forms/computer/manager', f.input); expect(registered.status).toBe(303); expect(managerId).not.toBeNull();
  const after = await (await web.get('/resources/computer', { 'accept-language': 'en' })).text(); expect(after).toContain('/s15/forms/computer/manager/start'); expect(after).not.toContain(credential);
  const started = await web.post('/s15/forms/computer/manager/start', { managerId: managerId! }); expect(started.status).toBe(303); expect(f.starts()).toBe(1);
  expect((await m.get(managerId!)!.inspect()).state).toBe('running');
});

test.skipIf(process.platform === 'linux' && ['x64', 'arm64'].includes(process.arch) && !!process.getuid?.() && !!process.getgid?.())('unsupported controller refuses native registration before creating metadata or retaining its credential', async () => {
  const f = await fixture(), { fixture: _fixture, ...native } = f.options.firecracker, managers = new VmManagers({ ...f.options, firecracker: native }); cleanup.push(() => managers.close());
  expect(managers.canPrepareFirecracker).toBe(false); expect(() => managers.register(f.owner, f.input)).toThrow(expect.objectContaining({ code: 'vm_host_unsupported' }));
  expect(existsSync(native.directory)).toBe(false); expect(f.store.db.query('SELECT * FROM vm_managers').all()).toHaveLength(0); expect(f.starts()).toBe(0);
});
