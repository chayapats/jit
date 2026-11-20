import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { AppError } from '../../../errors';
import { vmInteger, vmRecord } from '../validation';
import { firecrackerNativeHost, type FirecrackerHostSelection } from './custody';
import { FirecrackerHostJournal } from './jobs';
import { firecrackerLaunchPlan } from './launch';
import { FirecrackerHostLock } from './lock';
import { createFirecrackerManagementRelay } from './rpc';
import { FirecrackerHostRuntime } from './runtime';
import { FirecrackerProcessLease, firecrackerProcessStartTicks } from './process';

/** Administrator-installed protected configuration. This API does not install it or change accounts/policy. */
export interface FirecrackerDaemonConfig {
  contract: 's16-firecracker-host/v1'; installationId: string; stateDirectory: string; credentialFile: string;
  managementPort: number; sshPort: number; guestPort: number;
  selection: Omit<FirecrackerHostSelection, 'process'>;
}
function fail(): never { throw new AppError('vm_firecracker_host_configuration_unavailable', 503); }
const path = (v: unknown): v is string => typeof v === 'string' && v.startsWith('/') && normalize(v) === v && !v.endsWith('/') && !/[\u0000-\u001f\u007f]/u.test(v);
function ancestors(file: string): void {
  for (let p = dirname(file);; p = dirname(p)) { const s = lstatSync(p); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || s.mode & 0o7022) fail(); if (p === '/') break; }
}
function privateDirectory(value: string): void {
  ancestors(value); const s = lstatSync(value); if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== 0 || (s.mode & 0o7777) !== 0o700) fail();
}
function protectedFile(file: string, maximum: number) {
  if (!path(file)) return fail(); ancestors(file);
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd, { bigint: true }); if (!before.isFile() || before.uid !== 0n || before.nlink !== 1n || before.mode & 0o7077n || before.size < 1 || before.size > maximum) return fail();
    const bytes = Buffer.alloc(Number(before.size) + 1); let used = 0;
    while (used < bytes.length) { const n = readSync(fd, bytes, used, bytes.length - used, null); if (!n) break; used += n; }
    const after = fstatSync(fd, { bigint: true }), current = lstatSync(file, { bigint: true });
    if (used !== Number(before.size) || ['dev', 'ino', 'size', 'mtimeNs', 'ctimeNs', 'uid', 'mode', 'nlink'].some(k => before[k as keyof typeof before] !== after[k as keyof typeof after] || after[k as keyof typeof after] !== current[k as keyof typeof current])) return fail();
    const data = bytes.subarray(0, used); return { data, identity: `${before.dev}:${before.ino}:${used}:${createHash('sha256').update(data).digest('hex')}` };
  } finally { closeSync(fd); }
}
/** Closed shape and separation checks before root host I/O or any helper state is created. */
export function firecrackerDaemonConfig(value: unknown): FirecrackerDaemonConfig {
  const r = vmRecord(value, ['contract', 'installationId', 'stateDirectory', 'credentialFile', 'managementPort', 'sshPort', 'guestPort', 'selection']);
  if (r.contract !== 's16-firecracker-host/v1' || typeof r.installationId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(r.installationId) || !path(r.stateDirectory) || !path(r.credentialFile)) return fail();
  vmInteger(r.managementPort, 65535); vmInteger(r.sshPort, 65535); vmInteger(r.guestPort, 0xffffffff - 1); if (r.managementPort === r.sshPort) return fail();
  const s = vmRecord(r.selection, ['profile', 'host', 'pins', 'disk']), selection = structuredClone(s) as unknown as FirecrackerDaemonConfig['selection'];
  firecrackerLaunchPlan(selection.profile, selection.host);
  const disk = vmRecord(selection.disk, ['device', 'inode', 'bytes', 'initialSha256']), sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  if (typeof disk.device !== 'string' || !/^(?:0|[1-9][0-9]{0,39})$/.test(disk.device) || typeof disk.inode !== 'string' || !/^[1-9][0-9]{0,39}$/.test(disk.inode) || disk.bytes !== selection.host.diskBytes || !sha(disk.initialSha256)) return fail();
  const pins = vmRecord(selection.pins, ['jailer', 'firecracker', 'kernel', ...(selection.profile.initrdPath ? ['initrd'] : [])]);
  for (const pin of Object.values(pins)) { const p = vmRecord(pin, ['bytes', 'sha256']); vmInteger(p.bytes, 64 * 1048576); if (!sha(p.sha256)) return fail(); }
  // Protected helper/credential state is never placed in a jail or cold guest-data tree.
  if ([r.stateDirectory, r.credentialFile].some(file => file === selection.host.jailerBase || file.startsWith(selection.host.jailerBase + '/')) || selection.host.jailerBase.startsWith(r.stateDirectory + '/')) return fail();
  return structuredClone(r) as unknown as FirecrackerDaemonConfig;
}
/**
 * Starts only a previously prepared Linux root installation. No download, mkdir fallback, sudoers,
 * account change, credential generation or production activation is performed. Initialization is an
 * explicit administrator command and refuses existing state; ordinary serve refuses missing state.
 */
export async function startFirecrackerDaemon(configPath: string, options: { initialize?: boolean } = {}) {
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || process.getuid?.() !== 0) return fail();
  const file = protectedFile(configPath, 32768), config = firecrackerDaemonConfig(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(file.data)));
  const credentialFile = protectedFile(config.credentialFile, 257), credential = /^([A-Za-z0-9_-]{32,256})\n?$/.exec(new TextDecoder('utf-8', { fatal: true }).decode(credentialFile.data))?.[1]; if (!credential) return fail();
  privateDirectory(config.stateDirectory);
  const recoveryDirectory = join(config.selection.host.jailerBase, '.jit-recovery', config.selection.profile.instanceId); privateDirectory(recoveryDirectory);
  const jail = firecrackerLaunchPlan(config.selection.profile, config.selection.host).rootDirectory;
  if (lstatSync(jail, { bigint: true }).dev !== lstatSync(recoveryDirectory, { bigint: true }).dev) return fail();
  const database = join(config.stateDirectory, 'host.sqlite'), exists = !!lstatSync(database, { throwIfNoEntry: false });
  if (options.initialize ? exists : !exists) return fail();
  // Resolve the actual pidfd/poll/signal ABI on this helper's own process before a VM could be
  // launched. This opens/closes observation only; it never sends a signal or creates a KVM VM.
  const host = firecrackerNativeHost(), stat = host.read(`/proc/${process.pid}/stat`, 65536), boot = host.read('/proc/sys/kernel/random/boot_id', 128);
  if (!stat || !boot) return fail(); const text = new TextDecoder('utf-8', { fatal: true });
  const self = await FirecrackerProcessLease.open({ pid: process.pid, startTicks: firecrackerProcessStartTicks(text.decode(stat), process.pid), hostBootId: text.decode(boot).trim() });
  self.close();
  const kvm = openSync('/dev/kvm', constants.O_RDWR | constants.O_NOFOLLOW);
  try { const device = fstatSync(kvm, { bigint: true }); if (!device.isCharacterDevice() || device.rdev !== 2792n) return fail(); } finally { closeSync(kvm); }
  const owner = await FirecrackerHostLock.open(config.stateDirectory);
  let journal: FirecrackerHostJournal | undefined, runtime: FirecrackerHostRuntime | undefined, relay: ReturnType<typeof createFirecrackerManagementRelay> | undefined;
  const guard = () => { owner.current(); if (protectedFile(configPath, 32768).identity !== file.identity || protectedFile(config.credentialFile, 257).identity !== credentialFile.identity) fail(); };
  try {
    guard(); if (options.initialize ? !!lstatSync(database, { throwIfNoEntry: false }) : !lstatSync(database, { throwIfNoEntry: false })) return fail();
    journal = new FirecrackerHostJournal(database, { create: !!options.initialize }); journal.recover(owner);
    runtime = new FirecrackerHostRuntime({ journal, owner, selection: config.selection, guestPort: config.guestPort, listenPort: config.sshPort, guard });
    relay = createFirecrackerManagementRelay(runtime, { credential, installationId: config.installationId, port: config.managementPort });
    const activeRuntime = runtime, activeJournal = journal, activeRelay = relay; let closing: Promise<void> | null = null;
    return { computerId: runtime.computerId, selectionSha256: runtime.selectionSha256,
      close(): Promise<void> { return closing ??= (async () => { activeRelay.close(); await activeRuntime.close(); activeJournal.close(); owner.close(); })(); } };
  } catch {
    relay?.close(); await runtime?.close(); journal?.close(); owner.close(); return fail();
  }
}
