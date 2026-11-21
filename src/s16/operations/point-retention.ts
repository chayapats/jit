import { createHash } from 'node:crypto';
import { lstatSync, opendirSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../errors';
import { opsDirectory, opsRead, opsSyncDirectory, opsWrite } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import { assertS16ExclusiveInstallationLease, type S16InstallationLease } from './installation-lease';
import type { S16OperationsJournal } from './operations-journal';
import { inspectS16PointFiles, s16PointDirectory, s16PointEntry, s16PointEntryIdentity, s16PointMemberPath, s16PointSubdirectory, type S16PointDirectoryScope, type S16PointFile, type S16PointInventory } from './point-files';
import { verifyS16PayloadSources } from './payload-set';

const planBound = 8388608, storageBound = 8589934592, nodesBound = 100000;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function refuse(code = 's16_ops_point_removal_invalid'): never { throw new AppError(code, 409); }
interface Plan {
  contract: 's16-point-removal-plan/v1'; operationsId: string; installationId: string; ownerIdentity: string;
  operationId: string; requestId: string; configurationSha256: string; admittedRevision: number; createdAt: number; attempt: string;
  point: { id: string; sha256: string; bytes: number; operationId: string };
  files: readonly Readonly<S16PointFile>[]; directories: readonly Readonly<{ scope: S16PointDirectoryScope; identity: string }>[];
}
/** One explicitly selected current point and optional original-boundary fault observer. */
export interface S16PointRemovalOptions {
  pointId: string; attempt?: string;
  /** Observes durable boundaries only; it never chooses a path, expected hash or authority. */
  after?(boundary: 'admitted' | 'prepared' | 'activating' | 'intent' | 'plan' | 'file' | 'directory' | 'observed' | 'receipt' | 'complete', member?: Readonly<{ scope: string; name: string }>): void;
}
/** Only protected current-control composition supplies the original journal and actual exclusion. */
export interface S16PointRemovalOwner {
  directory: string; installationId: string; ownerIdentity: string; configurationSha256: string; lease: S16InstallationLease; journal: S16OperationsJournal; guard(): void;
}
/** Stable original terminal receipt; subsequent unrelated journal writes do not change its revision. */
export interface S16PointRemovalResult { contract: 's16-point-removal-result/v1'; state: 'removed'; pointId: string; requestId: string; operationId: string; revision: number }
function text(plan: Plan): string {
  const encoded = '{' + Object.keys(plan).sort().map(key => JSON.stringify(key) + ':' + (key === 'files' || key === 'directories' ? '[' + plan[key].map(row => canonical(row)).join(',') + ']' : canonical(plan[key as keyof Plan]))).join(',') + '}';
  if (Buffer.byteLength(encoded) > planBound) refuse('s16_ops_point_bounds'); return encoded;
}
function usage(path: string): { bytes: number; nodes: number } {
  if (!lstatSync(path, { throwIfNoEntry: false })) return { bytes: 0, nodes: 0 };
  let nodes = 0, bytes = 0;
  const walk = (path: string, depth: number) => {
    if (++nodes > nodesBound || depth > 4) refuse('s16_ops_point_bounds'); const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) { s16PointEntry(path, true); const dir = opendirSync(path); try { for (;;) { const entry = dir.readSync(); if (!entry) break; walk(join(path, entry.name), depth + 1); } } finally { dir.closeSync(); } }
    else { const entry = s16PointEntry(path); bytes += Number(entry.size); if (!Number.isSafeInteger(bytes) || bytes > storageBound) refuse('s16_ops_point_bounds'); }
  }; walk(path, 0); return { bytes, nodes };
}
/**
 * Removes only an independently receipted historical point under its original durable action/plan.
 * Missing members can be prior completed unlinks; changed or unowned members never become targets.
 * Current continuity, process leases and original operation/plan receipts are never deletion targets.
 */
export function removeS16Point(owner: S16PointRemovalOwner, requestId: string, options: S16PointRemovalOptions): Readonly<S16PointRemovalResult> {
  identity(requestId); const { pointId } = options, attempt = options.attempt ?? 'original', { journal } = owner;
  if (!/^[a-f0-9]{32}$/.test(pointId) || !/^[a-z0-9][a-z0-9_]{0,23}$/.test(attempt) || !sha(owner.configurationSha256)) refuse();
  const guard = () => { assertS16ExclusiveInstallationLease(owner.lease, owner.directory); if ((owner.guard() as unknown) !== undefined) refuse('s16_ops_guard_invalid'); }; guard();
  const after = (boundary: Parameters<NonNullable<S16PointRemovalOptions['after']>>[0], member?: { scope: string; name: string }) => { guard(); if ((options.after?.(boundary, member && Object.freeze(member)) as unknown) !== undefined) refuse('s16_ops_guard_invalid'); guard(); };
  const read = () => { guard(); const control = journal.read(), request = control.requests.find(row => row.requestId === requestId); if (!request || request.kind !== 'cleanup' || request.pointId !== pointId || control.installationId !== owner.installationId || control.ownerIdentity !== owner.ownerIdentity || request.configurationSha256 !== owner.configurationSha256) return refuse(); return { control, request }; };
  const root = s16PointDirectory(owner.directory, pointId), command = hash(canonical({ contract: 's16-point-removal/v1', configurationSha256: owner.configurationSha256, pointId }));
  journal.begin({ requestId, kind: 'cleanup', hash: command, pointId }, journal.read().revision);
  const result = (): Readonly<S16PointRemovalResult> => { const state = read(); return Object.freeze({ contract: 's16-point-removal-result/v1', state: 'removed', pointId, requestId, operationId: state.request.id, revision: state.request.revision }); };
  let actionId: string | undefined;
  try {
    let state = read();
    if (state.request.status === 'complete') { if (lstatSync(root, { throwIfNoEntry: false })) refuse('s16_ops_point_reappeared'); return result(); }
    if (state.request.status === 'discarded') refuse(); after('admitted');
    if (state.request.status !== 'running' && state.request.actions.every(row => ['confirmed', 'not_applied'].includes(row.state))) { journal.resume(requestId, state.control.revision); state = read(); }
    const point = state.control.points.find(row => row.id === pointId);
    const prefix = 'point_remove_' + attempt + '_', matching = state.request.actions.filter(row => row.id.startsWith(prefix));
    if (matching.length > 1 || state.request.actions.some(row => row.kind !== 'remove_point' || !row.id.startsWith(prefix) && row.state !== 'not_applied')) refuse();
    const action = matching[0]; if (action?.state === 'not_applied') refuse('s16_ops_point_distinct_attempt_required'); actionId = action?.id;
    if (!point && !(action?.state === 'confirmed' && state.request.phase === 'activating')) refuse('s16_ops_point_unavailable');
    const originalPoint = point ?? { id: pointId, sha256: action!.priorSha256!, bytes: 0, operationId: '' }, backup = state.control.requests.find(row => row.id === originalPoint.operationId);
    const cohort = point ? hash(canonical({ contract: 's16-point-removal-scope/v1', operationsId: state.control.id, ownerIdentity: owner.ownerIdentity, configurationSha256: owner.configurationSha256, pointId, sha256: point.sha256, bytes: point.bytes, operationId: point.operationId })) : state.request.cohortSha256!;
    let inventory: Readonly<S16PointInventory> | undefined;
    const inspect = () => {
      if (!point || !backup || backup.kind !== 'backup' || backup.phase !== 'complete' || backup.status !== 'complete' || !sha(backup.configurationSha256) || !sha(backup.cohortSha256)) refuse();
      return inspectS16PointFiles(root, { id: pointId, installationId: owner.installationId, ownerIdentity: owner.ownerIdentity, operationId: point.operationId, requestId: backup.requestId, configurationSha256: backup.configurationSha256, cohortSha256: backup.cohortSha256, manifestSha256: point.sha256, bytes: point.bytes, capturedAt: backup.createdAt }, guard);
    };
    if (state.request.phase === 'pending') { inventory = inspect(); journal.advance(requestId, state.control.revision, 'prepared', { cohortSha256: cohort, targetSha256: originalPoint.sha256 }); after('prepared'); state = read(); }
    if (!['prepared', 'activating'].includes(state.request.phase) || state.request.cohortSha256 !== cohort || state.request.targetSha256 !== originalPoint.sha256) refuse();
    const planHeader = (): Omit<Plan, 'point' | 'files' | 'directories'> => ({ contract: 's16-point-removal-plan/v1', operationsId: state.control.id, installationId: owner.installationId, ownerIdentity: owner.ownerIdentity,
      operationId: state.request.id, requestId, configurationSha256: owner.configurationSha256, admittedRevision: state.request.admittedRevision!, createdAt: state.request.createdAt, attempt });
    const makePlan = (inventory: S16PointInventory): Plan => ({ ...planHeader(), point: { id: pointId, sha256: originalPoint.sha256, bytes: inventory.bytes, operationId: originalPoint.operationId }, files: inventory.files, directories: inventory.directories });
    let planText: string | undefined;
    if (!action) {
      if (!point || point.state !== 'retained' || state.request.status !== 'running') refuse(); inventory ??= inspect(); planText = text(makePlan(inventory));
      if (state.request.phase === 'prepared') { journal.advance(requestId, state.control.revision, 'activating'); after('activating'); state = read(); }
      actionId = prefix + hash(planText); journal.planPointRemoval(requestId, state.control.revision, actionId); after('intent'); state = read();
    }
    if (!actionId || !new RegExp('^' + prefix + '[a-f0-9]{64}$').test(actionId)) refuse();
    const retention = join(owner.directory, 'operations/retention'), stage = join(retention, state.request.id, actionId), path = join(stage, 'plan.json'), expectedPlan = actionId.slice(prefix.length);
    if (lstatSync(path, { throwIfNoEntry: false })) {
      const before = s16PointEntry(path); if (before.size > BigInt(planBound)) refuse('s16_ops_point_bounds'); const data = opsRead(path, planBound);
      if (data.length !== Number(before.size) || s16PointEntryIdentity(before) !== s16PointEntryIdentity(s16PointEntry(path)) || hash(data) !== expectedPlan) refuse('s16_ops_point_removal_plan_invalid'); planText = new TextDecoder('utf-8', { fatal: true }).decode(data);
    } else {
      planText ??= text(makePlan(inspect())); if (hash(planText) !== expectedPlan) refuse('s16_ops_point_removal_plan_invalid');
      const occupied = usage(retention);
      if (occupied.bytes + Buffer.byteLength(planText) > storageBound || occupied.nodes + 4 > nodesBound) refuse('s16_ops_point_bounds'); opsDirectory(stage); guard(); opsWrite(path, planText); after('plan');
    }
    const plan: Plan = JSON.parse(planText);
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !Array.isArray(plan.files) || plan.files.length > 20261 || !Array.isArray(plan.directories) || plan.directories.length !== 5 || text(plan) !== planText || hash(planText) !== expectedPlan) refuse('s16_ops_point_removal_plan_invalid');
    const { files, directories, point: savedPoint, ...header } = plan;
    if (canonical(header) !== canonical(planHeader()) || !savedPoint || Object.keys(savedPoint).sort().join(',') !== 'bytes,id,operationId,sha256' || savedPoint.id !== pointId || savedPoint.sha256 !== state.request.targetSha256 || !Number.isSafeInteger(savedPoint.bytes) || savedPoint.bytes < 0 || savedPoint.bytes > 6442450944 || point && (savedPoint.bytes !== point.bytes || savedPoint.operationId !== point.operationId)) refuse('s16_ops_point_removal_plan_invalid');
    const originalBackup = state.control.requests.find(row => row.id === savedPoint.operationId);
    if (!originalBackup || originalBackup.kind !== 'backup' || originalBackup.phase !== 'complete' || originalBackup.status !== 'complete' || originalBackup.pointId !== pointId || originalBackup.targetSha256 !== savedPoint.sha256) refuse('s16_ops_point_removal_plan_invalid');
    const expectedFiles = new Map<string, S16PointFile>();
    for (const file of files) { if (!file || Object.keys(file).sort().join(',') !== 'bytes,identity,name,scope,sha256' || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 1073741824 || !sha(file.sha256) || !sha(file.identity)) refuse(); const target = s16PointMemberPath(root, pointId, file.scope, file.name); if (expectedFiles.has(target)) refuse(); expectedFiles.set(target, file); }
    if (files.reduce((total, file) => total + file.bytes, 0) !== savedPoint.bytes) refuse('s16_ops_point_removal_plan_invalid');
    const expectedDirs = new Map<string, string>();
    for (const dir of directories) { if (!dir || Object.keys(dir).sort().join(',') !== 'identity,scope' || !sha(dir.identity)) refuse(); const target = s16PointSubdirectory(root, pointId, dir.scope); if (expectedDirs.has(target)) refuse(); expectedDirs.set(target, dir.identity); }
    if (expectedDirs.size !== 5 || !['root', 'ledgers', 'ledger-data', 'payloads', 'payload-data'].every(scope => expectedDirs.has(s16PointSubdirectory(root, pointId, scope as S16PointDirectoryScope)))) refuse();
    const checkRemaining = () => {
      guard(); if (!lstatSync(root, { throwIfNoEntry: false })) return;
      let count = 0; const walk = (target: string, depth: number) => {
        if (++count > 20270 || depth > 2 || s16PointEntryIdentity(s16PointEntry(target, true), true) !== expectedDirs.get(target)) refuse('s16_ops_point_changed');
        const dir = opendirSync(target); try { for (;;) { const next = dir.readSync(); if (!next) break; const child = join(target, next.name), stat = lstatSync(child);
          if (stat.isDirectory() && !stat.isSymbolicLink()) walk(child, depth + 1); else { const file = expectedFiles.get(child); if (!file || s16PointEntryIdentity(s16PointEntry(child)) !== file.identity) refuse('s16_ops_point_changed'); }
        } } finally { dir.closeSync(); }
      }; walk(root, 0); guard();
    }; checkRemaining();
    if (state.request.phase !== 'activating') refuse('s16_ops_phase_invalid');
    const ordered = [...files].sort((a, b) => Number(a.name === 'manifest.json') - Number(b.name === 'manifest.json') || Number(a.scope === 'metadata') - Number(b.scope === 'metadata') || a.scope.localeCompare(b.scope) || a.name.localeCompare(b.name));
    for (const file of ordered) {
      const target = s16PointMemberPath(root, pointId, file.scope, file.name); if (!lstatSync(target, { throwIfNoEntry: false })) continue;
      guard(); if (s16PointEntryIdentity(s16PointEntry(target)) !== file.identity) refuse('s16_ops_point_changed');
      verifyS16PayloadSources([{ name: 'original', path: target, bytes: file.bytes, sha256: file.sha256 }], guard);
      if (s16PointEntryIdentity(s16PointEntry(target)) !== file.identity) refuse('s16_ops_point_changed'); unlinkSync(target); opsSyncDirectory(file.scope === 'metadata' ? root : join(root, file.scope, pointId)); after('file', { scope: file.scope, name: file.name });
    }
    checkRemaining();
    for (const scope of ['ledger-data', 'ledgers', 'payload-data', 'payloads', 'root'] as const) {
      const target = s16PointSubdirectory(root, pointId, scope); if (!lstatSync(target, { throwIfNoEntry: false })) continue;
      guard(); if (s16PointEntryIdentity(s16PointEntry(target, true), true) !== expectedDirs.get(target)) refuse('s16_ops_point_changed'); rmdirSync(target); opsSyncDirectory(scope === 'root' ? join(owner.directory, 'operations/points') : scope === 'ledger-data' ? join(root, 'ledgers') : scope === 'payload-data' ? join(root, 'payloads') : root); after('directory', { scope, name: pointId });
    }
    if (lstatSync(root, { throwIfNoEntry: false })) refuse('s16_ops_point_changed'); opsSyncDirectory(join(owner.directory, 'operations/points'));
    state = read(); journal.observeAction(requestId, state.control.revision, actionId, 'applied', null); after('observed'); state = read();
    if (state.request.status !== 'running') { journal.resume(requestId, state.control.revision); state = read(); }
    journal.recordPointRemoved(requestId, state.control.revision); after('receipt'); state = read(); journal.advance(requestId, state.control.revision, 'complete'); after('complete'); return result();
  } catch (error) {
    try { const state = read(); if (!['complete', 'discarded'].includes(state.request.status)) { const action = actionId && state.request.actions.find(row => row.id === actionId); journal.block(requestId, state.control.revision, 's16_ops_point_removal_incomplete', action && !['confirmed', 'not_applied'].includes(action.state) ? action.id : undefined); } } catch { /* The original gate/receipts remain authoritative on unknown journal or release. */ }
    throw error;
  }
}
