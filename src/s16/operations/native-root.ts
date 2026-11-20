import { createHash } from 'node:crypto';
import { lstatSync, mkdirSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, normalize, relative } from 'node:path';
import { createHost, hostCapabilities, MAX_SNAPSHOT_SESSIONS, MAX_SNAPSHOT_TOTAL_BYTES, RELEASE_CONTRACT, SNAPSHOT_CONTRACT, SNAPSHOT_NATIVE_FORMAT_VERSION, type HostRuntime, type HostSessionInventoryEntry, type HostSessionReference, type HostSessionSnapshot } from 'schway/host';
import { AppError } from '../../errors';
import { opsPath, opsSyncDirectory } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import type { S16NativeManagementCustody } from './native-namespace';

/** Public snapshot decoded bound plus base64/envelope overhead, checked before reading stored bytes. */
export const s16NativeRootByteLimit = Math.ceil(MAX_SNAPSHOT_TOTAL_BYTES / 3) * 4 + 1_048_576;
const encodedBound = s16NativeRootByteLimit;
const uuid = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value);
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
function refuse(code = 's16_ops_native_invalid'): never { throw new AppError(code, 409); }
function references(value: unknown): asserts value is HostSessionReference[] {
  if (!Array.isArray(value) || value.length > MAX_SNAPSHOT_SESSIONS) refuse('s16_ops_native_bounds');
  const ids = new Set<string>();
  for (const ref of value) {
    if (!ref || Object.keys(ref).sort().join(',') !== 'branchId,id' || !uuid(ref.id) || ids.has(ref.id) || typeof ref.branchId !== 'string' || !ref.branchId || ref.branchId.length > 128 || /[\0\r\n]/.test(ref.branchId)) refuse();
    ids.add(ref.id);
  }
  canonical(value);
}
function inventory(value: unknown): asserts value is HostSessionInventoryEntry[] {
  if (!Array.isArray(value) || value.length > MAX_SNAPSHOT_SESSIONS) refuse('s16_ops_native_bounds');
  let prior = '';
  for (const entry of value) {
    if (!entry || Object.keys(entry).sort().join(',') !== 'reference,state' || !['active', 'retired', 'deleted'].includes(entry.state)) refuse();
    references([entry.reference]);
    if (entry.reference.branchId !== 'main' || entry.reference.id <= prior) refuse(); prior = entry.reference.id;
  }
  canonical(value);
}
function management(value: unknown): asserts value is S16NativeManagementCustody {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'kind,ownerId,phase,vm') refuse();
  const row = value as S16NativeManagementCustody; identity(row.ownerId);
  if (!['chat', 'model', 'github'].includes(row.kind)) refuse();
  if (row.kind === 'chat') {
    if (typeof row.phase !== 'string' || row.phase !== 'work' && (!/^interpretation_[1-9][0-9]{0,15}$/.test(row.phase) || !Number.isSafeInteger(Number(row.phase.slice(15)))) || row.vm !== null) refuse();
  } else if (row.phase !== null || row.kind === 'model' && row.vm !== null) refuse();
  if (row.kind !== 'github') return;
  const vm = row.vm;
  if (!vm || Object.keys(vm).sort().join(',') !== 'attemptId,generation,sessionId,state,vmId,workId') refuse();
  for (const field of [vm.sessionId, vm.vmId, vm.workId]) identity(field);
  if (row.ownerId !== vm.attemptId || !/^github_[a-f0-9]{32}$/.test(vm.attemptId) || !['opening', 'active', 'stopping', 'closed', 'unknown'].includes(vm.state) || !Number.isSafeInteger(vm.generation) || vm.generation < 1) refuse();
}
/** Trusted existing root/correlations only. The aggregate owner must enumerate every required root. */
export interface S16NativeRootOptions {
  directory: string; installationId: string; id: string; references: readonly HostSessionReference[];
  /** Known owning intent; discovery adds management custody while retaining the exact saved subset. */
  custody?: Readonly<S16NativeManagementCustody>;
  /** Owning resource registration before the final opener guard; retain it even if open/close rejects. */
  retain?(capability: S16NativeRootMaintenance): void;
  guard(): void; now?(): number;
}
/** Full lifecycle inventory with explicit unresolved custody; none of these observations grant execution. */
export interface S16NativeInspection {
  readonly inventory: readonly HostSessionInventoryEntry[];
  readonly missing: readonly HostSessionReference[];
  readonly uncorrelated: readonly HostSessionInventoryEntry[];
}
/** Private opaque bytes; only the independent current receipt supplies verification provenance. */
export interface S16NativeCapture { readonly bytes: Uint8Array; readonly sha256: string }
/** No creation/open/run/live-restore methods or raw host escape from this protected inspection capability. */
export interface S16NativeRootMaintenance {
  inspect(): Promise<S16NativeInspection>;
  capture(): Promise<S16NativeCapture>;
  verify(bytes: Uint8Array, expectedSha256: string): void;
  /** Deep public native-format/ancestry verification in an exclusive fresh quarantine, never live activation. */
  verifyQuarantine(bytes: Uint8Array, expectedSha256: string, directory: string): Promise<void>;
  close(): Promise<void>;
}
/**
 * Opens only an existing owning native root with a metadata-only public host. It never creates missing
 * directories or correlates an orphan by inference. Caller retains the aggregate maintenance fence.
 */
export async function openS16NativeRoot(options: S16NativeRootOptions): Promise<S16NativeRootMaintenance> {
  const { installationId, id, directory, guard: currentGuard, now = Date.now } = options;
  identity(installationId);
  if (!/^[a-f0-9]{32}$/.test(id) || !isAbsolute(directory) || normalize(directory) !== directory) refuse();
  references(options.references); const expected = JSON.parse(canonical(options.references)) as HostSessionReference[];
  const custody = options.custody ? JSON.parse(canonical(options.custody)) as S16NativeManagementCustody : null;
  if (custody) { management(custody); if (custody.vm) Object.freeze(custody.vm); Object.freeze(custody); }
  expected.sort((a, b) => a.id.localeCompare(b.id)); expected.forEach(ref => Object.freeze(ref)); Object.freeze(expected);
  const paths = { workspaceRoot: join(directory, 'workspace'), homeDirectory: join(directory, 'home'), sessionDirectory: join(directory, 'sessions') };
  const entries = new Map<string, BigIntStats>(); let closed = false, usable = true, inFlight = 0;
  const entry = (path: string) => {
    opsPath(path); const stat = lstatSync(path, { bigint: true }), uid = process.getuid?.();
    if (uid === undefined || !stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(uid) || stat.mode & 0o7077n) refuse('s16_ops_path_untrusted'); return stat;
  };
  const guard = () => {
    if (closed || !usable) refuse('s16_ops_native_closed'); if ((currentGuard() as unknown) !== undefined) refuse('s16_ops_guard_invalid');
    for (const [path, before] of entries) { const current = entry(path); if (current.dev !== before.dev || current.ino !== before.ino || current.mode !== before.mode || current.uid !== before.uid) refuse('s16_ops_native_changed'); }
  };
  guard();
  try { for (const path of [directory, ...Object.values(paths)]) entries.set(path, entry(path)); } catch { refuse('s16_ops_native_unavailable'); }
  const capabilities = hostCapabilities();
  if (capabilities.releaseContract !== RELEASE_CONTRACT || capabilities.snapshotContract !== SNAPSHOT_CONTRACT || capabilities.sessionInventoryContract !== 'schway.host.session-inventory/v1') refuse('s16_ops_native_unsupported');
  const host: HostRuntime = await createHost({ ...paths, context: { policy: 'strict', systemPrompt: 'Protected metadata inspection only.', sections: [] },
    tools: { policy: 'exact', definitions: [], hostedLookup: 'off' }, limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 1, contextWindow: 32768, maxInputChars: 1024, deadlineMs: 1000 } });
  const quarantines = new Set<HostRuntime>();
  const release = async (target: HostRuntime) => {
    try { await target.close(); quarantines.delete(target); }
    catch { usable = false; return refuse('s16_ops_source_release_unknown'); }
  };
  const close = async () => {
    if (closed) return; usable = false;
    // Public host disposal alone does not certify that our outstanding inventory/copy promise settled.
    // Keep the owning coordinator's exclusion until that exact operation completes and close is retried.
    if (inFlight) refuse('s16_ops_native_busy');
    for (const target of quarantines) await release(target);
    try { await host.close(); } catch { return refuse('s16_ops_source_release_unknown'); } closed = true;
  };
  const sweep = async () => {
    guard(); const page = await host.listSessions({ limit: MAX_SNAPSHOT_SESSIONS }); guard(); inventory(page.sessions);
    if (page.next !== undefined) refuse('s16_ops_native_bounds');
    const rows = JSON.parse(canonical(page.sessions)) as HostSessionInventoryEntry[];
    rows.forEach(row => { Object.freeze(row.reference); Object.freeze(row); }); return rows;
  };
  const inspect = async (): Promise<S16NativeInspection> => {
    const first = await sweep(), second = await sweep(); if (canonical(first) !== canonical(second)) refuse('s16_ops_native_changed');
    const saved = new Set(expected.map(ref => ref.id)), found = new Set(first.map(row => row.reference.id));
    return Object.freeze({ inventory: Object.freeze(first), missing: Object.freeze(expected.filter(ref => !found.has(ref.id))), uncorrelated: Object.freeze(first.filter(row => !saved.has(row.reference.id))) });
  };
  const check = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) refuse();
    const envelope = value as { contract: string; id: string; installationId: string; capturedAt: number; workspaceRoot: string; references: HostSessionReference[]; inventory: HostSessionInventoryEntry[]; snapshot: HostSessionSnapshot | null; referenceKind?: string; custody?: S16NativeManagementCustody; savedReferences?: HostSessionReference[] };
    const managed = envelope.contract === 's16-native-root/v2';
    if (Object.keys(value).sort().join(',') !== (managed ? 'capturedAt,contract,custody,id,installationId,inventory,referenceKind,references,savedReferences,snapshot,workspaceRoot' : 'capturedAt,contract,id,installationId,inventory,references,snapshot,workspaceRoot')) refuse();
    if (!['s16-native-root/v1', 's16-native-root/v2'].includes(envelope.contract) || envelope.id !== id || envelope.installationId !== installationId || envelope.workspaceRoot !== paths.workspaceRoot || !Number.isSafeInteger(envelope.capturedAt) || envelope.capturedAt < 0) refuse();
    if (managed) {
      management(envelope.custody); if (!custody || envelope.referenceKind !== 'current_custody') refuse();
      for (const field of ['kind', 'ownerId', 'phase'] as const) if (envelope.custody![field] !== custody[field]) refuse();
      if (custody.vm) for (const field of ['sessionId', 'vmId', 'workId', 'attemptId'] as const) if (envelope.custody!.vm![field] !== custody.vm[field]) refuse();
    } else if (custody) refuse();
    references(envelope.references); inventory(envelope.inventory);
    if (managed) {
      references(envelope.savedReferences);
      const saved = new Map(envelope.savedReferences!.map(ref => [ref.id, ref.branchId]));
      if (envelope.savedReferences!.some(ref => !envelope.references.some(selected => selected.id === ref.id && selected.branchId === ref.branchId)) || envelope.references.some(ref => ref.branchId !== (saved.get(ref.id) ?? 'main'))) refuse();
    }
    if (envelope.references.length !== envelope.inventory.length || envelope.references.some((ref, index) => ref.id !== envelope.inventory[index]!.reference.id)) refuse();
    const live = envelope.references.filter(ref => envelope.inventory.find(row => row.reference.id === ref.id)!.state !== 'deleted');
    if (!live.length) { if (envelope.snapshot !== null) refuse(); return; }
    const snapshot = envelope.snapshot; if (!snapshot) refuse();
    const verdict = host.validateSessionSnapshot(snapshot);
    if (verdict.status !== 'valid' || snapshot.snapshotContract !== SNAPSHOT_CONTRACT || snapshot.nativeFormatVersion !== SNAPSHOT_NATIVE_FORMAT_VERSION || canonical(verdict.sessions) !== canonical(live)) refuse();
    for (const session of snapshot.sessions) {
      const state = envelope.inventory.find(row => row.reference.id === session.id)?.state;
      if (session.workspaceRoot !== paths.workspaceRoot || session.retired !== (state === 'retired')) refuse();
    }
  };
  const run = async <T>(work: () => Promise<T>): Promise<T> => { guard(); inFlight++; try { return await work(); } finally { inFlight--; } };
  const verified = (bytes: Uint8Array, expectedSha256: string) => {
    guard(); if (!(bytes instanceof Uint8Array) || bytes.byteLength > encodedBound || !/^[a-f0-9]{64}$/.test(expectedSha256)) refuse();
    const retained = Buffer.from(bytes); if (hash(retained) !== expectedSha256) refuse();
    let value: { snapshot: HostSessionSnapshot | null };
    try { value = JSON.parse(retained.toString('utf8')); check(value); } catch { return refuse(); } guard(); return value;
  };
  const capability = Object.freeze<S16NativeRootMaintenance>({ inspect: () => run(inspect), capture: () => run(async () => {
    const current = await inspect(); if (current.missing.length || !custody && current.uncorrelated.length) refuse('s16_ops_native_reconciliation_required');
    const saved = new Map(expected.map(ref => [ref.id, ref]));
    const selected = custody ? current.inventory.map(row => saved.get(row.reference.id) ?? row.reference) : expected;
    const live = selected.filter(ref => current.inventory.find(row => row.reference.id === ref.id)!.state !== 'deleted');
    guard(); const snapshot = live.length ? await host.snapshotSessions(live, { excludeRetired: false }) : null; guard();
    if (canonical(await sweep()) !== canonical(current.inventory)) refuse('s16_ops_native_changed');
    const capturedAt = now();
    const value = { contract: custody ? 's16-native-root/v2' : 's16-native-root/v1', id, installationId, capturedAt, workspaceRoot: paths.workspaceRoot, references: selected, inventory: current.inventory, snapshot,
      ...(custody ? { referenceKind: 'current_custody', custody, savedReferences: expected } : {}) }; check(value);
    const text = JSON.stringify(value); if (Buffer.byteLength(text) > encodedBound) refuse('s16_ops_native_bounds'); const bytes = Buffer.from(text); guard();
    return Object.freeze({ bytes, sha256: hash(bytes) });
  }), verify(bytes, expectedSha256) { verified(bytes, expectedSha256); }, verifyQuarantine: (bytes, expectedSha256, parent) => run(async () => {
    const value = verified(bytes, expectedSha256);
    if (typeof parent !== 'string' || !isAbsolute(parent) || normalize(parent) !== parent) refuse('s16_ops_path_untrusted');
    const within = (a: string, b: string) => { const path = relative(a, b); return path === '' || !path.startsWith('../') && path !== '..' && !isAbsolute(path); };
    if (within(directory, parent) || within(parent, directory)) refuse('s16_ops_path_untrusted');
    const parentEntry = entry(parent); if (!value.snapshot) { guard(); return; }
    const target = join(parent, id); try { mkdirSync(target, { mode: 0o700 }); } catch { return refuse('s16_ops_point_unavailable'); }
    opsSyncDirectory(parent); const targetEntry = entry(target);
    const stageCurrent = () => {
      guard(); for (const [path, before] of [[parent, parentEntry], [target, targetEntry]] as const) {
        const current = entry(path); if (current.dev !== before.dev || current.ino !== before.ino || current.mode !== before.mode || current.uid !== before.uid) refuse('s16_ops_native_changed');
      }
    }; stageCurrent();
    for (const part of ['home', 'sessions']) mkdirSync(join(target, part), { mode: 0o700 }); opsSyncDirectory(target);
    const native = await createHost({ workspaceRoot: paths.workspaceRoot, homeDirectory: join(target, 'home'), sessionDirectory: join(target, 'sessions'),
      context: { policy: 'strict', systemPrompt: 'Protected native quarantine verification only.', sections: [] }, tools: { policy: 'exact', definitions: [], hostedLookup: 'off' },
      limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 1, contextWindow: 32768, maxInputChars: 1024, deadlineMs: 1000 } }); quarantines.add(native);
    try {
      stageCurrent(); const result = await native.restoreSessionSnapshot(value.snapshot, { excludeRetired: false }); stageCurrent();
      const expectedRefs = value.snapshot.sessions.map(session => ({ id: session.id, branchId: session.branchId }));
      if (result.status !== 'restored') refuse('s16_ops_native_quarantined'); references(result.sessions);
      if (canonical([...result.sessions].sort((a, b) => a.id.localeCompare(b.id))) !== canonical(expectedRefs.sort((a, b) => a.id.localeCompare(b.id)))) refuse('s16_ops_native_quarantined');
      const observed = await native.listSessions({ limit: MAX_SNAPSHOT_SESSIONS }); stageCurrent(); inventory(observed.sessions);
      if (observed.next !== undefined || observed.sessions.length !== value.snapshot.sessions.length || observed.sessions.some(row => {
        const expected = value.snapshot!.sessions.find(session => session.id === row.reference.id); return !expected || row.state !== (expected.retired ? 'retired' : 'active');
      })) refuse('s16_ops_native_quarantined');
    } finally { await release(native); }
    stageCurrent();
  }), close });
  try {
    if ((options.retain?.(capability) as unknown) !== undefined) refuse('s16_ops_guard_invalid');
    guard();
  } catch (error) { await close(); throw error; }
  return capability;
}
