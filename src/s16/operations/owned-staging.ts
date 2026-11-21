import { createHash } from 'node:crypto';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../errors';
import { opsDirectory } from '../../s14/ops-files';
import { canonical } from '../../s15/conversation/validation';
import type { S16OperationsJournal } from './operations-journal';
import type { S16OperationsBinding, S16OperationsRequest } from './operations-state';
import { s16PointEntry, s16PointEntryIdentity } from './point-files';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function refuse(): never { throw new AppError('s16_ops_staging_ownership_invalid', 409); }
/** A fixed temporary capture namespace; no caller/archive-selected filesystem path is accepted. */
export type S16StagingRole = 'native' | 'point';
/** Original independently journaled directory identities, separate from incomplete child metadata. */
export interface S16OwnedStage {
  readonly role: S16StagingRole; readonly captureActionId: string; readonly actionId: string;
  readonly root: string; readonly data: string; readonly rootSha256: string; readonly dataSha256: string;
}
/** Maps only an original local capture action to its fixed private temporary namespace. */
export function s16StagingPath(directory: string, request: S16OperationsRequest, role: S16StagingRole, captureActionId: string): string {
  if (!['native', 'point'].includes(role) || request.kind !== 'backup' || !/^[a-f0-9]{32}$/.test(request.id) || !request.actions.some(row => row.id === captureActionId && row.kind === (role === 'native' ? 'capture_native' : 'capture_backend'))) refuse();
  return join(directory, 'operations/' + role + '-staging', request.id, captureActionId);
}
/** Original ownership identity, derived from the original capture rather than failed stage metadata. */
export function s16StagingOwnershipId(role: S16StagingRole, captureActionId: string): string { return 'stage_own_' + role + '_' + hash(captureActionId); }
function directoryDigest(binding: S16OperationsBinding, request: S16OperationsRequest, role: S16StagingRole, captureActionId: string, part: 'root' | 'data', path: string): string {
  return hash(canonical({ contract: 's16-owned-staging/v1', operationsId: binding.id, installationId: binding.installationId, ownerIdentity: binding.ownerIdentity,
    operationId: request.id, requestId: request.requestId, commandSha256: request.hash, configurationSha256: request.configurationSha256,
    admittedRevision: request.admittedRevision, createdAt: request.createdAt, role, captureActionId, part, identity: s16PointEntryIdentity(s16PointEntry(path, true), true) }));
}
/** Verifies original root custody, and data custody when present, without decoding any child file. */
export function inspectS16OwnedStage(directory: string, binding: S16OperationsBinding, request: S16OperationsRequest, role: S16StagingRole, captureActionId: string, dataLocation?: string): Readonly<S16OwnedStage> {
  const root = s16StagingPath(directory, request, role, captureActionId), data = join(root, 'data'), actionId = s16StagingOwnershipId(role, captureActionId);
  const action = request.actions.find(row => row.id === actionId);
  if (!action || action.kind !== 'own_staging' || action.state !== 'confirmed' || action.observedSha256 !== action.targetSha256 || !action.priorSha256 || !action.targetSha256 || directoryDigest(binding, request, role, captureActionId, 'root', root) !== action.priorSha256) refuse();
  const actualData = dataLocation ?? data;
  if (dataLocation || lstatSync(data, { throwIfNoEntry: false })) if (directoryDigest(binding, request, role, captureActionId, 'data', actualData) !== action.targetSha256) refuse();
  return Object.freeze({ role, captureActionId, actionId, root, data, rootSha256: action.priorSha256, dataSha256: action.targetSha256 });
}
/** Journals both empty directory identities before the first child write; an unowned nonempty tree refuses. */
export function ownS16Staging(directory: string, journal: S16OperationsJournal, requestId: string, role: S16StagingRole, captureActionId: string, guard: () => void, verifyOnly = false, dataLocation?: string): Readonly<S16OwnedStage> {
  guard(); let control = journal.read(), request = control.requests.find(row => row.requestId === requestId); if (!request) refuse();
  const root = s16StagingPath(directory, request, role, captureActionId), data = join(root, 'data'), actionId = s16StagingOwnershipId(role, captureActionId);
  let action = request.actions.find(row => row.id === actionId);
  if (action) {
    // An original intent is only emitted for an empty root/data pair. No data writes precede confirmation.
    if (action.state !== 'confirmed') {
      if (verifyOnly || action.kind !== 'own_staging' || action.state === 'not_applied' || readdirSync(root).sort().join(',') !== 'data' || readdirSync(data).length ||
        action.priorSha256 !== directoryDigest(control, request, role, captureActionId, 'root', root) || action.targetSha256 !== directoryDigest(control, request, role, captureActionId, 'data', data)) refuse();
      journal.observeAction(requestId, control.revision, actionId, 'applied', action.targetSha256); control = journal.read(); request = control.requests.find(row => row.requestId === requestId)!;
    }
  } else {
    if (verifyOnly || dataLocation) refuse();
    opsDirectory(root);
    if (readdirSync(root).some(name => name !== 'data')) refuse();
    opsDirectory(data); if (readdirSync(data).length) refuse();
    guard(); const priorSha256 = directoryDigest(control, request, role, captureActionId, 'root', root), targetSha256 = directoryDigest(control, request, role, captureActionId, 'data', data);
    journal.recordIntent(requestId, control.revision, { id: actionId, kind: 'own_staging', priorSha256, targetSha256 });
    control = journal.read(); request = control.requests.find(row => row.requestId === requestId)!;
    if (directoryDigest(control, request, role, captureActionId, 'root', root) !== priorSha256 || directoryDigest(control, request, role, captureActionId, 'data', data) !== targetSha256) refuse();
    journal.observeAction(requestId, control.revision, actionId, 'applied', targetSha256); control = journal.read(); request = control.requests.find(row => row.requestId === requestId)!;
  }
  guard(); if (!lstatSync(dataLocation ?? data, { throwIfNoEntry: false })) refuse();
  return inspectS16OwnedStage(directory, control, request, role, captureActionId, dataLocation);
}
