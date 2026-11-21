import { isAbsolute, normalize } from 'node:path';
import { AppError } from '../../../errors';
import type { FirecrackerApi } from './api';

/** Reviewed public API implementation, not an automatic updater or a wildcard compatible version. */
export const firecrackerVersion = '1.18.0' as const;
/** Trusted host-selected paths refer to the VMM's private jail; none is supplied by a model or guest. */
export interface FirecrackerProfileSelection {
  instanceId: string; cpuCount: number; memoryMiB: number;
  kernelPath: string; bootArgs: string; initrdPath?: string | null;
  rootDrivePath: string; vsockPath: string; guestCid: number;
}
/** Closed API facts only. A protected process/socket/disk binding is still required for host proof. */
export interface FirecrackerApiFacts {
  profile: 'firecracker-offline-vsock/v1'; version: typeof firecrackerVersion;
  instanceId: string; state: 'Not started' | 'Running' | 'Paused';
  cpuCount: number; memoryBytes: number; guestCid: number;
  rootDrives: 1; networkInterfaces: 0; basis: 'api_reported';
}
const reject = (): never => { throw new AppError('vm_firecracker_profile_unproven', 409); };
function object(value: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return reject();
  const result = value as Record<string, unknown>;
  if (required.some(key => !Object.hasOwn(result, key)) || Object.keys(result).some(key => !required.includes(key) && !optional.includes(key))) return reject();
  return result;
}
const disabled = (value: unknown) => value === undefined || value === null;
const empty = (value: unknown) => disabled(value) || Array.isArray(value) && value.length === 0;
function path(value: unknown): value is string {
  return typeof value === 'string' && value.isWellFormed() && isAbsolute(value) && normalize(value) === value && Buffer.byteLength(value) <= 100 && !/[\u0000-\u001f\u007f]/u.test(value);
}

/**
 * Validates the complete NIC-free API profile against immutable host selection. This does not inspect
 * a host process, manufacture an enrollment binding or certify isolation/stop. API drift, RAM-loaded
 * configurations, unknown devices and unreviewed paths refuse before any capability can be combined.
 */
export class FirecrackerProfile {
  readonly #selected: Readonly<Required<FirecrackerProfileSelection>>;
  constructor(selection: FirecrackerProfileSelection) {
    object(selection, ['instanceId', 'cpuCount', 'memoryMiB', 'kernelPath', 'bootArgs', 'rootDrivePath', 'vsockPath', 'guestCid'], ['initrdPath']);
    if (typeof selection.instanceId !== 'string' || !/^jit-work(?:-[a-z0-9-]{1,54})?$/.test(selection.instanceId) || !Number.isSafeInteger(selection.cpuCount) || selection.cpuCount < 1 || selection.cpuCount > 32 || selection.cpuCount !== 1 && selection.cpuCount % 2 !== 0 || !Number.isSafeInteger(selection.memoryMiB) || selection.memoryMiB < 128 || selection.memoryMiB > 65536 || !Number.isSafeInteger(selection.guestCid) || selection.guestCid < 3 || selection.guestCid >= 0xffffffff || !path(selection.kernelPath) || !path(selection.rootDrivePath) || !path(selection.vsockPath) || selection.initrdPath != null && !path(selection.initrdPath) || typeof selection.bootArgs !== 'string' || !selection.bootArgs.trim() || !selection.bootArgs.isWellFormed() || Buffer.byteLength(selection.bootArgs) > 2048 || /[\u0000-\u001f\u007f]/u.test(selection.bootArgs)) reject();
    const paths = [selection.kernelPath, selection.rootDrivePath, selection.vsockPath, ...(selection.initrdPath ? [selection.initrdPath] : [])];
    if (new Set(paths).size !== paths.length) reject();
    this.#selected = Object.freeze({ ...selection, initrdPath: selection.initrdPath ?? null });
  }
  #instance(raw: unknown): FirecrackerApiFacts['state'] {
    const instance = object(raw, ['app_name', 'id', 'state', 'vmm_version']);
    if (instance.app_name !== 'Firecracker' || instance.id !== this.#selected.instanceId || instance.vmm_version !== firecrackerVersion || !['Not started', 'Running', 'Paused'].includes(instance.state as string)) reject();
    return instance.state as FirecrackerApiFacts['state'];
  }
  #configuration(raw: unknown): void {
    const selected = this.#selected;
    const config = object(raw, ['boot-source', 'drives', 'machine-config', 'network-interfaces', 'vsock'],
      ['balloon', 'cpu-config', 'enclave', 'logger', 'metrics', 'memory-hotplug', 'mmds-config', 'pmem', 'entropy']);
    for (const field of ['balloon', 'cpu-config', 'enclave', 'logger', 'metrics', 'memory-hotplug', 'mmds-config', 'entropy']) if (!disabled(config[field])) reject();
    if (!empty(config.pmem) || !Array.isArray(config['network-interfaces']) || config['network-interfaces'].length !== 0) reject();
    const boot = object(config['boot-source'], ['kernel_image_path', 'boot_args'], ['initrd_path']);
    if (boot.kernel_image_path !== selected.kernelPath || boot.boot_args !== selected.bootArgs || (boot.initrd_path ?? null) !== selected.initrdPath) reject();
    const machine = object(config['machine-config'], ['vcpu_count', 'mem_size_mib'], ['smt', 'track_dirty_pages', 'cpu_template', 'huge_pages']);
    if (machine.vcpu_count !== selected.cpuCount || machine.mem_size_mib !== selected.memoryMiB || !disabled(machine.cpu_template) || (machine.smt ?? false) !== false || (machine.track_dirty_pages ?? false) !== false || (machine.huge_pages ?? 'None') !== 'None') reject();
    if (!Array.isArray(config.drives) || config.drives.length !== 1) return reject();
    const disk = object(config.drives[0], ['drive_id', 'path_on_host', 'is_root_device', 'is_read_only', 'cache_type'],
      ['partuuid', 'rate_limiter', 'io_engine', 'discard', 'blk_size', 'topology', 'socket', 'dmb_size_mib']);
    if (disk.drive_id !== 'rootfs' || disk.path_on_host !== selected.rootDrivePath || disk.is_root_device !== true || disk.is_read_only !== false || disk.cache_type !== 'Writeback' || !disabled(disk.partuuid) || !disabled(disk.rate_limiter) || (disk.io_engine ?? 'Sync') !== 'Sync' || (disk.discard ?? false) !== false || (disk.blk_size ?? 512) !== 512 || !disabled(disk.topology) || !disabled(disk.socket) || !disabled(disk.dmb_size_mib)) reject();
    const vsock = object(config.vsock, ['guest_cid', 'uds_path'], ['vsock_id']);
    if (vsock.guest_cid !== selected.guestCid || vsock.uds_path !== selected.vsockPath || !disabled(vsock.vsock_id)) reject();
  }
  /** One bounded read of version/configuration between matching instance observations. No mutation or retry. */
  async inspect(api: Pick<FirecrackerApi, 'call'>, signal?: AbortSignal): Promise<FirecrackerApiFacts> {
    const abort = new AbortController(), cancel = () => abort.abort();
    if (signal?.aborted) throw new AppError('aborted', 409);
    signal?.addEventListener('abort', cancel, { once: true });
    const timer = setTimeout(cancel, 15000);
    try {
      const before = this.#instance(await api.call('instance', abort.signal));
      const version = object(await api.call('version', abort.signal), ['firecracker_version']);
      if (version.firecracker_version !== firecrackerVersion) reject();
      this.#configuration(await api.call('configuration', abort.signal));
      const after = this.#instance(await api.call('instance', abort.signal));
      if (before !== after || abort.signal.aborted) throw new AppError('vm_firecracker_profile_changed', 409);
      const selected = this.#selected;
      return { profile: 'firecracker-offline-vsock/v1', version: firecrackerVersion, instanceId: selected.instanceId, state: after,
        cpuCount: selected.cpuCount, memoryBytes: selected.memoryMiB * 1048576, guestCid: selected.guestCid, rootDrives: 1, networkInterfaces: 0, basis: 'api_reported' };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', cancel); }
  }
}
