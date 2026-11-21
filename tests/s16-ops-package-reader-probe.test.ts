import { Database } from 'bun:sqlite';
import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { RELEASE_CONTRACT } from 'schway/host';
import { artifactContentHash, buildPackage, installArtifactDependencies, manifestMetadata, readDependencyRecord, validateArtifact, type BuildManifest } from '../ops/package/bun-build';
import { openS16PackageReaderProbe, s16PackageNativeNamespaceSha256 } from '../ops/package/installer/s16-package-probe';
import { spawnRunner } from '../src/ops/supervisor';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { readS15RuntimeConfig } from '../src/s15/runtime-config';
import { canonical } from '../src/s15/conversation/validation';
import { adoptS16Operations } from '../src/s16/operations/adoption';
import { openS16ControlMaintenance } from '../src/s16/operations/control-maintenance';
import { canonicalS16OperationsControl, readS16OperationsControl, readS16OperationsFence } from '../src/s16/operations/operations-state';
import { opsDirectory, opsWrite } from '../src/s14/ops-files';

let parent: string;
const packages: { path: string; manifest: BuildManifest; sourceRevision: string; dependencyHash: string; dependencyFiles: number }[] = [], cleanups: (() => void)[] = [];
const hash = (value: string | Uint8Array) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
const env = { PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin' };
beforeAll(async () => {
  const receipt = process.env.JIT_S16_PACKAGE_READER_RECEIPT;
  if (receipt && (!isAbsolute(receipt) || existsSync(receipt))) throw Error('fixture_receipt_must_be_fresh_absolute_path');
  if (receipt) opsDirectory(dirname(receipt));
  parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-package-readers-')));
  for (const [name, revision] of [['current', null], ['compatible', '4e2a80f82c6345f23f97d531aa8a0dc2b53a0d0e'], ['pre_operations', '95a958e99d5903c4804bba79b92e3cfa940e77d2']] as const) {
    let source = process.cwd();
    if (revision) {
      source = join(parent, name + '-source'); mkdirSync(source, { mode: 0o700 }); const archive = join(parent, name + '.tar');
      const archived = Bun.spawnSync(['git', 'archive', '--format=tar', '--output=' + archive, revision], { env, stdout: 'pipe', stderr: 'pipe' });
      if (archived.exitCode !== 0 || Bun.spawnSync(['/usr/bin/tar', '-xf', archive, '-C', source], { env, stdout: 'pipe', stderr: 'pipe' }).exitCode !== 0) throw Error('fixture_archive_failed');
    }
    const path = join(parent, name), manifest = buildPackage({ srcDir: source, outDir: path, engineContract: RELEASE_CONTRACT, engineRevision: null });
    const dependencies = await installArtifactDependencies(path, { bunPath: process.execPath, run: spawnRunner, env, timeoutMs: 120000 });
    packages.push({ path, manifest, sourceRevision: revision ?? Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString().trim(), dependencyHash: dependencies.dependencyHash, dependencyFiles: dependencies.dependencyFiles });
  }
}, 300000);
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
afterAll(() => {
  try {
    for (const pkg of packages) { const checked = validateArtifact(pkg.path, { runtime: true }); expect(checked.ok && checked.manifest?.contentHash === pkg.manifest.contentHash && readDependencyRecord(pkg.path)?.dependencyHash === pkg.dependencyHash).toBe(true); }
    const receipt = process.env.JIT_S16_PACKAGE_READER_RECEIPT;
    if (receipt) {
      const source = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' }), status = Bun.spawnSync(['git', 'status', '--porcelain'], { stdout: 'pipe', stderr: 'ignore' });
      opsWrite(receipt, JSON.stringify({ contract: 's16-package-current-reader-artifact-evidence/v1', basis: 'actual_sealed_target_modules_and_current_owning_maintenance_with_protocol_upgrade_gate',
        sourceCommit: source.stdout.toString().trim(), sourceState: source.exitCode === 0 && status.exitCode === 0 && !status.stdout.length && source.stdout.toString().trim() === packages[0]?.sourceRevision ? 'clean' : 'unverified',
        packages: packages.map(pkg => ({ sourceCommit: pkg.sourceRevision, packageContentHash: pkg.manifest.contentHash, lockHash: pkg.manifest.lockHash, dependencyHash: pkg.dependencyHash, dependencyFiles: pkg.dependencyFiles })),
        platform: process.platform, arch: process.arch, bunVersion: Bun.version, engineContract: RELEASE_CONTRACT, engineRevision: 'unverified', driverSha256: hash(readFileSync(import.meta.path)),
        artifactsAfter: 'verified_unchanged', testOutcomes: 'separate_test_log_required', native: 'namespace_metadata_only', helpers: 'current_metadata_not_physical_settlement', serviceClientLifecycle: 'not_exercised', liveAccounts: false, nativeDevices: 'not_exercised' }));
    }
  } finally { if (parent) rmSync(parent, { recursive: true, force: true }); }
});

/** Actual copied init/current owning control; original action-free admission is an explicit protocol fixture. */
async function fixture() {
  const directory = realpathSync(mkdtempSync(join(parent, 'state-'))), path = join(directory, 'config.json'); cleanups.push(() => rmSync(directory, { recursive: true, force: true }));
  writeFileSync(path, JSON.stringify({ ...s15StageConfig(join(directory, 'installation'), 'http://localhost:3041'), files: true }), { mode: 0o600 });
  const initialized = await spawnRunner([process.execPath, 'src/main.ts', 'init', '--s15', '--config', path], { cwd: packages[0]!.path, env, timeoutMs: 60000 });
  expect(initialized.exitCode).toBe(0); const config = readS15RuntimeConfig(path); adoptS16Operations(config, 'adoption_original');
  const ctx = openS16ControlMaintenance(config), journal = ctx.operations();
  journal.begin({ requestId: 'original_action_free_backup', kind: 'backup', hash: 'a'.repeat(64) }, journal.read().revision);
  ctx.abortBackup('original_action_free_backup'); expect(journal.read().contract).toBe('s16-operations-control/v3');
  journal.begin({ requestId: 'upgrade_protocol_fixture', kind: 'upgrade', hash: 'b'.repeat(64) }, journal.read().revision);
  const sql = ctx.sources.map(source => hash(source.database.serialize())); ctx.close();
  const controlPath = join(config.directory, 'operations/control.json'), fencePath = join(config.directory, 'owner/owner.sqlite.ops/fence.json'), control = readFileSync(controlPath), fence = readFileSync(fencePath);
  const input = (index = 1) => ({ targetDirectory: packages[index]!.path, packageSha256: packages[index]!.manifest.contentHash, configPath: path, configurationSha256: hash(canonical(config)) });
  return { config, input, policy: { root: parent, uid: process.getuid!() }, unchanged() {
    expect(readFileSync(controlPath)).toEqual(control); expect(readFileSync(fencePath)).toEqual(fence);
    const reopened = openS16ControlMaintenance(config, { operationFence: readS16OperationsFence(config.directory) });
    try { expect(reopened.sources.map(source => hash(source.database.serialize()))).toEqual(sql); } finally { reopened.close(); }
  } };
}

test('the actual earlier sealed package reads current v3 control under its own genuine retained process leases', async () => {
  const f = await fixture(), probe = await openS16PackageReaderProbe(f.input(), { pathPolicy: f.policy });
  cleanups.push(() => probe.close()); const observed = await probe.observe();
  expect(observed).toMatchObject({ state: 'readable', package: { contentHash: packages[1]!.manifest.contentHash }, native: 'namespace_metadata_only', helpers: 'current_metadata_not_physical_settlement' });
  expect(observed.sql.map(row => row.name)).toContain('files.sqlite'); expect(observed.sql.map(row => row.name)).toContain('owner.sqlite');
  expect(observed.sql.every(row => /^[a-f0-9]{64}$/.test(row.logicalSha256))).toBe(true);
  expect(JSON.stringify(observed)).not.toContain(parent);
  expect(() => openS16ControlMaintenance(f.config, { operationFence: readS16OperationsFence(f.config.directory) })).toThrow();
  expect(probe.released).toBe(false); probe.close(); expect(probe.released).toBe(true); f.unchanged();
});

test('actual target readers observe more than 256 known native roots without command-array limits or current writes', async () => {
  const f = await fixture(), database = new Database(join(f.config.directory, 'runtime/model.sqlite'), { readwrite: true, create: false });
  // Real owning schema and directories with explicit protocol correlations, not dispatched model work.
  for (let index = 0; index < 300; index++) {
    const id = 'retained_' + String(index).padStart(4, '0'), directory = join(f.config.directory, 'runtime/native-model', id);
    database.query('INSERT INTO records(id,json) VALUES (?,?)').run(id, JSON.stringify({ contract: 's15-model-selection/v1', id, state: 'reconcile_only', session: null }));
    mkdirSync(directory, { recursive: true, mode: 0o700 }); for (const name of ['workspace', 'home', 'sessions']) mkdirSync(join(directory, name), { mode: 0o700 });
  } database.close(true);
  const ctx = openS16ControlMaintenance(f.config, { operationFence: readS16OperationsFence(f.config.directory) }), namespace = ctx.nativeNamespace(), small = { roots: namespace.roots.slice(0, 2), pending: namespace.pending.slice(0, 2), untracked: namespace.untracked };
  expect(namespace.roots).toHaveLength(300); expect(s16PackageNativeNamespaceSha256(small)).toBe(hash(canonical(small)));
  const expected = s16PackageNativeNamespaceSha256(namespace), sql = ctx.sources.map(source => hash(source.database.serialize())), controlPath = join(f.config.directory, 'operations/control.json'), control = readFileSync(controlPath), fencePath = join(f.config.directory, 'owner/owner.sqlite.ops/fence.json'), fence = readFileSync(fencePath); ctx.close();
  const probe = await openS16PackageReaderProbe(f.input(), { pathPolicy: f.policy }); cleanups.push(() => probe.close());
  expect((await probe.observe()).custody.nativeNamespaceSha256).toBe(expected); probe.close();
  expect(readFileSync(controlPath)).toEqual(control); expect(readFileSync(fencePath)).toEqual(fence);
  const current = openS16ControlMaintenance(f.config, { operationFence: readS16OperationsFence(f.config.directory) }); try { expect(current.sources.map(source => hash(source.database.serialize()))).toEqual(sql); } finally { current.close(); }
});

test.each(['hash', 'config', 'unsupported_package', 'production_path_policy'] as const)('target probe refuses %s without current-state or gate mutation', async mode => {
  const f = await fixture(), input = f.input(mode === 'unsupported_package' ? 2 : 1);
  if (mode === 'hash') input.packageSha256 = '0'.repeat(64);
  if (mode === 'config') input.configurationSha256 = '0'.repeat(64);
  if (mode === 'config') {
    const probe = await openS16PackageReaderProbe(input, { pathPolicy: f.policy }); try { await expect(probe.observe()).rejects.toThrow(); } finally { probe.close(); }
  } else await expect(openS16PackageReaderProbe(input, mode === 'production_path_policy' ? {} : { pathPolicy: f.policy })).rejects.toThrow();
  f.unchanged();
});

test('changed target code under the original content pin refuses before any current source opens', async () => {
  const f = await fixture(), entry = join(packages[1]!.path, 'src/s16/operations/runtime-readers.ts'), original = readFileSync(entry);
  try {
    writeFileSync(entry, Buffer.concat([original, Buffer.from('\n// Controlled changed-package negative fixture.\n')]));
    await expect(openS16PackageReaderProbe(f.input(), { pathPolicy: f.policy })).rejects.toThrow('s16_package_probe_artifact_changed');
  } finally { writeFileSync(entry, original); }
  f.unchanged();
});

test('matching package/dependency metadata cannot substitute a different Bun runtime for the actual executing version', async () => {
  const f = await fixture(), paths = ['manifest.json', 'dependencies.json'].map(name => join(packages[1]!.path, name)), before = paths.map(path => readFileSync(path));
  try {
    // A self-consistent metadata fixture with an independently supplied new content pin.
    const manifest = JSON.parse(before[0]!.toString()) as BuildManifest, dependencies = JSON.parse(before[1]!.toString()); manifest.bunVersion = '0.0.0';
    manifest.contentHash = artifactContentHash(packages[1]!.path, manifestMetadata(manifest)); dependencies.bunVersion = manifest.bunVersion; dependencies.contentHash = manifest.contentHash;
    writeFileSync(paths[0]!, JSON.stringify(manifest)); writeFileSync(paths[1]!, JSON.stringify(dependencies));
    expect(validateArtifact(packages[1]!.path, { runtime: true }).ok).toBe(true);
    await expect(openS16PackageReaderProbe({ ...f.input(), packageSha256: manifest.contentHash }, { pathPolicy: f.policy })).rejects.toThrow('s16_package_probe_artifact_changed'); f.unchanged();
  } finally { paths.forEach((path, index) => writeFileSync(path, before[index]!)); }
});

test('actual earlier readers hash a valid aggregate control larger than a single command without metadata mutation', async () => {
  const f = await fixture(), controlPath = join(f.config.directory, 'operations/control.json'), control = readS16OperationsControl(f.config.directory);
  // Explicit retained-metadata protocol fixture, not executed export jobs or grants.
  // Every original receipt stays below its own bound; the aggregate has its existing 4 MiB bound.
  for (let index = 0; index < 32; index++) control.requests.push({ id: 'e'.repeat(24) + index.toString(16).padStart(8, '0'), requestId: 'metadata_fixture_' + index,
    kind: 'export', hash: 'c'.repeat(64), phase: 'complete', status: 'complete', pointId: null, cohortSha256: 'c'.repeat(64), targetSha256: 'c'.repeat(64), createdAt: control.adoption.createdAt, updatedAt: control.adoption.createdAt, revision: 1, reason: null, configurationSha256: control.adoption.configurationSha256, admittedRevision: 1, abort: null,
    actions: Array.from({ length: 24 }, (_, action) => ({ id: ('metadata_action_' + action + '_').padEnd(120, 'x'), kind: 'capture_backend' as const, priorSha256: null, targetSha256: null, state: 'confirmed' as const, observedSha256: 'c'.repeat(64) })) });
  const encoded = canonicalS16OperationsControl(control); expect(Buffer.byteLength(encoded)).toBeGreaterThan(131072); writeFileSync(controlPath, encoded);
  const fencePath = join(f.config.directory, 'owner/owner.sqlite.ops/fence.json'), fence = readFileSync(fencePath), ctx = openS16ControlMaintenance(f.config, { operationFence: readS16OperationsFence(f.config.directory) }), sql = ctx.sources.map(source => hash(source.database.serialize())); ctx.close();
  const probe = await openS16PackageReaderProbe(f.input(), { pathPolicy: f.policy }); cleanups.push(() => probe.close()); expect((await probe.observe()).controlSha256).toBe(hash(encoded)); probe.close();
  expect(readFileSync(controlPath, 'utf8')).toBe(encoded); expect(readFileSync(fencePath)).toEqual(fence);
  const current = openS16ControlMaintenance(f.config, { operationFence: readS16OperationsFence(f.config.directory) }); try { expect(current.sources.map(source => hash(source.database.serialize()))).toEqual(sql); } finally { current.close(); }
});

test.each(['future_format', 'missing_current_store'] as const)('actual target owning readers refuse %s without empty reconstruction or metadata rewrites', async mode => {
  const f = await fixture(), file = join(f.config.directory, 'runtime/files.sqlite');
  if (mode === 'future_format') {
    const db = new Database(file, { readwrite: true, create: false }); try { db.exec('PRAGMA user_version=2147483647'); } finally { db.close(true); }
  } else unlinkSync(file);
  const protectedPaths = ['operations/control.json', 'owner/owner.sqlite.ops/fence.json', 'runtime/composition.json'].map(name => join(f.config.directory, name));
  const before = protectedPaths.map(path => readFileSync(path)), inventory = readdirSync(dirname(file)).sort(), bytes = existsSync(file) ? readFileSync(file) : null;
  const probe = await openS16PackageReaderProbe(f.input(), { pathPolicy: f.policy });
  try { await expect(probe.observe()).rejects.toThrow(); } finally { probe.close(); }
  expect(protectedPaths.map(path => readFileSync(path))).toEqual(before); expect(readdirSync(dirname(file)).sort()).toEqual(inventory);
  if (bytes) expect(readFileSync(file)).toEqual(bytes); else expect(existsSync(file)).toBe(false);
});

test('an unknown target rollback keeps the original capability and actual leases until same-capability disposal succeeds', async () => {
  const f = await fixture(), probe = await openS16PackageReaderProbe(f.input(), { pathPolicy: f.policy }); cleanups.push(() => probe.close());
  const original = Database.prototype.exec; let injected = false, fail = true;
  Database.prototype.exec = function(sql, ...bindings) {
    if (fail && !injected && String(sql).trim().toUpperCase() === 'ROLLBACK' && this.filename.startsWith(f.config.directory + '/')) { injected = true; throw Error('fixture_rollback_unknown'); }
    return original.call(this, sql, ...bindings);
  };
  try {
    await expect(probe.observe()).rejects.toThrow(); expect(injected).toBe(true); expect(probe.released).toBe(false);
    expect(() => openS16ControlMaintenance(f.config, { operationFence: readS16OperationsFence(f.config.directory) })).toThrow();
    fail = false; probe.close(); expect(probe.released).toBe(true);
  } finally { Database.prototype.exec = original; }
  f.unchanged();
});
