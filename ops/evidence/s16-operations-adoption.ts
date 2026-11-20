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
export async function verifyS16OperationsPackageAdoption(input: { oldCommit: string; receipt: string; profile?: 'adoption' | 'journal' | 'native' }): Promise<object> {
  if (!/^[a-f0-9]{40}$/.test(input.oldCommit) || !isAbsolute(input.receipt) || input.profile !== undefined && !['adoption', 'journal', 'native'].includes(input.profile)) throw Error('invalid_evidence_input');
  const nativeProfile = input.profile === 'native', journalProfile = input.profile === 'journal' || nativeProfile;
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
      const setup = `import {readS15RuntimeConfig} from './src/s15/runtime-config.ts';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance.ts';const cap=openS16ControlMaintenance(readS15RuntimeConfig(${JSON.stringify(config)}));try{const native=cap.nativeNamespace();native.assertCurrent();if(native.roots.length||native.pending.length||native.untracked.length)throw Error('unexpected_native_custody');const journal=cap.operations();const row=journal.begin({requestId:'package_journal_probe',kind:'export',hash:'${'b'.repeat(64)}'},0);console.log(JSON.stringify({revision:row.revision,fresh:row.fresh,nativeNamespace:'explicit_empty_preserved'}));}finally{cap.close();}`;
      const setupResult = parseSuccess(await execute(['-e', setup])); requireOutcome(setupResult.revision === 1 && setupResult.nativeNamespace === 'explicit_empty_preserved', 'packaged_journal_write_failed');
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
    let nativeProbe: object | null = null, nativeSetProbe: object | null = null, controllerProbe: object | null = null;
    if (nativeProfile) {
      const nativeCode = `import {mkdirSync} from 'node:fs';import {join} from 'node:path';import {createHost} from 'schway/host';import {openS16NativeRoot} from './src/s16/operations/native-root.ts';
const root=${JSON.stringify(join(parent, 'native-probe'))};mkdirSync(root,{mode:0o700});for(const part of ['workspace','home','sessions'])mkdirSync(join(root,part),{mode:0o700});
const host=await createHost({workspaceRoot:join(root,'workspace'),homeDirectory:join(root,'home'),sessionDirectory:join(root,'sessions'),context:{policy:'strict',systemPrompt:'Disposable native evidence.',sections:[]},tools:{policy:'exact',definitions:[],hostedLookup:'off'},limits:{maxTurns:1,maxConcurrentTools:1,maxAttempts:1,contextWindow:131072,maxInputChars:300000,deadlineMs:1000}});let cap,live;
try{live=await host.createSession();await live.submit({text:'public-native-fixture '.repeat(10000)},{provider:'codex-subscription',id:'fixture',async *stream(){yield {type:'message_complete',message:{type:'assistant',id:crypto.randomUUID(),content:[{type:'text',text:'Recorded fixture input.'}]}};}});
const retired=await host.createSession(),deleted=await host.createSession();await retired.retire();await retired.close();await deleted.retire();await deleted.close();await host.deleteSession(deleted.reference);
cap=await openS16NativeRoot({directory:root,installationId:'fixture',id:'${'a'.repeat(32)}',references:[live.reference,retired.reference,deleted.reference],guard(){}});let busy=false;try{await cap.capture();}catch(error){busy=error.code==='busy';}await live.close();
const captured=await cap.capture();cap.verify(captured.bytes,captured.sha256);const value=JSON.parse(Buffer.from(captured.bytes).toString('utf8'));let invalidReceipt=false;try{cap.verify(captured.bytes,'${'0'.repeat(64)}');}catch{invalidReceipt=true;}
const quarantine=${JSON.stringify(join(parent, 'native-quarantine'))};mkdirSync(quarantine,{mode:0o700});await cap.verifyQuarantine(captured.bytes,captured.sha256,quarantine);const after=await cap.capture();if(JSON.stringify(JSON.parse(Buffer.from(after.bytes).toString('utf8')).snapshot.sessions)!==JSON.stringify(value.snapshot.sessions))throw Error('native_source_changed');
console.log(JSON.stringify({busy,invalidReceipt,deepQuarantine:true,currentNativeBytes:'preserved',bytes:captured.bytes.byteLength,sha256:captured.sha256,states:value.inventory.map(row=>row.state).sort(),snapshots:value.snapshot.sessions.length,retired:value.snapshot.sessions.filter(row=>row.retired).length}));
}finally{await cap?.close();await live?.close();await host.close();}`;
      const observed = parseSuccess(await execute(['-e', nativeCode]));
      requireOutcome(observed.busy && observed.invalidReceipt && observed.deepQuarantine && observed.currentNativeBytes === 'preserved' && observed.bytes > 131072 && canonical(observed.states) === canonical(['active', 'deleted', 'retired']) && observed.snapshots === 2 && observed.retired === 1, 'packaged_native_custody_failed');
      nativeProbe = observed;
      // A separate immutable component reader proves v2 refusal. The older installation reader
      // above remains the supplied oldCommit; neither dependency pin nor source provenance changes.
      const nativeReaderCommit = '5eb0b7566475361654a11f0b425a36abfb5a55da';
      const priorNative = await spawnRunner(['git', 'show', nativeReaderCommit + ':src/s16/operations/native-root.ts'], { cwd: source, env: { PATH: runtimePath }, timeoutMs: 30_000 });
      requireOutcome(priorNative.exitCode === 0 && !priorNative.timedOut, 'old_native_reader_unavailable');
      const oldNativePath = join(parent, 'native-reader/src/s16/operations/native-root.ts'); opsWrite(oldNativePath, priorNative.stdout);
      // Preserve relative Jit imports and use exactly the artifact's already verified dependency tree.
      for (const name of ['errors.ts', 's14', 's15']) symlinkSync(join(artifact, 'src', name), join(parent, 'native-reader/src', name));
      symlinkSync(join(artifact, 'node_modules'), join(parent, 'native-reader/node_modules'));
      const nativeSetCode = `import {Database} from 'bun:sqlite';import {mkdirSync,readFileSync,readdirSync} from 'node:fs';import {join,dirname} from 'node:path';import {createHost} from 'schway/host';import {readS15RuntimeConfig} from './src/s15/runtime-config.ts';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance.ts';import {readS16OperationsFence} from './src/s16/operations/operations-state.ts';import {openS16NativeRoot as oldRoot} from ${JSON.stringify(oldNativePath)};
const config=readS15RuntimeConfig(${JSON.stringify(config)}),attempt='github_${'e'.repeat(32)}',root=join(config.directory,'native-github',attempt),vmPath=join(config.directory,'runtime/vm.sqlite');
const database=new Database(vmPath,{readwrite:true,create:false});database.query('INSERT INTO vm_sessions VALUES (?,?,?,?,?,?,?,?)').run('native_vm_original','working','native_work_original',attempt,'work','unknown','fixture_unit',3);database.close(true);
mkdirSync(root,{recursive:true,mode:0o700});for(const name of ['workspace','home','sessions'])mkdirSync(join(root,name),{mode:0o700});const host=await createHost({workspaceRoot:join(root,'workspace'),homeDirectory:join(root,'home'),sessionDirectory:join(root,'sessions'),context:{policy:'strict',systemPrompt:'Packaged native-set custody fixture.',sections:[]},tools:{policy:'exact',definitions:[],hostedLookup:'off'},limits:{maxTurns:1,maxConcurrentTools:1,contextWindow:32768,maxInputChars:1024}});
for(const state of ['active','retired','deleted']){const session=await host.createSession();if(state!=='active')await session.retire();await session.close();if(state==='deleted')await host.deleteSession(session.reference);}await host.close();const vmBefore=readFileSync(vmPath);
let ctx=openS16ControlMaintenance(config),journal=ctx.operations(),session,prior;try{const initial=journal.begin({requestId:'package_native_set',kind:'backup',hash:'${'d'.repeat(64)}'},journal.read().revision);journal.advance('package_native_set',initial.revision,'capturing');let armed=true;session=ctx.nativeSet('package_native_set',{attempt:'original',maxBytes:4294967296,after(at){if(armed&&at==='receipt'){armed=false;throw Error('fixture_receipt_response_loss');}}});let interrupted=false;try{await session.capture();}catch(error){interrupted=error.message==='fixture_receipt_response_loss';}if(!interrupted)throw Error('missing_native_interruption');prior=journal.read().requests.find(row=>row.requestId==='package_native_set');await session.close();ctx.close();ctx=openS16ControlMaintenance(config,{operationFence:readS16OperationsFence(config.directory)});journal=ctx.operations();session=ctx.nativeSet('package_native_set',{attempt:'original',maxBytes:4294967296});const result=await session.capture(),manifest=JSON.parse(readFileSync(join(result.directory,'manifest.json'),'utf8')),file=manifest.roots[0],body=readFileSync(join(result.directory,file.name)),value=JSON.parse(body.toString('utf8'));
let refused=false,oldPositive=false;const reader=await oldRoot({directory:root,installationId:config.installationId,id:file.id,references:value.references,guard(){}});try{const accepted=await reader.capture();reader.verify(accepted.bytes,accepted.sha256);oldPositive=true;try{reader.verify(body,file.sha256);}catch{refused=true;}}finally{await reader.close();}
const row=journal.read().requests.find(row=>row.requestId==='package_native_set');if(row.id!==prior.id||row.createdAt!==prior.createdAt||row.actions.length!==1||row.actions[0].state!=='confirmed'||row.actions[0].id!==prior.actions[0].id||!vmBefore.equals(readFileSync(vmPath)))throw Error('native_set_custody_changed');
console.log(JSON.stringify({roots:result.roots,pending:result.pending,bytes:result.bytes,sha256:result.manifestSha256,states:value.inventory.map(row=>row.state).sort(),nativeContract:value.contract,originalAction:'retained',receiptResponseLoss:'reconciled',currentVmBytes:'preserved',quarantine:readdirSync(join(dirname(result.directory),'quarantine')).length===0?'closed_and_removed':'unexpected',oldNativeReaderPositive:oldPositive,oldNativeReaderRefused:refused,aggregateBackup:'not_exercised'}));await session.close();journal.resume('package_native_set',journal.read().revision);journal.advance('package_native_set',journal.read().revision,'discarded');}finally{await session?.close();ctx.close();}`;
      const setObserved = parseSuccess(await execute(['-e', nativeSetCode]));
      requireOutcome(setObserved.roots === 1 && setObserved.pending === 2 && setObserved.nativeContract === 's16-native-root/v2' && setObserved.originalAction === 'retained' && setObserved.receiptResponseLoss === 'reconciled' && setObserved.currentVmBytes === 'preserved' && setObserved.quarantine === 'closed_and_removed' && setObserved.oldNativeReaderPositive && setObserved.oldNativeReaderRefused && canonical(setObserved.states) === canonical(['active', 'deleted', 'retired']), 'packaged_native_set_failed');
      nativeSetProbe = { ...setObserved, oldNativeReaderCommit: nativeReaderCommit, oldNativeReaderSha256: hash(priorNative.stdout) };
      const controllerCode = `import {Database} from 'bun:sqlite';import {mkdirSync,readFileSync,readdirSync} from 'node:fs';import {join} from 'node:path';import {readS15RuntimeConfig} from './src/s15/runtime-config.ts';import {FirecrackerVmManagement} from './src/s15/vm/firecracker/client.ts';import {DurableJournal} from './src/s15/durable-journal.ts';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance.ts';import {openS16InstallationLease} from './src/s16/operations/installation-lease.ts';import {captureS16LedgerSet} from './src/s16/operations/ledger-set.ts';import {verifyS16LedgerSet,s16LedgerSetManifestHash} from './src/s16/operations/verify-ledger-set.ts';
const config=readS15RuntimeConfig(${JSON.stringify(config)}),managerId='11111111-1111-4111-8111-111111111111',root=join(config.directory,'runtime/vm-firecracker'),path=join(root,managerId+'.sqlite'),binding={kind:'firecracker',origin:'http://127.0.0.1:3142',computerId:'jit-work-package',selectionSha256:'${'a'.repeat(64)}'};mkdirSync(root,{mode:0o700});
let credentialReads=0;const options={path,create:true,installationId:config.installationId,...binding,fixture:{basis:'protocol_fixture'},credential(){credentialReads++;throw Error('unexpected_credential');}};const initialized=new FirecrackerVmManagement(options);initialized.close();const vm=new Database(join(config.directory,'runtime/vm.sqlite'),{readwrite:true,create:false});vm.query('INSERT INTO vm_managers VALUES (?,?)').run(managerId,JSON.stringify(binding));vm.close(true);
const command={contract:'s16-firecracker-host-command/v1',requestId:'${'f'.repeat(32)}',computerId:binding.computerId,selectionSha256:binding.selectionSha256,expectedRevision:1,expectedLaunchId:null,kind:'launch'},journal=new DurableJournal(path,config.installationId,false,0x4a46434a,{records:256,bytes:67108864});journal.tx(()=>{journal.put('active',{requestId:command.requestId});journal.put(command.requestId,{contract:'s16-firecracker-client-intent/v1',command,state:'dispatched',receipt:null});});journal.close();const before=readFileSync(path);let cap=openS16ControlMaintenance(config);try{const original=cap.firecracker.controllers[0];if(original.pending?.state!=='dispatched'||cap.sources.length!==cap.outer.length+cap.runtime.sources.length+1)throw Error('controller_omitted');const target=${JSON.stringify(join(parent, 'controller-cohort'))};mkdirSync(target,{mode:0o700});const capture={directory:target,id:'${'c'.repeat(32)}',installationId:config.installationId,sources:cap.sources,guard:cap.assertCurrent};const manifest=captureS16LedgerSet(capture);verifyS16LedgerSet({...capture,readers:cap.sources.map(({name,reader})=>({name,reader})),manifestSha256:s16LedgerSetManifestHash(manifest)});if(!before.equals(readFileSync(path))||credentialReads)throw Error('controller_recovered_during_capture');
let duplicate=false;try{new FirecrackerVmManagement({...options,create:false});}catch(error){duplicate=error.code==='runtime_already_open';}const db=cap.firecracker.sources[0].database,close=db.close.bind(db);db.close=()=>{throw Error('fixture_close_unknown');};let held=false;try{cap.close();}catch(error){if(error.code!=='s16_ops_source_release_unknown')throw error;try{openS16InstallationLease({directory:config.directory,mode:'shared'});}catch{held=true;}}finally{db.close=close;}if(!held||!duplicate)throw Error('controller_exclusion_lost');cap.close();cap=openS16ControlMaintenance(config);if(cap.firecracker.controllers[0].pending?.state!=='dispatched'||!before.equals(readFileSync(path)))throw Error('controller_original_changed');console.log(JSON.stringify({controllers:cap.firecracker.controllers.length,cohortImages:manifest.images.length,sourceCopied:manifest.images.some(image=>image.name===original.source),originalState:'dispatched_preserved',credentialReads,duplicateRefused:duplicate,unknownClose:'exclusion_retained',sourceBytes:'preserved',processLeasesCopied:readdirSync(join(target,capture.id)).some(name=>name.includes('process-lock')),aggregateBackup:'not_exercised'}));}finally{cap.close();}`;
      const controllerObserved = parseSuccess(await execute(['-e', controllerCode]));
      requireOutcome(controllerObserved.controllers === 1 && controllerObserved.sourceCopied && controllerObserved.originalState === 'dispatched_preserved' && controllerObserved.credentialReads === 0 && controllerObserved.duplicateRefused && controllerObserved.unknownClose === 'exclusion_retained' && controllerObserved.sourceBytes === 'preserved' && controllerObserved.processLeasesCopied === false, 'packaged_controller_custody_failed');
      controllerProbe = controllerObserved;
    }
    requireOutcome(!refused.stdout.includes('fixture-only-package-probe') && validateArtifact(artifact).ok && readDependencyRecord(artifact)?.dependencyHash === dependencies.dependencyHash, 'artifact_changed_during_drill');
    const receipt = { contract: 's16-operations-package-evidence/v1', scope: nativeProfile ? 'deterministic_disposable_native_custody' : journalProfile ? 'deterministic_disposable_current_journal' : 'deterministic_disposable_metadata_adoption', platform: process.platform, arch: process.arch, bunVersion: Bun.version,
      packageHash: manifest.contentHash, dependencyHash: dependencies.dependencyHash, dependencyFiles: dependencies.dependencyFiles, lockHash: manifest.lockHash, engineContract: manifest.engineContract, engineRevision: manifest.engineRevision,
      oldCommit: input.oldCommit, oldFactorySha256: hash(readFileSync(join(old, 'src/s16/operations/installation-lease.ts'))), oldReaderSha256: hash(readFileSync(join(old, 'src/s16/operations/operations-state.ts'))),
      oldBeforeAdoption: 'credential_stored', oldAfterAdoption: journalProfile ? 'credential_stored' : 'refused', oldAfterJournalWrite: journalProfile ? 'refused_without_physical_fence' : 'not_exercised',
      currentAfterAdoption: 'credential_stored', currentPendingJournal: journalProfile ? 'refused_without_physical_fence' : 'not_exercised', originalJournalSettlement: journalProfile ? 'discarded_without_replay' : 'not_exercised', currentState: 'preserved', notices: 'present', admission: journalProfile ? 'control_v2_bound' : 'v2_bound', nativeNamespace: journalProfile ? 'explicit_empty_preserved' : 'not_exercised', nativeProbe, nativeSetProbe, controllerProbe };
    opsDirectory(dirname(input.receipt)); opsWrite(input.receipt, canonical(receipt)); return receipt;
  } finally { rmSync(parent, { recursive: true, force: true }); }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  try {
    if (![4, 6].includes(args.length) || args[0] !== '--old-commit' || args[2] !== '--receipt' || args.length === 6 && (args[4] !== '--profile' || !['adoption', 'journal', 'native'].includes(args[5]!))) throw Error('invalid_evidence_input');
    console.log(JSON.stringify(await verifyS16OperationsPackageAdoption({ oldCommit: args[1]!, receipt: args[3]!, ...(args.length === 6 ? { profile: args[5] as 'adoption' | 'journal' | 'native' } : {}) })));
  } catch (error) { console.error(JSON.stringify({ error: error instanceof Error && /^[a-z][a-z0-9_]{1,79}$/.test(error.message) ? error.message : 'operations_evidence_failed' })); process.exitCode = 1; }
}
