import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { AppError } from '../../errors';
import { opsDirectory, opsRead, opsWrite } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import type { S15RuntimeConfig } from '../../s15/runtime-config';
import type { S16CurrentFileCustody } from '../files/custody';
import type { S16CurrentGithubCustody } from '../../s15/github/maintenance';
import type { S16ByteCustodyIdentity } from './byte-custody-identity';
import type { S16ControlMaintenance } from './control-maintenance';
import type { S16CurrentNativeMaintenance, S16CurrentNativeObservation } from './current-native-custody';
import type { S16ExternalCustody } from './external-custody';
import type { S16HelperCohort, S16HelperCohortOptions } from './helper-cohort';
import { assertS16ExclusiveInstallationLease, type S16InstallationLease } from './installation-lease';
import type { S16LedgerSet } from './ledger-set';
import { openS16LedgerWriteCut, type S16LedgerWriteCut } from './ledger-write-cut';
import type { S16OperationsJournal } from './operations-journal';
import { inspectS16ExecutingPackage } from './package-custody';
import { s16PointEntry, s16PointEntryIdentity, type S16PointPackage } from './point-files';
import { s16RecoveryLimits, s16RecoveryNames as names, s16RecoveryUsage as usage } from './recovery-usage';
import { assertS16RecoveryStageFor } from './recovery-staging';
import { assertS16SelectedStores } from './selected-stores';
import { verifyS16LedgerSet, s16LedgerSetManifestHash } from './verify-ledger-set';
import { verifyS16PayloadSources } from './payload-set';

const metadataBound = 67108864;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function refuse(code = 's16_ops_current_cohort_invalid'): never { throw new AppError(code, 409); }
function text(value: unknown): string { const out = JSON.stringify(value); if (Buffer.byteLength(out) > metadataBound) refuse('s16_ops_current_cohort_bounds'); return out; }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const part of Object.values(value)) freeze(part); Object.freeze(value); } return value; }
/** Protected current continuity only. This value contains host identities and is never an ordinary export/client DTO. */
export interface S16ForwardCurrentCohort {
  contract: 's16-forward-current-cohort/v1'; operationsId: string; installationId: string; ownerIdentity: string; operationId: string; requestId: string;
  configurationSha256: string; admittedRevision: number; capturedAt: number; stageSha256: string; package: S16PointPackage;
  sql: { directoryIdentity: string; sources: readonly Readonly<{ name: string; identity: string }>[]; manifestSha256: string; manifest: Readonly<S16LedgerSet> };
  file: { value: Readonly<S16CurrentFileCustody>; sha256: string; entries: readonly S16ByteCustodyIdentity[] };
  github: { value: Readonly<S16CurrentGithubCustody>; sha256: string; entries: readonly S16ByteCustodyIdentity[] };
  native: { sha256: string; roots: number; pending: number };
  helpers: { value: Readonly<S16HelperCohort>; sha256: string }; external: { value: Readonly<S16ExternalCustody>; sha256: string };
}
/** Original independent current preparation. It grants no activation and strict checks reject later repaired bytes. */
export interface S16ForwardCurrentObservation {
  readonly value: Readonly<S16ForwardCurrentCohort>; readonly sha256: string; readonly actionId: string;
  assertCurrent(): Promise<void>;
}
/** Original current preparation owns its native and SQL disposal even after partial opener failure. */
export interface S16ForwardCurrentMaintenance {
  readonly released: boolean; readonly resourcesReleased: boolean;
  capture(): Promise<S16ForwardCurrentObservation>; close(): Promise<void>;
}
/** Actual protected composition supplies every current source/path; no archive or actor supplies these bindings. */
export interface S16ForwardCurrentOwner { config: S15RuntimeConfig; requestId: string; lease: S16InstallationLease; context: S16ControlMaintenance; journal: S16OperationsJournal }
/** Helper injection is an explicit deterministic protocol fixture, never physical acceptance or ordinary configuration. */
export interface S16ForwardCurrentOptions {
  helper?: S16HelperCohortOptions;
  after?(boundary: 'native' | 'directories' | 'intent' | 'plan' | 'image' | 'sql_manifest' | 'revalidated' | 'observed', sourceName?: string): void;
}
/** Retains a complete independent current cohort without replacing live SQL, native state, credentials or bytes. */
export function openS16ForwardCurrentCohort(owner: S16ForwardCurrentOwner, options: S16ForwardCurrentOptions = {}): S16ForwardCurrentMaintenance {
  const { config, requestId, context, journal } = owner; identity(requestId);
  let released = false, usable = true, busy = false, native: S16CurrentNativeMaintenance | undefined, cut: S16LedgerWriteCut | undefined;
  const guard = () => { if (released || !usable) refuse('s16_ops_current_cohort_closed'); assertS16ExclusiveInstallationLease(owner.lease, config.directory); context.assertCurrent(); };
  const after = (boundary: Parameters<NonNullable<S16ForwardCurrentOptions['after']>>[0], name?: string) => { guard(); if ((options.after?.(boundary, name) as unknown) !== undefined) refuse('s16_ops_guard_invalid'); guard(); };
  const read = () => {
    guard(); const control = journal.read(), request = control.requests.find(row => row.requestId === requestId);
    if (!request || request.kind !== 'restore' || !request.pointId || !['capturing', 'verifying', 'prepared', 'activating'].includes(request.phase) || ['complete', 'discarded'].includes(request.status) || request.configurationSha256 !== hash(canonical(config)) || request.admittedRevision === null) refuse();
    return { control, request };
  };
  const releaseCut = () => { if (!cut) return; try { cut.close(); } catch { usable = false; refuse('s16_ops_source_release_unknown'); } };
  const reserve = () => { guard(); if (cut && !cut.released) refuse('s16_ops_source_release_unknown'); return openS16LedgerWriteCut({ sources: context.sources, guard, retain(value) { cut = value; } }); };
  // Current SQL contents use the complete logical image; a legitimate WAL checkpoint can change
  // main-file size/timestamps without changing that image or the original private source inode.
  const sqlIdentities = () => [...context.sources].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0).map(row => ({ name: row.name, identity: s16PointEntryIdentity(s16PointEntry(row.database.filename), true) }));
  const byteEntries = (entries: readonly S16ByteCustodyIdentity[]) => entries.filter(row => !context.sources.some(source => source.database.filename === row.path));
  let session: S16ForwardCurrentMaintenance;
  session = Object.freeze<S16ForwardCurrentMaintenance>({ get released() { return released; }, get resourcesReleased() { return (!cut || cut.released) && (!native || native.resourcesReleased); },
    async close() { if (released) return; usable = false; if (busy) refuse('s16_ops_current_cohort_busy'); releaseCut(); await native?.close(); released = true; },
    async capture() {
      guard(); if (busy) refuse('s16_ops_current_cohort_busy'); busy = true; let pendingActionId: string | undefined;
      try {
        const initial = read(); assertS16SelectedStores(config, context.runtime.sources);
        if (context.sources.some(source => source.database.inTransaction)) refuse('s16_ops_sources_busy');
        const stage = context.recoveryStage(requestId); assertS16RecoveryStageFor(stage, requestId, initial.request.id);
        const path = join(stage.root, 'current.json'), sqlParent = stage.path('ledgers'), sqlRoot = join(sqlParent, initial.request.id), globalStage = dirname(stage.root);
        const actions = initial.request.actions.filter(row => row.id.startsWith('current_cohort_')); if (actions.length > 1 || actions[0]?.state === 'not_applied') refuse();
        const existing = actions[0], prepared = initial.request.phase !== 'capturing'; pendingActionId = existing?.id;
        let originalText: string | undefined;
        if (lstatSync(path, { throwIfNoEntry: false })) {
          const stat = s16PointEntry(path); if (!existing || stat.size > metadataBound) refuse('s16_ops_current_cohort_plan_invalid');
          const bytes = opsRead(path, metadataBound); if (bytes.length !== Number(stat.size) || hash(bytes) !== existing.targetSha256) refuse('s16_ops_current_cohort_plan_invalid'); originalText = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
        }
        if (prepared && (!originalText || existing?.state !== 'confirmed')) refuse('s16_ops_current_cohort_incomplete');
        if (existing?.state === 'confirmed' && originalText === undefined) refuse('s16_ops_current_cohort_incomplete');
        if (existing) s16PointEntry(sqlRoot, true);
        else { if (prepared) refuse(); opsDirectory(sqlRoot); if (names(sqlRoot, 1).length) refuse('s16_ops_current_cohort_plan_invalid'); }
        if (names(sqlParent, 2).join(',') !== initial.request.id) refuse(); after('directories');
        if (!native || native.released) native = context.currentNativeCustody(requestId);
        const nativeCut: S16CurrentNativeObservation = await native.capture(); after('native');
        const external = context.externalCustody(), helpers = await context.helperCustody(options.helper);
        const binary = inspectS16ExecutingPackage(context.sources), directoryIdentity = s16PointEntryIdentity(s16PointEntry(sqlRoot, true), true);
        const stageCurrent = () => { guard(); stage.assertCurrent(); if (directoryIdentity !== s16PointEntryIdentity(s16PointEntry(sqlRoot, true), true)) refuse('s16_ops_current_cohort_plan_invalid'); };
        let value: S16ForwardCurrentCohort, encoded: string, digest: string;
        const held = reserve();
        try {
          const files = context.currentFileCustody(held), github = context.currentGithubCustody(held), images: S16LedgerSet['images'][number][] = []; let total = 0;
          for (const source of held.sources) { const bytes = held.serialize(source.name); total += bytes.length; images.push({ contract: 's16-ledger-image/v1', validation: 'header_and_hash', applicationId: bytes.readUInt32BE(68), readerVersion: bytes.readUInt32BE(60), journalMode: 'rollback', bytes: bytes.length, sha256: hash(bytes), name: source.name }); }
          const manifest: S16LedgerSet = { contract: 's16-ledger-set/v1', scope: 'caller_selected_ledgers', validation: 'sqlite_integrity_and_image_hashes', installationId: config.installationId, id: initial.request.id, capturedAt: initial.request.createdAt, bytes: total, images };
          value = { contract: 's16-forward-current-cohort/v1', operationsId: initial.control.id, installationId: config.installationId, ownerIdentity: context.ownerIdentity, operationId: initial.request.id, requestId,
            configurationSha256: initial.request.configurationSha256!, admittedRevision: initial.request.admittedRevision!, capturedAt: initial.request.createdAt, stageSha256: stage.scopeSha256, package: binary,
            sql: { directoryIdentity, sources: sqlIdentities(), manifestSha256: s16LedgerSetManifestHash(manifest), manifest }, file: { value: files.value, sha256: files.sha256, entries: byteEntries(files.entries) }, github: { value: github.value, sha256: github.sha256, entries: byteEntries(github.entries) },
            native: { sha256: nativeCut.sha256, roots: nativeCut.roots, pending: nativeCut.pending }, helpers: { value: helpers.value, sha256: helpers.sha256 }, external: { value: external.value, sha256: external.sha256 } };
          encoded = text(value); digest = hash(encoded); const actionId = 'current_cohort_' + digest; pendingActionId = actionId;
          if (existing && (existing.id !== actionId || existing.kind !== 'capture_backend' || existing.priorSha256 !== value.sql.manifestSha256 || existing.targetSha256 !== digest) || originalText !== undefined && originalText !== encoded) refuse('s16_ops_current_cohort_changed');
          const known = new Set([...images.map(row => row.name), 'manifest.json']); if (names(sqlRoot, 257).some(name => !known.has(name))) refuse();
          const occupied = usage(globalStage), remaining = images.filter(row => !lstatSync(join(sqlRoot, row.name), { throwIfNoEntry: false })).reduce((sum, row) => sum + row.bytes, 0);
          if (occupied.bytes + remaining + (originalText === undefined ? Buffer.byteLength(encoded) : 0) + 131072 > s16RecoveryLimits.bytes || occupied.nodes + images.length + 2 > s16RecoveryLimits.nodes) refuse('s16_ops_recovery_bounds');
          if (!existing) { let state = read(); if (state.request.status !== 'running' && state.request.actions.every(row => ['confirmed', 'not_applied'].includes(row.state))) { journal.resume(requestId, state.control.revision); state = read(); } journal.recordIntent(requestId, state.control.revision, { id: actionId, kind: 'capture_backend', priorSha256: value.sql.manifestSha256, targetSha256: digest }); after('intent'); }
          if (originalText === undefined) { stageCurrent(); opsWrite(path, encoded); } after('plan');
          for (const image of images) {
            stageCurrent(); held.assertCurrent(); const target = join(sqlRoot, image.name), bytes = held.serialize(image.name);
            if (hash(bytes) !== image.sha256 || bytes.length !== image.bytes) refuse('s16_ops_current_cohort_changed');
            if (lstatSync(target, { throwIfNoEntry: false })) verifyS16PayloadSources([{ name: image.name, path: target, bytes: image.bytes, sha256: image.sha256 }], stageCurrent);
            else { if (prepared || existing?.state === 'confirmed') refuse('s16_ops_current_cohort_incomplete'); opsWrite(target, bytes); }
            after('image', image.name);
          }
          const manifestText = canonical(manifest), manifestPath = join(sqlRoot, 'manifest.json');
          if (lstatSync(manifestPath, { throwIfNoEntry: false })) verifyS16PayloadSources([{ name: 'sql_manifest.json', path: manifestPath, bytes: Buffer.byteLength(manifestText), sha256: value.sql.manifestSha256 }], stageCurrent);
          else { if (prepared || existing?.state === 'confirmed') refuse('s16_ops_current_cohort_incomplete'); opsWrite(manifestPath, manifestText); }
          held.assertCurrent(); files.assertCurrent(); github.assertCurrent(); after('sql_manifest');
        } finally { releaseCut(); }
        const sqlCurrent = (observe: () => void) => {
          stageCurrent(); if (text(sqlIdentities()) !== text(value.sql.sources)) refuse('s16_ops_current_cohort_changed'); const current = reserve();
          try { if (current.sources.length !== value.sql.manifest.images.length || current.sources.some((source, at) => source.name !== value.sql.manifest.images[at]!.name)) refuse('s16_ops_current_cohort_changed'); for (const row of value.sql.manifest.images) { const bytes = current.serialize(row.name); if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) refuse('s16_ops_current_cohort_changed'); } observe(); current.assertCurrent(); }
          finally { releaseCut(); }
        };
        const bytesCurrent = () => { stageCurrent(); const file = context.currentFileCustody(), github = context.currentGithubCustody(); if (text({ value: file.value, sha256: file.sha256, entries: byteEntries(file.entries) }) !== text(value.file) || text({ value: github.value, sha256: github.sha256, entries: byteEntries(github.entries) }) !== text(value.github)) refuse('s16_ops_current_cohort_changed'); };
        bytesCurrent(); external.assertCurrent(); await helpers.assertCurrent(); await nativeCut.assertCurrent(); bytesCurrent(); external.assertCurrent();
        verifyS16LedgerSet({ directory: sqlParent, installationId: config.installationId, id: initial.request.id, readers: context.sources.map(({ database: _db, ...source }) => source), manifestSha256: value.sql.manifestSha256 });
        stageCurrent(); if (text(inspectS16ExecutingPackage(context.sources)) !== text(binary) || hash(opsRead(path, metadataBound)) !== digest) refuse('s16_ops_current_cohort_changed');
        sqlCurrent(() => { after('revalidated'); cut!.assertCurrent(); const state = read(); journal.observeAction(requestId, state.control.revision, pendingActionId!, 'applied', digest); }); after('observed');
        return Object.freeze({ value: freeze(value), sha256: digest, actionId: pendingActionId, async assertCurrent() { guard(); const latest = await session.capture(); if (latest.sha256 !== digest) refuse('s16_ops_current_cohort_changed'); } });
      } catch (error) {
        const failure = error instanceof AppError && error.code.startsWith('s16_ops_') ? error : new AppError('s16_ops_current_cohort_invalid', 409);
        try { const state = read(), action = state.request.actions.find(row => row.id === pendingActionId); journal.block(requestId, state.control.revision, failure.code, action && !['confirmed', 'not_applied'].includes(action.state) ? action.id : undefined); } catch { /* Lost current guards cannot authorize another write; original resources and fence remain. */ }
        throw failure;
      } finally { busy = false; }
    } });
  guard(); return session;
}
