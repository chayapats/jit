import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { readS15RuntimeConfig } from '../src/s15/runtime-config';
import { GithubBundleStore } from '../src/s15/github/artifacts';
import { GithubStore } from '../src/s15/github/store';
import type { Ref } from '../src/s15/policy';
import { DurableJournal } from '../src/s15/durable-journal';
import { digest as policyDigest } from '../src/s15/policy/validation';
import { captureS16GithubArtifacts } from '../src/s15/github/maintenance';
import { openS16ControlMaintenance } from '../src/s16/operations/control-maintenance';
import { openS16InstallationLease } from '../src/s16/operations/installation-lease';
import { captureS16PayloadSet, s16PayloadSetManifestHash, verifyS16PayloadSet, verifyS16PayloadSources } from '../src/s16/operations/payload-set';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (bytes: Uint8Array | string) => new Bun.CryptoHasher('sha256').update(bytes).digest('hex');
async function fixture(rich = false, lineageOnly = false) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-github-custody-'))); cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const directory = join(parent, 'state'), configPath = join(parent, 'config.json'); writeFileSync(configPath, JSON.stringify(s15StageConfig(directory, 'http://localhost:3041')), { mode: 0o600 });
  const child = Bun.spawn([process.execPath, 'src/main.ts', 'init', '--s15', '--config', configPath], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]); expect({ exit, error }).toEqual({ exit: 0, error: '' });
  const config = readS15RuntimeConfig(configPath), root = join(directory, 'github-artifacts'), working = join(parent, 'working'); mkdirSync(working, { mode: 0o700 });
  const git = (...args: string[]) => { const result = Bun.spawnSync(['git', '-c', 'core.hooksPath=/dev/null', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@invalid', ...args], { cwd: working, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5000 }); expect({ exit: result.exitCode, error: result.stderr.toString() }).toEqual({ exit: 0, error: '' }); };
  git('init', '-q'); const writer = new GithubBundleStore(root, 268435456), bundles: { ref: Ref; bytes: Buffer }[] = [];
  for (let i = 0; i < (rich ? 3 : 1); i++) { writeFileSync(join(working, 'notes.txt'), 'Fixture revision ' + i + '\n', { mode: 0o600 }); git('add', 'notes.txt'); git('commit', '-qm', 'Fixture revision ' + i); const path = join(working, 'bundle-' + i); git('bundle', 'create', path, 'HEAD'); const bytes = readFileSync(path), ref = writer.capture(bytes, hash(bytes)); expect(writer.read(ref)).toEqual(bytes); bundles.push({ ref, bytes }); }
  const path = join(directory, 'runtime/github.sqlite'), store = new GithubStore(path, config.installationId, false);
  const coding = (at: number) => ({ head: 'a'.repeat(40), base: 'b'.repeat(40), diffHash: 'c'.repeat(64), bundle: bundles[at]!.ref, tests: [], criteria: [], source: { ref: 'private_source_marker', observedAt: 1 }, settlement: { transportSettled: false, executionSettled: false } });
  const selection = { id: 'selected_current', workId: 'work_current', state: 'implementing', evidence: coding(0) };
  try {
    store.tx(() => {
      if (!lineageOnly) { store.put('selection', selection.id, selection); store.put('work_evidence', 'original_evidence', coding(0)); }
      store.put('babysit', 'original_babysit', { id: 'original_babysit', state: 'remediating' });
      // Remote content is not a typed artifact slot.
      store.put('report', 'remote_content', { snapshot: { bundle: { id: 'bundle_' + 'f'.repeat(64), revision: 1, generation: 1 } } });
      if (rich) { const prior = { ...selection, id: 'selected_prior', state: 'reconcile_only', evidence: coding(1) }; store.put('action', 'original_action', { id: 'original_action', selection: prior, evidence: prior.evidence, effect: { bundle: prior.evidence.bundle } }); store.put('remote_result', 'original_action', { outcome: 'unknown', receipt: null }); store.commitReceipt('select_original', 'd'.repeat(64), prior); }
    });
  } finally { store.close(); }
  if (lineageOnly) {
    const journal = new DurableJournal(join(directory, 'runtime/disclosure.sqlite'), config.installationId, false, 0x4a445135), ref = bundles[0]!.ref, id = 'derived_' + policyDigest('s15.disclosure.derived.v1', ref);
    try { journal.tx(() => journal.put(id, { kind: 'derived', id, ref, workId: 'original_work', format: 'artifact', sources: [] })); } finally { journal.close(); }
  }
  const context = openS16ControlMaintenance(config); cleanup.push(() => context.close()); const db = context.runtime.sources.find(row => row.name === 'github.sqlite')!.database;
  const state = { parent, directory, root, config, path, bundles, context, db, reopen() { state.context.close(); const current = openS16ControlMaintenance(config); cleanup.push(() => current.close()); state.context = current; state.db = current.runtime.sources.find(row => row.name === 'github.sqlite')!.database; } }; return state;
}

test('actual owning bundle writer and current selected capability retain all referenced, old and unpublished bundles without recovery', async () => {
  const f = await fixture(true), before = readFileSync(f.path), n = f.db.query<{ n: number }, []>('SELECT total_changes() n').get()!.n, cut = f.context.githubArtifacts();
  expect(cut.value.bundles).toHaveLength(3); expect(cut.value.bundles.find(row => row.id === f.bundles[0]!.ref.id)!.references.map(row => row.slot)).toEqual(['selection.evidence', 'work_evidence.bundle']);
  expect(cut.value.bundles.find(row => row.id === f.bundles[1]!.ref.id)!.references.map(row => row.slot)).toEqual(['action.selection.evidence', 'action.evidence', 'action.effect', 'receipt.evidence']);
  expect(cut.value.bundles.find(row => row.id === f.bundles[2]!.ref.id)!.references).toEqual([]); expect(JSON.stringify(cut.value)).not.toContain(f.directory); expect(JSON.stringify(cut.value)).not.toContain('private_source_marker');
  const directory = join(f.parent, 'capture'); mkdirSync(directory, { mode: 0o700 }); const options = { directory, id: 'a'.repeat(32), installationId: f.config.installationId, sources: cut.sources, guard: f.context.assertCurrent }, manifest = captureS16PayloadSet(options);
  verifyS16PayloadSet({ ...options, files: manifest.files, manifestSha256: s16PayloadSetManifestHash(manifest) }); cut.assertCurrent(); expect(readFileSync(f.path)).toEqual(before); expect(f.db.query<{ n: number }, []>('SELECT total_changes() n').get()!.n).toBe(n);
  const state = (kind: string, id: string) => JSON.parse(f.db.query<{ json: string }, [string, string]>('SELECT json FROM records WHERE kind=? AND id=?').get(kind, id)!.json);
  expect(state('selection', 'selected_current').state).toBe('implementing'); expect(state('babysit', 'original_babysit').state).toBe('remediating'); expect(state('remote_result', 'original_action').outcome).toBe('unknown');
  expect(Object.isFrozen(cut.value.bundles[0]!.references)).toBe(true); f.context.close(); expect(() => cut.assertCurrent()).toThrow();
});

test.each(['content', 'inode', 'extra', 'reference'] as const)('original GitHub cut rejects changed %s instead of replacing its expected cohort', async kind => {
  const f = await fixture(), cut = f.context.githubArtifacts(), path = join(f.root, f.bundles[0]!.ref.id);
  if (kind === 'content') writeFileSync(path, 'changed bytes', { mode: 0o600 });
  if (kind === 'inode') { renameSync(path, path + '.old'); writeFileSync(path, readFileSync(path + '.old'), { mode: 0o600 }); unlinkSync(path + '.old'); }
  if (kind === 'extra') writeFileSync(join(f.root, 'bundle_' + hash('unpublished')), 'unpublished', { mode: 0o600 });
  if (kind === 'reference') f.db.exec("UPDATE records SET json=json_set(json,'$.state','reconcile_only') WHERE kind='selection'");
  expect(() => cut.assertCurrent()).toThrow();
});

test.each(['missing', 'hash', 'symlink', 'hardlink', 'mode', 'name', 'size', 'identity', 'reader', 'kind', 'slot', 'row-bounds', 'utf8'] as const)('invalid %s custody refuses without application recovery, deletion or inferred completion', async kind => {
  const f = await fixture(), path = join(f.root, f.bundles[0]!.ref.id);
  if (kind === 'missing') unlinkSync(path);
  if (kind === 'hash') writeFileSync(path, 'corrupt byte hash', { mode: 0o600 });
  if (kind === 'symlink') { unlinkSync(path); symlinkSync(join(f.parent, 'working/bundle-0'), path); }
  if (kind === 'hardlink') linkSync(path, join(f.parent, 'alias'));
  if (kind === 'mode') chmodSync(path, 0o644);
  if (kind === 'name') writeFileSync(join(f.root, 'unknown.part'), 'unowned', { mode: 0o600 });
  if (kind === 'size') truncateSync(path, 1073741825);
  if (kind === 'identity') f.db.exec("UPDATE identity SET id='foreign'");
  if (kind === 'reader') f.db.exec('PRAGMA user_version=99');
  if (kind === 'kind') f.db.exec("UPDATE records SET kind='unknown_kind' WHERE kind='report'");
  if (kind === 'slot') f.db.exec("UPDATE records SET json=json_set(json,'$.evidence.bundle.generation',2) WHERE kind='selection'");
  if (kind === 'row-bounds') f.db.query("UPDATE records SET json=? WHERE kind='report'").run(JSON.stringify({ content: 'x'.repeat(1048576) }));
  if (kind === 'utf8') f.db.query("UPDATE records SET json=CAST(? AS TEXT) WHERE kind='report'").run(Buffer.concat([Buffer.from('{"content":"'), Buffer.from([255]), Buffer.from('"}')]));
  expect(() => f.context.githubArtifacts()).toThrow(); expect(JSON.parse(f.db.query<{ json: string }, []>("SELECT json FROM records WHERE kind='babysit'").get()!.json).state).toBe('remediating');
  if (['identity', 'reader', 'kind', 'slot', 'row-bounds', 'utf8'].includes(kind)) expect(() => f.context.currentPayloadReferences()).toThrow();
});

test('unused namespace stays absent or empty and unowned bytes/forged exclusion cannot certify custody', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jit-github-unused-'))); cleanup.push(() => rmSync(directory, { recursive: true, force: true })); mkdirSync(join(directory, 'runtime'), { mode: 0o700 });
  openS16InstallationLease({ directory, mode: 'shared', create: true }).close();
  const lease = openS16InstallationLease({ directory, mode: 'exclusive' }); cleanup.push(() => lease.close()); const options = { directory, installationId: 'fixture', lease, source: undefined, disclosure: undefined, guard() {} }, cut = captureS16GithubArtifacts(options);
  expect(cut.value.present).toBe(false); expect(cut.sources).toEqual([]); cut.assertCurrent(); expect(existsSync(join(directory, 'github-artifacts'))).toBe(false);
  expect(() => captureS16GithubArtifacts({ ...options, lease: {} as typeof lease })).toThrow(); mkdirSync(join(directory, 'github-artifacts'), { mode: 0o700 });
  expect(captureS16GithubArtifacts(options).value.namespace).toBe(true); writeFileSync(join(directory, 'github-artifacts', 'bundle_' + hash('unowned')), 'unowned', { mode: 0o600 }); expect(() => captureS16GithubArtifacts(options)).toThrow();
});

test('existing source verification streams only expected bytes and produces no files or manifest', async () => {
  const f = await fixture(), before = readdirSync(f.root), source = { name: 'opaque', path: join(f.root, f.bundles[0]!.ref.id), bytes: f.bundles[0]!.bytes.length, sha256: f.bundles[0]!.ref.id.slice(7) }; let checks = 0;
  verifyS16PayloadSources([source], () => { checks++; }); expect(checks).toBe(4); expect(readdirSync(f.root)).toEqual(before); expect(() => verifyS16PayloadSources([{ ...source, sha256: '0'.repeat(64) }], () => {})).toThrow(); expect(() => verifyS16PayloadSources([source], () => true as unknown as void)).toThrow();
});

test('original long selection-receipt identity is preserved rather than truncated or omitted', async () => {
  const f = await fixture(), id = 'select_' + 'r'.repeat(128), body = f.db.query<{ json: string }, []>("SELECT json FROM records WHERE kind='selection'").get()!.json;
  f.db.query('INSERT INTO receipts VALUES (?,?,?)').run(id, 'd'.repeat(64), body);
  f.reopen();
  const cut = f.context.githubArtifacts(); expect(cut.value.bundles[0]!.references.some(ref => ref.table === 'receipts' && ref.rowId === id)).toBe(true); cut.assertCurrent();
});

test('missing registered namespace refuses and never recreates it from its ledger', async () => {
  const f = await fixture(); renameSync(f.root, f.root + '.retained'); expect(() => f.context.githubArtifacts()).toThrow(); expect(existsSync(f.root)).toBe(false); expect(existsSync(f.root + '.retained')).toBe(true);
});

test('aggregate byte quota refuses sparse over-bound custody before hashing any multi-GiB input', async () => {
  const f = await fixture();
  for (let i = 0; i < 4; i++) { const path = join(f.root, 'bundle_' + hash('quota-' + i)); writeFileSync(path, '', { mode: 0o600 }); truncateSync(path, 1073741824); }
  expect(() => f.context.githubArtifacts()).toThrow('s16_ops_github_bounds'); expect(readdirSync(f.root)).toHaveLength(5);
});

test('correlation metadata quota refuses a large retained history without dropping references', async () => {
  const f = await fixture(), body = JSON.parse(f.db.query<{ json: string }, []>("SELECT json FROM records WHERE kind='work_evidence'").get()!.json), put = f.db.query("INSERT INTO records VALUES ('work_evidence',?,?)");
  f.db.transaction(() => { for (let i = 0; i < 26000; i++) { const json = JSON.stringify({ ...body, source: { ref: 'vm:github_' + String(i).padStart(32, '0'), observedAt: 1 } }); put.run('gh_evidence_' + hash(json), json); } })();
  f.reopen();
  expect(() => { f.context.githubArtifacts(); }).toThrow('s16_ops_github_bounds'); expect(f.db.query<{ n: number }, []>("SELECT count(*) n FROM records WHERE kind='work_evidence'").get()!.n).toBe(26001);
});

test('DATA15 artifact committed before selection evidence remains required without manufacturing a GitHub correlation', async () => {
  const f = await fixture(false, true), cut = f.context.githubArtifacts(); expect(cut.value.lineage).toBe(true);
  expect(cut.value.bundles[0]!.references).toEqual([{ table: 'disclosure', kind: 'derived', rowId: 'derived_' + policyDigest('s15.disclosure.derived.v1', f.bundles[0]!.ref), slot: 'disclosure.derived.ref', state: null }]);
  cut.assertCurrent(); unlinkSync(join(f.root, f.bundles[0]!.ref.id)); expect(() => f.context.githubArtifacts()).toThrow('s16_ops_github_missing');
});

test.each(['reader', 'identity', 'key', 'ref'] as const)('invalid current DATA15 %s refuses instead of dropping pre-publication artifact custody', async kind => {
  const f = await fixture(false, true), db = f.context.runtime.sources.find(row => row.name === 'disclosure.sqlite')!.database;
  if (kind === 'reader') db.exec('PRAGMA user_version=99');
  if (kind === 'identity') db.exec("UPDATE identity SET installation='foreign'");
  if (kind === 'key') db.exec("UPDATE records SET id='changed'");
  if (kind === 'ref') db.exec("UPDATE records SET json=json_set(json,'$.ref.generation',2)");
  expect(() => f.context.githubArtifacts()).toThrow(); expect(existsSync(join(f.root, f.bundles[0]!.ref.id))).toBe(true);
  expect(() => f.context.currentPayloadReferences()).toThrow();
});

test('current GitHub references survive missing namespace without claiming unreferenced or historical bytes as current', async () => {
  const f = await fixture(true), before = f.db.serialize(), references = f.context.currentPayloadReferences();
  expect(references.value.github.bundles).toHaveLength(2);
  for (const bundle of references.value.github.bundles) expect(bundle).toEqual({ id: bundle.id, sha256: bundle.id.slice(7), references: bundle.references });
  expect(references.value.github.bundles.find(row => row.id === f.bundles[1]!.ref.id)!.references.map(row => row.slot)).toEqual(['action.selection.evidence', 'action.evidence', 'action.effect', 'receipt.evidence']);
  renameSync(f.root, f.root + '.retained'); references.assertCurrent(); expect(f.context.currentPayloadReferences().sha256).toBe(references.sha256);
  expect(() => f.context.githubArtifacts()).toThrow(); expect(existsSync(f.root)).toBe(false); expect(f.db.serialize()).toEqual(before);
  expect(JSON.stringify(references.value)).not.toContain(f.directory); expect(JSON.stringify(references.value)).not.toContain('private_source_marker');
  expect(Object.isFrozen(references.value.github.bundles[0]!.references[0])).toBe(true);
  expect(JSON.parse(f.db.query<{ json: string }, []>("SELECT json FROM records WHERE kind='remote_result'").get()!.json).outcome).toBe('unknown');
  f.context.close(); expect(() => references.assertCurrent()).toThrow();
});

test('current DATA15 alone keeps its original pre-publication bundle pin when bytes disappear', async () => {
  const f = await fixture(false, true), before = f.context.currentPayloadReferences();
  expect(before.value.github.bundles[0]!.references[0]!.slot).toBe('disclosure.derived.ref');
  unlinkSync(join(f.root, f.bundles[0]!.ref.id)); before.assertCurrent(); expect(f.context.currentPayloadReferences().value).toEqual(before.value);
  expect(() => f.context.githubArtifacts()).toThrow('s16_ops_github_missing');
});

test('original current reference observation rereads a WAL-only change and never retains a stale SQL snapshot', async () => {
  const f = await fixture(); f.db.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0'); f.reopen();
  const mode = f.db.query<{ journal_mode: string }, []>('PRAGMA journal_mode').get()!.journal_mode;
  expect(mode).toBe('wal'); const cut = f.context.currentPayloadReferences(), mainBefore = readFileSync(f.path);
  f.db.exec("UPDATE records SET json=json_set(json,'$.state','reconcile_only') WHERE kind='selection'");
  expect(readFileSync(f.path)).toEqual(mainBefore); f.context.assertCurrent(); expect(() => cut.assertCurrent()).toThrow('s16_ops_references_changed');
  const current = f.context.currentPayloadReferences(); expect(current.value.github.bundles[0]!.references.find(row => row.slot === 'selection.evidence')!.state).toBe('reconcile_only');
  f.db.exec('BEGIN'); try { expect(() => current.assertCurrent()).toThrow('s16_ops_sources_busy'); expect(() => f.context.currentPayloadReferences()).toThrow('s16_ops_sources_busy'); } finally { f.db.exec('ROLLBACK'); }
  current.assertCurrent();
});
