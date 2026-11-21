import { createHash } from 'node:crypto';
import { lstatSync, opendirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHost, MAX_SNAPSHOT_SESSIONS, RELEASE_CONTRACT, type HostRuntime, type HostSessionReference, type HostSessionSnapshot } from 'schway/host';
import { AppError } from '../../errors';
import { opsDirectory, opsRead, opsWrite } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import type { S15RuntimeConfig } from '../../s15/runtime-config';
import type { S16ControlMaintenance } from './control-maintenance';
import { assertS16ExclusiveInstallationLease, type S16InstallationLease } from './installation-lease';
import { openS16NativeRoot, s16NativeRootByteLimit, type S16NativeRootMaintenance } from './native-root';
import type { S16NativeBinding } from './native-namespace';
import type { S16OperationsJournal } from './operations-journal';
import { inspectS16ExecutingPackage } from './package-custody';
import { inspectS16PointFiles, s16PointDirectory, s16PointEntry, s16PointEntryIdentity, s16PointMemberPath, type S16PointExpectation, type S16PointInventory } from './point-files';
import { assertS16RecoveryStageFor } from './recovery-staging';
import { s16RuntimeReaders } from './runtime-readers';
import { verifyS16LedgerSet } from './verify-ledger-set';
import { verifyS16PayloadSources, type S16PayloadSource } from './payload-set';

const metadataBound = 4194304, storageBound = 12884901888, nodeBound = 250000;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function refuse(code = 's16_ops_candidate_invalid'): never { throw new AppError(code, 409); }
function text(value: unknown): string { const result = JSON.stringify(value); if (Buffer.byteLength(result) > metadataBound) refuse('s16_ops_recovery_bounds'); return result; }
function names(path: string, limit: number): string[] {
  const result: string[] = [], directory = opendirSync(path);
  try { for (;;) { const next = directory.readSync(); if (!next) break; if (result.length >= limit) refuse('s16_ops_recovery_bounds'); result.push(next.name); } }
  finally { directory.closeSync(); } return result.sort();
}
function usage(root: string): { bytes: number; nodes: number } {
  let bytes = 0, nodes = 0;
  const visit = (path: string, depth: number) => {
    if (++nodes > nodeBound || depth > 32) refuse('s16_ops_recovery_bounds'); const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) { s16PointEntry(path, true); for (const name of names(path, nodeBound - nodes)) visit(join(path, name), depth + 1); }
    else { const file = s16PointEntry(path); if (file.size > 1073741824n || (bytes += Number(file.size)) > storageBound) refuse('s16_ops_recovery_bounds'); }
  }; visit(root, 0); return { bytes, nodes };
}
interface RootPlan { id: string; sourceSha256: string; root: string; home: string; sessions: string }
/** Authenticated historical custody only; no historical row/native context is activated in the installation. */
export interface S16CandidateObservation {
  readonly contract: 's16-verified-candidate/v1'; readonly pointId: string; readonly manifestSha256: string;
  readonly inventory: Readonly<S16PointInventory>; readonly nativeRoots: number;
  /** Host-only immutable source selected from the complete authenticated fixed inventory. */
  payload(name: string): Readonly<S16PayloadSource> | undefined;
  assertCurrent(): void;
}
/** Owns public native disposal across verification failures; a response/timeout never releases unknown resources. */
export interface S16CandidateMaintenance {
  readonly released: boolean; readonly resourcesReleased: boolean;
  verify(): Promise<S16CandidateObservation>;
  close(): Promise<void>;
}
/** Current composition supplies every authority/path/resource binding; only the original restore chooses a point ID. */
export interface S16CandidateOwner {
  config: S15RuntimeConfig; requestId: string; lease: S16InstallationLease; context: S16ControlMaintenance; journal: S16OperationsJournal;
}
/** Observes original verification boundaries only; no path, expected hash or execution authority is supplied. */
export interface S16CandidateOptions { after?(boundary: 'authenticated' | 'directories' | 'intent' | 'plan' | 'native_restore' | 'native' | 'observed', rootId?: string): void }
/**
 * Authenticates the complete receipted point, supported SQL readers and actual public native ancestry
 * in original private quarantine. Live SQL/native/helper/disk state is never restored or booted.
 */
export function openS16CandidateQuarantine(owner: S16CandidateOwner, options: S16CandidateOptions = {}): S16CandidateMaintenance {
  const { config, requestId, context, journal } = owner; identity(requestId);
  let released = false, usable = true, busy = false;
  const roots = new Set<S16NativeRootMaintenance>(), hosts = new Set<HostRuntime>();
  const guard = () => { if (released || !usable) refuse('s16_ops_candidate_closed'); assertS16ExclusiveInstallationLease(owner.lease, config.directory); context.assertCurrent(); };
  const after = (boundary: Parameters<NonNullable<S16CandidateOptions['after']>>[0], rootId?: string) => { guard(); if ((options.after?.(boundary, rootId) as unknown) !== undefined) refuse('s16_ops_guard_invalid'); guard(); };
  const read = () => {
    guard(); const control = journal.read(), request = control.requests.find(row => row.requestId === requestId);
    if (!request || request.kind !== 'restore' || !request.pointId || !['capturing', 'verifying', 'prepared', 'activating'].includes(request.phase) || ['complete', 'discarded'].includes(request.status) || request.configurationSha256 !== hash(canonical(config))) refuse();
    const point = control.points.find(row => row.id === request.pointId && row.state === 'retained'), backup = point && control.requests.find(row => row.id === point.operationId);
    if (!point || !backup || backup.kind !== 'backup' || backup.status !== 'complete' || backup.phase !== 'complete' || backup.pointId !== point.id || backup.targetSha256 !== point.sha256 || !backup.configurationSha256 || !backup.cohortSha256) refuse('s16_ops_point_unavailable');
    const expected: S16PointExpectation = { id: point.id, installationId: config.installationId, ownerIdentity: context.ownerIdentity, operationId: backup.id, requestId: backup.requestId,
      configurationSha256: backup.configurationSha256, cohortSha256: backup.cohortSha256, manifestSha256: point.sha256, bytes: point.bytes, capturedAt: backup.createdAt };
    return { control, request, point, expected };
  };
  const releaseHost = async (host: HostRuntime) => { try { await host.close(); hosts.delete(host); } catch { usable = false; refuse('s16_ops_source_release_unknown'); } };
  const releaseRoot = async (root: S16NativeRootMaintenance) => { try { await root.close(); roots.delete(root); } catch { usable = false; refuse('s16_ops_source_release_unknown'); } };
  guard();
  return Object.freeze<S16CandidateMaintenance>({ get released() { return released; }, get resourcesReleased() { return !busy && !roots.size && !hosts.size; },
    async close() {
      if (released) return; usable = false; if (busy) refuse('s16_ops_candidate_busy');
      for (const host of hosts) await releaseHost(host); for (const root of roots) await releaseRoot(root); released = true;
    }, async verify() {
      guard(); if (busy) refuse('s16_ops_candidate_busy'); busy = true;
      let pendingActionId: string | undefined;
      try {
        const initial = read(), binary = inspectS16ExecutingPackage(context.sources), pointRoot = s16PointDirectory(config.directory, initial.point.id);
        const inventory = inspectS16PointFiles(pointRoot, initial.expected, guard);
        if (inventory.catalogs !== 'present' || inventory.manifest.package.engineContract !== RELEASE_CONTRACT) refuse('s16_ops_candidate_incomplete');
        const readers = inventory.manifest.configuration.sources.map(name => {
          const reader = context.sources.find(source => source.name === name)?.reader ?? (Object.hasOwn(s16RuntimeReaders, name) ? s16RuntimeReaders[name] : undefined);
          if (!reader) refuse('s16_ops_reader_unsupported'); return { name, reader };
        });
        verifyS16LedgerSet({ directory: join(pointRoot, 'ledgers'), installationId: config.installationId, id: initial.point.id, readers, manifestSha256: inventory.manifest.components.find(row => row.role === 'ledgers')!.sha256 });
        after('authenticated');
        const members = new Map(inventory.files.filter(row => row.scope === 'payloads').map(row => [row.name, row]));
        const source = (name: string): S16PayloadSource => {
          const file = members.get(name); if (!file) return refuse('s16_ops_candidate_incomplete');
          return { name, path: s16PointMemberPath(pointRoot, initial.point.id, 'payloads', name), bytes: file.bytes, sha256: file.sha256 };
        };
        const bytes = (name: string, bound: number) => {
          const selected = source(name); if (selected.bytes > bound) refuse('s16_ops_recovery_bounds'); verifyS16PayloadSources([selected], guard);
          const value = opsRead(selected.path, bound); if (value.length !== selected.bytes || hash(value) !== selected.sha256) refuse('s16_ops_point_changed'); return value;
        };
        const nativePlan = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes('native_plan.json', metadataBound))) as { roots: Omit<S16NativeBinding, 'directory' | 'available'>[] };
        const namespace = context.nativeNamespace(), nativeIdentity = (value = context.nativeNamespace()) => hash(text({ roots: value.roots, pending: value.pending, untracked: value.untracked }));
        const namespaceSha256 = nativeIdentity(namespace), currentRoots = new Map(namespace.roots.map(root => [root.id, root]));
        if (!Array.isArray(nativePlan.roots) || nativePlan.roots.length > 20000 || nativePlan.roots.some(root => !currentRoots.get(root.id)?.available || root.kind !== currentRoots.get(root.id)!.kind || root.ownerId !== currentRoots.get(root.id)!.ownerId || root.phase !== currentRoots.get(root.id)!.phase)) refuse('s16_ops_native_continuity_required');
        const stage = context.recoveryStage(requestId); assertS16RecoveryStageFor(stage, requestId, initial.request.id);
        const quarantine = stage.path('quarantine'), planPath = join(stage.root, 'candidate.json'), globalStage = dirname(stage.root);
        const directoryIdentity = (path: string) => s16PointEntryIdentity(s16PointEntry(path, true), true);
        const existingActions = initial.request.actions.filter(row => row.id.startsWith('candidate_quarantine_'));
        if (existingActions.length > 1) refuse();
        const existing = existingActions[0]; if (existing?.state === 'not_applied') refuse('s16_ops_candidate_distinct_attempt_required');
        pendingActionId = existing?.id;
        if (!existing && (initial.request.phase !== 'capturing' || lstatSync(planPath, { throwIfNoEntry: false }))) refuse();
        if (['prepared', 'activating'].includes(initial.request.phase) && (!existing || existing.state !== 'confirmed' || !lstatSync(planPath, { throwIfNoEntry: false }))) refuse('s16_ops_candidate_plan_missing');
        const ids = new Set(nativePlan.roots.map(root => root.id));
        if (names(quarantine, 20000).some(id => !ids.has(id))) refuse();
        let planText: string;
        if (existing && lstatSync(planPath, { throwIfNoEntry: false })) {
          const stat = s16PointEntry(planPath); if (stat.size > metadataBound) refuse('s16_ops_recovery_bounds');
          const data = opsRead(planPath, metadataBound); if (hash(data) !== existing.targetSha256) refuse('s16_ops_candidate_plan_invalid'); planText = new TextDecoder('utf-8', { fatal: true }).decode(data);
        } else {
          const occupied = usage(globalStage); if (occupied.nodes + nativePlan.roots.length * 3 + 2 > nodeBound) refuse('s16_ops_recovery_bounds');
          for (const { id } of nativePlan.roots) {
            const root = join(quarantine, id); opsDirectory(root);
            if (names(root, 3).some(name => !['home', 'sessions'].includes(name))) refuse();
            for (const part of ['home', 'sessions']) { opsDirectory(join(root, part)); if (names(join(root, part), 1).length) refuse('s16_ops_candidate_plan_missing'); }
          }
          const rootPlans: RootPlan[] = nativePlan.roots.map(({ id }) => ({ id, sourceSha256: source('native_' + id + '.json').sha256, root: directoryIdentity(join(quarantine, id)), home: directoryIdentity(join(quarantine, id, 'home')), sessions: directoryIdentity(join(quarantine, id, 'sessions')) }));
          planText = text({ contract: 's16-candidate-quarantine/v1', operationsId: initial.control.id, installationId: config.installationId, ownerIdentity: context.ownerIdentity, operationId: initial.request.id, requestId,
            configurationSha256: initial.request.configurationSha256, pointId: initial.point.id, pointSha256: initial.point.sha256, stageSha256: stage.scopeSha256, currentNativeNamespaceSha256: namespaceSha256, roots: rootPlans });
          after('directories');
          const actionId = 'candidate_quarantine_' + hash(planText);
          pendingActionId = actionId;
          if (existing) { if (existing.id !== actionId || existing.priorSha256 !== initial.point.sha256 || existing.targetSha256 !== hash(planText)) refuse('s16_ops_candidate_plan_invalid'); }
          else {
            let state = read();
            if (state.request.status !== 'running' && state.request.actions.every(action => ['confirmed', 'not_applied'].includes(action.state))) { journal.resume(requestId, state.control.revision); state = read(); }
            journal.recordIntent(requestId, state.control.revision, { id: actionId, kind: 'capture_native', priorSha256: initial.point.sha256, targetSha256: hash(planText) });
            after('intent');
          }
          stage.assertCurrent(); opsWrite(planPath, planText);
        }
        const plan = JSON.parse(planText) as { roots: RootPlan[]; [key: string]: unknown }, { roots: savedRoots, ...header } = plan;
        const expectedHeader = { contract: 's16-candidate-quarantine/v1', operationsId: initial.control.id, installationId: config.installationId, ownerIdentity: context.ownerIdentity, operationId: initial.request.id, requestId,
          configurationSha256: initial.request.configurationSha256, pointId: initial.point.id, pointSha256: initial.point.sha256, stageSha256: stage.scopeSha256, currentNativeNamespaceSha256: namespaceSha256 };
        if (text(header) !== text(expectedHeader) || !Array.isArray(savedRoots) || savedRoots.length !== nativePlan.roots.length || savedRoots.some((root, at) => root.id !== nativePlan.roots[at]!.id || Object.keys(root).sort().join(',') !== 'home,id,root,sessions,sourceSha256')) refuse('s16_ops_candidate_plan_invalid');
        const actionId = 'candidate_quarantine_' + hash(planText);
        const stageCurrent = () => {
          guard(); stage.assertCurrent(); namespace.assertCurrent();
          const action = read().request.actions.find(row => row.id === actionId);
          if (!action || action.kind !== 'capture_native' || action.priorSha256 !== initial.point.sha256 || action.targetSha256 !== hash(planText) || action.state === 'not_applied' || hash(opsRead(planPath, metadataBound)) !== hash(planText)) refuse('s16_ops_candidate_plan_invalid');
          for (const root of savedRoots) if (root.sourceSha256 !== source('native_' + root.id + '.json').sha256 || root.root !== directoryIdentity(join(quarantine, root.id)) || root.home !== directoryIdentity(join(quarantine, root.id, 'home')) || root.sessions !== directoryIdentity(join(quarantine, root.id, 'sessions'))) refuse('s16_ops_candidate_plan_invalid');
        }; stageCurrent(); after('plan');
        for (const selected of nativePlan.roots) {
          const current = currentRoots.get(selected.id)!;
          const data = bytes('native_' + selected.id + '.json', s16NativeRootByteLimit), envelope = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data)) as { contract: string; snapshot: HostSessionSnapshot | null; savedReferences?: HostSessionReference[]; references: HostSessionReference[] };
          const cap = await openS16NativeRoot({ directory: current.directory, installationId: config.installationId, id: current.id, references: selected.references,
            ...(envelope.contract === 's16-native-root/v2' ? { custody: { kind: current.kind, ownerId: current.ownerId, phase: current.phase, vm: current.vm } } : {}), guard: stageCurrent, retain(capability) { roots.add(capability); } });
          try {
            cap.verify(data, source('native_' + selected.id + '.json').sha256); const snapshot = envelope.snapshot;
            const saved = envelope.contract === 's16-native-root/v2' ? envelope.savedReferences! : envelope.references;
            if (canonical([...saved].sort((a, b) => a.id.localeCompare(b.id))) !== canonical([...selected.references].sort((a, b) => a.id.localeCompare(b.id)))) refuse('s16_ops_native_correlation_invalid');
            if (!snapshot) continue;
            const occupied = usage(globalStage), allowance = snapshot.sessions.reduce((n, session) => n + session.artifacts.reduce((size, artifact) => size + artifact.size, 0) + 65536, 0);
            if (occupied.bytes + allowance > storageBound || occupied.nodes + snapshot.sessions.length * 16 + 32 > nodeBound) refuse('s16_ops_recovery_bounds');
            const root = join(quarantine, selected.id), host = await createHost({ workspaceRoot: join(current.directory, 'workspace'), homeDirectory: join(root, 'home'), sessionDirectory: join(root, 'sessions'),
              context: { policy: 'strict', systemPrompt: 'Protected historical candidate quarantine only.', sections: [] }, tools: { policy: 'exact', definitions: [], hostedLookup: 'off' }, limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 1, contextWindow: 32768, maxInputChars: 1024, deadlineMs: 1000 } }); hosts.add(host);
            try {
              stageCurrent(); after('native_restore', selected.id); stageCurrent(); const result = await host.restoreSessionSnapshot(snapshot, { excludeRetired: false }); stageCurrent();
              if (result.status !== 'restored' || canonical([...result.sessions].sort((a, b) => a.id.localeCompare(b.id))) !== canonical(snapshot.sessions.map(session => ({ id: session.id, branchId: session.branchId })).sort((a, b) => a.id.localeCompare(b.id)))) refuse('s16_ops_native_quarantined');
              const actual = await host.listSessions({ limit: MAX_SNAPSHOT_SESSIONS }); stageCurrent();
              if (actual.next !== undefined || actual.sessions.length !== snapshot.sessions.length || actual.sessions.some(row => !snapshot.sessions.some(session => session.id === row.reference.id && row.state === (session.retired ? 'retired' : 'active')))) refuse('s16_ops_native_quarantined');
            } finally { await releaseHost(host); }
            usage(globalStage);
          } finally { await releaseRoot(cap); }
          after('native', selected.id);
        }
        stageCurrent(); if (nativeIdentity() !== namespaceSha256 || text(inspectS16ExecutingPackage(context.sources)) !== text(binary)) refuse('s16_ops_candidate_changed');
        const current = read(); journal.observeAction(requestId, current.control.revision, actionId, 'applied', hash(planText));
        after('observed');
        const assertCurrent = () => {
          stageCurrent(); const state = read(); if (text(state.expected) !== text(initial.expected) || text(inspectS16PointFiles(pointRoot, state.expected, guard)) !== text(inventory) || nativeIdentity() !== namespaceSha256 || text(inspectS16ExecutingPackage(context.sources)) !== text(binary)) refuse('s16_ops_candidate_changed');
        }; assertCurrent();
        return Object.freeze<S16CandidateObservation>({ contract: 's16-verified-candidate/v1', pointId: initial.point.id, manifestSha256: initial.point.sha256, inventory, nativeRoots: nativePlan.roots.length,
          assertCurrent, payload(name) {
            guard(); stage.assertCurrent(); if (text(read().expected) !== text(initial.expected)) refuse('s16_ops_candidate_changed');
            const member = members.get(name); if (!member) return undefined; const selected = source(name);
            if (s16PointEntryIdentity(s16PointEntry(selected.path)) !== member.identity) refuse('s16_ops_point_changed');
            return Object.freeze(selected);
          } });
      } catch (error) {
        const failure = error instanceof AppError && error.code.startsWith('s16_ops_') ? error : new AppError('s16_ops_candidate_invalid', 409);
        try {
          const control = journal.read(), request = control.requests.find(row => row.requestId === requestId), action = request?.actions.find(row => row.id === pendingActionId);
          if (request && !['complete', 'discarded'].includes(request.status)) journal.block(requestId, control.revision, failure.code, action && !['confirmed', 'not_applied'].includes(action.state) ? action.id : undefined);
        } catch { /* A lost current guard cannot authorize another metadata write; the original fence remains. */ }
        throw failure;
      } finally { busy = false; }
    } });
}
