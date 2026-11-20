import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, rmdirSync, unlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from '../../errors';
import { opsAtomic, opsPath, opsRead, opsSyncDirectory } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import type { S16OperationsJournal } from './operations-journal';
import type { S16OperationsRequest } from './operations-state';
import { inspectS16OwnedStage, s16StagingOwnershipId, s16StagingPath, type S16StagingRole } from './owned-staging';
import { s16PointEntry, s16PointEntryIdentity } from './point-files';
import { verifyS16PayloadSources } from './payload-set';

const planBound = 16777216, bytesBound = 21474836480, nodesBound = 100000;
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function refuse(code = 's16_ops_staging_retirement_invalid'): never { throw new AppError(code, 409); }
interface File { name: string; identity: string; sha256: string; bytes: number }
interface Directory { name: string; identity: string }
interface Stage {
  role: S16StagingRole; captureActionId: string; ownershipId: string; rootSha256: string; dataSha256: string;
  files: File[]; directories: Directory[];
}
interface Plan {
  contract: 's16-staging-retirement-plan/v1'; operationsId: string; installationId: string; ownerIdentity: string; configurationSha256: string;
  operationId: string; requestId: string; admittedRevision: number; createdAt: number; sourceOperationId: string; sourceRequestId: string; sourceSha256: string;
  stages: Stage[];
}
/** Selects an original terminal backup, never an arbitrary filesystem path or archive namespace. */
export interface S16StagingRetirementOptions {
  sourceRequestId: string;
  after?(boundary: 'admitted' | 'prepared' | 'activating' | 'intent' | 'plan' | 'file' | 'directory' | 'observed' | 'complete', member?: string): void;
}
/** Stable original receipt; retained points and original operation/removal receipts are preserved. */
export interface S16StagingRetirementResult { contract: 's16-staging-retirement-result/v1'; state: 'removed'; operationId: string; requestId: string; sourceRequestId: string; revision: number }
/** Current protected composition supplies exclusion, configuration and released-resource checks. */
export interface S16StagingRetirementOwner { directory: string; configurationSha256: string; journal: S16OperationsJournal; guard(): void }
function stageText(stage: Stage): string {
  return '{' + Object.keys(stage).sort().map(key => JSON.stringify(key) + ':' + (key === 'files' || key === 'directories' ? '[' + stage[key].map(row => canonical(row)).join(',') + ']' : canonical(stage[key as keyof Stage]))).join(',') + '}';
}
function text(plan: Plan): string {
  const value = '{' + Object.keys(plan).sort().map(key => JSON.stringify(key) + ':' + (key === 'stages' ? '[' + plan.stages.map(stageText).join(',') + ']' : canonical(plan[key as keyof Plan]))).join(',') + '}';
  if (Buffer.byteLength(value) > planBound) refuse('s16_ops_staging_bounds'); return value;
}
const segment = (value: string) => value.length > 0 && value.length <= 192 && value !== '.' && value !== '..' && !/[\x00-\x1f/\\]/.test(value);
function allowed(role: S16StagingRole, pointId: string, name: string, directory: boolean): boolean {
  const parts = name.split('/'); if (name === '') return directory;
  if (parts.length > 32 || parts.some(part => !segment(part))) return false;
  if (role === 'native') {
    if (parts[0] === 'quarantine') return parts.length === 1 ? directory : /^[a-f0-9]{32}$/.test(parts[1]!) && (parts.length > 2 || directory);
    if (parts[0] === 'data') return parts.length === 1 ? directory : parts.length === 2 && !directory && (['plan.json', 'manifest.json'].includes(parts[1]!) || /^[a-f0-9]{32}\.json$/.test(parts[1]!));
    return parts.length === 1 && !directory && ['plan.json', 'receipt.json', 'scratch.json'].includes(name);
  }
  if (parts[0] !== 'data') return parts.length === 1 && !directory && ['plan.json', 'file-cohort.json', 'github-cohort.json'].includes(name);
  if (parts.length === 1) return directory;
  if (['manifest.json', 'references.json', 'capture.json'].includes(parts[1]!)) return parts.length === 2 && !directory;
  if (!['ledgers', 'payloads'].includes(parts[1]!)) return false;
  if (parts.length === 2) return directory;
  if (parts[2] !== pointId) return false;
  if (parts.length === 3) return directory;
  return parts.length === 4 && !directory && (parts[1] === 'ledgers' ? /^(?:manifest\.json|[a-z][a-z0-9_-]{0,63}\.sqlite)$/.test(parts[3]!) : /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(parts[3]!));
}
function digestFile(path: string): File {
  const before = s16PointEntry(path); if (before.size > 1073741824n) refuse('s16_ops_staging_bounds');
  const pinned = s16PointEntryIdentity(before), fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (s16PointEntryIdentity(fstatSync(fd, { bigint: true })) !== pinned) refuse('s16_ops_staging_changed');
    const digest = createHash('sha256'), buffer = Buffer.alloc(65536); let offset = 0;
    while (offset < Number(before.size)) { const length = readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - offset), offset); if (!length) refuse('s16_ops_staging_changed'); digest.update(buffer.subarray(0, length)); offset += length; }
    if (readSync(fd, buffer, 0, 1, offset) || s16PointEntryIdentity(fstatSync(fd, { bigint: true })) !== pinned || s16PointEntryIdentity(s16PointEntry(path)) !== pinned) refuse('s16_ops_staging_changed');
    return { name: '', identity: pinned, bytes: offset, sha256: digest.digest('hex') };
  } finally { closeSync(fd); }
}
function inventory(root: string, role: S16StagingRole, pointId: string, guard: () => void, budget: { nodes: number; bytes: number }): Pick<Stage, 'files' | 'directories'> {
  const files: File[] = [], directories: Directory[] = [];
  const walk = (name: string) => {
    guard(); if (++budget.nodes > nodesBound) refuse('s16_ops_staging_bounds'); const path = name ? join(root, ...name.split('/')) : root, stat = lstatSync(path), directory = stat.isDirectory() && !stat.isSymbolicLink();
    if (!allowed(role, pointId, name, directory)) refuse('s16_ops_staging_unowned_member');
    if (directory) {
      const identity = s16PointEntryIdentity(s16PointEntry(path, true), true), names = readdirSync(path).sort(); directories.push({ name, identity });
      for (const child of names) walk(name ? name + '/' + child : child);
      if (s16PointEntryIdentity(s16PointEntry(path, true), true) !== identity || JSON.stringify(readdirSync(path).sort()) !== JSON.stringify(names)) refuse('s16_ops_staging_changed');
    } else { const file = { ...digestFile(path), name }; budget.bytes += file.bytes; if (budget.bytes > bytesBound) refuse('s16_ops_staging_bounds'); files.push(file); }
  }; walk(''); return { files, directories };
}
/** Removes only explicitly planned, independently owned temporary capture bytes; retries refuse changed/new members. */
export function retireS16Staging(owner: S16StagingRetirementOwner, requestId: string, options: S16StagingRetirementOptions): Readonly<S16StagingRetirementResult> {
  identity(requestId); identity(options.sourceRequestId); const { journal } = owner;
  let assertUnownedAbsent = () => {};
  const guard = () => { if ((owner.guard() as unknown) !== undefined) refuse('s16_ops_guard_invalid'); assertUnownedAbsent(); }; guard();
  const after = (boundary: Parameters<NonNullable<S16StagingRetirementOptions['after']>>[0], member?: string) => { guard(); if ((options.after?.(boundary, member) as unknown) !== undefined) refuse('s16_ops_guard_invalid'); guard(); };
  const readSource = () => { guard(); const control = journal.read(), source = control.requests.find(row => row.requestId === options.sourceRequestId); if (!source || source.kind !== 'backup' || !(source.status === 'complete' || source.status === 'discarded' && source.abort) || source.configurationSha256 !== owner.configurationSha256) return refuse(); return { control, source }; };
  const sourceDigest = (source: S16OperationsRequest) => hash(canonical({ ...source, abort: source.abort ?? null }));
  const initial = readSource(), sourceSha256 = sourceDigest(initial.source);
  const command = hash(canonical({ contract: 's16-staging-retirement/v1', operationsId: initial.control.id, configurationSha256: owner.configurationSha256, sourceOperationId: initial.source.id, sourceRequestId: options.sourceRequestId, sourceSha256 }));
  const allCaptures = initial.source.actions.filter(row => row.kind === 'capture_native' || row.kind === 'capture_backend');
  const ownership = (row: S16OperationsRequest['actions'][number]) => initial.source.actions.find(own => own.id === s16StagingOwnershipId(row.kind === 'capture_native' ? 'native' : 'point', row.id));
  const captures = allCaptures.filter(row => ownership(row));
  if (captures.some(row => ownership(row)!.kind !== 'own_staging' || ownership(row)!.state !== 'confirmed')) refuse('s16_ops_staging_ownership_invalid');
  const capturePath = (row: S16OperationsRequest['actions'][number]) => opsPath(s16StagingPath(owner.directory, initial.source, row.kind === 'capture_native' ? 'native' : 'point', row.id));
  const paths = captures.map(capturePath), allPaths = allCaptures.map(capturePath), unownedPaths = allCaptures.filter(row => !ownership(row)).map(capturePath);
  assertUnownedAbsent = () => { if (unownedPaths.some(path => lstatSync(opsPath(path), { throwIfNoEntry: false }))) refuse('s16_ops_staging_ownership_invalid'); }; guard();
  if (!initial.control.requests.some(row => row.requestId === requestId)) {
    const budget = { nodes: 0, bytes: 0 };
    for (const capture of captures) { const role = capture.kind === 'capture_native' ? 'native' : 'point', owned = inspectS16OwnedStage(owner.directory, initial.control, initial.source, role, capture.id); inventory(owned.root, role, initial.source.pointId!, guard, budget); }
  }
  journal.begin({ requestId, kind: 'retire', hash: command }, initial.control.revision);
  const read = () => { const { control, source } = readSource(), request = control.requests.find(row => row.requestId === requestId); if (!request || request.kind !== 'retire' || request.hash !== command || request.configurationSha256 !== owner.configurationSha256 || sourceDigest(source) !== sourceSha256) return refuse(); return { control, source, request }; };
  const result = () => { const state = read(); return Object.freeze<S16StagingRetirementResult>({ contract: 's16-staging-retirement-result/v1', state: 'removed', operationId: state.request.id, requestId, sourceRequestId: options.sourceRequestId, revision: state.request.revision }); };
  let actionId: string | undefined;
  try {
    let state = read();
    if (state.request.status === 'complete') { if (allPaths.some(path => lstatSync(opsPath(path), { throwIfNoEntry: false }))) refuse('s16_ops_staging_reappeared'); return result(); }
    if (state.request.status === 'discarded') refuse(); after('admitted');
    if (state.request.status !== 'running' && state.request.actions.every(row => ['confirmed', 'not_applied'].includes(row.state))) { journal.resume(requestId, state.control.revision); state = read(); }
    const makePlan = (): Plan => {
      const budget = { nodes: 0, bytes: 0 }, stages: Stage[] = [];
      for (const capture of captures) {
        const role = capture.kind === 'capture_native' ? 'native' : 'point', owned = inspectS16OwnedStage(owner.directory, state.control, state.source, role, capture.id);
        stages.push({ role, captureActionId: capture.id, ownershipId: owned.actionId, rootSha256: owned.rootSha256, dataSha256: owned.dataSha256, ...inventory(owned.root, role, state.source.pointId!, guard, budget) });
      }
      return { contract: 's16-staging-retirement-plan/v1', operationsId: state.control.id, installationId: state.control.installationId, ownerIdentity: state.control.ownerIdentity, configurationSha256: owner.configurationSha256,
        operationId: state.request.id, requestId, admittedRevision: state.request.admittedRevision!, createdAt: state.request.createdAt, sourceOperationId: state.source.id, sourceRequestId: state.source.requestId, sourceSha256, stages };
    };
    const scope = hash(canonical({ contract: 's16-staging-retirement-scope/v1', commandSha256: command, sourceSha256 }));
    let planText: string | undefined;
    if (state.request.phase === 'pending') { planText = text(makePlan()); journal.advance(requestId, state.control.revision, 'prepared', { cohortSha256: scope, targetSha256: hash(planText) }); after('prepared'); state = read(); }
    if (!['prepared', 'activating'].includes(state.request.phase) || state.request.cohortSha256 !== scope || !sha(state.request.targetSha256)) refuse();
    actionId = 'staging_remove_' + state.request.targetSha256;
    const action = state.request.actions.find(row => row.id === actionId);
    if (state.request.actions.length > 1 || action?.state === 'not_applied') refuse();
    const retention = join(owner.directory, 'operations/staging-retention'), path = join(retention, state.request.id, actionId, 'plan.json');
    if (lstatSync(path, { throwIfNoEntry: false })) {
      const entry = s16PointEntry(path); if (entry.size > BigInt(planBound)) refuse('s16_ops_staging_bounds'); const bytes = opsRead(path, planBound);
      if (hash(bytes) !== state.request.targetSha256 || bytes.length !== Number(entry.size) || s16PointEntryIdentity(entry) !== s16PointEntryIdentity(s16PointEntry(path))) refuse('s16_ops_staging_plan_invalid'); planText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } else { planText ??= text(makePlan()); if (hash(planText) !== state.request.targetSha256) refuse('s16_ops_staging_changed'); }
    if (state.request.phase === 'prepared') { journal.advance(requestId, state.control.revision, 'activating'); after('activating'); state = read(); }
    if (!action) { journal.recordIntent(requestId, state.control.revision, { id: actionId, kind: 'remove_staging', priorSha256: state.request.targetSha256, targetSha256: null }); after('intent'); state = read(); }
    if (!lstatSync(path, { throwIfNoEntry: false })) {
      // Bound persistent removal metadata independently of temporary byte namespaces.
      let nodes = 0, bytes = 0;
      const usage = (path: string, depth: number) => { if (++nodes > nodesBound || depth > 4) refuse('s16_ops_staging_bounds'); const stat = lstatSync(path); if (stat.isDirectory() && !stat.isSymbolicLink()) { s16PointEntry(path, true); for (const name of readdirSync(path)) usage(join(path, name), depth + 1); } else { bytes += Number(s16PointEntry(path).size); if (bytes > 8589934592) refuse('s16_ops_staging_bounds'); } };
      if (lstatSync(retention, { throwIfNoEntry: false })) usage(retention, 0); if (bytes + Buffer.byteLength(planText) > 8589934592 || nodes + 4 > nodesBound) refuse('s16_ops_staging_bounds');
      guard(); opsAtomic(path, JSON.parse(planText)); after('plan');
    }
    guard(); const savedPlan = s16PointEntry(path); if (savedPlan.size > BigInt(planBound)) refuse('s16_ops_staging_bounds');
    const savedBytes = opsRead(path, planBound);
    if (hash(savedBytes) !== state.request.targetSha256 || savedBytes.length !== Number(savedPlan.size) || s16PointEntryIdentity(savedPlan) !== s16PointEntryIdentity(s16PointEntry(path))) refuse('s16_ops_staging_plan_invalid');
    const plan: Plan = JSON.parse(planText);
    if (!plan || typeof plan !== 'object' || Array.isArray(plan) || !Array.isArray(plan.stages) || plan.stages.length !== captures.length || text(plan) !== planText || hash(planText) !== state.request.targetSha256) refuse('s16_ops_staging_plan_invalid');
    const { stages, ...header } = plan, expectedHeader = { contract: 's16-staging-retirement-plan/v1', operationsId: state.control.id, installationId: state.control.installationId, ownerIdentity: state.control.ownerIdentity, configurationSha256: owner.configurationSha256,
      operationId: state.request.id, requestId, admittedRevision: state.request.admittedRevision!, createdAt: state.request.createdAt, sourceOperationId: state.source.id, sourceRequestId: state.source.requestId, sourceSha256 };
    if (canonical(header) !== canonical(expectedHeader)) refuse('s16_ops_staging_plan_invalid');
    const targets: { root: string; stage: Stage; files: Map<string, File>; dirs: Map<string, Directory> }[] = []; let nodes = 0, bytes = 0;
    for (let index = 0; index < stages.length; index++) {
      const stage = stages[index]!, capture = captures[index]!, role = capture.kind === 'capture_native' ? 'native' : 'point', own = state.source.actions.find(row => row.id === s16StagingOwnershipId(role, capture.id));
      if (!stage || Object.keys(stage).sort().join(',') !== 'captureActionId,dataSha256,directories,files,ownershipId,role,rootSha256' || stage.role !== role || stage.captureActionId !== capture.id || stage.ownershipId !== own?.id || stage.rootSha256 !== own?.priorSha256 || stage.dataSha256 !== own?.targetSha256 || !Array.isArray(stage.files) || !Array.isArray(stage.directories)) refuse();
      const files = new Map<string, File>(), dirs = new Map<string, Directory>();
      for (const file of stage.files) { if (!file || Object.keys(file).sort().join(',') !== 'bytes,identity,name,sha256' || typeof file.name !== 'string' || !allowed(role, state.source.pointId!, file.name, false) || !sha(file.identity) || !sha(file.sha256) || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 1073741824 || files.has(file.name) || ++nodes > nodesBound) refuse(); bytes += file.bytes; if (bytes > bytesBound) refuse(); files.set(file.name, file); }
      for (const dir of stage.directories) { if (!dir || Object.keys(dir).sort().join(',') !== 'identity,name' || typeof dir.name !== 'string' || !allowed(role, state.source.pointId!, dir.name, true) || !sha(dir.identity) || dirs.has(dir.name) || files.has(dir.name) || ++nodes > nodesBound) refuse(); dirs.set(dir.name, dir); }
      if (!dirs.has('')) refuse();
      for (const name of [...files.keys(), ...dirs.keys()]) if (name && !dirs.has(name.includes('/') ? name.slice(0, name.lastIndexOf('/')) : '')) refuse();
      targets.push({ root: paths[index]!, stage, files, dirs });
    }
    const checkRemaining = () => {
      guard(); for (const { root, stage, files, dirs } of targets) {
        if (!lstatSync(root, { throwIfNoEntry: false })) continue;
        inspectS16OwnedStage(owner.directory, state.control, state.source, stage.role, stage.captureActionId);
        const walk = (name: string) => {
          const path = name ? join(root, ...name.split('/')) : root, stat = lstatSync(path);
          if (stat.isDirectory() && !stat.isSymbolicLink()) { if (s16PointEntryIdentity(s16PointEntry(path, true), true) !== dirs.get(name)?.identity) refuse('s16_ops_staging_changed'); for (const child of readdirSync(path)) { if (!segment(child)) refuse(); walk(name ? name + '/' + child : child); } }
          else if (s16PointEntryIdentity(s16PointEntry(path)) !== files.get(name)?.identity) refuse('s16_ops_staging_changed');
        }; walk('');
      } guard();
    }; checkRemaining();
    const assertParents = (root: string, name: string, dirs: Map<string, Directory>) => {
      const parts = name.split('/');
      for (let count = 0; count < parts.length; count++) {
        const relative = parts.slice(0, count).join('/'), path = relative ? join(root, ...parts.slice(0, count)) : root;
        if (s16PointEntryIdentity(s16PointEntry(path, true), true) !== dirs.get(relative)?.identity) refuse('s16_ops_staging_changed');
      }
    };
    for (const { root, stage, files, dirs } of targets) {
      for (const file of files.values()) {
        const path = join(root, ...file.name.split('/')); if (!lstatSync(path, { throwIfNoEntry: false })) continue;
        guard(); assertParents(root, file.name, dirs); if (s16PointEntryIdentity(s16PointEntry(path)) !== file.identity) refuse('s16_ops_staging_changed');
        verifyS16PayloadSources([{ name: 'original', path, bytes: file.bytes, sha256: file.sha256 }], guard);
        if (s16PointEntryIdentity(s16PointEntry(path)) !== file.identity) refuse('s16_ops_staging_changed'); unlinkSync(path); opsSyncDirectory(dirname(path)); after('file', stage.captureActionId + '/' + file.name);
      }
      checkRemaining();
      for (const dir of [...dirs.values()].sort((a, b) => b.name.split('/').length - a.name.split('/').length || b.name.length - a.name.length)) {
        const path = dir.name ? join(root, ...dir.name.split('/')) : root; if (!lstatSync(path, { throwIfNoEntry: false })) continue;
        guard(); assertParents(root, dir.name, dirs); if (s16PointEntryIdentity(s16PointEntry(path, true), true) !== dir.identity) refuse('s16_ops_staging_changed'); rmdirSync(path); opsSyncDirectory(dirname(path)); after('directory', stage.captureActionId + '/' + dir.name);
      }
    }
    if (allPaths.some(path => lstatSync(opsPath(path), { throwIfNoEntry: false }))) refuse('s16_ops_staging_changed');
    state = read(); journal.observeAction(requestId, state.control.revision, actionId, 'applied', null); after('observed'); state = read();
    if (state.request.status !== 'running') { journal.resume(requestId, state.control.revision); state = read(); }
    journal.advance(requestId, state.control.revision, 'complete'); after('complete'); return result();
  } catch (error) {
    try { const state = read(); if (!['complete', 'discarded'].includes(state.request.status)) { const action = state.request.actions.find(row => row.id === actionId); journal.block(requestId, state.control.revision, 's16_ops_staging_retirement_incomplete', action && !['confirmed', 'not_applied'].includes(action.state) ? action.id : undefined); } } catch { /* Preserve original gate and immutable removal facts on uncertainty. */ }
    throw error;
  }
}
