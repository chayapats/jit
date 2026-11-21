import { createHash } from 'node:crypto';
import { lstatSync, opendirSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../errors';
import { opsDirectory } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import { assertS16ExclusiveInstallationLease, type S16InstallationLease } from './installation-lease';
import type { S16OperationsJournal } from './operations-journal';
import { s16PointEntry, s16PointEntryIdentity } from './point-files';
import type { S16OperationsControl, S16OperationsRequest } from './operations-state';

const parts = ['ledgers', 'payloads', 'quarantine'] as const;
export type S16RecoveryStagePart = typeof parts[number];
const metadata = ['candidate.json', 'current.json', 'plan.json', 'progress.json'];
const actualStages = new WeakMap<S16RecoveryStage, { requestId: string; operationId: string; assertCurrent(): void }>();
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function refuse(code = 's16_ops_recovery_stage_invalid'): never { throw new AppError(code, 409); }
/** Pure scope derivation; callers still authenticate the current journal, source receipt and actual inode ownership. */
export function s16RecoveryStageScope(control: Pick<S16OperationsControl, 'id' | 'installationId' | 'ownerIdentity'>, request: S16OperationsRequest): string {
  return hash(canonical({ contract: 's16-recovery-staging/v1', operationsId: control.id, installationId: control.installationId, ownerIdentity: control.ownerIdentity,
    operationId: request.id, requestId: request.requestId, commandSha256: request.hash, configurationSha256: request.configurationSha256, admittedRevision: request.admittedRevision, createdAt: request.createdAt, pointId: request.pointId }));
}
function names(path: string, bound: number): string[] {
  const result: string[] = [], directory = opendirSync(path);
  try { for (;;) { const next = directory.readSync(); if (!next) break; if (result.length >= bound) refuse('s16_ops_recovery_bounds'); result.push(next.name); } }
  finally { directory.closeSync(); } return result.sort();
}
/** Independently journaled original private namespace; child metadata never authenticates its own custody. */
export interface S16RecoveryStage {
  readonly contract: 's16-recovery-staging/v1'; readonly operationId: string; readonly requestId: string;
  readonly root: string; readonly scopeSha256: string; readonly actionId: string;
  path(part: S16RecoveryStagePart): string;
  assertCurrent(): void;
}
/** Actual protected current composition, never historical metadata or an ordinary actor input. */
export interface S16RecoveryStageOwner {
  directory: string; installationId: string; ownerIdentity: string; configurationSha256: string;
  lease: S16InstallationLease; journal: S16OperationsJournal; guard(): void;
}
/** Fault observers see original durable boundaries; they cannot choose paths or ownership hashes. */
export interface S16RecoveryStageOptions { after?(boundary: 'directories' | 'intent' | 'observed'): void }
/** Requires the actual original namespace capability rather than caller-selected paths or copied methods. */
export function assertS16RecoveryStageFor(stage: S16RecoveryStage, requestId: string, operationId: string): void {
  const actual = stage && typeof stage === 'object' ? actualStages.get(stage) : undefined;
  if (!actual || actual.requestId !== requestId || actual.operationId !== operationId) refuse(); actual.assertCurrent();
}
/**
 * Confirms empty root/child inode identities in the current restore journal before any payload,
 * candidate, SQL or opaque native write. Missing owned paths refuse recreation; unknown original
 * ownership can be confirmed only while the exact originally pinned namespace is still empty.
 */
export function ownS16RecoveryStage(owner: S16RecoveryStageOwner, requestId: string, options: S16RecoveryStageOptions = {}): S16RecoveryStage {
  identity(requestId);
  const guard = () => { assertS16ExclusiveInstallationLease(owner.lease, owner.directory); if ((owner.guard() as unknown) !== undefined) refuse('s16_ops_guard_invalid'); }; guard();
  const read = () => {
    guard(); const control = owner.journal.read(), request = control.requests.find(row => row.requestId === requestId);
    if (!request || request.kind !== 'restore' || !request.pointId || request.configurationSha256 !== owner.configurationSha256 || control.installationId !== owner.installationId || control.ownerIdentity !== owner.ownerIdentity || !['capturing', 'verifying', 'prepared', 'activating'].includes(request.phase) || ['complete', 'discarded'].includes(request.status)) refuse();
    return { control, request };
  };
  const initial = read(), operationId = initial.request.id;
  const scopeSha256 = s16RecoveryStageScope(initial.control, initial.request);
  const actionId = 'recovery_own_' + scopeSha256, root = join(owner.directory, 'operations/forward-recovery', operationId);
  const path = (part: S16RecoveryStagePart) => { if (!(parts as readonly string[]).includes(part)) refuse(); return join(root, part); };
  const digests = () => ({ priorSha256: hash(canonical({ scopeSha256, root: s16PointEntryIdentity(s16PointEntry(root, true), true) })),
    targetSha256: hash(canonical({ scopeSha256, parts: parts.map(part => ({ part, identity: s16PointEntryIdentity(s16PointEntry(path(part), true), true) })) })) });
  const empty = () => {
    if (names(root, 8).join(',') !== [...parts].sort().join(',') || parts.some(part => names(path(part), 1).length)) refuse();
  };
  const after = (boundary: 'directories' | 'intent' | 'observed') => { guard(); if ((options.after?.(boundary) as unknown) !== undefined) refuse('s16_ops_guard_invalid'); guard(); };
  let state = read(), action = state.request.actions.find(row => row.id === actionId);
  if (!action) {
    if (state.request.phase !== 'capturing' || state.request.status !== 'running') refuse();
    opsDirectory(root);
    if (names(root, 8).some(name => !(parts as readonly string[]).includes(name))) refuse();
    for (const part of parts) opsDirectory(path(part)); empty(); after('directories');
    const expected = digests(); owner.journal.recordIntent(requestId, state.control.revision, { id: actionId, kind: 'capture_backend', ...expected }); after('intent');
    state = read(); action = state.request.actions.find(row => row.id === actionId);
  }
  if (!action || action.kind !== 'capture_backend' || action.state === 'not_applied') refuse();
  const expected = digests();
  if (action.priorSha256 !== expected.priorSha256 || action.targetSha256 !== expected.targetSha256) refuse();
  if (action.state !== 'confirmed') {
    empty(); owner.journal.observeAction(requestId, state.control.revision, actionId, 'applied', expected.targetSha256); after('observed');
  }
  const assertCurrent = () => {
    const latest = read(), original = latest.request.actions.find(row => row.id === actionId), current = digests();
    if (latest.request.id !== operationId || !original || original.kind !== 'capture_backend' || original.state !== 'confirmed' || original.observedSha256 !== expected.targetSha256 || original.priorSha256 !== expected.priorSha256 || original.targetSha256 !== expected.targetSha256 || current.priorSha256 !== expected.priorSha256 || current.targetSha256 !== expected.targetSha256) refuse();
    for (const name of names(root, 8)) {
      if ((parts as readonly string[]).includes(name)) continue;
      if (!metadata.includes(name)) refuse(); s16PointEntry(join(root, name));
    }
    guard();
  }; assertCurrent();
  const stage = Object.freeze<S16RecoveryStage>({ contract: 's16-recovery-staging/v1', operationId, requestId, root, scopeSha256, actionId, path, assertCurrent });
  actualStages.set(stage, { requestId, operationId, assertCurrent }); return stage;
}
