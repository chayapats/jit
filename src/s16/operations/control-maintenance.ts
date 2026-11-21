import { Database } from 'bun:sqlite';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, readdirSync, unlinkSync, type BigIntStats } from 'node:fs';
import { dirname, join } from 'node:path';
import { createHash } from 'node:crypto';
import { AppError } from '../../errors';
import { opsPath, opsSyncDirectory, opsWrite } from '../../s14/ops-files';
import { assertS14BackupUnfenced, assertS14OpsUnfenced } from '../../s14/ops-state';
import { s14ApplicationId, s14SchemaVersion } from '../../s14/store';
import { provisionedBrowserResource } from '../../s15/browser/provisioned';
import { canonical } from '../../s15/conversation/validation';
import type { S15RuntimeConfig } from '../../s15/runtime-config';
import type { S16LedgerSource } from './ledger-set';
import { bindS16OperationsLease, openS16InstallationLease } from './installation-lease';
import { openS16RuntimeMaintenance, type S16RuntimeMaintenance } from './runtime-maintenance';
import { assertS16OperationsFenceCurrent, readS16OperationsAdoptionFence, readS16OperationsControl, readS16OperationsFence, validateS16OperationsAdoptionFence, validateS16OperationsFence, type S16OperationsAdoptionFence, type S16OperationsFence } from './operations-state';
import { openS16OperationsJournal, type S16OperationsJournal, type S16OperationsJournalOptions } from './operations-journal';
import { resolveS16NativeNamespace, type S16NativeNamespace } from './native-namespace';
import { openS16NativeSet, type S16NativeSetMaintenance, type S16NativeSetOptions } from './native-set';
import { openFirecrackerControllerMaintenance, type FirecrackerControllerMaintenance } from '../../s15/vm/firecracker/maintenance';
import { ConnectionVault } from '../../exec/connections';
import { captureS16HelperCohort, type S16HelperObservation, type S16HelperCohortOptions } from './helper-cohort';
import { captureS16FileCohort, captureS16CurrentFileCustody, type S16FileObservation, type S16CurrentFileObservation } from '../files/custody';
import { captureS16GithubArtifacts, captureS16CurrentGithubCustody, type S16GithubArtifactObservation, type S16CurrentGithubObservation } from '../../s15/github/maintenance';
import { removeS16Point, type S16PointRemovalOptions, type S16PointRemovalResult } from './point-retention';
import { captureS16ExternalCustody, type S16ExternalObservation } from './external-custody';
import { s16PointDirectory } from './point-files';
import { retireS16Staging, type S16StagingRetirementOptions, type S16StagingRetirementResult } from './staging-retention';
import { abortS16Backup, type S16BackupAbortOptions, type S16BackupAbortResult } from './backup-abort';
import type { S16OperationsRequest } from './operations-state';
import { openS16PointCapture, type S16PointCaptureMaintenance, type S16PointCaptureOptions } from './point-capture';
import { captureS16CurrentPayloadReferences, type S16CurrentPayloadReferenceObservation } from './current-payload-references';
import { assertS16LedgerWriteCutFor, openS16LedgerWriteCut, type S16LedgerWriteCut } from './ledger-write-cut';
import { ownS16RecoveryStage, type S16RecoveryStage, type S16RecoveryStageOptions } from './recovery-staging';
import { openS16CandidateQuarantine, type S16CandidateMaintenance, type S16CandidateOptions } from './candidate-quarantine';
import { assertS16SelectedStores } from './selected-stores';

function refuse(code = 's16_ops_outer_continuity_invalid'): never { throw new AppError(code, 409); }
function entry(path: string, directory = false): BigIntStats {
  try {
    opsPath(path); const stat = lstatSync(path, { bigint: true }), uid = process.getuid?.();
    if (uid === undefined || stat.uid !== BigInt(uid) || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) || stat.mode & (directory ? 0o7077n : 0o7177n)) refuse();
    return stat;
  } catch { return refuse(); }
}
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && (a.isDirectory() && b.isDirectory() || a.nlink === b.nlink);
function integrity(db: Database): void {
  if (db.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get()?.quick_check !== 'ok' || db.query('PRAGMA foreign_key_check').get()) refuse();
  const quote = (name: string) => '"' + name.replaceAll('"', '""') + '"';
  const tables = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' LIMIT 257").all();
  if (tables.length > 256) refuse();
  for (const table of tables) for (const column of db.query<{ name: string; type: string }, []>(`PRAGMA table_info(${quote(table.name)})`).all()) {
    if (column.type.toUpperCase() === 'TEXT' && (column.name === 'json' || column.name.endsWith('_json')) && db.query(`SELECT 1 FROM ${quote(table.name)} WHERE ${quote(column.name)} IS NOT NULL AND json_valid(${quote(column.name)})=0 LIMIT 1`).get()) refuse();
  }
}
/** Protected current-control capability. Outer owner/lifecycle state is never historical restore authority. */
export interface S16ControlMaintenance {
  readonly runtime: S16RuntimeMaintenance;
  readonly outer: readonly S16LedgerSource[];
  /** Complete selected/retained current SQL cohort, including auxiliary controller journals. Non-SQL custody is separate. */
  readonly sources: readonly S16LedgerSource[];
  readonly ownerIdentity: string;
  /** Current controller original intents, separate from root-helper/working-disk settlement. */
  readonly firecracker: FirecrackerControllerMaintenance;
  /** Retains only this exact current-owner/config bootstrap fence; it grants no application/effect authority. */
  retainAdoptionFence(fence: S16OperationsAdoptionFence): void;
  /** Binds the verified original fenced operations journal without releasing either process lease. */
  publishOperationsBinding(): void;
  /** Removes only the verified completed initial-adoption fence; unknown boundaries remain explicit. */
  completeAdoptionFence(): void;
  /** Opens current durable metadata under this exact owning exclusion; never an archive or actor API. */
  operations(options?: Pick<S16OperationsJournalOptions, 'now' | 'id' | 'after'>): S16OperationsJournal;
  /** Resolves the complete fixed native namespace from current owning rows, preserving unresolved custody. */
  nativeNamespace(): S16NativeNamespace;
  /** Captures protected native custody for an original operation; close this session before the context. */
  nativeSet(requestId: string, options: S16NativeSetOptions): S16NativeSetMaintenance;
  /** Authenticated read-only root-helper cut; private journals/disks and physical settlement stay separate. */
  helperCustody(options?: S16HelperCohortOptions): Promise<S16HelperObservation>;
  /** Complete known FILE/parser byte custody, retaining pending and untrusted roles without boot recovery. */
  fileCustody(): S16FileObservation;
  /** Present FILE/parser bytes and exact missing current pins; neither a complete point nor write authority. */
  currentFileCustody(cut?: S16LedgerWriteCut): S16CurrentFileObservation;
  /** Present GitHub bytes and exact missing current refs, preserving unreferenced current custody. */
  currentGithubCustody(cut?: S16LedgerWriteCut): S16CurrentGithubObservation;
  /** Current SQL pins even when payload bytes are missing; no complete cohort or restore authority. */
  currentPayloadReferences(cut?: S16LedgerWriteCut): S16CurrentPayloadReferenceObservation;
  /** Actual writer reservations for the complete current SQL set; no actor or activation authority. */
  currentLedgerCut(): S16LedgerWriteCut;
  /** Independently pins original empty restore staging; no child metadata or archive grants ownership. */
  recoveryStage(requestId: string, options?: S16RecoveryStageOptions): S16RecoveryStage;
  /** Authenticates a retained point and its public native ancestry in original private quarantine. */
  candidateQuarantine(requestId: string, options?: S16CandidateOptions): S16CandidateMaintenance;
  /** Complete current GitHub bundle bytes/references, without recovery, Git, credentials or publication. */
  githubArtifacts(): S16GithubArtifactObservation;
  /** Current backend/client/credential metadata; no secret/profile/disk copy or physical settlement. */
  externalCustody(): S16ExternalObservation;
  /** Owns aggregate capture and native disposal; close this session before releasing current control. */
  pointCapture(requestId: string, options?: S16PointCaptureOptions): S16PointCaptureMaintenance;
  /** Explicit protected retention, confined to the original receipted historical point and durable plan. */
  removePoint(requestId: string, options: S16PointRemovalOptions): Readonly<S16PointRemovalResult>;
  /** Explicit logical backup abort; temporary bytes require separate retirement. */
  abortBackup(requestId: string, options?: S16BackupAbortOptions): Readonly<S16BackupAbortResult>;
  /** Explicit retirement of one terminal backup's independently owned temporary namespaces. */
  retireStaging(requestId: string, options: S16StagingRetirementOptions): Readonly<S16StagingRetirementResult>;
  assertCurrent(): void;
  /** Closes original SQL sources, keeping genuine installation/CHAT/controller process exclusion. */
  retireSources(): void;
  /** Exclusion only after retirement; current cohort/target validation remains with the activation coordinator. */
  assertExclusion(): void;
  close(): void;
}
/** A protected operator may resume only its independently read exact current adoption intent. Never archive input. */
export interface S16ControlMaintenanceOptions { adoptionFence?: S16OperationsAdoptionFence; operationFence?: S16OperationsFence }
/**
 * Opens selected/retained current control behind installation and CHAT exclusion without application
 * boot or missing-state initialization. Paths and exact current config originate only in trusted host
 * code; this capability is not a complete backup, ordinary export, actor or restore/admission grant.
 */
export function openS16ControlMaintenance(config: S15RuntimeConfig, options: S16ControlMaintenanceOptions = {}): S16ControlMaintenance {
  if (options.adoptionFence && options.operationFence) refuse();
  const configIdentity = canonical(config), root = config.directory, lease = openS16InstallationLease({ directory: root, mode: 'exclusive' });
  const configurationSha256 = createHash('sha256').update(configIdentity).digest('hex');
  let expectedFence = options.adoptionFence ? Object.freeze({ ...options.adoptionFence }) : undefined;
  let expectedOperation = options.operationFence ? Object.freeze({ ...options.operationFence }) : undefined;
  let runtime: S16RuntimeMaintenance | undefined, closed = false, usable = true, retiring = false, retired = false;
  let firecracker: FirecrackerControllerMaintenance | undefined;
  const opened: Database[] = [], entries = new Map<string, BigIntStats>();
  const nativeSets = new Set<S16NativeSetMaintenance>();
  const pointCaptures = new Set<S16PointCaptureMaintenance>();
  const ledgerCuts = new Set<S16LedgerWriteCut>();
  const candidates = new Set<S16CandidateMaintenance>();
  let helperReads = 0;
  const retireDataSources = () => {
    if (retired) return;
    firecracker?.retireSources();
    let failed = false;
    for (const db of [...opened].reverse()) try { db.close(true); } catch { failed = true; }
    if (failed) refuse('s16_ops_source_release_unknown');
    runtime?.retireSources(); retired = true;
  };
  const close = () => {
    if (closed) return; usable = false;
    if (helperReads || [...nativeSets].some(session => !session.released) || [...pointCaptures].some(session => !session.released) || [...candidates].some(session => !session.released)) refuse('s16_ops_source_release_unknown');
    for (const cut of ledgerCuts) cut.close();
    // A retirement attempt never releases auxiliary process locks while any original source close is unknown.
    if (retiring) retireDataSources();
    firecracker?.close();
    let failed = false;
    if (!retired) for (const db of [...opened].reverse()) try { db.close(true); } catch { failed = true; }
    if (failed) refuse('s16_ops_source_release_unknown');
    runtime?.close(); lease.close(); closed = true;
  };
  try {
    if (expectedFence) { validateS16OperationsAdoptionFence(expectedFence); if (expectedFence.installationId !== config.installationId || expectedFence.configurationSha256 !== configurationSha256) refuse(); }
    if (expectedOperation) { validateS16OperationsFence(expectedOperation); if (!lease.operations || expectedOperation.id !== lease.operations.id || expectedOperation.installationId !== config.installationId || expectedOperation.configurationSha256 !== configurationSha256) refuse(); }
    if (lease.operations && lease.operations.installationId !== config.installationId) refuse();
    const ownerDirectory = join(root, 'owner'), ownerPath = join(ownerDirectory, 'owner.sqlite');
    const rootEntry = entry(root, true), ownerEntry = entry(ownerDirectory, true);
    const unfenced = () => {
      if (expectedFence) { if (canonical(readS16OperationsAdoptionFence(root)) !== canonical(expectedFence)) refuse(); }
      else if (expectedOperation) {
        if (canonical(readS16OperationsFence(root)) !== canonical(expectedOperation)) refuse();
        assertS16OperationsFenceCurrent(readS16OperationsControl(root), expectedOperation);
      }
      else assertS14OpsUnfenced(ownerPath);
      assertS14BackupUnfenced(ownerPath);
    }; unfenced();
    runtime = openS16RuntimeMaintenance({ directory: join(root, 'runtime'), installationId: config.installationId, browserResourceId: config.browser?.resource.id ?? provisionedBrowserResource.id });
    const websites = !!(!config.browser && config.disclosure) || !!lstatSync(join(root, 'browser-sites.sqlite'), { throwIfNoEntry: false });
    const roles = [
      { name: 'owner.sqlite', path: ownerPath, reader: { applicationId: s14ApplicationId, formats: [s14SchemaVersion] } },
      { name: 'owner-lifecycle.sqlite', path: ownerPath + '.lifecycle.sqlite', reader: { applicationId: 0, formats: [0] } },
      { name: 'recipients.sqlite', path: join(root, 'recipients.sqlite'), reader: { applicationId: 0x4a523136, formats: [1] } },
      ...(websites ? [{ name: 'browser-sites.sqlite', path: join(root, 'browser-sites.sqlite'), reader: { applicationId: 0x4a425135, formats: [1] } }] : []),
    ];
    const inventory = () => ({ root: readdirSync(root).filter(name => name.endsWith('.sqlite')).sort(), owner: readdirSync(ownerDirectory).filter(name => name.endsWith('.sqlite')).sort() });
    const expectedInventory = { root: ['s16-operations.lock.sqlite', 'recipients.sqlite', ...(websites ? ['browser-sites.sqlite'] : [])].sort(), owner: ['owner.sqlite', 'owner.sqlite.lifecycle.sqlite'] };
    if (canonical(inventory()) !== canonical(expectedInventory)) refuse('s16_ops_inventory_changed');
    const outer = roles.map(role => {
      const before = entry(role.path); if (before.size < 512n || before.size > 1_073_741_824n) refuse();
      const fd = openSync(role.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), header = Buffer.alloc(100);
      try {
        if (!same(before, fstatSync(fd, { bigint: true })) || readSync(fd, header, 0, 100, 0) !== 100 || header.toString('ascii', 0, 16) !== 'SQLite format 3\0' || header.readUInt32BE(68) !== role.reader.applicationId || !role.reader.formats.includes(header.readUInt32BE(60))) refuse('s16_ops_reader_unsupported');
      } finally { closeSync(fd); }
      const database = new Database(role.path, { readwrite: true, create: false, strict: true }); opened.push(database); database.exec('PRAGMA busy_timeout=10');
      if (!same(before, entry(role.path)) || database.query<{ application_id: number }, []>('PRAGMA application_id').get()?.application_id !== role.reader.applicationId || !role.reader.formats.includes(database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version ?? -1)) refuse('s16_ops_reader_unsupported');
      integrity(database); entries.set(role.path, entry(role.path));
      return Object.freeze({ name: role.name, database, reader: Object.freeze({ applicationId: role.reader.applicationId, formats: Object.freeze(role.reader.formats) }) });
    });
    const boundedIdentity = "CASE WHEN typeof(id)='text' AND length(CAST(id AS BLOB)) BETWEEN 1 AND 128 THEN id ELSE NULL END AS id";
    const owners = outer[0]!.database.query<{ id: string }, []>(`SELECT ${boundedIdentity} FROM memory_identity LIMIT 2`).all(), lifecycle = outer[1]!.database.query<{ id: string }, []>(`SELECT ${boundedIdentity} FROM identity LIMIT 2`).all();
    if (owners.length !== 1 || lifecycle.length !== 1 || typeof owners[0]!.id !== 'string' || !owners[0]!.id || owners[0]!.id.length > 128 || owners[0]!.id !== lifecycle[0]!.id) refuse();
    const ownerIdentity = owners[0]!.id;
    if (expectedFence && expectedFence.ownerIdentity !== ownerIdentity || expectedOperation && expectedOperation.ownerIdentity !== ownerIdentity || lease.operations && lease.operations.ownerIdentity !== ownerIdentity) refuse();
    for (const source of outer.slice(2)) {
      const identities = source.database.query<{ installation: string }, []>('SELECT installation FROM identity LIMIT 2').all();
      const meta = source.database.query<{ json: string }, []>("SELECT json FROM records WHERE id='meta' AND length(CAST(json AS BLOB))<=4096").get();
      if (identities.length !== 1 || identities[0]!.installation !== config.installationId || !meta) refuse();
      const value = JSON.parse(meta.json);
      if (!value || value.kind !== 'meta' || typeof value.epoch !== 'string' || !/^[a-f0-9]{16}$/.test(value.epoch) || source.database.query<{ total: number }, []>("SELECT count(*) AS total FROM records WHERE json_extract(json,'$.kind')='meta'").get()?.total !== 1) refuse();
    }
    const heldRuntime = runtime;
    const assertBaseCurrent = () => {
      if (closed || !usable) refuse('s16_ops_maintenance_closed'); lease.assertCurrent(); heldRuntime.assertCurrent(); unfenced();
      if (canonical(config) !== configIdentity || !same(rootEntry, entry(root, true)) || !same(ownerEntry, entry(ownerDirectory, true)) || canonical(inventory()) !== canonical(expectedInventory)) refuse('s16_ops_inventory_changed');
      for (const [path, before] of entries) { const current = entry(path); if (!same(before, current) || before.size !== current.size || before.mtimeNs !== current.mtimeNs || before.ctimeNs !== current.ctimeNs) refuse('s16_ops_image_changed'); }
    };
    const assertCurrent = () => { assertBaseCurrent(); firecracker?.assertCurrent(); };
    const retainAdoptionFence = (fence: S16OperationsAdoptionFence) => {
      assertCurrent(); validateS16OperationsAdoptionFence(fence);
      if (expectedOperation) refuse();
      if (fence.ownerIdentity !== ownerIdentity || fence.installationId !== config.installationId || fence.configurationSha256 !== configurationSha256 || lease.operations && lease.operations.id !== fence.id) refuse();
      if (expectedFence) { if (canonical(expectedFence) !== canonical(fence)) refuse(); return; }
      opsWrite(join(ownerPath + '.ops', 'fence.json'), canonical(fence)); expectedFence = Object.freeze({ ...fence }); assertCurrent();
    };
    const publishOperationsBinding = () => {
      assertCurrent(); if (!expectedFence) refuse();
      bindS16OperationsLease(lease, root, { id: expectedFence.id, installationId: config.installationId, ownerIdentity }); assertCurrent();
    };
    const completeAdoptionFence = () => {
      assertCurrent(); if (!expectedFence || !lease.operations || lease.operations.id !== expectedFence.id) refuse();
      const control = readS16OperationsControl(root);
      if (control.id !== expectedFence.id || control.ownerIdentity !== ownerIdentity || control.installationId !== config.installationId || control.revision !== 0 || control.requests.length || control.points.length || control.adoption.requestId !== expectedFence.requestId || control.adoption.configurationSha256 !== expectedFence.configurationSha256 || control.adoption.createdAt !== expectedFence.createdAt) refuse();
      const path = join(ownerPath + '.ops', 'fence.json');
      // assertCurrent just re-read the exact private original fence; only this owning bootstrap may remove it.
      unlinkSync(path); opsSyncDirectory(dirname(path)); expectedFence = undefined; assertCurrent();
    };
    const assertCaptureReleased = () => {
      assertCurrent(); if (helperReads || [...nativeSets].some(session => !session.released) || [...pointCaptures].some(session => !session.released) || [...ledgerCuts].some(cut => !cut.released) || [...candidates].some(session => !session.resourcesReleased)) refuse('s16_ops_source_release_unknown');
    };
    const assertExclusion = () => {
      if (closed || !retired) refuse('s16_ops_sources_not_retired');
      lease.assertCurrent(); heldRuntime.assertExclusion(); firecracker?.assertExclusion(); unfenced();
      if (canonical(config) !== configIdentity || !same(rootEntry, entry(root, true)) || !same(ownerEntry, entry(ownerDirectory, true))) refuse('s16_ops_inventory_changed');
    };
    const retireSources = () => {
      if (!retiring) {
        assertCaptureReleased();
        if (sources.some(source => source.database.inTransaction)) refuse('s16_ops_sources_busy');
        retiring = true; usable = false;
      }
      else { if (closed) refuse('s16_ops_maintenance_closed'); lease.assertCurrent(); }
      retireDataSources(); assertExclusion();
    };
    const assertBackupAbortable = (request: Readonly<S16OperationsRequest>) => {
      assertCaptureReleased(); const control = readS16OperationsControl(root);
      if (request.pointId) opsPath(s16PointDirectory(root, request.pointId));
      if (request.kind !== 'backup' || !request.pointId || request.configurationSha256 !== configurationSha256 || control.ownerIdentity !== ownerIdentity || control.installationId !== config.installationId ||
        control.points.some(row => row.id === request.pointId) || lstatSync(s16PointDirectory(root, request.pointId), { throwIfNoEntry: false })) refuse('s16_ops_backup_abort_refused');
    };
    const operations = (journalOptions: Pick<S16OperationsJournalOptions, 'now' | 'id' | 'after'> = {}) => {
      assertCurrent(); if (expectedFence || !lease.operations) refuse('s16_ops_adoption_required');
      return openS16OperationsJournal({ ...journalOptions, directory: root, lease, configurationSha256, guard: assertCurrent, assertBackupAbortable,
        retainFence(fence) {
          assertCurrent(); validateS16OperationsFence(fence);
          if (fence.id !== lease.operations!.id || fence.installationId !== config.installationId || fence.ownerIdentity !== ownerIdentity || fence.configurationSha256 !== configurationSha256) refuse();
          assertS16OperationsFenceCurrent(readS16OperationsControl(root), fence);
          if (expectedOperation) { if (canonical(expectedOperation) !== canonical(fence)) refuse(); return; }
          opsWrite(join(ownerPath + '.ops', 'fence.json'), canonical(fence)); expectedOperation = Object.freeze({ ...fence }); assertCurrent();
        }, clearFence(fence) {
          assertCurrent(); if (!expectedOperation || canonical(expectedOperation) !== canonical(fence)) refuse();
          const control = readS16OperationsControl(root); assertS16OperationsFenceCurrent(control, fence);
          const request = control.requests.find(row => row.id === fence.operationId);
          if (!request || !['complete', 'discarded'].includes(request.status)) refuse();
          if (request.abort) assertBackupAbortable(request);
          else if (request.actions.some(action => !['confirmed', 'not_applied'].includes(action.state))) refuse();
          const path = join(ownerPath + '.ops', 'fence.json');
          unlinkSync(path); opsSyncDirectory(dirname(path)); expectedOperation = undefined; assertCurrent();
        } });
    };
    const nativeNamespace = () => resolveS16NativeNamespace({ runtimeDirectory: join(root, 'runtime'), githubDirectory: join(root, 'native-github'), installationId: config.installationId, sources: heldRuntime.sources, guard: assertCurrent });
    const nativeSet = (requestId: string, sessionOptions: S16NativeSetOptions) => {
      assertCurrent(); for (const session of nativeSets) { if (!session.released) refuse('s16_ops_native_busy'); nativeSets.delete(session); }
      const session = openS16NativeSet({ ...sessionOptions, directory: root, requestId, lease, journal: operations(), namespace: nativeNamespace, guard: assertCurrent }); nativeSets.add(session); return session;
    };
    const vm = heldRuntime.sources.find(source => source.name === 'vm.sqlite')!.database;
    firecracker = openFirecrackerControllerMaintenance({ runtimeDirectory: join(root, 'runtime'), installationId: config.installationId, vm, guard: assertBaseCurrent, retain(capability) { firecracker = capability; } });
    const sources = Object.freeze([...outer, ...heldRuntime.sources, ...firecracker.sources]);
    if (sources.length > 256 || new Set(sources.map(source => source.name)).size !== sources.length || new Set(sources.map(source => source.database)).size !== sources.length) refuse('s16_ops_inventory_changed');
    const controllers = firecracker.controllers;
    const githubArtifacts = () => captureS16GithubArtifacts({ directory: root, installationId: config.installationId, lease, source: heldRuntime.sources.find(source => source.name === 'github.sqlite'), disclosure: heldRuntime.sources.find(source => source.name === 'disclosure.sqlite'), guard: assertCurrent });
    const fileCustody = () => captureS16FileCohort({ directory: root, installationId: config.installationId, lease,
      source: heldRuntime.sources.find(source => source.name === 'files.sqlite'), configuredGeneration: typeof config.files === 'object' ? config.files.parserImage : null, guard: assertCurrent });
    const currentFileCustody = (cut?: S16LedgerWriteCut) => {
      assertCurrent(); assertS16SelectedStores(config, heldRuntime.sources);
      if (cut) assertS16LedgerWriteCutFor(cut, sources);
      return captureS16CurrentFileCustody({ directory: root, installationId: config.installationId, lease,
        source: heldRuntime.sources.find(source => source.name === 'files.sqlite'), configuredGeneration: typeof config.files === 'object' ? config.files.parserImage : null, guard: assertCurrent, ...(cut ? { cut } : {}) });
    };
    const currentGithubCustody = (cut?: S16LedgerWriteCut) => {
      assertCurrent(); assertS16SelectedStores(config, heldRuntime.sources);
      if (cut) assertS16LedgerWriteCutFor(cut, sources);
      return captureS16CurrentGithubCustody({ directory: root, installationId: config.installationId, lease,
        source: heldRuntime.sources.find(source => source.name === 'github.sqlite'), disclosure: heldRuntime.sources.find(source => source.name === 'disclosure.sqlite'), guard: assertCurrent, ...(cut ? { cut } : {}) });
    };
    const currentPayloadReferences = (cut?: S16LedgerWriteCut) => {
      if (cut) assertS16LedgerWriteCutFor(cut, sources);
      return captureS16CurrentPayloadReferences({ directory: root, installationId: config.installationId, lease, sources: heldRuntime.sources, guard: assertCurrent, ...(cut ? { cut } : {}) });
    };
    const currentLedgerCut = () => {
      assertCaptureReleased(); for (const cut of ledgerCuts) ledgerCuts.delete(cut);
      return openS16LedgerWriteCut({ sources, guard: assertCurrent, retain(cut) { ledgerCuts.add(cut); } });
    };
    const recoveryStage = (requestId: string, stageOptions: S16RecoveryStageOptions = {}) => ownS16RecoveryStage({ directory: root, installationId: config.installationId, ownerIdentity, configurationSha256, lease, journal: operations(), guard: assertCurrent }, requestId, stageOptions);
    const helperCustody = (helperOptions: S16HelperCohortOptions = {}) => {
      assertCurrent();
      return captureS16HelperCohort({ ...helperOptions, directory: root, lease, installationId: config.installationId, controllers,
        vault: new ConnectionVault(join(root, 'vault'), { forbidden: [ownerDirectory, join(root, 'runtime'), join(root, 'backups'), join(root, 'operations')] }), guard: assertCurrent,
        async retain<T>(operation: () => Promise<T>) { assertCurrent(); helperReads++; try { return await operation(); } finally { helperReads--; } } });
    };
    const removePoint = (requestId: string, removalOptions: S16PointRemovalOptions) => removeS16Point({ directory: root, installationId: config.installationId, ownerIdentity, configurationSha256, lease, journal: operations(), guard: assertCurrent }, requestId, removalOptions);
    const externalCustody = () => { const notifications = heldRuntime.sources.find(source => source.name === 'notifications.sqlite')?.database;
      return captureS16ExternalCustody({ config, ownerIdentity, owner: outer[0]!.database, vm, ...(notifications ? { notifications } : {}), lease, guard: assertCurrent }); };
    let context: S16ControlMaintenance;
    const candidateQuarantine = (requestId: string, candidateOptions: S16CandidateOptions = {}) => {
      assertCaptureReleased(); for (const session of candidates) { if (!session.released) refuse('s16_ops_candidate_busy'); candidates.delete(session); }
      const session = openS16CandidateQuarantine({ config, requestId, lease, context, journal: operations() }, candidateOptions); candidates.add(session); return session;
    };
    const pointCapture = (requestId: string, captureOptions: S16PointCaptureOptions = {}) => {
      assertCurrent(); for (const session of pointCaptures) { if (!session.released) refuse('s16_ops_point_capture_busy'); pointCaptures.delete(session); }
      const session = openS16PointCapture({ ...captureOptions, config, requestId, lease, context, journal: operations() }); pointCaptures.add(session); return session;
    };
    const abortBackup = (requestId: string, abortOptions: S16BackupAbortOptions = {}) => abortS16Backup({ directory: root, journal: operations(), guard: assertCurrent, assertReleased: assertCaptureReleased }, requestId, abortOptions);
    const retireStaging = (requestId: string, retirementOptions: S16StagingRetirementOptions) => retireS16Staging({ directory: root, configurationSha256, journal: operations(), guard: assertCaptureReleased }, requestId, retirementOptions);
    assertCurrent(); context = Object.freeze({ runtime: heldRuntime, outer: Object.freeze(outer), sources, ownerIdentity, firecracker, assertCurrent, retireSources, assertExclusion, close, retainAdoptionFence, publishOperationsBinding, completeAdoptionFence, operations, nativeNamespace, nativeSet, helperCustody, fileCustody, currentFileCustody, currentGithubCustody, currentPayloadReferences, currentLedgerCut, recoveryStage, candidateQuarantine, githubArtifacts, externalCustody, pointCapture, removePoint, abortBackup, retireStaging }); return context;
  } catch (error) {
    // An opener's unknown runtime release retains its CHAT lease; do not free installation exclusion.
    if (!(error instanceof AppError && error.code === 's16_ops_source_release_unknown')) close();
    if (error instanceof AppError) throw error;
    return refuse();
  }
}
