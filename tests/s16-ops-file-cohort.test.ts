import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { readS15RuntimeConfig } from '../src/s15/runtime-config';
import { FileStore } from '../src/s16/files/store';
import { openS16ControlMaintenance, type S16ControlMaintenance } from '../src/s16/operations/control-maintenance';
import { captureS16PayloadSet, s16PayloadSetManifestHash, verifyS16PayloadSet } from '../src/s16/operations/payload-set';
import { binaryRuntime, launchPdf } from './fixtures/s16-binary';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (bytes: Uint8Array | string) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
async function fixture(kind: 'none' | 'text' | 'binary' = 'text') {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-file-cohort-'))); cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const directory = join(parent, 'state'), configPath = join(parent, 'config.json');
  writeFileSync(configPath, JSON.stringify({ ...s15StageConfig(directory, 'http://localhost:3041'), ...(kind === 'none' ? {} : { files: kind === 'text' ? true : { parserImage: 'localhost/jit-parser@sha256:' + 'a'.repeat(64), imageProbes: [] } }) }), { mode: 0o600 });
  const child = Bun.spawn([process.execPath, 'src/main.ts', 'init', '--s15', '--config', configPath], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]); expect({ exit, error }).toEqual({ exit: 0, error: '' });
  const config = readS15RuntimeConfig(configPath), initial = openS16ControlMaintenance(config), ownerId = initial.ownerIdentity; initial.close();
  const context = () => { const ctx = openS16ControlMaintenance(config); cleanup.push(() => ctx.close()); return ctx; };
  return { parent, directory, config, ownerId, context, data: join(directory, 'runtime/file-bytes'), parser: join(directory, 'runtime/file-parser') };
}
async function ready(f: Awaited<ReturnType<typeof fixture>>) {
  const store = new FileStore({ path: join(f.directory, 'runtime/files.sqlite'), directory: f.data, installationId: f.config.installationId, create: false, resource: { id: 'computer', revision: 1, generation: 1 }, requireOwner: () => ({ id: f.ownerId, generation: 1 }) });
  try { const bytes = Buffer.from('current private input\n'), upload = store.create({} as never, { requestId: 'ready_original', conversationId: 'conversation', name: 'notes.txt', bytes: bytes.length, sha256: hash(bytes) }); await store.write({} as never, upload.id, new Blob([bytes]).stream()); return upload.id; } finally { await store.close(); }
}
async function interrupt(f: Awaited<ReturnType<typeof fixture>>, mode: 'uploading' | 'validating') {
  const child = Bun.spawn([process.execPath, 'tests/fixtures/s16-file-custody-process.ts', f.directory, f.config.installationId, f.ownerId, mode], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader(), timer = setTimeout(() => child.kill('SIGKILL'), 5000);
  try { const chunk = await reader.read(); expect(chunk.done).toBe(false); const value = JSON.parse(Buffer.from(chunk.value!).toString()); expect(value.state).toBe(mode); return value.id as string; }
  finally { clearTimeout(timer); child.kill('SIGKILL'); await child.exited; await reader.cancel(); reader.releaseLock(); const error = await new Response(child.stderr).text(); expect(error).toBe(''); }
}
const db = (ctx: S16ControlMaintenance) => ctx.runtime.sources.find(source => source.name === 'files.sqlite')!.database;

test('actual selected FILE input remains owning-pinned while current cut and payload capture preserve bytes and exclude host paths', async () => {
  const f = await fixture(), id = await ready(f), ctx = f.context(), before = readFileSync(join(f.data, id + '.blob')), cut = ctx.fileCustody();
  expect(cut.value.files).toHaveLength(1); expect(cut.value.files[0]).toMatchObject({ role: 'original', trust: 'owning_pinned', rowId: id, state: 'ready', sha256: hash(before) });
  expect(cut.value.pending).toEqual([]); expect(cut.value.parser.present).toBe(false); expect(JSON.stringify(cut.value)).not.toContain(f.directory); expect(Object.isFrozen(cut.value.files[0])).toBe(true);
  const directory = join(f.parent, 'payloads'); mkdirSync(directory, { mode: 0o700 }); const options = { directory, id: 'a'.repeat(32), installationId: f.config.installationId, sources: cut.sources, guard: ctx.assertCurrent }, manifest = captureS16PayloadSet(options);
  verifyS16PayloadSet({ ...options, files: manifest.files, manifestSha256: s16PayloadSetManifestHash(manifest) }); cut.assertCurrent(); expect(readFileSync(join(f.data, id + '.blob'))).toEqual(before);
});

test.each(['uploading', 'validating'] as const)('actual SIGKILL retains %s original bytes and parser uncertainty without boot recovery or output promotion', async mode => {
  const f = await fixture(mode === 'validating' ? 'binary' : 'text'), id = await interrupt(f, mode), ctx = f.context(), journal = db(ctx), changes = journal.query<{ n: number }, []>('SELECT total_changes() n').get()!.n;
  const before = readFileSync(join(f.data, id + '.part')), cut = ctx.fileCustody();
  expect(cut.value.pending).toEqual([{ id, state: mode }]); expect(cut.value.files.every(row => row.trust === 'untrusted')).toBe(true); expect(cut.value.files.filter(row => row.rowId === id)).toHaveLength(1);
  if (mode === 'validating') { expect(cut.value.parser.jobs).toHaveLength(1); expect(cut.value.parser.container).toMatchObject({ originalJobId: null, generation: null, settlement: 'unobserved' }); expect(cut.value.files.map(row => row.role).sort()).toEqual(['parser_input', 'parser_output', 'parser_output', 'upload_fragment']); }
  else expect(cut.value.files[0]!.bytes).toBe(4);
  cut.assertCurrent(); expect(journal.query<{ n: number }, []>('SELECT total_changes() n').get()!.n).toBe(changes); expect(JSON.parse(journal.query<{ json: string }, [string]>('SELECT json FROM records WHERE id=?').get(id)!.json).state).toBe(mode); expect(readFileSync(join(f.data, id + '.part'))).toEqual(before);
  const directory = join(f.parent, 'pending-payloads'); mkdirSync(directory, { mode: 0o700 }); const manifest = captureS16PayloadSet({ directory, id: 'b'.repeat(32), installationId: f.config.installationId, sources: cut.sources, guard: ctx.assertCurrent });
  expect(manifest.files).toHaveLength(cut.value.files.length); cut.assertCurrent();
});

test('absent unselected FILE remains absent and original observations fail after context close', async () => {
  const f = await fixture('none'), ctx = f.context(), cut = ctx.fileCustody(); expect(cut.value.present).toBe(false); expect(cut.sources).toEqual([]); cut.assertCurrent(); expect(existsSync(f.data)).toBe(false); expect(existsSync(f.parser)).toBe(false); ctx.close(); expect(() => cut.assertCurrent()).toThrow();
});

test('current protected references retain exact FILE pins after directory loss without completing a backup or rewriting current SQL', async () => {
  const f = await fixture(), id = await ready(f), ctx = f.context(), before = ctx.sources.map(row => row.database.serialize()), cut = ctx.currentPayloadReferences();
  expect(cut.value.file!.files).toEqual([{ name: id + '.blob', rowId: id, role: 'original', bytes: 22, sha256: hash('current private input\n') }]);
  renameSync(f.data, f.data + '.retained'); cut.assertCurrent(); expect(ctx.currentPayloadReferences().value).toEqual(cut.value);
  expect(() => ctx.fileCustody()).toThrow(); expect(existsSync(f.data)).toBe(false); expect(ctx.sources.map(row => row.database.serialize())).toEqual(before);
  expect(JSON.stringify(cut.value)).not.toContain(f.directory); expect(Object.isFrozen(cut.value.file!.files[0])).toBe(true);
});

test('current FILE withdrawal in a WAL invalidates old recovery references while preserving pending and other current authority', async () => {
  const f = await fixture(), id = await ready(f), path = join(f.directory, 'runtime/files.sqlite'), setup = new Database(path, { readwrite: true, create: false });
  try { setup.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0'); } finally { setup.close(true); }
  const ctx = f.context(), cut = ctx.currentPayloadReferences(), journal = db(ctx), before = readFileSync(path);
  journal.exec("UPDATE records SET json=json_set(json,'$.state','withdrawn') WHERE json_extract(json,'$.kind')='upload'");
  expect(readFileSync(path)).toEqual(before); ctx.assertCurrent(); expect(() => cut.assertCurrent()).toThrow('s16_ops_references_changed');
  const fresh = ctx.currentPayloadReferences(); expect(fresh.value.file!.files).toEqual([]); expect(fresh.value.file!.pending).toEqual([]); fresh.assertCurrent();
  expect(JSON.parse(journal.query<{ json: string }, [string]>('SELECT json FROM records WHERE id=?').get(id)!.json).state).toBe('withdrawn');
  journal.exec('BEGIN'); try { expect(() => fresh.assertCurrent()).toThrow('s16_ops_sources_busy'); } finally { journal.exec('ROLLBACK'); }
});

test('absent FILE reference source stays absent and stale current-reference capabilities refuse after retirement', async () => {
  const f = await fixture('none'), ctx = f.context(), cut = ctx.currentPayloadReferences();
  expect(cut.value.file).toBeNull(); expect(cut.value.github.bundles).toEqual([]); cut.assertCurrent(); expect(existsSync(f.data)).toBe(false);
  ctx.retireSources(); ctx.assertExclusion(); expect(() => cut.assertCurrent()).toThrow(); expect(() => ctx.currentPayloadReferences()).toThrow();
});

test('owning withdrawal and staged artifact metadata remain distinct from untrusted terminal leftovers', async () => {
  const f = await fixture(), id = await ready(f), path = join(f.data, id + '.blob'), original = readFileSync(path);
  const store = new FileStore({ path: join(f.directory, 'runtime/files.sqlite'), directory: f.data, installationId: f.config.installationId, create: false, resource: { id: 'computer', revision: 1, generation: 1 }, requireOwner: () => ({ id: f.ownerId, generation: 1 }) });
  let artifactId = '';
  try { artifactId = store.stageArtifact({} as never, { id: 'staged_candidate', requestId: 'uncommitted', workId: 'work', conversationId: 'conversation', name: 'draft.md', text: 'Unpublished artifact\n', inputs: [{ id, sha256: hash(original) }] }).id; store.withdraw({} as never, id); } finally { await store.close(); }
  // Simulate a retained interrupted unlink after the owning withdrawal committed.
  writeFileSync(path, original, { mode: 0o600 }); const ctx = f.context(), cut = ctx.fileCustody();
  expect(cut.value.files.find(row => row.rowId === id)).toMatchObject({ state: 'withdrawn', trust: 'untrusted', role: 'unpublished_original' });
  expect(cut.value.files.find(row => row.rowId === artifactId)).toMatchObject({ state: 'artifact_metadata', trust: 'owning_pinned', role: 'artifact' });
  cut.assertCurrent(); expect(JSON.parse(db(ctx).query<{ json: string }, [string]>('SELECT json FROM records WHERE id=?').get(id)!.json).state).toBe('withdrawn');
});

test('bounded partial parser snapshots remain unobserved and an extra job refuses without cleanup', async () => {
  const f = await fixture('binary');
  for (let i = 0; i < 64; i++) mkdirSync(join(f.parser, 'job-' + String(i).padStart(6, '0')), { mode: 0o700 });
  const ctx = f.context(), cut = ctx.fileCustody(); expect(cut.value.parser.jobs).toHaveLength(64); expect(cut.sources).toEqual([]); cut.assertCurrent();
  mkdirSync(join(f.parser, 'job-overflow'), { mode: 0o700 }); expect(() => ctx.fileCustody()).toThrow(); expect(readdirSync(f.parser)).toHaveLength(65);
});

test('unused but unowned FILE bytes cannot become an empty successful cohort', async () => {
  const f = await fixture('none'); mkdirSync(f.data, { mode: 0o700 }); writeFileSync(join(f.data, 'unowned.blob'), 'unowned', { mode: 0o600 });
  const ctx = f.context(); expect(() => ctx.fileCustody()).toThrow(); expect(readFileSync(join(f.data, 'unowned.blob'), 'utf8')).toBe('unowned');
});

test.each(['content', 'inode', 'extra', 'parser-absence'] as const)('original cut refuses changed %s without replacing its expected hash', async kind => {
  const f = await fixture(), id = await ready(f), ctx = f.context(), cut = ctx.fileCustody(), path = join(f.data, id + '.blob');
  if (kind === 'content') writeFileSync(path, 'changed input\n', { mode: 0o600 });
  if (kind === 'inode') { renameSync(path, path + '.old'); writeFileSync(path, readFileSync(path + '.old'), { mode: 0o600 }); unlinkSync(path + '.old'); }
  if (kind === 'extra') writeFileSync(join(f.data, 'unowned.part'), 'unowned', { mode: 0o600 });
  if (kind === 'parser-absence') mkdirSync(f.parser, { mode: 0o700 });
  expect(() => cut.assertCurrent()).toThrow(); expect(cut.sha256).toMatch(/^[a-f0-9]{64}$/);
});

test.each(['unknown', 'symlink', 'hardlink', 'mode', 'size', 'missing', 'parser-name', 'parser-size', 'parser-missing'] as const)('unsafe or incomplete %s custody refuses without initialization or cleanup', async kind => {
  const f = await fixture('binary'), id = await interrupt(f, 'validating'), original = join(f.data, id + '.part'), job = join(f.parser, readdirSync(f.parser)[0]!);
  if (kind === 'unknown') writeFileSync(join(f.data, 'unknown.part'), 'unowned', { mode: 0o600 });
  if (kind === 'symlink') { unlinkSync(original); symlinkSync(join(job, 'in/input'), original); }
  if (kind === 'hardlink') linkSync(original, join(f.parent, 'alias'));
  if (kind === 'mode') chmodSync(original, 0o644);
  if (kind === 'size') truncateSync(original, 1048577);
  if (kind === 'missing') unlinkSync(original);
  if (kind === 'parser-name') writeFileSync(join(job, 'out/unknown'), 'unowned', { mode: 0o600 });
  if (kind === 'parser-size') truncateSync(join(job, 'out/text.txt'), 2097153);
  if (kind === 'parser-missing') renameSync(f.parser, f.parser + '.retained');
  const ctx = f.context(); expect(() => ctx.fileCustody()).toThrow(); expect(() => ctx.currentFileCustody()).toThrow(); expect(existsSync(job) || existsSync(f.parser + '.retained')).toBe(true);
});

test('damaged current FILE custody records exact absent pins and original identities without creating bytes or changing current SQL', async () => {
  const f = await fixture(), id = await ready(f), ctx = f.context(), before = ctx.sources.map(row => row.database.serialize());
  renameSync(f.data, f.data + '.retained'); const cut = ctx.currentFileCustody();
  expect(cut.value.contract).toBe('s16-current-file-custody/v1'); expect(cut.value.files).toEqual([]); expect(cut.sources).toEqual([]);
  expect(cut.value.missing).toEqual([{ name: id + '.blob', rowId: id, role: 'original', bytes: 22, sha256: hash('current private input\n') }]);
  expect(cut.entries).toContainEqual({ path: f.data, kind: 'absent', sha256: null });
  expect(cut.entries).toContainEqual({ path: join(f.data, id + '.blob'), kind: 'absent', sha256: null });
  expect(Object.isFrozen(cut.entries[0])).toBe(true); expect(Object.isFrozen(cut.value.missing[0])).toBe(true); expect(JSON.stringify(cut.value)).not.toContain(f.directory);
  cut.assertCurrent(); expect(existsSync(f.data)).toBe(false); expect(() => ctx.fileCustody()).toThrow(); expect(ctx.sources.map(row => row.database.serialize())).toEqual(before);
  ctx.close(); expect(() => cut.assertCurrent()).toThrow();
});

test('damaged FILE custody preserves withdrawn leftovers and actual interrupted pending bytes while missing artifact metadata stays inert', async () => {
  const f = await fixture(), id = await ready(f), original = readFileSync(join(f.data, id + '.blob'));
  const store = new FileStore({ path: join(f.directory, 'runtime/files.sqlite'), directory: f.data, installationId: f.config.installationId, create: false, resource: { id: 'computer', revision: 1, generation: 1 }, requireOwner: () => ({ id: f.ownerId, generation: 1 }) });
  let artifact = '';
  try { artifact = store.stageArtifact({} as never, { id: 'missing_staged', requestId: 'never_published', workId: 'work', conversationId: 'conversation', name: 'draft.md', text: 'Inert current artifact\n', inputs: [{ id, sha256: hash(original) }] }).id; store.withdraw({} as never, id); } finally { await store.close(); }
  writeFileSync(join(f.data, id + '.blob'), original, { mode: 0o600 }); unlinkSync(join(f.data, artifact + '.blob'));
  const pending = await interrupt(f, 'uploading'), ctx = f.context(), before = ctx.sources.map(row => row.database.serialize()), cut = ctx.currentFileCustody();
  expect(cut.value.files.find(row => row.rowId === id)).toMatchObject({ state: 'withdrawn', role: 'unpublished_original', trust: 'untrusted' });
  expect(cut.value.files.find(row => row.rowId === pending)).toMatchObject({ state: 'uploading', role: 'upload_fragment', trust: 'untrusted', bytes: 4 });
  expect(cut.value.pending).toEqual([{ id: pending, state: 'uploading' }]); expect(cut.value.missing.map(row => [row.rowId, row.role])).toEqual([[artifact, 'artifact']]);
  cut.assertCurrent(); expect(ctx.sources.map(row => row.database.serialize())).toEqual(before); expect(readFileSync(join(f.data, id + '.blob'))).toEqual(original); expect(() => ctx.fileCustody()).toThrow();
});

test('actual parser ready representation can be missing while its current original remains pinned and parser continuity stays mandatory', async () => {
  const f = await fixture('binary'), store = new FileStore({ path: join(f.directory, 'runtime/files.sqlite'), directory: f.data, installationId: f.config.installationId, create: false, resource: { id: 'computer', revision: 1, generation: 1 }, parserRuntime: binaryRuntime(), requireOwner: () => ({ id: f.ownerId, generation: 1 }) });
  let id = '';
  try { const bytes = launchPdf(), upload = store.create({} as never, { requestId: 'ready_pdf', conversationId: 'conversation', name: 'notes.pdf', bytes: bytes.length, sha256: hash(bytes) }); const result = await store.write({} as never, upload.id, new Blob([new Uint8Array(bytes)]).stream()); expect(result.state).toBe('ready'); id = result.id; } finally { await store.close(); }
  const derived = join(f.data, id + '.blob.derived'); unlinkSync(derived); const ctx = f.context(), cut = ctx.currentFileCustody();
  expect(cut.value.files.map(row => row.role)).toEqual(['original']); expect(cut.value.missing.map(row => [row.name, row.role])).toEqual([[id + '.blob.derived', 'representation']]); cut.assertCurrent();
  expect(() => ctx.fileCustody()).toThrow(); renameSync(f.parser, f.parser + '.retained'); expect(() => ctx.currentFileCustody()).toThrow('s16_ops_file_parser_missing'); expect(existsSync(f.parser)).toBe(false);
});

test.each(['replacement', 'repair', 'extra', 'metadata'] as const)('original current FILE custody refuses %s rather than accepting a changed preparation', async kind => {
  const f = await fixture(), id = await ready(f), path = join(f.data, id + '.blob'), bytes = readFileSync(path);
  if (kind === 'repair') unlinkSync(path); const ctx = f.context(), cut = ctx.currentFileCustody();
  if (kind === 'replacement') { renameSync(path, path + '.old'); writeFileSync(path, bytes, { mode: 0o600 }); unlinkSync(path + '.old'); }
  if (kind === 'repair') writeFileSync(path, bytes, { mode: 0o600 });
  if (kind === 'extra') writeFileSync(join(f.data, 'unknown.part'), '', { mode: 0o600 });
  if (kind === 'metadata') db(ctx).exec("UPDATE records SET json=json_set(json,'$.state','withdrawn') WHERE json_extract(json,'$.kind')='upload'");
  expect(() => cut.assertCurrent()).toThrow();
});

test('selected current FILE SQL cannot disappear into an empty damaged-byte observation', async () => {
  const f = await fixture(), id = await ready(f), path = join(f.directory, 'runtime/files.sqlite'); renameSync(path, path + '.retained');
  expect(() => f.context()).toThrow('s16_ops_continuity_unavailable');
  expect(existsSync(path)).toBe(false); expect(readFileSync(join(f.data, id + '.blob'), 'utf8')).toBe('current private input\n');
});

test('current FILE custody rereads WAL-only metadata and refuses a transaction without its actual writer cut', async () => {
  const f = await fixture(), id = await ready(f), path = join(f.directory, 'runtime/files.sqlite'), setup = new Database(path, { readwrite: true, create: false });
  try { setup.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0'); } finally { setup.close(true); }
  const ctx = f.context(), source = db(ctx), cut = ctx.currentFileCustody(), before = readFileSync(source.filename);
  source.exec("UPDATE records SET json=json_set(json,'$.name','renamed.txt') WHERE id='" + id + "'");
  expect(readFileSync(source.filename)).toEqual(before); expect(() => cut.assertCurrent()).toThrow('s16_ops_file_changed');
  source.exec('BEGIN'); try { expect(() => ctx.currentFileCustody()).toThrow('s16_ops_sources_busy'); } finally { source.exec('ROLLBACK'); }
});
