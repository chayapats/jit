import { afterEach, expect, test } from 'bun:test';
import { equal } from '../src/s15/policy/validation';
import { QemuVmManagement } from '../src/s15/vm/qemu';
import { VmSshTransport } from '../src/s15/vm/transport';
import { composedFixture } from './fixtures/s15-composition';
import { FakeQemuHost } from './fixtures/s15-qemu';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of cleanups.splice(0).reverse()) await c(); });
const capability = (f: Awaited<ReturnType<typeof composedFixture>>, id: string, row: string) => f.service.enrollment.status(f.owner, id).capabilities.find(c => c.id === row)?.state;

async function qemuFixture() {
  const h = new FakeQemuHost(); cleanups.push(() => h.cleanup());
  const manager = new QemuVmManagement({ name: 'jit-work-00aa11bb22cc', architecture: 'x86_64', mac: '52:54:00:12:34:56', sshPort: 22122, resources: { cpus: 2, memoryMiB: 4096, diskGiB: 60 } }, h.options());
  await manager.provision();
  const f = await composedFixture('default', false, undefined, o => ({ ...o, vm: { ...o.vm, managers: new Map([['manager', manager]]) } })); cleanups.push(() => f.close());
  const machine = await manager.inspect();
  f.service.vmStore.save({ ...f.service.vmStore.registration('vm'), endpoint: { ...manager.endpoint() }, machineIdentity: machine.identity, boot: machine.boot, bindingMac: machine.nicMac! });
  return { h, f, manager };
}

test('S15-AC03 local QEMU under composed POLICY/TEAM: live snapshot before system admin, honest rows, TEAM release on protected stop, no policy rewind', async () => {
  const { h, f, manager } = await qemuFixture();
  expect(capability(f, 'vm', 'snapshot-recovery')).toBe('unproven'); expect(capability(f, 'vm', 'hypervisor-stop')).toBe('unproven');
  // A system-administration session takes the exclusive lease and a live protected snapshot first.
  f.interpretation = { intent: 'execute', purposeId: 'purpose', resourceIds: ['computer'], access: 'reversible_write', subject: null };
  const row = await f.chat('Run the requested command');
  const actor = f.service.policy.control.bindWork(row.authority!.id), launches = h.launches.length;
  const system = await f.service.vm.openAttempt(actor, { vmId: 'vm', workId: row.authority!.id, attemptId: `chat_${row.authority!.id}`, mode: 'system' });
  const snapshot = f.service.vm.snapshots(f.owner, 'vm')[0]!;
  expect(h.qmpLog.filter(c => c.execute === 'blockdev-snapshot-internal-sync')).toEqual([{ execute: 'blockdev-snapshot-internal-sync', arguments: { device: 'disk0', name: snapshot.id } }]);
  expect(await manager.snapshots()).toContain(snapshot.id); expect(h.launches).toHaveLength(launches); expect((await manager.inspect()).state).toBe('running');
  await system.close();
  // Unproven cooperative cleanup leaves the TEAM lease fenced until protected hypervisor stop proof.
  const leases = () => f.service.team.store.db.query<{ state: string }, []>('SELECT state FROM leases').all().map(r => r.state);
  f.cleanupConfirmed = false; await f.chat('Run the requested command in the working computer');
  expect(leases()).toContain('unknown');
  const usage = f.service.policy.control.usage(), generation = f.service.vmStore.registration('vm').generation;
  expect((await f.request('/s15/vm/recover', 'POST', { vmId: 'vm', snapshotId: snapshot.id })).status).toBe(200);
  expect(h.qmpLog.at(-1)?.execute).toBe('quit'); expect((await manager.inspect()).state).toBe('stopped');
  expect(h.commands.some(c => c[1] === 'snapshot' && c[2] === '-a' && c[3] === snapshot.id)).toBe(true);
  expect(leases()).not.toContain('unknown');
  expect(equal(usage, f.service.policy.control.usage())).toBe(true);
  expect(f.service.vmStore.registration('vm')).toMatchObject({ state: 'stopped', generation: generation + 1 });
  expect(capability(f, 'vm', 'snapshot-recovery')).toBe('proven'); expect(capability(f, 'vm', 'hypervisor-stop')).toBe('proven');
  // Restore leaves it stopped; only the explicit owner start boots it again and re-verifies the binding.
  f.cleanupConfirmed = true; await f.service.vm.start(f.owner, 'vm');
  expect(h.launches).toHaveLength(launches + 1); expect(f.service.vmStore.registration('vm').state).toBe('ready');
  expect((await f.chat('Run the requested command in the working computer again')).state).toBe('completed');
});

test('S15-AC03 composed local VM: owner registers it with one call, enrolls without a pasted line, edits resources, and reopen re-attaches without restarting', async () => {
  const h = new FakeQemuHost(); cleanups.push(() => h.cleanup());
  const { proxySocket: _socket, ...local } = h.options(), proxyLog: string[] = [];
  const f = await composedFixture('default', false, undefined, o => ({ ...o, vm: { ...o.vm, local: { ...local, proxyLog: entry => proxyLog.push(entry.host) }, enrollmentRun: h.run,
    transport: registration => new VmSshTransport(registration.endpoint, h.run) } })); cleanups.push(() => f.close());
  const registered = await f.request('/s15/vm/management', 'POST', { kind: 'qemu' }); expect(registered.status).toBe(200);
  const { managerId } = await registered.json() as { managerId: string };
  const status = await f.service.enrollment.enrollLocal(f.owner, { id: 'local', managerId });
  expect(status).toMatchObject({ state: 'ready', networkIsolated: true, recoveryAvailable: true, facts: { docker: true } });
  expect(status.capabilities.map(c => [c.id, c.state])).toEqual([['network-isolated', 'proven'], ['snapshot-recovery', 'unproven'], ['hypervisor-stop', 'unproven']]);
  const view = await (await f.request(`/s15/vm/resources?managerId=${managerId}`)).json() as { resources: { cpus: number; memoryMiB: number; diskGiB: number }; defaults: unknown };
  expect(view.resources).toEqual({ cpus: 5, memoryMiB: 9216, diskGiB: 60 }); expect(view.defaults).toEqual(view.resources);
  expect((await f.request('/s15/vm/resources', 'POST', { managerId, cpus: 4, memoryMiB: 8192, diskGiB: 60 })).status).toBe(200);
  expect((await f.request('/s15/vm/resources', 'POST', { managerId, cpus: 4, memoryMiB: 8192, diskGiB: 60, root: true })).status).toBe(409);
  const launches = h.launches.length, before = f.service.vmStore.registration('local');
  await f.reopen(); await f.service.vm.reattach();
  expect(h.launches).toHaveLength(launches);
  expect(f.service.vmStore.registration('local')).toMatchObject({ state: 'ready', boot: before.boot, generation: before.generation });
  const argv = h.launches.at(-1)!; expect(argv[argv.indexOf('-smp') + 1]).toBe('5');
});
