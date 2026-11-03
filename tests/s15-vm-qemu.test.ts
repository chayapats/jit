import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { QemuVmManagement, qemuArgv, qemuArgvFacts, type QemuMachineSpec } from '../src/s15/vm/qemu';
import { defaultLocalVmResources, localVmDiskReserve, localVmImages, validateLocalVmResources, detectLocalVmHost } from '../src/s15/vm/local';
import { startVmRegistryProxy } from '../src/s15/vm/proxy';
import { VmStore } from '../src/s15/vm/store';
import { VmEnrollment } from '../src/s15/vm/enrollment';
import { VmManagers } from '../src/s15/vm/managers';
import { WorkingVmService } from '../src/s15/vm/service';
import { VmSshTransport } from '../src/s15/vm/transport';
import { ConnectionVault } from '../src/exec/connections';
import type { VmPolicyPort } from '../src/s15/vm/types';
import { FakeQemuHost } from './fixtures/s15-qemu';

const GiB = 1_073_741_824, MiB = 1_048_576;
const hosts: FakeQemuHost[] = [], stores: VmStore[] = [], closers: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const c of closers.splice(0)) await c(); for (const s of stores.splice(0)) s.close(); for (const h of hosts.splice(0)) h.cleanup(); });
const identity = { name: 'jit-work-0123456789ab', architecture: 'x86_64' as const, mac: '52:54:00:12:34:56', sshPort: 22022, resources: { cpus: 5, memoryMiB: 9216, diskGiB: 60 } };
function host() { const h = new FakeQemuHost(); hosts.push(h); return h; }
function manager(h = host(), id = identity) { return { h, m: new QemuVmManagement(id, h.options()) }; }
const spec = (h: FakeQemuHost): QemuMachineSpec => ({ name: identity.name, architecture: 'x86_64', machineDirectory: join(h.directory, 'machines', identity.name), cpus: 5, memoryMiB: 9216, mac: identity.mac, sshPort: 22022, proxySocket: join(h.directory, 'proxy.sock') });
const allow: VmPolicyPort = { assertCurrent() {}, async claim() { return { async dispatch(start) { return start(); }, publish(consume) { return consume(); }, observe() {} }; } };

describe('restricted QEMU command line', () => {
  test('one NIC on restricted user networking, IPv6 off, one loopback SSH forward, one proxy guest-forward, no shares', () => {
    const h = host(), argv = qemuArgv(spec(h)), joined = argv.join(' ');
    expect(argv[0]).toBe('/usr/bin/qemu-system-x86_64');
    expect(argv.filter(a => a === '-netdev')).toHaveLength(1);
    const netdev = argv[argv.indexOf('-netdev') + 1]!;
    expect(netdev).toStartWith('user,id=net0,restrict=on,ipv6=off,net=192.168.5.0/24,host=192.168.5.2,');
    expect(netdev.match(/hostfwd=/g)).toHaveLength(1); expect(netdev).toContain('hostfwd=tcp:127.0.0.1:22022-:22');
    expect(netdev.match(/guestfwd=/g)).toHaveLength(1); expect(netdev).toEndWith(`guestfwd=tcp:192.168.5.100:3128-cmd:/usr/bin/nc -U ${join(h.directory, 'proxy.sock')}`);
    expect(argv.filter(a => a.startsWith('virtio-net-pci'))).toEqual(['virtio-net-pci,netdev=net0,mac=52:54:00:12:34:56']);
    for (const flag of ['-virtfs', '-fsdev', '-nic', '-net', '-usb', '-device vhost-vsock-pci']) expect(argv).not.toContain(flag);
    for (const banned of ['smb=', 'tftp=', 'vsock', 'virtio-serial', 'virtio-9p', 'vhost-user-fs', 'guest-agent', 'monitor stdio']) expect(joined).not.toContain(banned);
    expect(argv).toContain('-nodefaults'); expect(argv).toContain('-no-user-config'); expect(joined).toContain('readonly=on');
    expect(qemuArgvFacts(argv, spec(h))).toEqual({ exact: true, cpus: 5, memoryMiB: 9216, mac: '52:54:00:12:34:56', sshPort: 22022 });
    expect(qemuArgv({ ...spec(h), architecture: 'aarch64' }).join(' ')).toContain('-machine virt,accel=kvm,gic-version=host -bios /usr/share/qemu-efi-aarch64/QEMU_EFI.fd');
  });
  test.each([
    ['an SMB share', (a: string[]) => a.map(x => x.startsWith('user,') ? x + ',smb=/home' : x)],
    ['a second netdev', (a: string[]) => [...a, '-netdev', 'user,id=net1']],
    ['a host directory share', (a: string[]) => [...a, '-virtfs', 'local,path=/,mount_tag=host']],
    ['a second host-forward', (a: string[]) => a.map(x => x.startsWith('user,') ? x.replace('hostfwd=', 'hostfwd=tcp:0.0.0.0:2222-:22,hostfwd=') : x)],
    ['a vsock management channel', (a: string[]) => [...a, '-device', 'vhost-vsock-pci,guest-cid=3']],
    ['TFTP', (a: string[]) => a.map(x => x.startsWith('user,') ? x + ',tftp=/srv' : x)],
    ['IPv6 enabled', (a: string[]) => a.map(x => x.replace('ipv6=off', 'ipv6=on'))],
  ])('%s is refused as proxy-only evidence', (_name, change) => {
    const h = host(); expect(qemuArgvFacts(change(qemuArgv(spec(h))), spec(h)).exact).toBe(false);
  });
});

describe('verified image, keys and pinned host key', () => {
  test('a matching pinned hash creates a read-only base and a per-VM overlay; seed has keys only, no password or root login', async () => {
    const { h, m } = manager(), result = await m.provision();
    expect(result).toEqual({ docker: false });
    const base = join(h.directory, 'images', `${h.options().images!.x86_64.sha256}.qcow2`);
    expect(statSync(base).mode & 0o777).toBe(0o400);
    expect(h.commands.some(c => c[1] === 'create' && c.includes('-b') && c.includes(base))).toBe(true);
    const machine = join(h.directory, 'machines', identity.name);
    const known = readFileSync(join(machine, 'known_hosts'), 'utf8'), hostPub = readFileSync(join(machine, 'hostkey.pub'), 'utf8').trim().split(' ').slice(0, 2).join(' ');
    expect(known).toBe(`[127.0.0.1]:22022 ${hostPub}\n`); expect(existsSync(join(machine, 'hostkey'))).toBe(false); expect(existsSync(join(machine, 'seed'))).toBe(false);
    const seed = h.seeds[0]!;
    expect(seed).toContain('"ssh_pwauth":false'); expect(seed).toContain('"disable_root":true'); expect(seed).toContain('"lock_passwd":true');
    expect(seed).toContain('"restrict ssh-ed25519 '); expect(seed).toContain('PermitRootLogin no'); expect(seed).toContain('"ssh_genkeytypes":[]');
    expect(seed).toContain(hostPub); expect(seed).not.toMatch(/passwd"\s*:\s*"/); expect(seed).not.toContain('qemu-guest-agent');
    expect(seed).toContain('"use-dns":false'); expect(seed).toContain('"optional":true'); expect(seed).toContain('Pipeline-Depth');
    expect(h.launches).toHaveLength(1); expect(qemuArgvFacts(h.launches[0]!, spec(h)).exact).toBe(true);
    expect(h.commands.some(c => c[0] === 'ssh-keyscan')).toBe(true);
  });
  test('an image hash mismatch refuses provisioning with vm_image_unverified and starts nothing', async () => {
    const { h, m } = manager(); h.imageBytes = Buffer.from('tampered');
    await expect(m.provision()).rejects.toMatchObject({ code: 'vm_image_unverified' });
    expect(h.launches).toHaveLength(0); expect(h.commands.some(c => c[1] === 'create')).toBe(false);
    expect(existsSync(join(h.directory, 'images', `${h.options().images!.x86_64.sha256}.qcow2`))).toBe(false);
  });
  test('the production image pins are dated immutable HTTPS releases with SHA-256 for both architectures', () => {
    for (const image of Object.values(localVmImages)) { expect(image.url).toMatch(/^https:\/\/cloud-images\.ubuntu\.com\/releases\/resolute\/release-20261016\//); expect(image.sha256).toMatch(/^[a-f0-9]{64}$/); }
    expect(localVmImages.x86_64.url).toEndWith('-amd64.img');
  });
  test('a changed guest host key fails closed with vm_host_key_changed', async () => {
    const { h, m } = manager(); h.keyscanOverride = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherGuestHostKeyThatIsNotThePinnedOne0000000';
    await expect(m.provision()).rejects.toMatchObject({ code: 'vm_host_key_changed' });
    // The guest this failed attempt started is stopped again: nothing unregistered keeps consuming the host.
    expect([...h.units.values()].every(unit => !unit.active)).toBe(true);
    expect((await m.inspect()).state).toBe('stopped');
  });
  test('a failed provisioning whose guest cannot be stopped surfaces vm_stop_unconfirmed instead of hiding it', async () => {
    const { h, m } = manager(); h.keyscanOverride = 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIOtherGuestHostKeyThatIsNotThePinnedOne0000000'; h.stuck = true;
    await expect(m.provision()).rejects.toMatchObject({ code: 'vm_stop_unconfirmed' });
  });
  test('Docker installs through one bounded provisioning proxy lease that is closed afterwards', async () => {
    const { h, m } = manager(); let closed = 0;
    const result = await m.provision({ lease: (sessionId, expiresAt) => { expect(sessionId).toMatch(/^provision_[a-f0-9]{32}$/); expect(expiresAt).toBeGreaterThan(Date.now()); return { environment: { HTTPS_PROXY: `http://${sessionId}:secret@192.168.5.100:3128` }, close() { closed++; } }; } });
    expect(result.docker).toBe(true); expect(closed).toBe(1);
    expect(h.guestCommands.find(c => c.includes('docker.io'))).not.toContain('secret');
  });
});

describe('controller-side inspection and settlement', () => {
  test('inspect reads hypervisor facts from /proc and QMP: restricted argv is proxy-only; a changed argv is unproven; a dead PID is stopped', async () => {
    const { h, m } = manager(); await m.provision();
    const running = await m.inspect();
    expect(running).toMatchObject({ state: 'running', identity: `qemu:${identity.name}`, network: 'proxy-only', nicMac: identity.mac, sshEndpoint: { host: '127.0.0.1', port: 22022 }, cpuCount: 5, memoryBytes: 9216 * MiB, diskBytes: 60 * GiB });
    const pid = [...h.units.values()][0]!.pid, original = h.processes.get(pid)!.argv;
    h.processes.get(pid)!.argv = [...original, '-virtfs', 'local,path=/,mount_tag=host'];
    expect((await m.inspect()).network).toBe('unproven');
    h.processes.get(pid)!.argv = original.map(a => a.startsWith('user,') ? a + ',smb=/srv' : a);
    expect((await m.inspect()).network).toBe('unproven');
    h.processes.get(pid)!.argv = original;
    h.units.delete(`${identity.name}.service`); h.processes.delete(pid);
    expect(await m.inspect()).toMatchObject({ state: 'stopped', boot: 'stopped', network: 'unproven' });
  });
  test('a foreign process behind the unit is a boundary failure, never a running working VM', async () => {
    const { h, m } = manager(); await m.provision();
    const pid = [...h.units.values()][0]!.pid; h.processes.get(pid)!.argv = ['/usr/bin/python3', '-c', 'pass'];
    await expect(m.inspect()).rejects.toMatchObject({ code: 'vm_boundary_unproven' });
  });
  test('stop is proven by unit inactivity, PID absence and a released image lock; a live PID is vm_stop_unconfirmed', async () => {
    const { h, m } = manager(); await m.provision();
    await m.stop(); expect((await m.inspect()).state).toBe('stopped'); expect(h.qmpLog.at(-1)?.execute).toBe('quit');
    await m.start(); h.stuck = true;
    await expect(m.stop()).rejects.toMatchObject({ code: 'vm_stop_unconfirmed' });
    expect(h.commands.some(c => c[2] === 'stop')).toBe(true); expect(h.commands.some(c => c[2] === 'kill')).toBe(true);
  });
  test('snapshot, restore and retire act only on exact protected tags; restore leaves the VM stopped', async () => {
    const { h, m } = manager(); await m.provision();
    const tag = 'jit-' + 'a'.repeat(32);
    for (const bad of ['jit-A', '../x', 'jit-' + 'a'.repeat(31), 'base']) {
      await expect(m.snapshot(bad)).rejects.toMatchObject({ code: 'vm_invalid_setup' });
      await expect(m.restore(bad)).rejects.toMatchObject({ code: 'vm_invalid_setup' });
      await expect(m.retireSnapshot(bad)).rejects.toMatchObject({ code: 'vm_invalid_setup' });
    }
    const flushes = h.guestCommands.length; await m.snapshot(tag);
    expect(h.guestCommands.slice(flushes)).toEqual(["'sudo' '-n' 'sync'"]);
    expect(h.qmpLog.find(c => c.execute === 'blockdev-snapshot-internal-sync')).toEqual({ execute: 'blockdev-snapshot-internal-sync', arguments: { device: 'disk0', name: tag } });
    expect((await m.inspect()).state).toBe('running');
    await expect(m.restore('jit-' + 'b'.repeat(32))).rejects.toMatchObject({ code: 'vm_snapshot_unknown' });
    await m.restore(tag); expect((await m.inspect()).state).toBe('stopped');
    expect(h.commands.some(c => c[1] === 'snapshot' && c[2] === '-a' && c[3] === tag)).toBe(true);
    expect(await m.resume()).toBe(false); expect((await m.inspect()).state).toBe('stopped');
    await m.retireSnapshot(tag); expect(await m.snapshots()).toEqual([]);
  });
  test('start waits until the booted guest admits a pinned-key login (pam_nologin), never reporting an unusable VM as started', async () => {
    const { h, m } = manager(); await m.provision(); await m.stop();
    h.bootingLogins = 4; const before = h.guestCommands.length; await m.start();
    expect(h.guestCommands.slice(before)).toEqual(["'true'"]); expect(h.time).toBeGreaterThanOrEqual(4 * 3000);
  });
  test('a protected state directory too long for Unix socket paths is refused up front', () => {
    const h = host();
    expect(() => new QemuVmManagement(identity, { ...h.options(), directory: '/' + 'd'.repeat(70) })).toThrow('vm_state_path_too_long');
  });
  test('resource edits apply at the next start; disks grow before boot', async () => {
    const { h, m } = manager(); await m.provision(); await m.stop();
    m.resources = { cpus: 3, memoryMiB: 4096, diskGiB: 80 }; await m.start();
    const argv = h.launches.at(-1)!; expect(argv[argv.indexOf('-smp') + 1]).toBe('3'); expect(argv[argv.indexOf('-m') + 1]).toBe('4096M');
    expect((await m.inspect()).diskBytes).toBe(80 * GiB);
  });
});

describe('default sizing', () => {
  test('half the CPUs and ~45% RAM, keeping 2 vCPU / 6 GiB for the controller and Chromium', () => {
    const disk = { diskTotalBytes: 200 * GiB, diskFreeBytes: 150 * GiB };
    expect(defaultLocalVmResources({ cpus: 10, memoryBytes: 20 * GiB, ...disk })).toEqual({ cpus: 5, memoryMiB: 9216, diskGiB: 60 });
    // jit-vm reports MemTotal 19949512 kB.
    expect(defaultLocalVmResources({ cpus: 10, memoryBytes: 19949512 * 1024, ...disk })).toEqual({ cpus: 5, memoryMiB: 9216, diskGiB: 60 });
    expect(defaultLocalVmResources({ cpus: 4, memoryBytes: 8 * GiB, ...disk })).toEqual({ cpus: 2, memoryMiB: 2048, diskGiB: 60 });
    for (const small of [{ cpus: 2, memoryBytes: 16 * GiB }, { cpus: 8, memoryBytes: 7 * GiB }]) expect(() => defaultLocalVmResources({ ...small, ...disk })).toThrow('vm_host_too_small');
    expect(() => defaultLocalVmResources({ cpus: 10, memoryBytes: 20 * GiB, diskTotalBytes: 200 * GiB, diskFreeBytes: 62 * GiB })).toThrow('vm_disk_insufficient');
    expect(localVmDiskReserve(200 * GiB)).toBe(4 * GiB); expect(localVmDiskReserve(10 * GiB)).toBe(GiB); expect(localVmDiskReserve(2000 * GiB)).toBe(16 * GiB);
  });
  test('owner edits stay within the host, never shrink the disk and need free space for growth', () => {
    const h = { cpus: 10, memoryBytes: 20 * GiB, diskTotalBytes: 200 * GiB, diskFreeBytes: 100 * GiB }, current = { cpus: 5, memoryMiB: 9216, diskGiB: 60 };
    expect(validateLocalVmResources(h, { cpus: 8, memoryMiB: 12288, diskGiB: 100 }, current)).toEqual({ cpus: 8, memoryMiB: 12288, diskGiB: 100 });
    for (const bad of [{ cpus: 11, memoryMiB: 9216, diskGiB: 60 }, { cpus: 5, memoryMiB: 19456, diskGiB: 60 }, { cpus: 5, memoryMiB: 9000, diskGiB: 60 }, { cpus: 5, memoryMiB: 9216, diskGiB: 40 }, { cpus: 5, memoryMiB: 9216, diskGiB: 60, extra: 1 }]) expect(() => validateLocalVmResources(h, bad, current)).toThrow();
    expect(() => validateLocalVmResources(h, { cpus: 5, memoryMiB: 9216, diskGiB: 200 }, current)).toThrow('vm_disk_insufficient');
    // Pending edits cannot be stacked: growth is measured from the disk size actually applied (60 GiB here).
    const pending = { cpus: 5, memoryMiB: 9216, diskGiB: 150 };
    expect(validateLocalVmResources(h, { cpus: 5, memoryMiB: 9216, diskGiB: 156 }, pending, 60)).toEqual({ cpus: 5, memoryMiB: 9216, diskGiB: 156 });
    expect(() => validateLocalVmResources(h, { cpus: 5, memoryMiB: 9216, diskGiB: 157 }, pending, 60)).toThrow('vm_disk_insufficient');
  });
  test('without KVM the host is reported unsupported so setup can fall back to owner-supplied enrollment', () => {
    const h = host(); h.facts.kvm = false; expect(detectLocalVmHost(h.root, h.probe).kvm).toBe(false);
  });
});

describe('managers, local enrollment and re-attachment', () => {
  async function stack(h = host(), store = new VmStore(':memory:')) {
    stores.push(store); const owner = {}, requireOwner = (a: object) => { if (a !== owner) throw new Error('owner'); };
    const vault = new ConnectionVault(join(h.root, 'vault'), { forbidden: [h.directory] });
    const managers = new VmManagers({ store, vault, requireOwner, local: { ...h.options(), port: () => 22022 } });
    const enrollment = new VmEnrollment({ store, keyDirectory: join(h.root, 'keys'), requireOwner, managers, run: h.run, now: () => 1 });
    const service = new WorkingVmService({ store, policy: allow, managers, requireOwner, transport: row => new VmSshTransport(row.endpoint, h.run) });
    return { h, store, owner, managers, enrollment, service };
  }
  test('the qemu manager persists no secret, enrolls without a pasted bootstrap and reports honest capability rows', async () => {
    const s = await stack(), { managerId } = s.managers.register(s.owner, { kind: 'qemu' });
    const row = s.store.db.query<{ data: string }, [string]>('SELECT data FROM vm_managers WHERE id=?').get(managerId)!.data;
    expect(JSON.parse(row)).toMatchObject({ kind: 'qemu', architecture: 'x86_64', sshPort: 22022, resources: { cpus: 5, memoryMiB: 9216, diskGiB: 60 } });
    expect(row).not.toMatch(/PRIVATE|ssh-ed25519|password|token/i);
    expect(() => s.managers.register(s.owner, { kind: 'qemu' })).toThrow('vm_already_enrolled');
    const status = await s.enrollment.enrollLocal(s.owner, { id: 'local', managerId });
    expect(status).toMatchObject({ state: 'ready', networkIsolated: true, recoveryAvailable: true, maxSessions: 2, reason: null });
    expect(status.capabilities).toEqual([{ id: 'network-isolated', state: 'proven', reason: null }, { id: 'snapshot-recovery', state: 'unproven', reason: null }, { id: 'hypervisor-stop', state: 'unproven', reason: null }]);
    expect(JSON.stringify(status)).not.toContain('127.0.0.1');
    const registration = s.store.registration('local');
    expect(registration).toMatchObject({ managerId, machineIdentity: expect.stringMatching(/^qemu:jit-work-[a-f0-9]{12}$/), endpoint: { host: '127.0.0.1', port: 22022, user: 'jit' } });
    await expect(s.enrollment.enrollLocal(s.owner, { id: 'other', managerId })).rejects.toMatchObject({ code: 'vm_already_enrolled' });
    await s.service.recover(s.owner, { vmId: 'local' });
    expect(s.enrollment.status(s.owner, 'local').capabilities.find(c => c.id === 'hypervisor-stop')?.state).toBe('proven');
    expect(s.enrollment.status(s.owner, 'local').capabilities.find(c => c.id === 'snapshot-recovery')?.state).toBe('unproven');
  });
  test('a guest reporting another MAC cannot inherit isolation or recovery', async () => {
    const s = await stack(), { managerId } = s.managers.register(s.owner, { kind: 'qemu' }); s.h.guestMac = '52:54:00:ab:cd:ef';
    const status = await s.enrollment.enrollLocal(s.owner, { id: 'local', managerId });
    expect(status).toMatchObject({ state: 'unproven', networkIsolated: false, recoveryAvailable: false, reason: 'vm_identity_unproven' });
  });
  test('owner resource edits persist without config files and apply at the next start', async () => {
    const s = await stack(), { managerId } = s.managers.register(s.owner, { kind: 'qemu' });
    expect(s.managers.resources(s.owner, managerId)).toMatchObject({ resources: { cpus: 5, memoryMiB: 9216, diskGiB: 60 }, defaults: { cpus: 5, memoryMiB: 9216, diskGiB: 60 }, appliesAt: 'next_start' });
    expect(() => s.managers.setResources({}, managerId, { cpus: 2, memoryMiB: 4096, diskGiB: 60 })).toThrow('owner');
    s.managers.setResources(s.owner, managerId, { cpus: 2, memoryMiB: 4096, diskGiB: 70 });
    const reopened = new VmManagers({ store: s.store, vault: new ConnectionVault(join(s.h.root, 'vault'), { forbidden: [s.h.directory] }), requireOwner: () => {}, local: s.h.options() });
    expect((reopened.get(managerId) as QemuVmManagement).resources).toEqual({ cpus: 2, memoryMiB: 4096, diskGiB: 70 });
  });
  test('a second service instance re-attaches the surviving VM and re-verifies identity without restarting it', async () => {
    const s = await stack(), { managerId } = s.managers.register(s.owner, { kind: 'qemu' });
    await s.enrollment.enrollLocal(s.owner, { id: 'local', managerId });
    const launches = s.h.launches.length, before = s.store.registration('local'), guestCalls = s.h.guestCommands.length;
    const next = await stack(s.h, s.store);
    await next.service.reattach();
    expect(s.h.launches).toHaveLength(launches);
    expect(s.store.registration('local')).toMatchObject({ state: 'ready', boot: before.boot, generation: before.generation });
    expect(s.h.guestCommands.slice(guestCalls).some(c => c.includes('nicMacs'))).toBe(true);
  });
  test('after a host restart a previously running VM starts again under a new fence; an owner-stopped VM stays stopped', async () => {
    const s = await stack(), { managerId } = s.managers.register(s.owner, { kind: 'qemu' });
    await s.enrollment.enrollLocal(s.owner, { id: 'local', managerId });
    const before = s.store.registration('local');
    s.h.units.clear(); s.h.processes.clear(); for (const disk of s.h.disks.values()) disk.locked = false;
    const rebooted = await stack(s.h, s.store); await rebooted.service.reattach();
    const after = s.store.registration('local');
    expect(after).toMatchObject({ state: 'ready', generation: before.generation + 1 }); expect(after.boot).not.toBe(before.boot);
    await rebooted.service.recover(rebooted.owner, { vmId: 'local' });
    s.h.units.clear(); s.h.processes.clear();
    const again = await stack(s.h, s.store); await again.service.reattach();
    expect(s.store.registration('local').state).toBe('stopped'); expect([...s.h.units.values()].some(u => u.active)).toBe(false);
  });
  test('an unconfirmed protected stop keeps the shared VM fenced', async () => {
    const s = await stack(), { managerId } = s.managers.register(s.owner, { kind: 'qemu' });
    await s.enrollment.enrollLocal(s.owner, { id: 'local', managerId }); s.h.stuck = true;
    await expect(s.service.recover(s.owner, { vmId: 'local' })).rejects.toMatchObject({ code: 'vm_stop_unconfirmed' });
    expect(s.store.registration('local').state).toBe('uncertain');
    expect(s.store.db.query('SELECT sequence FROM vm_events WHERE kind=\'stop\'').get()).toBeNull();
  });
});

test('the registry proxy can listen on a controller-only socket while the guest uses the fixed forward address', async () => {
  const h = host(), socketPath = join(h.root, 'proxy.sock');
  const proxy = await startVmRegistryProxy({ hostname: '127.0.0.1', port: 0, socketPath, guestHostname: '192.168.5.100', guestPort: 3128, hosts: ['registry.test'], log() {} });
  closers.push(() => proxy.close());
  expect(statSync(socketPath).mode & 0o777).toBe(0o600);
  const lease = proxy.lease('session_one', Date.now() + 60000); expect(lease.environment.HTTPS_PROXY).toMatch(/^http:\/\/session_one:[a-f0-9]{48}@192\.168\.5\.100:3128$/); lease.close();
  const reply = await new Promise<string>((resolve, reject) => { const socket = require('node:net').connect({ path: socketPath }, () => socket.write('CONNECT registry.test:443 HTTP/1.1\r\nHost: registry.test\r\n\r\n')); let text = ''; socket.on('data', (d: Buffer) => { text += d; }); socket.on('close', () => resolve(text)); socket.on('error', reject); });
  expect(reply).toStartWith('HTTP/1.1 407');
  await expect(startVmRegistryProxy({ hostname: '127.0.0.1', port: 0, socketPath: join(h.root, 'other.sock'), guestHostname: '192.168.5.100', log() {} })).rejects.toMatchObject({ code: 'vm_invalid_setup' });
});
