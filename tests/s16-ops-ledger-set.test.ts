import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppError } from '../src/errors';
import { DurableJournal } from '../src/s15/durable-journal';
import { VmStore } from '../src/s15/vm/store';
import { captureS16LedgerSet, type S16LedgerSetOptions } from '../src/s16/operations/ledger-set';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-ledger-set-'))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const journal = new DurableJournal(join(root, 'model.sqlite'), 'installation', true, 0x4a4d5135); cleanup.push(() => journal.close());
  journal.tx(() => journal.put('original', { state: 'unknown', usage: 7, privateScope: 'bot', body: 'fixture-private-control' }));
  const vm = new VmStore(join(root, 'vm.sqlite')); cleanup.push(() => vm.close()); vm.enablePortableState();
  const directory = join(root, 'points'); mkdirSync(directory, { mode: 0o700 });
  const options: S16LedgerSetOptions = { directory, installationId: 'installation', id: 'a'.repeat(32), now: () => 123, guard() {}, sources: [
    { name: 'vm.sqlite', database: vm.db, reader: { applicationId: 0x4a495456, formats: [1, 2, 3] } },
    { name: 'model.sqlite', database: journal.db, reader: { applicationId: 0x4a4d5135, formats: [1] } },
  ] };
  return { root, directory, journal, vm, options, target: join(directory, options.id) };
}
function image(path: string) { const db = new Database(path, { readonly: true, create: false }); cleanup.push(() => db.close()); return db; }

test('owning model/VM handles produce exact private images of one SQLite cut without changing original unknown/usage/private custody', () => {
  const f = fixture(), before = f.journal.get('original'), manifest = captureS16LedgerSet(f.options);
  expect(manifest).toMatchObject({ contract: 's16-ledger-set/v1', scope: 'caller_selected_ledgers', validation: 'sqlite_integrity_and_image_hashes', installationId: 'installation', capturedAt: 123 });
  expect(manifest.images.map(row => row.name)).toEqual(['model.sqlite', 'vm.sqlite']);
  expect(manifest.bytes).toBe(manifest.images.reduce((total, row) => total + row.bytes, 0));
  for (const row of manifest.images) { const bytes = readFileSync(join(f.target, row.name)); expect(bytes.length).toBe(row.bytes); expect(new Bun.CryptoHasher('sha256').update(bytes).digest('hex')).toBe(row.sha256); }
  const saved = image(join(f.target, 'model.sqlite')).query<{ json: string }, []>("SELECT json FROM records WHERE id='original'").get(); expect(JSON.parse(saved!.json)).toEqual(before);
  expect(image(join(f.target, 'vm.sqlite')).query('PRAGMA user_version').get()).toEqual({ user_version: 3 });
  expect(readFileSync(join(f.target, 'vm.sqlite'))[18]).toBe(1); expect(readFileSync(join(f.root, 'vm.sqlite'))[18]).toBe(2);
  expect(f.vm.db.query('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' });
  expect(f.journal.get('original')).toEqual(before); expect(f.vm.db.inTransaction).toBe(false); expect(f.journal.db.inTransaction).toBe(false);
  const text = readFileSync(join(f.target, 'manifest.json'), 'utf8'); expect(JSON.parse(text)).toEqual(manifest); expect(text).not.toContain(f.root); expect(text).not.toContain('fixture-private-control');
});

test('a competing writer refuses the complete batch, releases earlier reservations and creates no point', () => {
  const f = fixture(), other = new Database(join(f.root, 'vm.sqlite'), { readwrite: true, create: false }); cleanup.push(() => other.close()); other.exec('BEGIN IMMEDIATE');
  expect(() => captureS16LedgerSet(f.options)).toThrow(expect.objectContaining({ code: 's16_ops_source_busy' }));
  expect(existsSync(f.target)).toBe(false); expect(f.journal.db.inTransaction).toBe(false); expect(f.vm.db.inTransaction).toBe(false);
  other.exec('ROLLBACK'); expect(captureS16LedgerSet(f.options).images.length).toBe(2);
});

test('a current guard failure after one durable image leaves no published manifest or held source transaction', () => {
  const f = fixture();
  f.options.guard = () => { if (existsSync(join(f.target, 'model.sqlite'))) throw new AppError('fixture_current_authority_lost', 403); };
  expect(() => captureS16LedgerSet(f.options)).toThrow(expect.objectContaining({ code: 'fixture_current_authority_lost' }));
  expect(existsSync(join(f.target, 'model.sqlite'))).toBe(true); expect(existsSync(join(f.target, 'manifest.json'))).toBe(false);
  expect(f.journal.db.inTransaction).toBe(false); expect(f.vm.db.inTransaction).toBe(false);
  f.options.guard = () => {};
  expect(() => captureS16LedgerSet(f.options)).toThrow(expect.objectContaining({ code: 's16_ops_point_unavailable' }));
});

test('reader and size refusals precede image allocation/publication and preserve source transactions', () => {
  const f = fixture();
  expect(() => captureS16LedgerSet({ ...f.options, maxBytes: 512 })).toThrow(expect.objectContaining({ code: 's16_ops_capture_bounds' })); expect(existsSync(f.target)).toBe(false);
  f.options.sources[0]!.reader.formats = [1, 2];
  expect(() => captureS16LedgerSet(f.options)).toThrow(expect.objectContaining({ code: 's16_ops_reader_unsupported' })); expect(existsSync(f.target)).toBe(false);
  expect(f.journal.db.inTransaction).toBe(false); expect(f.vm.db.inTransaction).toBe(false);
});

test('foreign-key corruption in an owning source refuses instead of certifying a hash-only backup', () => {
  const f = fixture(); f.journal.db.exec('CREATE TABLE parent (id INTEGER PRIMARY KEY); CREATE TABLE child (id INTEGER REFERENCES parent(id)); INSERT INTO child VALUES (1)');
  expect(() => captureS16LedgerSet(f.options)).toThrow(expect.objectContaining({ code: 's16_ops_continuity_invalid' })); expect(existsSync(f.target)).toBe(false);
  expect(f.journal.db.inTransaction).toBe(false);
});

test('existing IDs and duplicate source aliases/handles never overwrite an earlier image or manifest', () => {
  const f = fixture(); captureS16LedgerSet(f.options); const before = readFileSync(join(f.target, 'manifest.json'));
  expect(() => captureS16LedgerSet(f.options)).toThrow(expect.objectContaining({ code: 's16_ops_point_unavailable' })); expect(readFileSync(join(f.target, 'manifest.json'))).toEqual(before);
  expect(() => captureS16LedgerSet({ ...f.options, id: 'b'.repeat(32), sources: [f.options.sources[0]!, f.options.sources[0]!] })).toThrow(expect.objectContaining({ code: 's16_ops_capture_invalid' }));
  expect(existsSync(join(f.directory, 'b'.repeat(32)))).toBe(false); expect(f.vm.db.inTransaction).toBe(false);
});

test('a pre-existing owning transaction is refused without rolling it back or closing its connection', () => {
  const f = fixture(); f.vm.db.exec('BEGIN IMMEDIATE');
  try {
    expect(() => captureS16LedgerSet(f.options)).toThrow(expect.objectContaining({ code: 's16_ops_source_busy' }));
    expect(f.vm.db.inTransaction).toBe(true); expect(f.journal.db.inTransaction).toBe(false); expect(existsSync(f.target)).toBe(false);
  } finally { f.vm.db.exec('ROLLBACK'); }
});

test.each(['read-only', 'query-only'] as const)('a %s handle cannot claim the simultaneous writer cut merely by accepting BEGIN IMMEDIATE', mode => {
  const f = fixture(), readonly = new Database(join(f.root, 'model.sqlite'), { readonly: mode === 'read-only', readwrite: mode === 'query-only', create: false }); cleanup.push(() => readonly.close(true));
  if (mode === 'query-only') readonly.exec('PRAGMA query_only=ON');
  const sources = f.options.sources.map(source => source.name === 'model.sqlite' ? { ...source, database: readonly } : source);
  expect(() => captureS16LedgerSet({ ...f.options, sources })).toThrow(expect.objectContaining({ code: 's16_ops_source_not_writable' })); expect(existsSync(join(f.target, 'manifest.json'))).toBe(false);
  expect(readonly.inTransaction).toBe(false); expect(f.journal.get('original')).toMatchObject({ state: 'unknown', usage: 7, privateScope: 'bot' });
});

test('an independent process cannot acquire either actual main writer while the simultaneous owning cut is held', () => {
  const f = fixture(); let observed = false;
  f.options.guard = () => {
    if (observed || !f.vm.db.inTransaction || !f.journal.db.inTransaction) return; observed = true;
    const code = `import {Database} from 'bun:sqlite'; for(const path of JSON.parse(process.env.JIT_OPS_PROBE_PATHS!)){const db=new Database(path,{readwrite:true,create:false}); try{db.exec('PRAGMA busy_timeout=0; BEGIN IMMEDIATE'); console.log('incorrectly_acquired'); db.exec('ROLLBACK');}catch{console.log('busy');}finally{db.close(true);}}`;
    const child = Bun.spawnSync([process.execPath, '-e', code], { env: { ...process.env, JIT_OPS_PROBE_PATHS: JSON.stringify([join(f.root, 'model.sqlite'), join(f.root, 'vm.sqlite')]) }, stdout: 'pipe', stderr: 'pipe' });
    expect({ exit: child.exitCode, out: child.stdout.toString(), error: child.stderr.toString() }).toEqual({ exit: 0, out: 'busy\nbusy\n', error: '' });
  };
  expect(captureS16LedgerSet(f.options).images).toHaveLength(2); expect(observed).toBe(true); expect(f.journal.get('original')).toMatchObject({ state: 'unknown', usage: 7, privateScope: 'bot' });
});

test('attached persisted databases cannot disappear from the selected cut', () => {
  const f = fixture(); f.vm.db.exec(`ATTACH DATABASE '${join(f.root, 'additional.sqlite').replaceAll("'", "''")}' AS additional`);
  expect(() => captureS16LedgerSet(f.options)).toThrow(expect.objectContaining({ code: 's16_ops_attached_unsupported' }));
  expect(existsSync(f.target)).toBe(false); expect(f.journal.db.inTransaction).toBe(false);
});

test('an asynchronous current guard cannot be mistaken for a synchronous authority check', () => {
  const f = fixture(); f.options.guard = async () => {};
  expect(() => captureS16LedgerSet(f.options)).toThrow(expect.objectContaining({ code: 's16_ops_capture_invalid' }));
  expect(existsSync(f.target)).toBe(false); expect(f.vm.db.inTransaction).toBe(false);
});

test('an unexpectedly closed source reports unknown release and never publishes a manifest', () => {
  const f = fixture(); f.options.guard = () => { if (existsSync(join(f.target, 'model.sqlite'))) f.journal.db.close(true); };
  expect(() => captureS16LedgerSet(f.options)).toThrow(expect.objectContaining({ code: 's16_ops_source_release_unknown' }));
  expect(existsSync(join(f.target, 'manifest.json'))).toBe(false); expect(f.vm.db.inTransaction).toBe(false);
});
