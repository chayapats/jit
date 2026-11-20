import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableJournal } from '../src/s15/durable-journal';
import { VmStore } from '../src/s15/vm/store';
import { browserContinuity } from '../src/s15/browser/state';
import { observeS16LedgerImage, type S16LedgerImageExpectation } from '../src/s16/operations/ledger-image';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const reader: S16LedgerImageExpectation = { applicationId: 0x4a4d5135, formats: [1], ownerUid: process.getuid!() };
function directory() { const root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-ops-image-'))); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return root; }
function journal() {
  const root = directory(), path = join(root, 'model.sqlite'), store = new DurableJournal(path, 'installation', true, reader.applicationId);
  store.tx(() => store.put('original', { state: 'unknown', privateContext: 'retained-private-fixture-value' })); store.close();
  return { root, path };
}
function snapshot(path: string): string {
  const image = path + '.image', db = new Database(path, { readonly: true, create: false });
  try { writeFileSync(image, db.serialize(), { mode: 0o600 }); } finally { db.close(); }
  return image;
}

test('actual owning journal is observed without changing bytes, returning rows or clearing an unknown record', () => {
  const f = journal(), before = readFileSync(f.path), names = readdirSync(f.root);
  const image = observeS16LedgerImage(f.path, reader);
  expect(image).toEqual({ contract: 's16-ledger-image/v1', validation: 'header_and_hash', applicationId: reader.applicationId,
    readerVersion: 1, journalMode: 'rollback', bytes: before.length, sha256: new Bun.CryptoHasher('sha256').update(before).digest('hex') });
  expect(Object.isFrozen(image)).toBe(true); expect(JSON.stringify(image)).not.toContain('private'); expect(JSON.stringify(image)).not.toContain(f.root);
  expect(readFileSync(f.path)).toEqual(before); expect(readdirSync(f.root)).toEqual(names);
  const reopened = new DurableJournal(f.path, 'installation', false, reader.applicationId);
  try { expect(reopened.get('original')).toEqual({ state: 'unknown', privateContext: 'retained-private-fixture-value' }); } finally { reopened.close(); }
});

test('actual VM physical and portable adoption require the corresponding reader without lowering the durable header', () => {
  const path = join(directory(), 'vm.sqlite'), vmReader = { ...reader, applicationId: 0x4a495456, formats: [1, 2, 3] };
  let store = new VmStore(path); store.enableVsockBindings(); store.close(); const image = snapshot(path);
  expect(() => observeS16LedgerImage(image, { ...vmReader, formats: [1] })).toThrow(expect.objectContaining({ code: 's16_ops_reader_unsupported' }));
  expect(observeS16LedgerImage(image, vmReader).readerVersion).toBe(2);
  store = new VmStore(path); store.enablePortableState(); store.close();
  snapshot(path);
  expect(() => observeS16LedgerImage(image, { ...vmReader, formats: [1, 2] })).toThrow(expect.objectContaining({ code: 's16_ops_reader_unsupported' }));
  expect(observeS16LedgerImage(image, vmReader).readerVersion).toBe(3); expect(readFileSync(path).readUInt32BE(60)).toBe(3);
});

test('historical browser zero header must be explicitly named; observing it cannot settle its original effect', () => {
  const path = join(directory(), 'browser.sqlite'), original = { id: 'action', revision: 1, actionHash: 'a'.repeat(64) };
  const state = browserContinuity(path, true, 'browser'); state.arm(original); state.close();
  const image = snapshot(path);
  expect(() => observeS16LedgerImage(image, reader)).toThrow(expect.objectContaining({ code: 's16_ops_reader_unsupported' }));
  expect(observeS16LedgerImage(image, { ...reader, applicationId: 0, formats: [0] }).readerVersion).toBe(0);
  const reopened = browserContinuity(path, false, 'browser'); try { expect(reopened.uncertain()).toEqual(original); } finally { reopened.close(); }
});

test.each(['-wal', '-shm', '-journal'])('any retained %s refuses rather than hashing a potentially stale main image or cleaning it', suffix => {
  const f = journal(), before = readFileSync(f.path), sidecar = f.path + suffix; writeFileSync(sidecar, 'retained', { mode: 0o600 });
  expect(() => observeS16LedgerImage(f.path, reader)).toThrow(expect.objectContaining({ code: 's16_ops_settlement_required' }));
  expect(readFileSync(sidecar, 'utf8')).toBe('retained'); expect(readFileSync(f.path)).toEqual(before);
});

test('a real open WAL writer refuses; an explicit SQLite snapshot is a self-contained image rather than proof of writer settlement', () => {
  const path = join(directory(), 'vm.sqlite'), store = new VmStore(path), vmReader = { ...reader, applicationId: 0x4a495456 };
  try {
    expect(() => observeS16LedgerImage(path, vmReader)).toThrow(expect.objectContaining({ code: 's16_ops_settlement_required' }));
    expect(observeS16LedgerImage(snapshot(path), vmReader).readerVersion).toBe(1);
    expect(() => observeS16LedgerImage(path, vmReader)).toThrow(expect.objectContaining({ code: 's16_ops_settlement_required' }));
  } finally { store.close(); }
});

test('missing files and parents are never created, and underlying paths do not enter safe errors', () => {
  const root = directory(), path = join(root, 'absent.sqlite'), names = readdirSync(root);
  expect(() => observeS16LedgerImage(path, reader)).toThrow(expect.objectContaining({ code: 's16_ops_continuity_unavailable' }));
  expect(() => observeS16LedgerImage(join(root, 'absent', 'file.sqlite'), reader)).toThrow();
  expect(existsSync(path)).toBe(false); expect(readdirSync(root)).toEqual(names);
  try { observeS16LedgerImage(path, reader); } catch (error) { expect(String(error)).not.toContain(root); }
});

test.each(['symlink', 'ancestor', 'hardlink', 'group', 'executable', 'owner', 'directory'] as const)('untrusted %s refuses without changing custody', kind => {
  const f = journal(), before = readFileSync(f.path); let path = f.path, expected = reader;
  if (kind === 'symlink') { path = join(f.root, 'alias'); symlinkSync(f.path, path); }
  if (kind === 'ancestor') { const parent = join(directory(), 'alias'); symlinkSync(f.root, parent); path = join(parent, 'model.sqlite'); }
  if (kind === 'hardlink') linkSync(f.path, join(f.root, 'alias'));
  if (kind === 'group') chmodSync(f.path, 0o640);
  if (kind === 'executable') chmodSync(f.path, 0o700);
  if (kind === 'owner') expected = { ...reader, ownerUid: reader.ownerUid + 1 };
  if (kind === 'directory') path = f.root;
  expect(() => observeS16LedgerImage(path, expected)).toThrow(expect.objectContaining({ code: 's16_ops_path_untrusted' }));
  expect(readFileSync(f.path)).toEqual(before);
});

test.each(['signature', 'truncated', 'page_size', 'page_count', 'version', 'application'] as const)('invalid or unsupported %s is refused before it can name a compatible image', kind => {
  const f = journal(), bytes = readFileSync(f.path);
  if (kind === 'signature') bytes[0] = 0;
  if (kind === 'page_size') bytes.writeUInt16BE(513, 16);
  if (kind === 'page_count') bytes.writeUInt32BE(0, 28);
  if (kind === 'version') bytes.writeUInt32BE(99, 60);
  if (kind === 'application') bytes.writeUInt32BE(123, 68);
  writeFileSync(f.path, kind === 'truncated' ? bytes.subarray(0, bytes.length - 1) : bytes);
  expect(() => observeS16LedgerImage(f.path, reader)).toThrow(expect.objectContaining({ code: ['version', 'application'].includes(kind) ? 's16_ops_reader_unsupported' : 's16_ops_image_invalid' }));
});

test('a sparse oversized ledger refuses before allocating or reading its content', () => {
  const f = journal(); truncateSync(f.path, 1_073_741_825);
  expect(() => observeS16LedgerImage(f.path, reader)).toThrow(expect.objectContaining({ code: 's16_ops_image_invalid' }));
});
