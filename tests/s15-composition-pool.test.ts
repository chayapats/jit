import { afterEach, expect, test } from 'bun:test';
import { dictionaries } from '../src/i18n';
import { readS15VmPool } from '../src/s15/main';
import { VmSshTransport } from '../src/s15/vm/transport';
import type { VmHostCommand, VmManagement, WorkingVmPort } from '../src/s15/vm/types';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { composedFixture } from './fixtures/s15-composition';
import { FakeQemuHost } from './fixtures/s15-qemu';

// POOL15-01 and SETUP15-01 under the real composition: placement for conversation and GitHub work,
// per-member TEAM leases, the legacy single-VM shape, and the automatic, restart-safe working computer.
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
type Fixture = Awaited<ReturnType<typeof composedFixture>>;

/** A second fake hypervisor-bound member next to the fixture's default `vm`. */
async function twoComputers() {
  let github: WorkingVmPort | null = null;
  const second: VmManagement = { async inspect() { return { state: 'running', identity: 'fixture2', boot: 'boot', cpuCount: 2, memoryBytes: 1e9, diskBytes: 1e9, network: 'isolated', nicMac: '52:54:00:12:34:56' }; }, async stop() {}, async snapshot() {}, async restore() {}, async retireSnapshot() {} };
  const f = await composedFixture('default', false, undefined, o => ({ ...o, vm: { ...o.vm, managers: new Map([...o.vm.managers, ['manager2', second]]) },
    github: { ...o.github!, workspace: input => { github = input.vm; return o.github!.workspace(input); } } })); cleanups.push(() => f.close());
  f.service.vmStore.save({ ...f.service.vmStore.registration('vm'), id: 'vm2', managerId: 'manager2', machineIdentity: 'fixture2' });
  return { f, github: () => github! };
}
const admit = (f: Fixture, id: string, bot = 0) => {
  const work = f.service.policy.owner.admit(f.owner, { requestId: id, intent: 'execute', access: 'reversible_write', purpose: f.policyInput.purposes[0]!, bot: f.policyInput.bots[bot]!, resources: [f.policyInput.resources[0]!], recipients: [], selection: f.choice, selectionPin: null, expiresAt: 800000 }).work!;
  return { actor: f.service.policy.control.bindWork(work.id), id: work.id };
};

test('conversation work is placed on the less loaded computer with its own TEAM lease, and later attempts return to it', async () => {
  const { f } = await twoComputers();
  const held = admit(f, 'held_on_vm'), session = await f.service.workingVm.openAttempt(held.actor, { vmId: 'vm', workId: held.id, attemptId: `chat_${held.id}` });
  expect(f.service.vmPool.holder(held.id)).toBe('vm');
  // With one VM the shared TEAM workspace lease made this resource_busy; per-member leases let vm2 serve.
  f.interpretation = { intent: 'execute', purposeId: 'purpose', resourceIds: ['computer'], access: 'reversible_write', subject: null };
  const row = await f.chat('Run the requested command in the working computer');
  expect(row.state).toBe('completed'); expect(f.vmCalls).toContain('spawn');
  expect(f.service.vmPool.holder(row.authority!.id)).toBe('vm2');
  await session.close();
  // Both idle now: a tie would choose the default member, but the work's workspace is on vm2.
  const again = await f.service.workingVm.openAttempt(f.service.policy.control.bindWork(row.authority!.id), { vmId: 'vm', workId: row.authority!.id, attemptId: `chat_${row.authority!.id}` });
  expect(f.service.vmStore.db.query<{ vm_id: string }, [string]>("SELECT vm_id FROM vm_sessions WHERE work_id=? AND state<>'closed'").get(row.authority!.id)?.vm_id).toBe('vm2');
  await again.close(); expect(f.liveVm).toBe(0);
  // A member id is never accepted from a consumer; only the pool id is.
  await expect(f.service.workingVm.openAttempt(held.actor, { vmId: 'vm2', workId: held.id, attemptId: `chat_${held.id}` })).rejects.toMatchObject({ code: 'vm_policy_denied' });
});

test('the GitHub workspace receives the placing port and its work lands on the free member', async () => {
  const { f, github } = await twoComputers();
  const held = admit(f, 'busy_default'), session = await f.service.workingVm.openAttempt(held.actor, { vmId: 'vm', workId: held.id, attemptId: `chat_${held.id}` });
  const work = admit(f, 'github_work', 1), attemptId = `github_${'a'.repeat(32)}`;
  const opened = await github().openAttempt(work.actor, { vmId: 'vm', workId: work.id, attemptId, mode: 'work', access: 'execute' });
  expect(f.service.vmPool.holder(work.id)).toBe('vm2');
  await opened.close(); await session.close();
  // Draining vm2 stops new placement there, but this work still returns to its workspace.
  f.service.vmPool.setDrained('vm2', true);
  const later = await github().openAttempt(work.actor, { vmId: 'vm', workId: work.id, attemptId: `github_${'b'.repeat(32)}`, mode: 'work', access: 'execute' });
  expect(f.service.vmStore.db.query<{ vm_id: string }, [string]>("SELECT vm_id FROM vm_sessions WHERE work_id=? AND state<>'closed'").get(work.id)?.vm_id).toBe('vm2'); await later.close();
  const fresh = admit(f, 'after_drain'), placed = await f.service.workingVm.openAttempt(fresh.actor, { vmId: 'vm', workId: fresh.id, attemptId: `chat_${fresh.id}` });
  expect(f.service.vmPool.holder(fresh.id)).toBe('vm'); await placed.close();
});

test('the composed Resources page lists both computers and drains one through the owner form', async () => {
  const { f } = await twoComputers();
  const page = await (await f.request('/resources/computer')).text();
  expect(page).toContain('s15-pool'); expect(page).toContain('id="s15-computer-vm"'); expect(page).toContain('id="s15-computer-vm2"'); expect(page).toContain('s15-computer-add');
  const drained = await f.form('/s15/forms/computer/drain', { vmId: 'vm2', drained: '1' });
  expect(drained.status).toBe(303); expect(f.service.vmPool.members().find(m => m.id === 'vm2')?.drained).toBe(true);
  expect((await f.form('/s15/forms/computer/drain', { vmId: 'vm2', drained: '0', csrf: 'forged' })).status).toBe(403);
  expect(f.service.vmPool.members().find(m => m.id === 'vm2')?.drained).toBe(true);
});

test('the existing single-VM config shape reads as a one-member pool and composes unchanged', async () => {
  const config = s15StageConfig('/protected/installation', 'http://localhost:3041');
  expect(readS15VmPool(config.vm)).toEqual({ poolId: 'working', defaultMemberId: 'working', local: false });
  expect(readS15VmPool({ ...config.vm, local: true })).toMatchObject({ local: true });
  expect(() => readS15VmPool({ ...config.vm, id: '../other' })).toThrow('invalid_s15_config');
  const f = await composedFixture(); cleanups.push(() => f.close());
  expect(f.service.vmPool.members().map(m => m.id)).toEqual(['vm']); expect(f.service.provisioning).toBeNull();
  expect((await f.chat('Run the requested command in the working computer')).state).toBe('completed');
});

/** Composed local VM on a fake KVM host; `crash` aborts the job (a controller stop) at the first matching command. */
async function automatic() {
  const h = new FakeQemuHost(); cleanups.push(() => h.cleanup());
  const { proxySocket: _socket, ...local } = h.options(), state: { crash: string | null; f: Fixture | null } = { crash: null, f: null };
  const run: VmHostCommand = async (argv, options) => {
    if (state.crash && argv.join(' ').includes(state.crash)) { state.crash = null; void state.f!.service.provisioning!.close(); throw new DOMException('Aborted', 'AbortError'); }
    return h.run(argv, options);
  };
  const f = await composedFixture('default', false, undefined, o => ({ ...o, vm: { ...o.vm, local: { ...local, run }, enrollmentRun: run, transport: registration => new VmSshTransport(registration.endpoint, run) } }));
  cleanups.push(() => f.close()); state.f = f;
  // A fresh installation: the default member is not enrolled yet.
  f.service.vmStore.db.query("DELETE FROM vm_registry WHERE id='vm'").run();
  return { h, f, state };
}
const creates = (h: FakeQemuHost) => h.commands.filter(c => c[0] === '/usr/bin/qemu-img' && c[1] === 'create').length;

test('SETUP15-01: a KVM controller creates, starts and enrolls the default computer with no typed value', async () => {
  const { h, f } = await automatic();
  const started = f.service.provisioning!.ensure(); expect(started).toMatchObject({ state: 'running', step: 'host', vmId: 'vm' });
  await f.service.provisioning!.settled();
  expect(f.service.provisioning!.view()).toMatchObject({ state: 'enrolled', error: null });
  const status = f.service.enrollment.status(f.owner, 'vm');
  expect(status).toMatchObject({ state: 'ready', networkIsolated: true, facts: { docker: true } });
  // Rows are observed: isolation proven by hypervisor and egress checks, snapshot/stop still unproven.
  expect(status.capabilities.map(c => [c.id, c.state])).toEqual([['network-isolated', 'proven'], ['snapshot-recovery', 'unproven'], ['hypervisor-stop', 'unproven']]);
  expect(h.downloads).toHaveLength(1); expect(creates(h)).toBe(1);
  expect(f.service.vmPool.members()).toMatchObject([{ id: 'vm', isDefault: true }]);
  const page = await (await f.request('/resources/computer')).text();
  expect(page).toContain((dictionaries.th as Record<string, string>)['s15.pool.origin_local']!);
  // Re-running ensure (setup again, or the next boot) starts nothing new.
  f.service.provisioning!.ensure(); expect(f.service.provisioning!.view()!.attempts).toBe(1);
  expect(f.service.vmStore.db.query('SELECT id FROM vm_managers').all()).toHaveLength(1);
});

test('SETUP15-01: a restart during first boot removes the half-made machine by exact path and recreates it once', async () => {
  const { h, f, state } = await automatic();
  state.crash = 'cloud-init';
  f.service.provisioning!.ensure(); await f.service.provisioning!.settled();
  expect(f.service.provisioning!.view()).toMatchObject({ state: 'running', step: 'connect', active: false });
  expect([...h.units.values()].some(u => u.active)).toBe(false);
  await f.reopen(); state.f = f;
  const setup = await (await f.request('/setup')).text();
  expect(setup).toContain((dictionaries.th as Record<string, string>)['s15.provision.continue']!);
  f.service.provisioning!.ensure(); await f.service.provisioning!.settled();
  expect(f.service.provisioning!.view()).toMatchObject({ state: 'enrolled', attempts: 1 });
  expect(creates(h)).toBe(2); expect(h.downloads).toHaveLength(1);
  expect(f.service.vmStore.db.query('SELECT id FROM vm_managers').all()).toHaveLength(1); expect(h.units.size).toBe(1);
  expect(f.service.enrollment.status(f.owner, 'vm').state).toBe('ready');
});

test('SETUP15-01: a restart during the final checks reuses the finished guest after re-verification', async () => {
  const { h, f, state } = await automatic();
  state.crash = 'platform.machine';
  f.service.provisioning!.ensure(); await f.service.provisioning!.settled();
  expect(f.service.provisioning!.view()).toMatchObject({ state: 'running', step: 'checks', active: false });
  const launches = h.launches.length;
  await f.reopen(); state.f = f;
  f.service.provisioning!.ensure(); await f.service.provisioning!.settled();
  expect(f.service.provisioning!.view()!.state).toBe('enrolled');
  expect(creates(h)).toBe(1); expect(h.launches).toHaveLength(launches); expect(h.units.size).toBe(1);
  expect(f.service.vmStore.db.query('SELECT id FROM vm_registry').all()).toEqual([{ id: 'vm' }]);
});

test('SETUP15-01: without KVM nothing starts, the setup card explains why and offers enrollment, and nothing claims readiness', async () => {
  const { h, f } = await automatic(); h.facts.kvm = false;
  expect(f.service.provisioning!.ensure()).toBeNull();
  const page = await (await f.request('/setup')).text(), th = dictionaries.th as Record<string, string>;
  expect(page).toContain(th['s15.code.vm_kvm_unavailable']!); expect(page).toContain('action="/s15/forms/computer/begin"');
  expect(page).not.toContain('action="/s15/forms/computer/provision"'); expect(f.service.vmStore.db.query('SELECT id FROM vm_managers').all()).toHaveLength(0);
});
