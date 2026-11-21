import { createHash } from 'node:crypto';
import { lstatSync, opendirSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { AppError } from '../../errors';
import { opsPath, opsRead } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import type { S16LedgerSet } from './ledger-set';
import { s16LedgerSetManifestHash } from './verify-ledger-set';
import { s16PayloadSetManifestHash, verifyS16PayloadSources, type S16PayloadSet } from './payload-set';
import { s16RuntimeReaders } from './runtime-readers';

export const s16PointLimits = Object.freeze({ metadata: 4194304, sql: 2147483648, payload: 4294967296, bytes: 6442450944, payloadFiles: 20000, sqlFiles: 256 });
const roles = { ledgers: ['s16-ledger-set/v1', 'protected_copy'], payloads: ['s16-payload-set/v1', 'inert_copy'], references: ['s16-current-references/v1', 'independent_current_required'], capture: ['s16-point-capture/v1', 'capture_evidence'] } as const;
export type S16PointRole = keyof typeof roles;
export type S16PointFileScope = 'metadata' | 'ledgers' | 'payloads';
/** Reviewed code/dependency/readership identity. This is not a native/live readiness certificate. */
export interface S16PointPackage {
  contentHash: string; dependencyHash: string; lockHash: string; engineContract: string; engineRevision: string; readersSha256: string; noticesSha256: string;
}
export const s16PointReconnection = Object.freeze({ vault: 'retain_current_or_owner_reconnect', nativeAuth: 'retain_current_or_owner_reconnect', browserProfiles: 'retain_current_only', workingDisks: 'retain_current_only', clientSecureStorage: 'retain_binding_and_current_storage_or_owner_reconnect' });
/** Closed aggregate envelope. Current receipts remain outside it; no historical row becomes authority. */
export interface S16RecoveryPoint {
  contract: 's16-recovery-point/v1'; id: string; installationId: string; capturedAt: number; scope: 'selected_control_plane';
  package: S16PointPackage;
  configuration: { sha256: string; ownerIdentity: string; sources: readonly string[]; runtime: { selected: readonly string[]; retained: readonly string[] } };
  components: readonly Readonly<{ role: S16PointRole; contract: string; custody: string; bytes: number; sha256: string }>[];
  reconnection: typeof s16PointReconnection;
}
/** Compact original capture facts; full owning restrictions/commands remain in protected SQL copies. */
export interface S16PointCaptureMetadata {
  contract: 's16-point-capture/v1'; installationId: string; operationId: string; requestId: string; cohortSha256: string;
  native: { actionId: string; manifestSha256: string; planSha256: string; roots: number; pending: number };
  files: { sha256: string; files: number; pending: number; parserJobs: number };
  github: { sha256: string; bundles: number; correlations: number };
}
/** Expected identities come from independent current operation/point receipts, never candidate self-hashes. */
export interface S16PointExpectation {
  id: string; installationId: string; ownerIdentity: string; operationId: string; requestId: string; configurationSha256: string; cohortSha256: string; manifestSha256: string;
  bytes?: number; capturedAt?: number;
}
/** Exact scoped member. Identity is over original attributes; it is not serialized authority to open a host path. */
export interface S16PointFile { scope: S16PointFileScope; name: string; bytes: number; sha256: string; identity: string }
export type S16PointDirectoryScope = 'root' | 'ledgers' | 'ledger-data' | 'payloads' | 'payload-data';
/** File custody only. SQL integrity, native ancestry, current continuity and activation need their owning gates. */
export interface S16PointInventory {
  readonly manifest: Readonly<S16RecoveryPoint>; readonly files: readonly Readonly<S16PointFile>[];
  readonly directories: readonly Readonly<{ scope: S16PointDirectoryScope; identity: string }>[];
  readonly bytes: number; readonly metadataBytes: number; readonly catalogs: 'present' | 'absent';
}
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const hex = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const nat = (value: unknown, max = Number.MAX_SAFE_INTEGER): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;
function refuse(code = 's16_ops_point_invalid'): never { throw new AppError(code, 409); }
function fields(value: unknown, names: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== names.split(',').sort().join(',')) refuse();
}
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse(); return value as Record<string, unknown>; }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function strings(value: unknown, max: number): asserts value is string[] { if (!Array.isArray(value) || value.length > max || value.some(x => typeof x !== 'string' || !/^[a-z][a-z0-9_-]{0,63}\.sqlite$/.test(x)) || new Set(value).size !== value.length) refuse(); }
/** Stable original file/directory identity; directory membership changes during original removal are intentional. */
export function s16PointEntryIdentity(stat: BigIntStats, directory = false): string {
  return hash(JSON.stringify(directory ? [String(stat.dev), String(stat.ino), String(stat.uid), String(stat.mode)] : [String(stat.dev), String(stat.ino), String(stat.uid), String(stat.mode), String(stat.nlink), String(stat.size), String(stat.mtimeNs), String(stat.ctimeNs)]));
}
/** Requires canonical private same-owner custody before any point metadata or byte read. */
export function s16PointEntry(path: string, directory = false): BigIntStats {
  opsPath(path); const stat = lstatSync(path, { bigint: true }), uid = process.getuid?.();
  if (uid === undefined || stat.uid !== BigInt(uid) || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) || stat.mode & (directory ? 0o7077n : 0o7177n)) refuse('s16_ops_point_path_untrusted'); return stat;
}
/** Fixed historical target only; an archive never supplies a filesystem destination. */
export function s16PointDirectory(directory: string, id: string): string {
  if (!isAbsolute(directory) || normalize(directory) !== directory || !opaque(id)) refuse(); return join(directory, 'operations/points', id);
}
/** Maps only closed role/member names to the fixed private point layout. */
export function s16PointMemberPath(root: string, id: string, scope: S16PointFileScope, name: string): string {
  if (!opaque(id) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,191}$/.test(name)) refuse();
  if (scope === 'metadata') { if (!['manifest.json', 'references.json', 'capture.json'].includes(name)) refuse(); return join(root, name); }
  if (!['ledgers', 'payloads'].includes(scope)) refuse(); return join(root, scope, id, name);
}
/** Resolves only the five fixed point-owned directory roles; arbitrary archive paths are refused. */
export function s16PointSubdirectory(root: string, id: string, scope: S16PointDirectoryScope): string {
  if (!opaque(id)) refuse(); if (scope === 'root') return root;
  if (scope === 'ledgers' || scope === 'payloads') return join(root, scope);
  if (scope === 'ledger-data') return join(root, 'ledgers', id); if (scope === 'payload-data') return join(root, 'payloads', id); return refuse();
}
/** Encodes a producer's closed envelope. Only a separately retained receipt can authenticate these bytes. */
export function s16RecoveryPointText(value: S16RecoveryPoint): string {
  validateManifest(value); const text = canonical(value); if (Buffer.byteLength(text) > s16PointLimits.metadata) refuse('s16_ops_point_bounds'); return text;
}
function validateManifest(value: unknown): asserts value is S16RecoveryPoint {
  fields(value, 'contract,id,installationId,capturedAt,scope,package,configuration,components,reconnection'); identity(value.installationId as string);
  if (value.contract !== 's16-recovery-point/v1' || !opaque(value.id) || !nat(value.capturedAt) || value.scope !== 'selected_control_plane') refuse();
  fields(value.package, 'contentHash,dependencyHash,lockHash,engineContract,engineRevision,readersSha256,noticesSha256');
  for (const key of ['contentHash', 'dependencyHash', 'lockHash', 'readersSha256', 'noticesSha256']) if (!hex(value.package[key])) refuse();
  if (typeof value.package.engineContract !== 'string' || !/^[a-z][a-z0-9_./-]{0,119}$/.test(value.package.engineContract) || typeof value.package.engineRevision !== 'string' || !/^[A-Za-z0-9._-]{1,120}$/.test(value.package.engineRevision)) refuse();
  fields(value.configuration, 'sha256,ownerIdentity,sources,runtime'); fields(value.configuration.runtime, 'selected,retained');
  if (!hex(value.configuration.sha256) || typeof value.configuration.ownerIdentity !== 'string' || !value.configuration.ownerIdentity || value.configuration.ownerIdentity.length > 128 || value.configuration.ownerIdentity.includes('\0')) refuse();
  strings(value.configuration.sources, 256); strings(value.configuration.runtime.selected, Object.keys(s16RuntimeReaders).length); strings(value.configuration.runtime.retained, Object.keys(s16RuntimeReaders).length);
  const sourceNames = value.configuration.sources, current = [...value.configuration.runtime.selected, ...value.configuration.runtime.retained]; if (new Set(current).size !== current.length || current.some(name => !sourceNames.includes(name))) refuse();
  for (const required of ['conversation.sqlite', 'policy.sqlite', 'model.sqlite', 'work.sqlite', 'vm.sqlite', 'team.sqlite', 'memory.sqlite', 'owner.sqlite', 'owner-lifecycle.sqlite', 'recipients.sqlite']) if (!value.configuration.sources.includes(required)) refuse();
  if (!Array.isArray(value.components) || value.components.length !== 4 || new Set(value.components.map(row => object(row).role)).size !== 4) refuse();
  for (const component of value.components) { fields(component, 'role,contract,custody,bytes,sha256'); const role = component.role as S16PointRole; if (!Object.hasOwn(roles, role) || component.contract !== roles[role][0] || component.custody !== roles[role][1] || !nat(component.bytes, s16PointLimits.metadata) || !hex(component.sha256)) refuse(); }
  if (canonical(value.reconnection) !== canonical(s16PointReconnection)) refuse();
}

/**
 * Authenticates the complete fixed file inventory against a current receipt and hashes every byte.
 * It never boots an application, decodes native bodies, validates native ancestry or activates state.
 */
export function inspectS16PointFiles(root: string, expected: S16PointExpectation, guard: () => void): Readonly<S16PointInventory> {
  const current = () => { if ((guard() as unknown) !== undefined) refuse('s16_ops_guard_invalid'); }; current();
  if (!isAbsolute(root) || normalize(root) !== root || !opaque(expected.id) || !opaque(expected.operationId) || !hex(expected.manifestSha256) || !hex(expected.configurationSha256) || !hex(expected.cohortSha256)) refuse();
  identity(expected.requestId);
  const files: S16PointFile[] = [], byPath = new Map<string, S16PointFile>(), dirs: { scope: S16PointDirectoryScope; identity: string }[] = []; let metadataBytes = 0;
  const add = (scope: S16PointFileScope, name: string, bytes: number, sha256: string) => {
    if (!nat(bytes, 1073741824) || !hex(sha256)) refuse(); const path = s16PointMemberPath(root, expected.id, scope, name); if (byPath.has(path)) refuse(); const stat = s16PointEntry(path);
    if (stat.size !== BigInt(bytes)) refuse('s16_ops_point_changed'); const file = Object.freeze({ scope, name, bytes, sha256, identity: s16PointEntryIdentity(stat) }); files.push(file); byPath.set(path, file); return file;
  };
  const read = (scope: S16PointFileScope, name: string, digest: string, bytes?: number) => {
    const path = s16PointMemberPath(root, expected.id, scope, name), stat = s16PointEntry(path); if (stat.size > BigInt(s16PointLimits.metadata) || bytes !== undefined && stat.size !== BigInt(bytes)) refuse('s16_ops_point_bounds');
    const file = byPath.get(path) ?? add(scope, name, Number(stat.size), digest), data = opsRead(path, s16PointLimits.metadata);
    if (file.sha256 !== digest || data.length !== file.bytes || hash(data) !== digest || s16PointEntryIdentity(s16PointEntry(path)) !== file.identity) refuse('s16_ops_point_changed');
    metadataBytes += data.length; if (metadataBytes > s16PointLimits.metadata) refuse('s16_ops_point_bounds'); return data;
  };
  for (const scope of ['root', 'ledgers', 'ledger-data', 'payloads', 'payload-data'] as const) dirs.push(Object.freeze({ scope, identity: s16PointEntryIdentity(s16PointEntry(s16PointSubdirectory(root, expected.id, scope), true), true) }));
  const raw = read('metadata', 'manifest.json', expected.manifestSha256), point: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); validateManifest(point);
  if (raw.toString('utf8') !== s16RecoveryPointText(point) || point.id !== expected.id || point.installationId !== expected.installationId || point.configuration.ownerIdentity !== expected.ownerIdentity || point.configuration.sha256 !== expected.configurationSha256 || expected.capturedAt !== undefined && point.capturedAt !== expected.capturedAt) refuse();
  const component = (role: S16PointRole, scope: S16PointFileScope, name: string) => { const item = point.components.find(row => row.role === role)!; return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read(scope, name, item.sha256, item.bytes))); };
  const sql = component('ledgers', 'ledgers', 'manifest.json') as S16LedgerSet;
  fields(sql, 'contract,scope,validation,installationId,id,capturedAt,bytes,images');
  if (sql.contract !== 's16-ledger-set/v1' || sql.scope !== 'caller_selected_ledgers' || sql.validation !== 'sqlite_integrity_and_image_hashes' || sql.installationId !== expected.installationId || sql.id !== expected.id || !nat(sql.capturedAt) || !nat(sql.bytes, s16PointLimits.sql) || !Array.isArray(sql.images) || !sql.images.length || sql.images.length > 256 || s16LedgerSetManifestHash(sql) !== point.components.find(row => row.role === 'ledgers')!.sha256) refuse();
  let sqlBytes = 0;
  for (const image of sql.images) {
    fields(image, 'name,contract,validation,applicationId,readerVersion,journalMode,bytes,sha256');
    if (typeof image.name !== 'string' || !/^[a-z][a-z0-9_-]{0,63}\.sqlite$/.test(image.name) || image.contract !== 's16-ledger-image/v1' || image.validation !== 'header_and_hash' || !nat(image.applicationId, 0xffffffff) || !nat(image.readerVersion, 0xffffffff) || image.journalMode !== 'rollback' || !nat(image.bytes, 1073741824) || image.bytes < 512 || !hex(image.sha256)) refuse();
    sqlBytes += image.bytes; add('ledgers', image.name, image.bytes, image.sha256);
  }
  if (sqlBytes !== sql.bytes || JSON.stringify(sql.images.map(row => row.name).sort()) !== JSON.stringify([...point.configuration.sources].sort())) refuse();
  const payload = component('payloads', 'payloads', 'manifest.json') as S16PayloadSet;
  fields(payload, 'contract,scope,installationId,id,capturedAt,bytes,files');
  if (payload.contract !== 's16-payload-set/v1' || payload.scope !== 'caller_selected_payloads' || payload.installationId !== expected.installationId || payload.id !== expected.id || !nat(payload.capturedAt) || !nat(payload.bytes, s16PointLimits.payload) || !Array.isArray(payload.files) || payload.files.length > 20000 || s16PayloadSetManifestHash(payload) !== point.components.find(row => row.role === 'payloads')!.sha256) refuse();
  let payloadBytes = 0, fileCount = 0, githubCount = 0; const nativeFiles = new Set<string>(), catalogFiles = new Set<string>(), payloadByName = new Map<string, { bytes: number; sha256: string }>();
  for (const file of payload.files) {
    fields(file, 'name,bytes,sha256');
    if (typeof file.name !== 'string' || !nat(file.bytes, 1073741824) || !hex(file.sha256)) refuse(); payloadByName.set(file.name, { bytes: file.bytes, sha256: file.sha256 });
    if (/^file_[a-f0-9]{64}\.blob$/.test(file.name)) fileCount++;
    else if (/^github_bundle_[a-f0-9]{64}\.bundle$/.test(file.name)) githubCount++;
    else if (['native_plan.json', 'native_manifest.json'].includes(file.name) || /^native_[a-f0-9]{32}\.json$/.test(file.name)) nativeFiles.add(file.name);
    else if (['file_cohort.json', 'github_cohort.json'].includes(file.name)) catalogFiles.add(file.name);
    else refuse(); payloadBytes += file.bytes; add('payloads', file.name, file.bytes, file.sha256);
  }
  if (payloadBytes !== payload.bytes) refuse();
  const refs = component('references', 'metadata', 'references.json'); fields(refs, 'contract,installationId,helpers,external');
  if (refs.contract !== roles.references[0] || refs.installationId !== expected.installationId || object(refs.helpers).contract !== 's16-helper-cohort/v1' || object(refs.helpers).installationId !== expected.installationId || object(refs.external).contract !== 's16-external-custody/v1' || object(refs.external).installationId !== expected.installationId) refuse();
  const capture = component('capture', 'metadata', 'capture.json') as S16PointCaptureMetadata; fields(capture, 'contract,installationId,operationId,requestId,cohortSha256,native,files,github');
  if (capture.contract !== roles.capture[0] || capture.installationId !== expected.installationId || capture.operationId !== expected.operationId || capture.requestId !== expected.requestId || capture.cohortSha256 !== expected.cohortSha256) refuse(); identity(capture.requestId);
  fields(capture.files, 'sha256,files,pending,parserJobs'); fields(capture.github, 'sha256,bundles,correlations'); fields(capture.native, 'actionId,manifestSha256,planSha256,roots,pending');
  if (!hex(capture.files.sha256) || capture.files.files !== fileCount || !nat(capture.files.pending, 10000) || !nat(capture.files.parserJobs, 64) || !hex(capture.github.sha256) || capture.github.bundles !== githubCount || !nat(capture.github.correlations, 50000) || !hex(capture.native.planSha256) || !hex(capture.native.manifestSha256) || !nat(capture.native.roots, 20000) || !nat(capture.native.pending, 20000) || typeof capture.native.actionId !== 'string' || !/^native_set_[a-z0-9_]+_[a-f0-9]{64}$/.test(capture.native.actionId)) refuse();
  if (catalogFiles.size && catalogFiles.size !== 2) refuse();
  if (catalogFiles.size) {
    const fileCatalog = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read('payloads', 'file_cohort.json', capture.files.sha256)))), githubCatalog = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read('payloads', 'github_cohort.json', capture.github.sha256))));
    fields(fileCatalog, 'contract,installationId,present,files,pending,parser'); fields(githubCatalog, 'contract,installationId,present,namespace,lineage,bundles');
    if (fileCatalog.contract !== 's16-file-cohort/v1' || githubCatalog.contract !== 's16-github-artifact-cohort/v1' || fileCatalog.installationId !== expected.installationId || githubCatalog.installationId !== expected.installationId || !Array.isArray(fileCatalog.files) || fileCatalog.files.length !== fileCount || !Array.isArray(fileCatalog.pending) || fileCatalog.pending.length !== capture.files.pending || !Array.isArray(object(fileCatalog.parser).jobs) || (object(fileCatalog.parser).jobs as unknown[]).length !== capture.files.parserJobs || !Array.isArray(githubCatalog.bundles) || githubCatalog.bundles.length !== githubCount) refuse();
    const knownFiles = new Set<string>(); for (const row of fileCatalog.files) { const value = object(row), file = typeof value.name === 'string' && /^file_[a-f0-9]{64}\.blob$/.test(value.name) ? payloadByName.get(value.name) : undefined; if (!file || knownFiles.has(value.name as string) || file.bytes !== value.bytes || file.sha256 !== value.sha256) refuse(); knownFiles.add(value.name as string); }
    let correlations = 0; const knownBundles = new Set<string>();
    for (const row of githubCatalog.bundles) { const value = object(row), name = 'github_' + value.id + '.bundle', file = payloadByName.get(name); if (!file || knownBundles.has(name) || file.bytes !== value.bytes || file.sha256 !== value.sha256 || !Array.isArray(value.references)) refuse(); knownBundles.add(name); correlations += value.references.length; }
    if (correlations !== capture.github.correlations) refuse();
  }
  const plan = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read('payloads', 'native_plan.json', capture.native.planSha256)))), native = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(read('payloads', 'native_manifest.json', capture.native.manifestSha256))));
  if (plan.contract !== 's16-native-set-plan/v1' || native.contract !== 's16-native-set/v1' || plan.installationId !== expected.installationId || native.installationId !== expected.installationId || plan.operationId !== expected.operationId || native.operationId !== expected.operationId || plan.requestId !== capture.requestId || native.requestId !== capture.requestId || plan.kind !== 'backup' || native.actionId !== capture.native.actionId || native.planSha256 !== capture.native.planSha256 || !Array.isArray(plan.roots) || !Array.isArray(plan.pending) || !Array.isArray(native.roots) || plan.roots.length !== capture.native.roots || native.roots.length !== capture.native.roots || plan.pending.length !== capture.native.pending || !nat(native.bytes, s16PointLimits.payload)) refuse();
  const nativeIds = new Set<string>(); let nativeBytes = 0;
  for (const item of native.roots) {
    fields(item, 'id,name,bytes,sha256,identities,uncorrelated'); const name = 'native_' + item.id + '.json', file = payloadByName.get(name);
    if (!opaque(item.id) || item.name !== item.id + '.json' || nativeIds.has(item.id) || !file || file.sha256 !== item.sha256 || file.bytes !== item.bytes || !nat(item.identities, 64) || !nat(item.uncorrelated, item.identities)) refuse(); nativeIds.add(item.id); nativeBytes += file.bytes;
  }
  const planIds = new Set<string>(); for (const row of plan.roots) { const id = object(row).id; if (!opaque(id) || planIds.has(id)) refuse(); planIds.add(id); }
  if (nativeBytes !== native.bytes || nativeFiles.size !== nativeIds.size + 2 || planIds.size !== nativeIds.size || [...planIds].some(id => !nativeIds.has(id))) refuse();
  const actualFiles = new Set<string>(), actualDirs = new Set<string>();
  const walk = (path: string, relative: string, depth: number) => {
    if (depth > 2 || actualFiles.size + actualDirs.size > 20270) refuse('s16_ops_point_bounds'); s16PointEntry(path, true); actualDirs.add(relative);
    const dir = opendirSync(path); try { for (;;) { const item = dir.readSync(); if (!item) break; const child = join(path, item.name), rel = relative ? relative + '/' + item.name : item.name, stat = lstatSync(child);
      if (stat.isDirectory() && !stat.isSymbolicLink()) walk(child, rel, depth + 1); else { s16PointEntry(child); if (!byPath.has(child)) refuse('s16_ops_point_inventory_changed'); actualFiles.add(child); }
    } } finally { dir.closeSync(); }
  };
  const inventory = () => {
    actualFiles.clear(); actualDirs.clear(); walk(root, '', 0);
    if (actualFiles.size !== files.length || JSON.stringify([...actualDirs].sort()) !== JSON.stringify(['', 'ledgers', 'ledgers/' + expected.id, 'payloads', 'payloads/' + expected.id].sort())) refuse('s16_ops_point_inventory_changed');
  }; inventory();
  const bytes = files.reduce((total, file) => total + file.bytes, 0); if (bytes > s16PointLimits.bytes || expected.bytes !== undefined && expected.bytes !== bytes) refuse('s16_ops_point_bounds');
  current(); for (let at = 0; at < files.length; at += 20000) verifyS16PayloadSources(files.slice(at, at + 20000).map((file, index) => ({ name: 'point_' + (at + index), path: s16PointMemberPath(root, expected.id, file.scope, file.name), bytes: file.bytes, sha256: file.sha256 })), current);
  current(); inventory();
  for (const file of files) if (s16PointEntryIdentity(s16PointEntry(s16PointMemberPath(root, expected.id, file.scope, file.name))) !== file.identity) refuse('s16_ops_point_changed');
  for (const dir of dirs) if (s16PointEntryIdentity(s16PointEntry(s16PointSubdirectory(root, expected.id, dir.scope), true), true) !== dir.identity) refuse('s16_ops_point_changed'); current();
  return Object.freeze({ manifest: freeze(point), files: Object.freeze(files), directories: Object.freeze(dirs), bytes, metadataBytes, catalogs: catalogFiles.size ? 'present' : 'absent' });
}
