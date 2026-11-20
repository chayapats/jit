import { createHash } from 'node:crypto';
import { lstatSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from '../../errors';
import { opsSyncDirectory } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import type { S16OperationsJournal } from './operations-journal';
import { inspectS16OwnedStage, ownS16Staging, s16StagingOwnershipId, type S16OwnedStage } from './owned-staging';
import { s16PointDirectory } from './point-files';

const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function refuse(): never { throw new AppError('s16_ops_backup_abort_refused', 409); }
/** Observes only original abort boundaries; never supplies authority, filesystem paths or replacement facts. */
export interface S16BackupAbortOptions { after?(boundary: 'quarantine_intent' | 'quarantined' | 'quarantine_observed' | 'discarded'): void }
/** Stable original logical disposition, separate from explicit retirement of temporary bytes. */
export interface S16BackupAbortResult { contract: 's16-backup-abort-result/v1'; state: 'discarded'; requestId: string; operationId: string; revision: number }
/** Exact current exclusive composition supplies resource-release and owner/configuration checks. */
export interface S16BackupAbortOwner { directory: string; journal: S16OperationsJournal; guard(): void; assertReleased(): void }
/** Quarantines only original owned unregistered data, then preserves all old capture facts in a logical abort. */
export function abortS16Backup(owner: S16BackupAbortOwner, requestId: string, options: S16BackupAbortOptions = {}): Readonly<S16BackupAbortResult> {
  identity(requestId); const { journal } = owner;
  const guard = () => { if ((owner.guard() as unknown) !== undefined || (owner.assertReleased() as unknown) !== undefined) refuse(); }; guard();
  const after = (boundary: Parameters<NonNullable<S16BackupAbortOptions['after']>>[0]) => { guard(); if ((options.after?.(boundary) as unknown) !== undefined) refuse(); guard(); };
  const read = () => { guard(); const control = journal.read(), request = control.requests.find(row => row.requestId === requestId); if (!request || request.kind !== 'backup' || !request.pointId || control.points.some(row => row.id === request.pointId)) return refuse(); return { control, request }; };
  let state = read(); const point = s16PointDirectory(owner.directory, state.request.pointId!);
  if (state.request.status === 'complete' || state.request.status === 'discarded' && !state.request.abort) refuse();
  if (state.request.status === 'discarded') {
    const result = journal.abortBackup(requestId, state.control.revision); after('discarded');
    return Object.freeze({ contract: 's16-backup-abort-result/v1', state: 'discarded', requestId, operationId: result.request.id, revision: result.request.revision });
  }
  // Reconcile an original empty ownership intent before disposition, without changing capture outcomes.
  for (const capture of state.request.actions.filter(row => ['capture_native', 'capture_backend'].includes(row.kind))) {
    const role = capture.kind === 'capture_native' ? 'native' : 'point', ownershipId = s16StagingOwnershipId(role, capture.id), ownership = state.request.actions.find(row => row.id === ownershipId);
    if (ownership && !['confirmed', 'not_applied'].includes(ownership.state)) ownS16Staging(owner.directory, journal, requestId, role, capture.id, guard);
  }
  state = read();
  const quarantines = state.request.actions.filter(row => row.kind === 'quarantine_point'); if (quarantines.length > 1) refuse();
  if (lstatSync(point, { throwIfNoEntry: false }) || quarantines.length) {
    if (state.request.phase !== 'verifying') refuse();
    const present = !!lstatSync(point, { throwIfNoEntry: false });
    const captures = state.request.actions.filter(row => row.kind === 'capture_backend' && state.request.actions.some(own => own.id === s16StagingOwnershipId('point', row.id) && (!quarantines.length || own.targetSha256 === quarantines[0]!.priorSha256)));
    const matches: Readonly<S16OwnedStage>[] = [];
    for (const capture of captures) try {
      const owned = inspectS16OwnedStage(owner.directory, state.control, state.request, 'point', capture.id, present ? point : undefined);
      if (present && lstatSync(owned.data, { throwIfNoEntry: false }) || !present && !lstatSync(owned.data, { throwIfNoEntry: false })) continue; matches.push(owned);
    } catch { /* Only an independently journaled exact original data inode can match. */ }
    if (matches.length !== 1) refuse(); const owned = matches[0]!;
    const actionId = 'point_quarantine_' + owned.dataSha256, targetSha256 = hash({ contract: 's16-point-quarantine/v1', operationsId: state.control.id, operationId: state.request.id, requestId, pointId: state.request.pointId, ownershipId: owned.actionId, rootSha256: owned.rootSha256, dataSha256: owned.dataSha256 });
    const old = quarantines[0]; if (old && (old.id !== actionId || old.priorSha256 !== owned.dataSha256 || old.targetSha256 !== targetSha256 || old.state === 'not_applied')) refuse();
    if (!old) { journal.recordIntent(requestId, state.control.revision, { id: actionId, kind: 'quarantine_point', priorSha256: owned.dataSha256, targetSha256 }); after('quarantine_intent'); }
    if (present) {
      guard(); state = read(); inspectS16OwnedStage(owner.directory, state.control, state.request, 'point', owned.captureActionId, point);
      if (lstatSync(owned.data, { throwIfNoEntry: false })) refuse(); renameSync(point, owned.data); opsSyncDirectory(dirname(point)); opsSyncDirectory(owned.root); after('quarantined');
    }
    state = read(); if (lstatSync(point, { throwIfNoEntry: false })) refuse(); inspectS16OwnedStage(owner.directory, state.control, state.request, 'point', owned.captureActionId);
    journal.observeAction(requestId, state.control.revision, actionId, 'applied', targetSha256); after('quarantine_observed');
  }
  state = read(); if (lstatSync(point, { throwIfNoEntry: false })) refuse();
  const result = journal.abortBackup(requestId, state.control.revision); after('discarded');
  return Object.freeze({ contract: 's16-backup-abort-result/v1', state: 'discarded', requestId, operationId: result.request.id, revision: result.request.revision });
}
