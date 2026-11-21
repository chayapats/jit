import { createHash } from 'node:crypto';
import { lstatSync, opendirSync, readdirSync, rmSync, type BigIntStats } from 'node:fs';
import { join } from 'node:path';
import { AppError } from '../../errors';
import { opsDirectory, opsPath, opsRead, opsSyncDirectory, opsWrite } from '../../s14/ops-files';
import { canonical, identity } from '../../s15/conversation/validation';
import { assertS16ExclusiveInstallationLease, type S16InstallationLease } from './installation-lease';
import type { S16NativeBinding, S16NativeManagementCustody, S16NativeNamespace, S16NativePending } from './native-namespace';
import { openS16NativeRoot, s16NativeRootByteLimit, type S16NativeRootMaintenance } from './native-root';
import type { S16OperationsJournal } from './operations-journal';
import type { S16OperationsRequest } from './operations-state';
import { ownS16Staging, s16StagingOwnershipId } from './owned-staging';

const metadataBound = 4_194_304, payloadBound = 4_294_967_296, stagingBound = 8_589_934_592, nodeBound = 100_000;
const hash = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
const sha = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
function refuse(code = 's16_ops_native_set_invalid'): never { throw new AppError(code, 409); }
type Root = Omit<S16NativeBinding, 'directory' | 'available'>;
interface Plan {
  contract: 's16-native-set-plan/v1'; installationId: string; operationsId: string; ownerIdentity: string;
  operationId: string; requestId: string; kind: S16OperationsRequest['kind']; commandSha256: string;
  configurationSha256: string; admittedRevision: number; capturedAt: number; attempt: string; maxBytes: number;
  roots: readonly Root[]; pending: readonly S16NativePending[];
}
interface File { id: string; name: string; bytes: number; sha256: string; identities: number; uncorrelated: number }
interface Manifest {
  contract: 's16-native-set/v1'; installationId: string; operationId: string; requestId: string; actionId: string;
  capturedAt: number; planSha256: string; bytes: number; roots: readonly File[];
}
/** A verified subcomponent only. The aggregate still owns SQL/backend/client continuity and publication. */
export interface S16NativeSetResult {
  readonly directory: string; readonly actionId: string; readonly manifestSha256: string;
  readonly bytes: number; readonly roots: number; readonly pending: number;
}
/** Fault hooks observe durable boundaries; they cannot supply paths, hashes, authority or replacement IDs. */
export interface S16NativeSetOptions {
  attempt: string; maxBytes: number;
  /** Recheck current public native bytes/deep quarantine; a complete retained backup additionally requires ownedStaging. */
  verifyCurrent?: true;
  /** Independently journal empty root/data identities before child writes for explicit retirement. */
  ownedStaging?: true;
  after?(boundary: 'intent' | 'plan' | 'root' | 'manifest' | 'receipt' | 'observed', rootId?: string): void;
}
/** Owned by the current control context; close it before releasing installation/CHAT exclusion. */
export interface S16NativeSetMaintenance {
  readonly released: boolean;
  capture(): Promise<Readonly<S16NativeSetResult>>;
  /** Retries resource disposal only; it neither retries capture nor settles an uncertain action. */
  close(): Promise<void>;
}
/** Private composition inputs. A candidate point never supplies the journal, lease or namespace. */
export interface S16NativeSetOwner extends S16NativeSetOptions {
  directory: string; requestId: string; lease: S16InstallationLease; journal: S16OperationsJournal;
  namespace(): S16NativeNamespace; guard(): void;
}

// Closed per-root rows use the shared canonical encoder; the owning array has its own larger bound.
// This permits thousands of roots without weakening command/journal receipt limits.
function text(value: Plan | Manifest): string {
  const arrays = new Set(['roots', 'pending']);
  const encoded = '{' + Object.keys(value).sort().map(key => {
    const part = value[key as keyof typeof value] as unknown;
    return JSON.stringify(key) + ':' + (arrays.has(key) ? '[' + (part as unknown[]).map(row => canonical(row)).join(',') + ']' : canonical(part));
  }).join(',') + '}';
  if (Buffer.byteLength(encoded) > metadataBound) refuse('s16_ops_capture_bounds'); return encoded;
}
function entry(path: string, directory: boolean): BigIntStats {
  opsPath(path); const value = lstatSync(path, { bigint: true }), uid = process.getuid?.();
  if (uid === undefined || value.uid !== BigInt(uid) || value.isSymbolicLink() || (directory ? !value.isDirectory() : !value.isFile() || value.nlink !== 1n) || value.mode & (directory ? 0o7077n : 0o7177n)) refuse('s16_ops_path_untrusted'); return value;
}
const same = (a: BigIntStats, b: BigIntStats) => a.dev === b.dev && a.ino === b.ino && a.uid === b.uid && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
function read(path: string, limit: number): Buffer {
  const before = entry(path, false); if (before.size > BigInt(limit)) refuse('s16_ops_capture_bounds');
  const bytes = opsRead(path, limit); if (!same(before, entry(path, false)) || bytes.byteLength !== Number(before.size)) refuse('s16_ops_image_changed'); return bytes;
}
/** Metadata-only, no-follow accounting. It never decodes native files or follows their internal schema. */
function usage(path: string): number {
  let nodes = 0, bytes = 0;
  const walk = (path: string, depth: number) => {
    if (++nodes > nodeBound || depth > 32) refuse('s16_ops_capture_bounds'); opsPath(path);
    const stat = lstatSync(path), uid = process.getuid?.();
    if (uid === undefined || stat.uid !== uid || stat.isSymbolicLink()) refuse('s16_ops_path_untrusted');
    if (stat.isFile()) { if (stat.nlink !== 1) refuse('s16_ops_path_untrusted'); bytes += stat.size; if (!Number.isSafeInteger(bytes) || bytes > stagingBound) refuse('s16_ops_capture_bounds'); }
    else if (stat.isDirectory()) {
      const dir = opendirSync(path); try { for (let item; (item = dir.readSync());) walk(join(path, item.name), depth + 1); } finally { dir.closeSync(); }
    } else refuse('s16_ops_path_untrusted');
  }; walk(path, 0); return bytes;
}
const custody = (root: Root): S16NativeManagementCustody => ({ kind: root.kind, ownerId: root.ownerId, phase: root.phase, vm: root.vm });
const roots = (namespace: S16NativeNamespace): Root[] => namespace.roots.map(({ directory: _path, available: _available, ...root }) => root);

/**
 * Captures one original protected native-set action behind genuine installation and CHAT exclusion.
 * Per-root public capture/deep quarantine is sequential. Data is published last; a separate current
 * producer receipt or fresh exact owning readback is required after interruption. No live restoration,
 * execution correlation, authority rewind or original task retry is exposed by this capability.
 */
export function openS16NativeSet(owner: S16NativeSetOwner): S16NativeSetMaintenance {
  const { directory, requestId, attempt, maxBytes, journal } = owner;
  identity(requestId);
  if (!/^[a-z0-9][a-z0-9_]{0,23}$/.test(attempt) || !Number.isSafeInteger(maxBytes) || maxBytes < 0 || maxBytes > payloadBound || owner.verifyCurrent !== undefined && owner.verifyCurrent !== true || owner.ownedStaging !== undefined && owner.ownedStaging !== true) refuse();
  let released = false, usable = true, busy = false;
  const held = new Set<S16NativeRootMaintenance>();
  const guard = () => {
    if (released || !usable) refuse('s16_ops_native_closed');
    assertS16ExclusiveInstallationLease(owner.lease, directory); if ((owner.guard() as unknown) !== undefined) refuse('s16_ops_guard_invalid');
  };
  const current = () => {
    guard(); const control = journal.read(), request = control.requests.find(row => row.requestId === requestId);
    const terminalVerification = request?.kind === 'backup' && request.phase === 'complete' && request.status === 'complete' && owner.verifyCurrent === true && owner.ownedStaging === true &&
      sha(request.targetSha256) && control.points.some(point => point.operationId === request.id && point.id === request.pointId && point.sha256 === request.targetSha256 && point.state === 'retained');
    const phaseAllowed = request?.phase === 'capturing' || request?.kind === 'backup' && request.phase === 'verifying' && owner.verifyCurrent === true || terminalVerification;
    if (!request || !['backup', 'restore', 'upgrade'].includes(request.kind) || !phaseAllowed || ['complete', 'discarded'].includes(request.status) && !terminalVerification || !sha(request.configurationSha256) || !Number.isSafeInteger(request.admittedRevision)) refuse('s16_ops_phase_invalid');
    return { control, request };
  }; current();
  const release = async (cap: S16NativeRootMaintenance) => {
    try { await cap.close(); held.delete(cap); } catch { usable = false; refuse('s16_ops_source_release_unknown'); }
  };
  const close = async () => {
    if (released) return; usable = false; if (busy) refuse('s16_ops_native_busy');
    for (const cap of held) await release(cap); released = true;
  };
  const after = (boundary: Parameters<NonNullable<S16NativeSetOptions['after']>>[0], id?: string) => {
    guard(); if ((owner.after?.(boundary, id) as unknown) !== undefined) refuse('s16_ops_guard_invalid'); guard();
  };
  return Object.freeze<S16NativeSetMaintenance>({ get released() { return released; }, close, async capture() {
    guard(); if (busy) refuse('s16_ops_native_busy'); if (held.size) refuse('s16_ops_source_release_unknown'); busy = true;
    let actionId: string | undefined, manifestPath: string | undefined;
    try {
      const initial = current(), verifyOnly = initial.request.phase !== 'capturing', namespace = owner.namespace(); namespace.assertCurrent();
      if (namespace.untracked.length || namespace.roots.some(root => !root.available) || namespace.pending.some(row => !['correlation_missing', 'github_discovery_required', 'github_attempt_unsettled', 'github_work_unsettled'].includes(row.reason) || row.kind === 'chat' && row.phase === null)) refuse('s16_ops_native_reconciliation_required');
      const proposed: Plan = { contract: 's16-native-set-plan/v1', installationId: initial.control.installationId, operationsId: initial.control.id, ownerIdentity: initial.control.ownerIdentity,
        operationId: initial.request.id, requestId, kind: initial.request.kind, commandSha256: initial.request.hash, configurationSha256: initial.request.configurationSha256!, admittedRevision: initial.request.admittedRevision!, capturedAt: initial.request.createdAt,
        attempt, maxBytes, roots: roots(namespace), pending: namespace.pending };
      const proposedText = text(proposed), prefix = 'native_set_' + attempt + '_';
      const prior = initial.request.actions.filter(row => row.id.startsWith(prefix)); if (prior.length > 1) refuse();
      const action = prior[0]; actionId = action?.id ?? prefix + hash(proposedText);
      if (verifyOnly && (!action || action.state !== 'confirmed')) refuse('s16_ops_phase_invalid');
      if (!new RegExp('^' + prefix + '[a-f0-9]{64}$').test(actionId) || action && (action.kind !== 'capture_native' || action.priorSha256 !== null || action.targetSha256 !== null || action.state === 'not_applied')) refuse('s16_ops_request_conflict');
      const planSha256 = actionId.slice(prefix.length), staging = join(directory, 'operations/native-staging'), stage = join(staging, initial.request.id, actionId), data = join(stage, 'data');
      const planPath = join(stage, 'plan.json'), receiptPath = join(stage, 'receipt.json'); manifestPath = join(data, 'manifest.json');
      if (!action) {
        if (initial.request.status !== 'running') refuse('s16_ops_reconciliation_required');
        journal.recordIntent(requestId, initial.control.revision, { id: actionId, kind: 'capture_native', priorSha256: null, targetSha256: null }); after('intent');
      }
      if (owner.ownedStaging || initial.request.actions.some(row => row.id === s16StagingOwnershipId('native', actionId!))) ownS16Staging(directory, journal, requestId, 'native', actionId, guard, verifyOnly);
      // A recorded action never silently switches its namespace, budget, timestamp or source plan.
      if (verifyOnly && (!action || action.state !== 'confirmed' || !lstatSync(planPath, { throwIfNoEntry: false }))) refuse('s16_ops_phase_invalid');
      let planText = proposedText;
      if (lstatSync(planPath, { throwIfNoEntry: false })) planText = read(planPath, metadataBound).toString('utf8');
      if (hash(planText) !== planSha256) refuse('s16_ops_native_plan_changed');
      let plan: Plan; try { plan = JSON.parse(planText); } catch { return refuse(); }
      const { roots: _roots, pending: _pending, ...planIdentity } = plan;
      const { roots: _proposedRoots, pending: _proposedPending, ...proposedIdentity } = proposed;
      if (canonical(planIdentity) !== canonical(proposedIdentity) || !Array.isArray(plan.roots) || !Array.isArray(plan.pending) || plan.roots.length > 20_000 || plan.pending.length > 20_000) refuse('s16_ops_native_plan_changed');
      const selected = new Map(namespace.roots.map(root => [root.id, root]));
      for (const root of plan.roots) {
        const binding = selected.get(root.id); if (!binding || canonical({ kind: binding.kind, ownerId: binding.ownerId, phase: binding.phase, vm: binding.vm ? { sessionId: binding.vm.sessionId, vmId: binding.vm.vmId, workId: binding.vm.workId, attemptId: binding.vm.attemptId } : null }) !==
          canonical({ kind: root.kind, ownerId: root.ownerId, phase: root.phase, vm: root.vm ? { sessionId: root.vm.sessionId, vmId: root.vm.vmId, workId: root.vm.workId, attemptId: root.vm.attemptId } : null })) refuse('s16_ops_native_plan_changed');
      }
      // Reserve metadata before any native copy. A row cannot grow beyond these fixed upper bounds.
      const shell: Manifest = { contract: 's16-native-set/v1', installationId: plan.installationId, operationId: plan.operationId, requestId, actionId, capturedAt: plan.capturedAt, planSha256, bytes: maxBytes,
        roots: plan.roots.map(root => ({ id: root.id, name: root.id + '.json', bytes: s16NativeRootByteLimit, sha256: 'f'.repeat(64), identities: 64, uncorrelated: 64 })) };
      const overhead = Buffer.byteLength(text(shell)) + Buffer.byteLength(planText); if (overhead > maxBytes) refuse('s16_ops_capture_bounds');
      if (!verifyOnly) opsDirectory(staging); entry(staging, true); const beforeBytes = usage(staging);
      if (!lstatSync(planPath, { throwIfNoEntry: false })) { opsWrite(planPath, planText); after('plan'); }
      const stageEntry = entry(stage, true); if (!verifyOnly) opsDirectory(data); const dataEntry = entry(data, true);
      const stageGuard = () => {
        guard(); for (const [path, before] of [[stage, stageEntry], [data, dataEntry]] as const) { const now = entry(path, true); if (now.dev !== before.dev || now.ino !== before.ino || now.uid !== before.uid || now.mode !== before.mode) refuse('s16_ops_image_changed'); }
      };
      const receipt = (manifestSha256: string) => ({ contract: 's16-native-set-receipt/v1', installationId: plan.installationId, operationId: plan.operationId, actionId, planSha256, manifestSha256 });
      if (action?.state === 'confirmed' && !sha(action.observedSha256)) refuse();
      let independent: string | null = action?.state === 'confirmed' ? action.observedSha256! : null;
      if (lstatSync(receiptPath, { throwIfNoEntry: false })) {
        const raw = read(receiptPath, 4096).toString('utf8'); let saved: ReturnType<typeof receipt>; try { saved = JSON.parse(raw); } catch { return refuse(); }
        if (!sha(saved.manifestSha256) || canonical(saved) !== canonical(receipt(saved.manifestSha256)) || independent !== null && independent !== saved.manifestSha256) refuse(); independent = saved.manifestSha256;
      }
      const published = !!lstatSync(manifestPath, { throwIfNoEntry: false });
      if (verifyOnly && (!published || !independent || !lstatSync(receiptPath, { throwIfNoEntry: false }))) refuse('s16_ops_phase_invalid');
      if (initial.request.phase === 'complete' && hash(proposedText) !== planSha256) refuse('s16_ops_native_plan_changed');
      if (independent && !published) refuse('s16_ops_native_set_invalid');
      if (published && !independent && planText !== proposedText) refuse('s16_ops_native_plan_changed');
      if (!published && (action?.state === 'confirmed' || planText !== proposedText)) refuse('s16_ops_native_plan_changed');
      const quarantine = join(stage, 'quarantine'), scratchPath = join(stage, 'scratch.json');
      const rootIds = new Set(plan.roots.map(root => root.id));
      const cleanScratch = () => {
        stageGuard(); if (held.size) refuse('s16_ops_source_release_unknown');
        if (verifyOnly && (!lstatSync(quarantine, { throwIfNoEntry: false }) || !lstatSync(scratchPath, { throwIfNoEntry: false }))) refuse('s16_ops_path_untrusted');
        if (!verifyOnly) opsDirectory(quarantine); const stat = entry(quarantine, true), marker = canonical({ contract: 's16-native-scratch/v1', operationId: plan.operationId, actionId, planSha256, dev: String(stat.dev), ino: String(stat.ino) });
        if (lstatSync(scratchPath, { throwIfNoEntry: false })) { if (read(scratchPath, 4096).toString('utf8') !== marker) refuse('s16_ops_path_untrusted'); }
        else { if (readdirSync(quarantine).length) refuse('s16_ops_path_untrusted'); opsWrite(scratchPath, marker); }
        for (const name of readdirSync(quarantine)) {
          if (!rootIds.has(name)) refuse('s16_ops_path_untrusted'); const path = join(quarantine, name); usage(path); stageGuard(); rmSync(path, { recursive: true }); opsSyncDirectory(quarantine);
        }
      };
      const files: File[] = []; let total = 0, added = 0;
      let manifest: Manifest | undefined;
      if (published) {
        const raw = read(manifestPath, metadataBound); if (independent && hash(raw) !== independent) refuse();
        try { manifest = JSON.parse(raw.toString('utf8')); } catch { return refuse(); }
        if (!manifest || text(manifest) !== raw.toString('utf8') || Object.keys(manifest).sort().join(',') !== Object.keys(shell).sort().join(',') ||
          canonical({ ...manifest, roots: [] , bytes: 0 }) !== canonical({ ...shell, roots: [], bytes: 0 }) || !Array.isArray(manifest.roots) || manifest.roots.length !== plan.roots.length) refuse();
      }
      const planCopy = join(data, 'plan.json');
      if (published || lstatSync(planCopy, { throwIfNoEntry: false })) { if (read(planCopy, metadataBound).toString('utf8') !== planText) refuse(); }
      else opsWrite(planCopy, planText);
      if (!independent || owner.verifyCurrent) cleanScratch();
      for (let index = 0; index < plan.roots.length; index++) {
        const root: Root = plan.roots[index]!, binding = selected.get(root.id)!, path = join(data, root.id + '.json'), rootGuard = namespace.rootGuard(root.id);
        const cap = await openS16NativeRoot({ directory: binding.directory, installationId: plan.installationId, id: root.id, references: root.references, custody: custody(root), now: () => plan.capturedAt,
          retain(capability) { held.add(capability); }, guard() { stageGuard(); rootGuard(); } });
        try {
          let bytes: Uint8Array, digest: string;
          if (published || lstatSync(path, { throwIfNoEntry: false })) { bytes = read(path, s16NativeRootByteLimit); digest = hash(bytes); cap.verify(bytes, digest); }
          else { const captured = await cap.capture(); bytes = captured.bytes; digest = captured.sha256; }
          const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as { inventory: { reference: { id: string } }[]; snapshot: { createdAt?: unknown } | null; savedReferences: unknown };
          const saved = new Set(root.references.map(ref => ref.id));
          if (root.nativeRequired && !value.inventory.length || canonical(value.savedReferences) !== canonical(root.references)) refuse('s16_ops_native_reconciliation_required');
          const file: File = { id: root.id, name: root.id + '.json', bytes: bytes.byteLength, sha256: digest, identities: value.inventory.length, uncorrelated: value.inventory.filter(row => !saved.has(row.reference.id)).length };
          const absent = !lstatSync(path, { throwIfNoEntry: false });
          total += file.bytes; if (absent) added += file.bytes;
          if (total + overhead > maxBytes || !independent && beforeBytes + added + 268_435_456 + metadataBound * 3 > stagingBound) refuse('s16_ops_capture_bounds');
          if (manifest && canonical(manifest.roots[index]) !== canonical(file)) refuse();
          if (!independent || owner.verifyCurrent) {
            if (published || lstatSync(path, { throwIfNoEntry: false })) {
              const fresh = await cap.capture(), currentValue = JSON.parse(Buffer.from(fresh.bytes).toString('utf8')) as typeof value;
              // The public snapshot timestamp is copy metadata; all custody, native bytes and headers must match.
              if (value.snapshot) delete value.snapshot.createdAt; if (currentValue.snapshot) delete currentValue.snapshot.createdAt;
              if (JSON.stringify(currentValue) !== JSON.stringify(value)) refuse('s16_ops_native_changed');
            }
            await cap.verifyQuarantine(bytes, digest, quarantine);
            if (!lstatSync(path, { throwIfNoEntry: false })) opsWrite(path, bytes);
            if (hash(read(path, s16NativeRootByteLimit)) !== digest) refuse();
          }
          files.push(file);
        } finally { await release(cap); }
        if (!independent || owner.verifyCurrent) cleanScratch(); after('root', root.id);
      }
      stageGuard(); namespace.assertCurrent();
      const actual: Manifest = { ...shell, roots: files, bytes: total }, encoded = text(actual), manifestSha256 = hash(encoded), componentBytes = total + Buffer.byteLength(encoded) + Buffer.byteLength(planText);
      if (componentBytes > maxBytes) refuse('s16_ops_capture_bounds');
      const names = ['plan.json', ...files.map(file => file.name), ...(published ? ['manifest.json'] : [])].sort();
      if (JSON.stringify(readdirSync(data).sort()) !== JSON.stringify(names)) refuse('s16_ops_inventory_changed');
      if (manifest && text(manifest) !== encoded || independent && manifestSha256 !== independent) refuse();
      if (!published) { opsWrite(manifestPath, encoded); after('manifest'); }
      if (hash(read(manifestPath, metadataBound)) !== manifestSha256) refuse(); stageGuard(); namespace.assertCurrent();
      if (!independent) { opsWrite(receiptPath, canonical(receipt(manifestSha256))); after('receipt'); }
      const latest = current(); journal.observeAction(requestId, latest.control.revision, actionId, 'applied', manifestSha256); after('observed');
      return Object.freeze({ directory: data, actionId, manifestSha256, bytes: componentBytes, roots: files.length, pending: plan.pending.length });
    } catch (error) {
      // Settlement describes this subcomponent's publication only, never original native/VM work.
      if (actionId) try {
        const state = current(), action = state.request.actions.find(row => row.id === actionId);
        if (action && !['confirmed', 'not_applied'].includes(action.state)) {
          const absent = !held.size && manifestPath !== undefined && !lstatSync(manifestPath, { throwIfNoEntry: false });
          if (absent) journal.observeAction(requestId, state.control.revision, actionId, 'not_applied', null);
          const next = current(); journal.block(requestId, next.control.revision, 's16_ops_native_set_incomplete', absent ? undefined : actionId);
        }
      } catch { /* Unknown journal/release boundaries keep the original fence and action intact. */ }
      throw error;
    } finally { busy = false; }
  } });
}
