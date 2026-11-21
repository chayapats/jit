import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../errors';
import { canonical } from '../s15/conversation/validation';
import { readS15RuntimeConfig } from '../s15/runtime-config';
import { adoptS16Operations } from './operations/adoption';
import { openS16InstallationLease } from './operations/installation-lease';
import { assertS16OperationsFenceCurrent, readS16OperationsAdoptionFence, readS16OperationsControl, readS16OperationsFence } from './operations/operations-state';
import { opsRead } from '../s14/ops-files';
import { openS16ControlMaintenance } from './operations/control-maintenance';

/** Protected operator entry for bounded current-state backup/repair and independently receipted retention. */
export async function runS16OperationsCli(args: readonly string[]): Promise<object> {
  const command = args[0], values = new Map<string, string>(); let selected = false;
  if (!['adopt', 'status', 'cleanup', 'backup', 'restore', 'abort-backup', 'retire-staging'].includes(command ?? '')) throw new AppError('s16_ops_command_invalid');
  const allowed = command === 'retire-staging' ? ['--config', '--request-id', '--source-request-id'] : command === 'restore' ? ['--config', '--request-id', '--point-id'] : command === 'cleanup' ? ['--config', '--request-id', '--point-id', '--attempt'] : command === 'backup' ? ['--config', '--request-id', '--attempt'] : ['--config', '--request-id'];
  for (let index = 1; index < args.length; index++) {
    const name = args[index]!;
    if (name === '--s15' && !selected) { selected = true; continue; }
    if (!allowed.includes(name) || values.has(name) || !args[index + 1] || args[index + 1]!.startsWith('--')) throw new AppError('s16_ops_command_invalid');
    values.set(name, args[++index]!);
  }
  if (!selected || !values.get('--config') || (command !== 'status') !== values.has('--request-id') || ['cleanup', 'restore'].includes(command!) && !values.has('--point-id') || command === 'retire-staging' && !values.has('--source-request-id')) throw new AppError('explicit_s15_config_required');
  const config = readS15RuntimeConfig(values.get('--config')!);
  if (command === 'adopt') return adoptS16Operations(config, values.get('--request-id')!);
  if (['cleanup', 'backup', 'restore', 'abort-backup', 'retire-staging'].includes(command!)) {
    const fence = join(config.directory, 'owner/owner.sqlite.ops/fence.json');
    const ctx = openS16ControlMaintenance(config, lstatSync(fence, { throwIfNoEntry: false }) ? { operationFence: readS16OperationsFence(config.directory) } : {});
    try {
      if (command === 'abort-backup') return ctx.abortBackup(values.get('--request-id')!);
      if (command === 'retire-staging') return ctx.retireStaging(values.get('--request-id')!, { sourceRequestId: values.get('--source-request-id')! });
      if (command === 'cleanup') return ctx.removePoint(values.get('--request-id')!, { pointId: values.get('--point-id')!, ...(values.has('--attempt') ? { attempt: values.get('--attempt')! } : {}) });
      if (command === 'restore') { const recovery = ctx.restorePoint(values.get('--request-id')!, values.get('--point-id')!); try { return await recovery.repair(); } finally { await recovery.close(); } }
      const capture = ctx.pointCapture(values.get('--request-id')!, values.has('--attempt') ? { attempt: values.get('--attempt')! } : {});
      try { return await capture.capture(); } finally { await capture.close(); }
    }
    finally { ctx.close(); }
  }
  const lease = openS16InstallationLease({ directory: config.directory, mode: 'shared', observation: true });
  try {
    if (lease.operations && lease.operations.installationId !== config.installationId) throw new AppError('s16_ops_control_invalid', 409);
    const fencePath = join(config.directory, 'owner/owner.sqlite.ops/fence.json');
    if (lstatSync(fencePath, { throwIfNoEntry: false })) {
      const envelope = JSON.parse(opsRead(fencePath, 4096).toString('utf8'));
      if (envelope?.contract === 's16-operations-maintenance/v1') {
        const fence = readS16OperationsFence(config.directory), control = readS16OperationsControl(config.directory);
        if (!lease.operations || fence.installationId !== config.installationId) throw new AppError('s16_ops_control_invalid', 409);
        assertS16OperationsFenceCurrent(control, fence); lease.assertCurrent();
        const active = control.requests.find(request => request.id === fence.operationId);
        return { contract: 's16-operations-status/v1', state: 'maintenance_pending', id: fence.id, requestId: fence.requestId, revision: control.revision,
          active: active ? { requestId: active.requestId, kind: active.kind, phase: active.phase, status: active.status, reason: active.reason } : { requestId: fence.requestId, kind: fence.kind, phase: 'pending', status: 'running', reason: null } };
      }
      const fence = readS16OperationsAdoptionFence(config.directory);
      if (fence.installationId !== config.installationId || lease.operations && canonical(lease.operations) !== canonical({ id: fence.id, installationId: fence.installationId, ownerIdentity: fence.ownerIdentity })) throw new AppError('s16_ops_control_invalid', 409);
      lease.assertCurrent(); return { contract: 's16-operations-status/v1', state: 'adoption_pending', id: fence.id, requestId: fence.requestId };
    }
    if (!lease.operations) {
      if (lstatSync(join(config.directory, 'operations/control.json'), { throwIfNoEntry: false })) throw new AppError('s16_ops_adoption_conflict', 409);
      return { contract: 's16-operations-status/v1', state: 'not_adopted' };
    }
    const control = readS16OperationsControl(config.directory); lease.assertCurrent();
    const active = control.requests.find(request => !['complete', 'discarded'].includes(request.status));
    return { contract: 's16-operations-status/v1', state: 'adopted', id: control.id, revision: control.revision, retainedPoints: control.points.length,
      active: active ? { requestId: active.requestId, kind: active.kind, phase: active.phase, status: active.status, reason: active.reason } : null };
  } finally { lease.close(); }
}

if (import.meta.main) {
  try { console.log(JSON.stringify(await runS16OperationsCli(process.argv.slice(2)))); }
  catch (error) { console.error(JSON.stringify({ error: error instanceof AppError ? error.code : 's16_ops_command_failed' })); process.exitCode = 1; }
}
