import { createHash } from 'node:crypto';
import { lstatSync, opendirSync, readdirSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { RELEASE_CONTRACT } from 'schway/host';
import { readDependencyRecord, validateArtifact } from '../../../ops/package/bun-build';
import { AppError } from '../../errors';
import { opsDirectory, opsRead, opsSyncDirectory, opsWrite } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import { vmCanonical } from '../../s15/vm/validation';
import type { S15RuntimeConfig } from '../../s15/runtime-config';
import type { S16ControlMaintenance } from './control-maintenance';
import { assertS16ExclusiveInstallationLease, type S16InstallationLease } from './installation-lease';
import { captureS16LedgerSet } from './ledger-set';
import type { S16NativeSetMaintenance } from './native-set';
import type { S16OperationsJournal } from './operations-journal';
import { captureS16PayloadSet, s16PayloadSetManifestHash, s16PayloadSetManifestText, verifyS16PayloadSet, verifyS16PayloadSources, type S16PayloadSource } from './payload-set';
import { inspectS16PointFiles, s16PointDirectory, s16PointEntry, s16PointEntryIdentity, s16PointLimits, s16PointReconnection, s16RecoveryPointText, type S16PointPackage, type S16PointRole, type S16RecoveryPoint } from './point-files';
import { s16LedgerSetManifestHash, verifyS16LedgerSet } from './verify-ledger-set';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const stageBytes = 12884901888, stageNodes = 250000, metadataBound = 4194304;
function refuse(code = 's16_ops_point_capture_invalid'): never { throw new AppError(code, 409); }
type Boundary = 'admitted' | 'capturing' | 'native' | 'intent' | 'plan' | 'sql' | 'payload' | 'manifest' | 'observed' | 'verifying' | 'publish_intent' | 'published' | 'publication_observed' | 'receipt' | 'complete';
/** Fault observers see only durable boundaries; they cannot choose paths, hashes or authority. */
export interface S16PointCaptureOptions { attempt?: string; after?(boundary: Boundary): void }
/** Original terminal capture receipt. Retirement never causes a completed request to recreate files. */
export interface S16PointCaptureResult { contract: 's16-point-capture-result/v1'; state: 'retained'; operationId: string; requestId: string; pointId: string; manifestSha256: string; bytes: number; revision: number }
/** Retains the original native disposal handle and both exclusions until conclusive close. */
export interface S16PointCaptureMaintenance { readonly released: boolean; capture(): Promise<Readonly<S16PointCaptureResult>>; close(): Promise<void> }
/** Trusted current composition only; candidate files cannot manufacture this capability. */
export interface S16PointCaptureOwner extends S16PointCaptureOptions { config: S15RuntimeConfig; requestId: string; lease: S16InstallationLease; context: S16ControlMaintenance; journal: S16OperationsJournal }

function packageIdentity(context: S16ControlMaintenance): S16PointPackage {
  // Derive the actual executing artifact, never an operator/archive-selected package root.
  const root = resolve(import.meta.dir, '../../..'), checked = validateArtifact(root, { runtime: true }), dependencies = readDependencyRecord(root), manifest = checked.manifest;
  if (!checked.ok || !manifest || !dependencies || manifest.engineContract !== RELEASE_CONTRACT) refuse('s16_ops_verified_package_required');
  const readers = context.sources.map(source => ({ name: source.name, reader: source.reader }));
  return Object.freeze({ contentHash: manifest.contentHash, dependencyHash: dependencies.dependencyHash, lockHash: manifest.lockHash, engineContract: manifest.engineContract, engineRevision: manifest.engineRevision,
    readersSha256: hash(canonical(readers)), noticesSha256: hash(Buffer.concat([opsRead(join(root, 'LICENSE'), metadataBound), Buffer.from('\0'), opsRead(join(root, 'NOTICE'), metadataBound)])) });
}
function usage(root: string): { bytes: number; nodes: number } {
  if (!lstatSync(root, { throwIfNoEntry: false })) return { bytes: 0, nodes: 0 };
  let bytes = 0, nodes = 0;
  const walk = (path: string, depth: number) => { if (++nodes > stageNodes || depth > 8) refuse('s16_ops_capture_bounds'); const stat = lstatSync(path);
    if (stat.isDirectory() && !stat.isSymbolicLink()) { s16PointEntry(path, true); const dir = opendirSync(path); try { for (;;) { const next = dir.readSync(); if (!next) break; walk(join(path, next.name), depth + 1); } } finally { dir.closeSync(); } }
    else { const entry = s16PointEntry(path); bytes += Number(entry.size); if (!Number.isSafeInteger(bytes) || bytes > stageBytes) refuse('s16_ops_capture_bounds'); }
  }; walk(root, 0); return { bytes, nodes };
}
function read(path: string, max = metadataBound): Buffer { const before = s16PointEntry(path); if (before.size > BigInt(max)) refuse('s16_ops_capture_bounds'); const bytes = opsRead(path, max); if (bytes.length !== Number(before.size) || s16PointEntryIdentity(before) !== s16PointEntryIdentity(s16PointEntry(path))) refuse('s16_ops_image_changed'); return bytes; }
function ensure(path: string, text: string, guard: () => void, verifyOnly: boolean): void {
  guard(); if (lstatSync(path, { throwIfNoEntry: false })) verifyS16PayloadSources([{ name: 'metadata', path, bytes: Buffer.byteLength(text), sha256: hash(text) }], guard);
  else { if (verifyOnly) refuse('s16_ops_point_incomplete'); opsWrite(path, text); } guard();
}
/** Captures/publishes one complete current control-plane point; never activates a historical authority or disk. */
export function openS16PointCapture(owner: S16PointCaptureOwner): S16PointCaptureMaintenance {
  const { config, requestId, context, journal } = owner, attempt = owner.attempt ?? 'original'; identity(requestId);
  if (!/^[a-z0-9][a-z0-9_]{0,23}$/.test(attempt)) refuse();
  let released = false, usable = true, busy = false, native: S16NativeSetMaintenance | undefined;
  const guard = () => { if (released || !usable) refuse('s16_ops_point_capture_closed'); assertS16ExclusiveInstallationLease(owner.lease, config.directory); context.assertCurrent(); };
  const after = (boundary: Boundary) => { guard(); if ((owner.after?.(boundary) as unknown) !== undefined) refuse('s16_ops_guard_invalid'); guard(); };
  const current = () => { guard(); const control = journal.read(), request = control.requests.find(row => row.requestId === requestId); if (!request || request.kind !== 'backup' || !request.pointId || request.configurationSha256 !== hash(canonical(config))) return refuse(); return { control, request }; };
  const resumeSettled = () => { const state = current(); if (!['running', 'complete', 'discarded'].includes(state.request.status) && state.request.actions.every(row => ['confirmed', 'not_applied'].includes(row.state))) journal.resume(requestId, state.control.revision); };
  guard();
  return Object.freeze<S16PointCaptureMaintenance>({ get released() { return released; }, async close() { if (released) return; usable = false; if (busy) refuse('s16_ops_point_capture_busy'); await native?.close(); released = true; }, async capture() {
    guard(); if (busy) refuse('s16_ops_point_capture_busy'); if (native && !native.released) refuse('s16_ops_source_release_unknown'); busy = true;
    let captureAction: string | undefined, publicationAction: string | undefined, data: string | undefined, point: string | undefined;
    try {
      const binary = packageIdentity(context), configurationSha256 = hash(canonical(config)), command = hash(canonical({ contract: 's16-point-capture-command/v1', configurationSha256, package: binary }));
      const required = ['conversation.sqlite', 'policy.sqlite', 'model.sqlite', 'work.sqlite', 'vm.sqlite', 'team.sqlite', 'memory.sqlite'];
      for (const feature of ['files', 'routines', 'notifications', 'bots', 'connections', 'skills', 'voice'] as const) if (config[feature]) required.push(feature + '.sqlite');
      if (config.disclosure) required.push('disclosure.sqlite'); if (config.browser || config.disclosure) required.push('browser.sqlite'); if (config.github || config.disclosure) required.push('github.sqlite');
      const present = new Set(context.runtime.sources.map(row => row.name)); if (required.some(name => !present.has(name))) refuse('s16_ops_selected_store_missing');
      journal.begin({ requestId, kind: 'backup', hash: command }, journal.read().revision); let state = current(); point = s16PointDirectory(config.directory, state.request.pointId!);
      const publications = state.request.actions.filter(row => row.kind === 'replace');
      if (publications.length > 1 || publications[0] && (publications[0].id !== 'point_publish_' + state.request.targetSha256 || publications[0].targetSha256 !== state.request.targetSha256 || publications[0].priorSha256 !== null)) refuse();
      publicationAction = publications[0]?.id;
      const result = (): Readonly<S16PointCaptureResult> => { const latest = current(), saved = latest.control.points.find(row => row.id === latest.request.pointId); if (!saved || saved.state !== 'retained' || latest.request.status !== 'complete') return refuse('s16_ops_point_unavailable'); return Object.freeze({ contract: 's16-point-capture-result/v1', state: 'retained', operationId: latest.request.id, requestId, pointId: saved.id, manifestSha256: saved.sha256, bytes: saved.bytes, revision: latest.request.revision }); };
      const readers = context.sources.map(({ database: _db, ...source }) => source);
      if (state.request.status === 'complete') {
        const saved = state.control.points.find(row => row.id === state.request.pointId); if (!saved || saved.state !== 'retained') refuse('s16_ops_point_unavailable');
        const inventory = inspectS16PointFiles(point, { id: saved.id, installationId: config.installationId, ownerIdentity: context.ownerIdentity, operationId: state.request.id, requestId, configurationSha256, cohortSha256: state.request.cohortSha256!, manifestSha256: saved.sha256, bytes: saved.bytes, capturedAt: state.request.createdAt }, guard);
        if (inventory.catalogs !== 'present') refuse('s16_ops_point_incomplete');
        return result();
      }
      if (state.request.status === 'discarded') refuse(); after('admitted'); resumeSettled(); state = current();
      if (state.request.phase === 'pending') { journal.advance(requestId, state.control.revision, 'capturing'); after('capturing'); state = current(); }
      if (!['capturing', 'verifying'].includes(state.request.phase)) refuse('s16_ops_phase_invalid');
      const files = context.fileCustody(), github = context.githubArtifacts(), external = context.externalCustody(), helpers = await context.helperCustody();
      const cutsCurrent = async () => { guard(); files.assertCurrent(); github.assertCurrent(); external.assertCurrent(); await helpers.assertCurrent(); guard(); };
      const fileCatalog = JSON.stringify(files.value), githubCatalog = JSON.stringify(github.value);
      if (hash(fileCatalog) !== files.sha256 || hash(githubCatalog) !== github.sha256) refuse();
      await cutsCurrent(); const ordinaryBytes = [...files.sources, ...github.sources].reduce((n, row) => n + row.bytes, 0) + Buffer.byteLength(fileCatalog) + Buffer.byteLength(githubCatalog);
      if (ordinaryBytes > s16PointLimits.payload) refuse('s16_ops_capture_bounds');
      native = context.nativeSet(requestId, { attempt, maxBytes: s16PointLimits.payload - ordinaryBytes, verifyCurrent: true });
      const nativeResult = await native.capture(); await native.close(); after('native'); resumeSettled(); state = current();
      const nativePlan = read(join(nativeResult.directory, 'plan.json')), nativeManifestBytes = read(join(nativeResult.directory, 'manifest.json')), nativeManifest = JSON.parse(nativeManifestBytes.toString('utf8'));
      if (hash(nativeManifestBytes) !== nativeResult.manifestSha256 || nativeManifest.planSha256 !== hash(nativePlan)) refuse();
      const nativeSources: S16PayloadSource[] = [{ name: 'native_plan.json', path: join(nativeResult.directory, 'plan.json'), bytes: nativePlan.length, sha256: hash(nativePlan) }, { name: 'native_manifest.json', path: join(nativeResult.directory, 'manifest.json'), bytes: nativeManifestBytes.length, sha256: nativeResult.manifestSha256 },
        ...nativeManifest.roots.map((row: { id: string; name: string; bytes: number; sha256: string }) => ({ name: 'native_' + row.id + '.json', path: join(nativeResult.directory, row.name), bytes: row.bytes, sha256: row.sha256 }))];
      const plan = { contract: 's16-point-capture-plan/v1', operationsId: state.control.id, installationId: config.installationId, ownerIdentity: context.ownerIdentity, operationId: state.request.id, requestId, configurationSha256, admittedRevision: state.request.admittedRevision, capturedAt: state.request.createdAt, attempt, package: binary,
        filesSha256: files.sha256, githubSha256: github.sha256, externalSha256: external.sha256, helpersSha256: helpers.sha256, nativeActionId: nativeResult.actionId, nativeSha256: nativeResult.manifestSha256 };
      const planText = canonical(plan), prefix = 'point_capture_' + attempt + '_', actions = state.request.actions.filter(row => row.kind === 'capture_backend');
      if (actions.some(row => !row.id.startsWith(prefix) && row.state !== 'not_applied') || actions.filter(row => row.id.startsWith(prefix)).length > 1) refuse('s16_ops_request_conflict');
      let action = actions.find(row => row.id.startsWith(prefix)); if (action?.state === 'not_applied') refuse('s16_ops_point_distinct_attempt_required'); captureAction = action?.id ?? prefix + hash(planText);
      if (captureAction !== prefix + hash(planText) || action && (action.priorSha256 !== null || action.targetSha256 !== null)) refuse('s16_ops_point_plan_changed');
      if (!action) { if (state.request.phase !== 'capturing' || state.request.status !== 'running') refuse('s16_ops_phase_invalid'); journal.recordIntent(requestId, state.control.revision, { id: captureAction, kind: 'capture_backend', priorSha256: null, targetSha256: null }); after('intent'); state = current(); action = state.request.actions.find(row => row.id === captureAction); }
      const staging = join(config.directory, 'operations/point-staging'), stage = join(staging, state.request.id, captureAction), stagedData = join(stage, 'data');
      const published = !!lstatSync(point, { throwIfNoEntry: false }), recordedPublication = state.request.actions.find(row => row.kind === 'replace');
      if (published && (!recordedPublication || lstatSync(stagedData, { throwIfNoEntry: false }))) refuse('s16_ops_point_unavailable');
      const verifyOnly = published || state.request.phase === 'verifying'; data = published ? point : stagedData;
      const totalUsage = usage(staging), ownUsage = usage(stage);
      if (totalUsage.bytes - ownUsage.bytes + s16PointLimits.bytes + metadataBound * 3 > stageBytes || totalUsage.nodes - ownUsage.nodes + 20280 > stageNodes) refuse('s16_ops_capture_bounds');
      if (verifyOnly) { s16PointEntry(stage, true); ensure(join(stage, 'plan.json'), planText, guard, true); s16PointEntry(data, true); }
      else { opsDirectory(stage); ensure(join(stage, 'plan.json'), planText, guard, false); opsDirectory(data); } after('plan');
      const catalogs = [{ name: 'file_cohort.json', path: join(stage, 'file-cohort.json'), bytes: Buffer.byteLength(fileCatalog), sha256: files.sha256 }, { name: 'github_cohort.json', path: join(stage, 'github-cohort.json'), bytes: Buffer.byteLength(githubCatalog), sha256: github.sha256 }];
      const sources = [...files.sources, ...github.sources, ...nativeSources, ...catalogs];
      if (readdirSync(stage).some(name => !['plan.json', 'data', 'file-cohort.json', 'github-cohort.json'].includes(name))) refuse('s16_ops_inventory_changed');
      const references = vmCanonical({ contract: 's16-current-references/v1', installationId: config.installationId, helpers: helpers.value, external: external.value });
      const payloadIndex = s16PayloadSetManifestText({ contract: 's16-payload-set/v1', scope: 'caller_selected_payloads', installationId: config.installationId, id: state.request.pointId!, capturedAt: state.request.createdAt, bytes: sources.reduce((n, row) => n + row.bytes, 0), files: sources.map(({ path: _path, ...row }) => row).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0) });
      if (Buffer.byteLength(references) + Buffer.byteLength(payloadIndex) + nativePlan.length + nativeManifestBytes.length + Buffer.byteLength(fileCatalog) + Buffer.byteLength(githubCatalog) + 393216 > metadataBound) refuse('s16_ops_capture_bounds');
      ensure(catalogs[0]!.path, fileCatalog, guard, verifyOnly); ensure(catalogs[1]!.path, githubCatalog, guard, verifyOnly);
      const pointId = state.request.pointId!, capturedAt = state.request.createdAt;
      if (!verifyOnly) { opsDirectory(join(data, 'ledgers')); opsDirectory(join(data, 'payloads')); }
      const sql = captureS16LedgerSet({ directory: join(data, 'ledgers'), installationId: config.installationId, id: pointId, sources: context.sources, guard, now: () => capturedAt, maxBytes: Math.min(s16PointLimits.sql, s16PointLimits.bytes - sources.reduce((n, row) => n + row.bytes, 0) - metadataBound), resume: true, ...(verifyOnly ? { verifyOnly: true } : {}) }); after('sql');
      const payload = captureS16PayloadSet({ directory: join(data, 'payloads'), installationId: config.installationId, id: pointId, sources, guard, now: () => capturedAt, resume: true, ...(verifyOnly ? { verifyOnly: true } : {}) }); after('payload');
      verifyS16LedgerSet({ directory: join(data, 'ledgers'), installationId: config.installationId, id: pointId, readers, manifestSha256: s16LedgerSetManifestHash(sql) });
      verifyS16PayloadSet({ directory: join(data, 'payloads'), installationId: config.installationId, id: pointId, files: payload.files, manifestSha256: s16PayloadSetManifestHash(payload) });
      await cutsCurrent();
      const cohortSha256 = hash(canonical({ contract: 's16-point-cohort/v1', planSha256: hash(planText), sqlSha256: s16LedgerSetManifestHash(sql), payloadSha256: s16PayloadSetManifestHash(payload) }));
      const capture = canonical({ contract: 's16-point-capture/v1', installationId: config.installationId, operationId: state.request.id, requestId, cohortSha256,
        native: { actionId: nativeResult.actionId, manifestSha256: nativeResult.manifestSha256, planSha256: hash(nativePlan), roots: nativeResult.roots, pending: nativeResult.pending },
        files: { sha256: files.sha256, files: files.sources.length, pending: files.value.pending.length, parserJobs: files.value.parser.jobs.length }, github: { sha256: github.sha256, bundles: github.value.bundles.length, correlations: github.value.bundles.reduce((n, row) => n + row.references.length, 0) } });
      ensure(join(data, 'references.json'), references, guard, verifyOnly); ensure(join(data, 'capture.json'), capture, guard, verifyOnly);
      const descriptors: readonly [S16PointRole, string, string, string][] = [['ledgers', 's16-ledger-set/v1', 'protected_copy', join(data, 'ledgers', pointId, 'manifest.json')], ['payloads', 's16-payload-set/v1', 'inert_copy', join(data, 'payloads', pointId, 'manifest.json')], ['references', 's16-current-references/v1', 'independent_current_required', join(data, 'references.json')], ['capture', 's16-point-capture/v1', 'capture_evidence', join(data, 'capture.json')]];
      const manifest: S16RecoveryPoint = { contract: 's16-recovery-point/v1', id: pointId, installationId: config.installationId, capturedAt, scope: 'selected_control_plane', package: binary, configuration: { sha256: configurationSha256, ownerIdentity: context.ownerIdentity, sources: context.sources.map(row => row.name), runtime: { selected: context.runtime.selected, retained: context.runtime.retained } }, reconnection: s16PointReconnection,
        components: descriptors.map(([role, contract, custody, path]) => { const bytes = read(path); return { role, contract, custody, bytes: bytes.length, sha256: hash(bytes) }; }) };
      const manifestText = s16RecoveryPointText(manifest), manifestSha256 = hash(manifestText); ensure(join(data, 'manifest.json'), manifestText, guard, verifyOnly); after('manifest');
      if (action?.state === 'confirmed' && action.observedSha256 !== manifestSha256) refuse('s16_ops_point_plan_changed');
      const expected = { id: pointId, installationId: config.installationId, ownerIdentity: context.ownerIdentity, operationId: state.request.id, requestId, configurationSha256, cohortSha256, manifestSha256, capturedAt };
      const inventory = inspectS16PointFiles(data, expected, guard); if (inventory.catalogs !== 'present') refuse('s16_ops_point_incomplete'); await cutsCurrent();
      if (canonical(packageIdentity(context)) !== canonical(binary)) refuse('s16_ops_package_changed');
      state = current(); journal.observeAction(requestId, state.control.revision, captureAction, 'applied', manifestSha256); after('observed'); resumeSettled(); state = current();
      if (state.request.phase === 'capturing') { journal.advance(requestId, state.control.revision, 'verifying', { cohortSha256, targetSha256: manifestSha256 }); after('verifying'); state = current(); }
      if (state.request.targetSha256 !== manifestSha256 || state.request.cohortSha256 !== cohortSha256) refuse('s16_ops_point_plan_changed');
      publicationAction = 'point_publish_' + manifestSha256;
      if (!state.request.actions.some(row => row.id === publicationAction)) { journal.recordIntent(requestId, state.control.revision, { id: publicationAction, kind: 'replace', priorSha256: null, targetSha256: manifestSha256 }); after('publish_intent'); }
      await cutsCurrent();
      if (canonical(packageIdentity(context)) !== canonical(binary)) refuse('s16_ops_package_changed');
      if (!published) { opsDirectory(dirname(point)); if (lstatSync(point, { throwIfNoEntry: false })) refuse('s16_ops_point_unavailable'); guard(); renameSync(data, point); opsSyncDirectory(stage); opsSyncDirectory(dirname(point)); data = point; after('published'); }
      inspectS16PointFiles(point, { ...expected, bytes: inventory.bytes }, guard); await cutsCurrent();
      if (canonical(packageIdentity(context)) !== canonical(binary)) refuse('s16_ops_package_changed');
      state = current(); journal.observeAction(requestId, state.control.revision, publicationAction, 'applied', manifestSha256); after('publication_observed'); resumeSettled(); state = current();
      journal.retainPoint(requestId, state.control.revision, { sha256: manifestSha256, bytes: inventory.bytes }); after('receipt'); state = current(); journal.advance(requestId, state.control.revision, 'complete'); after('complete'); return result();
    } catch (error) {
      try { let state = current(); if (!['complete', 'discarded'].includes(state.request.status)) {
        const id = publicationAction ?? captureAction ?? state.request.actions.findLast(row => !['confirmed', 'not_applied'].includes(row.state))?.id, action = id ? state.request.actions.find(row => row.id === id) : undefined;
        const absent = action?.kind === 'capture_backend' && (!native || native.released) && !(error instanceof AppError && error.code === 's16_ops_source_release_unknown') && data !== undefined && point !== undefined && !lstatSync(join(data, 'manifest.json'), { throwIfNoEntry: false }) && !lstatSync(point, { throwIfNoEntry: false }) && !state.request.actions.some(row => row.kind === 'replace');
        if (action && !['confirmed', 'not_applied'].includes(action.state) && absent) { journal.observeAction(requestId, state.control.revision, action.id, 'not_applied', null); state = current(); }
        const latest = id ? state.request.actions.find(row => row.id === id) : undefined; journal.block(requestId, state.control.revision, 's16_ops_point_capture_incomplete', latest && !['confirmed', 'not_applied'].includes(latest.state) ? latest.id : undefined);
      } } catch { /* Unknown source/journal/disposal retains the original gate and original handles. */ }
      throw error;
    } finally { busy = false; }
  } });
}
