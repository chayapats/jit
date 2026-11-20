import { createHash } from 'node:crypto';
import { basename, join, normalize } from 'node:path';
import { AppError } from '../../../errors';
import { FirecrackerProfile, type FirecrackerProfileSelection } from './profile';

/** Protected installer-selected host paths/identity. None is a guest/model command or an installation action. */
export interface FirecrackerLaunchHost {
  jailerPath: string; firecrackerPath: string; jailerBase: string;
  uid: number; gid: number; controllerUid: number; controllerGid: number;
  diskBytes: number;
}
/** Exact preparation for one durable launch intent; executing jailer also starts this VM. */
export interface FirecrackerLaunchPlan {
  readonly operation: 'launch_and_start';
  readonly rootDirectory: string; readonly apiSocket: string; readonly vsockSocket: string;
  readonly configuration: string; readonly configurationSha256: string;
  readonly argv: readonly string[];
}
const reject = (): never => { throw new AppError('vm_firecracker_launch_invalid', 409); };
const path = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.startsWith('/') && !value.endsWith('/') && normalize(value) === value && Buffer.byteLength(value) <= maximum && /^\/[A-Za-z0-9._/-]+$/.test(value);
const uid = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value < 0xffffffff;

/**
 * Builds a closed jailer v1.18.0 launch, never executes it. The owning manager must validate immutable
 * binaries/images, prepare the private jail, persist its intent and recheck authority before spawn.
 * `--config-file` starts the VM: a lost launch reply must never cause a second launch/InstanceStart.
 * No NIC, MMDS, shared mount, extra device, arbitrary flag/environment or disabled seccomp is selected.
 */
export function firecrackerLaunchPlan(profile: FirecrackerProfileSelection, host: FirecrackerLaunchHost): FirecrackerLaunchPlan {
  profile = Object.freeze({ ...profile }); host = Object.freeze({ ...host });
  new FirecrackerProfile(profile);
  if (!host || Object.keys(host).sort().join() !== 'controllerGid,controllerUid,diskBytes,firecrackerPath,gid,jailerBase,jailerPath,uid' || !path(host.jailerPath, 256) || basename(host.jailerPath) !== 'jailer' || !path(host.firecrackerPath, 256) || basename(host.firecrackerPath) !== 'firecracker' || !path(host.jailerBase, 64) || !uid(host.uid) || !uid(host.gid) || !uid(host.controllerUid) || !uid(host.controllerGid) || host.uid === host.controllerUid || host.gid === host.controllerGid || !Number.isSafeInteger(host.diskBytes) || host.diskBytes < 128 * 1048576 || host.diskBytes > 64 * 1073741824) return reject();
  if (profile.kernelPath !== '/kernel' || profile.rootDrivePath !== '/rootfs.ext4' || profile.vsockPath !== '/run/vsock.sock' || profile.initrdPath != null && profile.initrdPath !== '/initrd') return reject();
  const rootDirectory = join(host.jailerBase, 'firecracker', profile.instanceId, 'root');
  const apiSocket = join(rootDirectory, 'run/api.sock'), vsockSocket = join(rootDirectory, 'run/vsock.sock');
  if (Buffer.byteLength(apiSocket) > 100 || Buffer.byteLength(vsockSocket) > 100) return reject();
  const configuration = JSON.stringify({
    'boot-source': { kernel_image_path: profile.kernelPath, boot_args: profile.bootArgs, ...(profile.initrdPath ? { initrd_path: profile.initrdPath } : {}) },
    'machine-config': { vcpu_count: profile.cpuCount, mem_size_mib: profile.memoryMiB, smt: false, track_dirty_pages: false, huge_pages: 'None' },
    drives: [{ drive_id: 'rootfs', path_on_host: profile.rootDrivePath, is_root_device: true, is_read_only: false, cache_type: 'Writeback', io_engine: 'Sync' }],
    'network-interfaces': [], vsock: { guest_cid: profile.guestCid, uds_path: profile.vsockPath },
  });
  const argv = Object.freeze([host.jailerPath, '--id', profile.instanceId, '--exec-file', host.firecrackerPath,
    '--uid', String(host.uid), '--gid', String(host.gid), '--chroot-base-dir', host.jailerBase,
    '--cgroup-version', '2', '--parent-cgroup', 'jit/firecracker',
    '--cgroup', `memory.max=${(profile.memoryMiB + 256) * 1048576}`, '--cgroup', 'memory.swap.max=0', '--cgroup', 'pids.max=128',
    '--cgroup', `cpu.max=${profile.cpuCount * 100000} 100000`,
    '--resource-limit', 'no-file=256', '--resource-limit', `fsize=${host.diskBytes}`,
    '--', '--api-sock', '/run/api.sock', '--config-file', '/config.json']);
  return Object.freeze({ operation: 'launch_and_start', rootDirectory, apiSocket, vsockSocket, configuration,
    configurationSha256: createHash('sha256').update(configuration).digest('hex'), argv });
}

/**
 * Exact post-exec argv of the selected foreground jailer. The upstream jailer injects three numeric
 * timing arguments; none changes VM resources or grants authority. Unknown/duplicate flags refuse.
 * This validates argv only, not executable provenance, process identity, jail or API socket custody.
 */
export function firecrackerRuntimeArgvMatches(argv: readonly string[], instanceId: string): boolean {
  if (!Array.isArray(argv) || argv.length !== 13 || argv.some(value => typeof value !== 'string') || !/^jit-work(?:-[a-z0-9-]{1,54})?$/.test(instanceId)) return false;
  const expected = ['/firecracker', '--id', instanceId, '--start-time-us', null, '--start-time-cpu-us', null,
    '--parent-cpu-time-us', null, '--api-sock', '/run/api.sock', '--config-file', '/config.json'];
  // Retain exact ordering from the pinned jailer.
  return argv.length === expected.length && expected.every((value, index) => value === null ? /^[0-9]{1,20}$/.test(argv[index]!) : argv[index] === value);
}
