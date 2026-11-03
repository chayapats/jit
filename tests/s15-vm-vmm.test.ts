import { afterEach, describe, expect, test } from 'bun:test';
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join } from 'node:path';
import { QemuVmManagement, qemuArgv, qemuArgvFacts } from '../src/s15/vm/qemu';
import { renderVmmLauncher } from '../src/s15/vm/vmm-launcher';
import { takeInheritedSocket, validateVmm, vmmCommand, vmmHostProbe, vmmLayout, type QemuVmmOptions } from '../src/s15/vm/vmm';
import { assertVmmLayout, startLocalVmControl } from '../src/s15/vm/local-control';
import { probeLocalVmHost } from '../src/s15/vm/local';
import { VmStore } from '../src/s15/vm/store';
import { readS15VmPool } from '../src/s15/main';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import type { VmHostCommand } from '../src/s15/vm/types';
import { FakeQemuHost } from './fixtures/s15-qemu';

const roots: string[] = [], hosts: FakeQemuHost[] = [], closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); for (const h of hosts.splice(0)) h.cleanup(); for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });
/** Short root: the QMP and proxy Unix socket paths must fit `sun_path` (macOS TMPDIR is long). */
const shortRoot = () => { const root = realpathSync(mkdtempSync(join(process.platform === 'darwin' ? '/tmp' : tmpdir(), 'jv-'))); roots.push(root); return root; };
const identity = { name: 'jit-work-0123456789ab', architecture: 'x86_64' as const, mac: '52:54:00:12:34:56', sshPort: 22022, resources: { cpus: 5, memoryMiB: 9216, diskGiB: 60 } };
const sha = 'ab'.repeat(32), tag = `jit-${'cd'.repeat(16)}`;

/**
 * Installer-made shared layout: root not group/world-writable, controller-owned setgid control/ and control/images/,
 * a separate machines/ owner (faked by mode). The group is the test user's own, so macOS keeps the setgid bit too.
 */
function layout(root: string) {
  const directory = join(root, 'vmm'), l = vmmLayout(directory);
  mkdirSync(l.images, { recursive: true }); mkdirSync(l.machines);
  for (const path of [directory, l.control, l.images, l.machines]) chownSync(path, process.getuid!(), process.getgid!());
  chmodSync(directory, 0o750); chmodSync(l.control, 0o2750); chmodSync(l.images, 0o2750); chmodSync(l.machines, 0o2750);
  return { directory, ...l };
}

describe('the argv-fixed launcher', () => {
  function launcher(user = userInfo().username) {
    const root = shortRoot(), l = layout(root), bin = join(root, 'bin'), record = join(root, 'record');
    mkdirSync(bin);
    for (const tool of ['systemctl', 'systemd-run', 'qemu-img']) writeFileSync(join(bin, tool), `#!/bin/sh\nprintf '%s\\0' '${tool}' "$@" >> '${record}'\nprintf 'ok\\n'\n`, { mode: 0o755 });
    const vmm: QemuVmmOptions = { user, uid: 4242, directory: l.directory, launcher: join(root, 'launcher') };
    writeFileSync(vmm.launcher, renderVmmLauncher(vmm, { systemctl: join(bin, 'systemctl'), systemdRun: join(bin, 'systemd-run'), qemuImg: join(bin, 'qemu-img') }), { mode: 0o755 });
    const run = async (args: string[], input?: Uint8Array) => {
      rmSync(record, { force: true });
      const child = Bun.spawn(['sh', vmm.launcher, ...args], { stdin: input ?? 'ignore', stdout: 'pipe', stderr: 'pipe', env: { PATH: '/usr/bin:/bin' } });
      const [stdout, , code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      const recorded = existsSync(record) ? readFileSync(record, 'utf8').split('\0').slice(0, -1) : null;
      return { code, stdout, recorded };
    };
    return { vmm, l, run, root };
  }
  const machine = (l: ReturnType<typeof layout>) => join(l.machines, identity.name);

  test('each operation runs exactly one fixed command for that exact VM', async () => {
    const { l, run } = launcher(), dir = machine(l), disk = join(dir, 'disk.qcow2'), unit = `${identity.name}.service`;
    const cases: [string[], string[]][] = [
      [['show', identity.name], ['systemctl', '--user', 'show', unit, '--property=LoadState', '--property=ActiveState', '--property=MainPID']],
      [['stop', identity.name], ['systemctl', '--user', 'stop', unit]],
      [['kill', identity.name], ['systemctl', '--user', 'kill', '--signal=SIGKILL', unit]],
      [['info', identity.name, 'shared'], ['qemu-img', 'info', '--force-share', '--output=json', disk]],
      [['info', identity.name, 'exclusive'], ['qemu-img', 'info', '--output=json', disk]],
      [['resize', identity.name, '80'], ['qemu-img', 'resize', disk, '80G']],
      [['create', identity.name, sha, '60'], ['qemu-img', 'create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', join(l.images, `${sha}.qcow2`), disk, '60G']],
      [['snapshot', identity.name, 'create', tag], ['qemu-img', 'snapshot', '-c', tag, disk]],
      [['snapshot', identity.name, 'apply', tag], ['qemu-img', 'snapshot', '-a', tag, disk]],
      [['snapshot', identity.name, 'delete', tag], ['qemu-img', 'snapshot', '-d', tag, disk]],
    ];
    for (const [args, expected] of cases) {
      const result = await run(args);
      expect({ args, code: result.code, recorded: result.recorded }).toEqual({ args, code: 0, recorded: expected });
    }
    expect(await run(['check'])).toEqual({ code: 0, stdout: 'jit-vmm-ready-v1\n', recorded: null });
    // `create` prepared the VM's own directory, group-readable and setgid for the shared group.
    expect(lstatSync(dir).isDirectory()).toBe(true); expect(lstatSync(dir).mode & 0o777).toBe(0o750);
  });

  test.each(['x86_64', 'aarch64'] as const)('start builds the restricted QEMU argv byte-for-byte as qemuArgv for %s', async architecture => {
    const { l, run } = launcher(), dir = machine(l);
    mkdirSync(dir); writeFileSync(join(dir, 'qmp.sock'), 'stale');
    const result = await run(['start', identity.name, architecture, '5', '9216', identity.mac, '22022']);
    const spec = { name: identity.name, architecture, machineDirectory: dir, cpus: 5, memoryMiB: 9216, mac: identity.mac, sshPort: 22022, proxySocket: l.proxySocket };
    expect(result.code).toBe(0);
    expect(result.recorded).toEqual(['systemd-run', '--user', '--quiet', '--collect', `--unit=${identity.name}.service`, '--property=Type=exec', '--property=TimeoutStopSec=15', '--property=UMask=0007', '--', ...qemuArgv(spec)]);
    expect(qemuArgvFacts(result.recorded!.slice(9), spec).exact).toBe(true);
    // The stale QMP socket of the previous boot is removed by the QEMU identity itself.
    expect(existsSync(join(dir, 'qmp.sock'))).toBe(false);
  });

  test('seed stores stdin as the VM seed; remove deletes only that VM directory', async () => {
    const { l, run } = launcher(), dir = machine(l), other = join(l.machines, 'jit-work-ffffffffffff');
    mkdirSync(other); writeFileSync(join(other, 'disk.qcow2'), 'other VM');
    expect((await run(['seed', identity.name], new TextEncoder().encode('seed-bytes'))).code).toBe(0);
    expect(readFileSync(join(dir, 'seed.img'), 'utf8')).toBe('seed-bytes');
    expect(readdirSync(dir)).toEqual(['seed.img']);
    expect((await run(['seed', identity.name], new Uint8Array(0))).code).toBe(64);
    expect(readFileSync(join(dir, 'seed.img'), 'utf8')).toBe('seed-bytes');
    expect((await run(['remove', identity.name])).code).toBe(0);
    expect(existsSync(dir)).toBe(false); expect(readFileSync(join(other, 'disk.qcow2'), 'utf8')).toBe('other VM');
  });

  test('every malformed operation, name, value or extra argument is refused before any command runs', async () => {
    const { run } = launcher(), n = identity.name;
    const refused = [[], ['bogus', n], ['show'], ['show', n, 'extra'], ['show', 'jit-work-XYZ'], ['show', '../etc'], ['show', `${n}/..`], ['show', 'jit-work-0123456789abc'],
      ['info', n], ['info', n, 'all'], ['resize', n, '0'], ['resize', n, '012'], ['resize', n, '12345'], ['resize', n, '-1'],
      ['create', n, 'AB'.repeat(32), '60'], ['create', n, sha], ['create', n, `${sha}/../x`, '60'], ['snapshot', n, 'create', 'other'], ['snapshot', n, 'revert', tag],
      ['start', n, 'riscv64', '1', '2048', identity.mac, '22022'], ['start', n, 'x86_64', '0', '2048', identity.mac, '22022'], ['start', n, 'x86_64', '1000', '2048', identity.mac, '22022'],
      ['start', n, 'x86_64', '1', '2048', 'aa:bb:cc:dd:ee:ff', '22022'], ['start', n, 'x86_64', '1', '2048', identity.mac, '80'], ['start', n, 'x86_64', '1', '2048', identity.mac, '70000'],
      ['start', n, 'x86_64', '1', '2048 -device foo', identity.mac, '22022'], ['start', n, 'x86_64', '1', '2048', identity.mac], ['kvm', n], ['check', n], ['remove', n, '/']];
    for (const args of refused) {
      const result = await run(args);
      expect({ args, code: result.code, recorded: result.recorded }).toEqual({ args, code: 64, recorded: null });
    }
    const wrongUser = launcher('jit-not-this-user');
    expect(await wrongUser.run(['show', n])).toMatchObject({ code: 64, recorded: null });
  });

  test('the rendered launcher names only fixed tools, the fixed layout and no environment input', () => {
    const vmm: QemuVmmOptions = { user: 'jit-s15-vmm', uid: 991, directory: '/var/lib/jit-s15-vm', launcher: '/opt/jit-s15/libexec/jit-s15-vmm' };
    const script = renderVmmLauncher(vmm);
    expect(script).toStartWith('#!/bin/sh\n');
    expect(script).toContain("[ \"$(id -un)\" = 'jit-s15-vmm' ] || refuse");
    expect(script).toContain("exec '/usr/bin/systemctl' --user show");
    expect(script).toContain("'/usr/bin/systemd-run' --user --quiet --collect");
    expect(script).toContain("'/usr/bin/qemu-img' create -q -f qcow2 -F qcow2 -b '/var/lib/jit-s15-vm/control/images'");
    expect(script).toContain("-cmd:/usr/bin/nc -U /var/lib/jit-s15-vm/control/proxy.sock'");
    expect(script).not.toMatch(/\$\{?(HOME|USER|SUDO_[A-Z]+|LD_[A-Z]+)\b/);
    expect(script).not.toContain('eval'); expect(script).not.toContain('$@');
  });
});

describe('QEMU as the separate identity', () => {
  function vmmHost(options: { wrongUid?: boolean } = {}) {
    const h = new FakeQemuHost(); hosts.push(h);
    const l = layout(h.root), vmm: QemuVmmOptions = { user: 'jit-test-vmm', uid: 4242, directory: l.directory, launcher: '/opt/jit-s15/libexec/jit-s15-vmm' };
    const prefix = vmmCommand(vmm, []), launched: string[][] = [], direct: string[][] = [];
    const run: VmHostCommand = async (argv, settings) => {
      if (argv[0] !== prefix[0]) {
        if (['systemctl', 'systemd-run', '/usr/bin/qemu-img'].includes(argv[0]!)) direct.push([...argv]);
        return h.run(argv, settings);
      }
      expect(argv.slice(0, prefix.length)).toEqual(prefix);
      const [op, name, ...rest] = argv.slice(prefix.length) as [string, string, ...string[]]; launched.push([op, name, ...rest]);
      const dir = join(l.machines, name), disk = join(dir, 'disk.qcow2'), unit = `${name}.service`;
      if (op === 'show') return h.run(['systemctl', '--user', 'show', unit, '--property=LoadState', '--property=ActiveState', '--property=MainPID'], settings);
      if (op === 'stop') return h.run(['systemctl', '--user', 'stop', unit], settings);
      if (op === 'kill') return h.run(['systemctl', '--user', 'kill', '--signal=SIGKILL', unit], settings);
      if (op === 'info') return h.run(['/usr/bin/qemu-img', 'info', ...(rest[0] === 'shared' ? ['--force-share'] : []), '--output=json', disk], settings);
      if (op === 'resize') return h.run(['/usr/bin/qemu-img', 'resize', disk, `${rest[0]}G`], settings);
      if (op === 'create') { mkdirSync(dir, { recursive: true }); return h.run(['/usr/bin/qemu-img', 'create', '-q', '-f', 'qcow2', '-F', 'qcow2', '-b', join(l.images, `${rest[0]}.qcow2`), disk, `${rest[1]}G`], settings); }
      if (op === 'snapshot') return h.run(['/usr/bin/qemu-img', 'snapshot', rest[0] === 'create' ? '-c' : rest[0] === 'apply' ? '-a' : '-d', rest[1]!, disk], settings);
      if (op === 'seed') { mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, 'seed.img'), settings.input!); return { exitCode: 0, stdout: Buffer.alloc(0) }; }
      if (op === 'remove') { rmSync(dir, { recursive: true, force: true }); return { exitCode: 0, stdout: Buffer.alloc(0) }; }
      if (op === 'start') {
        const spec = { name, architecture: rest[0] as 'x86_64', machineDirectory: dir, cpus: Number(rest[1]), memoryMiB: Number(rest[2]), mac: rest[3]!, sshPort: Number(rest[4]), proxySocket: l.proxySocket };
        return h.run(['systemd-run', '--user', '--quiet', '--collect', `--unit=${unit}`, '--property=Type=exec', '--property=TimeoutStopSec=15', '--property=UMask=0007', '--', ...qemuArgv(spec)], settings);
      }
      return { exitCode: 64, stdout: Buffer.alloc(0) };
    };
    const proc = { ...h.proc, uid: (pid: number) => h.processes.has(pid) ? options.wrongUid ? process.getuid!() : vmm.uid : null };
    const host = { ...h.options(l.proxySocket), run, proc, vmm };
    return { h, l, vmm, host, launched, direct, m: new QemuVmManagement(identity, host) };
  }

  test('every hypervisor-side command carries the fixed sudo prefix; controller-side commands never do', async () => {
    const { h, m, launched, direct, vmm } = vmmHost();
    expect(await m.provision()).toEqual({ docker: false });
    expect(direct).toEqual([]);
    expect([...new Set(launched.map(c => c[0]))].sort()).toEqual(['create', 'info', 'seed', 'show', 'start']);
    expect(launched.find(c => c[0] === 'start')).toEqual(['start', identity.name, 'x86_64', '5', '9216', identity.mac, '22022']);
    expect(launched.find(c => c[0] === 'create')).toEqual(['create', identity.name, h.options().images!.x86_64.sha256, '60']);
    for (const tool of ['ssh-keygen', 'ssh-keyscan', '/usr/bin/cloud-localds', 'ssh']) expect(h.commands.some(c => c[0] === tool)).toBe(true);
    expect(h.commands.filter(c => c[0] === '/usr/bin/sudo').every(c => c.slice(0, 6).join(' ') === `/usr/bin/sudo -n -u ${vmm.user} -- ${vmm.launcher}`)).toBe(true);
    expect(h.commands.some(c => c.includes('sudo') && ['ssh', 'ssh-keygen', 'ssh-keyscan', '/usr/bin/cloud-localds'].includes(c[0]!))).toBe(false);
  });

  test('keys and state stay controller-private; the QEMU identity directory holds only the overlay and seed', async () => {
    const { h, l, m } = vmmHost();
    await m.provision();
    const own = m.machineDirectory, hyper = m.hypervisorDirectory;
    expect(hyper).toBe(join(l.machines, identity.name)); expect(own).toBe(join(h.directory, 'machines', identity.name));
    expect(readdirSync(own).sort()).toEqual(['client', 'client.pub', 'hostkey.pub', 'known_hosts', 'state.json']);
    expect(lstatSync(own).mode & 0o777).toBe(0o700);
    for (const name of ['client', 'known_hosts', 'state.json']) expect(lstatSync(join(own, name)).mode & 0o077).toBe(0);
    expect(readdirSync(hyper).sort()).toEqual(['disk.qcow2', 'seed.img']);
    // The verified base is controller-owned and group-readable for the QEMU identity only; nobody else can write it.
    const base = join(l.images, `${h.options().images!.x86_64.sha256}.qcow2`);
    expect(lstatSync(base).mode & 0o777).toBe(0o440); expect(lstatSync(l.images).mode & 0o7777).toBe(0o2750);
    expect(lstatSync(base).gid).toBe(lstatSync(l.images).gid);
    expect(existsSync(join(h.directory, 'images'))).toBe(false);
    const launch = h.launches[0]!, joined = launch.join(' ');
    expect(joined).toContain(`file=${join(hyper, 'disk.qcow2')},`); expect(joined).toContain(`-cmd:/usr/bin/nc -U ${l.proxySocket}`);
    expect(joined).not.toContain(own);
  });

  test('stop proof, live and offline snapshots, restore, retire and re-attach after a controller restart behave as before', async () => {
    const { m, host, launched } = vmmHost();
    await m.provision();
    expect(await m.inspect()).toMatchObject({ state: 'running', network: 'proxy-only', cpuCount: 5 });
    await m.snapshot(tag); expect(await m.snapshots()).toEqual([tag]);
    // A new controller process re-attaches to the surviving VM and re-verifies it.
    const again = new QemuVmManagement(identity, host);
    expect(await again.inspect()).toMatchObject({ state: 'running', network: 'proxy-only' });
    await again.stop(); expect(await again.inspect()).toMatchObject({ state: 'stopped' });
    const offline = `jit-${'ef'.repeat(16)}`;
    await again.snapshot(offline); expect((await again.snapshots()).sort()).toEqual([tag, offline].sort());
    await again.restore(tag); expect(await again.inspect()).toMatchObject({ state: 'stopped' });
    await again.retireSnapshot(offline); expect(await again.snapshots()).toEqual([tag]);
    expect(await again.resume()).toBe(false);
    await again.start(); expect(await again.inspect()).toMatchObject({ state: 'running' });
    expect(launched.filter(c => c[0] === 'snapshot').map(c => c[2])).toEqual(['create', 'apply', 'delete']);
  });

  test('a QEMU process that is not owned by the separate identity is never this VM', async () => {
    const { m } = vmmHost({ wrongUid: true });
    await expect(m.provision()).rejects.toMatchObject({ code: 'vm_management_unavailable' });
  });

  test('a proxy socket outside the shared layout is refused at construction', () => {
    const { host } = vmmHost();
    expect(() => new QemuVmManagement(identity, { ...host, proxySocket: '/tmp/other.sock' })).toThrow('vm_invalid_setup');
    expect(() => new QemuVmManagement(identity, { ...host, vmm: { ...host.vmm, user: 'Root;' } })).toThrow('vm_invalid_setup');
  });
});

describe('shared layout, proxy socket and host probe', () => {
  test('the registry proxy socket is group-connectable in the controller-owned control directory', async () => {
    const root = shortRoot(), l = layout(root), store = new VmStore(join(root, 'vm.sqlite')); closers.push(() => store.close());
    const vmm: QemuVmmOptions = { user: 'jit-test-vmm', uid: 4242, directory: l.directory, launcher: '/opt/jit-s15/libexec/jit-s15-vmm' };
    const spawned: string[][] = [];
    const probe = vmmHostProbe(vmm, { arch: () => 'x64', platform: () => 'linux', exists: () => true, kvm: () => true, executable: () => true, readable: () => true, cpus: () => 10, memoryBytes: () => 20 * 1_073_741_824, disk: () => ({ total: 200 * 1_073_741_824, free: 150 * 1_073_741_824 }) }, argv => { spawned.push(argv); return 1; });
    expect(() => assertVmmLayout(vmm)).not.toThrow();
    const control = await startLocalVmControl(store, { directory: join(root, 'local'), vmm, probe });
    closers.push(() => control.close());
    expect(control.host.proxySocket).toBe(l.proxySocket);
    expect(lstatSync(l.proxySocket).isSocket()).toBe(true); expect(lstatSync(l.proxySocket).mode & 0o777).toBe(0o660);
    // Readiness reports this identity's denied /dev/kvm through the launcher, never the controller's own access.
    expect(probeLocalVmHost(join(root, 'local'), control.host.probe)).toMatchObject({ state: 'missing', code: 'vm_kvm_denied' });
    expect(spawned).toEqual([vmmCommand(vmm, ['kvm'])]);
  });

  test('layout checks refuse writable, foreign or linked parents and malformed identities', () => {
    const root = shortRoot(), l = layout(root), vmm: QemuVmmOptions = { user: 'jit-test-vmm', uid: 4242, directory: l.directory, launcher: '/opt/x/launcher' };
    chmodSync(l.directory, 0o770); expect(() => assertVmmLayout(vmm)).toThrow('vm_key_directory_unsafe'); chmodSync(l.directory, 0o750);
    chmodSync(l.control, 0o2770); expect(() => assertVmmLayout(vmm)).toThrow('vm_key_directory_unsafe'); chmodSync(l.control, 0o2750);
    // Without setgid, new images and a path-bound socket would not carry the shared group; the unit cannot repair it.
    chmodSync(l.images, 0o750); expect(() => assertVmmLayout(vmm)).toThrow('vm_key_directory_unsafe'); chmodSync(l.images, 0o2750);
    rmSync(l.control, { recursive: true }); symlinkSync(root, l.control); expect(() => assertVmmLayout(vmm)).toThrow('vm_key_directory_unsafe');
    for (const bad of [{ ...vmm, user: 'Root' }, { ...vmm, uid: 0 }, { ...vmm, directory: 'relative' }, { ...vmm, directory: `/${'a'.repeat(70)}` }, { ...vmm, launcher: '/x/../y' }, { ...vmm, extra: true }])
      expect(() => validateVmm(bad as QemuVmmOptions)).toThrow('vm_invalid_setup');
  });

  test('the runtime config accepts the separate identity only with a Jit-managed local VM', () => {
    const vm = s15StageConfig('/protected/installation', 'http://localhost:3041').vm;
    const vmm: QemuVmmOptions = { user: 'jit-s15-vmm', uid: 991, directory: '/var/lib/jit-s15-vm', launcher: '/opt/jit-s15/libexec/jit-s15-vmm' };
    expect(readS15VmPool({ ...vm, local: true, vmm })).toEqual({ poolId: 'working', defaultMemberId: 'working', local: true });
    expect(() => readS15VmPool({ ...vm, vmm })).toThrow('invalid_s15_config');
    expect(() => readS15VmPool({ ...vm, local: true, vmm: { ...vmm, uid: -1 } })).toThrow('invalid_s15_config');
  });
});

describe('the registry proxy socket from systemd socket activation', () => {
  test('only this process takes its named socket, and the activation variables never reach children', () => {
    const env = (pid: string, names = 'other:jit-s15-vm-proxy') => ({ LISTEN_PID: pid, LISTEN_FDS: '2', LISTEN_FDNAMES: names } as NodeJS.ProcessEnv);
    const sockets = new Set([3, 4]);
    let e = env('4321'); expect(takeInheritedSocket('jit-s15-vm-proxy', e, 4321, fd => sockets.has(fd))).toBe(4);
    expect(e).toEqual({});
    expect(takeInheritedSocket('jit-s15-vm-proxy', env('4322'), 4321, fd => sockets.has(fd))).toBeNull();
    expect(takeInheritedSocket('jit-s15-vm-proxy', env('4321', 'other'), 4321, fd => sockets.has(fd))).toBeNull();
    expect(takeInheritedSocket('jit-s15-vm-proxy', env('4321'), 4321, () => false)).toBeNull();
    expect(takeInheritedSocket('jit-s15-vm-proxy', {}, 4321, () => true)).toBeNull();
  });

  test('the proxy serves an inherited listening socket without unlinking or re-binding its path', async () => {
    // A non-accepting binder (as systemd is) listens, then execs the Bun child with the socket as fd 3.
    const root = shortRoot(), path = join(root, 'proxy.sock'), child = join(import.meta.dir, 'fixtures/s15-proxy-fd-child.ts');
    const binder = 'import os,socket,sys\ns=socket.socket(socket.AF_UNIX,socket.SOCK_STREAM)\ns.bind(sys.argv[1]);s.listen(16)\nos.dup2(s.fileno(),3);os.set_inheritable(3,True)\nos.execv(sys.argv[2],[sys.argv[2],sys.argv[3],sys.argv[1]])\n';
    const proc = Bun.spawn(['python3', '-I', '-c', binder, path, process.execPath, child], { stdout: 'pipe', stderr: 'pipe' });
    closers.push(() => { proc.kill(); });
    const reader = proc.stdout.getReader(); const { value } = await reader.read(); expect(new TextDecoder().decode(value)).toContain('ready');
    const { connect } = await import('node:net');
    const reply = await new Promise<string>((done, fail) => {
      const socket = connect(path, () => socket.write('CONNECT registry.npmjs.org:443 HTTP/1.1\r\nHost: registry.npmjs.org:443\r\n\r\n'));
      let text = ''; socket.on('data', chunk => { text += chunk; socket.end(); }); socket.on('close', () => done(text)); socket.on('error', fail);
    });
    // The proxy itself answered (no lease: refused), on the very socket the binder created.
    expect(reply).toMatch(/^HTTP\/1\.1 4\d\d /);
    expect(lstatSync(path).isSocket()).toBe(true);
  });
});
