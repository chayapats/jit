import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { AppError } from '../../../errors';
import { vmCanonical, vmRecord } from '../validation';
import { firecrackerArmFacts, firecrackerNativeHost, type FirecrackerHostFixture, type FirecrackerHostPin, type FirecrackerHostReadPort, type FirecrackerHostSelection } from './custody';
import { FirecrackerHostLock } from './lock';
import { firecrackerLaunchPlan } from './launch';

const fail = (): never => { throw new AppError('vm_firecracker_preparation_unproven', 503); };
/** Installed immutable preparation, not a request to install software or create a host account. */
export interface FirecrackerPreparationOptions {
  selection: Omit<FirecrackerHostSelection, 'process'>;
  guard(): void;
  owner?: FirecrackerHostLock;
  fixture?: FirecrackerHostFixture;
}
/**
 * Verifies the actual installed jail immediately before systemd dispatch. It accepts no installer argv,
 * downloads, seed path, shell or mutable executable selection, and performs no host reconfiguration.
 * The installer prepares the exact pinned inputs and empty socket scope; a stale socket refuses rather
 * than deleting an unknown launch's handle. This observation is preparation only, never VM readiness.
 */
export class FirecrackerHostPreparation {
  readonly #selected: FirecrackerPreparationOptions['selection'];
  readonly #host: FirecrackerHostReadPort;
  readonly #guard: () => void;
  readonly #owner: FirecrackerHostLock | undefined;
  readonly #fixture: boolean;
  readonly #plan: ReturnType<typeof firecrackerLaunchPlan>;
  readonly #digest: string;
  constructor(options: FirecrackerPreparationOptions) {
    const selected = structuredClone(options.selection); this.#plan = firecrackerLaunchPlan(selected.profile, selected.host);
    vmRecord(selected, ['profile', 'host', 'pins', 'disk']); vmRecord(selected.disk, ['device', 'inode', 'bytes', 'initialSha256']);
    const number = (v: unknown) => typeof v === 'string' && /^(?:0|[1-9][0-9]{0,39})$/.test(v), sha = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
    if (!number(selected.disk.device) || !number(selected.disk.inode) || selected.disk.bytes !== selected.host.diskBytes || !sha(selected.disk.initialSha256) || typeof options.guard !== 'function' || options.fixture && (options.fixture.basis !== 'protocol_fixture' || options.fixture.process.basis !== 'protocol_fixture')) fail();
    vmRecord(selected.pins, ['jailer', 'firecracker', 'kernel'], selected.profile.initrdPath ? ['initrd'] : []);
    if (selected.profile.initrdPath && !selected.pins.initrd) fail();
    for (const pin of Object.values(selected.pins)) { vmRecord(pin, ['bytes', 'sha256']); if (!Number.isSafeInteger(pin.bytes) || pin.bytes < 1 || pin.bytes > 64 * 1048576 || !sha(pin.sha256)) fail(); }
    if (!options.fixture && (!(options.owner instanceof FirecrackerHostLock) || options.owner.basis !== 'protected_host')) fail();
    this.#owner = options.owner; this.#guard = options.guard; this.#fixture = !!options.fixture;
    const f = options.fixture; this.#host = f ? { metadata: f.metadata.bind(f), read: f.read.bind(f), file: f.file.bind(f), link: f.link.bind(f), list: f.list.bind(f), syncDisk: f.syncDisk.bind(f) } : firecrackerNativeHost();
    this.#selected = selected;
    this.#digest = createHash('sha256').update(vmCanonical({ contract: 's16-firecracker-host-selection/v1', profile: selected.profile, host: selected.host, pins: selected.pins, disk: { bytes: selected.disk.bytes, initialSha256: selected.disk.initialSha256 } })).digest('hex');
  }
  #current(deadline: number): void { if (performance.now() >= deadline) fail(); this.#owner?.current(); this.#guard(); if (performance.now() >= deadline) fail(); }
  #ancestors(path: string): void {
    for (let p = dirname(path);; p = dirname(p)) { const s = this.#host.metadata(p); if (s.kind !== 'directory' || s.uid !== 0 || s.mode & 0o7022) fail(); if (p === '/') break; }
  }
  #pin(path: string, pin: FirecrackerHostPin, executable = false, guestRead = false): void {
    this.#ancestors(path.startsWith(this.#plan.rootDirectory + '/') ? this.#plan.rootDirectory : path); const file = this.#host.file(path, pin.bytes), s = file.metadata;
    if (s.kind !== 'file' || s.uid !== 0 || s.links !== 1 || s.bytes !== pin.bytes || s.mode & 0o7022 || executable && !(s.mode & 0o100) || guestRead && !(s.mode & 0o004) || file.sha256 !== pin.sha256) fail();
  }
  #inspect(deadline: number): void {
    this.#current(deadline); const s = this.#selected, root = this.#plan.rootDirectory;
    this.#ancestors(root);
    // The installer may retain root ownership until the pinned jailer changes these two directories.
    for (const path of [root, join(root, 'run')]) { const m = this.#host.metadata(path); if (m.kind !== 'directory' || ![0, s.host.uid].includes(m.uid) || m.mode !== 0o700) fail(); }
    const required = ['config.json', 'kernel', 'rootfs.ext4', 'run', ...(s.profile.initrdPath ? ['initrd'] : [])], names = this.#host.list(root, 9);
    if (required.some(name => !names.includes(name)) || names.some(name => ![...required, 'firecracker', 'dev', 'sys'].includes(name)) || this.#host.list(join(root, 'run'), 2).length) fail();
    if (names.includes('dev')) {
      for (const path of [join(root, 'dev'), join(root, 'dev/net')]) { const m = this.#host.metadata(path); if (m.kind !== 'directory' || m.uid !== s.host.uid || m.gid !== s.host.gid || m.mode !== 0o700) fail(); }
      if (this.#host.list(join(root, 'dev'), 3).slice().sort().join() !== 'kvm,net,urandom' || this.#host.list(join(root, 'dev/net'), 1).join() !== 'tun') fail();
      for (const [path, rdev] of [['kvm', '2792'], ['net/tun', '2760'], ['urandom', '265']] as const) { const m = this.#host.metadata(join(root, 'dev', path)); if (m.kind !== 'character' || m.rdev !== rdev || m.uid !== s.host.uid || m.gid !== s.host.gid || m.mode !== 0o600) fail(); }
    }
    if (names.includes('sys')) firecrackerArmFacts(this.#host, root, s.host.uid, s.host.gid);
    this.#pin(s.host.jailerPath, s.pins.jailer, true); this.#pin(s.host.firecrackerPath, s.pins.firecracker, true);
    this.#pin(join(root, 'kernel'), s.pins.kernel, false, true);
    if (s.profile.initrdPath) this.#pin(join(root, 'initrd'), s.pins.initrd!, false, true);
    const config = Buffer.from(this.#plan.configuration); this.#pin(join(root, 'config.json'), { bytes: config.length, sha256: this.#plan.configurationSha256 }, false, true);
    if (names.includes('firecracker')) { const file = this.#host.file(join(root, 'firecracker'), s.pins.firecracker.bytes), m = file.metadata; if (m.kind !== 'file' || m.uid !== s.host.uid || m.links !== 1 || m.bytes !== s.pins.firecracker.bytes || m.mode & 0o7022 || !(m.mode & 0o100) || file.sha256 !== s.pins.firecracker.sha256) fail(); }
    const d = this.#host.metadata(join(root, 'rootfs.ext4'));
    if (d.kind !== 'file' || d.uid !== s.host.uid || d.gid !== s.host.gid || d.mode !== 0o600 || d.links !== 1 || d.bytes !== s.disk.bytes || d.device !== s.disk.device || d.inode !== s.disk.inode) fail();
    const view = this.#host.metadata(join(s.host.jailerBase, '.jit-proc-misc'));
    if (view.kind !== 'file' || view.uid !== 0 || view.links !== 1 || view.bytes !== 0 || view.mode & 0o7022 || this.#host.read(join(s.host.jailerBase, '.jit-proc-misc'), 1)?.length !== 0) fail();
    let total = 0;
    for (const name of this.#host.list('/proc', 8192)) {
      this.#current(deadline); if (!/^[1-9][0-9]{0,9}$/.test(name)) continue;
      const bytes = this.#host.read(`/proc/${name}/status`, 65536); if (bytes === null) continue;
      total += bytes.length; if (bytes.length > 65536 || total > 16 * 1048576) fail();
      const status = new TextDecoder('utf-8', { fatal: true }).decode(bytes), ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*$/m.exec(status);
      if (!ids || ids.slice(1).some(id => Number(id) === s.host.uid)) fail();
    }
    this.#current(deadline); this.#host.syncDisk(join(root, 'rootfs.ext4'), s.disk); this.#current(deadline);
  }
  /** Exact synchronous actual-beforeStart check, including empty dedicated UID and fresh disk flush. */
  verify(): { observation: 'launch_prepared'; basis: 'protected_host' | 'protocol_fixture'; selectionSha256: string } {
    try { const deadline = performance.now() + 15000; this.#inspect(deadline); this.#current(deadline); return { observation: 'launch_prepared', basis: this.#fixture ? 'protocol_fixture' : 'protected_host', selectionSha256: this.#digest }; }
    catch { return fail(); }
  }
}
