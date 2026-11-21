import { lstatSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { canonical, identity } from '../../../src/s15/conversation/validation';
import { readS15RuntimeConfig } from '../../../src/s15/runtime-config';
import { openS16ControlMaintenance, type S16ControlMaintenance } from '../../../src/s16/operations/control-maintenance';
import type { S16LedgerWriteCut } from '../../../src/s16/operations/ledger-write-cut';
import { readS16OperationsFence, type S16OperationsRequest } from '../../../src/s16/operations/operations-state';
import { inspectS16ExecutingPackage } from '../../../src/s16/operations/package-custody';
import { assertRootTree, type RootPathPolicy } from '../trusted-paths';
import { validateArtifact } from '../bun-build';
import { inspectS16RootReleaseSelector } from './s16-release-selector';
import { s16PackageNativeNamespaceSha256 } from './s16-package-probe';
import { readS16Wiring, s16AbsentWiring, s16WiringLayout, s16WiringSha256 } from './s16-wiring-value';

const digest = (value: unknown) => new Bun.CryptoHasher('sha256').update(canonical(value)).digest('hex');
const sha = (value: string) => /^[a-f0-9]{64}$/.test(value);
function refuse(code = 's16_wiring_maintenance_refused'): never { throw Error(code); }
/** Original protected root wiring command; it cannot name an arbitrary filesystem target. */
export interface S16WiringInput {
  requestId: string; direction: 'remove' | 'restore'; configPath: string; configurationSha256: string; operatorSha256: string;
  currentDirectory: string; currentSha256: string; priorWiringSha256: string; targetWiringSha256: string; originalRemovalRequestId: string | null;
}
interface Cohort { sqlSha256: string; nativeNamespaceSha256: string; keyringWiringSha256: string }
/** Independently journalled original current facts, separate from root's retained public unit bytes. */
export interface S16WiringPlan {
  contract: 's16-installed-wiring/v1'; input: S16WiringInput; operationsId: string; operationId: string; ownerSha256: string;
  admittedRevision: number; createdAt: number; cohort: Cohort;
}
/** Historical original operation only; it grants no permission to remove later restored wiring. */
export interface S16WiringReceipt { contract: 's16-installed-wiring-result/v1'; requestId: string; operationId: string; planSha256: string; revision: number }
/** Fixture boundaries are never accepted by the production helper CLI. */
export interface S16WiringOptions { pathPolicy?: RootPathPolicy; layoutRoot?: string; after?: (at: 'admitted' | 'planned' | 'armed' | 'completed') => void }
/** Retains original SQL and process capabilities after unknown disposal for same-owner retry. */
export interface S16WiringMaintenance {
  readonly released: boolean; prepare(): Readonly<S16WiringPlan>; arm(plan: S16WiringPlan): void;
  inspect(plan: S16WiringPlan): Readonly<{ armed: boolean; receipt: Readonly<S16WiringReceipt> | null }>;
  complete(plan: S16WiringPlan): Readonly<S16WiringReceipt>; close(): void;
}

/** Current-data-preserving unit removal/restoration only; no package, SQL, payload or native activation. */
export function openS16WiringMaintenance(input: S16WiringInput, options: S16WiringOptions = {}): S16WiringMaintenance {
  identity(input.requestId); const layout = s16WiringLayout(options.layoutRoot), policy = options.pathPolicy ?? {};
  if (input.originalRemovalRequestId !== null) identity(input.originalRemovalRequestId);
  if (Object.keys(input).sort().join(',') !== 'configPath,configurationSha256,currentDirectory,currentSha256,direction,operatorSha256,originalRemovalRequestId,priorWiringSha256,requestId,targetWiringSha256' ||
    !['remove', 'restore'].includes(input.direction) || input.configPath !== layout.config || dirname(input.currentDirectory) !== join(layout.prefix, 'releases') ||
    (input.direction === 'remove' ? input.originalRemovalRequestId !== null : input.originalRemovalRequestId === null || input.originalRemovalRequestId === input.requestId) ||
    ![input.configurationSha256, input.currentSha256, input.operatorSha256, input.priorWiringSha256, input.targetWiringSha256].every(sha) ||
    input.priorWiringSha256 === input.targetWiringSha256) refuse();
  input = JSON.parse(canonical(input)) as S16WiringInput;
  let context: S16ControlMaintenance | undefined, cut: S16LedgerWriteCut | undefined, released = false, busy = false;
  const kind = input.direction === 'remove' ? 'uninstall' : 'upgrade', planAction = 'wiring_plan_' + digest(input), physicalAction = 'wiring_effect_' + digest(input);
  const guard = () => { if (released) refuse('s16_wiring_maintenance_closed'); context?.assertCurrent(); };
  const after = (at: Parameters<NonNullable<S16WiringOptions['after']>>[0]) => { guard(); if ((options.after?.(at) as unknown) !== undefined) refuse(); guard(); };
  const open = () => {
    guard(); const config = readS15RuntimeConfig(input.configPath);
    if (config.directory !== layout.state || digest(config) !== input.configurationSha256 || !lstatSync(join(config.directory, 'operations/control.json'), { throwIfNoEntry: false })?.isFile()) refuse('s16_wiring_configuration_changed');
    context ??= openS16ControlMaintenance(config, lstatSync(join(config.directory, 'owner/owner.sqlite.ops/fence.json'), { throwIfNoEntry: false }) ? { operationFence: readS16OperationsFence(config.directory) } : {});
    if (inspectS16ExecutingPackage(context.sources).contentHash !== input.operatorSha256) refuse('s16_wiring_operator_changed');
    const journal = context.operations();
    if (input.direction === 'restore') {
      const original = journal.read().requests.find(row => row.requestId === input.originalRemovalRequestId);
      const actions = original?.actions.filter(row => row.id.startsWith('wiring_effect_') && row.kind === 'replace' && row.state === 'confirmed' && row.priorSha256 === input.targetWiringSha256 && row.targetSha256 === input.priorWiringSha256 && row.observedSha256 === input.priorWiringSha256);
      if (!original || original.kind !== 'uninstall' || original.status !== 'complete' || original.phase !== 'complete' || original.configurationSha256 !== input.configurationSha256 || actions?.length !== 1) refuse('s16_wiring_original_removal_unconfirmed');
    }
    return { ctx: context, journal };
  };
  const packageCurrent = () => {
    assertRootTree(input.currentDirectory, policy); const checked = validateArtifact(input.currentDirectory, { runtime: true });
    if (!checked.ok || checked.manifest?.contentHash !== input.currentSha256 || checked.manifest.artifactId !== basename(input.currentDirectory) || checked.manifest.bunVersion !== Bun.version ||
      inspectS16RootReleaseSelector({ prefix: layout.prefix, pathPolicy: policy }).targetDirectory !== input.currentDirectory) refuse('s16_wiring_current_package_changed');
  };
  const wiring = () => s16WiringSha256(readS16Wiring(layout, process.getuid!(), policy));
  const cohort = (): Cohort => {
    const { ctx } = open(); if (cut && !cut.released) refuse('s16_ops_source_release_unknown'); cut = ctx.currentLedgerCut();
    try {
      if (!ctx.sources.length || ctx.sources.length > 256) refuse('s16_wiring_source_bounds');
      const native = ctx.nativeNamespace(), nativeNamespaceSha256 = s16PackageNativeNamespaceSha256(native);
      const sql = ctx.sources.map(source => ({ name: source.name, sha256: new Bun.CryptoHasher('sha256').update(cut!.serialize(source.name)).digest('hex') })).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
      native.assertCurrent(); guard(); return { sqlSha256: digest(sql), nativeNamespaceSha256, keyringWiringSha256: digest(readS16Wiring(layout, process.getuid!(), policy).files.keyring) };
    } finally { cut.close(); }
  };
  const command = (facts: Cohort) => digest({ contract: 's16-installed-wiring/v1', input, cohort: facts });
  const load = (plan: S16WiringPlan) => {
    const { ctx, journal } = open(), control = journal.read(), request = control.requests.find(row => row.requestId === input.requestId);
    if (Buffer.byteLength(canonical(plan)) > 65536 || plan.contract !== 's16-installed-wiring/v1' || canonical(plan.input) !== canonical(input) ||
      !request || request.kind !== kind || request.hash !== command(plan.cohort) || request.id !== plan.operationId || request.configurationSha256 !== input.configurationSha256 ||
      plan.operationsId !== control.id || plan.ownerSha256 !== digest(ctx.ownerIdentity) || plan.admittedRevision !== request.admittedRevision || plan.createdAt !== request.createdAt ||
      request.cohortSha256 !== digest(plan.cohort) || request.targetSha256 !== input.targetWiringSha256) refuse('s16_wiring_original_plan_changed');
    const action = request.actions.find(row => row.id === planAction);
    if (!action || action.kind !== 'replace' || action.priorSha256 !== null || action.targetSha256 !== digest(plan)) refuse('s16_wiring_original_plan_changed');
    return { ctx, journal, control, request, action };
  };
  const receipt = (plan: S16WiringPlan, request: S16OperationsRequest): Readonly<S16WiringReceipt> => Object.freeze({ contract: 's16-installed-wiring-result/v1', requestId: input.requestId, operationId: request.id, planSha256: digest(plan), revision: request.revision });
  const armed = (state: ReturnType<typeof load>) => {
    const action = state.request.actions.find(row => row.id === physicalAction);
    return state.action.state === 'confirmed' && state.request.phase === 'activating' && !!action && action.kind === 'replace' && action.priorSha256 === input.priorWiringSha256 && action.targetSha256 === input.targetWiringSha256 && ['intent', 'unknown', 'confirmed'].includes(action.state);
  };
  const enter = () => { guard(); if (busy) refuse('s16_wiring_maintenance_busy'); busy = true; };
  return Object.freeze<S16WiringMaintenance>({ get released() { return released; }, close() { if (released) return; if (busy) refuse('s16_wiring_maintenance_busy'); cut?.close(); context?.close(); released = true; }, inspect(plan) {
    guard(); if (busy) refuse('s16_wiring_maintenance_busy'); const state = load(plan);
    return Object.freeze({ armed: armed(state), receipt: state.request.status === 'complete' ? receipt(plan, state.request) : null });
  }, prepare() {
    enter(); try {
      packageCurrent(); const prior = readS16Wiring(layout, process.getuid!(), policy);
      if (s16WiringSha256(prior) !== input.priorWiringSha256 || (input.direction === 'remove' ? input.targetWiringSha256 : input.priorWiringSha256) !== s16WiringSha256(s16AbsentWiring(prior.files.keyring))) refuse('s16_wiring_prior_changed');
      const facts = cohort(), { ctx, journal } = open();
      journal.begin({ requestId: input.requestId, kind, hash: command(facts) }, journal.read().revision); after('admitted');
      let control = journal.read(), request = control.requests.find(row => row.requestId === input.requestId)!;
      if (['complete', 'discarded'].includes(request.status)) refuse('s16_wiring_original_request_terminal');
      const plan: S16WiringPlan = { contract: 's16-installed-wiring/v1', input, operationsId: control.id, operationId: request.id, ownerSha256: digest(ctx.ownerIdentity), admittedRevision: request.admittedRevision!, createdAt: request.createdAt, cohort: facts };
      const phases = input.direction === 'remove' ? ['pending', 'prepared'] as const : ['pending', 'capturing', 'verifying', 'prepared'] as const;
      if (request.status !== 'running' || !(phases as readonly string[]).includes(request.phase)) refuse('s16_wiring_phase_invalid');
      for (const phase of phases.slice(1)) {
        control = journal.read(); request = control.requests.find(row => row.requestId === input.requestId)!;
        if ((phases as readonly string[]).indexOf(request.phase) < (phases as readonly string[]).indexOf(phase)) journal.advance(input.requestId, control.revision, phase, { cohortSha256: digest(facts), targetSha256: input.targetWiringSha256 });
      }
      journal.recordIntent(input.requestId, journal.read().revision, { id: planAction, kind: 'replace', priorSha256: null, targetSha256: digest(plan) }); after('planned'); return Object.freeze(plan);
    } finally { busy = false; }
  }, arm(plan) {
    enter(); try {
      let state = load(plan); if (state.request.status === 'complete') return;
      packageCurrent(); if (canonical(cohort()) !== canonical(plan.cohort)) refuse('s16_wiring_current_changed');
      if (armed(state)) return;
      if (wiring() !== input.priorWiringSha256) refuse('s16_wiring_current_changed');
      if (!['prepared', 'activating'].includes(state.request.phase) || state.request.status !== 'running') refuse('s16_wiring_phase_invalid');
      state.journal.observeAction(input.requestId, state.control.revision, planAction, 'applied', digest(plan)); state = load(plan);
      if (state.request.phase === 'prepared') state.journal.advance(input.requestId, state.control.revision, 'activating'); state = load(plan);
      state.journal.recordIntent(input.requestId, state.control.revision, { id: physicalAction, kind: 'replace', priorSha256: input.priorWiringSha256, targetSha256: input.targetWiringSha256 }); after('armed');
    } finally { busy = false; }
  }, complete(plan) {
    enter(); try {
      let state = load(plan); if (state.request.status === 'complete') return receipt(plan, state.request);
      const action = state.request.actions.find(row => row.id === physicalAction);
      if (state.request.phase !== 'activating' || state.request.status !== 'running' || state.action.state !== 'confirmed' || !action || action.kind !== 'replace' || action.priorSha256 !== input.priorWiringSha256 || action.targetSha256 !== input.targetWiringSha256) refuse('s16_wiring_phase_invalid');
      packageCurrent(); if (canonical(cohort()) !== canonical(plan.cohort) || wiring() !== input.targetWiringSha256) refuse('s16_wiring_current_changed');
      state = load(plan); state.journal.observeAction(input.requestId, state.control.revision, physicalAction, 'applied', input.targetWiringSha256); state = load(plan);
      state.journal.advance(input.requestId, state.control.revision, 'complete'); after('completed'); state = load(plan); return receipt(plan, state.request);
    } finally { busy = false; }
  } });
}

if (import.meta.main) {
  let cap: S16WiringMaintenance | undefined;
  try {
    if (process.argv.length !== 2) refuse();
    const reader = Bun.stdin.stream().getReader(), chunks: Uint8Array[] = []; let bytes = 0;
    try { for (;;) { const next = await reader.read(); if (next.done) break; bytes += next.value.length; if (bytes > 131072) refuse(); chunks.push(next.value); } } finally { await reader.cancel(); }
    const command = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!['prepare', 'inspect', 'arm', 'complete'].includes(command.method) || Object.keys(command).sort().join(',') !== (command.method === 'prepare' ? 'input,method' : 'input,method,plan')) refuse();
    cap = openS16WiringMaintenance(command.input);
    const result = command.method === 'prepare' ? cap.prepare() : command.method === 'inspect' ? cap.inspect(command.plan) : command.method === 'arm' ? (cap.arm(command.plan), { state: 'armed' }) : cap.complete(command.plan);
    cap.close(); console.log(JSON.stringify(result));
  } catch { try { cap?.close(); } catch { /* Original unknown disposal remains fenced until process exit. */ } console.error('s16_wiring_maintenance_refused'); process.exitCode = 1; }
}
