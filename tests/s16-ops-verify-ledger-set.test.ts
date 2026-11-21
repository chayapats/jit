import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableJournal } from '../src/s15/durable-journal';
import { VmStore } from '../src/s15/vm/store';
import { canonical } from '../src/s15/conversation/validation';
import { observeS16LedgerImage } from '../src/s16/operations/ledger-image';
import { captureS16LedgerSet, type S16LedgerSet } from '../src/s16/operations/ledger-set';
import { s16LedgerSetManifestHash, verifyS16LedgerSet, type S16LedgerSetVerification } from '../src/s16/operations/verify-ledger-set';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-verify-set-'))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const journal = new DurableJournal(join(root, 'model.sqlite'), 'installation', true, 0x4a4d5135); cleanup.push(() => journal.close());
  journal.tx(() => journal.put('original', { state: 'unknown', usage: 9 }));
  const vm = new VmStore(join(root, 'vm.sqlite')); cleanup.push(() => vm.close()); vm.enablePortableState();
  const directory = join(root, 'points'); mkdirSync(directory, { mode: 0o700 });
  const sources = [{ name: 'a_b.sqlite', database: vm.db, reader: { applicationId: 0x4a495456, formats: [1, 2, 3] } },
    { name: 'a-b.sqlite', database: journal.db, reader: { applicationId: 0x4a4d5135, formats: [1] } }];
  const manifest = captureS16LedgerSet({ directory, id: 'a'.repeat(32), installationId: 'installation', guard() {}, sources });
  const options: S16LedgerSetVerification = { directory, id: manifest.id, installationId: manifest.installationId, manifestSha256: s16LedgerSetManifestHash(manifest), readers: sources.map(({ name, reader }) => ({ name, reader })) };
  return { root, vm, journal, manifest, options, target: join(directory, options.id) };
}

test('an independently retained receipt verifies exact owning images and canonical alias order without touching original state', () => {
  const f = fixture(), before = f.journal.get('original'), files = f.manifest.images.map(row => readFileSync(join(f.target, row.name)));
  expect(f.manifest.images.map(row => row.name)).toEqual(['a-b.sqlite', 'a_b.sqlite']);
  expect(new Bun.CryptoHasher('sha256').update(readFileSync(join(f.target, 'manifest.json'))).digest('hex')).toBe(f.options.manifestSha256);
  expect(verifyS16LedgerSet(f.options)).toEqual(f.manifest); expect(f.journal.get('original')).toEqual(before);
  expect(f.vm.db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 });
  expect(f.manifest.images.map(row => readFileSync(join(f.target, row.name)))).toEqual(files);
});

test.each(['manifest', 'image', 'missing', 'extra', 'symlink', 'installation', 'receipt', 'readers', 'unsupported'] as const)('a changed %s refuses without fallback, source writes or reconstructed empty state', kind => {
  const f = fixture(), file = join(f.target, 'a_b.sqlite');
  if (kind === 'manifest') writeFileSync(join(f.target, 'manifest.json'), readFileSync(join(f.target, 'manifest.json'), 'utf8') + '\n');
  if (kind === 'image') { const bytes = readFileSync(file); bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 1; writeFileSync(file, bytes); }
  if (kind === 'missing') unlinkSync(file);
  if (kind === 'extra') writeFileSync(join(f.target, 'unexpected'), 'not part of the point', { mode: 0o600 });
  if (kind === 'symlink') { unlinkSync(file); symlinkSync(join(f.root, 'vm.sqlite'), file); }
  if (kind === 'installation') f.options.installationId = 'different';
  if (kind === 'receipt') f.options.manifestSha256 = '0'.repeat(64);
  if (kind === 'readers') f.options.readers = f.options.readers.slice(0, 1);
  if (kind === 'unsupported') f.options.readers = f.options.readers.map(reader => ({ ...reader, reader: { ...reader.reader, formats: [1] } }));
  expect(() => verifyS16LedgerSet(f.options)).toThrow(); expect(f.journal.get('original')).toEqual({ state: 'unknown', usage: 9 });
  expect(f.vm.db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 });
  if (kind === 'missing') expect(existsSync(file)).toBe(false);
});

function retainLegacyCandidate(f: ReturnType<typeof fixture>, manifest: S16LedgerSet) {
  // Models a trusted receipt from a defective older capturer; hashes alone must still not bypass image checks.
  writeFileSync(join(f.target, 'manifest.json'), canonical(manifest)); f.options.manifestSha256 = s16LedgerSetManifestHash(manifest);
}

test('even a hash-matching historical WAL image refuses before SQLite can create sidecars', () => {
  const f = fixture(), file = join(f.target, 'a_b.sqlite'), bytes = readFileSync(file); bytes[18] = 2; bytes[19] = 2; writeFileSync(file, bytes);
  retainLegacyCandidate(f, { ...f.manifest, images: f.manifest.images.map(row => row.name === 'a_b.sqlite' ? { ...row, journalMode: 'wal', sha256: new Bun.CryptoHasher('sha256').update(bytes).digest('hex') } : row) });
  expect(() => verifyS16LedgerSet(f.options)).toThrow(expect.objectContaining({ code: 's16_ops_point_integrity_failed' }));
  expect(existsSync(file + '-wal')).toBe(false); expect(existsSync(file + '-shm')).toBe(false);
});

test('matching hashes cannot certify an orphaned foreign key in a historical control image', () => {
  const f = fixture(), file = join(f.target, 'a-b.sqlite'), db = new Database(file, { readwrite: true, create: false });
  try { db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES (1)'); } finally { db.close(true); }
  const image = observeS16LedgerImage(file, { applicationId: 0x4a4d5135, formats: [1], ownerUid: process.getuid!() });
  const manifest = { ...f.manifest, images: f.manifest.images.map(row => row.name === 'a-b.sqlite' ? { ...image, name: row.name } : row) };
  manifest.bytes = manifest.images.reduce((total, row) => total + row.bytes, 0); retainLegacyCandidate(f, manifest);
  expect(() => verifyS16LedgerSet(f.options)).toThrow(expect.objectContaining({ code: 's16_ops_point_integrity_failed' }));
  expect(f.journal.get('original')).toEqual({ state: 'unknown', usage: 9 });
});
