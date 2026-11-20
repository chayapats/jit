import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { FirecrackerHostPreparation } from '../src/s15/vm/firecracker/prepare';
import { FirecrackerLaunchUnits } from '../src/s15/vm/firecracker/units';
import { firecrackerHostFixture } from './fixtures/s15-firecracker-host';

function fixture(guard = () => {}) {
  const f = firecrackerHostFixture(); f.exit();
  for (const name of ['api.sock', 'vsock.sock']) f.nodes.delete(join(f.root, 'run', name));
  f.write(join(f.selected.host.jailerBase, '.jit-proc-misc'), Buffer.alloc(0), { mode: 0o444 });
  const { process: _process, ...selected } = f.selected;
  const prepared = new FirecrackerHostPreparation({ selection: selected, fixture: f.host, guard });
  return { ...f, prepared, selected };
}

test('prepared installed pins, no live UID and private empty jailer inventory remain preparation-only facts', () => {
  const f = fixture(), facts = f.prepared.verify();
  expect(facts).toMatchObject({ observation: 'launch_prepared', basis: 'protocol_fixture' }); expect(facts.selectionSha256).toMatch(/^[a-f0-9]{64}$/);
  expect(f.counters()).toEqual({ opens: 0, closes: 0, signals: 0, syncs: 1 }); expect(Object.keys(facts).sort()).toEqual(['basis', 'observation', 'selectionSha256']);
  f.selected.host.uid = 0; expect(f.prepared.verify()).toEqual(facts);
});

test.each(['jailer', 'vmm', 'kernel', 'config', 'disk', 'permission', 'guest-read', 'view', 'linked-view', 'socket', 'uid', 'device', 'dev-link', 'extra', 'ancestor', 'sync'] as const)('actual preparation refuses %s drift before any launch', drift => {
  const f = fixture();
  if (drift === 'jailer') f.data.set(f.selected.host.jailerPath, Buffer.from('changed bytes'));
  if (drift === 'vmm') f.nodes.get(f.selected.host.firecrackerPath)!.mode = 0o644;
  if (drift === 'kernel') f.data.set(join(f.root, 'kernel'), Buffer.from('changed bytes'));
  if (drift === 'config') f.data.set(join(f.root, 'config.json'), Buffer.from('{}'));
  if (drift === 'disk') f.nodes.get(join(f.root, 'rootfs.ext4'))!.inode = '9876';
  if (drift === 'permission') f.nodes.get(join(f.root, 'rootfs.ext4'))!.mode = 0o666;
  if (drift === 'guest-read') f.nodes.get(join(f.root, 'kernel'))!.mode = 0o600;
  if (drift === 'view') f.write(join(f.selected.host.jailerBase, '.jit-proc-misc'), '123 userfaultfd\n');
  if (drift === 'linked-view') f.nodes.get(join(f.selected.host.jailerBase, '.jit-proc-misc'))!.links = 2;
  if (drift === 'socket') f.add(join(f.root, 'run/api.sock'), 'socket', { uid: f.selected.host.uid, gid: f.selected.host.gid, mode: 0o600 });
  if (drift === 'uid') f.otherProcess(); if (drift === 'device') f.add(join(f.root, 'dev/userfaultfd'), 'character');
  if (drift === 'dev-link') f.nodes.get(join(f.root, 'dev'))!.kind = 'other';
  if (drift === 'extra') f.add(join(f.root, 'owner-credential'), 'file'); if (drift === 'ancestor') f.nodes.get('/opt/jit')!.mode = 0o777;
  if (drift === 'sync') f.failSync();
  expect(() => f.prepared.verify()).toThrow(expect.objectContaining({ code: 'vm_firecracker_preparation_unproven' })); expect(f.counters().signals).toBe(0);
});

test('fresh installer-owned directories and absent generated jailer devices are accepted without changing host state', () => {
  const f = fixture(); for (const name of ['dev/kvm', 'dev/net/tun', 'dev/net', 'dev/urandom', 'dev', 'firecracker']) f.nodes.delete(join(f.root, name));
  for (const name of ['', 'run']) { const s = f.nodes.get(join(f.root, name))!; s.uid = 0; s.gid = 0; }
  expect(f.prepared.verify().observation).toBe('launch_prepared'); expect(f.counters().opens).toBe(0);
});

test('actual systemd beforeStart rechecks preparation after a dispatch wait, refusing a newly live VMM UID', async () => {
  const f = fixture(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(); let effects = 0;
  const unit = new FirecrackerLaunchUnits({ profile: f.selected.profile, host: f.selected.host, current() {}, preflight() { f.prepared.verify(); }, fixture: async (_argv, options) => {
    entered.resolve(); await release.promise; options.beforeStart!(); effects++; return { exitCode: 0, stdout: Buffer.alloc(0) };
  } });
  const launch = unit.launch('1'.repeat(32)); await entered.promise; f.otherProcess(); release.resolve();
  await expect(launch).rejects.toMatchObject({ outcome: 'not_sent' }); expect(effects).toBe(0); expect(f.counters().signals).toBe(0);
});

test('captured host I/O cannot be replaced by a later fixture mutation', () => {
  let authorized = true; const f = fixture(() => { if (!authorized) throw Error('revoked'); });
  const sync = f.host.syncDisk; f.host.syncDisk = (...args) => { sync(...args); authorized = false; };
  // The instance captured its actual I/O methods; this callback change cannot replace those methods.
  expect(f.prepared.verify().observation).toBe('launch_prepared');
  authorized = false; expect(() => f.prepared.verify()).toThrow(); expect(f.counters().signals).toBe(0);
});

test('authority revoked by actual disk flush withholds the prepared result', () => {
  let authorized = true; const f = fixture(), sync = f.host.syncDisk;
  f.host.syncDisk = (...args) => { sync(...args); authorized = false; };
  const prepared = new FirecrackerHostPreparation({ selection: f.selected, fixture: f.host, guard() { if (!authorized) throw Error('revoked'); } });
  expect(() => prepared.verify()).toThrow(expect.objectContaining({ code: 'vm_firecracker_preparation_unproven' })); expect(f.counters().syncs).toBe(1);
});

test('retained ARM public CPU facts are revalidated, so a clean restart needs no broad sysfs import', () => {
  const f = fixture(), path = 'sys/devices/system/cpu/cpu0/regs/identification/midr_el1', parts = path.split('/');
  for (let depth = 1; depth < parts.length; depth++) f.add(join(f.root, ...parts.slice(0, depth)), 'directory', { uid: f.selected.host.uid, gid: f.selected.host.gid, mode: 0o700 });
  f.write(join(f.root, path), '0x410fd0c0\n', { uid: f.selected.host.uid, gid: f.selected.host.gid }); f.write('/' + path, '0x410fd0c0\n');
  expect(f.prepared.verify().observation).toBe('launch_prepared');
  f.write('/' + path, 'changed\n'); expect(() => f.prepared.verify()).toThrow(); expect(f.counters().signals).toBe(0);
});

test('native preparation requires an actual native singleton, never a fixture label or this Mac user', () => {
  const f = fixture(); expect(() => new FirecrackerHostPreparation({ selection: f.selected, guard() {} })).toThrow(expect.objectContaining({ code: 'vm_firecracker_preparation_unproven' }));
});
