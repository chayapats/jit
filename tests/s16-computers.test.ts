import { afterEach, expect, test } from 'bun:test';
import { dictionaries } from '../src/i18n';
import type { VmHostCommand, VmManagement } from '../src/s15/vm/types';
import { VmSshTransport } from '../src/s15/vm/transport';
import { vmIdleReason } from '../src/s15/vm/service';
import { privateLocalVmResources, defaultLocalVmResources } from '../src/s15/vm/local';
import { s15InstallerConfig } from '../ops/package/installer/s15';
import { s16ComputerIdleStopMs } from '../src/s16/computers/defaults';
import type { S15CompositionOptions } from '../src/s15/composition';
import { composedFixture } from './fixtures/s15-composition';
import { canonical, digest } from '../src/s15/conversation/validation';
import { FakeQemuHost } from './fixtures/s15-qemu';

// TEAM16-01 under the real composition: per-work workspace leases, private computers that never become shared,
// idle release with on-demand start, the owner computers API and Jit-created private computers on a KVM host.
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const fn of cleanups.splice(0).reverse()) await fn(); });
type Fixture = Awaited<ReturnType<typeof composedFixture>>;
const minute = 60_000;
const host = (h: FakeQemuHost) => ({ cpus: h.facts.cpus, memoryBytes: h.facts.memoryBytes, diskTotalBytes: h.facts.total, diskFreeBytes: h.facts.free });

async function computers(tune?: (o: S15CompositionOptions) => S15CompositionOptions, idleStopMs = 30 * minute) {
  const f = await composedFixture('default', false, undefined, o => { const next = { ...o, computers: { idleStopMs, sweepMs: 0 } }; return tune ? tune(next) : next; });
  cleanups.push(() => f.close()); return f;
}
/** A second fake hypervisor-bound member next to the fixture's default `vm`, with its own observable state. */
function secondMember() {
  const state = { value: 'running' as 'running' | 'stopped', stops: 0, starts: 0 };
  const manager: VmManagement = { async inspect() { return { state: state.value, identity: 'fixture2', boot: state.starts ? `boot${state.starts}` : 'boot', cpuCount: 2, memoryBytes: 1e9, diskBytes: 1e9, network: 'isolated', nicMac: '52:54:00:12:34:56' }; },
    async stop() { state.stops++; state.value = 'stopped'; }, async start() { state.starts++; state.value = 'running'; }, async snapshot() {}, async restore() {}, async retireSnapshot() {} };
  return { state, manager, tune: (o: S15CompositionOptions): S15CompositionOptions => ({ ...o, vm: { ...o.vm, managers: new Map([...o.vm.managers, ['manager2', manager]]) } }) };
}
const enrollSecond = (f: Fixture) => f.service.vmStore.save({ ...f.service.vmStore.registration('vm'), id: 'vm2', managerId: 'manager2', machineIdentity: 'fixture2' });
const admit = (f: Fixture, id: string, bot = 0) => {
  const work = f.service.policy.owner.admit(f.owner, { requestId: id, intent: 'execute', access: 'reversible_write', purpose: f.policyInput.purposes[0]!, bot: f.policyInput.bots[bot]!, resources: [f.policyInput.resources[0]!], recipients: [], selection: f.choice, selectionPin: null, expiresAt: 800000 }).work!;
  return { actor: f.service.policy.control.bindWork(work.id), id: work.id, input: { vmId: 'vm', workId: work.id, attemptId: `chat_${work.id}` } };
};
const open = (f: Fixture, w: ReturnType<typeof admit>) => f.service.workingVm.openAttempt(w.actor, w.input);

test('TEAM16-01: two Bots work concurrently on the shared computer, each in its own workspace lease', async () => {
  const f = await computers(), a = admit(f, 'bot_a', 0), b = admit(f, 'bot_b', 1);
  const first = await open(f, a), second = await open(f, b);
  expect(f.liveVm).toBe(2);
  expect(f.service.vmPool.holder(a.id)).toBe('vm'); expect(f.service.vmPool.holder(b.id)).toBe('vm');
  // Each work owns a separate directory and a separate TEAM lease; a second attempt of the same work stays serialized.
  expect(first.backend.workspaceRoot).not.toBe(second.backend.workspaceRoot);
  await expect(f.service.workingVm.openAttempt(a.actor, { ...a.input, attemptId: `chat_${a.id}` })).rejects.toThrow('resource_busy');
  await first.close(); await second.close(); expect(f.liveVm).toBe(0);
  expect(f.service.team.store.db.query("SELECT count(*) n FROM lease_keys").get()).toEqual({ n: 0 });
  // Without explicit S16 computers the S15 per-member lease is unchanged.
  const plain = await composedFixture(); cleanups.push(() => plain.close());
  const c = admit(plain, 'plain_a', 0), d = admit(plain, 'plain_b', 1), held = await open(plain, c);
  await expect(open(plain, d)).rejects.toThrow('resource_busy'); await held.close();
});

test('TEAM16-01: a private computer serves only its Bot, never becomes shared, and retiring it returns new work to the shared computer', async () => {
  const second = secondMember(), f = await computers(second.tune); enrollSecond(f);
  const scopes = f.service.computerScopes!;
  // The default member stays shared, and a member that already held work can never become private.
  expect(() => scopes.assignPrivate('vm', 'specialist')).toThrow('computer_default_shared');
  const used = admit(f, 'used_vm2', 0), busy = admit(f, 'busy_vm', 0), hold = await open(f, busy), placed = await open(f, used);
  expect(f.service.vmPool.holder(used.id)).toBe('vm2'); await placed.close(); await hold.close();
  expect(() => scopes.assignPrivate('vm2', 'specialist')).toThrow('private_promotion_requires_migration');

  const third = { ...f.service.vmStore.registration('vm2'), id: 'vm3' }; f.service.vmStore.save(third);
  // A Bot whose private computer is still being set up waits instead of using the shared computer.
  scopes.assignPrivate('vm_pending', 'specialist');
  await expect(open(f, admit(f, 'waits', 1))).rejects.toMatchObject({ code: 'vm_private_preparing' });
  scopes.retire('vm_pending');
  scopes.assignPrivate('vm3', 'specialist');
  expect(() => f.service.vmStore.db.query("UPDATE vm_scope SET bot_id='bot' WHERE vm_id='vm3'").run()).toThrow('computer_scope_immutable');
  expect(() => f.service.vmStore.db.query("DELETE FROM vm_scope WHERE vm_id='vm3'").run()).toThrow('computer_scope_immutable');
  expect(() => scopes.assignPrivate('vm2', 'specialist')).toThrow();

  const mine = admit(f, 'specialist_work', 1), session = await open(f, mine);
  expect(f.service.vmPool.holder(mine.id)).toBe('vm3');
  // Another Bot's new work never lands on the private computer, even when it is the least loaded member.
  const other = admit(f, 'bot_work', 0), otherSession = await open(f, other);
  expect(f.service.vmPool.holder(other.id)).not.toBe('vm3');
  await otherSession.close(); await session.close();
  // A work's workspace never moves, and a private member refuses any other Bot's attempt.
  expect(() => f.service.vmPool.place(mine.id, 'bot')).toThrow('outside_scope');

  // Retiring stops new placement there; earlier work still returns to its workspace, only for its Bot.
  scopes.retire('vm3');
  const later = admit(f, 'specialist_later', 1), laterSession = await open(f, later);
  expect(f.service.vmPool.holder(later.id)).not.toBe('vm3'); await laterSession.close();
  const again = await open(f, mine); expect(f.service.vmStore.db.query<{ vm_id: string }, [string]>("SELECT vm_id FROM vm_sessions WHERE work_id=? AND state<>'closed'").get(mine.id)?.vm_id).toBe('vm3'); await again.close();
  expect(scopes.scope('vm3')).toEqual({ kind: 'private', botId: 'specialist' });
  // Restart keeps the scopes.
  await f.reopen(); expect(f.service.computerScopes!.scope('vm3')).toEqual({ kind: 'private', botId: 'specialist' }); expect(f.service.computerScopes!.assigned('specialist')).toEqual([]);
});

test('TEAM16-01: an idle computer sleeps after the idle period, keeps its state and starts again on demand under a new generation', async () => {
  // The fixture's standing policy lives 15 minutes, so the idle period is shortened; production uses 30 minutes.
  expect(s16ComputerIdleStopMs).toBe(30 * minute);
  const f = await computers(undefined, minute), w = admit(f, 'idle_work', 0);
  const session = await open(f, w); await session.backend.writeFileAtomically(`${session.backend.workspaceRoot}/kept.txt`, 'kept');
  f.advance(2 * minute);
  // An open session is never stopped, however long it has been open.
  expect(await f.service.vm.sleepIdle()).toEqual([]);
  await session.close();
  f.advance(minute - 1); expect(await f.service.vm.sleepIdle()).toEqual([]);
  f.advance(1); expect(await f.service.vm.sleepIdle()).toEqual(['vm']);
  const slept = f.service.vmStore.registration('vm'); expect(slept).toMatchObject({ state: 'stopped', reason: vmIdleReason, networkIsolated: false });
  const view = await (await f.request('/api/s16/client/computers')).json();
  expect(view.computers[0]).toMatchObject({ id: 'vm', state: 'sleeping', scope: { kind: 'shared' }, sleepsAt: null });
  // Restart: an idle-stopped computer stays asleep until work needs it.
  await f.reopen(); expect(f.service.vmStore.registration('vm').state).toBe('stopped');
  const resumed = admit(f, 'after_sleep', 0), started = await open(f, resumed);
  const awake = f.service.vmStore.registration('vm'); expect(awake).toMatchObject({ state: 'ready', reason: null, networkIsolated: true }); expect(awake.generation).toBeGreaterThan(slept.generation);
  // The same work returns to its workspace on the woken computer; files there were kept.
  await started.close();
  const back = await f.service.workingVm.openAttempt(f.service.policy.control.bindWork(w.id), w.input);
  const chunks: Uint8Array[] = []; for await (const chunk of back.backend.readFile(`${back.backend.workspaceRoot}/kept.txt`)) chunks.push(chunk);
  expect(Buffer.concat(chunks).toString()).toBe('kept'); await back.close();
  expect(f.service.vmStore.db.query("SELECT kind FROM vm_events WHERE kind LIKE 'idle_%' ORDER BY sequence").all()).toEqual([{ kind: 'idle_stop' }, { kind: 'idle_start' }]);
  const running = (await (await f.request('/api/s16/client/computers')).json()).computers[0];
  expect(running.state).toBe('running'); expect(running.sleepsAt).toBe(f.now + minute);
});

test('TEAM16-01: works arriving while a sleeping computer starts join that one start instead of failing', async () => {
  let starts = 0, release!: () => void;
  const f = await computers(o => { const base = o.vm.managers.get('manager')!; return { ...o, vm: { ...o.vm, managers: new Map([['manager', { ...base, async start() { starts++; await new Promise<void>(resolve => { release = resolve; }); await base.start!(); } }]]) } }; }, minute);
  // The first sweep starts the idle clock of a computer that never had a session.
  expect(await f.service.vm.sleepIdle()).toEqual([]); f.advance(2 * minute); expect(await f.service.vm.sleepIdle()).toEqual(['vm']);
  const a = admit(f, 'wake_a', 0), b = admit(f, 'wake_b', 1);
  const first = open(f, a); await Bun.sleep(5);
  expect(f.service.vmStore.registration('vm').reason).toBe('vm_waking');
  const second = open(f, b); await Bun.sleep(5); release();
  const [x, y] = await Promise.all([first, second]);
  expect(starts).toBe(1); expect(f.liveVm).toBe(2);
  await x.close(); await y.close();
});

test('TEAM16-01: a computer command reserves its request id before acting and a retry finishes an interrupted one', async () => {
  let stop!: () => void;
  const f = await computers(o => { const base = o.vm.managers.get('manager')!; return { ...o, vm: { ...o.vm, managers: new Map([['manager', { ...base, async stop() { await new Promise<void>(resolve => { stop = resolve; }); await base.stop(); } }]]) } }; });
  const sleep = { contract: 's16-computer-command/v1', requestId: 'sleep_once', kind: 'sleep', vmId: 'vm' };
  const running = f.request('/api/s16/client/computers/commands', 'POST', sleep); await Bun.sleep(5);
  // While it runs, the same id with another body conflicts and the same body is in progress; neither acts.
  expect((await f.request('/api/s16/client/computers/commands', 'POST', { ...sleep, kind: 'retire_private' })).status).toBe(409);
  const again = await f.request('/api/s16/client/computers/commands', 'POST', sleep);
  expect(again.status).toBe(409); expect((await again.json()).error).toBe('command_in_progress');
  stop(); expect((await running).status).toBe(200);
  expect((await f.request('/api/s16/client/computers/commands', 'POST', sleep)).status).toBe(200);
  // A restart after the computer slept but before the command was marked done: the retry reports success.
  f.service.vmStore.db.query("INSERT INTO s16_computer_commands VALUES ('interrupted', ?, 'vm', 'pending')").run(digest(canonical({ ...sleep, requestId: 'interrupted' })));
  await f.reopen();
  const retried = await f.request('/api/s16/client/computers/commands', 'POST', { ...sleep, requestId: 'interrupted' });
  expect(retried.status).toBe(200); expect(f.service.vmStore.db.query("SELECT state FROM s16_computer_commands WHERE id='interrupted'").get()).toEqual({ state: 'done' });
  // A sleep whose owner session ends while the hypervisor stops still keeps its identity: the retry succeeds.
  await f.service.vm.start(f.owner, 'vm');
  const late = f.request('/api/s16/client/computers/commands', 'POST', { ...sleep, requestId: 'late_owner' }); await Bun.sleep(5);
  f.generation = 2; stop(); expect((await late).status).not.toBe(200);
  f.generation = 1;
  expect(f.service.vmStore.db.query("SELECT state FROM s16_computer_commands WHERE id='late_owner'").get()).toEqual({ state: 'done' });
  expect((await f.request('/api/s16/client/computers/commands', 'POST', { ...sleep, requestId: 'late_owner' })).status).toBe(200);
  // A failed action releases its id: the same command can be tried again.
  const busy = admit(f, 'busy_sleep', 0), session = await open(f, busy);
  await f.service.vm.start(f.owner, 'vm').catch(() => {});
  const refused = await f.request('/api/s16/client/computers/commands', 'POST', { ...sleep, requestId: 'while_busy' });
  expect(refused.status).toBe(409); expect(f.service.vmStore.db.query("SELECT 1 FROM s16_computer_commands WHERE id='while_busy'").get()).toBeNull();
  await session.close();
});

test('TEAM16-01: an owner-stopped computer is never started by work, and a failed stop fences the computer', async () => {
  const f = await computers();
  await f.service.vm.recover(f.owner, { vmId: 'vm' });
  await expect(open(f, admit(f, 'owner_stopped', 0))).rejects.toThrow();
  expect(f.service.vmStore.registration('vm')).toMatchObject({ state: 'stopped', reason: null });
  expect((await (await f.request('/api/s16/client/computers')).json()).computers[0].state).toBe('stopped');
  const g = await computers(o => ({ ...o, vm: { ...o.vm, managers: new Map([['manager', { ...o.vm.managers.get('manager')!, async stop() { /* The hypervisor never stops. */ } }]]) } }), minute);
  g.advance(2 * minute); await g.service.vm.sleepIdle(); g.advance(2 * minute);
  expect(await g.service.vm.sleepIdle()).toEqual([]);
  expect(g.service.vmStore.registration('vm')).toMatchObject({ state: 'uncertain', reason: 'vm_stop_unconfirmed' });
  await expect(open(g, admit(g, 'fenced', 0))).rejects.toMatchObject({ code: 'vm_fenced' });
});

test('TEAM16-01: the owner computers API lists Bots and computers, sleeps now, and refuses forged or ambiguous commands', async () => {
  const f = await computers();
  const boot = await (await f.request('/api/s16/client/bootstrap')).json();
  expect(boot.capabilities.computers).toEqual({ available: true, contract: 's16-client-computers/v1', idleStopMs: 30 * minute, files: false });
  const view = await (await f.request('/api/s16/client/computers')).json();
  expect(view).toMatchObject({ contract: 's16-client-computers/v1', idleStopMs: 30 * minute, privateCreation: { available: false, code: 'computer_local_unavailable' } });
  expect(view.bots).toEqual([{ id: 'bot', main: true, computer: { kind: 'shared' } }, { id: 'specialist', main: false, computer: { kind: 'shared' } }]);
  const sleep = { contract: 's16-computer-command/v1', requestId: 'sleep_now', kind: 'sleep', vmId: 'vm' };
  expect((await f.request('/api/s16/client/computers/commands', 'POST', sleep, { 'x-csrf-token': 'forged' })).status).toBe(403);
  expect(f.service.vmStore.registration('vm').state).toBe('ready');
  const slept = await f.request('/api/s16/client/computers/commands', 'POST', sleep);
  expect(slept.status).toBe(200); expect((await slept.json()).view.computers[0].state).toBe('sleeping');
  // The same request id returns its first result; a different body under it is refused.
  expect((await f.request('/api/s16/client/computers/commands', 'POST', sleep)).status).toBe(200);
  expect((await f.request('/api/s16/client/computers/commands', 'POST', { ...sleep, vmId: 'other' })).status).toBe(409);
  expect((await f.request('/api/s16/client/computers/commands', 'POST', { ...sleep, requestId: 'extra', extra: true })).status).toBe(400);
  const create = await f.request('/api/s16/client/computers/commands', 'POST', { contract: 's16-computer-command/v1', requestId: 'make', kind: 'create_private', botId: 'specialist' });
  expect(create.status).toBe(409); expect((await create.json()).error).toBe('computer_local_unavailable');
  expect((await f.request('/api/s16/client/computers/commands', 'POST', { contract: 's16-computer-command/v1', requestId: 'stranger', kind: 'create_private', botId: 'stranger' })).status).toBe(403);
  // Without explicit S16 computers there is no API and the capability says so.
  const plain = await composedFixture(); cleanups.push(() => plain.close());
  expect((await (await plain.request('/api/s16/client/bootstrap')).json()).capabilities.computers).toEqual({ available: false, code: 'computers_unavailable' });
  expect((await plain.request('/api/s16/client/computers')).status).toBe(503);
  for (const locale of ['en', 'th'] as const) for (const key of ['s16.nav.computers', 's16.computers.lead', 's16.computers.state.sleeping', 's16.computers.givePrivateBody']) expect((dictionaries[locale] as Record<string, string>)[key]).toBeTruthy();
});

test('TEAM16-01: on a KVM controller the owner gives a Bot its own Jit-created computer, sized for the host, that its work then uses', async () => {
  const h = new FakeQemuHost(); cleanups.push(() => h.cleanup());
  const { proxySocket: _socket, ...local } = h.options(), run: VmHostCommand = (argv, options) => h.run(argv, options);
  const f = await computers(o => ({ ...o, vm: { ...o.vm, local: { ...local, run }, enrollmentRun: run, transport: registration => registration.id === 'vm' ? o.vm.transport!(registration) : new VmSshTransport(registration.endpoint, run) } }));
  f.service.vmStore.db.query("DELETE FROM vm_registry WHERE id='vm'").run();
  f.service.provisioning!.ensure(); await f.service.provisioning!.settled();
  expect(f.service.provisioning!.view()!.state).toBe('enrolled');
  const before = await (await f.request('/api/s16/client/computers')).json();
  expect(before.privateCreation).toEqual({ available: true });
  const made = await f.request('/api/s16/client/computers/commands', 'POST', { contract: 's16-computer-command/v1', requestId: 'make_private', kind: 'create_private', botId: 'specialist' });
  expect(made.status).toBe(200); const result = await made.json();
  expect(result.view.computers.find((c: { id: string }) => c.id === result.vmId)).toMatchObject({ scope: { kind: 'private', botId: 'specialist' } });
  await f.service.computers!.settled();
  const after = await (await f.request('/api/s16/client/computers')).json(), privateComputer = after.computers.find((c: { id: string }) => c.id === result.vmId);
  expect(privateComputer).toMatchObject({ state: 'running', local: true, scope: { kind: 'private', botId: 'specialist' }, isDefault: false });
  expect(after.bots.find((b: { id: string }) => b.id === 'specialist').computer).toEqual({ kind: 'private', vmId: result.vmId });
  // Two separate local machines; the private one uses the smaller private sizing.
  const managers = f.service.vmStore.db.query<{ data: string }, []>('SELECT data FROM vm_managers').all().map(row => JSON.parse(row.data));
  expect(managers).toHaveLength(2); expect(new Set(managers.map(m => m.name)).size).toBe(2);
  expect(managers.find(m => m.forVm === result.vmId).resources).toEqual(privateLocalVmResources(host(h)));
  expect(managers.find(m => !m.forVm).resources).toEqual(defaultLocalVmResources(host(h)));
  // A repeated command creates nothing more; a second private computer for the same Bot is refused.
  expect((await f.request('/api/s16/client/computers/commands', 'POST', { contract: 's16-computer-command/v1', requestId: 'make_private', kind: 'create_private', botId: 'specialist' })).status).toBe(200);
  expect((await f.request('/api/s16/client/computers/commands', 'POST', { contract: 's16-computer-command/v1', requestId: 'make_again', kind: 'create_private', botId: 'specialist' })).status).toBe(409);
  expect(f.service.vmStore.db.query('SELECT id FROM vm_managers').all()).toHaveLength(2);
});

test('TEAM16-01: the generated installer config composes S16 computers', () => {
  const config = s15InstallerConfig({ installationId: 'install_fixture', vmm: null });
  expect(config.computers).toBe(true);
});
