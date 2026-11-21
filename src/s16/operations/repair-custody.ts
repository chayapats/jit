import { lstatSync } from 'node:fs';
import { dirname, isAbsolute, join, normalize, relative } from 'node:path';
import { createHash } from 'node:crypto';
import { AppError } from '../../errors';
import { opsPath, opsRead } from '../../s14/ops-files';
import type { S15RuntimeConfig } from '../../s15/runtime-config';
import type { S16ControlMaintenance } from './control-maintenance';
import type { S16ForwardCurrentCohort } from './forward-current-cohort';
import type { S16RecoveryStage } from './recovery-staging';
import { s16PointEntry, s16PointEntryIdentity } from './point-files';
import { s16RecoveryNames as names } from './recovery-usage';
import { inspectS16RepairFile, type S16RepairFile } from './repair-files';

/** Protected repair roles only; an archive never supplies a current destination or parent. */
export type S16RepairDomain = 'file' | 'github';
/** Path-free member of an independently current-journal-bound immutable repair plan. */
export interface S16RepairMember {
  domain: S16RepairDomain; name: string; sourceName: string; sourceIdentity: string; bytes: number; sha256: string; tempName: string; tempIdentity: string;
}
/** Original parent identity; creation from a prior current absence needs its own independent receipt. */
export interface S16RepairParent { domain: S16RepairDomain; identity: string; created: boolean }
/** Current authority and original per-member filesystem transitions, never history-derived grants. */
export interface S16ForwardRepairPlan {
  contract: 's16-forward-payload-repair/v1'; operationsId: string; installationId: string; ownerIdentity: string; operationId: string; requestId: string;
  configurationSha256: string; admittedRevision: number; capturedAt: number; pointId: string; pointSha256: string; cohortSha256: string; stageSha256: string;
  parents: S16RepairParent[]; members: S16RepairMember[];
}
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
function refuse(code = 's16_ops_repair_custody_invalid'): never { throw new AppError(code, 409); }
/** Uses only the actual current installation's two fixed immutable-byte namespaces. */
export function s16RepairParentPath(config: S15RuntimeConfig, domain: S16RepairDomain): string {
  if (domain === 'file') return join(config.directory, 'runtime/file-bytes');
  if (domain === 'github') return join(config.directory, 'github-artifacts');
  return refuse();
}
/** Resolves a validated current logical name and original temp identity; no archive path participates. */
export function s16RepairMemberPaths(config: S15RuntimeConfig, plan: S16ForwardRepairPlan, member: S16RepairMember): S16RepairFile {
  const parent = plan.parents.find(row => row.domain === member.domain), root = s16RepairParentPath(config, member.domain);
  if (!parent || !member.name || member.name === '.' || member.name === '..' || /[\/\\\0]/.test(member.name) || !/^\.jit-recovery-[a-f0-9]{32}-[a-f0-9]{5}\.tmp$/.test(member.tempName)) refuse();
  return { target: join(root, member.name), temp: join(root, member.tempName), parentIdentity: parent.identity, tempIdentity: member.tempIdentity, bytes: member.bytes, sha256: member.sha256 };
}
/** Reads only a complete independently confirmed original current record, not self-authenticating JSON. */
export function readS16OriginalCurrentCohort(context: S16ControlMaintenance, stage: S16RecoveryStage, requestId: string): { value: S16ForwardCurrentCohort; sha256: string } {
  context.assertCurrent(); stage.assertCurrent(); const control = context.operations().read(), request = control.requests.find(row => row.requestId === requestId);
  const actions = request?.actions.filter(row => row.id.startsWith('current_cohort_')) ?? [];
  if (!request || actions.length !== 1 || actions[0]!.kind !== 'capture_backend' || actions[0]!.state !== 'confirmed' || !actions[0]!.targetSha256 || actions[0]!.observedSha256 !== actions[0]!.targetSha256) refuse('s16_ops_current_cohort_incomplete');
  const path = join(stage.root, 'current.json'), stat = s16PointEntry(path); if (stat.size > 67108864n) refuse('s16_ops_current_cohort_bounds');
  const bytes = opsRead(path, 67108864), sha256 = hash(bytes);
  if (bytes.length !== Number(stat.size) || s16PointEntryIdentity(stat) !== s16PointEntryIdentity(s16PointEntry(path)) || sha256 !== actions[0]!.targetSha256 || actions[0]!.id !== 'current_cohort_' + sha256) refuse();
  const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as S16ForwardCurrentCohort;
  if (!value || value.contract !== 's16-forward-current-cohort/v1' || value.operationsId !== control.id || value.installationId !== control.installationId || value.ownerIdentity !== control.ownerIdentity || value.operationId !== request.id || value.requestId !== requestId || value.configurationSha256 !== request.configurationSha256 || value.admittedRevision !== request.admittedRevision || value.capturedAt !== request.createdAt || value.stageSha256 !== stage.scopeSha256 || actions[0]!.priorSha256 !== value.sql?.manifestSha256 || !Array.isArray(value.sql?.manifest?.images) || value.sql.manifest.images.length > 256 || !Array.isArray(value.file?.entries) || !Array.isArray(value.github?.entries) || value.file.entries.length + value.github.entries.length > 50000) refuse();
  context.assertCurrent(); stage.assertCurrent(); return { value, sha256 };
}
/**
 * Rechecks all original current byte identities and exact namespace membership, allowing only this
 * independently authenticated plan's own temp/target transitions. It does not authenticate the plan,
 * settle publication or replace complete SQL/native/helper/external/package verification.
 */
export function assertS16RepairPhysicalCustody(config: S15RuntimeConfig, current: S16ForwardCurrentCohort, plan: S16ForwardRepairPlan, guard: () => void): void {
  const check = () => { if ((guard() as unknown) !== undefined) refuse('s16_ops_guard_invalid'); }; check();
  const roots = [s16RepairParentPath(config, 'file'), join(config.directory, 'runtime/file-parser'), s16RepairParentPath(config, 'github')];
  const sqlAbsences = new Set(['github.sqlite', 'disclosure.sqlite'].map(name => join(config.directory, 'runtime', name)));
  const allowed = (path: string) => isAbsolute(path) && normalize(path) === path && roots.some(root => { const suffix = relative(root, path); return suffix === '' || suffix !== '..' && !suffix.startsWith('../') && !isAbsolute(suffix); });
  const entries = [...current.file.entries, ...current.github.entries], observed = new Map<string, { kind: string; identity: string | null }>(), expectedNames = new Map<string, Set<string>>();
  const addName = (path: string) => { const children = expectedNames.get(dirname(path)) ?? new Set<string>(); children.add(path.slice(dirname(path).length + 1)); expectedNames.set(dirname(path), children); };
  for (const row of entries) {
    if ((!allowed(row.path) && !(row.kind === 'absent' && sqlAbsences.has(row.path))) || observed.has(row.path)) refuse(); observed.set(row.path, { kind: row.kind, identity: row.sha256 }); if (row.kind !== 'absent') addName(row.path);
    if (row.kind === 'directory' && !expectedNames.has(row.path)) expectedNames.set(row.path, new Set());
  }
  const transitionPaths = new Set<string>();
  for (const parent of plan.parents) {
    const path = s16RepairParentPath(config, parent.domain), original = observed.get(path);
    if (!original || (parent.created ? original.kind !== 'absent' : original.kind !== 'directory' || original.identity !== parent.identity) || s16PointEntryIdentity(s16PointEntry(path, true), true) !== parent.identity) refuse('s16_ops_repair_parent_changed');
    transitionPaths.add(path); if (!expectedNames.has(path)) expectedNames.set(path, new Set());
  }
  for (const member of plan.members) {
    const paths = s16RepairMemberPaths(config, plan, member), original = observed.get(paths.target);
    if (!original || original.kind !== 'absent' || transitionPaths.has(paths.target) || transitionPaths.has(paths.temp)) refuse();
    const state = inspectS16RepairFile(paths); transitionPaths.add(paths.target); transitionPaths.add(paths.temp);
    if (state.temp) addName(paths.temp); if (state.target) addName(paths.target);
  }
  for (const row of entries) {
    if (transitionPaths.has(row.path)) continue; opsPath(row.path); const stat = lstatSync(row.path, { bigint: true, throwIfNoEntry: false });
    if (row.kind === 'absent') { if (stat) refuse('s16_ops_repair_original_changed'); continue; }
    const entry = s16PointEntry(row.path, row.kind === 'directory');
    if (s16PointEntryIdentity(entry, row.kind === 'directory') !== row.sha256) refuse('s16_ops_repair_original_changed');
  }
  for (const [path, wanted] of expectedNames) {
    if (!allowed(path)) continue;
    if (names(path, 20001).join('\0') !== [...wanted].sort().join('\0')) refuse('s16_ops_repair_namespace_changed');
  }
  check();
}
/** Fresh complete owning byte readers must see precisely original custody plus the repaired current pins. */
export function assertS16RepairedByteCatalogs(context: S16ControlMaintenance, current: S16ForwardCurrentCohort, plan: S16ForwardRepairPlan): void {
  const file = context.currentFileCustody(), github = context.currentGithubCustody(), before = current.file.value, after = file.value;
  const expected = new Map(before.files.map(row => [row.name, row]));
  for (const missing of before.missing) expected.set('file_' + hash('data/' + missing.name) + '.blob', { name: 'file_' + hash('data/' + missing.name) + '.blob', role: missing.role, trust: 'owning_pinned', rowId: missing.rowId, jobId: null, state: missing.role === 'artifact' ? 'artifact_metadata' : 'ready', bytes: missing.bytes, sha256: missing.sha256 });
  if (after.missing.length || after.present !== before.present || JSON.stringify(after.pending) !== JSON.stringify(before.pending) || JSON.stringify(after.parser) !== JSON.stringify(before.parser) || after.files.length !== expected.size || after.files.some(row => JSON.stringify(row) !== JSON.stringify(expected.get(row.name)))) refuse('s16_ops_repair_catalog_changed');
  const old = current.github.value, actual = github.value, bundles = new Map(old.bundles.map(row => [row.id, row]));
  for (const missing of old.missing) { const member = plan.members.find(row => row.domain === 'github' && row.name === missing.id); if (!member) refuse(); bundles.set(missing.id, { id: missing.id, bytes: member.bytes, sha256: missing.sha256, references: missing.references }); }
  if (actual.missing.length || actual.present !== old.present || actual.lineage !== old.lineage || actual.namespace !== (old.namespace || plan.parents.some(row => row.domain === 'github')) || actual.bundles.length !== bundles.size || actual.bundles.some(row => JSON.stringify(row) !== JSON.stringify(bundles.get(row.id)))) refuse('s16_ops_repair_catalog_changed');
  // The strict complete backup readers must now succeed as well; no repair-temp allowance is introduced.
  context.fileCustody().assertCurrent(); context.githubArtifacts().assertCurrent();
}
