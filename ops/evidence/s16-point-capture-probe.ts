import { Database } from 'bun:sqlite';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectionVault } from '../../src/exec/connections';
import { readS15RuntimeConfig } from '../../src/s15/runtime-config';
import { FileStore } from '../../src/s16/files/store';
import { openS16ControlMaintenance } from '../../src/s16/operations/control-maintenance';

const hash = (value: Uint8Array) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
/** Actual selected copied-package backup/publication on disposable owning data; no restore/device/physical claim. */
export async function probePackagedPointCapture(configPath: string): Promise<object> {
  const config = readS15RuntimeConfig(configPath), initial = openS16ControlMaintenance(config), ownerId = initial.ownerIdentity; initial.close();
  const bytes = Buffer.from('Private current source for aggregate backup.\n'), fileDirectory = join(config.directory, 'runtime/file-bytes');
  const store = new FileStore({ path: join(config.directory, 'runtime/files.sqlite'), directory: fileDirectory, installationId: config.installationId, create: false, resource: { id: 'computer', revision: 1, generation: 1 }, requireOwner: () => ({ id: ownerId, generation: 1 }) });
  let withdrawnId = '', readyId = '', artifactId = '';
  try {
    for (const requestId of ['withdrawn_original', 'ready_original']) { const upload = store.create({} as never, { requestId, conversationId: 'conversation', name: 'notes.txt', bytes: bytes.length, sha256: hash(bytes) }); await store.write({} as never, upload.id, new Blob([bytes]).stream()); if (requestId === 'withdrawn_original') withdrawnId = upload.id; else readyId = upload.id; }
    artifactId = store.stageArtifact({} as never, { id: 'artifact_pending', requestId: 'artifact_original', workId: 'work_original', conversationId: 'conversation', name: 'draft.md', text: 'Unpublished candidate.\n', inputs: [{ id: withdrawnId, sha256: hash(bytes) }] }).id;
    store.withdraw({} as never, withdrawnId);
  } finally { await store.close(); }
  // Disposable interrupted-unlink fixture: owning withdrawal already committed; retained bytes stay untrusted.
  writeFileSync(join(fileDirectory, withdrawnId + '.blob'), bytes, { mode: 0o600 });
  const vaultId = 'ffffffff-ffff-4fff-8fff-ffffffffffff', vault = new ConnectionVault(join(config.directory, 'vault'), { forbidden: [join(config.directory, 'runtime')] }); vault.write(vaultId, 'fixture-only-protected-secret');
  const protectedPaths = ['owner/owner.sqlite', 'owner/owner.sqlite.lifecycle.sqlite', 'runtime/files.sqlite', 'runtime/file-bytes/' + withdrawnId + '.blob', 'runtime/file-bytes/' + readyId + '.blob', 'vault/' + vaultId], before = protectedPaths.map(path => hash(readFileSync(join(config.directory, path))));
  const selected = ['--s15', '--config', configPath], requestId = 'packaged_backup_original';
  const run = async (args: string[]) => { const child = Bun.spawn([process.execPath, ...args], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }), timer = setTimeout(() => child.kill('SIGKILL'), 25000);
    try { const [exit, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { exit, out, error }; } finally { clearTimeout(timer); } };
  const adopted = await run(['src/s16/operations-cli.ts', 'adopt', ...selected, '--request-id', 'packaged_point_adoption']); if (adopted.exit || adopted.error) throw Error('packaged_point_adoption_failed');
  const interrupted = await run(['-e', `import {readS15RuntimeConfig} from './src/s15/runtime-config';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance';const ctx=openS16ControlMaintenance(readS15RuntimeConfig(${JSON.stringify(configPath)})),cap=ctx.pointCapture('${requestId}',{after(at){if(at==='verifying')process.kill(process.pid,'SIGKILL');}});await cap.capture();throw Error('fixture_no_interrupt');`]);
  if (interrupted.exit === 0 || interrupted.error) throw Error('packaged_point_interruption_failed');
  const controlPath = join(config.directory, 'operations/control.json'), original = JSON.parse(readFileSync(controlPath, 'utf8')).requests.find((row: { requestId: string }) => row.requestId === requestId);
  if (!original || original.phase !== 'verifying' || original.actions.length !== 2 || original.actions.some((row: { state: string }) => row.state !== 'confirmed')) throw Error('packaged_point_original_missing');
  const recovery = `import {ConnectionVault} from './src/exec/connections';import {runS16OperationsCli} from './src/s16/operations-cli';let credentials=0,network=0,processes=0;const denied=()=>{credentials++;throw Error('unexpected_credential');};ConnectionVault.prototype.read=denied;ConnectionVault.prototype.readExisting=denied;globalThis.fetch=Object.assign(async()=>{network++;throw Error('unexpected_network');},{preconnect(){network++;throw Error('unexpected_network');}});Bun.spawn=()=>{processes++;throw Error('unexpected_process');};Bun.spawnSync=Bun.spawn;const result=await runS16OperationsCli(${JSON.stringify(['backup', ...selected, '--request-id', requestId])});console.log(JSON.stringify({result,credentials,network,processes}));`;
  const recovered = await run(['-e', recovery]); if (recovered.exit || recovered.error) throw Error('packaged_point_recovery_failed'); const observed = JSON.parse(recovered.out), result = observed.result;
  const control = JSON.parse(readFileSync(controlPath, 'utf8')), completed = control.requests.find((row: { requestId: string }) => row.requestId === requestId);
  if (result.operationId !== original.id || completed.status !== 'complete' || completed.createdAt !== original.createdAt || completed.admittedRevision !== original.admittedRevision || completed.actions.length !== 3 || completed.actions.some((row: { state: string }) => row.state !== 'confirmed') || completed.actions.slice(0, 2).some((row: { id: string }, at: number) => row.id !== original.actions[at].id) || observed.credentials || observed.network || observed.processes || JSON.stringify(before) !== JSON.stringify(protectedPaths.map(path => hash(readFileSync(join(config.directory, path)))))) throw Error('packaged_point_current_custody_changed');
  const point = join(config.directory, 'operations/points', result.pointId), manifest = JSON.parse(readFileSync(join(point, 'manifest.json'), 'utf8')), references = JSON.parse(readFileSync(join(point, 'references.json'), 'utf8')), catalog = JSON.parse(readFileSync(join(point, 'payloads', result.pointId, 'file_cohort.json'), 'utf8'));
  const withdrawn = catalog.files.find((row: { rowId: string }) => row.rowId === withdrawnId), artifact = catalog.files.find((row: { rowId: string }) => row.rowId === artifactId);
  if (references.external.contract !== 's16-external-custody/v1' || references.external.basis || withdrawn?.state !== 'withdrawn' || withdrawn.trust !== 'untrusted' || artifact?.state !== 'artifact_metadata' || existsSync(join(config.directory, 'runtime/notifications-vapid.key'))) throw Error('packaged_point_catalog_invalid');
  const image = new Database(join(point, 'ledgers', result.pointId, 'files.sqlite'), { readonly: true, create: false });
  try { const row = image.query<{ json: string }, [string]>('SELECT json FROM records WHERE id=?').get(withdrawnId); if (!row || JSON.parse(row.json).state !== 'withdrawn') throw Error('packaged_point_withdrawal_lost'); } finally { image.close(true); }
  const retry = await run(['src/s16/operations-cli.ts', 'backup', ...selected, '--request-id', requestId]); if (retry.exit || retry.error || JSON.stringify(JSON.parse(retry.out)) !== JSON.stringify(result)) throw Error('packaged_point_cli_retry_failed');
  const retired = await run(['src/s16/operations-cli.ts', 'cleanup', ...selected, '--request-id', 'packaged_point_retire', '--point-id', result.pointId]); if (retired.exit || retired.error || existsSync(point)) throw Error('packaged_point_retention_failed');
  const unavailable = await run(['src/s16/operations-cli.ts', 'backup', ...selected, '--request-id', requestId]); if (unavailable.exit === 0 || JSON.parse(unavailable.error).error !== 's16_ops_point_unavailable' || existsSync(point)) throw Error('packaged_point_recreated');
  return { basis: 'protocol_fixture', producer: 'actual_selected_shipped_cli', scope: manifest.scope, bytes: result.bytes, sourcePackageHash: manifest.package.contentHash, catalogs: 'complete', externalReferences: 'actual_current', nativeRoots: 0, physicalSettlement: 'unobserved', interruption: 'actual_sigkill_verifying', originalOperation: 'preserved', originalActions: 'confirmed_once', owningSqlAndFileBytes: 'preserved', withdrawnLeftover: 'untrusted_retained', unpublishedArtifact: 'metadata_only', withdrawalInSqlCopy: 'preserved', credentialReads: observed.credentials, networkCalls: observed.network, subprocessesDuringCapture: observed.processes, cliRetry: 'original_receipt', retirement: 'removed_without_recreation', forwardRestore: 'not_exercised', nativeClient: 'not_exercised' };
}

if (import.meta.main) console.log(JSON.stringify(await probePackagedPointCapture(Bun.argv[2]!)));
