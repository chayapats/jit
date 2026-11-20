import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../errors';
import { opsAtomic, opsDirectory, opsRead } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import type { S15RuntimeConfig } from '../../s15/runtime-config';
import { openS16ControlMaintenance } from './control-maintenance';
import { readS16OperationsAdoptionFence, readS16OperationsControl, validateS16OperationsControl, type S16OperationsAdoptionFence, type S16OperationsControl } from './operations-state';

function refuse(code = 's16_ops_adoption_conflict'): never { throw new AppError(code, 409); }
/** Metadata-only adoption result. It certifies neither aggregate recovery nor physical/native settlement. */
export interface S16OperationsAdoptionReceipt { contract: 's16-operations-adoption/v1'; id: string; installationId: string; state: 'adopted' | 'already_adopted'; revision: number }
/** Trusted deterministic fault/clock seams; never ordinary client, archive or model-selected callbacks. */
export interface S16OperationsAdoptionOptions {
  now?(): number; id?(): string;
  after?(boundary: 'fence' | 'control' | 'binding' | 'cleared'): void;
}
/**
 * Explicitly adopts operations metadata over existing validated control. Original fences resume the
 * same initialization, whereas a missing/corrupt adopted journal refuses before application access.
 * No application ledger, policy, credential, backend or client binding is initialized or replaced.
 */
export function adoptS16Operations(config: S15RuntimeConfig, requestId: string, options: S16OperationsAdoptionOptions = {}): S16OperationsAdoptionReceipt {
  identity(requestId); const root = config.directory, fencePath = join(root, 'owner/owner.sqlite.ops/fence.json');
  const configurationSha256 = createHash('sha256').update(canonical(config)).digest('hex');
  const originalFence = lstatSync(fencePath, { throwIfNoEntry: false }) ? readS16OperationsAdoptionFence(root) : undefined;
  if (originalFence && (originalFence.requestId !== requestId || originalFence.installationId !== config.installationId || originalFence.configurationSha256 !== configurationSha256)) refuse();
  const current = openS16ControlMaintenance(config, originalFence ? { adoptionFence: originalFence } : {});
  const after = (boundary: Parameters<NonNullable<S16OperationsAdoptionOptions['after']>>[0]) => { if ((options.after?.(boundary) as unknown) !== undefined) refuse('s16_ops_adoption_callback_invalid'); };
  try {
    const receiptPath = join(root, 's16-operations.lease.json'), operationsPath = join(root, 'operations'), controlPath = join(operationsPath, 'control.json');
    // The current capability already validated any v2 binding; its journal is not a fresh initializer.
    if (!originalFence && lstatSync(controlPath, { throwIfNoEntry: false })) {
      const control = readS16OperationsControl(root);
      if (control.ownerIdentity !== current.ownerIdentity || control.installationId !== config.installationId || control.adoption.requestId !== requestId || control.adoption.configurationSha256 !== configurationSha256) refuse();
      // A valid but unbound journal must not be silently adopted after losing its original fence.
      const receipt = JSON.parse(opsRead(receiptPath, 1024).toString('utf8'));
      if (receipt.contract !== 's16-installation-lease/v2' || receipt.operations?.id !== control.id) refuse();
      return { contract: 's16-operations-adoption/v1', id: control.id, installationId: config.installationId, state: 'already_adopted', revision: control.revision };
    }
    if (!originalFence && lstatSync(operationsPath, { throwIfNoEntry: false }) && readdirSync(operationsPath).length) refuse();
    const fence: S16OperationsAdoptionFence = originalFence ?? {
      contract: 's16-operations-adoption/v1', id: (options.id ?? (() => crypto.randomUUID().replaceAll('-', '')))(), installationId: config.installationId, ownerIdentity: current.ownerIdentity,
      requestId, configurationSha256, createdAt: (options.now ?? Date.now)(),
    };
    current.retainAdoptionFence(fence); after('fence');
    const control: S16OperationsControl = {
      contract: 's16-operations-control/v1', id: fence.id, installationId: fence.installationId, ownerIdentity: fence.ownerIdentity, revision: 0,
      adoption: { requestId: fence.requestId, configurationSha256: fence.configurationSha256, createdAt: fence.createdAt }, requests: [], points: [],
    }; validateS16OperationsControl(control);
    if (lstatSync(controlPath, { throwIfNoEntry: false })) {
      if (canonical(readS16OperationsControl(root)) !== canonical(control)) refuse();
    } else {
      opsDirectory(operationsPath); current.assertCurrent();
      // The exclusive installation lease plus original admission fence excludes every supported writer.
      // Only initial unbound adoption reaches this create; normal missing adopted state never does.
      opsAtomic(controlPath, JSON.parse(canonical(control)));
      if (canonical(readS16OperationsControl(root)) !== canonical(control)) refuse('s16_ops_adoption_unknown');
    }
    after('control'); current.publishOperationsBinding(); after('binding');
    current.completeAdoptionFence(); after('cleared');
    return { contract: 's16-operations-adoption/v1', id: control.id, installationId: config.installationId, state: 'adopted', revision: 0 };
  } finally { current.close(); }
}
