import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { FirecrackerHostLease, type FirecrackerHostFixture, type FirecrackerHostMetadata, type FirecrackerHostSelection } from '../../src/s15/vm/firecracker/custody';
import { firecrackerLaunchPlan } from '../../src/s15/vm/firecracker/launch';

// These are complete protected-host protocol fixtures, never Linux/KVM execution receipts.
const sha = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
export function firecrackerHostFixture(jailerBase = '/srv/jit') {
  const payload = { jailer: Buffer.from('pinned jailer'), firecracker: Buffer.from('pinned VMM'), kernel: Buffer.from('pinned kernel') };
  const selected: FirecrackerHostSelection = {
    profile: { instanceId: 'jit-work-fixture', cpuCount: 2, memoryMiB: 512, guestCid: 3, kernelPath: '/kernel', rootDrivePath: '/rootfs.ext4', vsockPath: '/run/vsock.sock', bootArgs: 'console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw' },
    host: { jailerPath: '/opt/jit/jailer', firecrackerPath: '/opt/jit/firecracker', jailerBase, uid: 2001, gid: 2002, controllerUid: 1000, controllerGid: 1000, diskBytes: 128 * 1048576 },
    pins: Object.fromEntries(Object.entries(payload).map(([key, data]) => [key, { bytes: data.length, sha256: sha(data) }])) as FirecrackerHostSelection['pins'],
    disk: { device: '2', inode: '9000', bytes: 128 * 1048576, initialSha256: 'a'.repeat(64) },
    process: { pid: 521, startTicks: '12345', hostBootId: '12345678-1234-1234-1234-123456789abc' },
  };
  const plan = firecrackerLaunchPlan(selected.profile, selected.host), root = plan.rootDirectory, proc = `/proc/${selected.process.pid}`;
  const nodes = new Map<string, FirecrackerHostMetadata>(), data = new Map<string, Uint8Array>(), links = new Map<string, string>();
  let inode = 100, alive = true, otherUidProcess = false, syncs = 0, signals = 0, opens = 0, closes = 0, failSync = false;
  const add = (path: string, kind: FirecrackerHostMetadata['kind'], extra: Partial<FirecrackerHostMetadata> = {}) => {
    for (let parent = dirname(path); !nodes.has(parent); parent = dirname(parent)) {
      nodes.set(parent, { kind: 'directory', device: '2', inode: String(++inode), rdev: '0', bytes: 0, links: 1, uid: 0, gid: 0, mode: 0o755 }); if (parent === '/') break;
    }
    const s = { kind, device: '2', inode: String(++inode), rdev: '0', bytes: 0, links: 1, uid: 0, gid: 0, mode: 0o644, ...extra }; nodes.set(path, s); return s;
  };
  const write = (path: string, text: Uint8Array | string, extra: Partial<FirecrackerHostMetadata> = {}) => { const bytes = typeof text === 'string' ? Buffer.from(text) : text; data.set(path, bytes); return add(path, 'file', { bytes: bytes.length, ...extra }); };
  write(selected.host.jailerPath, payload.jailer, { mode: 0o755 }); write(selected.host.firecrackerPath, payload.firecracker, { mode: 0o755 });
  const owner = { uid: selected.host.uid, gid: selected.host.gid };
  for (const suffix of ['', '/dev', '/dev/net', '/run']) add(root + suffix, 'directory', { ...owner, mode: 0o700 });
  write(join(root, 'firecracker'), payload.firecracker, { ...owner, mode: 0o755 }); write(join(root, 'kernel'), payload.kernel);
  write(join(root, 'config.json'), plan.configuration);
  add(join(root, 'rootfs.ext4'), 'file', { ...owner, mode: 0o600, ...{ device: selected.disk.device, inode: selected.disk.inode, bytes: selected.disk.bytes } });
  for (const [path, rdev] of [['dev/kvm', '2792'], ['dev/net/tun', '2760'], ['dev/urandom', '265']] as const) add(join(root, path), 'character', { ...owner, mode: 0o600, rdev });
  for (const path of ['api.sock', 'vsock.sock']) add(join(root, 'run', path), 'socket', { ...owner, mode: 0o700 });
  write('/proc/sys/kernel/random/boot_id', selected.process.hostBootId + '\n');
  const stat = Array<string>(20).fill('0'); stat[0] = 'S'; stat[19] = selected.process.startTicks;
  write(`${proc}/stat`, `${selected.process.pid} (firecracker) ${stat.join(' ')}\n`);
  write(`${proc}/status`, `Name:\tfirecracker\nUid:\t${owner.uid}\t${owner.uid}\t${owner.uid}\t${owner.uid}\nGid:\t${owner.gid}\t${owner.gid}\t${owner.gid}\t${owner.gid}\nGroups:\t${owner.gid}\nNoNewPrivs:\t1\nSeccomp:\t2\n${['CapInh', 'CapPrm', 'CapEff', 'CapAmb'].map(key => `${key}:\t0000000000000000`).join('\n')}\n`);
  write(`${proc}/cmdline`, ['/firecracker', '--id', selected.profile.instanceId, '--start-time-us', '123', '--start-time-cpu-us', '2', '--parent-cpu-time-us', '1', '--api-sock', '/run/api.sock', '--config-file', '/config.json', ''].join('\0'));
  write(`${proc}/environ`, 'PATH=/usr/bin:/bin\0LANG=C\0HOME=/nonexistent\0');
  write(`${proc}/cgroup`, `0::/jit/firecracker/${selected.profile.instanceId}\n`);
  write(`${proc}/task/${selected.process.pid}/status`, data.get(`${proc}/status`)!);
  write(`${proc}/task/${selected.process.pid}/cgroup`, data.get(`${proc}/cgroup`)!);
  const cgroup = `/sys/fs/cgroup/jit/firecracker/${selected.profile.instanceId}`;
  for (const [file, value] of [['memory.max', String((selected.profile.memoryMiB + 256) * 1048576)], ['memory.swap.max', '0'], ['pids.max', '128'], ['cpu.max', '200000 100000'], ['cgroup.procs', String(selected.process.pid)]]) write(join(cgroup, file!), value! + '\n');
  links.set(`${proc}/root`, root); links.set(`${proc}/exe`, join(root, 'firecracker'));
  for (const [fd, target] of Object.entries({ 0: '/dev/null', 1: '/dev/null', 2: '/dev/null', 3: join(root, 'rootfs.ext4'), 4: join(root, 'dev/kvm'), 5: 'anon_inode:kvm-vm', 6: 'anon_inode:kvm-vcpu:0', 7: 'anon_inode:[eventfd]', 8: 'socket:[1001]', 9: 'socket:[1002]', 10: 'anon_inode:kvm-vcpu:1' })) links.set(`${proc}/fd/${fd}`, target);
  write(`${proc}/fdinfo/3`, 'flags:\t0100002\n');
  add('/dev/null', 'character', { rdev: '259', mode: 0o666 });
  write('/proc/net/unix', 'Num RefCount Protocol Flags Type St Inode Path\n0000: 2 0 00010000 0001 01 1001 /run/api.sock\n0001: 2 0 00010000 0001 01 1002 /run/vsock.sock\n');
  const host: FirecrackerHostFixture = {
    basis: 'protocol_fixture',
    process: { basis: 'protocol_fixture', bootId: () => selected.process.hostBootId, startTicks: () => selected.process.startTicks,
      open() { opens++; return 30; }, exited() { return !alive; }, kill() { signals++; alive = false; }, close() { closes++; } },
    metadata(path, follow = false) { const s = nodes.get(follow ? links.get(path) ?? path : path); if (!s) throw Error('missing fixture node'); return { ...s }; },
    read(path, maximum) {
      if (path === '/proc/999/status') return Buffer.from(`Uid:\t${owner.uid}\t${owner.uid}\t${owner.uid}\t${owner.uid}\n`);
      const value = data.get(path); if (!value) return null; if (value.length > maximum) throw Error('fixture read bound'); return value;
    },
    file(path, maximum, follow = false) { const actual = follow ? links.get(path) ?? path : path, bytes = data.get(actual); if (!bytes || bytes.length > maximum) throw Error('fixture file bound'); return { metadata: host.metadata(actual), sha256: sha(bytes) }; },
    link(path) { const target = links.get(path); if (!target) throw Error('missing fixture link'); return target; },
    list(path, maximum) {
      const values = path === '/proc' ? [...(alive ? [String(selected.process.pid)] : []), ...(otherUidProcess ? ['999'] : [])] : path === `${proc}/fd` ? [...links.keys()].filter(key => key.startsWith(`${proc}/fd/`)).map(key => key.slice(`${proc}/fd/`.length)) : [...new Set([...nodes.keys()].filter(key => key.startsWith(path + '/') && !key.slice(path.length + 1).includes('/')).map(key => key.slice(path.length + 1)))];
      if (values.length > maximum) throw Error('fixture directory bound'); return values;
    },
    syncDisk(path, expected) { syncs++; if (failSync || host.metadata(path).inode !== expected.inode) throw Error('uncertain sync'); },
  };
  return { selected, host, root, proc, cgroup, nodes, data, links, write, add,
    counters: () => ({ syncs, signals, opens, closes }), exit: () => { alive = false; }, otherProcess: () => { otherUidProcess = true; }, failSync: () => { failSync = true; }, recoverSync: () => { failSync = false; },
    open: (options: { guard?: () => void | Promise<void>; timeoutMs?: number; signal?: AbortSignal } = {}) => FirecrackerHostLease.open(selected, { ...options, guard: options.guard ?? (() => {}), fixture: host }) };
}
