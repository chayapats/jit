import { afterEach, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { closeSync, chmodSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FirecrackerColdStore, type FirecrackerColdContext, type FirecrackerColdControl } from '../src/s15/vm/firecracker/cold';
import { firecrackerHostFixture } from './fixtures/s15-firecracker-host';

// Actual raw files/copies/renames, with explicit host-settlement fixtures. No KVM/stop certification.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const request = (n: number) => n.toString(16).padStart(32, '0'), snapshot = `jit-${request(10)}`;
function hash(path: string) {
  const fd = openSync(path, 'r'), h = createHash('sha256'), buffer = Buffer.alloc(1048576); try { for (;;) { const n = readSync(fd, buffer); if (!n) break; h.update(buffer.subarray(0, n)); } return h.digest('hex'); } finally { closeSync(fd); }
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jit-fc-cold-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const root = join(dir, 'root'), recovery = join(dir, 'recovery'); mkdirSync(root, { mode: 0o700 }); mkdirSync(recovery, { mode: 0o700 });
  const selected = firecrackerHostFixture().selected, path = join(root, 'rootfs.ext4'); writeFileSync(path, 'original work bytes', { mode: 0o600 }); truncateSync(path, selected.disk.bytes);
  const stat = lstatSync(path, { bigint: true }); selected.disk = { device: String(stat.dev), inode: String(stat.ino), bytes: selected.disk.bytes, initialSha256: hash(path) };
  const options = { selection: selected, fixture: { basis: 'protocol_fixture' as const, rootDirectory: root, recoveryDirectory: recovery } }, store = new FirecrackerColdStore(options);
  function control(guard: () => void | Promise<void> = () => {}, record: (context: FirecrackerColdContext) => void = () => {}) {
    let context: FirecrackerColdContext | null = null, settlement = true;
    const port: FirecrackerColdControl = { guard, context: () => structuredClone(context), record(value) { context = structuredClone(value); record(context); }, async settled(disk) {
      if (!settlement) throw Error('only cooperative guest scope empty');
      const s = lstatSync(path, { bigint: true }); if (String(s.dev) !== disk.device || String(s.ino) !== disk.inode || s.size !== BigInt(disk.bytes)) throw Error('different original disk');
      return { observation: 'process_and_disk_settled', basis: 'protocol_fixture', selectionSha256: store.selectionSha256 };
    } };
    return { port, context: () => structuredClone(context), settlement(value: boolean) { settlement = value; } };
  }
  return { dir, root, recovery, path, selected, options, store, control };
}

test('cold checkpoint, atomic restore and exact retirement preserve original receipts and immutable tags', async () => {
  const f = setup(), capture = f.control(), original = hash(f.path), before = lstatSync(f.path, { bigint: true });
  const manifest = await f.store.checkpoint(request(1), snapshot, capture.port);
  expect(manifest).toMatchObject({ sha256: original, bytes: f.selected.disk.bytes, snapshotId: snapshot });
  expect(await f.store.readBack(capture.context(), capture.port)).toEqual(manifest); expect(lstatSync(join(f.recovery, snapshot, 'disk.raw')).mode & 0o777).toBe(0o400);
  const fd = openSync(f.path, 'r+'); writeSync(fd, Buffer.from('CHANGED WORK'), 0, 12, 0); closeSync(fd); expect(hash(f.path)).not.toBe(original);
  const restore = f.control(), replacement = await f.store.restore(request(2), snapshot, restore.port);
  expect(hash(f.path)).toBe(original); expect(replacement.inode).not.toBe(String(before.ino)); expect(replacement.initialSha256).toBe(f.selected.disk.initialSha256);
  expect(await f.store.readBack(restore.context(), restore.port)).toEqual(replacement);
  await expect(f.store.restore(request(2), snapshot, restore.port)).rejects.toMatchObject({ code: 'vm_firecracker_cold_unavailable' });
  const retire = f.control(); await f.store.retire(request(3), snapshot, retire.port); expect(await f.store.readBack(retire.context(), retire.port)).toBe(true);
  expect(lstatSync(join(f.recovery, snapshot), { throwIfNoEntry: false })).toBeUndefined();
  expect(readdirSync(join(f.recovery, `.retired-${snapshot}-${request(3)}`))).toEqual(['manifest.json']);
  const next = new FirecrackerColdStore({ ...f.options, selection: { ...f.selected, disk: replacement } }); expect(next.selectionSha256).toBe(f.store.selectionSha256);
  await expect(next.checkpoint(request(4), snapshot, f.control().port)).rejects.toMatchObject({ code: 'vm_firecracker_cold_unavailable' });
});

test('interrupted capture holds its private original stage and cannot publish or resume a partial snapshot', async () => {
  const f = setup(); let guards = 0;
  const c = f.control(() => { if (++guards > 12) throw Error('revoked during actual copy'); });
  await expect(f.store.checkpoint(request(1), snapshot, c.port)).rejects.toMatchObject({ code: 'vm_firecracker_cold_unavailable' });
  expect(lstatSync(join(f.recovery, snapshot), { throwIfNoEntry: false })).toBeUndefined(); expect(lstatSync(join(f.recovery, `.capture-${request(1)}`, 'disk.raw')).size).toBeGreaterThan(0);
  const read = f.control(); expect(await f.store.readBack(c.context(), read.port)).toBeNull();
  await expect(f.store.checkpoint(request(1), snapshot, c.port)).rejects.toMatchObject({ code: 'vm_firecracker_cold_unavailable' });
  expect(hash(f.path)).toBe(f.selected.disk.initialSha256);
});

test('revocation after complete staging leaves original disk intact; read-back does not perform the pending rename', async () => {
  const f = setup(); await f.store.checkpoint(request(1), snapshot, f.control().port);
  const fd = openSync(f.path, 'r+'); writeSync(fd, Buffer.from('later work'), 0, 10, 0); closeSync(fd);
  const original = hash(f.path), before = lstatSync(f.path).ino; let revoked = false;
  const c = f.control(() => { if (revoked) throw Error('revoked before publication'); }, context => { if (context.replacement) revoked = true; });
  await expect(f.store.restore(request(2), snapshot, c.port)).rejects.toMatchObject({ code: 'vm_firecracker_cold_unavailable' });
  expect(lstatSync(f.path).ino).toBe(before); expect(hash(f.path)).toBe(original); expect(c.context()?.replacement).not.toBeNull();
  expect(await f.store.readBack(c.context(), f.control().port)).toBeNull(); expect(hash(f.path)).toBe(original);
  expect(lstatSync(join(f.recovery, `.restore-${request(2)}`)).size).toBe(f.selected.disk.bytes);
});

test('lost publication reply is recovered by exact actual bytes/inode without another disk replacement', async () => {
  const f = setup(); let first = true;
  const capture = f.control(() => { if (first && lstatSync(join(f.recovery, snapshot), { throwIfNoEntry: false })) { first = false; throw Error('reply lost'); } });
  await expect(f.store.checkpoint(request(1), snapshot, capture.port)).rejects.toMatchObject({ code: 'vm_firecracker_cold_unavailable' });
  expect(await f.store.readBack(capture.context(), f.control().port)).toMatchObject({ sha256: f.selected.disk.initialSha256 });
  let replaced = false; const restore = f.control(() => {
    if (!replaced && lstatSync(f.path, { bigint: true }).ino.toString() !== f.selected.disk.inode) { replaced = true; throw Error('reply lost after rename'); }
  });
  await expect(f.store.restore(request(2), snapshot, restore.port)).rejects.toMatchObject({ code: 'vm_firecracker_cold_unavailable' });
  const inode = lstatSync(f.path).ino; expect(await f.store.readBack(restore.context(), f.control().port)).toMatchObject({ inode: String(inode) }); expect(lstatSync(f.path).ino).toBe(inode);
});

test('cooperative cleanup and invalid original identities cannot start a cold copy', async () => {
  const f = setup(), c = f.control(); c.settlement(false);
  await expect(f.store.checkpoint(request(1), snapshot, c.port)).rejects.toMatchObject({ code: 'vm_firecracker_cold_unavailable' }); expect(readdirSync(f.recovery)).toHaveLength(0);
  for (const [id, tag] of [['../original', snapshot], [request(1), '../disk'], [request(1), 'jit-' + 'A'.repeat(32)]]) await expect(f.store.checkpoint(id!, tag!, f.control().port)).rejects.toMatchObject({ code: 'vm_firecracker_cold_unavailable' });
  expect(readdirSync(f.recovery)).toHaveLength(0);
});

test('linked or hash-changed snapshot cannot replace the original disk', async () => {
  const f = setup(); await f.store.checkpoint(request(1), snapshot, f.control().port);
  const path = join(f.recovery, snapshot, 'disk.raw'), before = lstatSync(f.path).ino;
  chmodSync(path, 0o600); const fd = openSync(path, 'r+'); writeSync(fd, Buffer.from('changed'), 0, 7, 0); closeSync(fd);
  await expect(f.store.restore(request(2), snapshot, f.control().port)).rejects.toMatchObject({ code: 'vm_firecracker_cold_unavailable' }); expect(lstatSync(f.path).ino).toBe(before);
  rmSync(path); symlinkSync(f.path, path);
  await expect(f.store.restore(request(3), snapshot, f.control().port)).rejects.toMatchObject({ code: 'vm_firecracker_cold_unavailable' }); expect(lstatSync(f.path).ino).toBe(before);
});

test('an occupied cold job rejects another mutation while its actual settlement is pending', async () => {
  const f = setup(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), c = f.control(), settled = c.port.settled;
  c.port.settled = async disk => { entered.resolve(); await release.promise; return settled(disk); };
  const pending = f.store.checkpoint(request(1), snapshot, c.port); await entered.promise;
  await expect(f.store.retire(request(2), snapshot, f.control().port)).rejects.toMatchObject({ code: 'vm_firecracker_cold_unavailable' });
  release.resolve(); expect(await pending).toMatchObject({ snapshotId: snapshot });
});
