import { closeSync, constants, fstatSync, fsyncSync, lstatSync, openSync, readSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { AppError } from '../../../errors';
import { vmCanonical } from '../validation';
import { firecrackerLaunchPlan, firecrackerRuntimeArgvMatches, type FirecrackerLaunchHost, type FirecrackerLaunchPlan } from './launch';
import { FirecrackerProcessLease, firecrackerProcessStartTicks, type FirecrackerProcessFixture, type FirecrackerProcessIdentity } from './process';
import type { FirecrackerProfileSelection } from './profile';

/** Immutable installer pins; the running guest's mutable disk is identified separately by its protected launch record. */
export interface FirecrackerHostPin { bytes: number; sha256: string }
/** The original protected launch record, never a guest/API report or an owner-supplied process selector. */
export interface FirecrackerHostSelection {
  profile: FirecrackerProfileSelection; host: FirecrackerLaunchHost;
  pins: { jailer: FirecrackerHostPin; firecracker: FirecrackerHostPin; kernel: FirecrackerHostPin; initrd?: FirecrackerHostPin };
  disk: { device: string; inode: string; bytes: number; initialSha256: string };
  process: FirecrackerProcessIdentity;
}
/** Bounded host-only metadata. Device/inode values retain exact kernel integer identities. */
export interface FirecrackerHostMetadata {
  kind: 'file' | 'directory' | 'socket' | 'character' | 'other';
  device: string; inode: string; rdev: string; bytes: number; links: number; uid: number; gid: number; mode: number;
}
/** Injected host observations always stay protocol fixtures, regardless of their apparent values. */
export interface FirecrackerHostFixture {
  basis: 'protocol_fixture'; process: FirecrackerProcessFixture;
  metadata(path: string, follow?: boolean): FirecrackerHostMetadata;
  read(path: string, maximum: number): Uint8Array | null;
  file(path: string, maximum: number, follow?: boolean): { metadata: FirecrackerHostMetadata; sha256: string };
  link(path: string): string;
  list(path: string, maximum: number): readonly string[];
  syncDisk(path: string, expected: FirecrackerHostSelection['disk']): void;
}
type HostPort = Omit<FirecrackerHostFixture, 'basis' | 'process'>;
/** Independent host observations only; the owning manager still combines the closed API profile and current authority. */
export interface FirecrackerHostFacts {
  observation: 'process_bound' | 'process_and_disk_settled';
  basis: 'protected_host' | 'protocol_fixture'; selectionSha256: string;
}
const reject = (): never => { throw new AppError('vm_firecracker_custody_unproven', 503); };
const hash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const identity = (value: unknown): value is string => typeof value === 'string' && /^(?:0|[1-9][0-9]{0,39})$/.test(value);
function closed(value: unknown, keys: readonly string[]): void {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join() !== [...keys].sort().join()) reject();
}
function metadata(s: BigIntStats): FirecrackerHostMetadata {
  return { kind: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : s.isSocket() ? 'socket' : s.isCharacterDevice() ? 'character' : 'other',
    device: String(s.dev), inode: String(s.ino), rdev: String(s.rdev), bytes: Number(s.size), links: Number(s.nlink), uid: Number(s.uid), gid: Number(s.gid), mode: Number(s.mode & 0o7777n) };
}
function equalFile(a: FirecrackerHostMetadata, b: FirecrackerHostMetadata): boolean {
  return ['kind', 'device', 'inode', 'bytes', 'links', 'uid', 'gid', 'mode'].every(key => a[key as keyof FirecrackerHostMetadata] === b[key as keyof FirecrackerHostMetadata]);
}
function budget(timeoutMs: number, maximum: number, signal?: AbortSignal) {
  if (!integer(timeoutMs) || timeoutMs < 1 || timeoutMs > maximum || signal !== undefined && !(signal instanceof AbortSignal)) return reject();
  const deadline = performance.now() + timeoutMs, expired = Promise.withResolvers<never>();
  let canceled = false;
  const abort = () => { canceled = true; expired.reject(new AppError('vm_firecracker_custody_unproven', 503)); };
  const timer = setTimeout(abort, timeoutMs); signal?.addEventListener('abort', abort, { once: true });
  // Every asynchronous wait races this promise below; pre-abort is checked without an unobserved rejection.
  const check = () => { if (canceled || signal?.aborted || performance.now() >= deadline) return reject(); };
  return { check, remaining: () => Math.max(1, Math.floor(deadline - performance.now())),
    async run<T>(start: () => T | Promise<T>): Promise<T> { check(); return Promise.race([Promise.resolve().then(() => { check(); return start(); }).then(value => { check(); return value; }), expired.promise]); },
    close() { clearTimeout(timer); signal?.removeEventListener('abort', abort); } };
}
function nativeHost(): HostPort {
  // Only the installed privileged helper can inspect another UID's /proc root/exe/fd and settle its disk.
  // The controller must not run as root or as the VMM identity to gain this access.
  if (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || process.getuid?.() !== 0) return reject();
  return {
    metadata(path, follow = false) { return metadata((follow ? statSync : lstatSync)(path, { bigint: true })); },
    read(path, maximum) {
      let fd: number; try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
      try {
        const bytes = Buffer.alloc(maximum + 1); let length = 0;
        while (length < bytes.length) { const n = readSync(fd, bytes, length, bytes.length - length, null); if (!n) break; length += n; }
        if (length > maximum) return reject(); return bytes.subarray(0, length);
      } finally { closeSync(fd); }
    },
    file(path, maximum, follow = false) {
      const fd = openSync(path, constants.O_RDONLY | (follow ? 0 : constants.O_NOFOLLOW));
      try {
        const before = metadata(fstatSync(fd, { bigint: true }));
        if (before.kind !== 'file' || !integer(before.bytes) || before.bytes > maximum || before.links !== 1) return reject();
        const digest = createHash('sha256'), buffer = Buffer.alloc(65536); let length = 0;
        for (;;) { const n = readSync(fd, buffer, 0, Math.min(buffer.length, maximum + 1 - length), null); if (!n) break; length += n; if (length > maximum) return reject(); digest.update(buffer.subarray(0, n)); }
        if (length !== before.bytes || !equalFile(before, metadata(fstatSync(fd, { bigint: true })))) return reject();
        return { metadata: before, sha256: digest.digest('hex') };
      } finally { closeSync(fd); }
    },
    link(path) { const value = readlinkSync(path); if (Buffer.byteLength(value) > 4096) return reject(); return value; },
    list(path, maximum) { const values = readdirSync(path); if (values.length > maximum) return reject(); return values; },
    syncDisk(path, expected) {
      const fd = openSync(path, constants.O_RDWR | constants.O_NOFOLLOW);
      try {
        const before = metadata(fstatSync(fd, { bigint: true }));
        if (before.kind !== 'file' || before.device !== expected.device || before.inode !== expected.inode || before.bytes !== expected.bytes || before.links !== 1) return reject();
        fsyncSync(fd); if (!equalFile(before, metadata(fstatSync(fd, { bigint: true })))) return reject();
      } finally { closeSync(fd); }
    },
  };
}
function selectedHost(selection: FirecrackerHostSelection): { selected: FirecrackerHostSelection; plan: FirecrackerLaunchPlan } {
  const selected = structuredClone(selection);
  closed(selected, ['profile', 'host', 'pins', 'disk', 'process']); closed(selected.process, ['pid', 'startTicks', 'hostBootId']);
  if (!Number.isSafeInteger(selected.process.pid) || selected.process.pid < 2 || selected.process.pid > 0x7fffffff || typeof selected.process.startTicks !== 'string' || !/^[1-9][0-9]{0,19}$/.test(selected.process.startTicks) || typeof selected.process.hostBootId !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(selected.process.hostBootId)) return reject();
  closed(selected.pins, selected.profile.initrdPath ? ['jailer', 'firecracker', 'kernel', 'initrd'] : ['jailer', 'firecracker', 'kernel']);
  for (const pin of Object.values(selected.pins)) { closed(pin, ['bytes', 'sha256']); if (!integer(pin.bytes) || pin.bytes < 1 || pin.bytes > 64 * 1048576 || !hash(pin.sha256)) reject(); }
  closed(selected.disk, ['device', 'inode', 'bytes', 'initialSha256']);
  if (!identity(selected.disk.device) || !identity(selected.disk.inode) || !hash(selected.disk.initialSha256) || selected.disk.bytes !== selected.host.diskBytes) reject();
  return { selected, plan: firecrackerLaunchPlan(selected.profile, selected.host) };
}

/**
 * Exact host custody around a retained pidfd. This is a privileged-helper component, never a working
 * backend/HTTP input. It does not launch, import authority, signal a replacement PID, or certify API
 * configuration from guest output. Closing releases observation only; unknown stop retains this lease.
 */
export class FirecrackerHostLease {
  readonly #selection: FirecrackerHostSelection;
  readonly #plan: FirecrackerLaunchPlan;
  readonly #host: HostPort;
  readonly #process: Pick<FirecrackerProcessLease, 'exited' | 'stop' | 'close'>;
  readonly #basis: FirecrackerHostFacts['basis'];
  readonly #digest: string;
  #closed = false;
  #stopping = false;
  private constructor(selected: FirecrackerHostSelection, plan: FirecrackerLaunchPlan, host: HostPort, process: Pick<FirecrackerProcessLease, 'exited' | 'stop' | 'close'>, fixture: boolean) {
    this.#selection = selected; this.#plan = plan; this.#host = host; this.#process = process; this.#basis = fixture ? 'protocol_fixture' : 'protected_host';
    this.#digest = createHash('sha256').update(vmCanonical({ contract: 's16-firecracker-host-selection/v1', profile: selected.profile, host: selected.host, pins: selected.pins, disk: { bytes: selected.disk.bytes, initialSha256: selected.disk.initialSha256 } })).digest('hex');
  }
  /** Acquire only the original protected launch identity, verifying custody on both sides of pidfd acquisition. */
  static async open(selection: FirecrackerHostSelection, options: { guard(): void | Promise<void>; fixture?: FirecrackerHostFixture; timeoutMs?: number; signal?: AbortSignal }): Promise<FirecrackerHostLease> {
    const limit = budget(options.timeoutMs ?? 15000, 15000, options.signal);
    let process: FirecrackerProcessLease | null = null;
    try {
      const { selected, plan } = selectedHost(selection), fixture = options.fixture, guard = options.guard, processFixture = fixture?.process;
      if (typeof guard !== 'function' || fixture && (fixture.basis !== 'protocol_fixture' || processFixture?.basis !== 'protocol_fixture')) reject();
      const host: HostPort = fixture ? { metadata: fixture.metadata.bind(fixture), read: fixture.read.bind(fixture), file: fixture.file.bind(fixture), link: fixture.link.bind(fixture), list: fixture.list.bind(fixture), syncDisk: fixture.syncDisk.bind(fixture) } : nativeHost();
      await limit.run(guard);
      process = await limit.run(async () => {
        const acquired = await FirecrackerProcessLease.open(selected.process, processFixture);
        try { limit.check(); return acquired; } catch (error) { acquired.close(); throw error; }
      });
      const lease = new FirecrackerHostLease(selected, plan, host, process, !!fixture);
      lease.inspect(); limit.check(); await limit.run(guard); lease.inspect(); limit.check(); return lease;
    } catch { try { process?.close(); } catch { /* Closing is never a stop or capacity release. */ } return reject(); }
    finally { limit.close(); }
  }
  /**
   * Read-only restart recovery when the original pidfd belonged to a dead helper. A changed host boot,
   * absent original PID or different start ticks can establish original exit, never permission to signal
   * a reused PID. Dedicated-UID emptiness, exact closed jail/disk and fsync remain independently required.
   * Returns only settlement facts, never a running lease, replacement process or execution authority.
   */
  static async recoverStopped(selection: FirecrackerHostSelection, options: { guard(): void | Promise<void>; fixture?: FirecrackerHostFixture; timeoutMs?: number; signal?: AbortSignal }): Promise<FirecrackerHostFacts> {
    const limit = budget(options.timeoutMs ?? 10000, 10000, options.signal);
    try {
      const { selected, plan } = selectedHost(selection), fixture = options.fixture, guard = options.guard;
      if (typeof guard !== 'function' || fixture && (fixture.basis !== 'protocol_fixture' || fixture.process?.basis !== 'protocol_fixture')) return reject();
      const host: HostPort = fixture ? { metadata: fixture.metadata.bind(fixture), read: fixture.read.bind(fixture), file: fixture.file.bind(fixture), link: fixture.link.bind(fixture), list: fixture.list.bind(fixture), syncDisk: fixture.syncDisk.bind(fixture) } : nativeHost();
      const text = (path: string, maximum: number) => { const bytes = host.read(path, maximum); if (bytes === null) return null; if (bytes.length > maximum) return reject(); return new TextDecoder('utf-8', { fatal: true }).decode(bytes); };
      const process: Pick<FirecrackerProcessLease, 'exited' | 'stop' | 'close'> = {
        exited() {
          const boot = text('/proc/sys/kernel/random/boot_id', 128)?.trim();
          if (!boot || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot)) return reject();
          if (boot !== selected.process.hostBootId) return true;
          const stat = text(`/proc/${selected.process.pid}/stat`, 65536);
          return stat === null || firecrackerProcessStartTicks(stat, selected.process.pid) !== selected.process.startTicks;
        },
        async stop() { return reject(); }, close() {},
      };
      const lease = new FirecrackerHostLease(selected, plan, host, process, !!fixture);
      return await lease.#settled(guard, limit);
    } catch { return reject(); }
    finally { limit.close(); }
  }
  #text(path: string, maximum = 65536): string {
    const bytes = this.#host.read(path, maximum); if (!bytes || bytes.length > maximum) return reject();
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return reject(); }
  }
  #ancestors(path: string): void {
    for (let parent = dirname(path);; parent = dirname(parent)) {
      const s = this.#host.metadata(parent); if (s.kind !== 'directory' || s.uid !== 0 || s.mode & 0o7022) reject();
      if (parent === '/') break;
    }
  }
  #pin(path: string, pin: FirecrackerHostPin, uid: number, follow = false): FirecrackerHostMetadata {
    const file = this.#host.file(path, pin.bytes, follow), s = file.metadata;
    if (s.kind !== 'file' || s.bytes !== pin.bytes || s.links !== 1 || s.uid !== uid || s.mode & 0o7022 || file.sha256 !== pin.sha256) return reject();
    return s;
  }
  #disk(): FirecrackerHostMetadata {
    const s = this.#host.metadata(join(this.#plan.rootDirectory, 'rootfs.ext4')), d = this.#selection.disk;
    if (s.kind !== 'file' || s.device !== d.device || s.inode !== d.inode || s.bytes !== d.bytes || s.links !== 1 || s.uid !== this.#selection.host.uid || s.gid !== this.#selection.host.gid || s.mode !== 0o600) return reject();
    return s;
  }
  #uids(): readonly number[] {
    const selected = this.#selection, matches: number[] = []; let bytesRead = 0;
    for (const name of this.#host.list('/proc', 8192)) {
      if (!/^[1-9][0-9]{0,9}$/.test(name)) continue;
      const bytes = this.#host.read(`/proc/${name}/status`, 65536); if (bytes === null) continue;
      bytesRead += bytes.length; if (bytes.length > 65536 || bytesRead > 16 * 1048576) return reject();
      const status = new TextDecoder('utf-8', { fatal: true }).decode(bytes), uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
      if (!uid) return reject(); if (uid.slice(1).some(value => Number(value) === selected.host.uid)) matches.push(Number(name));
    }
    return matches;
  }
  #jail(running = true): void {
    const root = this.#plan.rootDirectory, selected = this.#selection;
    this.#ancestors(root);
    for (const suffix of ['', '/run', '/dev', '/dev/net']) {
      const s = this.#host.metadata(root + suffix);
      if (s.kind !== 'directory' || s.uid !== selected.host.uid || s.gid !== selected.host.gid || s.mode !== 0o700) reject();
    }
    for (const [path, rdev] of [['dev/kvm', '2792'], ['dev/net/tun', '2760'], ['dev/urandom', '265']]) {
      const s = this.#host.metadata(join(root, path!));
      if (s.kind !== 'character' || s.rdev !== rdev || s.uid !== selected.host.uid || s.gid !== selected.host.gid || s.mode !== 0o600) reject();
    }
    const fixed = ['config.json', 'dev', 'firecracker', 'kernel', 'rootfs.ext4', 'run', ...(selected.profile.initrdPath ? ['initrd'] : [])];
    // aarch64's pinned jailer additionally copies bounded public CPU sysfs facts; validate the entire tree.
    const rootEntries = this.#host.list(root, 9); const expected = rootEntries.includes('sys') ? [...fixed, 'sys'] : fixed;
    const sockets = this.#host.list(join(root, 'run'), 2).slice().sort();
    if ([...rootEntries].sort().join() !== expected.sort().join() || this.#host.list(join(root, 'dev'), 3).slice().sort().join() !== 'kvm,net,urandom' || this.#host.list(join(root, 'dev/net'), 1).join() !== 'tun' || sockets.some(name => !['api.sock', 'vsock.sock'].includes(name)) || running && sockets.join() !== 'api.sock,vsock.sock') reject();
    if (rootEntries.includes('sys')) {
      let count = 0;
      const visit = (relative: string, depth: number) => {
        if (++count > 128 || depth > 12) reject(); const path = join(root, relative), s = this.#host.metadata(path);
        if (s.uid !== selected.host.uid || s.gid !== selected.host.gid || s.mode & 0o7022) reject();
        if (s.kind === 'directory') {
          if (!['sys', 'sys/devices', 'sys/devices/system', 'sys/devices/system/cpu', 'sys/devices/system/cpu/cpu0', 'sys/devices/system/cpu/cpu0/cache', 'sys/devices/system/cpu/cpu0/regs', 'sys/devices/system/cpu/cpu0/regs/identification'].includes(relative) && !/^sys\/devices\/system\/cpu\/cpu0\/cache\/index[0-7]$/.test(relative)) reject();
          for (const name of this.#host.list(path, 16)) { if (!/^[A-Za-z0-9_]+$/.test(name)) reject(); visit(`${relative}/${name}`, depth + 1); }
        }
        else {
          if (s.kind !== 'file' || s.links !== 1 || !/^sys\/devices\/system\/cpu\/cpu0\/(?:cache\/index[0-7]\/(?:size|level|type|shared_cpu_map|coherency_line_size|number_of_sets)|regs\/identification\/midr_el1)$/.test(relative) || this.#text(path, 4096) !== this.#text(`/${relative}`, 4096)) reject();
        }
      }; visit('sys', 0);
    }
  }
  #sockets(): void {
    const root = this.#plan.rootDirectory;
    for (const suffix of ['api.sock', 'vsock.sock']) {
      const s = this.#host.metadata(join(root, 'run', suffix));
      if (s.kind !== 'socket' || s.uid !== this.#selection.host.uid || s.gid !== this.#selection.host.gid || s.mode & 0o7077) reject();
    }
  }
  #status(status: string): void {
    const s = this.#selection, ids = (name: string, id: number) => new RegExp(`^${name}:\\s+${id}\\s+${id}\\s+${id}\\s+${id}\\s*$`, 'm').test(status);
    if (!ids('Uid', s.host.uid) || !ids('Gid', s.host.gid) || !/^NoNewPrivs:\s+1\s*$/m.test(status) || !/^Seccomp:\s+2\s*$/m.test(status)) reject();
    for (const cap of ['CapInh', 'CapPrm', 'CapEff', 'CapAmb']) if (!new RegExp(`^${cap}:\\s+0{16}\\s*$`, 'm').test(status)) reject();
    const groups = /^Groups:[ \t]*([^\r\n]*)$/m.exec(status)?.[1];
    if (groups === undefined || groups.trim() && groups.trim().split(/\s+/).some(group => group !== String(s.host.gid))) reject();
  }
  #inspect(): void {
    if (this.#closed || this.#process.exited()) return reject();
    const s = this.#selection, proc = `/proc/${s.process.pid}`, root = this.#plan.rootDirectory;
    if (this.#text('/proc/sys/kernel/random/boot_id', 64).trim() !== s.process.hostBootId || firecrackerProcessStartTicks(this.#text(`${proc}/stat`), s.process.pid) !== s.process.startTicks) reject();
    const argv = this.#text(`${proc}/cmdline`, 4096).split('\0'); if (argv.pop() !== '' || !firecrackerRuntimeArgvMatches(argv, s.profile.instanceId)) reject();
    const environment = this.#text(`${proc}/environ`, 1024).split('\0');
    if (environment.pop() !== '' || environment.sort().join('\0') !== ['HOME=/nonexistent', 'LANG=C', 'PATH=/usr/bin:/bin'].join('\0')) reject();
    this.#status(this.#text(`${proc}/status`));
    if (this.#uids().join() !== String(s.process.pid)) reject();
    const cgroup = `/sys/fs/cgroup/jit/firecracker/${s.profile.instanceId}`;
    if (this.#text(`${proc}/cgroup`, 256).trim() !== `0::/jit/firecracker/${s.profile.instanceId}`) reject();
    const threads = this.#host.list(`${proc}/task`, 128);
    if (!threads.length || !threads.includes(String(s.process.pid)) || new Set(threads).size !== threads.length) reject();
    for (const tid of threads) {
      if (!/^[1-9][0-9]{0,9}$/.test(tid)) reject();
      this.#status(this.#text(`${proc}/task/${tid}/status`));
      if (this.#text(`${proc}/task/${tid}/cgroup`, 256).trim() !== `0::/jit/firecracker/${s.profile.instanceId}`) reject();
    }
    this.#ancestors(join(cgroup, 'memory.max'));
    for (const [file, value] of [['memory.max', String((s.profile.memoryMiB + 256) * 1048576)], ['memory.swap.max', '0'], ['pids.max', '128'], ['cpu.max', `${s.profile.cpuCount * 100000} 100000`], ['cgroup.procs', String(s.process.pid)]]) if (this.#text(join(cgroup, file!), 4096).trim() !== value) reject();
    this.#jail(); this.#sockets(); const disk = this.#disk();
    this.#ancestors(s.host.jailerPath); this.#ancestors(s.host.firecrackerPath);
    if (!(this.#pin(s.host.jailerPath, s.pins.jailer, 0).mode & 0o100) || !(this.#pin(s.host.firecrackerPath, s.pins.firecracker, 0).mode & 0o100)) reject();
    const executable = this.#pin(join(root, 'firecracker'), s.pins.firecracker, s.host.uid);
    if (executable.gid !== s.host.gid || !(executable.mode & 0o100)) reject();
    const immutable = new Map<string, FirecrackerHostMetadata>();
    immutable.set(join(root, 'kernel'), this.#pin(join(root, 'kernel'), s.pins.kernel, 0));
    if (s.pins.initrd) immutable.set(join(root, 'initrd'), this.#pin(join(root, 'initrd'), s.pins.initrd, 0));
    immutable.set(join(root, 'config.json'), this.#pin(join(root, 'config.json'), { bytes: Buffer.byteLength(this.#plan.configuration), sha256: this.#plan.configurationSha256 }, 0));
    if (this.#host.link(`${proc}/root`) !== root || this.#host.link(`${proc}/exe`) !== join(root, 'firecracker') || !equalFile(executable, this.#host.metadata(`${proc}/exe`, true))) reject();
    const jail = this.#host.metadata(root), actualRoot = this.#host.metadata(`${proc}/root`, true);
    if (jail.device !== actualRoot.device || jail.inode !== actualRoot.inode) reject();
    const fds = this.#host.list(`${proc}/fd`, 256), unix = this.#text('/proc/net/unix', 131072).split('\n'), socketInodes = new Map<string, string>();
    for (const line of unix.slice(1)) { const fields = line.trim().split(/\s+/); if (fields.length >= 7 && fields[4] === '0001' && (fields.length === 7 || fields.length === 8 && ['/run/api.sock', '/run/vsock.sock'].includes(fields[7]!))) socketInodes.set(fields[6]!, fields[3] === '00010000' ? fields[7] ?? '' : ''); }
    let rootDisk = false, vm = false; const cpus = new Set<number>(), listeners = new Set<string>();
    const access = (fd: string, mode: bigint) => { const flags = /^flags:\s+([0-7]{1,16})\s*$/m.exec(this.#text(`${proc}/fdinfo/${fd}`, 4096))?.[1]; if (!flags || (BigInt(`0o${flags}`) & 3n) !== mode) reject(); };
    for (const fd of fds) {
      if (!/^(?:0|[1-9][0-9]{0,2})$/.test(fd)) reject();
      const path = `${proc}/fd/${fd}`, target = this.#host.link(path);
      if (target === join(root, 'rootfs.ext4')) { if (!equalFile(disk, this.#host.metadata(path, true))) reject(); access(fd, 2n); rootDisk = true; }
      else if (immutable.has(target)) { if (!equalFile(immutable.get(target)!, this.#host.metadata(path, true))) reject(); access(fd, 0n); }
      else if (target === join(root, 'dev/kvm')) { if (this.#host.metadata(path, true).rdev !== '2792') reject(); }
      else if (target === '/dev/null' && Number(fd) <= 2) { if (this.#host.metadata(path, true).rdev !== '259') reject(); }
      else if (target === 'anon_inode:kvm-vm') vm = true;
      else if (/^anon_inode:kvm-vcpu:(?:0|[1-9][0-9]?)$/.test(target)) { const id = Number(target.slice(target.lastIndexOf(':') + 1)); if (id >= s.profile.cpuCount) reject(); cpus.add(id); }
      else if (/^anon_inode:\[(?:eventfd|timerfd|eventpoll)\]$/.test(target)) { /* Selected VMM kernel descriptors. */ }
      else { const inode = /^socket:\[([1-9][0-9]{0,19})\]$/.exec(target)?.[1]; if (!inode || !socketInodes.has(inode)) return reject(); listeners.add(socketInodes.get(inode)!); }
    }
    if (!rootDisk || !vm || cpus.size !== s.profile.cpuCount || !listeners.has('/run/api.sock') || !listeners.has('/run/vsock.sock') || this.#process.exited() || firecrackerProcessStartTicks(this.#text(`${proc}/stat`), s.process.pid) !== s.process.startTicks) reject();
  }
  /** Rechecks actual host custody; API metadata and a guest NIC echo cannot supply this observation. */
  inspect(): FirecrackerHostFacts { const started = performance.now(); try { this.#inspect(); if (performance.now() - started >= 15000) return reject(); return { observation: 'process_bound', basis: this.#basis, selectionSha256: this.#digest }; } catch { return reject(); } }
  /**
   * One exact pidfd stop, followed by an independent dedicated-UID census and original-disk fsync.
   * A remaining UID process, changed disk or failed/late guard retains unknown capacity. Never sends
   * another signal after dispatch, and never upgrades cooperative cleanup to this observation.
   */
  async stop(options: { guard(): void | Promise<void>; timeoutMs?: number; signal?: AbortSignal }): Promise<FirecrackerHostFacts> {
    const { guard, signal } = options, limit = budget(options.timeoutMs ?? 10000, 10000, signal);
    if (this.#closed || this.#stopping || typeof guard !== 'function') { limit.close(); return reject(); } this.#stopping = true;
    try {
      await limit.run(() => this.#process.stop({ timeoutMs: limit.remaining(), ...(signal ? { signal } : {}), guard: async () => { await limit.run(guard); if (!this.#process.exited()) this.inspect(); limit.check(); } }));
      return await this.#settled(guard, limit);
    } finally { limit.close(); this.#stopping = false; }
  }
  /** Read-back only: proves original exit and disk settlement without a second signal or replacement launch. */
  async settled(guard: () => void | Promise<void>, options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<FirecrackerHostFacts> {
    const limit = budget(options.timeoutMs ?? 10000, 10000, options.signal);
    try { return await this.#settled(guard, limit); } finally { limit.close(); }
  }
  async #settled(guard: () => void | Promise<void>, limit: ReturnType<typeof budget>): Promise<FirecrackerHostFacts> {
    try {
      await limit.run(guard); if (this.#closed || !this.#process.exited() || this.#uids().length) return reject();
      this.#jail(false); this.#disk(); this.#host.syncDisk(join(this.#plan.rootDirectory, 'rootfs.ext4'), this.#selection.disk);
      limit.check(); await limit.run(guard); if (this.#closed || !this.#process.exited() || this.#uids().length) return reject(); this.#disk(); limit.check();
      return { observation: 'process_and_disk_settled', basis: this.#basis, selectionSha256: this.#digest };
    } catch { return reject(); }
  }
  /** Closes observation only, never stops a VM or releases an unresolved owning claim. */
  close(): void { if (this.#stopping) return reject(); if (!this.#closed) { this.#process.close(); this.#closed = true; } }
}
