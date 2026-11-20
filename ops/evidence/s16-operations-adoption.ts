import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { RELEASE_CONTRACT } from 'schway/host';
import { buildPackage, installArtifactDependencies, readDependencyRecord, validateArtifact } from '../package/bun-build';
import { opsDirectory, opsWrite } from '../../src/s14/ops-files';
import { canonical } from '../../src/s15/conversation/validation';
import { s15CredentialKey } from '../../src/s15/credentials';
import { spawnRunner } from '../../src/ops/supervisor';
import { s15StageConfig } from './s15-stage';

const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function requireOutcome(value: unknown, code: string): asserts value { if (!value) throw Error(code); }
/** Reproducible packaged metadata/admission drill. All state/credentials are disposable fixtures; no host is installed. */
export async function verifyS16OperationsPackageAdoption(input: { oldCommit: string; receipt: string; profile?: 'adoption' | 'journal' }): Promise<object> {
  if (!/^[a-f0-9]{40}$/.test(input.oldCommit) || !isAbsolute(input.receipt) || input.profile !== undefined && !['adoption', 'journal'].includes(input.profile)) throw Error('invalid_evidence_input');
  const journalProfile = input.profile === 'journal';
  const source = resolve(import.meta.dir, '../..'), parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-ops-package-'))), artifact = join(parent, 'artifact');
  const runtimePath = dirname(process.execPath) + ':' + (process.env.PATH ?? '/usr/bin:/bin');
  const execute = (args: string[], cwd = artifact, stdin?: string) => spawnRunner([process.execPath, ...args], { cwd, ...(stdin === undefined ? {} : { stdin }), env: { PATH: runtimePath }, timeoutMs: 30_000 });
  const parseSuccess = (result: { exitCode: number; stdout: string; timedOut: boolean }) => { requireOutcome(!result.timedOut && result.exitCode === 0, 'fixture_command_failed'); return JSON.parse(result.stdout); };
  try {
    const manifest = buildPackage({ srcDir: source, outDir: artifact, engineContract: RELEASE_CONTRACT, engineRevision: null });
    const dependencies = await installArtifactDependencies(artifact, { bunPath: process.execPath, run: spawnRunner, timeoutMs: 120_000, env: { PATH: runtimePath } });
    requireOutcome(validateArtifact(artifact).ok && readDependencyRecord(artifact)?.dependencyHash === dependencies.dependencyHash, 'artifact_validation_failed');
    requireOutcome(existsSync(join(artifact, 'LICENSE')) && existsSync(join(artifact, 'NOTICE')) && existsSync(join(artifact, 'third_party')), 'artifact_notices_missing');
    const old = join(parent, 'old-source'); mkdirSync(old, { mode: 0o700 });
    const archive = Bun.spawn(['git', 'archive', '--format=tar', input.oldCommit], { cwd: source, env: { PATH: runtimePath }, stdout: 'pipe', stderr: 'ignore' });
    const unpack = Bun.spawn(['tar', '-xf', '-', '-C', old], { env: { PATH: runtimePath }, stdin: archive.stdout, stdout: 'ignore', stderr: 'ignore' });
    const timer = setTimeout(() => { archive.kill('SIGKILL'); unpack.kill('SIGKILL'); }, 30_000);
    try { const results = await Promise.all([archive.exited, unpack.exited]); requireOutcome(results.every(code => code === 0), 'old_source_archive_failed'); } finally { clearTimeout(timer); }
    const vendor = 'vendor/schway-1.0.0-rc.2-39194f7.tgz';
    requireOutcome(hash(readFileSync(join(old, 'bun.lock'))) === manifest.lockHash && hash(readFileSync(join(old, vendor))) === hash(readFileSync(join(artifact, vendor))), 'old_dependency_pin_mismatch');
    symlinkSync(join(artifact, 'node_modules'), join(old, 'node_modules'));
    const directory = join(parent, 'state'), config = join(parent, 'runtime.json'), installationId = 's15_staged_controller';
    opsWrite(config, canonical(s15StageConfig(directory, 'http://localhost:3041')));
    const selected = ['--s15', '--config', config];
    requireOutcome(parseSuccess(await execute(['src/main.ts', 'init', ...selected])).state === 's15_initialized', 'packaged_init_failed');
    requireOutcome(parseSuccess(await execute(['run', 's16:ops', 'status', ...selected])).state === 'not_adopted', 'packaged_initial_status_failed');
    requireOutcome(parseSuccess(await execute([join(old, 'src/main.ts'), 'credential', ...selected, '--key', 'compat_before', '--secret-stdin'], old, 'fixture-only-package-probe\n')).state === 'credential_stored', 'old_source_positive_control_failed');
    const protectedFiles = ['owner/owner.sqlite', 'owner/owner.sqlite.lifecycle.sqlite', 'vault/' + s15CredentialKey(installationId, 'compat_before')];
    let preserved = protectedFiles.map(path => hash(readFileSync(join(directory, path))));
    const adopted = parseSuccess(await execute(['run', 's16:ops', 'adopt', ...selected, '--request-id', 'package_adoption_probe']));
    requireOutcome(adopted.state === 'adopted' && adopted.revision === 0, 'packaged_adoption_failed');
    requireOutcome(canonical(protectedFiles.map(path => hash(readFileSync(join(directory, path))))) === canonical(preserved), 'adoption_changed_current_state');
    if (journalProfile) {
      requireOutcome(parseSuccess(await execute([join(old, 'src/main.ts'), 'credential', ...selected, '--key', 'compat_v2_before', '--secret-stdin'], old, 'fixture-only-package-probe\n')).state === 'credential_stored', 'old_control_positive_control_failed');
      protectedFiles.push('vault/' + s15CredentialKey(installationId, 'compat_v2_before'));
      preserved = protectedFiles.map(path => hash(readFileSync(join(directory, path))));
      const setup = `import {readS15RuntimeConfig} from './src/s15/runtime-config.ts';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance.ts';const cap=openS16ControlMaintenance(readS15RuntimeConfig(${JSON.stringify(config)}));try{const journal=cap.operations();const row=journal.begin({requestId:'package_journal_probe',kind:'export',hash:'${'b'.repeat(64)}'},0);console.log(JSON.stringify({revision:row.revision,fresh:row.fresh}));}finally{cap.close();}`;
      requireOutcome(parseSuccess(await execute(['-e', setup])).revision === 1, 'packaged_journal_write_failed');
      // Simulate lost admission metadata, proving the adopted reader itself still refuses old/current execution.
      unlinkSync(join(directory, 'owner/owner.sqlite.ops/fence.json'));
    }
    const refused = await execute([join(old, 'src/main.ts'), 'credential', ...selected, '--key', 'compat_refused', '--secret-stdin'], old, 'fixture-only-package-probe\n');
    requireOutcome(!refused.timedOut && refused.exitCode !== 0 && !existsSync(join(directory, 'vault', s15CredentialKey(installationId, 'compat_refused'))), 'old_cli_crossed_admission');
    requireOutcome(canonical(protectedFiles.map(path => hash(readFileSync(join(directory, path))))) === canonical(preserved), 'old_cli_changed_current_state');
    const code = `import {openS16InstallationLease} from ${JSON.stringify(join(old, 'src/s16/operations/installation-lease.ts'))};try{const cap=openS16InstallationLease({directory:${JSON.stringify(directory)},mode:'shared'});cap.close();console.log(JSON.stringify({code:'incorrectly_acquired'}));}catch(error){console.log(JSON.stringify({code:error.code}));}`;
    requireOutcome(parseSuccess(await execute(['-e', code], old)).code === (journalProfile ? 's16_ops_control_invalid' : 's16_ops_installation_lease_invalid'), 'old_admission_profile_failed');
    if (journalProfile) {
      const pending = parseSuccess(await execute(['run', 's16:ops', 'status', ...selected]));
      requireOutcome(pending.active?.requestId === 'package_journal_probe' && pending.active.status === 'running', 'packaged_pending_status_failed');
      const denied = await execute(['src/main.ts', 'credential', ...selected, '--key', 'current_pending_refused', '--secret-stdin'], artifact, 'fixture-only-package-probe\n');
      requireOutcome(!denied.timedOut && denied.exitCode !== 0 && !existsSync(join(directory, 'vault', s15CredentialKey(installationId, 'current_pending_refused'))), 'current_cli_crossed_pending_gate');
      const settle = `import {readS15RuntimeConfig} from './src/s15/runtime-config.ts';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance.ts';const cap=openS16ControlMaintenance(readS15RuntimeConfig(${JSON.stringify(config)}));try{const journal=cap.operations();const row=journal.begin({requestId:'package_journal_probe',kind:'export',hash:'${'b'.repeat(64)}'},0);if(row.fresh)throw Error('replayed_request');const settled=journal.advance('package_journal_probe',row.revision,'discarded');console.log(JSON.stringify({status:settled.request.status}));}finally{cap.close();}`;
      requireOutcome(parseSuccess(await execute(['-e', settle])).status === 'discarded', 'packaged_journal_settlement_failed');
      requireOutcome(canonical(protectedFiles.map(path => hash(readFileSync(join(directory, path))))) === canonical(preserved), 'journal_changed_current_state');
    }
    requireOutcome(parseSuccess(await execute(['src/main.ts', 'credential', ...selected, '--key', 'compat_after', '--secret-stdin'], artifact, 'fixture-only-package-probe\n')).state === 'credential_stored', 'current_cli_failed_after_adoption');
    const status = parseSuccess(await execute(['run', 's16:ops', 'status', ...selected]));
    requireOutcome(status.state === 'adopted' && status.id === adopted.id && status.active === null, 'packaged_final_status_failed');
    requireOutcome(!refused.stdout.includes('fixture-only-package-probe') && validateArtifact(artifact).ok && readDependencyRecord(artifact)?.dependencyHash === dependencies.dependencyHash, 'artifact_changed_during_drill');
    const receipt = { contract: 's16-operations-package-evidence/v1', scope: journalProfile ? 'deterministic_disposable_current_journal' : 'deterministic_disposable_metadata_adoption', platform: process.platform, arch: process.arch, bunVersion: Bun.version,
      packageHash: manifest.contentHash, dependencyHash: dependencies.dependencyHash, dependencyFiles: dependencies.dependencyFiles, lockHash: manifest.lockHash, engineContract: manifest.engineContract, engineRevision: manifest.engineRevision,
      oldCommit: input.oldCommit, oldFactorySha256: hash(readFileSync(join(old, 'src/s16/operations/installation-lease.ts'))), oldReaderSha256: hash(readFileSync(join(old, 'src/s16/operations/operations-state.ts'))),
      oldBeforeAdoption: 'credential_stored', oldAfterAdoption: journalProfile ? 'credential_stored' : 'refused', oldAfterJournalWrite: journalProfile ? 'refused_without_physical_fence' : 'not_exercised',
      currentAfterAdoption: 'credential_stored', currentPendingJournal: journalProfile ? 'refused_without_physical_fence' : 'not_exercised', originalJournalSettlement: journalProfile ? 'discarded_without_replay' : 'not_exercised', currentState: 'preserved', notices: 'present', admission: journalProfile ? 'control_v2_bound' : 'v2_bound' };
    opsDirectory(dirname(input.receipt)); opsWrite(input.receipt, canonical(receipt)); return receipt;
  } finally { rmSync(parent, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (![4, 6].includes(args.length) || args[0] !== '--old-commit' || args[2] !== '--receipt' || args.length === 6 && (args[4] !== '--profile' || !['adoption', 'journal'].includes(args[5]!))) throw Error('invalid_evidence_input');
    console.log(JSON.stringify(await verifyS16OperationsPackageAdoption({ oldCommit: args[1]!, receipt: args[3]!, ...(args.length === 6 ? { profile: args[5] as 'adoption' | 'journal' } : {}) })));
  } catch (error) { console.error(JSON.stringify({ error: error instanceof Error && /^[a-z][a-z0-9_]{1,79}$/.test(error.message) ? error.message : 'operations_evidence_failed' })); process.exitCode = 1; }
}
