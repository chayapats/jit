import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { canonical, identity } from '../../../src/s15/conversation/validation';
import { vmCanonical } from '../../../src/s15/vm/validation';
import { readS15RuntimeConfig } from '../../../src/s15/runtime-config';
import { opsRead } from '../../../src/s14/ops-files';
import { openS16ControlMaintenance, type S16ControlMaintenance } from '../../../src/s16/operations/control-maintenance';
import { canonicalS16OperationsControl, readS16OperationsFence, type S16OperationsRequest } from '../../../src/s16/operations/operations-state';
import type { S16LedgerWriteCut } from '../../../src/s16/operations/ledger-write-cut';
import type { S16LedgerSet } from '../../../src/s16/operations/ledger-set';
import type { S16NativeSetMaintenance } from '../../../src/s16/operations/native-set';
import { inspectS16ExecutingPackage } from '../../../src/s16/operations/package-custody';
import type { S16PointCaptureMaintenance, S16PointCaptureResult } from '../../../src/s16/operations/point-capture';
import { s16PointEntry } from '../../../src/s16/operations/point-files';
import { validateArtifact } from '../bun-build';
import { assertRootTree, type RootPathPolicy } from '../trusted-paths';
import { s16PackageNativeNamespaceSha256, type S16PackageProbeObservation } from './s16-package-probe';
import { inspectS16RootReleaseSelector, s16RootSelectorValue } from './s16-release-selector';

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function refuse(code = 's16_release_selection_refused'): never { throw Error(code); }
/** Exact protected root command; no ordinary client, archive or model chooses these pins. */
export interface S16GuardedSelectionInput {
  requestId: string; configPath: string; configurationSha256: string; operatorSha256: string;
  prefix: string; sourceDirectory: string; sourceSha256: string; targetDirectory: string; targetSha256: string;
}
interface Cohort {
  sqlSha256: string; fileSha256: string; githubSha256: string; externalSha256: string; helperSha256: string; nativeNamespaceSha256: string;
}
/** Original independently journalled plan. Root stores these exact private bytes before arming selection. */
export interface S16GuardedSelectionPlan {
  contract: 's16-guarded-release-selection/v1'; input: S16GuardedSelectionInput;
  operationsId: string; operationId: string; ownerIdentitySha256: string; admittedRevision: number; createdAt: number;
  backup: Readonly<S16PointCaptureResult>; cohort: Readonly<Cohort>;
}
/** Completed original operation only; this receipt never certifies that a later service boot was healthy. */
export interface S16GuardedSelectionReceipt {
  contract: 's16-guarded-release-selection-result/v1'; state: 'selected'; requestId: string; operationId: string; planSha256: string; revision: number;
}
/** A plan discarded before any selector intent; current authority remains current. */
export interface S16GuardedSelectionAbort {
  contract: 's16-guarded-release-abort/v1'; state: 'not_selected'; requestId: string; operationId: string; planSha256: string; revision: number;
}
/** Actual independently executed target-reader and terminal-backup observations under the original gate. */
export interface S16GuardedSelectionReader {
  observation: Readonly<S16PackageProbeObservation>; backup: Readonly<S16PointCaptureResult>;
}
/** Owns all genuine controller capabilities; conclusive close is required before root starts the service. */
export interface S16GuardedSelection {
  readonly released: boolean;
  inspect(plan: Readonly<S16GuardedSelectionPlan>): Readonly<{ phase: S16OperationsRequest['phase']; status: S16OperationsRequest['status']; armed: boolean; receipt: Readonly<S16GuardedSelectionReceipt> | null }>;
  prepare(): Promise<Readonly<S16GuardedSelectionPlan>>;
  arm(plan: Readonly<S16GuardedSelectionPlan>, readers: readonly S16GuardedSelectionReader[]): Promise<void>;
  complete(plan: Readonly<S16GuardedSelectionPlan>): Promise<Readonly<S16GuardedSelectionReceipt>>;
  abortBeforeSelection(plan: Readonly<S16GuardedSelectionPlan>, source: S16GuardedSelectionReader): Promise<Readonly<S16GuardedSelectionAbort>>;
  close(): Promise<void>;
}
/** Explicit disposable fixture ownership only; production callers and the eventual helper CLI use root policy. */
export interface S16GuardedSelectionOptions {
  pathPolicy?: RootPathPolicy;
  /** Fault observer only; it cannot provide command values, paths or authority. */
  after?(boundary: 'backup' | 'admitted' | 'planned' | 'armed' | 'completed'): void;
}
const cohortOf = (observation: S16PackageProbeObservation): Cohort => ({ sqlSha256: digest(observation.sql), ...observation.custody });

/** Validates exact protected command values without opening resources or granting selection authority. */
export function validateS16GuardedSelectionInput(input: S16GuardedSelectionInput): Readonly<S16GuardedSelectionInput> {
  identity(input.requestId);
  const keys = 'configPath,configurationSha256,operatorSha256,prefix,requestId,sourceDirectory,sourceSha256,targetDirectory,targetSha256';
  if (Object.keys(input).sort().join(',') !== keys || ![input.configurationSha256, input.operatorSha256, input.sourceSha256, input.targetSha256].every(sha) ||
    [input.configPath, input.prefix, input.sourceDirectory, input.targetDirectory].some(path => typeof path !== 'string' || path.includes('\0') || !isAbsolute(path) || path !== resolve(path) || path.length > 4096) ||
    input.sourceDirectory === input.targetDirectory || [input.sourceDirectory, input.targetDirectory].some(path => dirname(path) !== join(input.prefix, 'releases'))) refuse();
  // Retain exact command values even if a trusted caller later mutates its own input object.
  return Object.freeze({ ...input });
}

/** Returns before opening current sources, retaining original cuts/native handles across unknown disposal. */
export function openS16GuardedSelection(input: S16GuardedSelectionInput, options: S16GuardedSelectionOptions = {}): S16GuardedSelection {
  input = validateS16GuardedSelectionInput(input);
  let context: S16ControlMaintenance | undefined, cut: S16LedgerWriteCut | undefined, native: S16NativeSetMaintenance | undefined, backup: S16PointCaptureMaintenance | undefined;
  let released = false, busy = false;
  const guard = () => { if (released) refuse('s16_release_selection_closed'); context?.assertCurrent(); };
  const after = (boundary: Parameters<NonNullable<S16GuardedSelectionOptions['after']>>[0]) => { guard(); if ((options.after?.(boundary) as unknown) !== undefined) refuse('s16_ops_guard_invalid'); guard(); };
  const open = () => {
    guard(); const config = readS15RuntimeConfig(input.configPath);
    if (digest(config) !== input.configurationSha256 || !lstatSync(join(config.directory, 'operations/control.json'), { throwIfNoEntry: false })?.isFile()) refuse('s16_release_selection_configuration_changed');
    context ??= openS16ControlMaintenance(config, lstatSync(join(config.directory, 'owner/owner.sqlite.ops/fence.json'), { throwIfNoEntry: false }) ? { operationFence: readS16OperationsFence(config.directory) } : {});
    if (inspectS16ExecutingPackage(context.sources).contentHash !== input.operatorSha256) refuse('s16_release_selection_operator_changed');
    return { ctx: context, config, journal: context.operations() };
  };
  const verifyPackages = () => {
    const manifests = [input.sourceDirectory, input.targetDirectory].map((directory, index) => {
      assertRootTree(directory, options.pathPolicy); const checked = validateArtifact(directory, { runtime: true });
      if (!checked.ok || checked.manifest?.contentHash !== (index ? input.targetSha256 : input.sourceSha256) || checked.manifest.artifactId !== basename(directory) || checked.manifest.bunVersion !== Bun.version) refuse('s16_release_selection_package_changed');
      return checked.manifest;
    });
    return manifests;
  };
  const sourceValue = s16RootSelectorValue(input.sourceDirectory), targetValue = s16RootSelectorValue(input.targetDirectory);
  const pointer = () => inspectS16RootReleaseSelector({ prefix: input.prefix, ...(options.pathPolicy ? { pathPolicy: options.pathPolicy } : {}) });
  const backupRequestId = 'release_backup_' + digest(input), command = (point: S16PointCaptureResult) => digest({ contract: 's16-guarded-release-command/v1', input, backup: point });
  const captureBackup = async () => {
    const { ctx } = open(); if (backup && !backup.released || native && !native.released || cut && !cut.released) refuse('s16_ops_source_release_unknown');
    backup = ctx.pointCapture(backupRequestId); const result = await backup.capture(); await backup.close(); return result;
  };
  const observe = async (point: S16PointCaptureResult): Promise<Cohort> => {
    const { ctx } = open(), files = ctx.fileCustody(), github = ctx.githubArtifacts(), external = ctx.externalCustody(), namespace = ctx.nativeNamespace(), helpers = await ctx.helperCustody(); guard();
    if (cut && !cut.released) refuse('s16_ops_source_release_unknown'); cut = ctx.currentLedgerCut();
    let sql: S16PackageProbeObservation['sql'];
    try {
      files.assertCurrent(); github.assertCurrent(); namespace.assertCurrent();
      sql = ctx.sources.map(source => ({ name: source.name, applicationId: source.reader.applicationId,
        format: source.database.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version, logicalSha256: hash(cut!.serialize(source.name)) })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    } finally { cut.close(); }
    external.assertCurrent(); await helpers.assertCurrent(); namespace.assertCurrent(); files.assertCurrent(); github.assertCurrent(); guard();
    // The point was independently authenticated by captureBackup. Compare all current
    // sources to that original point as well as the plan; an interrupted pre-admission
    // backup must never silently become a backup of later controller activity.
    const pointDirectory = join(readS15RuntimeConfig(input.configPath).directory, 'operations/points', point.pointId);
    const read = (name: string, limit = 4194304) => { const path = join(pointDirectory, name); s16PointEntry(path); return JSON.parse(opsRead(path, limit).toString('utf8')); };
    const captured = read('capture.json'), references = read('references.json'), ledgers = read('ledgers/' + point.pointId + '/manifest.json', 131072) as S16LedgerSet;
    const priorSql = ledgers.images.map(image => ({ name: image.name, applicationId: image.applicationId, format: image.readerVersion, logicalSha256: image.sha256 }));
    if (canonical(priorSql) !== canonical(sql) || captured.files.sha256 !== files.sha256 || captured.github.sha256 !== github.sha256 ||
      vmCanonical(references.helpers) !== vmCanonical(helpers.value) || vmCanonical(references.external) !== vmCanonical(external.value)) refuse('s16_release_selection_backup_not_current');
    return { sqlSha256: digest(sql), fileSha256: files.sha256, githubSha256: github.sha256, externalSha256: external.sha256, helperSha256: helpers.sha256,
      nativeNamespaceSha256: s16PackageNativeNamespaceSha256(namespace) };
  };
  const planAction = (plan: S16GuardedSelectionPlan) => 'release_plan_' + digest(plan);
  const selectionAction = (plan: S16GuardedSelectionPlan) => 'release_select_' + digest(plan);
  const load = (plan: S16GuardedSelectionPlan) => {
    const { ctx, journal } = open(), control = journal.read(), request = control.requests.find(row => row.requestId === input.requestId);
    if (canonical(plan).length > 65536 || plan.contract !== 's16-guarded-release-selection/v1' || canonical(plan.input) !== canonical(input) ||
      !request || request.kind !== 'upgrade' || request.hash !== command(plan.backup) || request.id !== plan.operationId || control.id !== plan.operationsId || hash(ctx.ownerIdentity) !== plan.ownerIdentitySha256 ||
      request.admittedRevision !== plan.admittedRevision || request.createdAt !== plan.createdAt || request.configurationSha256 !== input.configurationSha256 || request.pointId !== plan.backup.pointId) refuse('s16_release_selection_plan_changed');
    const action = request.actions.find(row => row.id === planAction(plan));
    if (!action || action.kind !== 'capture_backend' || action.priorSha256 !== null || action.targetSha256 !== null || !['intent', 'confirmed'].includes(action.state) || action.state === 'confirmed' && action.observedSha256 !== digest(plan)) refuse('s16_release_selection_plan_changed');
    return { ctx, journal, control, request, action };
  };
  const verifyBackupNative = async () => {
    const { ctx, config, journal } = open(), source = journal.read().requests.find(row => row.requestId === backupRequestId), actions = source?.actions.filter(row => row.kind === 'capture_native' && row.state === 'confirmed');
    if (!source || actions?.length !== 1) refuse('s16_release_selection_backup_changed');
    const path = join(config.directory, 'operations/native-staging', source.id, actions[0]!.id, 'plan.json'); s16PointEntry(path);
    const original = JSON.parse(opsRead(path, 4194304).toString('utf8'));
    native = ctx.nativeSet(backupRequestId, { attempt: original.attempt, maxBytes: original.maxBytes, verifyCurrent: true, ownedStaging: true });
    await native.capture(); await native.close();
  };
  const assertCohort = async (plan: S16GuardedSelectionPlan) => {
    if (canonical(await captureBackup()) !== canonical(plan.backup)) refuse('s16_release_selection_backup_changed');
    await verifyBackupNative();
    if (canonical(await observe(plan.backup)) !== canonical(plan.cohort)) refuse('s16_release_selection_cohort_changed');
  };
  const receipt = (plan: S16GuardedSelectionPlan, request: S16OperationsRequest): Readonly<S16GuardedSelectionReceipt> => Object.freeze({ contract: 's16-guarded-release-selection-result/v1', state: 'selected', requestId: request.requestId, operationId: request.id, planSha256: digest(plan), revision: request.revision });
  const assertReader = (plan: S16GuardedSelectionPlan, reader: S16GuardedSelectionReader, expected: string, controlSha256: string) => {
    const { ctx } = open(), binary = inspectS16ExecutingPackage(ctx.sources), observation = reader.observation;
    if (observation.contract !== 's16-package-current-readers/v1' || observation.state !== 'readable' || observation.package.contentHash !== expected || observation.configurationSha256 !== input.configurationSha256 || observation.ownerIdentitySha256 !== plan.ownerIdentitySha256 || observation.controlSha256 !== controlSha256 ||
      canonical(cohortOf(observation)) !== canonical(plan.cohort) || canonical(reader.backup) !== canonical(plan.backup) ||
      ['dependencyHash', 'lockHash', 'engineContract', 'engineRevision'].some(key => observation.package[key as keyof typeof binary] !== binary[key as keyof typeof binary])) refuse('s16_release_selection_reader_changed');
  };
  const enter = () => { guard(); if (busy) refuse('s16_release_selection_busy'); busy = true; };
  return Object.freeze<S16GuardedSelection>({ get released() { return released; }, async close() {
    if (released) return; if (busy) refuse('s16_release_selection_busy');
    await native?.close(); await backup?.close(); cut?.close(); context?.close(); released = true;
  }, inspect(plan) {
    guard(); if (busy) refuse('s16_release_selection_busy'); const state = load(plan);
    const action = state.request.actions.find(row => row.id === selectionAction(plan));
    const armed = !!action && action.kind === 'select_package' && action.priorSha256 === sourceValue.sha256 && action.targetSha256 === targetValue.sha256 && ['intent', 'unknown', 'confirmed'].includes(action.state);
    return Object.freeze({ phase: state.request.phase, status: state.request.status, armed, receipt: state.request.status === 'complete' ? receipt(plan, state.request) : null });
  }, async prepare() {
    enter(); try {
      verifyPackages(); if (pointer().sha256 !== sourceValue.sha256) refuse('s16_release_selection_source_changed');
      const { ctx, journal } = open(), prior = journal.read().requests.find(row => row.requestId === input.requestId);
      if (prior && (prior.kind !== 'upgrade' || ['complete', 'discarded'].includes(prior.status) || !journal.read().requests.some(row => row.requestId === backupRequestId && row.kind === 'backup'))) refuse('s16_release_selection_request_conflict');
      const point = await captureBackup(); after('backup'); await verifyBackupNative(); const cohort = await observe(point);
      journal.begin({ requestId: input.requestId, kind: 'upgrade', hash: command(point), pointId: point.pointId }, journal.read().revision);
      after('admitted');
      let control = journal.read(), request = control.requests.find(row => row.requestId === input.requestId)!;
      if (request.phase === 'pending') { journal.advance(input.requestId, control.revision, 'capturing'); control = journal.read(); request = control.requests.find(row => row.requestId === input.requestId)!; }
      if (request.phase !== 'capturing' || request.status !== 'running') refuse('s16_release_selection_phase_invalid');
      const plan: S16GuardedSelectionPlan = { contract: 's16-guarded-release-selection/v1', input, operationsId: control.id, operationId: request.id, ownerIdentitySha256: hash(ctx.ownerIdentity), admittedRevision: request.admittedRevision!, createdAt: request.createdAt, backup: point, cohort };
      journal.recordIntent(input.requestId, control.revision, { id: planAction(plan), kind: 'capture_backend', priorSha256: null, targetSha256: null });
      after('planned');
      return Object.freeze(plan);
    } finally { busy = false; }
  }, async arm(plan, readers) {
    enter(); try {
      let state = load(plan); if (state.request.status === 'complete') return; verifyPackages();
      if (!['capturing', 'verifying', 'prepared', 'activating'].includes(state.request.phase)) refuse('s16_release_selection_phase_invalid');
      const assertPointer = () => { const action = state.request.actions.find(row => row.id === selectionAction(plan)), value = pointer(); if (value.sha256 !== sourceValue.sha256 && (!action || value.sha256 !== targetValue.sha256)) refuse('s16_release_selection_source_changed'); };
      assertPointer();
      if (readers.length !== 2) refuse('s16_release_selection_readers_required');
      const packages = [input.sourceSha256, input.targetSha256], controlSha256 = hash(canonicalS16OperationsControl(state.journal.read()));
      for (const expected of packages) {
        const matches = readers.filter(reader => reader.observation.package.contentHash === expected); if (matches.length !== 1) refuse('s16_release_selection_reader_changed');
        assertReader(plan, matches[0]!, expected, controlSha256);
      }
      await assertCohort(plan); state = load(plan); assertPointer();
      if (state.request.phase === 'capturing') state.journal.observeAction(input.requestId, state.control.revision, state.action.id, 'applied', digest(plan));
      state = load(plan); if (state.request.status !== 'running' && !state.request.actions.some(action => action.kind === 'select_package')) { state.journal.resume(input.requestId, state.control.revision); state = load(plan); }
      for (const phase of ['verifying', 'prepared', 'activating'] as const) {
        state = load(plan); const order = ['capturing', 'verifying', 'prepared', 'activating'];
        if (order.indexOf(state.request.phase) < order.indexOf(phase)) state.journal.advance(input.requestId, state.control.revision, phase, { cohortSha256: digest(plan.cohort), targetSha256: targetValue.sha256 });
      }
      state = load(plan); assertPointer();
      state.journal.recordIntent(input.requestId, state.control.revision, { id: selectionAction(plan), kind: 'select_package', priorSha256: sourceValue.sha256, targetSha256: targetValue.sha256 });
      after('armed');
    } finally { busy = false; }
  }, async complete(plan) {
    enter(); try {
      let state = load(plan); if (state.request.status === 'complete') return receipt(plan, state.request);
      const action = state.request.actions.find(row => row.id === selectionAction(plan));
      if (state.request.phase !== 'activating' || state.action.state !== 'confirmed' || !action || action.kind !== 'select_package' || action.priorSha256 !== sourceValue.sha256 || action.targetSha256 !== targetValue.sha256) refuse('s16_release_selection_phase_invalid');
      verifyPackages(); if (pointer().sha256 !== targetValue.sha256) refuse('s16_release_selection_target_changed');
      await assertCohort(plan); state = load(plan);
      state.journal.observeAction(input.requestId, state.control.revision, action.id, 'applied', targetValue.sha256); state = load(plan);
      if (state.request.status !== 'running') { state.journal.resume(input.requestId, state.control.revision); state = load(plan); }
      state.journal.advance(input.requestId, state.control.revision, 'complete'); after('completed'); state = load(plan); return receipt(plan, state.request);
    } finally { busy = false; }
  }, async abortBeforeSelection(plan, source) {
    enter(); try {
      let state = load(plan);
      const result = (): Readonly<S16GuardedSelectionAbort> => Object.freeze({ contract: 's16-guarded-release-abort/v1', state: 'not_selected', requestId: input.requestId, operationId: plan.operationId, planSha256: digest(plan), revision: state.request.revision });
      if (state.request.actions.some(action => action.kind === 'select_package') || state.request.status === 'complete') refuse('s16_release_selection_abort_unsafe');
      if (state.request.status === 'discarded') return result();
      const verifySource = () => {
        assertRootTree(input.sourceDirectory, options.pathPolicy); const checked = validateArtifact(input.sourceDirectory, { runtime: true });
        if (!checked.ok || checked.manifest?.contentHash !== input.sourceSha256 || checked.manifest.artifactId !== basename(input.sourceDirectory) || checked.manifest.bunVersion !== Bun.version || pointer().sha256 !== sourceValue.sha256) refuse('s16_release_selection_source_changed');
      };
      verifySource(); assertReader(plan, source, input.sourceSha256, hash(canonicalS16OperationsControl(state.control))); await assertCohort(plan); verifySource(); state = load(plan);
      state.journal.observeAction(input.requestId, state.control.revision, state.action.id, 'applied', digest(plan)); state = load(plan);
      if (state.request.status !== 'running') { state.journal.resume(input.requestId, state.control.revision); state = load(plan); }
      state.journal.advance(input.requestId, state.control.revision, 'discarded'); state = load(plan); return result();
    } finally { busy = false; }
  } });
}

if (import.meta.main) {
  let cap: S16GuardedSelection | undefined;
  try {
    if (process.argv.length !== 2) refuse();
    const reader = Bun.stdin.stream().getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 131072) refuse(); chunks.push(next.value); } } finally { await reader.cancel(); }
    const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const expected = command.method === 'prepare' ? ['input', 'method'] : command.method === 'arm' ? ['input', 'method', 'plan', 'readers'] : command.method === 'abort' ? ['input', 'method', 'plan', 'reader'] : ['input', 'method', 'plan'];
    if (!['prepare', 'inspect', 'arm', 'complete', 'abort'].includes(command.method) || Object.keys(command).sort().join(',') !== expected.sort().join(',')) refuse();
    cap = openS16GuardedSelection(command.input); let result: unknown;
    if (command.method === 'prepare') result = await cap.prepare();
    else if (command.method === 'inspect') result = cap.inspect(command.plan);
    else if (command.method === 'arm') { await cap.arm(command.plan, command.readers); result = { state: 'armed' }; }
    else if (command.method === 'abort') result = await cap.abortBeforeSelection(command.plan, command.reader);
    else result = await cap.complete(command.plan);
    await cap.close(); console.log(canonical(result));
  } catch { try { await cap?.close(); } catch { /* Original operation remains fenced; never certify an unknown release. */ } console.error('s16_release_selection_refused'); process.exitCode = 1; }
}
