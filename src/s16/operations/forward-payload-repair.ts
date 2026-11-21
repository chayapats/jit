import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from '../../errors';
import { opsDirectory, opsRead, opsWrite } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import type { S15RuntimeConfig } from '../../s15/runtime-config';
import type { S16ControlMaintenance } from './control-maintenance';
import type { S16CandidateMaintenance, S16CandidateObservation } from './candidate-quarantine';
import type { S16CurrentNativeMaintenance } from './current-native-custody';
import type { S16ForwardCurrentCohort, S16ForwardCurrentMaintenance } from './forward-current-cohort';
import type { S16HelperCohortOptions } from './helper-cohort';
import { assertS16ExclusiveInstallationLease, type S16InstallationLease } from './installation-lease';
import { openS16LedgerWriteCut, type S16LedgerWriteCut } from './ledger-write-cut';
import type { S16OperationsJournal } from './operations-journal';
import { inspectS16ExecutingPackage } from './package-custody';
import { inspectS16RepairFile, createS16EmptyRepairTemp, copyS16RepairPrefix, publishS16RepairFile, s16RepairFileEntry, verifyS16RepairFile } from './repair-files';
import { assertS16RepairPhysicalCustody, assertS16RepairedByteCatalogs, readS16OriginalCurrentCohort, s16RepairMemberPaths, s16RepairParentPath, type S16ForwardRepairPlan, type S16RepairDomain, type S16RepairMember, type S16RepairParent } from './repair-custody';
import { s16PointDirectory, s16PointMemberPath, s16PointEntry, s16PointEntryIdentity } from './point-files';
import { s16RecoveryLimits, s16RecoveryNames as names, s16RecoveryUsage as usage } from './recovery-usage';
import { verifyS16LedgerSet, s16LedgerSetManifestHash } from './verify-ledger-set';
import { assertS16SelectedStores } from './selected-stores';

const planBound = 16777216;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function refuse(code = 's16_ops_forward_repair_invalid'): never { throw new AppError(code, 409); }
function text(value: unknown): string { const out = JSON.stringify(value); if (Buffer.byteLength(out) > 67108864) refuse('s16_ops_recovery_bounds'); return out; }
/** The original completed operation receipt only; newer current state is never rewound by response retry. */
export interface S16ForwardRepairResult { readonly contract: 's16-forward-payload-repair-result/v1'; readonly state: 'complete'; readonly operationId: string; readonly requestId: string; readonly pointId: string; readonly cohortSha256: string; readonly planSha256: string; readonly revision: number }
/** Original disposal remains available after any unknown native/SQL boundary. */
export interface S16ForwardRepairMaintenance { readonly released: boolean; readonly resourcesReleased: boolean; repair(): Promise<S16ForwardRepairResult>; close(): Promise<void> }
/** Only protected current composition supplies bindings; the request selects a retained opaque point ID. */
export interface S16ForwardRepairOwner { config: S15RuntimeConfig; requestId: string; pointId: string; lease: S16InstallationLease; context: S16ControlMaintenance; journal: S16OperationsJournal }
/** Deterministic fault observers and explicitly labelled helper transport, never ordinary actor inputs. */
export interface S16ForwardRepairOptions {
  helper?: S16HelperCohortOptions;
  after?(boundary: 'admitted' | 'candidate' | 'current' | 'parent' | 'temps' | 'plan_intent' | 'plan' | 'bytes_intent' | 'copy_chunk' | 'copied' | 'bytes' | 'verifying' | 'prepared' | 'activating' | 'activation_intent' | 'linked' | 'published' | 'revalidated' | 'publication_observed' | 'complete', member?: number): void;
}
interface Selected extends Omit<S16RepairMember, 'tempIdentity'> {}
/** Repairs only absent immutable members from independently verified current pins; no authority store is replaced. */
export function openS16ForwardPayloadRepair(owner: S16ForwardRepairOwner, options: S16ForwardRepairOptions = {}): S16ForwardRepairMaintenance {
  const { config, requestId, pointId, context, journal } = owner; identity(requestId); if (!/^[a-f0-9]{32}$/.test(pointId)) refuse();
  let released = false, usable = true, busy = false, cut: S16LedgerWriteCut | undefined;
  let candidate: S16CandidateMaintenance | undefined, cohort: S16ForwardCurrentMaintenance | undefined, native: S16CurrentNativeMaintenance | undefined;
  const guard = () => { if (released || !usable) refuse('s16_ops_forward_repair_closed'); assertS16ExclusiveInstallationLease(owner.lease, config.directory); context.assertCurrent(); };
  const after = (boundary: Parameters<NonNullable<S16ForwardRepairOptions['after']>>[0], member?: number) => { guard(); if ((options.after?.(boundary, member) as unknown) !== undefined) refuse('s16_ops_guard_invalid'); if (cut && !cut.released) cut.assertCurrent(); guard(); };
  const read = () => { guard(); const control = journal.read(), request = control.requests.find(row => row.requestId === requestId); if (!request || request.kind !== 'restore' || request.pointId !== pointId || request.configurationSha256 !== hash(canonical(config))) refuse(); return { control, request }; };
  const resumeSettled = () => { const state = read(); if (state.request.status !== 'running') journal.resume(requestId, state.control.revision); };
  const releaseCut = () => { if (!cut) return; try { cut.close(); } catch { usable = false; refuse('s16_ops_source_release_unknown'); } };
  const reserve = () => { guard(); if (cut && !cut.released) refuse('s16_ops_source_release_unknown'); return openS16LedgerWriteCut({ sources: context.sources, guard, retain(value) { cut = value; } }); };
  const currentSql = (saved: S16ForwardCurrentCohort, action?: (held: S16LedgerWriteCut) => void) => {
    guard(); assertS16SelectedStores(config, context.runtime.sources);
    const sources = [...context.sources].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    if (text(sources.map(row => ({ name: row.name, identity: s16PointEntryIdentity(s16PointEntry(row.database.filename), true) }))) !== text(saved.sql.sources) || saved.sql.manifest.images.length !== sources.length || s16LedgerSetManifestHash(saved.sql.manifest) !== saved.sql.manifestSha256) refuse('s16_ops_repair_current_sql_changed');
    const held = reserve();
    try {
      for (const [at, row] of saved.sql.manifest.images.entries()) { if (row.name !== sources[at]!.name) refuse(); const bytes = held.serialize(row.name); if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) refuse('s16_ops_repair_current_sql_changed'); }
      if ((action?.(held) as unknown) !== undefined) refuse('s16_ops_guard_invalid'); held.assertCurrent();
    } finally { releaseCut(); }
  };
  const verifyCurrent = async (saved: S16ForwardCurrentCohort, plan: S16ForwardRepairPlan, final = false) => {
    guard(); assertS16RepairPhysicalCustody(config, saved, plan, guard);
    if (text(inspectS16ExecutingPackage(context.sources)) !== text(saved.package)) refuse('s16_ops_repair_package_changed');
    if (!native || native.released) native = context.currentNativeCustody(requestId);
    const actual = await native.capture(); if (actual.sha256 !== saved.native.sha256 || actual.roots !== saved.native.roots || actual.pending !== saved.native.pending) refuse('s16_ops_repair_current_native_changed');
    const helpers = await context.helperCustody(options.helper), external = context.externalCustody();
    if (text({ value: helpers.value, sha256: helpers.sha256 }) !== text(saved.helpers) || text({ value: external.value, sha256: external.sha256 }) !== text(saved.external)) refuse('s16_ops_repair_current_external_changed');
    verifyS16LedgerSet({ directory: join(config.directory, 'operations/forward-recovery', saved.operationId, 'ledgers'), installationId: config.installationId, id: saved.operationId, readers: context.sources.map(({ database: _db, ...source }) => source), manifestSha256: saved.sql.manifestSha256 });
    assertS16RepairPhysicalCustody(config, saved, plan, guard); if (final) assertS16RepairedByteCatalogs(context, saved, plan); currentSql(saved); guard();
  };
  const result = (): S16ForwardRepairResult => { const state = read(); if (state.request.phase !== 'complete' || state.request.status !== 'complete' || !state.request.cohortSha256 || !state.request.targetSha256) refuse(); return Object.freeze({ contract: 's16-forward-payload-repair-result/v1', state: 'complete', operationId: state.request.id, requestId, pointId, cohortSha256: state.request.cohortSha256, planSha256: state.request.targetSha256, revision: state.request.revision }); };
  const select = (saved: S16ForwardCurrentCohort, observed: S16CandidateObservation): Selected[] => {
    const output: Omit<Selected, 'tempName'>[] = [], members = new Map(observed.inventory.files.filter(row => row.scope === 'payloads').map(row => [row.name, row]));
    const add = (domain: S16RepairDomain, name: string, sourceName: string, sha256: string, bytes?: number) => { const source = members.get(sourceName); if (!source || source.sha256 !== sha256 || bytes !== undefined && source.bytes !== bytes) refuse('s16_ops_repair_candidate_member_missing'); output.push({ domain, name, sourceName, sourceIdentity: source.identity, bytes: source.bytes, sha256 }); };
    currentSql(saved, held => {
      const references = context.currentPayloadReferences(held).value;
      for (const pin of saved.file.value.missing) { const current = references.file?.files.find(row => row.name === pin.name); if (!current || text(current) !== text(pin)) refuse('s16_ops_repair_current_pin_changed'); add('file', current.name, 'file_' + hash('data/' + current.name) + '.blob', current.sha256, current.bytes); }
      if (saved.github.value.missing.length && !saved.github.value.present) refuse('s16_ops_repair_current_continuity_required');
      for (const pin of saved.github.value.missing) { const current = references.github.bundles.find(row => row.id === pin.id); if (!current || text(current) !== text(pin)) refuse('s16_ops_repair_current_pin_changed'); add('github', current.id, 'github_' + current.id + '.bundle', current.sha256); }
    });
    if (output.length > 20000 || output.reduce((sum, row) => sum + row.bytes, 0) > 4294967296) refuse('s16_ops_recovery_bounds');
    return output.sort((a, b) => (a.domain + '/' + a.name) < (b.domain + '/' + b.name) ? -1 : 1).map((row, at) => ({ ...row, tempName: '.jit-recovery-' + saved.operationId + '-' + at.toString(16).padStart(5, '0') + '.tmp' }));
  };
  guard();
  return Object.freeze<S16ForwardRepairMaintenance>({ get released() { return released; }, get resourcesReleased() { return (!cut || cut.released) && (!candidate || candidate.resourcesReleased) && (!cohort || cohort.resourcesReleased) && (!native || native.resourcesReleased); },
    async close() { if (released) return; usable = false; if (busy) refuse('s16_ops_forward_repair_busy'); releaseCut(); await cohort?.close(); await native?.close(); await candidate?.close(); released = true; },
    async repair() {
      guard(); if (busy) refuse('s16_ops_forward_repair_busy'); busy = true; let pendingActionId: string | undefined, commandBinding: string | undefined;
      try {
        const binary = inspectS16ExecutingPackage(context.sources), configurationSha256 = hash(canonical(config)), command = hash(canonical({ contract: 's16-forward-payload-repair-command/v1', pointId, configurationSha256, package: binary }));
        const control = journal.read(), originalRequest = control.requests.find(row => row.requestId === requestId);
        // A terminal response retains its original binding; unfinished activation still requires its original package.
        const binding = originalRequest?.kind === 'restore' && originalRequest.phase === 'complete' && originalRequest.status === 'complete' && originalRequest.pointId === pointId && originalRequest.configurationSha256 === configurationSha256 ? originalRequest.hash : command;
        commandBinding = binding;
        journal.begin({ requestId, kind: 'restore', hash: binding, pointId }, control.revision); let state = read();
        if (state.request.phase === 'complete') return result(); if (state.request.phase === 'discarded') refuse('s16_ops_repair_discarded'); after('admitted');
        if (state.request.phase === 'pending') { resumeSettled(); journal.advance(requestId, read().control.revision, 'capturing'); }
        candidate = context.candidateQuarantine(requestId); const observed = await candidate.verify(); after('candidate');
        state = read();
        if (!state.request.actions.some(row => row.id.startsWith('current_cohort_') && row.state === 'confirmed')) { if (state.request.phase !== 'capturing') refuse('s16_ops_current_cohort_incomplete'); cohort = context.forwardCurrentCohort(requestId, { ...(options.helper ? { helper: options.helper } : {}) }); await cohort.capture(); await cohort.close(); }
        const stage = context.recoveryStage(requestId), retained = readS16OriginalCurrentCohort(context, stage, requestId), saved = retained.value; after('current');
        if (text(saved.package) !== text(binary)) refuse('s16_ops_repair_package_changed');
        const selected = select(saved, observed), planPath = join(stage.root, 'plan.json'), original = read(), planActions = original.request.actions.filter(row => row.id.startsWith('repair_plan_'));
        if (planActions.length > 1 || planActions[0]?.state === 'not_applied') refuse();
        const ownership = planActions[0], prepared = original.request.phase !== 'capturing'; let plan: S16ForwardRepairPlan, encoded: string;
        if (lstatSync(planPath, { throwIfNoEntry: false })) {
          const stat = s16PointEntry(planPath); if (!ownership || stat.size > BigInt(planBound)) refuse('s16_ops_repair_plan_invalid');
          const data = opsRead(planPath, planBound); if (hash(data) !== ownership.targetSha256) refuse('s16_ops_repair_plan_invalid'); encoded = new TextDecoder('utf-8', { fatal: true }).decode(data); plan = JSON.parse(encoded);
        } else {
          if (prepared) refuse('s16_ops_repair_plan_missing');
          const occupied = usage(dirname(stage.root)), bytes = selected.reduce((sum, row) => sum + row.bytes, 0);
          if (occupied.bytes + bytes + planBound > s16RecoveryLimits.bytes || occupied.nodes + selected.length * 2 + 4 > s16RecoveryLimits.nodes) refuse('s16_ops_recovery_bounds');
          const parents: S16RepairParent[] = [];
          for (const domain of ['file', 'github'] as const) {
            const root = s16RepairParentPath(config, domain), entry = [...saved.file.entries, ...saved.github.entries].find(row => row.path === root);
            if (!selected.some(row => row.domain === domain) && !((domain === 'file' ? saved.file.value.present : saved.github.value.present) && entry?.kind === 'absent')) continue;
            if (!entry || !['directory', 'absent'].includes(entry.kind)) refuse();
            if (entry.kind === 'directory') { if (s16PointEntryIdentity(s16PointEntry(root, true), true) !== entry.sha256) refuse('s16_ops_repair_parent_changed'); parents.push({ domain, identity: entry.sha256!, created: false }); continue; }
            const id = 'repair_parent_' + domain + '_' + retained.sha256; let latest = read(), action = latest.request.actions.find(row => row.id === id);
            if (action) s16PointEntry(root, true); else { if (ownership) refuse('s16_ops_repair_parent_changed'); opsDirectory(root); }
            const directory = s16PointEntryIdentity(s16PointEntry(root, true), true), parentHash = hash(text({ contract: 's16-repair-parent/v1', operationId: saved.operationId, cohortSha256: retained.sha256, domain, identity: directory }));
            if (action && (action.kind !== 'capture_backend' || action.priorSha256 !== retained.sha256 || action.targetSha256 !== parentHash || action.state === 'not_applied')) refuse('s16_ops_repair_parent_changed');
            if (!action) { if (names(root, 1).length) refuse('s16_ops_repair_unowned_parent'); resumeSettled(); latest = read(); journal.recordIntent(requestId, latest.control.revision, { id, kind: 'capture_backend', priorSha256: retained.sha256, targetSha256: parentHash }); }
            latest = read(); action = latest.request.actions.find(row => row.id === id)!;
            if (action.state !== 'confirmed') { if (names(root, 1).length) refuse('s16_ops_repair_unowned_parent'); journal.observeAction(requestId, latest.control.revision, id, 'applied', parentHash); }
            parents.push({ domain, identity: directory, created: true }); after('parent');
          }
          const members: S16RepairMember[] = [];
          for (const row of selected) { const root = s16RepairParentPath(config, row.domain), temp = join(root, row.tempName); if (lstatSync(join(root, row.name), { throwIfNoEntry: false })) refuse('s16_ops_repair_unowned_target'); if (ownership) { const originalTemp = s16RepairFileEntry(temp)!; if (originalTemp.size !== 0n) refuse('s16_ops_repair_plan_missing'); } const tempIdentity = createS16EmptyRepairTemp(temp); members.push({ ...row, tempIdentity }); }
          after('temps');
          plan = { contract: 's16-forward-payload-repair/v1', operationsId: original.control.id, installationId: config.installationId, ownerIdentity: context.ownerIdentity, operationId: saved.operationId, requestId, configurationSha256, admittedRevision: saved.admittedRevision, capturedAt: saved.capturedAt, pointId, pointSha256: observed.manifestSha256, cohortSha256: retained.sha256, stageSha256: stage.scopeSha256, parents, members };
          encoded = text(plan); if (Buffer.byteLength(encoded) > planBound) refuse('s16_ops_recovery_bounds'); const digest = hash(encoded), id = 'repair_plan_' + digest; pendingActionId = id;
          if (ownership) { if (ownership.id !== id || ownership.kind !== 'capture_backend' || ownership.priorSha256 !== retained.sha256 || ownership.targetSha256 !== digest) refuse('s16_ops_repair_plan_invalid'); }
          else { resumeSettled(); journal.recordIntent(requestId, read().control.revision, { id, kind: 'capture_backend', priorSha256: retained.sha256, targetSha256: digest }); after('plan_intent'); }
          stage.assertCurrent(); opsWrite(planPath, encoded);
        }
        // Validate every non-path field against fresh current pins before using the authenticated plan.
        const { members: planned, parents, ...header } = plan, expectedHeader = { contract: 's16-forward-payload-repair/v1', operationsId: original.control.id, installationId: config.installationId, ownerIdentity: context.ownerIdentity, operationId: saved.operationId, requestId, configurationSha256, admittedRevision: saved.admittedRevision, capturedAt: saved.capturedAt, pointId, pointSha256: observed.manifestSha256, cohortSha256: retained.sha256, stageSha256: stage.scopeSha256 };
        if (text(header) !== text(expectedHeader) || !Array.isArray(planned) || planned.length !== selected.length || !Array.isArray(parents) || parents.length > 2 || new Set(parents.map(row => row.domain)).size !== parents.length || planned.some((row, at) => { const { tempIdentity: _id, ...fields } = row; return text(fields) !== text(selected[at]); })) refuse('s16_ops_repair_plan_invalid');
        const digest = hash(encoded), ownId = 'repair_plan_' + digest;
        const planIdentity = s16PointEntryIdentity(s16PointEntry(planPath));
        const planCurrent = () => { guard(); stage.assertCurrent(); const request = read().request, action = request.actions.find(row => row.id === ownId); if (!action || action.kind !== 'capture_backend' || action.priorSha256 !== retained.sha256 || action.targetSha256 !== digest || action.state === 'not_applied' || s16PointEntryIdentity(s16PointEntry(planPath)) !== planIdentity) refuse('s16_ops_repair_plan_invalid');
          for (const parent of plan.parents) if (parent.created) { const original = request.actions.find(row => row.id === 'repair_parent_' + parent.domain + '_' + retained.sha256), expected = hash(text({ contract: 's16-repair-parent/v1', operationId: saved.operationId, cohortSha256: retained.sha256, domain: parent.domain, identity: parent.identity })); if (!original || original.kind !== 'capture_backend' || original.priorSha256 !== retained.sha256 || original.targetSha256 !== expected || original.state !== 'confirmed' || original.observedSha256 !== expected) refuse('s16_ops_repair_parent_changed'); }
        };
        planCurrent(); assertS16RepairPhysicalCustody(config, saved, plan, guard);
        let latest = read(), ownAction = latest.request.actions.find(row => row.id === ownId)!;
        if (ownAction.state !== 'confirmed') { if (plan.members.some(row => { const state = inspectS16RepairFile(s16RepairMemberPaths(config, plan, row)); return state.state !== 'temp' || state.temp!.size !== 0n; })) refuse('s16_ops_repair_plan_incomplete'); journal.observeAction(requestId, latest.control.revision, ownId, 'applied', digest); }
        after('plan');
        const fullBytes = () => { planCurrent(); for (const member of plan.members) { const file = s16RepairMemberPaths(config, plan, member), state = inspectS16RepairFile(file); if (state.temp) verifyS16RepairFile(file.temp, file, state.state === 'linked' ? [2n] : [1n]); if (state.target) verifyS16RepairFile(file.target, file, state.state === 'linked' ? [2n] : [1n]); } };
        const byteActionId = 'repair_bytes_' + digest;
        latest = read(); let byteAction = latest.request.actions.find(row => row.id === byteActionId);
        if (byteAction && (byteAction.kind !== 'capture_backend' || byteAction.priorSha256 !== digest || byteAction.targetSha256 !== digest || byteAction.state === 'not_applied')) refuse();
        if (latest.request.phase === 'capturing') {
          if (!byteAction) { resumeSettled(); journal.recordIntent(requestId, read().control.revision, { id: byteActionId, kind: 'capture_backend', priorSha256: digest, targetSha256: digest }); after('bytes_intent'); }
          pendingActionId = byteActionId;
          for (const [at, member] of plan.members.entries()) {
            planCurrent(); const file = s16RepairMemberPaths(config, plan, member);
            if (inspectS16RepairFile(file).state !== 'temp') refuse('s16_ops_repair_unexpected_publication');
            copyS16RepairPrefix(file, { path: s16PointMemberPath(s16PointDirectory(config.directory, pointId), pointId, 'payloads', member.sourceName), identity: member.sourceIdentity, bytes: member.bytes, sha256: member.sha256 }, guard, options.after ? () => after('copy_chunk', at) : undefined);
            after('copied', at);
          }
          planCurrent(); await observed.assertCurrent(); assertS16RepairPhysicalCustody(config, saved, plan, guard); fullBytes();
          journal.observeAction(requestId, read().control.revision, byteActionId, 'applied', digest); after('bytes');
          await verifyCurrent(saved, plan); resumeSettled(); journal.advance(requestId, read().control.revision, 'verifying', { cohortSha256: retained.sha256, targetSha256: digest }); after('verifying');
        } else if (!byteAction || byteAction.state !== 'confirmed' || byteAction.observedSha256 !== digest) refuse('s16_ops_repair_bytes_incomplete');
        fullBytes();
        latest = read();
        if (latest.request.cohortSha256 !== retained.sha256 || latest.request.targetSha256 !== digest) refuse('s16_ops_repair_plan_invalid');
        if (latest.request.phase === 'verifying') { await observed.assertCurrent(); await verifyCurrent(saved, plan); resumeSettled(); journal.advance(requestId, read().control.revision, 'prepared'); after('prepared'); }
        latest = read();
        if (latest.request.phase === 'prepared') { resumeSettled(); journal.advance(requestId, read().control.revision, 'activating'); after('activating'); }
        latest = read(); if (latest.request.phase !== 'activating') refuse();
        const publicationId = 'repair_publish_' + digest, prior = latest.request.actions.find(row => row.id === publicationId);
        if (prior && (prior.kind !== 'replace' || prior.priorSha256 !== retained.sha256 || prior.targetSha256 !== digest || prior.state === 'not_applied')) refuse();
        if (!prior) { resumeSettled(); journal.recordIntent(requestId, read().control.revision, { id: publicationId, kind: 'replace', priorSha256: retained.sha256, targetSha256: digest }); after('activation_intent'); }
        pendingActionId = publicationId;
        await observed.assertCurrent(); await verifyCurrent(saved, plan); fullBytes();
        currentSql(saved, () => {
          planCurrent(); assertS16RepairPhysicalCustody(config, saved, plan, guard);
          for (const [at, member] of plan.members.entries()) publishS16RepairFile(s16RepairMemberPaths(config, plan, member), guard, options.after ? boundary => after(boundary, at) : undefined);
          assertS16RepairPhysicalCustody(config, saved, plan, guard); planCurrent();
        });
        await observed.assertCurrent(); await verifyCurrent(saved, plan, true); after('revalidated');
        currentSql(saved, () => { planCurrent(); assertS16RepairPhysicalCustody(config, saved, plan, guard); journal.observeAction(requestId, read().control.revision, publicationId, 'applied', digest); }); after('publication_observed');
        // Close the exact original public resources before terminal admission clearance.
        await cohort?.close(); await native?.close(); await candidate.close(); releaseCut();
        resumeSettled(); journal.advance(requestId, read().control.revision, 'complete'); after('complete'); return result();
      } catch (error) {
        const failure = error instanceof AppError && error.code.startsWith('s16_ops_') ? error : new AppError('s16_ops_forward_repair_invalid', 409);
        try { const state = read(), action = state.request.actions.find(row => row.id === pendingActionId); if (state.request.hash === commandBinding && !['complete', 'discarded'].includes(state.request.status)) journal.block(requestId, state.control.revision, failure.code, action && !['confirmed', 'not_applied'].includes(action.state) ? action.id : undefined); } catch { /* Lost current guards cannot authorize metadata writes or discard original unknown resources. */ }
        throw failure;
      } finally { busy = false; }
    } });
}
