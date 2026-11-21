import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { HostRuntime, HostSessionReference, HostSessionSnapshot } from 'schway/host';
import { AppError } from '../../errors';
import { opsDirectory, opsRead, opsWrite } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import type { S15RuntimeConfig } from '../../s15/runtime-config';
import type { S16ControlMaintenance } from './control-maintenance';
import { assertS16ExclusiveInstallationLease, type S16InstallationLease } from './installation-lease';
import { openS16NativeRoot, s16NativeRootByteLimit, type S16NativeRootMaintenance } from './native-root';
import { verifyS16NativeQuarantine } from './native-quarantine';
import type { S16OperationsJournal } from './operations-journal';
import { inspectS16ExecutingPackage } from './package-custody';
import { s16PointEntry, s16PointEntryIdentity } from './point-files';
import { s16RecoveryLimits, s16RecoveryNames as names, s16RecoveryUsage as usage } from './recovery-usage';
import { assertS16RecoveryStageFor } from './recovery-staging';
import { assertS16SelectedStores } from './selected-stores';
import { verifyS16PayloadSources, type S16PayloadSource } from './payload-set';

const metadataBound = 4194304, nativeBound = 4294967296;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function refuse(code = 's16_ops_current_native_invalid'): never { throw new AppError(code, 409); }
function text(value: unknown): string { const out = JSON.stringify(value); if (Buffer.byteLength(out) > metadataBound) refuse('s16_ops_recovery_bounds'); return out; }
const directoryIdentity = (path: string) => s16PointEntryIdentity(s16PointEntry(path, true), true);
function readFile(path: string, maximum: number): Buffer {
  const before = s16PointEntry(path); if (before.size > BigInt(maximum)) refuse('s16_ops_recovery_bounds');
  const value = opsRead(path, maximum); if (value.length !== Number(before.size) || s16PointEntryIdentity(before) !== s16PointEntryIdentity(s16PointEntry(path))) refuse('s16_ops_image_changed'); return value;
}
interface RootPlan { id: string; root: string; home: string; sessions: string }
interface File { name: string; bytes: number; sha256: string; identity: string }
interface Envelope { inventory: { reference: HostSessionReference; state: string }[]; savedReferences: HostSessionReference[]; snapshot: HostSessionSnapshot | null }
/** Independently retained current public native cut only; it is not a complete current cohort or admission. */
export interface S16CurrentNativeObservation {
  readonly contract: 's16-current-native-custody/v1'; readonly sha256: string; readonly roots: number; readonly pending: number;
  readonly sources: readonly Readonly<S16PayloadSource>[];
  /** Repeats actual current public capture/deep verification against this original retained cut. */
  assertCurrent(): Promise<void>;
}
/** Original native resources survive unknown disposal under retained installation/CHAT exclusion. */
export interface S16CurrentNativeMaintenance {
  readonly released: boolean; readonly resourcesReleased: boolean;
  capture(): Promise<S16CurrentNativeObservation>; close(): Promise<void>;
}
/** Only actual protected current composition supplies paths, sources and the original restore journal. */
export interface S16CurrentNativeOwner { config: S15RuntimeConfig; requestId: string; lease: S16InstallationLease; context: S16ControlMaintenance; journal: S16OperationsJournal }
/** Fault observers cannot select roots, provenance, resources or replacement identities. */
export interface S16CurrentNativeOptions { after?(boundary: 'directories' | 'intent' | 'plan' | 'source' | 'native_restore' | 'native' | 'manifest_intent' | 'manifest' | 'observed', rootId?: string): void }
/** Captures and deeply verifies the complete current public native set without restoring or running live state. */
export function openS16CurrentNativeCustody(owner: S16CurrentNativeOwner, options: S16CurrentNativeOptions = {}): S16CurrentNativeMaintenance {
  const { config, requestId, context, journal } = owner; identity(requestId);
  let released = false, usable = true, busy = false;
  const roots = new Set<S16NativeRootMaintenance>(), hosts = new Set<HostRuntime>();
  const guard = () => { if (released || !usable) refuse('s16_ops_current_native_closed'); assertS16ExclusiveInstallationLease(owner.lease, config.directory); context.assertCurrent(); };
  const after = (boundary: Parameters<NonNullable<S16CurrentNativeOptions['after']>>[0], rootId?: string) => { guard(); if ((options.after?.(boundary, rootId) as unknown) !== undefined) refuse('s16_ops_guard_invalid'); guard(); };
  const read = () => {
    guard(); const control = journal.read(), request = control.requests.find(row => row.requestId === requestId);
    if (!request || request.kind !== 'restore' || !request.pointId || !['capturing', 'verifying', 'prepared', 'activating'].includes(request.phase) || ['complete', 'discarded'].includes(request.status) || request.configurationSha256 !== hash(canonical(config))) refuse();
    return { control, request };
  };
  const releaseHost = async (host: HostRuntime) => { try { await host.close(); hosts.delete(host); } catch { usable = false; refuse('s16_ops_source_release_unknown'); } };
  const releaseRoot = async (root: S16NativeRootMaintenance) => { try { await root.close(); roots.delete(root); } catch { usable = false; refuse('s16_ops_source_release_unknown'); } };
  let session: S16CurrentNativeMaintenance;
  session = Object.freeze<S16CurrentNativeMaintenance>({ get released() { return released; }, get resourcesReleased() { return !busy && !roots.size && !hosts.size; },
    async close() { if (released) return; usable = false; if (busy) refuse('s16_ops_current_native_busy'); for (const host of hosts) await releaseHost(host); for (const root of roots) await releaseRoot(root); released = true; },
    async capture() {
      guard(); if (busy) refuse('s16_ops_current_native_busy'); busy = true; let pendingActionId: string | undefined;
      try {
        const initial = read(); assertS16SelectedStores(config, context.runtime.sources);
        const binary = inspectS16ExecutingPackage(context.sources), namespace = context.nativeNamespace(); namespace.assertCurrent();
        if (namespace.untracked.length || namespace.roots.some(root => !root.available) || namespace.pending.some(row => !['correlation_missing', 'github_discovery_required', 'github_attempt_unsettled', 'github_work_unsettled'].includes(row.reason) || row.kind === 'chat' && row.phase === null)) refuse('s16_ops_native_reconciliation_required');
        const namespaceIdentity = () => { const current = context.nativeNamespace(); return hash(text({ roots: current.roots, pending: current.pending, untracked: current.untracked })); }, namespaceSha256 = namespaceIdentity();
        const stage = context.recoveryStage(requestId); assertS16RecoveryStageFor(stage, requestId, initial.request.id);
        const root = join(stage.path('payloads'), 'current-native'), data = join(root, 'data'), scratch = join(root, 'scratch'), planPath = join(root, 'plan.json'), manifestPath = join(data, 'manifest.json'), globalStage = dirname(stage.root);
        const scope = { contract: 's16-current-native-plan/v1', operationsId: initial.control.id, installationId: config.installationId, ownerIdentity: context.ownerIdentity, operationId: initial.request.id, requestId,
          configurationSha256: initial.request.configurationSha256, admittedRevision: initial.request.admittedRevision, capturedAt: initial.request.createdAt, stageSha256: stage.scopeSha256, namespaceSha256, package: binary };
        const existing = initial.request.actions.filter(row => row.id.startsWith('current_native_scope_')); if (existing.length > 1 || existing[0]?.state === 'not_applied') refuse();
        const savedAction = existing[0], prepared = initial.request.phase !== 'capturing'; pendingActionId = savedAction?.id;
        if (!savedAction && (prepared || lstatSync(planPath, { throwIfNoEntry: false }))) refuse('s16_ops_current_native_plan_missing');
        let planText: string;
        if (savedAction && lstatSync(planPath, { throwIfNoEntry: false })) {
          planText = new TextDecoder('utf-8', { fatal: true }).decode(readFile(planPath, metadataBound)); if (hash(planText) !== savedAction.targetSha256) refuse('s16_ops_current_native_plan_invalid');
        } else {
          if (prepared) refuse('s16_ops_current_native_plan_missing');
          const occupied = usage(globalStage); if (occupied.nodes + namespace.roots.length * 3 + 4 > s16RecoveryLimits.nodes) refuse('s16_ops_recovery_bounds');
          if (savedAction) { for (const path of [root, data, scratch, ...namespace.roots.flatMap(({ id }) => [join(scratch, id), join(scratch, id, 'home'), join(scratch, id, 'sessions')])]) s16PointEntry(path, true); }
          opsDirectory(root); if (names(root, 3).some(name => !['data', 'scratch'].includes(name))) refuse();
          opsDirectory(data); opsDirectory(scratch); if (names(data, 1).length) refuse('s16_ops_current_native_plan_missing');
          const ids = new Set(namespace.roots.map(row => row.id)); if (names(scratch, 20000).some(id => !ids.has(id))) refuse();
          for (const { id } of namespace.roots) { const path = join(scratch, id); opsDirectory(path); if (names(path, 3).some(name => !['home', 'sessions'].includes(name))) refuse(); for (const part of ['home', 'sessions']) { opsDirectory(join(path, part)); if (names(join(path, part), 1).length) refuse('s16_ops_current_native_plan_missing'); } }
          planText = text({ ...scope, root: directoryIdentity(root), data: directoryIdentity(data), scratch: directoryIdentity(scratch), roots: namespace.roots.map(({ id }) => ({ id, root: directoryIdentity(join(scratch, id)), home: directoryIdentity(join(scratch, id, 'home')), sessions: directoryIdentity(join(scratch, id, 'sessions')) })) });
          after('directories'); const id = 'current_native_scope_' + hash(planText); pendingActionId = id;
          if (savedAction) { if (savedAction.id !== id || savedAction.kind !== 'capture_backend' || savedAction.priorSha256 !== hash(text(scope)) || savedAction.targetSha256 !== hash(planText)) refuse('s16_ops_current_native_plan_invalid'); }
          else { let state = read(); if (state.request.status !== 'running' && state.request.actions.every(row => ['confirmed', 'not_applied'].includes(row.state))) { journal.resume(requestId, state.control.revision); state = read(); } journal.recordIntent(requestId, state.control.revision, { id, kind: 'capture_backend', priorSha256: hash(text(scope)), targetSha256: hash(planText) }); after('intent'); }
          stage.assertCurrent(); opsWrite(planPath, planText);
        }
        const plan = JSON.parse(planText) as typeof scope & { root: string; data: string; scratch: string; roots: RootPlan[] }, { root: rootIdentity, data: dataIdentity, scratch: scratchIdentity, roots: savedRoots, ...savedScope } = plan;
        const scopeActionId = 'current_native_scope_' + hash(planText);
        if (text(savedScope) !== text(scope) || !Array.isArray(savedRoots) || savedRoots.length !== namespace.roots.length || savedRoots.some((row, at) => row.id !== namespace.roots[at]!.id || Object.keys(row).sort().join(',') !== 'home,id,root,sessions')) refuse('s16_ops_current_native_plan_invalid');
        const stageCurrent = () => {
          guard(); stage.assertCurrent(); namespace.assertCurrent(); const action = read().request.actions.find(row => row.id === scopeActionId);
          if (!action || action.kind !== 'capture_backend' || action.priorSha256 !== hash(text(scope)) || action.targetSha256 !== hash(planText) || action.state === 'not_applied' || hash(readFile(planPath, metadataBound)) !== hash(planText) || directoryIdentity(root) !== rootIdentity || directoryIdentity(data) !== dataIdentity || directoryIdentity(scratch) !== scratchIdentity) refuse('s16_ops_current_native_plan_invalid');
          if (names(root, 3).join(',') !== 'data,plan.json,scratch' || names(scratch, 20000).join(',') !== savedRoots.map(row => row.id).sort().join(',')) refuse();
          for (const row of savedRoots) if (directoryIdentity(join(scratch, row.id)) !== row.root || directoryIdentity(join(scratch, row.id, 'home')) !== row.home || directoryIdentity(join(scratch, row.id, 'sessions')) !== row.sessions || names(join(scratch, row.id), 3).join(',') !== 'home,sessions') refuse('s16_ops_current_native_plan_invalid');
        }; stageCurrent();
        let state = read(); journal.observeAction(requestId, state.control.revision, scopeActionId, 'applied', hash(planText)); after('plan');
        const expectedNames = new Set(namespace.roots.map(row => row.id + '.json')); expectedNames.add('manifest.json'); if (names(data, 20001).some(name => !expectedNames.has(name))) refuse();
        const finalActions = read().request.actions.filter(row => row.id.startsWith('current_native_capture_')); if (finalActions.length > 1 || finalActions[0]?.state === 'not_applied') refuse();
        const savedFinal = finalActions[0], published = !!lstatSync(manifestPath, { throwIfNoEntry: false });
        if (prepared && (!published || savedFinal?.state !== 'confirmed') || savedFinal?.state === 'confirmed' && !published) refuse('s16_ops_current_native_incomplete');
        if (published && (!savedFinal || hash(readFile(manifestPath, metadataBound)) !== savedFinal.targetSha256)) refuse('s16_ops_current_native_changed');
        const files: File[] = []; let total = 0;
        for (const selected of namespace.roots) {
          const path = join(data, selected.id + '.json'), sourceGuard = namespace.rootGuard(selected.id), cap = await openS16NativeRoot({ directory: selected.directory, installationId: config.installationId, id: selected.id, references: selected.references,
            custody: { kind: selected.kind, ownerId: selected.ownerId, phase: selected.phase, vm: selected.vm }, now: () => initial.request.createdAt,
            guard() { stageCurrent(); sourceGuard(); }, retain(capability) { roots.add(capability); } });
          try {
            const fresh = await cap.capture(), present = !!lstatSync(path, { throwIfNoEntry: false }); if (!present && (prepared || published || savedFinal)) refuse('s16_ops_current_native_incomplete');
            const bytes = present ? readFile(path, s16NativeRootByteLimit) : fresh.bytes, digest = hash(bytes); cap.verify(bytes, digest);
            const envelope = JSON.parse(Buffer.from(bytes).toString('utf8')) as Envelope, freshValue = JSON.parse(Buffer.from(fresh.bytes).toString('utf8')) as Envelope;
            // Comparison views only; the original snapshot passed to public restore is never rewritten.
            const view = (value: Envelope) => { const parsed = JSON.parse(JSON.stringify(value)); if (parsed.snapshot) delete parsed.snapshot.createdAt; return JSON.stringify(parsed); };
            if (view(envelope) !== view(freshValue)) refuse('s16_ops_native_changed');
            if (selected.nativeRequired && !envelope.inventory.length || canonical(envelope.savedReferences) !== canonical(selected.references)) refuse('s16_ops_native_reconciliation_required');
            const occupied = usage(globalStage), allowance = envelope.snapshot?.sessions.reduce((n, session) => n + session.artifacts.reduce((sum, artifact) => sum + artifact.size, 0) + 65536, 0) ?? 0;
            if ((total += bytes.byteLength) + Buffer.byteLength(planText) + metadataBound > nativeBound || occupied.bytes + (present ? 0 : bytes.byteLength) + allowance + metadataBound > s16RecoveryLimits.bytes || occupied.nodes + (envelope.snapshot?.sessions.length ?? 0) * 16 + 33 > s16RecoveryLimits.nodes) refuse('s16_ops_recovery_bounds');
            if (!present) { opsWrite(path, bytes); after('source', selected.id); }
            if (envelope.snapshot) await verifyS16NativeQuarantine({ workspaceRoot: join(selected.directory, 'workspace'), homeDirectory: join(scratch, selected.id, 'home'), sessionDirectory: join(scratch, selected.id, 'sessions'), snapshot: envelope.snapshot,
              guard: stageCurrent, retain(host) { hosts.add(host); }, release: releaseHost, beforeRestore() { after('native_restore', selected.id); } });
            usage(globalStage); files.push({ name: selected.id + '.json', bytes: bytes.byteLength, sha256: digest, identity: s16PointEntryIdentity(s16PointEntry(path)) });
          } finally { await releaseRoot(cap); }
          after('native', selected.id);
        }
        stageCurrent(); if (namespaceIdentity() !== namespaceSha256 || text(inspectS16ExecutingPackage(context.sources)) !== text(binary)) refuse('s16_ops_current_native_changed');
        const manifest = text({ contract: 's16-current-native-custody/v1', operationId: initial.request.id, requestId, capturedAt: initial.request.createdAt, planSha256: hash(planText), planIdentity: s16PointEntryIdentity(s16PointEntry(planPath)), namespaceSha256, bytes: total, files }), digest = hash(manifest), actionId = 'current_native_capture_' + digest;
        pendingActionId = actionId;
        if (savedFinal && (savedFinal.id !== actionId || savedFinal.kind !== 'capture_native' || savedFinal.priorSha256 !== hash(planText) || savedFinal.targetSha256 !== digest)) refuse('s16_ops_current_native_changed');
        if (!savedFinal) { state = read(); if (state.request.status !== 'running' && state.request.actions.every(row => ['confirmed', 'not_applied'].includes(row.state))) { journal.resume(requestId, state.control.revision); state = read(); } journal.recordIntent(requestId, state.control.revision, { id: actionId, kind: 'capture_native', priorSha256: hash(planText), targetSha256: digest }); after('manifest_intent'); }
        if (published) { if (readFile(manifestPath, metadataBound).toString('utf8') !== manifest) refuse('s16_ops_current_native_changed'); }
        else { opsWrite(manifestPath, manifest); after('manifest'); }
        const sources = Object.freeze([{ name: 'current_native_plan.json', path: planPath, bytes: Buffer.byteLength(planText), sha256: hash(planText) }, { name: 'current_native_manifest.json', path: manifestPath, bytes: Buffer.byteLength(manifest), sha256: digest }, ...files.map(({ name, bytes, sha256 }) => ({ name, bytes, sha256, path: join(data, name) }))].map(row => Object.freeze(row)));
        verifyS16PayloadSources(sources, stageCurrent); stageCurrent(); state = read(); journal.observeAction(requestId, state.control.revision, actionId, 'applied', digest); after('observed');
        return Object.freeze({ contract: 's16-current-native-custody/v1' as const, sha256: digest, roots: files.length, pending: namespace.pending.length, sources, async assertCurrent() { guard(); const latest = await session.capture(); if (latest.sha256 !== digest) refuse('s16_ops_current_native_changed'); } });
      } catch (error) {
        const failure = error instanceof AppError && error.code.startsWith('s16_ops_') ? error : new AppError('s16_ops_current_native_invalid', 409);
        try { const state = read(), action = state.request.actions.find(row => row.id === pendingActionId); journal.block(requestId, state.control.revision, failure.code, action && !['confirmed', 'not_applied'].includes(action.state) ? action.id : undefined); } catch { /* Lost original guards cannot authorize another write. */ }
        throw failure;
      } finally { busy = false; }
    } });
  guard(); return session;
}
