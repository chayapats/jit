import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { RELEASE_CONTRACT } from 'schway/host';
import { buildPackage, installArtifactDependencies, readDependencyRecord, validateArtifact } from '../package/bun-build';
import { spawnRunner } from '../../src/ops/supervisor';
import { opsWrite } from '../../src/s14/ops-files';
import { canonical } from '../../src/s15/conversation/validation';
import { s15CredentialKey } from '../../src/s15/credentials';
import { s15StageConfig } from './s15-stage';

const hash = (value: string | Uint8Array) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
function requireOutcome(value: unknown, code: string): asserts value { if (!value) throw Error(code); }
/** Exact copied-package v3 disposition/retirement and v2-reader refusal; all data/accounts are disposable fixtures. */
export async function verifyS16StagingLifecycle(input: { oldCommit: string; receipt: string }): Promise<object> {
  if (!/^[a-f0-9]{40}$/.test(input.oldCommit) || !isAbsolute(input.receipt)) throw Error('invalid_evidence_input');
  const source = resolve(import.meta.dir, '../..'), parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-staging-package-'))), artifact = join(parent, 'artifact'), old = join(parent, 'old');
  const env = { PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? '/usr/bin:/bin') };
  const execute = (args: string[], cwd = artifact, stdin?: string) => spawnRunner([process.execPath, ...args], { cwd, env, ...(stdin === undefined ? {} : { stdin }), timeoutMs: 30000 });
  const success = (result: Awaited<ReturnType<typeof execute>>) => { requireOutcome(!result.timedOut && result.exitCode === 0, 'fixture_command_failed'); return JSON.parse(result.stdout); };
  try {
    const manifest = buildPackage({ srcDir: source, outDir: artifact, engineContract: RELEASE_CONTRACT, engineRevision: null });
    const dependencies = await installArtifactDependencies(artifact, { bunPath: process.execPath, run: spawnRunner, env, timeoutMs: 120000 });
    requireOutcome(validateArtifact(artifact).ok && readDependencyRecord(artifact)?.dependencyHash === dependencies.dependencyHash, 'artifact_validation_failed');
    mkdirSync(old, { mode: 0o700 }); const archive = Bun.spawn(['git', 'archive', '--format=tar', input.oldCommit], { cwd: source, env, stdout: 'pipe', stderr: 'ignore' }), unpack = Bun.spawn(['tar', '-xf', '-', '-C', old], { env, stdin: archive.stdout, stdout: 'ignore', stderr: 'ignore' });
    const timer = setTimeout(() => { archive.kill('SIGKILL'); unpack.kill('SIGKILL'); }, 30000);
    try { requireOutcome((await Promise.all([archive.exited, unpack.exited])).every(code => code === 0), 'old_source_archive_failed'); } finally { clearTimeout(timer); }
    const vendor = 'vendor/schway-1.0.0-rc.2-39194f7.tgz'; requireOutcome(hash(readFileSync(join(old, 'bun.lock'))) === manifest.lockHash && hash(readFileSync(join(old, vendor))) === hash(readFileSync(join(artifact, vendor))), 'old_dependency_pin_mismatch'); symlinkSync(join(artifact, 'node_modules'), join(old, 'node_modules'));
    const directory = join(parent, 'state'), config = join(parent, 'runtime.json'), installationId = 's15_staged_controller'; opsWrite(config, canonical({ ...s15StageConfig(directory, 'http://localhost:3041'), files: true })); const selected = ['--s15', '--config', config];
    success(await execute(['src/main.ts', 'init', ...selected])); success(await execute(['src/s16/operations-cli.ts', 'adopt', ...selected, '--request-id', 'adoption_original']));
    const v2 = `import {readS15RuntimeConfig} from './src/s15/runtime-config';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance';const ctx=openS16ControlMaintenance(readS15RuntimeConfig(${JSON.stringify(config)}));try{const journal=ctx.operations(),row=journal.begin({requestId:'v2_positive',kind:'export',hash:'${'c'.repeat(64)}'},journal.read().revision);journal.advance('v2_positive',row.revision,'discarded');console.log(JSON.stringify({contract:journal.read().contract}));}finally{ctx.close();}`;
    requireOutcome(success(await execute(['-e', v2])).contract === 's16-operations-control/v2', 'v2_positive_journal_failed');
    const positive = success(await execute([join(old, 'src/main.ts'), 'credential', ...selected, '--key', 'v2_positive', '--secret-stdin'], old, 'fixture-only-protected-secret\n')); requireOutcome(positive.state === 'credential_stored', 'old_v2_positive_control_failed');
    const protectedPaths = ['owner/owner.sqlite', 'owner/owner.sqlite.lifecycle.sqlite', 'runtime/files.sqlite', 's16-operations.lock.sqlite', 'vault/' + s15CredentialKey(installationId, 'v2_positive')], protectedHashes = protectedPaths.map(path => hash(readFileSync(join(directory, path))));
    const interrupted = await execute(['-e', `import {readS15RuntimeConfig} from './src/s15/runtime-config';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance';const ctx=openS16ControlMaintenance(readS15RuntimeConfig(${JSON.stringify(config)})),cap=ctx.pointCapture('backup_original',{after(at){if(at==='manifest')process.kill(process.pid,'SIGKILL');}});await cap.capture();`]); requireOutcome(!interrupted.timedOut && interrupted.exitCode !== 0, 'capture_interruption_failed');
    const controlPath = join(directory, 'operations/control.json'), control = () => JSON.parse(readFileSync(controlPath, 'utf8')), original = control().requests.find((row: { requestId: string }) => row.requestId === 'backup_original');
    requireOutcome(control().contract === 's16-operations-control/v3' && original.phase === 'capturing' && original.actions.length === 4, 'original_v3_capture_missing');
    const action = original.actions.find((row: { kind: string }) => row.kind === 'capture_backend'), stage = join(directory, 'operations/point-staging', original.id, action.id), torn = join(stage, 'data/manifest.json'); writeFileSync(torn, '{torn original capture metadata');
    const retry = await execute(['src/s16/operations-cli.ts', 'backup', ...selected, '--request-id', 'backup_original']); requireOutcome(retry.exitCode !== 0 && !retry.timedOut, 'corrupt_capture_accepted');
    const unknown = control().requests.find((row: { requestId: string }) => row.requestId === 'backup_original'); requireOutcome(unknown.status === 'unknown', 'original_capture_uncertainty_lost');
    const aborted = success(await execute(['src/s16/operations-cli.ts', 'abort-backup', ...selected, '--request-id', 'backup_original'])), discarded = control().requests.find((row: { requestId: string }) => row.requestId === 'backup_original');
    requireOutcome(discarded.status === 'discarded' && canonical(discarded.actions) === canonical(unknown.actions) && aborted.operationId === original.id && discarded.abort.point === 'absent' && !existsSync(join(directory, 'owner/owner.sqlite.ops/fence.json')) && readFileSync(torn, 'utf8') === '{torn original capture metadata', 'backup_abort_changed_facts');
    const refused = await execute([join(old, 'src/main.ts'), 'credential', ...selected, '--key', 'v3_refused', '--secret-stdin'], old, 'fixture-only-refused-secret\n');
    requireOutcome(!refused.timedOut && refused.exitCode !== 0 && !existsSync(join(directory, 'vault', s15CredentialKey(installationId, 'v3_refused'))) && JSON.stringify(protectedPaths.map(path => hash(readFileSync(join(directory, path))))) === JSON.stringify(protectedHashes), 'old_v2_reader_crossed_v3');
    const removal = await execute(['-e', `import {readS15RuntimeConfig} from './src/s15/runtime-config';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance';const ctx=openS16ControlMaintenance(readS15RuntimeConfig(${JSON.stringify(config)}));ctx.retireStaging('retire_original',{sourceRequestId:'backup_original',after(at){if(at==='file')process.kill(process.pid,'SIGKILL');}});`]); requireOutcome(!removal.timedOut && removal.exitCode !== 0, 'retirement_interruption_failed');
    const pending = control().requests.find((row: { requestId: string }) => row.requestId === 'retire_original'), removalAction = pending.actions[0], plan = join(directory, 'operations/staging-retention', pending.id, removalAction.id, 'plan.json'), planSha256 = hash(readFileSync(plan));
    const recovered = success(await execute(['src/s16/operations-cli.ts', 'retire-staging', ...selected, '--request-id', 'retire_original', '--source-request-id', 'backup_original'])), completed = control().requests.find((row: { requestId: string }) => row.requestId === 'retire_original');
    requireOutcome(recovered.operationId === pending.id && completed.createdAt === pending.createdAt && completed.actions.length === 1 && completed.actions[0].id === removalAction.id && completed.actions[0].state === 'confirmed' && hash(readFileSync(plan)) === planSha256 && !existsSync(stage) && canonical(control().requests.find((row: { requestId: string }) => row.requestId === 'backup_original')) === canonical(discarded) && JSON.stringify(protectedPaths.map(path => hash(readFileSync(join(directory, path))))) === JSON.stringify(protectedHashes), 'retirement_rewrote_original_custody');
    requireOutcome(canonical(success(await execute(['src/s16/operations-cli.ts', 'retire-staging', ...selected, '--request-id', 'retire_original', '--source-request-id', 'backup_original']))) === canonical(recovered), 'retirement_retry_changed_receipt');
    requireOutcome(success(await execute(['src/main.ts', 'credential', ...selected, '--key', 'v3_current_positive', '--secret-stdin'], artifact, 'fixture-only-current-secret\n')).state === 'credential_stored', 'current_v3_admission_failed');
    requireOutcome(validateArtifact(artifact).ok && readDependencyRecord(artifact)?.dependencyHash === dependencies.dependencyHash && existsSync(join(artifact, 'LICENSE')) && existsSync(join(artifact, 'NOTICE')), 'artifact_changed_during_drill');
    const receipt = { contract: 's16-staging-package-evidence/v1', basis: 'protocol_fixture', platform: process.platform, arch: process.arch, bunVersion: Bun.version, packageHash: manifest.contentHash, dependencyHash: dependencies.dependencyHash, dependencyFiles: dependencies.dependencyFiles, lockHash: manifest.lockHash, engineContract: manifest.engineContract, engineRevision: manifest.engineRevision,
      oldCommit: input.oldCommit, oldReaderSha256: hash(readFileSync(join(old, 'src/s16/operations/operations-state.ts'))), oldFactorySha256: hash(readFileSync(join(old, 'src/s16/operations/installation-lease.ts'))), oldV2Positive: 'credential_stored', oldV3Admission: 'refused_without_physical_fence', currentV3Admission: 'credential_stored', producer: 'actual_selected_copied_package', captureInterruption: 'actual_sigkill_manifest', corruptPresentMetadata: 'retired_as_inert_owned_bytes', originalCaptureUncertainty: 'preserved', abortReceipt: 'original_discarded', retirementInterruption: 'actual_sigkill_after_unlink', originalRemovalPlan: 'retained_unchanged', originalRemovalAction: 'confirmed_once', originalOperation: 'preserved', currentSqlOwnerAndVault: 'preserved', cliRetry: 'original_receipt', notices: 'present', forwardRestore: 'not_exercised', nativeClient: 'not_exercised', physicalSettlement: 'unobserved' };
    opsWrite(input.receipt, canonical(receipt)); return receipt;
  } finally { rmSync(parent, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try { if (args.length !== 4 || args[0] !== '--old-commit' || args[2] !== '--receipt') throw Error('invalid_evidence_input'); console.log(JSON.stringify(await verifyS16StagingLifecycle({ oldCommit: args[1]!, receipt: args[3]! }))); }
  catch (error) { console.error(JSON.stringify({ error: error instanceof Error && /^[a-z][a-z0-9_]{1,79}$/.test(error.message) ? error.message : 'staging_evidence_failed' })); process.exitCode = 1; }
}
