import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { RELEASE_CONTRACT } from 'schway/host';
import { buildPackage, installArtifactDependencies, readDependencyRecord, validateArtifact } from '../package/bun-build';
import { spawnRunner } from '../../src/ops/supervisor';
import { opsWrite } from '../../src/s14/ops-files';
import { canonical } from '../../src/s15/conversation/validation';

const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
function requireOutcome(value: unknown, code: string): asserts value { if (!value) throw Error(code); }
function files(directory: string, prefix = ''): string[] {
  return readdirSync(join(directory, prefix)).sort().flatMap(name => {
    const path = prefix ? prefix + '/' + name : name, stat = lstatSync(join(directory, path));
    if (stat.isDirectory()) return files(directory, path);
    requireOutcome(stat.isFile() && !stat.isSymbolicLink(), 'export_fixture_not_regular'); return [path];
  });
}
/** Copied-artifact owner export and real browser drill. Only disposable scripted accounts/VMs are used. */
export async function verifyS16OwnerExportPackage(input: { receipt: string; browserExecutable?: string }): Promise<object> {
  requireOutcome(isAbsolute(input.receipt) && !existsSync(input.receipt), 'invalid_evidence_input');
  const source = resolve(import.meta.dir, '../..'), runtimePath = dirname(process.execPath) + ':' + (process.env.PATH ?? '/usr/bin:/bin');
  const env = { PATH: runtimePath, FORCE_COLOR: '0' };
  const revision = await spawnRunner(['git', 'rev-parse', 'HEAD'], { cwd: source, env, timeoutMs: 10_000 });
  const status = await spawnRunner(['git', 'status', '--porcelain'], { cwd: source, env, timeoutMs: 10_000 });
  requireOutcome(revision.exitCode === 0 && /^[a-f0-9]{40}$/.test(revision.stdout.trim()) && status.exitCode === 0 && !status.stdout.trim(), 'export_source_must_be_clean');
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-export-package-'))), artifact = join(parent, 'artifact'), harness = join(parent, 'harness');
  try {
    const manifest = buildPackage({ srcDir: source, outDir: artifact, engineContract: RELEASE_CONTRACT, engineRevision: null });
    const dependencies = await installArtifactDependencies(artifact, { bunPath: process.execPath, run: spawnRunner, timeoutMs: 120_000, env });
    requireOutcome(validateArtifact(artifact).ok && readDependencyRecord(artifact)?.dependencyHash === dependencies.dependencyHash, 'export_artifact_validation_failed');
    requireOutcome(['LICENSE', 'NOTICE', 'third_party'].every(path => existsSync(join(artifact, path))), 'export_notices_missing');
    mkdirSync(join(harness, 'tests'), { recursive: true, mode: 0o700 });
    cpSync(join(source, 'tests/fixtures'), join(harness, 'tests/fixtures'), { recursive: true });
    const suites = ['tests/s16-owner-export.test.ts', 'tests/s16-owner-export.browser.test.ts'];
    for (const path of suites) cpSync(join(source, path), join(harness, path));
    const fixtureHashes = files(join(harness, 'tests')).map(path => ({ path: 'tests/' + path, sha256: hash(readFileSync(join(harness, 'tests', path))) }));
    // Realpath resolution pins every production import to the immutable copied artifact, not the checkout.
    symlinkSync(join(artifact, 'src'), join(harness, 'src')); symlinkSync(join(artifact, 'node_modules'), join(harness, 'node_modules'));
    mkdirSync(join(harness, '.local/resolve-issues'), { recursive: true, mode: 0o700 });
    // The shared bounded runner discards stderr. Route this fixture child's test report to its stdout pipe.
    const command = [process.execPath, 'test', '--timeout', '30000', ...suites];
    const launcher = `const child=Bun.spawn(${JSON.stringify(command)},{stdin:'ignore',stdout:1,stderr:1});process.exit(await child.exited);`;
    const tested = await spawnRunner([process.execPath, '-e', launcher], { cwd: harness, env: { ...env, JIT_S16_BROWSER_TESTS: '1', ...(input.browserExecutable ? { JIT_BROWSER_EXECUTABLE: input.browserExecutable } : {}) }, timeoutMs: 180_000 });
    const log = tested.stdout; opsWrite(input.receipt + '.tests.log', log);
    const counts = /\n\s*(\d+) pass\n\s*(\d+) fail\n\s*(\d+) expect\(\) calls/.exec(log);
    requireOutcome(!tested.timedOut && tested.exitCode === 0 && counts && Number(counts[1]) >= 27 && Number(counts[2]) === 0, 'packaged_owner_export_cases_failed');
    const images = [1440, 390].map(width => ({ width, language: width === 1440 ? 'en' : 'th', sha256: hash(readFileSync(join(harness, '.local/resolve-issues/429-owner-export-' + width + '.png'))) }));
    requireOutcome(validateArtifact(artifact).ok && readDependencyRecord(artifact)?.dependencyHash === dependencies.dependencyHash, 'export_artifact_changed_during_tests');
    const receipt = {
      contract: 's16-owner-export-package-evidence/v1', basis: 'protocol_fixture', sourceCommit: revision.stdout.trim(), sourceState: 'clean',
      packageContentHash: manifest.contentHash, lockHash: manifest.lockHash, dependencyHash: dependencies.dependencyHash, dependencyFiles: dependencies.dependencyFiles,
      platform: process.platform, arch: process.arch, bunVersion: Bun.version, engineContract: manifest.engineContract, engineRevision: manifest.engineRevision,
      exportContract: 's16-owner-export/v1', tests: { pass: Number(counts![1]), fail: 0, assertions: Number(counts![3]), logSha256: hash(log) },
      browser: { surface: 'actual_packaged_web_bundle', download: 'actual_bytes_verified', images }, fixtureHashes,
      driverSha256: hash(readFileSync(import.meta.path)), notices: 'present', artifactAfter: 'verified_unchanged',
      coverage: ['current_owning_http_and_shared_client', 'pure_chat_no_presentations', 'data15_team_withdrawal', 'memory_forget_restart', 'file_artifact_lineage_and_corruption', 'sanitized_images', 'bot_routine_connection_skill_configuration', 'credential_screening', 'capacity_and_changed_source', 'streamed_session_and_owner_generation_loss', 'unchanged_journals_no_vm_network_vault_calls', 'keyboard_focus_empty_error_auth_states'],
      liveProviderCalls: 0, liveAccounts: false, nativeDevices: 'not_exercised', ownerHostCutover: 'not_exercised', aggregateOperations: 'incomplete',
    };
    opsWrite(input.receipt, canonical(receipt)); return receipt;
  } finally { rmSync(parent, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2); requireOutcome(args.length === 2 && args[0] === '--receipt', 'invalid_evidence_arguments');
  console.log(JSON.stringify(await verifyS16OwnerExportPackage({ receipt: args[1]!, ...(process.env.JIT_BROWSER_EXECUTABLE ? { browserExecutable: process.env.JIT_BROWSER_EXECUTABLE } : {}) })));
}
