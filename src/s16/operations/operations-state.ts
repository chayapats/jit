import { lstatSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { AppError } from '../../errors';
import { opsPath, opsRead } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';

/** Fixed bounded current metadata; none of these limits permits evicting original unknown receipts. */
export const s16OperationsLimits = Object.freeze({ bytes: 4_194_304, requests: 256, requestBytes: 131_072, actions: 256, points: 10 });
/** Independent current installation/owner binding, outside every historical point. */
export interface S16OperationsBinding { readonly id: string; readonly installationId: string; readonly ownerIdentity: string }
/** Original current bootstrap intent at the existing owner admission-fence path; never archive authority. */
export interface S16OperationsAdoptionFence extends S16OperationsBinding {
  readonly contract: 's16-operations-adoption/v1'; readonly requestId: string; readonly configurationSha256: string; readonly createdAt: number;
}
/** An original durable physical boundary. Its metadata is never proof of execution or actor authority. */
export interface S16OperationsAction {
  id: string; kind: 'replace' | 'remove_point' | 'select_package' | 'capture_native' | 'capture_backend';
  priorSha256: string | null; targetSha256: string | null; state: 'intent' | 'confirmed' | 'unknown';
}
/** Deduplicated protected operation; unsettled states retain their original phase and request identity. */
export interface S16OperationsRequest {
  id: string; requestId: string; kind: 'backup' | 'export' | 'restore' | 'upgrade' | 'cleanup' | 'uninstall'; hash: string;
  phase: 'pending' | 'capturing' | 'verifying' | 'prepared' | 'activating' | 'complete' | 'discarded';
  status: 'running' | 'blocked' | 'unknown' | 'complete' | 'discarded'; pointId: string | null;
  cohortSha256: string | null; targetSha256: string | null; createdAt: number; updatedAt: number; revision: number;
  reason: string | null; actions: S16OperationsAction[];
}
/** Retained historical bytes; original operation receipts survive their later explicit removal. */
export interface S16OperationsPoint { id: string; sha256: string; bytes: number; createdAt: number; operationId: string; state: 'retained' | 'removing' }
/** Private current journal. It is never an ordinary export, historical authority or activation target. */
export interface S16OperationsControl extends S16OperationsBinding {
  contract: 's16-operations-control/v1'; revision: number;
  adoption: { requestId: string; configurationSha256: string; createdAt: number };
  requests: S16OperationsRequest[]; points: S16OperationsPoint[];
}
const phases = {
  backup: ['pending', 'capturing', 'verifying', 'complete'], export: ['pending', 'capturing', 'verifying', 'complete'],
  restore: ['pending', 'capturing', 'verifying', 'prepared', 'activating', 'complete'], upgrade: ['pending', 'capturing', 'verifying', 'prepared', 'activating', 'complete'],
  cleanup: ['pending', 'prepared', 'activating', 'complete'], uninstall: ['pending', 'prepared', 'activating', 'complete'],
} as const;
function refuse(): never { throw new AppError('s16_ops_control_invalid', 409); }
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const opaque = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const nat = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function fields(value: unknown, names: string): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== names.split(',').sort().join(',')) refuse();
}
/** Validates a current binding without assigning it from an archive or exposing owner authentication. */
export function validateS16OperationsBinding(value: unknown): asserts value is S16OperationsBinding {
  fields(value, 'id,installationId,ownerIdentity');
  if (!opaque(value.id) || typeof value.ownerIdentity !== 'string' || !value.ownerIdentity || value.ownerIdentity.length > 128 || value.ownerIdentity.includes('\0')) refuse();
  identity(value.installationId);
}
/** Validates only the exact bounded adoption intent; normal application admission still refuses it. */
export function validateS16OperationsAdoptionFence(value: unknown): asserts value is S16OperationsAdoptionFence {
  fields(value, 'contract,id,installationId,ownerIdentity,requestId,configurationSha256,createdAt');
  validateS16OperationsBinding({ id: value.id, installationId: value.installationId, ownerIdentity: value.ownerIdentity }); identity(value.requestId);
  if (value.contract !== 's16-operations-adoption/v1' || !sha(value.configurationSha256) || !nat(value.createdAt)) refuse();
}
/** Validates the complete bounded metadata and cross-references; it does not execute or authorize any action. */
export function validateS16OperationsControl(value: unknown): asserts value is S16OperationsControl {
  fields(value, 'contract,id,installationId,ownerIdentity,revision,adoption,requests,points');
  validateS16OperationsBinding({ id: value.id, installationId: value.installationId, ownerIdentity: value.ownerIdentity });
  if (value.contract !== 's16-operations-control/v1' || !nat(value.revision)) refuse();
  fields(value.adoption, 'requestId,configurationSha256,createdAt'); identity(value.adoption.requestId);
  if (!sha(value.adoption.configurationSha256) || !nat(value.adoption.createdAt) || !Array.isArray(value.requests) || value.requests.length > s16OperationsLimits.requests || !Array.isArray(value.points) || value.points.length > s16OperationsLimits.points) refuse();
  const requestIds = new Set<string>(), operationIds = new Set<string>(); let active = 0, bytes = 0;
  for (const request of value.requests) {
    fields(request, 'id,requestId,kind,hash,phase,status,pointId,cohortSha256,targetSha256,createdAt,updatedAt,revision,reason,actions');
    identity(request.requestId);
    if (!opaque(request.id) || operationIds.has(request.id) || requestIds.has(request.requestId as string) || typeof request.kind !== 'string' || !Object.hasOwn(phases, request.kind) || !sha(request.hash) ||
      typeof request.phase !== 'string' || request.phase !== 'discarded' && !(phases[request.kind as keyof typeof phases] as readonly string[]).includes(request.phase) ||
      !['running', 'blocked', 'unknown', 'complete', 'discarded'].includes(request.status as string) || request.pointId !== null && !opaque(request.pointId) ||
      request.cohortSha256 !== null && !sha(request.cohortSha256) || request.targetSha256 !== null && !sha(request.targetSha256) ||
      !nat(request.createdAt) || !nat(request.updatedAt) || request.updatedAt < request.createdAt || !nat(request.revision) || request.revision < 1 || request.revision > value.revision ||
      request.reason !== null && (typeof request.reason !== 'string' || !/^s16_ops_[a-z0-9_]{1,64}$/.test(request.reason)) || !Array.isArray(request.actions) || request.actions.length > s16OperationsLimits.actions) refuse();
    if ((request.phase === 'complete') !== (request.status === 'complete') || (request.phase === 'discarded') !== (request.status === 'discarded')) refuse();
    const actions = new Set<string>(); let unsettled = false, unknown = false;
    for (const action of request.actions) {
      fields(action, 'id,kind,priorSha256,targetSha256,state'); identity(action.id);
      if (actions.has(action.id as string) || !['replace', 'remove_point', 'select_package', 'capture_native', 'capture_backend'].includes(action.kind as string) ||
        action.priorSha256 !== null && !sha(action.priorSha256) || action.targetSha256 !== null && !sha(action.targetSha256) || !['intent', 'confirmed', 'unknown'].includes(action.state as string) ||
        ['replace', 'select_package'].includes(action.kind as string) && action.targetSha256 === null) refuse();
      actions.add(action.id as string); unsettled ||= action.state !== 'confirmed'; unknown ||= action.state === 'unknown';
    }
    if (unsettled && ['complete', 'discarded'].includes(request.status as string) || unknown && !['unknown', 'blocked'].includes(request.status as string)) refuse();
    if (!['complete', 'discarded'].includes(request.status as string)) active++;
    if (['backup', 'restore', 'cleanup'].includes(request.kind) && !opaque(request.pointId) || request.phase === 'complete' && (!sha(request.cohortSha256) || !sha(request.targetSha256))) refuse();
    if (['restore', 'upgrade'].includes(request.kind) && ['prepared', 'activating', 'complete'].includes(request.phase) && (!sha(request.cohortSha256) || !sha(request.targetSha256))) refuse();
    const measured = Buffer.byteLength(canonical(request)); bytes += measured; if (measured > s16OperationsLimits.requestBytes || bytes > s16OperationsLimits.bytes) refuse();
    operationIds.add(request.id); requestIds.add(request.requestId as string);
  }
  if (active > 1) refuse();
  const pointIds = new Set<string>();
  for (const point of value.points) {
    fields(point, 'id,sha256,bytes,createdAt,operationId,state');
    if (!opaque(point.id) || pointIds.has(point.id) || !sha(point.sha256) || !nat(point.bytes) || point.bytes > 6_442_450_944 || !nat(point.createdAt) || !opaque(point.operationId) || !['retained', 'removing'].includes(point.state as string)) refuse();
    const request = value.requests.find((row: S16OperationsRequest) => row.id === point.operationId) as S16OperationsRequest | undefined;
    if (!request || request.kind !== 'backup' || !['verifying', 'complete'].includes(request.phase) || request.pointId !== point.id || request.targetSha256 !== point.sha256) refuse(); pointIds.add(point.id);
  }
  if (Buffer.byteLength(canonical(value)) > s16OperationsLimits.bytes) refuse();
}
function privateEntry(path: string, directory = false): BigIntStats {
  opsPath(path); const stat = lstatSync(path, { bigint: true }), uid = process.getuid?.();
  if (uid === undefined || stat.uid !== BigInt(uid) || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) || stat.mode & (directory ? 0o7077n : 0o7177n)) refuse();
  return stat;
}
/** Reads only the fixed existing current journal. Missing/corrupt/linked state is never initialized or repaired. */
export function readS16OperationsControl(directory: string): S16OperationsControl {
  try {
    if (!isAbsolute(directory) || normalize(directory) !== directory) refuse();
    privateEntry(directory, true); privateEntry(join(directory, 'operations'), true);
    const path = join(directory, 'operations/control.json'), before = privateEntry(path), text = opsRead(path, s16OperationsLimits.bytes).toString('utf8');
    const value: unknown = JSON.parse(text); validateS16OperationsControl(value);
    const after = privateEntry(path);
    if (canonical(value) !== text || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) refuse();
    return value;
  } catch { return refuse(); }
}
/** Reads only a private original adoption fence; torn/foreign/substituted intent never grants access. */
export function readS16OperationsAdoptionFence(directory: string): S16OperationsAdoptionFence {
  try {
    if (!isAbsolute(directory) || normalize(directory) !== directory) refuse();
    const parent = join(directory, 'owner/owner.sqlite.ops'), path = join(parent, 'fence.json');
    privateEntry(directory, true); privateEntry(join(directory, 'owner'), true); privateEntry(parent, true);
    const before = privateEntry(path), text = opsRead(path, 4096).toString('utf8'), value: unknown = JSON.parse(text); validateS16OperationsAdoptionFence(value);
    const after = privateEntry(path);
    if (canonical(value) !== text || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) refuse();
    return value;
  } catch { return refuse(); }
}
