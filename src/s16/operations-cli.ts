import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../errors';
import { canonical } from '../s15/conversation/validation';
import { readS15RuntimeConfig } from '../s15/runtime-config';
import { adoptS16Operations } from './operations/adoption';
import { openS16InstallationLease } from './operations/installation-lease';
import { readS16OperationsAdoptionFence, readS16OperationsControl } from './operations/operations-state';

/** Explicit protected operator entry. It currently adopts/inspects metadata, never advertises aggregate recovery. */
export function runS16OperationsCli(args: readonly string[]): object {
  const command = args[0], values = new Map<string, string>(); let selected = false;
  if (!['adopt', 'status'].includes(command ?? '')) throw new AppError('s16_ops_command_invalid');
  for (let index = 1; index < args.length; index++) {
    const name = args[index]!;
    if (name === '--s15' && !selected) { selected = true; continue; }
    if (!['--config', '--request-id'].includes(name) || values.has(name) || !args[index + 1] || args[index + 1]!.startsWith('--')) throw new AppError('s16_ops_command_invalid');
    values.set(name, args[++index]!);
  }
  if (!selected || !values.get('--config') || (command === 'adopt') !== values.has('--request-id')) throw new AppError('explicit_s15_config_required');
  const config = readS15RuntimeConfig(values.get('--config')!);
  if (command === 'adopt') return adoptS16Operations(config, values.get('--request-id')!);
  const lease = openS16InstallationLease({ directory: config.directory, mode: 'shared' });
  try {
    if (lease.operations && lease.operations.installationId !== config.installationId) throw new AppError('s16_ops_control_invalid', 409);
    const fencePath = join(config.directory, 'owner/owner.sqlite.ops/fence.json');
    if (lstatSync(fencePath, { throwIfNoEntry: false })) {
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
  try { console.log(JSON.stringify(runS16OperationsCli(process.argv.slice(2)))); }
  catch (error) { console.error(JSON.stringify({ error: error instanceof AppError ? error.code : 's16_ops_command_failed' })); process.exitCode = 1; }
}
