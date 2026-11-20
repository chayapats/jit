import { expect, test } from 'bun:test';
import { FirecrackerLaunchUnits, firecrackerUnitName } from '../src/s15/vm/firecracker/units';
import { FirecrackerHostJobs, FirecrackerHostJournal, type FirecrackerHostJobDriver } from '../src/s15/vm/firecracker/jobs';
import { firecrackerHostFixture } from './fixtures/s15-firecracker-host';
import type { VmHostCommand } from '../src/s15/vm/types';

// Fixed systemd protocol fixtures, not native Linux manager/VM evidence.
const request = '1'.repeat(32), unit = firecrackerUnitName(request);
function status(patch: Record<string, string> = {}): string {
  return Object.entries({ Id: unit, LoadState: 'loaded', ActiveState: 'active', SubState: 'running', MainPID: '521', InvocationID: 'a'.repeat(32), Result: 'success', Type: 'exec', Restart: 'no', RemainAfterExit: 'yes', User: 'root', Group: 'root', PrivateMounts: 'yes', StandardInput: 'null', StandardOutput: 'null', StandardError: 'null', ...patch }).map(([key, value]) => `${key}=${value}`).join('\n') + '\n';
}
function fixture(run: VmHostCommand, current: (request: string, computer: string) => void = () => {}) {
  const f = firecrackerHostFixture(); let checks = 0;
  const units = new FirecrackerLaunchUnits({ profile: f.selected.profile, host: f.selected.host, current, preflight() { checks++; }, fixture: run });
  return { units, checks: () => checks, selected: f.selected };
}

test('one original submission uses fixed systemd scope, minimal environment, private device view and retained metadata', async () => {
  const commands: readonly string[][] = [], scopes: string[][] = []; let effects = 0;
  const f = fixture(async (argv, options) => {
    (commands as string[][]).push([...argv]); expect(options.env).toEqual({ PATH: '/usr/bin:/bin', LANG: 'C', HOME: '/nonexistent' });
    options.beforeStart!(); effects++; return { exitCode: 0, stdout: new Uint8Array() };
  }, (requestId, computer) => { scopes.push([requestId, computer]); });
  f.selected.host.uid = 0; // The immutable constructor selection is retained.
  expect(await f.units.launch(request)).toEqual({ observation: 'unit_start_submitted', unit, basis: 'protocol_fixture' });
  const argv = commands[0]!;
  for (const arg of ['--system', '--service-type=exec', '--property=RemainAfterExit=yes', '--property=Restart=no', '--property=PrivateMounts=yes', '--property=BindReadOnlyPaths=/srv/jit/.jit-proc-misc:/proc/misc:norbind', '--property=StandardInput=null', '--property=StandardOutput=null', '--property=StandardError=null']) expect(argv).toContain(arg);
  const separator = argv.indexOf('--'); expect(argv.slice(separator + 1, separator + 7)).toEqual(['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'LANG=C', 'HOME=/nonexistent', '/opt/jit/jailer']);
  expect(argv).toContain('memory.swap.max=0'); expect(argv).not.toContain('--collect'); expect(argv).not.toContain('--user'); expect(argv).not.toContain('--no-block');
  expect(scopes.every(scope => scope[0] === request && scope[1] === 'jit-work-fixture')).toBe(true); expect(f.checks()).toBe(2);
  await expect(f.units.launch(request)).rejects.toMatchObject({ outcome: 'unknown' }); expect(effects).toBe(1);
});

test('lost submission stays unknown, preserves no peer diagnostics and never starts another unit', async () => {
  let effects = 0;
  const f = fixture(async (_argv, options) => { options.beforeStart!(); effects++; throw Error('PRIVATE_PEER_DIAGNOSTIC'); });
  const error = await f.units.launch(request).catch(error => error);
  expect(error).toMatchObject({ outcome: 'unknown', code: 'vm_firecracker_unit_unavailable' }); expect(String(error)).not.toContain('PRIVATE_PEER_DIAGNOSTIC');
  await expect(f.units.launch(request)).rejects.toMatchObject({ outcome: 'unknown' }); expect(effects).toBe(1);
});

test('pending duplicate and revoked actual-beforeStart scope cannot dispatch another process', async () => {
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let authorized = true, calls = 0, effects = 0;
  const f = fixture(async (_argv, options) => { calls++; entered.resolve(); await release.promise; options.beforeStart!(); effects++; return { exitCode: 0, stdout: new Uint8Array() }; }, () => { if (!authorized) throw Error('revoked'); });
  const pending = f.units.launch(request); await entered.promise;
  await expect(f.units.launch(request)).rejects.toMatchObject({ outcome: 'not_sent' }); expect(calls).toBe(1);
  authorized = false; release.resolve(); await expect(pending).rejects.toMatchObject({ outcome: 'not_sent' }); expect(effects).toBe(0);
});

test('a retained exited unit or missing unit is metadata, never vm_stopped or permission to relaunch', async () => {
  let text = status({ MainPID: '0', SubState: 'exited' }), code = 0; const commands: string[][] = [];
  const f = fixture(async (argv, options) => { commands.push([...argv]); options.beforeStart!(); return { exitCode: code, stdout: Buffer.from(text) }; });
  expect(await f.units.inspect(request)).toMatchObject({ state: 'loaded', mainPid: 0, sub: 'exited', basis: 'protocol_fixture' });
  text = `Id=${unit}\nLoadState=not-found\n`; code = 4;
  expect(await f.units.inspect(request)).toEqual({ state: 'missing', unit, basis: 'protocol_fixture' });
  expect(commands.every(argv => argv[0] === '/usr/bin/systemctl' && argv.includes('show') && !argv.includes('start'))).toBe(true);
});

test.each(['duplicate', 'unknown', 'id', 'pid', 'invocation', 'restart', 'namespace', 'stdio'] as const)('malformed or changed %s manager facts cannot be published', async kind => {
  let text = status();
  if (kind === 'duplicate') text += 'MainPID=999\n'; if (kind === 'unknown') text += 'Credential=PRIVATE\n';
  if (kind === 'id') text = status({ Id: 'other.service' }); if (kind === 'pid') text = status({ MainPID: '2147483648' });
  if (kind === 'invocation') text = status({ InvocationID: 'not-an-invocation' }); if (kind === 'restart') text = status({ Restart: 'always' });
  if (kind === 'namespace') text = status({ PrivateMounts: 'no' }); if (kind === 'stdio') text = status({ StandardOutput: 'journal' });
  const f = fixture(async (_argv, options) => { options.beforeStart!(); return { exitCode: 0, stdout: Buffer.from(text) }; });
  await expect(f.units.inspect(request)).rejects.toMatchObject({ code: 'vm_firecracker_unit_unavailable' });
});

test('journal dispatch marker precedes the actual systemd request; original read-back cannot become a duplicate launch', async () => {
  const j = new FirecrackerHostJournal(':memory:'); let effects = 0, reads = 0;
  try {
    const computer = 'jit-work-fixture', sha = 'b'.repeat(64);
    j.register({ id: computer, selectionSha256: sha, diskBytes: 128 * 1048576, basis: 'protocol_fixture' }); j.observe(computer, { state: 'stopped', launchId: null, basis: 'protocol_fixture' });
    const f = fixture(async (argv, options) => { options.beforeStart!(); if (argv[0] === '/usr/bin/systemd-run') { expect(j.receipt(computer, request).state).toBe('dispatched'); effects++; throw Error('reply lost'); } reads++; return { exitCode: 0, stdout: Buffer.from(status()) }; }, (id, profile) => { expect(id).toBe(request); expect(profile).toBe(computer); });
    const driver: FirecrackerHostJobDriver = { basis: 'protocol_fixture', async execute(job, control) { await control.guard(); control.record({ unit: firecrackerUnitName(job.command.requestId) }); await f.units.launch(job.command.requestId); throw Error('unit submission cannot certify readiness'); }, async readBack(job, control) { await control.guard(); expect((await f.units.inspect(job.command.requestId)).state).toBe('loaded'); return null; } };
    const jobs = new FirecrackerHostJobs(j, driver), command = { contract: 's16-firecracker-host-command/v1' as const, requestId: request, computerId: computer, selectionSha256: sha, expectedRevision: 1, expectedLaunchId: null, kind: 'launch' as const };
    expect((await jobs.run(command, () => {})).state).toBe('unknown'); expect((await jobs.run(command, () => {})).state).toBe('unknown');
    expect((await jobs.reconcile(computer, request, () => {})).state).toBe('unknown'); expect(effects).toBe(1); expect(reads).toBe(1);
    expect(j.context(computer, request)).toEqual({ unit });
  } finally { j.close(); }
});

test('invalid original identities refuse before preflight or process preparation', async () => {
  let calls = 0; const f = fixture(async () => { calls++; throw Error('must not run'); });
  for (const invalid of ['other.service', '../vm', 'A'.repeat(32), '1'.repeat(33)]) {
    await expect(f.units.launch(invalid)).rejects.toMatchObject({ outcome: 'not_sent' }); await expect(f.units.inspect(invalid)).rejects.toMatchObject({ outcome: 'not_sent' });
  }
  expect(calls).toBe(0); expect(f.checks()).toBe(0);
});

test.skipIf(process.platform === 'linux')('native unit submission refuses this non-Linux computer without invoking its preflight', async () => {
  const f = firecrackerHostFixture(); let checks = 0;
  const native = new FirecrackerLaunchUnits({ profile: f.selected.profile, host: f.selected.host, current() {}, preflight() { checks++; } });
  await expect(native.launch(request)).rejects.toMatchObject({ outcome: 'not_sent' }); expect(checks).toBe(0);
});
