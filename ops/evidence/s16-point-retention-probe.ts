import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConnectionVault } from '../../src/exec/connections';
import { pointFormatFixture, pointFixtureHash } from '../../tests/fixtures/s16-point';

/** Actual copied-package removal of a disposable point-format fixture, never aggregate backup acceptance. */
export async function probePackagedPointRetention(): Promise<object> {
  const f = await pointFormatFixture(), requestId = 'packaged_removal_original';
  try {
    const protectedPaths = ['owner/owner.sqlite', 'owner/owner.sqlite.lifecycle.sqlite', 'runtime/files.sqlite', 'runtime/file-bytes/' + f.uploadId + '.blob'];
    const protectedBefore = protectedPaths.map(path => pointFixtureHash(readFileSync(join(f.directory, path)))), backup = f.context.operations().read().requests[0]!;
    f.context.close();
    const code = `import {readS15RuntimeConfig} from './src/s15/runtime-config';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance';const ctx=openS16ControlMaintenance(readS15RuntimeConfig(${JSON.stringify(f.configPath)}));ctx.removePoint('${requestId}',{pointId:'${f.pointId}',after(at){if(at==='file')process.kill(process.pid,'SIGKILL');}});throw Error('fixture_no_interrupt');`;
    const child = Bun.spawn([process.execPath, '-e', code], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' }), timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    try { const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]); if (exit === 0 || error) throw Error('packaged_removal_interruption_failed'); } finally { clearTimeout(timer); }
    f.open(); const journal = f.context.operations(), original = journal.read().requests.find(row => row.requestId === requestId)!;
    if (original.status !== 'running' || original.actions.length !== 1 || original.actions[0]!.state !== 'intent') throw Error('packaged_removal_original_missing');
    const planPath = join(f.directory, 'operations/retention', original.id, original.actions[0]!.id, 'plan.json'), planSha256 = pointFixtureHash(readFileSync(planPath));
    let credentials = 0, network = 0, subprocesses = 0;
    const read = ConnectionVault.prototype.read, existing = ConnectionVault.prototype.readExisting, fetch = globalThis.fetch, spawn = Bun.spawn, spawnSync = Bun.spawnSync;
    const credential = () => { credentials++; throw Error('unexpected_packaged_credential'); };
    ConnectionVault.prototype.read = credential; ConnectionVault.prototype.readExisting = credential;
    globalThis.fetch = Object.assign(async (): Promise<Response> => { network++; throw Error('unexpected_packaged_network'); }, { preconnect() { network++; throw Error('unexpected_packaged_network'); } }) as typeof fetch;
    Bun.spawn = (() => { subprocesses++; throw Error('unexpected_packaged_process'); }) as typeof Bun.spawn;
    Bun.spawnSync = (() => { subprocesses++; throw Error('unexpected_packaged_process'); }) as typeof Bun.spawnSync;
    let result;
    try { result = f.context.removePoint(requestId, { pointId: f.pointId }); }
    finally { ConnectionVault.prototype.read = read; ConnectionVault.prototype.readExisting = existing; globalThis.fetch = fetch; Bun.spawn = spawn; Bun.spawnSync = spawnSync; }
    const completed = journal.read().requests.find(row => row.requestId === requestId)!;
    if (result.operationId !== original.id || completed.status !== 'complete' || completed.actions.length !== 1 || completed.actions[0]!.id !== original.actions[0]!.id || completed.actions[0]!.state !== 'confirmed' || existsSync(f.root) || journal.read().points.length || pointFixtureHash(readFileSync(planPath)) !== planSha256 || JSON.stringify(journal.read().requests[0]) !== JSON.stringify(backup) || JSON.stringify(protectedBefore) !== JSON.stringify(protectedPaths.map(path => pointFixtureHash(readFileSync(join(f.directory, path))))) || credentials || network || subprocesses) throw Error('packaged_removal_custody_failed');
    f.context.close();
    const cli = Bun.spawn([process.execPath, 'src/s16/operations-cli.ts', 'cleanup', '--s15', '--config', f.configPath, '--request-id', requestId, '--point-id', f.pointId], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [exit, out, error] = await Promise.all([cli.exited, new Response(cli.stdout).text(), new Response(cli.stderr).text()]);
    if (exit !== 0 || error || JSON.stringify(JSON.parse(out)) !== JSON.stringify(result)) throw Error('packaged_removal_cli_retry_failed');
    f.open(); mkdirSync(f.root, { mode: 0o700 }); writeFileSync(join(f.root, 'unowned.txt'), 'Reappeared fixture bytes.', { mode: 0o600 });
    let refused = false; try { f.context.removePoint(requestId, { pointId: f.pointId }); } catch { refused = true; }
    if (!refused || readFileSync(join(f.root, 'unowned.txt'), 'utf8') !== 'Reappeared fixture bytes.') throw Error('packaged_removal_reappeared_point_deleted');
    return { basis: 'point_format_fixture_only', contract: 's16-point-files/v1', files: f.inventory.files.length, bytes: f.inventory.bytes, interruption: 'actual_sigkill_after_unlink', originalOperation: 'preserved', originalAction: 'confirmed_once', originalPlan: 'retained_unchanged', backupReceipt: 'preserved', currentSqlAndFileBytes: 'preserved', credentialReads: credentials, networkCalls: network, subprocessesDuringRecovery: subprocesses, protectedCliRetry: 'original_result', reappearedPoint: 'refused_untouched', aggregateBackup: 'not_exercised' };
  } finally { f.dispose(); }
}

if (import.meta.main) console.log(JSON.stringify(await probePackagedPointRetention()));
