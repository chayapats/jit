import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { firecrackerLaunchPlan, firecrackerRuntimeArgvMatches, type FirecrackerLaunchHost } from '../src/s15/vm/firecracker/launch';
import { FirecrackerProfile, type FirecrackerProfileSelection } from '../src/s15/vm/firecracker/profile';

const profile = (): FirecrackerProfileSelection => ({ instanceId: 'jit-work-fixture', cpuCount: 2, memoryMiB: 512, guestCid: 3, kernelPath: '/kernel', rootDrivePath: '/rootfs.ext4', vsockPath: '/run/vsock.sock', bootArgs: 'console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw' });
const host = (): FirecrackerLaunchHost => ({ jailerPath: '/usr/local/libexec/jit/jailer', firecrackerPath: '/usr/local/libexec/jit/firecracker', jailerBase: '/srv/jit', uid: 2001, gid: 2002, controllerUid: 1000, controllerGid: 1000, diskBytes: 1073741824 });
const runtime = () => ['/firecracker', '--id', 'jit-work-fixture', '--start-time-us', '12345', '--start-time-cpu-us', '8', '--parent-cpu-time-us', '7', '--api-sock', '/run/api.sock', '--config-file', '/config.json'];

test('one closed launch contains finite jailer resources and represents an autostart mutation', () => {
  const plan = firecrackerLaunchPlan(profile(), host());
  expect(plan.operation).toBe('launch_and_start'); expect(plan.rootDirectory).toBe('/srv/jit/firecracker/jit-work-fixture/root'); expect(plan.apiSocket).toBe(`${plan.rootDirectory}/run/api.sock`); expect(plan.vsockSocket).toBe(`${plan.rootDirectory}/run/vsock.sock`);
  expect(plan.argv).toEqual(['/usr/local/libexec/jit/jailer', '--id', 'jit-work-fixture', '--exec-file', '/usr/local/libexec/jit/firecracker', '--uid', '2001', '--gid', '2002', '--chroot-base-dir', '/srv/jit', '--cgroup-version', '2', '--parent-cgroup', 'jit/firecracker', '--cgroup', 'memory.max=805306368', '--cgroup', 'memory.swap.max=0', '--cgroup', 'pids.max=128', '--cgroup', 'cpu.max=200000 100000', '--resource-limit', 'no-file=256', '--resource-limit', 'fsize=1073741824', '--', '--api-sock', '/run/api.sock', '--config-file', '/config.json']);
  expect(plan.configurationSha256).toBe(createHash('sha256').update(plan.configuration).digest('hex'));
  expect(Object.isFrozen(plan)).toBe(true);
  for (const absent of ['--no-seccomp', '--daemonize', '--new-pid-ns', '--netns', '--enable-pci', '--http-api-max-payload-size', 'InstanceStart']) expect(plan.argv).not.toContain(absent);
});

test('the generated bounded configuration passes the actual selected API profile validator', async () => {
  for (const initrd of [false, true]) {
    const selected = { ...profile(), ...(initrd ? { initrdPath: '/initrd' } : {}) }, plan = firecrackerLaunchPlan(selected, host()); const calls: string[] = [];
    const facts = await new FirecrackerProfile(selected).inspect({ async call(operation) { calls.push(operation); return operation === 'instance' ? { id: selected.instanceId, app_name: 'Firecracker', vmm_version: '1.18.0', state: 'Running' } : operation === 'version' ? { firecracker_version: '1.18.0' } : JSON.parse(plan.configuration); } });
    expect(facts).toMatchObject({ state: 'Running', cpuCount: 2, networkInterfaces: 0, rootDrives: 1, basis: 'api_reported' }); expect(calls).toEqual(['instance', 'version', 'configuration', 'instance']);
    const config = JSON.parse(plan.configuration); expect(Object.keys(config).sort()).toEqual(['boot-source', 'drives', 'machine-config', 'network-interfaces', 'vsock']); expect(config['boot-source'].initrd_path).toBe(initrd ? '/initrd' : undefined);
  }
});

test('changing trusted configuration later cannot repoint or append to the selected argv/bytes', () => {
  const selected = profile(), machine = host(), plan = firecrackerLaunchPlan(selected, machine), original = plan.configurationSha256;
  selected.instanceId = 'jit-work-other'; selected.bootArgs = 'bad'; machine.uid = 0; machine.jailerPath = '/tmp/jailer';
  expect(plan.argv[2]).toBe('jit-work-fixture'); expect(plan.argv[0]).toBe('/usr/local/libexec/jit/jailer'); expect(plan.argv[6]).toBe('2001'); expect(plan.configurationSha256).toBe(original); expect(Object.isFrozen(plan.argv)).toBe(true);
});

test('unknown host fields, shared/root identity, escaped paths and excessive resources refuse', () => {
  for (const patch of [{ uid: 0 }, { gid: 0 }, { uid: 1000 }, { gid: 1000 }, { controllerUid: 0 }, { controllerGid: 0 }, { uid: 1.5 }, { jailerPath: '/tmp/jailer/' }, { jailerPath: 'jailer' }, { jailerPath: '/tmp/../jailer' }, { firecrackerPath: '/tmp/not-firecracker' }, { jailerBase: '/tmp/a b' }, { jailerBase: '/x/' + 'a'.repeat(62) }, { diskBytes: 1 }, { diskBytes: 65 * 1073741824 }, { extra: true }]) expect(() => firecrackerLaunchPlan(profile(), { ...host(), ...patch })).toThrow('vm_firecracker_launch_invalid');
});

test('unreviewed jailed resources and Unix paths exceeding the real socket ceiling refuse', () => {
  for (const patch of [{ kernelPath: '/other' }, { rootDrivePath: '/host-state' }, { vsockPath: '/run/other.sock' }, { initrdPath: '/other-initrd' }]) expect(() => firecrackerLaunchPlan({ ...profile(), ...patch }, host())).toThrow('vm_firecracker_launch_invalid');
  expect(() => firecrackerLaunchPlan({ ...profile(), instanceId: 'jit-work-' + 'a'.repeat(54) }, host())).toThrow('vm_firecracker_launch_invalid');
});

test('the runtime argv accepts only the exact foreground jailer identity and bounded timing fields', () => {
  expect(firecrackerRuntimeArgvMatches(runtime(), 'jit-work-fixture')).toBe(true);
  const altered = [runtime().concat('--no-seccomp'), runtime().slice(0, -1), runtime().map((value, index) => index === 2 ? 'jit-work-other' : value), runtime().map((value, index) => index === 4 ? 'x' : value), runtime().map((value, index) => index === 6 ? '1'.repeat(21) : value), runtime().map((value, index) => index === 10 ? '/other-api.sock' : value), runtime().map((value, index) => index === 12 ? '/other.json' : value), runtime().map((value, index) => index === 7 ? '--no-seccomp' : value), runtime().map((value, index) => index === 0 ? '/tmp/firecracker' : value)];
  for (const argv of altered) expect(firecrackerRuntimeArgvMatches(argv, 'jit-work-fixture')).toBe(false);
  expect(firecrackerRuntimeArgvMatches(runtime(), 'owner-vm')).toBe(false);
});
