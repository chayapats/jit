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
    requireOutcome(stat.isFile() && !stat.isSymbolicLink(), 'references_fixture_not_regular'); return [path];
  });
}
/** Exercises current-reference and complete-custody cases against an actual immutable copied service package. */
export async function verifyS16CurrentReferencesPackage(input: { receipt: string }): Promise<object> {
  requireOutcome(isAbsolute(input.receipt) && !existsSync(input.receipt), 'invalid_evidence_input');
  const source = resolve(import.meta.dir, '../..'), env = { PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? '/usr/bin:/bin'), FORCE_COLOR: '0' };
  const revision = await spawnRunner(['git', 'rev-parse', 'HEAD'], { cwd: source, env, timeoutMs: 10_000 });
  const status = await spawnRunner(['git', 'status', '--porcelain'], { cwd: source, env, timeoutMs: 10_000 });
  requireOutcome(revision.exitCode === 0 && /^[a-f0-9]{40}$/.test(revision.stdout.trim()) && status.exitCode === 0 && !status.stdout.trim(), 'references_source_must_be_clean');
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-references-package-'))), artifact = join(parent, 'artifact'), harness = join(parent, 'harness');
  try {
    const manifest = buildPackage({ srcDir: source, outDir: artifact, engineContract: RELEASE_CONTRACT, engineRevision: null });
    const dependencies = await installArtifactDependencies(artifact, { bunPath: process.execPath, run: spawnRunner, timeoutMs: 120_000, env });
    requireOutcome(validateArtifact(artifact).ok && readDependencyRecord(artifact)?.dependencyHash === dependencies.dependencyHash, 'references_artifact_validation_failed');
    requireOutcome(['LICENSE', 'NOTICE', 'third_party'].every(path => existsSync(join(artifact, path))), 'references_notices_missing');
    mkdirSync(join(harness, 'tests'), { recursive: true, mode: 0o700 }); cpSync(join(source, 'tests/fixtures'), join(harness, 'tests/fixtures'), { recursive: true });
    const suites = ['tests/s16-ops-file-payloads.test.ts', 'tests/s16-ops-file-cohort.test.ts', 'tests/s16-ops-github-artifacts.test.ts', 'tests/s16-ops-control-maintenance.test.ts'];
    for (const path of suites) cpSync(join(source, path), join(harness, path));
    const fixtureHashes = files(join(harness, 'tests')).map(path => ({ path: 'tests/' + path, sha256: hash(readFileSync(join(harness, 'tests', path))) }));
    // Every production import and CLI child resolves to the sealed artifact; test drivers stay outside it.
    symlinkSync(join(artifact, 'src'), join(harness, 'src')); symlinkSync(join(artifact, 'ops'), join(harness, 'ops')); symlinkSync(join(artifact, 'node_modules'), join(harness, 'node_modules'));
    const command = [process.execPath, 'test', '--timeout', '30000', ...suites], launcher = `const child=Bun.spawn(${JSON.stringify(command)},{stdin:'ignore',stdout:1,stderr:1});process.exit(await child.exited);`;
    const tested = await spawnRunner([process.execPath, '-e', launcher], { cwd: harness, env: { ...env, ...(process.env.JIT_TEST_PYTHON ? { JIT_TEST_PYTHON: process.env.JIT_TEST_PYTHON } : {}) }, timeoutMs: 180_000 });
    const log = tested.stdout; opsWrite(input.receipt + '.tests.log', log);
    const counts = /\n\s*(\d+) pass\n\s*(\d+) fail\n\s*(\d+) expect\(\) calls/.exec(log);
    requireOutcome(!tested.timedOut && tested.exitCode === 0 && counts && Number(counts[1]) >= 89 && Number(counts[2]) === 0, 'packaged_current_references_cases_failed');
    requireOutcome(validateArtifact(artifact).ok && readDependencyRecord(artifact)?.dependencyHash === dependencies.dependencyHash, 'references_artifact_changed_during_tests');
    const receipt = { contract: 's16-current-references-package-evidence/v1', basis: 'protocol_fixture', sourceCommit: revision.stdout.trim(), sourceState: 'clean',
      packageContentHash: manifest.contentHash, lockHash: manifest.lockHash, dependencyHash: dependencies.dependencyHash, dependencyFiles: dependencies.dependencyFiles,
      platform: process.platform, arch: process.arch, bunVersion: Bun.version, engineContract: manifest.engineContract, engineRevision: manifest.engineRevision,
      referencesContract: 's16-current-payload-references/v1', tests: { pass: Number(counts![1]), fail: 0, assertions: Number(counts![3]), logSha256: hash(log) }, fixtureHashes,
      driverSha256: hash(readFileSync(import.meta.path)), notices: 'present', artifactAfter: 'verified_unchanged',
      coverage: ['actual_current_control_exclusion', 'owning_client_upload_artifact_withdrawal', 'actual_git_bundle_writer', 'missing_payload_namespace_and_bytes', 'original_pending_parser_sigkill', 'data15_prepublication_references', 'wal_only_reference_and_withdrawal_fences', 'complete_custody_still_refuses', 'unchanged_current_sql_unknown_effects', 'retired_capability_refused'],
      liveProviderCalls: 0, liveAccounts: false, forwardActivation: 'not_exercised', nativeDevices: 'not_exercised', ownerHostCutover: 'not_exercised', aggregateOperations: 'incomplete' };
    opsWrite(input.receipt, canonical(receipt)); return receipt;
  } finally { rmSync(parent, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const args = Bun.argv.slice(2); requireOutcome(args.length === 2 && args[0] === '--receipt', 'invalid_evidence_arguments');
  console.log(JSON.stringify(await verifyS16CurrentReferencesPackage({ receipt: args[1]! })));
}
