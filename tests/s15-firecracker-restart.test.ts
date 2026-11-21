import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { FirecrackerHostLease } from '../src/s15/vm/firecracker/custody';
import { firecrackerHostFixture } from './fixtures/s15-firecracker-host';

test.each(['gone', 'reused', 'reboot'] as const)('restart recovery observes original %s exit without acquiring a PID or sending a signal', async kind => {
  const f = firecrackerHostFixture(); f.exit();
  if (kind === 'gone') f.data.delete(`${f.proc}/stat`);
  if (kind === 'reused') f.write(`${f.proc}/stat`, Buffer.from(f.data.get(`${f.proc}/stat`)!).toString().replace('12345', '67890'));
  if (kind === 'reboot') f.write('/proc/sys/kernel/random/boot_id', '22222222-2222-2222-2222-222222222222\n');
  const facts = await FirecrackerHostLease.recoverStopped(f.selected, { fixture: f.host, guard() {} });
  expect(facts).toMatchObject({ observation: 'process_and_disk_settled', basis: 'protocol_fixture' });
  expect(f.counters()).toEqual({ opens: 0, closes: 0, signals: 0, syncs: 1 });
});

test('a still-present original process cannot be declared stopped after helper restart', async () => {
  const f = firecrackerHostFixture();
  await expect(FirecrackerHostLease.recoverStopped(f.selected, { fixture: f.host, guard() {} })).rejects.toMatchObject({ code: 'vm_firecracker_custody_unproven' });
  expect(f.counters()).toEqual({ opens: 0, closes: 0, signals: 0, syncs: 0 });
});

test.each(['uid', 'disk', 'jail', 'sync', 'boot', 'stat'] as const)('original exit with missing %s evidence retains unknown after restart', async drift => {
  const f = firecrackerHostFixture(); f.exit(); if (drift !== 'stat') f.data.delete(`${f.proc}/stat`);
  if (drift === 'uid') f.otherProcess(); if (drift === 'disk') f.nodes.get(join(f.root, 'rootfs.ext4'))!.inode = '9876';
  if (drift === 'jail') f.nodes.get(join(f.root, 'dev/kvm'))!.rdev = '0'; if (drift === 'sync') f.failSync();
  if (drift === 'boot') f.write('/proc/sys/kernel/random/boot_id', 'unavailable'); if (drift === 'stat') f.write(`${f.proc}/stat`, `${f.selected.process.pid} (malformed)`);
  await expect(FirecrackerHostLease.recoverStopped(f.selected, { fixture: f.host, guard() {} })).rejects.toMatchObject({ code: 'vm_firecracker_custody_unproven' }); expect(f.counters().signals).toBe(0);
});

test('late authority loss and original-disk replacement during recovery cannot publish settlement', async () => {
  for (const replacement of [false, true]) {
    const f = firecrackerHostFixture(); f.exit(); f.data.delete(`${f.proc}/stat`); let guards = 0;
    await expect(FirecrackerHostLease.recoverStopped(f.selected, { fixture: f.host, guard() { if (++guards === 2) { if (replacement) f.nodes.get(join(f.root, 'rootfs.ext4'))!.inode = '9876'; else throw Error('revoked'); } } })).rejects.toMatchObject({ code: 'vm_firecracker_custody_unproven' });
    expect(f.counters()).toMatchObject({ signals: 0, opens: 0, syncs: 1 });
  }
});
