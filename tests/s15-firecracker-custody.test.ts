import { expect, test } from 'bun:test';
import { join } from 'node:path';
import { FirecrackerHostLease } from '../src/s15/vm/firecracker/custody';
import { firecrackerHostFixture as fixture } from './fixtures/s15-firecracker-host';

test('verified host lease binds original executable, jail, disk descriptor and finite cgroup without guest/API evidence', async () => {
  const f = fixture(), lease = await f.open();
  try {
    const facts = lease.inspect(); expect(facts.observation).toBe('process_bound'); expect(facts.basis).toBe('protocol_fixture'); expect(facts.selectionSha256).toMatch(/^[a-f0-9]{64}$/);
    f.selected.host.uid = 0; f.selected.pins.kernel.sha256 = 'b'.repeat(64); // Constructor selection was copied before awaits.
    expect(lease.inspect()).toEqual(facts); expect(f.counters()).toMatchObject({ opens: 1, signals: 0 });
    expect(JSON.stringify(facts)).not.toContain('/srv/'); expect(Object.keys(facts).sort()).toEqual(['basis', 'observation', 'selectionSha256']);
  } finally { lease.close(); }
  expect(f.counters().closes).toBe(1);
});

test.each(['kernel', 'binary', 'disk', 'root', 'argv', 'environment', 'caps', 'groups', 'socket', 'device', 'extra', 'fd', 'cpu', 'swap', 'uid-process'] as const)('API-equivalent metadata cannot hide %s host drift', async drift => {
  const f = fixture();
  if (drift === 'kernel') f.data.set(join(f.root, 'kernel'), Buffer.from('evil kernel!!'));
  if (drift === 'binary') f.links.set(`${f.proc}/exe`, '/opt/jit/firecracker');
  if (drift === 'disk') f.nodes.get(join(f.root, 'rootfs.ext4'))!.inode = '9001';
  if (drift === 'root') f.links.set(`${f.proc}/root`, '/other/jail');
  if (drift === 'argv') f.write(`${f.proc}/cmdline`, '/firecracker\0--no-seccomp\0');
  if (drift === 'environment') f.write(`${f.proc}/environ`, 'PATH=/usr/bin:/bin\0LANG=C\0HOME=/nonexistent\0JIT_TOKEN=SHOULD_NEVER_ESCAPE\0');
  if (drift === 'caps') f.data.set(`${f.proc}/status`, Buffer.from(Buffer.from(f.data.get(`${f.proc}/status`)!).toString().replace('CapEff:\t0000000000000000', 'CapEff:\t0000000000000001')));
  if (drift === 'groups') f.data.set(`${f.proc}/status`, Buffer.from(Buffer.from(f.data.get(`${f.proc}/status`)!).toString().replace('Groups:\t2002', 'Groups:\t2002 1000')));
  if (drift === 'socket') f.nodes.get(join(f.root, 'run/api.sock'))!.mode = 0o777;
  if (drift === 'device') f.add(join(f.root, 'dev/userfaultfd'), 'character', { uid: 2001, gid: 2002, mode: 0o600, rdev: '2800' });
  if (drift === 'extra') f.write(join(f.root, 'host-secret'), 'unreviewed');
  if (drift === 'fd') f.links.set(`${f.proc}/fd/10`, '/etc/secret');
  if (drift === 'cpu') f.write(join(f.cgroup, 'cpu.max'), 'max 100000\n');
  if (drift === 'swap') f.write(join(f.cgroup, 'memory.swap.max'), 'max\n');
  if (drift === 'uid-process') f.otherProcess();
  await expect(f.open()).rejects.toMatchObject({ code: 'vm_firecracker_custody_unproven' });
  expect(f.counters().signals).toBe(0); expect(f.counters().closes).toBe(1);
});

test('late host drift during the final authority guard closes observation before any admission', async () => {
  const f = fixture(); let checks = 0;
  await expect(f.open({ guard() { if (++checks === 2) f.links.set(`${f.proc}/fd/10`, '/control/socket'); } })).rejects.toMatchObject({ code: 'vm_firecracker_custody_unproven' });
  expect(f.counters()).toMatchObject({ signals: 0, closes: 1 });
});

test.each(['unfiltered', 'wrong-cgroup'] as const)('one %s secondary thread cannot inherit the main thread proof', async drift => {
  const f = fixture(), task = `${f.proc}/task/522`;
  const status = Buffer.from(f.data.get(`${f.proc}/status`)!).toString();
  f.write(`${task}/status`, drift === 'unfiltered' ? status.replace('Seccomp:\t2', 'Seccomp:\t0') : status);
  f.write(`${task}/cgroup`, drift === 'wrong-cgroup' ? '0::/other\n' : Buffer.from(f.data.get(`${f.proc}/cgroup`)!));
  await expect(f.open()).rejects.toMatchObject({ code: 'vm_firecracker_custody_unproven' }); expect(f.counters().signals).toBe(0);
});

test('kernel descriptors follow the selected read-only pin and KVM vCPU identity, not an arbitrary anonymous FD', async () => {
  const f = fixture(); f.links.set(`${f.proc}/fd/11`, join(f.root, 'kernel')); f.write(`${f.proc}/fdinfo/11`, 'flags:\t0100000\n');
  const lease = await f.open();
  try {
    expect(lease.inspect().observation).toBe('process_bound');
    f.write(`${f.proc}/fdinfo/11`, 'flags:\t0100002\n'); expect(() => lease.inspect()).toThrow('vm_firecracker_custody_unproven');
    f.write(`${f.proc}/fdinfo/11`, 'flags:\t0100000\n'); f.links.set(`${f.proc}/fd/10`, 'anon_inode:kvm-vcpu:2');
    expect(() => lease.inspect()).toThrow('vm_firecracker_custody_unproven');
    f.links.set(`${f.proc}/fd/10`, 'anon_inode:kvm-vcpu:1'); f.links.set(`${f.proc}/fd/12`, 'socket:[9999]');
    expect(() => lease.inspect()).toThrow('vm_firecracker_custody_unproven');
  } finally { lease.close(); }
});

test('selection digest stays stable across a new protected process/disk identity, while each exact receipt is checked', async () => {
  const f = fixture(), original = await f.open(), digest = original.inspect().selectionSha256; original.close();
  const g = fixture(); g.selected.disk.inode = '9001'; g.nodes.get(join(g.root, 'rootfs.ext4'))!.inode = '9001';
  g.selected.process.startTicks = '67890'; g.write(`${g.proc}/stat`, Buffer.from(g.data.get(`${g.proc}/stat`)!).toString().replace('12345', '67890'));
  const lease = await g.open(); try { expect(lease.inspect().selectionSha256).toBe(digest); } finally { lease.close(); }
});

test('exact process exit plus UID census and original-disk fsync is distinct from a process-only observation', async () => {
  const f = fixture(), lease = await f.open();
  try {
    const original = lease.inspect(); expect(await lease.stop({ guard() {} })).toEqual({ ...original, observation: 'process_and_disk_settled' });
    expect(f.counters()).toMatchObject({ signals: 1, syncs: 1 });
    expect(await lease.settled(() => {})).toEqual({ ...original, observation: 'process_and_disk_settled' });
    await expect(lease.stop({ guard() {} })).rejects.toMatchObject({ outcome: 'unknown' }); expect(f.counters().signals).toBe(1);
  } finally { lease.close(); }
});

test.each(['uid-process', 'disk', 'sync'] as const)('exit with uncertain %s retains the original lease and never reports settled', async drift => {
  const f = fixture(), lease = await f.open();
  try {
    f.exit(); if (drift === 'uid-process') f.otherProcess(); if (drift === 'disk') f.nodes.get(join(f.root, 'rootfs.ext4'))!.inode = '9001'; if (drift === 'sync') f.failSync();
    await expect(lease.settled(() => {})).rejects.toMatchObject({ code: 'vm_firecracker_custody_unproven' });
    expect(f.counters().signals).toBe(0);
  } finally { lease.close(); }
});

test('a clean external exit can settle after sockets disappear, without sending a signal', async () => {
  const f = fixture(), lease = await f.open();
  try {
    f.exit(); f.nodes.delete(join(f.root, 'run/api.sock')); f.nodes.delete(join(f.root, 'run/vsock.sock'));
    expect((await lease.settled(() => {})).observation).toBe('process_and_disk_settled'); expect(f.counters().signals).toBe(0);
  } finally { lease.close(); }
});

test('uncertain disk flush after a real stop keeps the original descriptor for read-back and never sends another signal', async () => {
  const f = fixture(), lease = await f.open();
  try {
    f.failSync(); await expect(lease.stop({ guard() {} })).rejects.toMatchObject({ code: 'vm_firecracker_custody_unproven' });
    expect(f.counters()).toMatchObject({ signals: 1, closes: 0 });
    await expect(lease.stop({ guard() {} })).rejects.toMatchObject({ outcome: 'unknown' });
    f.recoverSync(); expect((await lease.settled(() => {})).observation).toBe('process_and_disk_settled');
    expect(f.counters().signals).toBe(1);
  } finally { lease.close(); }
});

test('stale publication authority and complete-operation deadlines cannot publish or acquire a late lease', async () => {
  const f = fixture(), gate = Promise.withResolvers<void>();
  await expect(f.open({ guard: () => gate.promise, timeoutMs: 10 })).rejects.toMatchObject({ code: 'vm_firecracker_custody_unproven' });
  gate.resolve(); await Promise.resolve(); expect(f.counters().opens).toBe(0);
  const g = fixture(), lease = await g.open();
  try {
    g.exit(); let checks = 0;
    await expect(lease.settled(() => { if (++checks === 2) throw Error('revoked'); })).rejects.toMatchObject({ code: 'vm_firecracker_custody_unproven' });
    const hold = Promise.withResolvers<void>(); await expect(lease.settled(() => hold.promise, { timeoutMs: 10 })).rejects.toMatchObject({ code: 'vm_firecracker_custody_unproven' }); hold.resolve();
  } finally { lease.close(); }
});

test('injected host/process observations cannot upgrade their evidence basis', async () => {
  const f = fixture(); Object.assign(f.host, { basis: 'protected_host' });
  await expect(f.open()).rejects.toMatchObject({ code: 'vm_firecracker_custody_unproven' }); expect(f.counters().opens).toBe(0);
});

test.skipIf(process.platform === 'linux')('native custody refuses this non-Linux host before selecting any process', async () => {
  const f = fixture(); await expect(FirecrackerHostLease.open(f.selected, { guard() {} })).rejects.toMatchObject({ code: 'vm_firecracker_custody_unproven' });
});
