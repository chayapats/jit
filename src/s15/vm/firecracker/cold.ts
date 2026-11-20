import { createHash } from 'node:crypto';
import { constants, lstatSync, type BigIntStats } from 'node:fs';
import { open, mkdir, rename, unlink, readdir, type FileHandle } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { AppError } from '../../../errors';
import { vmCanonical, vmRecord } from '../validation';
import { firecrackerLaunchPlan } from './launch';
import type { FirecrackerHostFacts, FirecrackerHostSelection } from './custody';

type Disk = FirecrackerHostSelection['disk'];
/** Protected same-computer cold recovery metadata. This is never a portable working-state package. */
export interface FirecrackerColdManifest {
  contract: 's16-firecracker-cold/v1'; computerId: string; selectionSha256: string;
  requestId: string; snapshotId: string; bytes: number; sha256: string;
}
/** Private original context, persisted before each corresponding filesystem effect; absent from public receipts. */
export interface FirecrackerColdContext {
  contract: 's16-firecracker-cold-job/v1'; kind: 'checkpoint' | 'restore' | 'retire';
  requestId: string; snapshotId: string; selectionSha256: string; before: Disk;
  manifest: FirecrackerColdManifest | null; replacement: Disk | null;
}
/** Current job plus independently verified original-process exit, dedicated-UID emptiness and exact disk fsync. */
export interface FirecrackerColdControl {
  guard(): void | Promise<void>;
  settled(disk: Readonly<Disk>): Promise<FirecrackerHostFacts>;
  context(): unknown;
  record(context: FirecrackerColdContext): void;
}
/** Native paths are derived from the selected launch plan; path remapping is explicitly test-only. */
export interface FirecrackerColdOptions {
  selection: Omit<FirecrackerHostSelection, 'process'>;
  fixture?: { basis: 'protocol_fixture'; rootDirectory: string; recoveryDirectory: string };
}
function fail(): never { throw new AppError('vm_firecracker_cold_unavailable', 503); }
const request = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{32}$/.test(v);
const tag = (v: unknown): v is string => typeof v === 'string' && /^jit-[a-f0-9]{32}$/.test(v);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function disk(value: unknown, bytes: number): Disk {
  const r = vmRecord(value, ['device', 'inode', 'bytes', 'initialSha256']);
  if (typeof r.device !== 'string' || !/^(?:0|[1-9][0-9]{0,39})$/.test(r.device) || typeof r.inode !== 'string' || !/^[1-9][0-9]{0,39}$/.test(r.inode) || r.bytes !== bytes || !sha(r.initialSha256)) return fail();
  return { ...r } as Disk;
}
function same(a: BigIntStats, b: BigIntStats): boolean { return ['dev', 'ino', 'size', 'uid', 'gid', 'mode', 'nlink', 'mtimeNs', 'ctimeNs'].every(k => a[k as keyof BigIntStats] === b[k as keyof BigIntStats]); }

/**
 * Real bounded cold disk copying for an already quiescent selected computer. The installer prepares
 * recovery storage on the same local filesystem as its jail. Exclusive staging, fsync and one rename
 * publish whole snapshots/restores. Unknown original effects are read back, never repeated or cleaned
 * automatically. These methods do not stop/launch a VM, release a job or manufacture source ancestry.
 */
export class FirecrackerColdStore {
  readonly basis: FirecrackerHostFacts['basis'];
  readonly selectionSha256: string;
  readonly #selected: FirecrackerColdOptions['selection'];
  readonly #root: string;
  readonly #recovery: string;
  readonly #owner: number;
  #busy = false;
  constructor(options: FirecrackerColdOptions) {
    this.#selected = structuredClone(options.selection); const s = this.#selected, plan = firecrackerLaunchPlan(s.profile, s.host);
    disk(s.disk, s.host.diskBytes);
    if (options.fixture && options.fixture.basis !== 'protocol_fixture') fail();
    if (!options.fixture && (process.platform !== 'linux' || !['x64', 'arm64'].includes(process.arch) || process.getuid?.() !== 0)) fail();
    this.basis = options.fixture ? 'protocol_fixture' : 'protected_host'; this.#owner = options.fixture ? process.getuid!() : 0;
    this.#root = options.fixture?.rootDirectory ?? plan.rootDirectory;
    this.#recovery = options.fixture?.recoveryDirectory ?? join(s.host.jailerBase, '.jit-recovery', s.profile.instanceId);
    this.selectionSha256 = createHash('sha256').update(vmCanonical({ contract: 's16-firecracker-host-selection/v1', profile: s.profile, host: s.host, pins: s.pins, disk: { bytes: s.disk.bytes, initialSha256: s.disk.initialSha256 } })).digest('hex');
  }
  #directories(): void {
    for (const [path, uid] of [[this.#root, this.basis === 'protocol_fixture' ? this.#owner : this.#selected.host.uid], [this.#recovery, this.#owner]] as const) {
      const s = lstatSync(path, { bigint: true });
      if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== BigInt(uid) || s.mode & 0o7077n) return fail();
      if (this.basis === 'protected_host') for (let p = dirname(path);; p = dirname(p)) {
        const parent = lstatSync(p); if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || parent.mode & 0o7022) return fail(); if (p === '/') break;
      }
    }
    if (lstatSync(this.#root, { bigint: true }).dev !== lstatSync(this.#recovery, { bigint: true }).dev) return fail();
  }
  async #guard(control: FirecrackerColdControl, until: number): Promise<void> {
    if (performance.now() >= until) return fail(); await control.guard(); if (performance.now() >= until) return fail(); this.#directories();
  }
  async #settled(control: FirecrackerColdControl, selected: Disk, until: number): Promise<void> {
    await this.#guard(control, until); const facts = await control.settled(Object.freeze({ ...selected }));
    if (facts.observation !== 'process_and_disk_settled' || facts.basis !== this.basis || facts.selectionSha256 !== this.selectionSha256) return fail(); await this.#guard(control, until);
  }
  #manifest(value: unknown, snapshotId: string): FirecrackerColdManifest {
    const r = vmRecord(value, ['contract', 'computerId', 'selectionSha256', 'requestId', 'snapshotId', 'bytes', 'sha256']);
    if (r.contract !== 's16-firecracker-cold/v1' || r.computerId !== this.#selected.profile.instanceId || r.selectionSha256 !== this.selectionSha256 || !request(r.requestId) || r.snapshotId !== snapshotId || r.bytes !== this.#selected.disk.bytes || !sha(r.sha256)) return fail();
    return { ...r } as unknown as FirecrackerColdManifest;
  }
  #context(value: unknown): FirecrackerColdContext {
    const r = vmRecord(value, ['contract', 'kind', 'requestId', 'snapshotId', 'selectionSha256', 'before', 'manifest', 'replacement']);
    if (r.contract !== 's16-firecracker-cold-job/v1' || !['checkpoint', 'restore', 'retire'].includes(r.kind as string) || !request(r.requestId) || !tag(r.snapshotId) || r.selectionSha256 !== this.selectionSha256) return fail();
    const before = disk(r.before, this.#selected.disk.bytes), manifest = r.manifest === null ? null : this.#manifest(r.manifest, r.snapshotId), replacement = r.replacement === null ? null : disk(r.replacement, this.#selected.disk.bytes);
    if (vmCanonical(before) !== vmCanonical(this.#selected.disk) || r.kind !== 'restore' && replacement !== null || replacement && replacement.initialSha256 !== before.initialSha256) return fail();
    return { ...r, before, manifest, replacement } as FirecrackerColdContext;
  }
  async #file(path: string, uid: number, bytes: number, expected?: Disk): Promise<FileHandle> {
    const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const s = await fd.stat({ bigint: true });
      if (!s.isFile() || s.nlink !== 1n || s.uid !== BigInt(uid) || s.mode & 0o7077n || s.size !== BigInt(bytes) || expected && (String(s.dev) !== expected.device || String(s.ino) !== expected.inode)) return fail();
      const p = lstatSync(path, { bigint: true }); if (!same(s, p)) return fail(); return fd;
    } catch (error) { await fd.close(); throw error; }
  }
  async #syncDirectory(path: string): Promise<void> { const fd = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_DIRECTORY); try { await fd.sync(); } finally { await fd.close(); } }
  async #bytes(source: FileHandle, control: FirecrackerColdControl, until: number, destination?: FileHandle): Promise<string> {
    const before = await source.stat({ bigint: true }), hash = createHash('sha256'), buffer = Buffer.alloc(1048576); let position = 0;
    while (position < this.#selected.disk.bytes) {
      await this.#guard(control, until); const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, this.#selected.disk.bytes - position), position);
      if (bytesRead < 1) return fail(); hash.update(buffer.subarray(0, bytesRead));
      if (destination) for (let offset = 0; offset < bytesRead;) { await this.#guard(control, until); const { bytesWritten } = await destination.write(buffer, offset, bytesRead - offset, position + offset); if (!bytesWritten) return fail(); offset += bytesWritten; }
      position += bytesRead;
    }
    if (!same(before, await source.stat({ bigint: true }))) return fail(); await this.#guard(control, until); return hash.digest('hex');
  }
  async #snapshot(snapshotId: string, control: FirecrackerColdControl, until: number): Promise<FirecrackerColdManifest> {
    const dir = join(this.#recovery, snapshotId), s = lstatSync(dir);
    if (!s.isDirectory() || s.isSymbolicLink() || s.uid !== this.#owner || s.mode & 0o7077) return fail();
    const path = join(dir, 'manifest.json'), size = lstatSync(path).size; if (size > 4096 || size < 1) return fail();
    const fd = await this.#file(path, this.#owner, size); let manifest: FirecrackerColdManifest;
    try { const before = await fd.stat({ bigint: true }); manifest = this.#manifest(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(await fd.readFile())), snapshotId); if (!same(before, await fd.stat({ bigint: true }))) return fail(); } finally { await fd.close(); }
    const raw = await this.#file(join(dir, 'disk.raw'), this.#owner, manifest.bytes);
    try { if (await this.#bytes(raw, control, until) !== manifest.sha256) return fail(); } finally { await raw.close(); }
    return manifest;
  }
  async #run<T>(control: FirecrackerColdControl, action: (until: number) => Promise<T>): Promise<T> {
    if (this.#busy) return fail(); this.#busy = true;
    try { const until = performance.now() + 360000; await this.#guard(control, until); return await action(until); }
    catch { return fail(); } finally { this.#busy = false; }
  }
  #begin(kind: FirecrackerColdContext['kind'], requestId: string, snapshotId: string, control: FirecrackerColdControl): FirecrackerColdContext {
    if (!request(requestId) || !tag(snapshotId) || control.context() !== null) return fail();
    const context: FirecrackerColdContext = { contract: 's16-firecracker-cold-job/v1', kind, requestId, snapshotId, selectionSha256: this.selectionSha256, before: { ...this.#selected.disk }, manifest: null, replacement: null };
    control.record(structuredClone(context)); return context;
  }
  /** Whole stopped disk only; a staged or interrupted copy is never a published checkpoint. */
  checkpoint(requestId: string, snapshotId: string, control: FirecrackerColdControl): Promise<FirecrackerColdManifest> {
    return this.#run(control, async until => {
      const context = this.#begin('checkpoint', requestId, snapshotId, control); await this.#settled(control, context.before, until);
      const target = join(this.#recovery, snapshotId), stage = join(this.#recovery, `.capture-${requestId}`);
      const names = await readdir(this.#recovery);
      if (names.length > 8192 || names.some(name => name === snapshotId || name.startsWith(`.retired-${snapshotId}-`))) return fail(); await mkdir(stage, { mode: 0o700 });
      const source = await this.#file(join(this.#root, 'rootfs.ext4'), this.basis === 'protocol_fixture' ? this.#owner : this.#selected.host.uid, context.before.bytes, context.before);
      try {
        const dest = await open(join(stage, 'disk.raw'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try { const hash = await this.#bytes(source, control, until, dest); await dest.chmod(0o400); await dest.sync(); context.manifest = { contract: 's16-firecracker-cold/v1', computerId: this.#selected.profile.instanceId, selectionSha256: this.selectionSha256, requestId, snapshotId, bytes: context.before.bytes, sha256: hash }; } finally { await dest.close(); }
      } finally { await source.close(); }
      const fd = await open(join(stage, 'manifest.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      try { await fd.writeFile(vmCanonical(context.manifest)); await fd.chmod(0o400); await fd.sync(); } finally { await fd.close(); }
      await this.#syncDirectory(stage); control.record(structuredClone(context)); await this.#settled(control, context.before, until);
      if (lstatSync(target, { throwIfNoEntry: false })) return fail(); await rename(stage, target); await this.#syncDirectory(this.#recovery); await this.#guard(control, until); return structuredClone(context.manifest!);
    });
  }
  /** Atomic selected-disk replacement; the caller retains the returned new inode in protected launch context. */
  restore(requestId: string, snapshotId: string, control: FirecrackerColdControl): Promise<Disk> {
    return this.#run(control, async until => {
      const context = this.#begin('restore', requestId, snapshotId, control); await this.#settled(control, context.before, until);
      context.manifest = await this.#snapshot(snapshotId, control, until); control.record(structuredClone(context));
      const stage = join(this.#recovery, `.restore-${requestId}`), source = await this.#file(join(this.#recovery, snapshotId, 'disk.raw'), this.#owner, context.before.bytes);
      try {
        const dest = await open(stage, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          if (await this.#bytes(source, control, until, dest) !== context.manifest.sha256) return fail();
          if (this.basis === 'protected_host') await dest.chown(this.#selected.host.uid, this.#selected.host.gid); await dest.sync();
          const s = await dest.stat({ bigint: true }); context.replacement = { device: String(s.dev), inode: String(s.ino), bytes: context.before.bytes, initialSha256: context.before.initialSha256 };
          control.record(structuredClone(context)); await this.#settled(control, context.before, until);
          const old = await this.#file(join(this.#root, 'rootfs.ext4'), this.basis === 'protocol_fixture' ? this.#owner : this.#selected.host.uid, context.before.bytes, context.before); await old.close();
          if (!same(s, lstatSync(stage, { bigint: true }))) return fail(); await this.#guard(control, until);
          await rename(stage, join(this.#root, 'rootfs.ext4')); await this.#syncDirectory(this.#root); await this.#syncDirectory(this.#recovery);
        } finally { await dest.close(); }
      } finally { await source.close(); }
      await this.#settled(control, context.replacement!, until); return { ...context.replacement! };
    });
  }
  /** Verifies an exact immutable published snapshot after its source VM resumed; no mutable-disk/stop claim. */
  async inspectSnapshot(expected: FirecrackerColdManifest, control: FirecrackerColdControl): Promise<FirecrackerColdManifest> {
    return this.#run(control, async until => {
      const value = this.#manifest(expected, expected.snapshotId), actual = await this.#snapshot(value.snapshotId, control, until);
      if (vmCanonical(value) !== vmCanonical(actual)) return fail(); await this.#guard(control, until); return actual;
    });
  }
  /** Original read-back only. A prepared stage or missing output remains unknown; nothing is renamed/deleted. */
  readBack(value: unknown, control: FirecrackerColdControl): Promise<FirecrackerColdManifest | Disk | true | null> {
    return this.#run(control, async until => {
      const context = this.#context(value);
      if (context.kind === 'checkpoint') {
        if (!context.manifest || !lstatSync(join(this.#recovery, context.snapshotId), { throwIfNoEntry: false })) return null;
        const manifest = await this.#snapshot(context.snapshotId, control, until); if (vmCanonical(manifest) !== vmCanonical(context.manifest)) return fail();
        await this.#settled(control, context.before, until); return manifest;
      }
      if (context.kind === 'restore') {
        if (!context.manifest || !context.replacement) return null;
        const path = join(this.#root, 'rootfs.ext4'), s = lstatSync(path, { bigint: true }); if (String(s.dev) !== context.replacement.device || String(s.ino) !== context.replacement.inode) return null;
        const fd = await this.#file(path, this.basis === 'protocol_fixture' ? this.#owner : this.#selected.host.uid, context.replacement.bytes, context.replacement);
        try { if (await this.#bytes(fd, control, until) !== context.manifest.sha256) return fail(); } finally { await fd.close(); }
        await this.#settled(control, context.replacement, until); return { ...context.replacement };
      }
      const retired = join(this.#recovery, `.retired-${context.snapshotId}-${context.requestId}`);
      if (lstatSync(join(this.#recovery, context.snapshotId), { throwIfNoEntry: false }) || !lstatSync(retired, { throwIfNoEntry: false })) return null;
      // The immutable manifest survives deletion as the exact retirement tombstone.
      const path = join(retired, 'manifest.json'), size = lstatSync(path).size; if (size < 1 || size > 4096) return fail();
      const fd = await this.#file(path, this.#owner, size);
      try { if (!context.manifest || vmCanonical(this.#manifest(JSON.parse(await fd.readFile({ encoding: 'utf8' })), context.snapshotId)) !== vmCanonical(context.manifest)) return fail(); } finally { await fd.close(); }
      if (lstatSync(join(retired, 'disk.raw'), { throwIfNoEntry: false })) return null; await this.#guard(control, until); return true;
    });
  }
  /** Removes bytes only for an exact reviewed tag; retained tombstone prevents tag reuse after response loss. */
  retire(requestId: string, snapshotId: string, control: FirecrackerColdControl): Promise<void> {
    return this.#run(control, async until => {
      const context = this.#begin('retire', requestId, snapshotId, control); context.manifest = await this.#snapshot(snapshotId, control, until); control.record(structuredClone(context));
      const retired = join(this.#recovery, `.retired-${snapshotId}-${requestId}`); if (lstatSync(retired, { throwIfNoEntry: false })) return fail();
      await this.#guard(control, until); await rename(join(this.#recovery, snapshotId), retired); await this.#syncDirectory(this.#recovery);
      await this.#guard(control, until); await unlink(join(retired, 'disk.raw')); await this.#syncDirectory(retired); await this.#guard(control, until);
    });
  }
}
