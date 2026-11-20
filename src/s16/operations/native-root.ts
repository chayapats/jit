import { createHash } from 'node:crypto';
import { lstatSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { createHost, hostCapabilities, MAX_SNAPSHOT_SESSIONS, MAX_SNAPSHOT_TOTAL_BYTES, RELEASE_CONTRACT, SNAPSHOT_CONTRACT, SNAPSHOT_NATIVE_FORMAT_VERSION, type HostRuntime, type HostSessionInventoryEntry, type HostSessionReference, type HostSessionSnapshot } from 'schway/host';
import { AppError } from '../../errors';
import { opsPath } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';

const encodedBound = Math.ceil(MAX_SNAPSHOT_TOTAL_BYTES / 3) * 4 + 1_048_576;
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
/** Trusted existing root/correlations only. The aggregate owner must enumerate every required root. */
export interface S16NativeRootOptions {
  directory: string; installationId: string; id: string; references: readonly HostSessionReference[];
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
/** No creation/open/run/restore methods or raw host escape from this protected inspection capability. */
export interface S16NativeRootMaintenance {
  inspect(): Promise<S16NativeInspection>;
  capture(): Promise<S16NativeCapture>;
  verify(bytes: Uint8Array, expectedSha256: string): void;
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
  const close = async () => {
    if (closed) return; usable = false;
    // Public host disposal alone does not certify that our outstanding inventory/copy promise settled.
    // Keep the owning coordinator's exclusion until that exact operation completes and close is retried.
    if (inFlight) refuse('s16_ops_native_busy');
    try { await host.close(); } catch { return refuse('s16_ops_source_release_unknown'); } closed = true;
  };
  try { guard(); } catch (error) { await close(); throw error; }
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
    if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).sort().join(',') !== 'capturedAt,contract,id,installationId,inventory,references,snapshot,workspaceRoot') refuse();
    const envelope = value as { contract: string; id: string; installationId: string; capturedAt: number; workspaceRoot: string; references: HostSessionReference[]; inventory: HostSessionInventoryEntry[]; snapshot: HostSessionSnapshot | null };
    if (envelope.contract !== 's16-native-root/v1' || envelope.id !== id || envelope.installationId !== installationId || envelope.workspaceRoot !== paths.workspaceRoot || !Number.isSafeInteger(envelope.capturedAt) || envelope.capturedAt < 0) refuse();
    references(envelope.references); inventory(envelope.inventory);
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
  return Object.freeze<S16NativeRootMaintenance>({ inspect: () => run(inspect), capture: () => run(async () => {
    const current = await inspect(); if (current.missing.length || current.uncorrelated.length) refuse('s16_ops_native_reconciliation_required');
    const live = expected.filter(ref => current.inventory.find(row => row.reference.id === ref.id)!.state !== 'deleted');
    guard(); const snapshot = live.length ? await host.snapshotSessions(live, { excludeRetired: false }) : null; guard();
    if (canonical(await sweep()) !== canonical(current.inventory)) refuse('s16_ops_native_changed');
    const capturedAt = now();
    const value = { contract: 's16-native-root/v1', id, installationId, capturedAt, workspaceRoot: paths.workspaceRoot, references: expected, inventory: current.inventory, snapshot }; check(value);
    const text = JSON.stringify(value); if (Buffer.byteLength(text) > encodedBound) refuse('s16_ops_native_bounds'); const bytes = Buffer.from(text); guard();
    return Object.freeze({ bytes, sha256: hash(bytes) });
  }), verify(bytes, expectedSha256) {
    guard(); if (!(bytes instanceof Uint8Array) || bytes.byteLength > encodedBound || !/^[a-f0-9]{64}$/.test(expectedSha256) || hash(bytes) !== expectedSha256) refuse();
    try { check(JSON.parse(Buffer.from(bytes).toString('utf8'))); } catch { refuse(); } guard();
  }, close });
}
