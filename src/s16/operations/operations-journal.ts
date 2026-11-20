import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../errors';
import { opsAtomic } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import { assertS16ExclusiveInstallationLease, type S16InstallationLease } from './installation-lease';
import { assertS16OperationsFenceCurrent, canonicalS16OperationsControl, readS16OperationsControl, readS16OperationsFence, s16OperationsLimits, s16OperationsPhases, validateS16OperationsControl, type S16OperationsAction, type S16OperationsControl, type S16OperationsFence, type S16OperationsRequest } from './operations-state';

function refuse(code = 's16_ops_request_conflict'): never { throw new AppError(code, 409); }
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const terminal = (row: S16OperationsRequest) => ['complete', 'discarded'].includes(row.status);
const settled = (action: S16OperationsAction) => ['confirmed', 'not_applied'].includes(action.state);
const clone = <T>(value: T): T => JSON.parse(canonical(value)) as T;
/** Protected command fingerprint. A hash is supplied by the owning normalized operator command, never by an archive. */
export interface S16OperationsBegin { requestId: string; kind: S16OperationsRequest['kind']; hash: string; pointId?: string | null }
/** New metadata is not execution authority. A recorded old intent always needs owning readback before another effect. */
export interface S16OperationsMutation { readonly revision: number; readonly request: Readonly<S16OperationsRequest>; readonly fresh: boolean }
/** Only genuine current-control composition supplies these private fencing hooks and lease. */
export interface S16OperationsJournalOptions {
  directory: string; lease: S16InstallationLease; configurationSha256: string; guard(): void;
  retainFence(fence: S16OperationsFence): void; clearFence(fence: S16OperationsFence): void;
  now?(): number; id?(): string; after?(boundary: 'fence' | 'write' | 'clear'): void;
}
/** Durable current metadata only. Physical capture/verification/deletion remain with the owning coordinator. */
export interface S16OperationsJournal {
  read(): Readonly<S16OperationsControl>;
  begin(command: S16OperationsBegin, expectedRevision: number): S16OperationsMutation;
  advance(requestId: string, expectedRevision: number, phase: S16OperationsRequest['phase'], binding?: { cohortSha256?: string; targetSha256?: string }): S16OperationsMutation;
  recordIntent(requestId: string, expectedRevision: number, action: Omit<S16OperationsAction, 'state' | 'observedSha256'>): S16OperationsMutation;
  observeAction(requestId: string, expectedRevision: number, actionId: string, outcome: 'applied' | 'not_applied', observedSha256: string | null): S16OperationsMutation;
  block(requestId: string, expectedRevision: number, reason: string, unknownActionId?: string): S16OperationsMutation;
  resume(requestId: string, expectedRevision: number): S16OperationsMutation;
  retainPoint(requestId: string, expectedRevision: number, point: { sha256: string; bytes: number }): S16OperationsMutation;
  planPointRemoval(requestId: string, expectedRevision: number, actionId?: string): S16OperationsMutation;
  recordPointRemoved(requestId: string, expectedRevision: number): S16OperationsMutation;
}
/**
 * Opens the fixed existing bound current journal under actual exclusive exclusion. It never initializes
 * missing state or executes a physical action. Every write keeps the original gate until a verified
 * terminal receipt; idempotent metadata cannot authorize replay of a prior uncertain attempt.
 */
export function openS16OperationsJournal(options: S16OperationsJournalOptions): S16OperationsJournal {
  const root = options.directory, fencePath = join(root, 'owner/owner.sqlite.ops/fence.json');
  if (!sha(options.configurationSha256)) refuse();
  const guard = () => { assertS16ExclusiveInstallationLease(options.lease, root); if ((options.guard() as unknown) !== undefined) refuse('s16_ops_guard_invalid'); };
  const after = (boundary: 'fence' | 'write' | 'clear') => { if ((options.after?.(boundary) as unknown) !== undefined) refuse('s16_ops_guard_invalid'); };
  const read = () => {
    guard(); const control = readS16OperationsControl(root), binding = options.lease.operations;
    if (!binding || control.id !== binding.id || control.installationId !== binding.installationId || control.ownerIdentity !== binding.ownerIdentity) refuse('s16_ops_control_invalid');
    return control;
  };
  const writable = (control: S16OperationsControl) => {
    if (control.contract === 's16-operations-control/v1' && (control.revision !== 0 || control.requests.length || control.points.length)) refuse('s16_ops_control_upgrade_required');
  };
  const clock = (floor: number) => { const value = (options.now ?? Date.now)(); if (!Number.isSafeInteger(value) || value < 0) refuse('s16_ops_clock_invalid'); return Math.max(value, floor); };
  const result = (control: S16OperationsControl, request: S16OperationsRequest, fresh: boolean): S16OperationsMutation => Object.freeze({ revision: control.revision, request: clone(request), fresh });
  const originalFence = (control: S16OperationsControl, request: S16OperationsRequest): S16OperationsFence => {
    if (!sha(request.configurationSha256) || request.configurationSha256 !== options.configurationSha256 || !Number.isSafeInteger(request.admittedRevision) || request.admittedRevision! < 1) refuse('s16_ops_configuration_changed');
    return { contract: 's16-operations-maintenance/v1', id: control.id, installationId: control.installationId, ownerIdentity: control.ownerIdentity, operationId: request.id, requestId: request.requestId, kind: request.kind, hash: request.hash, pointId: request.pointId,
      configurationSha256: request.configurationSha256, priorRevision: request.admittedRevision! - 1, createdAt: request.createdAt };
  };
  const ensureFence = (control: S16OperationsControl, request: S16OperationsRequest) => {
    const fence = originalFence(control, request);
    if (lstatSync(fencePath, { throwIfNoEntry: false })) { if (canonical(readS16OperationsFence(root)) !== canonical(fence)) refuse('s16_ops_operation_busy'); }
    else { options.retainFence(fence); after('fence'); }
    if (canonical(readS16OperationsFence(root)) !== canonical(fence)) refuse('s16_ops_fence_invalid');
    assertS16OperationsFenceCurrent(control, fence); guard(); return fence;
  };
  const clearIfOwn = (control: S16OperationsControl, request: S16OperationsRequest) => {
    if (!terminal(request) || !lstatSync(fencePath, { throwIfNoEntry: false })) return;
    const actual = readS16OperationsFence(root); if (actual.operationId !== request.id) return;
    const fence = originalFence(control, request); if (canonical(actual) !== canonical(fence)) refuse('s16_ops_fence_invalid');
    options.clearFence(fence); if (lstatSync(fencePath, { throwIfNoEntry: false })) refuse('s16_ops_fence_invalid'); after('clear'); guard();
  };
  const save = (control: S16OperationsControl, request: S16OperationsRequest, expected: number) => {
    writable(control); if (control.revision !== expected || !Number.isSafeInteger(expected) || expected >= Number.MAX_SAFE_INTEGER) refuse('s16_ops_revision_conflict');
    control.contract = 's16-operations-control/v2'; control.revision++; request.revision = control.revision; request.updatedAt = clock(request.updatedAt);
    validateS16OperationsControl(control); guard();
    if (readS16OperationsControl(root).revision !== expected) refuse('s16_ops_revision_conflict');
    try {
      opsAtomic(join(root, 'operations/control.json'), JSON.parse(canonicalS16OperationsControl(control)));
      if (canonicalS16OperationsControl(readS16OperationsControl(root)) !== canonicalS16OperationsControl(control)) refuse('s16_ops_write_unknown');
    } catch { refuse('s16_ops_write_unknown'); }
    guard(); after('write'); clearIfOwn(control, request); return result(control, request, true);
  };
  const find = (control: S16OperationsControl, requestId: string) => {
    identity(requestId); const request = control.requests.find(row => row.requestId === requestId); if (!request) refuse('s16_ops_request_missing'); return request;
  };
  const editing = (requestId: string, expected: number) => {
    const control = read(), request = find(control, requestId); writable(control);
    if (terminal(request)) refuse('s16_ops_request_terminal'); if (control.revision !== expected) refuse('s16_ops_revision_conflict');
    ensureFence(control, request); return { control, request };
  };
  read();
  return Object.freeze<S16OperationsJournal>({ read, begin(command, expectedRevision) {
    identity(command.requestId); if (!Object.hasOwn(s16OperationsPhases, command.kind) || !sha(command.hash) || command.pointId !== undefined && command.pointId !== null && !opaque(command.pointId)) refuse();
    const control = read(), old = control.requests.find(row => row.requestId === command.requestId);
    if (old) {
      if (old.kind !== command.kind || old.hash !== command.hash || command.pointId !== undefined && old.pointId !== command.pointId) refuse();
      if (!terminal(old)) { writable(control); ensureFence(control, old); } else clearIfOwn(control, old);
      return result(control, old, false);
    }
    writable(control); if (control.revision !== expectedRevision) refuse('s16_ops_revision_conflict');
    if (control.requests.some(row => !terminal(row))) refuse('s16_ops_operation_busy');
    if (control.requests.length >= s16OperationsLimits.requests || control.revision >= Number.MAX_SAFE_INTEGER) refuse('s16_ops_capacity');
    let fence: S16OperationsFence;
    if (lstatSync(fencePath, { throwIfNoEntry: false })) {
      fence = readS16OperationsFence(root); assertS16OperationsFenceCurrent(control, fence);
      if (fence.requestId !== command.requestId || fence.kind !== command.kind || fence.hash !== command.hash || fence.configurationSha256 !== options.configurationSha256 || command.pointId !== undefined && fence.pointId !== command.pointId) refuse();
    } else {
      const id = (options.id ?? (() => crypto.randomUUID().replaceAll('-', '')))(); if (!opaque(id) || control.requests.some(row => row.id === id)) refuse();
      const pointId = command.pointId ?? (command.kind === 'backup' ? id : null);
      fence = { contract: 's16-operations-maintenance/v1', id: control.id, installationId: control.installationId, ownerIdentity: control.ownerIdentity, operationId: id, requestId: command.requestId, kind: command.kind, hash: command.hash, pointId,
        configurationSha256: options.configurationSha256, priorRevision: control.revision, createdAt: clock(Math.max(control.adoption.createdAt, ...control.requests.map(row => row.updatedAt))) };
    }
    if (['restore', 'cleanup'].includes(command.kind) && !control.points.some(point => point.id === fence.pointId && point.state === 'retained')) refuse('s16_ops_point_unavailable');
    if (command.kind === 'backup' && (!opaque(fence.pointId) || control.requests.some(row => row.kind === 'backup' && row.pointId === fence.pointId) || control.points.length >= s16OperationsLimits.points)) refuse('s16_ops_capacity');
    const request: S16OperationsRequest = { id: fence.operationId, requestId: fence.requestId, kind: fence.kind, hash: fence.hash, phase: 'pending', status: 'running', pointId: fence.pointId, cohortSha256: null, targetSha256: null,
      createdAt: fence.createdAt, updatedAt: fence.createdAt, revision: control.revision + 1, admittedRevision: control.revision + 1, configurationSha256: fence.configurationSha256, reason: null, actions: [] };
    const next = JSON.parse(canonicalS16OperationsControl(control)) as S16OperationsControl; next.requests.push(request); next.contract = 's16-operations-control/v2'; next.revision++;
    validateS16OperationsControl(next);
    const reserved = Buffer.byteLength(canonicalS16OperationsControl(next)) - Buffer.byteLength(canonical(request)) + s16OperationsLimits.requestBytes + (s16OperationsLimits.points - control.points.length) * 512 + 8192;
    if (reserved > s16OperationsLimits.bytes) refuse('s16_ops_capacity');
    ensureFence(control, request); control.contract = 's16-operations-control/v2'; control.requests.push(request); return save(control, request, expectedRevision);
  }, advance(requestId, expectedRevision, phase, binding = {}) {
    const control = read(), request = find(control, requestId); writable(control);
    if (binding.cohortSha256 !== undefined && !sha(binding.cohortSha256) || binding.targetSha256 !== undefined && !sha(binding.targetSha256)) refuse();
    const cohort = binding.cohortSha256 ?? request.cohortSha256, target = binding.targetSha256 ?? request.targetSha256;
    if (request.cohortSha256 !== null && cohort !== request.cohortSha256 || request.targetSha256 !== null && target !== request.targetSha256) refuse();
    if (request.phase === phase && cohort === request.cohortSha256 && target === request.targetSha256) { if (terminal(request)) clearIfOwn(control, request); else ensureFence(control, request); return result(control, request, false); }
    if (terminal(request) || request.status !== 'running') refuse('s16_ops_reconciliation_required');
    if (control.revision !== expectedRevision) refuse('s16_ops_revision_conflict'); ensureFence(control, request);
    const profile = s16OperationsPhases[request.kind] as readonly string[];
    if (phase !== request.phase && phase !== 'discarded' && profile.indexOf(phase) !== profile.indexOf(request.phase) + 1) refuse('s16_ops_phase_invalid');
    if (['complete', 'discarded'].includes(phase) && request.actions.some(action => !settled(action)) || ['verifying', 'prepared'].includes(phase) && request.actions.some(action => action.kind.startsWith('capture_') && !settled(action))) refuse('s16_ops_reconciliation_required');
    if (phase === 'complete' && request.kind === 'backup' && !control.points.some(point => point.id === request.pointId && point.operationId === request.id && point.sha256 === target && point.state === 'retained')) refuse('s16_ops_point_unavailable');
    if ((phase === 'complete' && request.kind === 'cleanup' || phase === 'discarded' && request.kind === 'backup') && control.points.some(point => point.id === request.pointId)) refuse('s16_ops_point_unavailable');
    if (phase === 'discarded' && request.kind === 'cleanup' && control.points.some(point => point.id === request.pointId && point.state === 'removing')) refuse('s16_ops_reconciliation_required');
    request.cohortSha256 = cohort; request.targetSha256 = target; request.phase = phase; request.status = phase === 'complete' ? 'complete' : phase === 'discarded' ? 'discarded' : 'running'; request.reason = null;
    return save(control, request, expectedRevision);
  }, recordIntent(requestId, expectedRevision, action) {
    const control = read(), request = find(control, requestId); writable(control); identity(action.id);
    if (terminal(request) || request.status !== 'running') refuse('s16_ops_reconciliation_required');
    const old = request.actions.find(row => row.id === action.id);
    if (old) {
      if (canonical({ id: old.id, kind: old.kind, priorSha256: old.priorSha256, targetSha256: old.targetSha256 }) !== canonical(action)) refuse();
      ensureFence(control, request); return result(control, request, false);
    }
    if (control.revision !== expectedRevision) refuse('s16_ops_revision_conflict'); ensureFence(control, request);
    if (request.actions.length >= s16OperationsLimits.actions) refuse('s16_ops_capacity');
    if (action.kind === 'remove_point') refuse('s16_ops_phase_invalid'); // Only planPointRemoval may change point custody.
    const pointPublication = request.kind === 'backup' && request.phase === 'verifying' && action.kind === 'replace' && action.priorSha256 === null && sha(request.targetSha256) && action.targetSha256 === request.targetSha256 && action.id === 'point_publish_' + request.targetSha256 && request.actions.some(row => row.kind === 'capture_backend' && row.state === 'confirmed' && row.observedSha256 === request.targetSha256);
    if (action.kind.startsWith('capture_') ? request.phase !== 'capturing' : !['prepared', 'activating'].includes(request.phase) && !pointPublication) refuse('s16_ops_phase_invalid');
    request.actions.push({ ...clone(action), state: 'intent', observedSha256: null }); return save(control, request, expectedRevision);
  }, observeAction(requestId, expectedRevision, actionId, outcome, observedSha256) {
    if (!['applied', 'not_applied'].includes(outcome) || observedSha256 !== null && !sha(observedSha256)) refuse();
    const control = read(), request = find(control, requestId); writable(control); identity(actionId);
    const action = request.actions.find(row => row.id === actionId); if (!action) refuse('s16_ops_action_missing');
    const expected = outcome === 'applied' ? action.targetSha256 : action.priorSha256, state = outcome === 'applied' ? 'confirmed' : 'not_applied';
    if (expected !== null && observedSha256 !== expected || outcome === 'not_applied' && observedSha256 !== expected || outcome === 'applied' && (action.kind === 'remove_point' ? observedSha256 !== null : observedSha256 === null)) refuse('s16_ops_observation_mismatch');
    if (settled(action)) { if (action.state !== state || action.observedSha256 !== observedSha256) refuse(); return result(control, request, false); }
    if (terminal(request) || control.revision !== expectedRevision) refuse('s16_ops_revision_conflict'); ensureFence(control, request);
    if (action.kind === 'remove_point') {
      const point = control.points.find(row => row.id === request.pointId);
      if (request.kind !== 'cleanup' || !point || point.state !== 'removing' || point.sha256 !== action.priorSha256) refuse('s16_ops_point_unavailable');
      if (state === 'not_applied') point.state = 'retained';
    }
    action.observedSha256 = observedSha256; action.state = state;
    if (request.status === 'unknown' && !request.actions.some(row => row.state === 'unknown')) { request.status = 'blocked'; request.reason = 's16_ops_reconciliation_required'; }
    return save(control, request, expectedRevision);
  }, block(requestId, expectedRevision, reason, unknownActionId) {
    if (!/^s16_ops_[a-z0-9_]{1,64}$/.test(reason)) refuse();
    const control = read(), request = find(control, requestId); writable(control);
    if (terminal(request)) refuse('s16_ops_request_terminal');
    let changed = false;
    if (unknownActionId !== undefined) { identity(unknownActionId); const action = request.actions.find(row => row.id === unknownActionId); if (!action || settled(action)) refuse('s16_ops_action_missing'); changed = action.state !== 'unknown'; action.state = 'unknown'; }
    const status = request.actions.some(row => row.state === 'unknown') ? 'unknown' : 'blocked';
    if (!changed && request.status === status && request.reason === reason) return result(control, request, false);
    if (control.revision !== expectedRevision) refuse('s16_ops_revision_conflict'); ensureFence(control, request); request.status = status; request.reason = reason;
    return save(control, request, expectedRevision);
  }, resume(requestId, expectedRevision) {
    const { control, request } = editing(requestId, expectedRevision);
    if (request.actions.some(action => !settled(action))) refuse('s16_ops_reconciliation_required');
    if (request.status === 'running') return result(control, request, false);
    request.status = 'running'; request.reason = null; return save(control, request, expectedRevision);
  }, retainPoint(requestId, expectedRevision, point) {
    const control = read(), request = find(control, requestId); writable(control);
    const old = control.points.find(row => row.id === request.pointId);
    if (old) { if (old.sha256 !== point.sha256 || old.bytes !== point.bytes || old.operationId !== request.id) refuse(); return result(control, request, false); }
    if (request.kind !== 'backup' || request.phase !== 'verifying' || request.status !== 'running' || request.targetSha256 !== point.sha256 || !sha(point.sha256) || !Number.isSafeInteger(point.bytes) || point.bytes < 0 || point.bytes > 6_442_450_944 || !opaque(request.pointId)) refuse('s16_ops_point_unavailable');
    if (control.revision !== expectedRevision) refuse('s16_ops_revision_conflict'); ensureFence(control, request);
    if (control.points.length >= s16OperationsLimits.points) refuse('s16_ops_capacity');
    control.points.push({ id: request.pointId, sha256: point.sha256, bytes: point.bytes, createdAt: clock(request.updatedAt), operationId: request.id, state: 'retained' }); return save(control, request, expectedRevision);
  }, planPointRemoval(requestId, expectedRevision, suppliedActionId) {
    const control = read(), request = find(control, requestId); writable(control);
    if (request.kind !== 'cleanup' || !['prepared', 'activating'].includes(request.phase) || request.status !== 'running') refuse('s16_ops_phase_invalid');
    const point = control.points.find(row => row.id === request.pointId); if (!point) refuse('s16_ops_point_unavailable');
    if (control.requests.some(row => row.id !== request.id && !terminal(row) && row.pointId === point.id)) refuse('s16_ops_point_in_use');
    const actionId = suppliedActionId ?? 'remove_' + point.id; identity(actionId);
    const old = request.actions.find(row => row.id === actionId);
    if (old) {
      if (old.kind !== 'remove_point' || old.priorSha256 !== point.sha256 || old.targetSha256 !== null) refuse();
      return result(control, request, false);
    }
    if (control.revision !== expectedRevision) refuse('s16_ops_revision_conflict'); ensureFence(control, request);
    if (request.targetSha256 !== point.sha256 || request.actions.length >= s16OperationsLimits.actions || point.state !== 'retained') refuse();
    point.state = 'removing'; request.actions.push({ id: actionId, kind: 'remove_point', priorSha256: point.sha256, targetSha256: null, state: 'intent', observedSha256: null }); return save(control, request, expectedRevision);
  }, recordPointRemoved(requestId, expectedRevision) {
    const control = read(), request = find(control, requestId); writable(control);
    if (request.kind !== 'cleanup' || request.phase !== 'activating' || request.status !== 'running') refuse('s16_ops_phase_invalid');
    const action = request.actions.find(row => row.kind === 'remove_point' && row.state === 'confirmed'), point = control.points.find(row => row.id === request.pointId);
    if (!action || action.kind !== 'remove_point' || action.state !== 'confirmed' || action.targetSha256 !== null) refuse('s16_ops_reconciliation_required');
    if (!point) return result(control, request, false);
    if (point.state !== 'removing' || point.sha256 !== action.priorSha256) refuse();
    if (control.revision !== expectedRevision) refuse('s16_ops_revision_conflict'); ensureFence(control, request);
    control.points = control.points.filter(row => row.id !== point.id); return save(control, request, expectedRevision);
  } });
}
