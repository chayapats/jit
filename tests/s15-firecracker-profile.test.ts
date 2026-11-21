import { expect, test } from 'bun:test';
import { createServer } from 'node:http';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FirecrackerApi, type FirecrackerApiOperation } from '../src/s15/vm/firecracker/api';
import { FirecrackerProfile, type FirecrackerProfileSelection } from '../src/s15/vm/firecracker/profile';

const selected = (): FirecrackerProfileSelection => ({ instanceId: 'jit-work-fixture', cpuCount: 2, memoryMiB: 512, guestCid: 3,
  kernelPath: '/kernel', rootDrivePath: '/rootfs.ext4', vsockPath: '/run/v.sock', bootArgs: 'console=ttyS0 reboot=k panic=1 pci=off root=/dev/vda rw' });
const instance = () => ({ app_name: 'Firecracker', id: 'jit-work-fixture', vmm_version: '1.18.0', state: 'Running' });
function configuration() { const s = selected(); return {
  'boot-source': { kernel_image_path: s.kernelPath, boot_args: s.bootArgs, initrd_path: null },
  'machine-config': { vcpu_count: s.cpuCount, mem_size_mib: s.memoryMiB, smt: false, track_dirty_pages: false, cpu_template: null, huge_pages: 'None' },
  drives: [{ drive_id: 'rootfs', path_on_host: s.rootDrivePath, is_root_device: true, is_read_only: false, cache_type: 'Writeback', io_engine: 'Sync', rate_limiter: null }],
  vsock: { guest_cid: s.guestCid, uds_path: s.vsockPath, vsock_id: null }, 'network-interfaces': [],
  balloon: null, 'cpu-config': null, enclave: null, logger: null, metrics: null, 'memory-hotplug': null, 'mmds-config': null, pmem: [], entropy: null,
}; }
const fixture = (config: unknown = configuration(), info: unknown = instance(), version: unknown = { firecracker_version: '1.18.0' }) => {
  const calls: FirecrackerApiOperation[] = [];
  return { calls, api: { async call(operation: FirecrackerApiOperation) { calls.push(operation); return structuredClone(operation === 'configuration' ? config : operation === 'version' ? version : info); } } };
};

test('selected NIC-free API profile exposes reported facts only, no host paths, isolation or stop certificate', async () => {
  const f = fixture(), facts = await new FirecrackerProfile(selected()).inspect(f.api);
  expect(f.calls).toEqual(['instance', 'version', 'configuration', 'instance']);
  expect(facts).toEqual({ profile: 'firecracker-offline-vsock/v1', version: '1.18.0', instanceId: 'jit-work-fixture', state: 'Running', cpuCount: 2, memoryBytes: 536870912, guestCid: 3, rootDrives: 1, networkInterfaces: 0, basis: 'api_reported' });
  expect(JSON.stringify(facts)).not.toContain('/rootfs'); expect('networkIsolated' in facts).toBe(false); expect('vm_stopped' in facts).toBe(false);
});

test.each(['Not started', 'Paused'])('API state %s is retained without becoming a running/stop proof', async state => {
  const f = fixture(configuration(), { ...instance(), state }); expect((await new FirecrackerProfile(selected()).inspect(f.api)).state).toBe(state as 'Not started' | 'Paused');
});

test.each(['balloon', 'cpu-config', 'enclave', 'logger', 'metrics', 'memory-hotplug', 'mmds-config', 'entropy', 'unknown-device'])('unreviewed configured %s is refused even with a matching instance/version', async field => {
  const config = { ...configuration(), [field]: {} }, f = fixture(config);
  await expect(new FirecrackerProfile(selected()).inspect(f.api)).rejects.toMatchObject({ code: 'vm_firecracker_profile_unproven' }); expect(f.calls).not.toContain('start');
});

test('NIC, pmem, extra disk and vhost-user socket cannot hide behind an offline profile', async () => {
  const variants = [
    { ...configuration(), 'network-interfaces': [{ iface_id: 'eth0', host_dev_name: 'tap0' }] },
    { ...configuration(), pmem: [{ path_on_host: '/host/home' }] },
    { ...configuration(), drives: [...configuration().drives, { drive_id: 'secrets', path_on_host: '/controller' }] },
    { ...configuration(), drives: [{ ...configuration().drives[0], socket: '/controller.sock' }] },
    { ...configuration(), 'boot-source': null },
  ];
  for (const config of variants) await expect(new FirecrackerProfile(selected()).inspect(fixture(config).api)).rejects.toMatchObject({ code: 'vm_firecracker_profile_unproven' });
});

test('device paths, resource ceilings, kernel arguments and vsock identity must match the exact selection', async () => {
  const patches = [
    { 'boot-source': { ...configuration()['boot-source'], kernel_image_path: '/other-kernel' } },
    { 'boot-source': { ...configuration()['boot-source'], initrd_path: '/unexpected-initrd' } },
    { 'boot-source': { ...configuration()['boot-source'], boot_args: selected().bootArgs + ' debug' } },
    { 'machine-config': { ...configuration()['machine-config'], vcpu_count: 4 } },
    { 'machine-config': { ...configuration()['machine-config'], mem_size_mib: 1024 } },
    { 'machine-config': { ...configuration()['machine-config'], smt: true } },
    { 'machine-config': { ...configuration()['machine-config'], track_dirty_pages: true } },
    { 'machine-config': { ...configuration()['machine-config'], huge_pages: '2M' } },
    { drives: [{ ...configuration().drives[0], path_on_host: '/other-disk' }] },
    { drives: [{ ...configuration().drives[0], cache_type: 'Unsafe' }] },
    { drives: [{ ...configuration().drives[0], is_root_device: false }] },
    { drives: [{ ...configuration().drives[0], io_engine: 'Async' }] },
    { vsock: { ...configuration().vsock, guest_cid: 4 } },
    { vsock: { ...configuration().vsock, uds_path: '/other.sock' } },
  ];
  for (const patch of patches) await expect(new FirecrackerProfile(selected()).inspect(fixture({ ...configuration(), ...patch }).api)).rejects.toMatchObject({ code: 'vm_firecracker_profile_unproven' });
});

test('missing/changed versions, identity, resource fields and extra status keys refuse instead of downgrade', async () => {
  for (const info of [{ ...instance(), vmm_version: '1.18.1' }, { ...instance(), id: 'jit-work-other' }, { ...instance(), app_name: 'other' }, { ...instance(), state: 'Stopped' }, { ...instance(), extra: true }]) await expect(new FirecrackerProfile(selected()).inspect(fixture(configuration(), info).api)).rejects.toMatchObject({ code: 'vm_firecracker_profile_unproven' });
  await expect(new FirecrackerProfile(selected()).inspect(fixture(configuration(), instance(), { firecracker_version: '1.17.0' }).api)).rejects.toMatchObject({ code: 'vm_firecracker_profile_unproven' });
  const partial = configuration() as Record<string, unknown>; delete partial['network-interfaces'];
  await expect(new FirecrackerProfile(selected()).inspect(fixture(partial).api)).rejects.toMatchObject({ code: 'vm_firecracker_profile_unproven' });
});

test('an instance changing while configuration is read cannot publish a coherent profile', async () => {
  let reads = 0;
  const f = fixture(); const api = { async call(operation: FirecrackerApiOperation) { if (operation === 'instance' && ++reads === 2) return { ...instance(), state: 'Paused' }; return f.api.call(operation); } };
  await expect(new FirecrackerProfile(selected()).inspect(api)).rejects.toMatchObject({ code: 'vm_firecracker_profile_changed' });
});

test('invalid or mutable host selections cannot change the private reviewed profile', async () => {
  const s = selected(), profile = new FirecrackerProfile(s); s.rootDrivePath = '/other'; s.cpuCount = 4;
  expect((await profile.inspect(fixture().api)).cpuCount).toBe(2);
  for (const patch of [{ instanceId: 'owner-vm' }, { cpuCount: 3 }, { cpuCount: 64 }, { memoryMiB: 0 }, { memoryMiB: 65537 }, { guestCid: 2 }, { guestCid: 0xffffffff }, { kernelPath: 'relative' }, { vsockPath: '/tmp/../v.sock' }, { rootDrivePath: '/kernel' }, { bootArgs: 'bad\nargument' }]) expect(() => new FirecrackerProfile({ ...selected(), ...patch })).toThrow('vm_firecracker_profile_unproven');
});

test('the profile composes with the actual bounded Unix HTTP client and preserves only fixed read operations', async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jit-fcprofile-'))), socketPath = join(directory, 'api.sock'), paths: string[] = [];
  const server = createServer((request, response) => { paths.push(request.url!); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(request.url === '/' ? instance() : request.url === '/version' ? { firecracker_version: '1.18.0' } : configuration())); });
  await new Promise<void>(resolve => server.listen(socketPath, resolve)); const api = new FirecrackerApi({ socketPath, guard() {} });
  try { expect((await new FirecrackerProfile(selected()).inspect(api)).basis).toBe('api_reported'); expect(paths).toEqual(['/', '/version', '/vm/config', '/']); expect(api.active()).toBe(0); }
  finally { await api.close(); await new Promise<void>(resolve => server.close(() => resolve())); rmSync(directory, { recursive: true, force: true }); }
});
