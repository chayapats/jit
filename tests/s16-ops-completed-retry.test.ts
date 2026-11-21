import { expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { RELEASE_CONTRACT } from 'schway/host';
import { buildPackage, installArtifactDependencies, readDependencyRecord, validateArtifact } from '../ops/package/bun-build';
import { spawnRunner } from '../src/ops/supervisor';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { opsWrite } from '../src/s14/ops-files';
import { readS15RuntimeConfig } from '../src/s15/runtime-config';
import { FileStore } from '../src/s16/files/store';
import { openS16ControlMaintenance } from '../src/s16/operations/control-maintenance';
import { readS16OperationsFence } from '../src/s16/operations/operations-state';
import { s16PointDirectory } from '../src/s16/operations/point-files';

const hash = (value: string | Uint8Array) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
const env = { PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin' };
async function command(cwd: string, args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
  try { const [exit, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { exit, out, error }; }
  finally { clearTimeout(timer); }
}

if (process.env.JIT_S16_COMPLETED_RETRY_CHILD !== '1') test('two actual sealed packages preserve completed receipts and refuse nonterminal package substitution', async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-retry-packages-'))), harness = join(parent, 'harness');
  const receipt = process.env.JIT_S16_COMPLETED_RETRY_RECEIPT;
  if (receipt && (!isAbsolute(receipt) || existsSync(receipt) || existsSync(receipt + '.tests.log'))) throw Error('fixture_receipt_must_be_fresh_absolute_path');
  try {
    const packages = [];
    for (const name of ['a', 'b']) {
      const path = join(parent, name), manifest = buildPackage({ srcDir: process.cwd(), outDir: path, engineContract: RELEASE_CONTRACT, engineRevision: null });
      const dependencies = await installArtifactDependencies(path, { bunPath: process.execPath, run: spawnRunner, env, timeoutMs: 120000 });
      packages.push({ path, manifest, dependencies });
    }
    expect(packages[0]!.manifest.contentHash).not.toBe(packages[1]!.manifest.contentHash);
    expect(packages[0]!.manifest.lockHash).toBe(packages[1]!.manifest.lockHash);
    expect(packages[0]!.dependencies.dependencyHash).toBe(packages[1]!.dependencies.dependencyHash);
    mkdirSync(join(harness, 'tests'), { recursive: true, mode: 0o700 }); mkdirSync(join(harness, 'ops/evidence'), { recursive: true, mode: 0o700 });
    cpSync(import.meta.path, join(harness, 'tests/s16-ops-completed-retry.test.ts'));
    cpSync(join(process.cwd(), 'ops/evidence/s15-stage.ts'), join(harness, 'ops/evidence/s15-stage.ts'));
    for (const name of ['src', 'node_modules']) symlinkSync(join(packages[0]!.path, name), join(harness, name));
    symlinkSync(join(packages[0]!.path, 'ops/package'), join(harness, 'ops/package'));
    const child = Bun.spawn([process.execPath, 'test', '--timeout', '120000', 'tests/s16-ops-completed-retry.test.ts'], { cwd: harness, env: { ...env, JIT_S16_COMPLETED_RETRY_CHILD: '1', JIT_S16_RETRY_PACKAGE_A: packages[0]!.path, JIT_S16_RETRY_PACKAGE_B: packages[1]!.path }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 150000); let report = '';
    try {
      const [exit, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); report = out + error;
      expect({ exit, error: exit === 0 ? '' : error }).toEqual({ exit: 0, error: '' }); expect(error).toContain('1 pass'); expect(error).toContain('0 fail');
    } finally { clearTimeout(timer); }
    for (const pkg of packages) { expect(validateArtifact(pkg.path, { runtime: true }).ok).toBe(true); expect(readDependencyRecord(pkg.path)?.dependencyHash).toBe(pkg.dependencies.dependencyHash); }
    if (receipt) {
      const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' }), status = Bun.spawnSync(['git', 'status', '--porcelain'], { stdout: 'pipe', stderr: 'ignore' });
      const counts = /\n\s*1 pass\n\s*0 fail\n\s*(\d+) expect\(\) calls/.exec(report); if (!counts) throw Error('fixture_test_counts_missing');
      opsWrite(receipt + '.tests.log', report);
      opsWrite(receipt, JSON.stringify({ contract: 's16-completed-operation-repackaging-evidence/v1', basis: 'actual_copied_cli_and_owning_file_store_with_empty_native_fixture', sourceCommit: revision.stdout.toString().trim(), sourceState: status.exitCode === 0 && !status.stdout.length ? 'clean' : 'unverified',
        packages: packages.map(pkg => ({ contentHash: pkg.manifest.contentHash, lockHash: pkg.manifest.lockHash, dependencyHash: pkg.dependencies.dependencyHash, dependencyFiles: pkg.dependencies.dependencyFiles })),
        platform: process.platform, arch: process.arch, bunVersion: Bun.version, engineContract: RELEASE_CONTRACT, engineRevision: 'unverified', driverSha256: hash(readFileSync(import.meta.path)),
        tests: { pass: 1, fail: 0, assertions: Number(counts[1]), logSha256: hash(report) }, artifactsAfter: 'verified_unchanged', compatibleServiceClientLifecycle: 'not_exercised', liveAccounts: false, nativeDevices: 'not_exercised' }));
    }
  } finally { rmSync(parent, { recursive: true, force: true }); }
}, 300000);

if (process.env.JIT_S16_COMPLETED_RETRY_CHILD === '1') test('completed metadata survives repackaging, retirement and withdrawal while original unfinished commands stay bound', async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-completed-retry-'))), path = join(parent, 'config.json'), a = process.env.JIT_S16_RETRY_PACKAGE_A!, b = process.env.JIT_S16_RETRY_PACKAGE_B!;
  try {
    writeFileSync(path, JSON.stringify({ ...s15StageConfig(join(parent, 'state'), 'http://localhost:3041'), files: true }), { mode: 0o600 });
    const init = await command(a, ['src/main.ts', 'init', '--s15', '--config', path]); expect({ exit: init.exit, error: init.error }).toEqual({ exit: 0, error: '' });
    const config = readS15RuntimeConfig(path), run = (pkg: string, operation: string, args: string[]) => command(pkg, ['src/s16/operations-cli.ts', operation, '--s15', '--config', path, ...args]);
    let ctx = openS16ControlMaintenance(config); const ownerId = ctx.ownerIdentity; ctx.close();
    const fileOptions = { path: join(config.directory, 'runtime/files.sqlite'), directory: join(config.directory, 'runtime/file-bytes'), installationId: config.installationId, create: false, resource: { id: 'computer', revision: 1, generation: 1 }, requireOwner: () => ({ id: ownerId, generation: 1 }) };
    let store = new FileStore(fileOptions), uploadId: string;
    try { const bytes = Buffer.from('Original bytes for a completed repair.'); const upload = store.create({}, { requestId: 'input_original', conversationId: 'conversation', name: 'notes.txt', bytes: bytes.length, sha256: hash(bytes) }); uploadId = upload.id; await store.write({}, upload.id, new Blob([bytes]).stream()); }
    finally { await store.close(); }
    const adopt = await run(a, 'adopt', ['--request-id', 'adoption_original']); expect({ exit: adopt.exit, error: adopt.error }).toEqual({ exit: 0, error: '' });
    const backup = await run(a, 'backup', ['--request-id', 'backup_original']); expect({ exit: backup.exit, error: backup.error }).toEqual({ exit: 0, error: '' });
    const point = JSON.parse(backup.out) as { pointId: string }; unlinkSync(join(fileOptions.directory, uploadId! + '.blob'));
    const restoreArgs = ['--request-id', 'restore_original', '--point-id', point.pointId];
    const restored = await run(a, 'restore', restoreArgs); expect({ exit: restored.exit, error: restored.error }).toEqual({ exit: 0, error: '' }); expect(existsSync(join(fileOptions.directory, uploadId! + '.blob'))).toBe(true);
    const retired = await run(a, 'retire-staging', ['--request-id', 'retire_original', '--source-request-id', 'restore_original']); expect({ exit: retired.exit, error: retired.error }).toEqual({ exit: 0, error: '' });
    store = new FileStore(fileOptions); try { store.withdraw({}, uploadId!); } finally { await store.close(); }
    ctx = openS16ControlMaintenance(config); const before = ctx.sources.map(source => hash(source.database.serialize())), control = ctx.operations().read(); ctx.close();
    const retried = await run(b, 'restore', restoreArgs); expect({ exit: retried.exit, error: retried.error }).toEqual({ exit: 0, error: '' }); expect(JSON.parse(retried.out)).toEqual(JSON.parse(restored.out));
    const backupRetry = await run(b, 'backup', ['--request-id', 'backup_original']); expect({ exit: backupRetry.exit, error: backupRetry.error }).toEqual({ exit: 0, error: '' }); expect(JSON.parse(backupRetry.out)).toEqual(JSON.parse(backup.out));
    expect(existsSync(join(fileOptions.directory, uploadId! + '.blob'))).toBe(false);
    const original = control.requests.find(row => row.requestId === 'restore_original')!;
    expect(existsSync(join(config.directory, 'operations/forward-recovery', original.id))).toBe(false);
    ctx = openS16ControlMaintenance(config); expect(ctx.sources.map(source => hash(source.database.serialize()))).toEqual(before); expect(ctx.operations().read()).toEqual(control);
    const unfinished = ctx.restorePoint('restore_unfinished', point.pointId, { after(boundary) { if (boundary === 'admitted') throw Error('fixture_before_capture'); } });
    try { await expect(unfinished.repair()).rejects.toThrow('s16_ops_forward_repair_invalid'); } finally { await unfinished.close(); ctx.close(); }
    const controlPath = join(config.directory, 'operations/control.json'), fencePath = join(config.directory, 'owner/owner.sqlite.ops/fence.json'), pending = readFileSync(controlPath), fence = readFileSync(fencePath);
    const terminalUnderOtherFence = await run(b, 'restore', restoreArgs); expect({ exit: terminalUnderOtherFence.exit, error: terminalUnderOtherFence.error }).toEqual({ exit: 0, error: '' }); expect(JSON.parse(terminalUnderOtherFence.out)).toEqual(JSON.parse(restored.out));
    expect(readFileSync(controlPath)).toEqual(pending); expect(readFileSync(fencePath)).toEqual(fence);
    const substituted = await run(b, 'restore', ['--request-id', 'restore_unfinished', '--point-id', point.pointId]); expect(substituted.exit).not.toBe(0);
    const wrongPoint = await run(b, 'restore', ['--request-id', 'restore_original', '--point-id', '0'.repeat(32)]); expect(wrongPoint.exit).not.toBe(0);
    const wrongKind = await run(b, 'restore', ['--request-id', 'backup_original', '--point-id', point.pointId]); expect(wrongKind.exit).not.toBe(0);
    const originalConfig = readFileSync(path);
    try {
      writeFileSync(path, JSON.stringify({ ...config, origin: 'http://localhost:3042' }), { mode: 0o600 });
      const changedConfiguration = await run(b, 'restore', restoreArgs); expect(changedConfiguration.exit).not.toBe(0);
    } finally { writeFileSync(path, originalConfig, { mode: 0o600 }); }
    const payloads = join(s16PointDirectory(config.directory, point.pointId), 'payloads', point.pointId), payload = join(payloads, readdirSync(payloads).find(name => name.endsWith('.blob'))!);
    writeFileSync(payload, 'Changed retained historical bytes.');
    const corruptBackup = await run(b, 'backup', ['--request-id', 'backup_original']); expect(corruptBackup.exit).not.toBe(0);
    expect(readFileSync(payload, 'utf8')).toBe('Changed retained historical bytes.');
    expect(readFileSync(controlPath)).toEqual(pending); expect(readFileSync(fencePath)).toEqual(fence);
    ctx = openS16ControlMaintenance(config, { operationFence: readS16OperationsFence(config.directory) }); expect(ctx.sources.map(source => hash(source.database.serialize()))).toEqual(before);
    // This explicit fixture interruption preceded every capture action; discard only that known action-free request.
    const journal = ctx.operations(); journal.resume('restore_unfinished', journal.read().revision); journal.advance('restore_unfinished', journal.read().revision, 'discarded');
    const unfinishedBackup = ctx.pointCapture('backup_unfinished', { after(boundary) { if (boundary === 'admitted') throw Error('fixture_before_backup_capture'); } });
    try { await expect(unfinishedBackup.capture()).rejects.toThrow(); } finally { await unfinishedBackup.close(); ctx.close(); }
    const pendingBackup = readFileSync(controlPath), backupFence = readFileSync(fencePath);
    const substitutedBackup = await run(b, 'backup', ['--request-id', 'backup_unfinished']); expect(substitutedBackup.exit).not.toBe(0);
    expect(readFileSync(controlPath)).toEqual(pendingBackup); expect(readFileSync(fencePath)).toEqual(backupFence);
    expect(existsSync(join(fileOptions.directory, uploadId! + '.blob'))).toBe(false);
  } finally { rmSync(parent, { recursive: true, force: true }); }
}, 120000);
