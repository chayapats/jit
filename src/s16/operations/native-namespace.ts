import type { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, type BigIntStats } from 'node:fs';
import { dirname, isAbsolute, join, normalize } from 'node:path';
import type { HostSessionReference } from 'schway/host';
import { AppError } from '../../errors';
import { opsPath } from '../../s14/ops-files';
import { identity } from '../../s15/conversation/validation';
import type { S16LedgerSource } from './ledger-set';
import { s16RuntimeReaders } from './runtime-readers';

const bound = 20_000;
type Kind = 'chat' | 'model' | 'github';
function refuse(code = 's16_ops_native_custody_invalid'): never { throw new AppError(code, 409); }
/** Current original VM custody, never a restored physical/execution grant. */
export interface S16NativeVmCustody { sessionId: string; vmId: string; workId: string; attemptId: string; state: string; generation: number }
/** Known current owning intent, without claiming a saved native execution correlation. */
export interface S16NativeManagementCustody { kind: Kind; ownerId: string; phase: string | null; vm: Readonly<S16NativeVmCustody> | null }
/** Protected root selection from actual current owning metadata, not a client/archive path. */
export interface S16NativeBinding {
  readonly id: string; readonly kind: Kind; readonly ownerId: string; readonly phase: string | null; readonly directory: string;
  readonly references: readonly HostSessionReference[]; readonly correlation: 'saved' | 'discovery_required'; readonly available: boolean;
  /** Saved refs or successful owning GitHub evidence require actual committed native identity. */
  readonly nativeRequired: boolean;
  readonly vm: Readonly<S16NativeVmCustody> | null;
}
/** Incomplete physical/correlation custody remains explicit until its actual owner reconciles it. */
export interface S16NativePending { readonly kind: Kind; readonly ownerId: string; readonly phase: string | null; readonly reason: 'missing_root' | 'partial_root' | 'correlation_missing' | 'github_discovery_required' | 'github_attempt_unsettled' | 'github_work_unsettled' | 'owner_unavailable' | 'ambiguous_owner' }
/** Complete bounded namespace observation; pending/untracked is not aggregate success. */
export interface S16NativeNamespace {
  readonly roots: readonly S16NativeBinding[]; readonly pending: readonly S16NativePending[];
  readonly untracked: readonly Readonly<{ kind: Kind; alias: string }>[];
  /** Checks only this original root and its ancestors; use assertCurrent at aggregate boundaries. */
  rootGuard(id: string): () => void;
  assertCurrent(): void;
}
/** Only trusted current composition supplies these fixed roots and already-held current sources. */
export interface S16NativeNamespaceOptions {
  runtimeDirectory: string; githubDirectory: string; installationId: string; sources: readonly S16LedgerSource[]; guard(): void;
}
/**
 * Resolves CHAT/MODEL/GitHub native roots without booting owning applications, touching native schema,
 * inventing correlations or initializing missing state. The current coordinator retains exclusion.
 */
export function resolveS16NativeNamespace(options: S16NativeNamespaceOptions): S16NativeNamespace {
  const { runtimeDirectory, githubDirectory, installationId, guard: owningGuard } = options; identity(installationId);
  for (const path of [runtimeDirectory, githubDirectory]) if (!isAbsolute(path) || normalize(path) !== path) refuse();
  const entries = new Map<string, BigIntStats>(), inventories = new Map<string, string[]>(), missing = new Set<string>();
  const roots: S16NativeBinding[] = [], pending: S16NativePending[] = [], untracked: { kind: Kind; alias: string }[] = []; let physicalCount = 0;
  const reserve = () => { if (roots.length + pending.length + untracked.length >= bound) refuse('s16_ops_native_bounds'); };
  const unowned = (kind: Kind, alias: string) => { reserve(); untracked.push(Object.freeze({ kind, alias })); };
  const current = () => { if ((owningGuard() as unknown) !== undefined) refuse('s16_ops_guard_invalid'); }; current();
  const directory = (path: string) => {
    opsPath(path); const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!stat) { missing.add(path); return false; }
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== BigInt(process.getuid?.() ?? -1) || stat.mode & 0o7077n) refuse('s16_ops_path_untrusted');
    const before = entries.get(path);
    if (before && (stat.dev !== before.dev || stat.ino !== before.ino || stat.uid !== before.uid || stat.mode !== before.mode)) refuse('s16_ops_native_changed');
    if (!before) entries.set(path, stat); return true;
  };
  const names = (path: string) => {
    if (!directory(path)) return [];
    const value = readdirSync(path).sort(), before = inventories.get(path);
    if (before && JSON.stringify(before) !== JSON.stringify(value)) refuse('s16_ops_native_changed');
    if (!before) { physicalCount += value.length; if (physicalCount > bound) refuse('s16_ops_native_bounds'); inventories.set(path, value); } return value;
  };
  if (!directory(runtimeDirectory)) refuse();
  const connections = new Map<string, Database>();
  for (const source of options.sources) { if (connections.has(source.name)) refuse(); connections.set(source.name, source.database); }
  if (!!lstatSync(join(runtimeDirectory, 'github.sqlite'), { throwIfNoEntry: false }) !== connections.has('github.sqlite')) refuse('s16_ops_source_unavailable');
  const source = (name: string, identityColumn?: 'id' | 'installation') => {
    const db = connections.get(name), reader = s16RuntimeReaders[name as keyof typeof s16RuntimeReaders]; if (!db || !reader) refuse('s16_ops_source_unavailable');
    const attached = db.query<{ name: string; file: string }, []>('PRAGMA database_list').all();
    if (attached.length !== 1 || attached[0]!.name !== 'main' || attached[0]!.file !== join(runtimeDirectory, name) ||
      db.query<{ application_id: number }, []>('PRAGMA main.application_id').get()?.application_id !== reader.applicationId || !reader.formats.includes(db.query<{ user_version: number }, []>('PRAGMA main.user_version').get()?.user_version ?? -1)) refuse();
    if (identityColumn) {
      const identities = db.query<{ installation: string }, []>(`SELECT ${identityColumn} AS installation FROM main.identity LIMIT 2`).all();
      if (identities.length !== 1 || identities[0]!.installation !== installationId) refuse();
    }
    return db;
  };
  const jsonBounds = (db: Database, table: 'records', where = '') => {
    const limits = db.query<{ rows: number; largest: number; bytes: number; invalid: number }, []>(`SELECT count(*) AS rows,coalesce(max(length(CAST(json AS BLOB))),0) AS largest,coalesce(sum(length(CAST(json AS BLOB))),0) AS bytes,coalesce(sum(typeof(id)<>'text' OR length(CAST(id AS BLOB))>128 OR typeof(json)<>'text' OR json_valid(json)=0),0) AS invalid FROM main.${table} ${where}`).get();
    if (!limits || limits.rows > bound || limits.largest > 131072 || limits.bytes > 67_108_864 || limits.invalid) refuse('s16_ops_native_bounds');
  };
  const rowBound = (db: Database, table: 'requests' | 'native_sessions' | 'vm_sessions') => {
    const columns = table === 'requests' ? ['id'] : table === 'native_sessions' ? ['request_id', 'phase', 'session_id', 'branch_id'] : ['id', 'vm_id', 'work_id', 'attempt_id', 'mode', 'state'];
    const invalid = columns.map(column => `(typeof(${column})<>'text' OR length(CAST(${column} AS BLOB)) NOT BETWEEN 1 AND ${column === 'branch_id' ? 512 : 128})`).join(' OR ') + (table === 'vm_sessions' ? " OR typeof(generation)<>'integer' OR generation<1" : '');
    const limits = db.query<{ rows: number; invalid: number }, []>(`SELECT count(*) AS rows,coalesce(sum(${invalid}),0) AS invalid FROM main.${table}`).get();
    if (!limits || limits.rows > bound || limits.invalid) refuse('s16_ops_native_bounds');
  };
  const ref = (id: unknown, branchId: unknown): HostSessionReference => {
    if (typeof id !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(id) || typeof branchId !== 'string' || !branchId || branchId.length > 128 || /[\0\r\n]/.test(branchId)) refuse();
    return Object.freeze({ id, branchId });
  };
  const hold = (kind: Kind, ownerId: string, phase: string | null, reason: S16NativePending['reason']) => { reserve(); pending.push(Object.freeze({ kind, ownerId, phase, reason })); };
  const add = (kind: Kind, ownerId: string, phase: string | null, path: string, refs: HostSessionReference[], vm: S16NativeVmCustody | null = null, nativeRequired = refs.length > 0) => {
    identity(ownerId); const present = directory(path); let available = present;
    if (!present) hold(kind, ownerId, phase, 'missing_root');
    else {
      const children = names(path); for (const child of children) if (!['workspace', 'home', 'sessions'].includes(child)) unowned(kind, ownerId + '/' + (phase ? phase + '/' : '') + child);
      for (const child of ['workspace', 'home', 'sessions']) if (!directory(join(path, child))) available = false;
      if (!available) hold(kind, ownerId, phase, 'partial_root');
    }
    reserve(); roots.push(Object.freeze({ id: createHash('sha256').update('s16-native-binding/v1\0' + kind + '\0' + ownerId + '\0' + (phase ?? '')).digest('hex').slice(0, 32), kind, ownerId, phase, directory: path,
      references: Object.freeze([...refs]), correlation: refs.length ? 'saved' : 'discovery_required', available, nativeRequired, vm: vm ? Object.freeze({ ...vm }) : null }));
  };
  try {
    const chat = source('conversation.sqlite', 'id'), model = source('model.sqlite', 'installation'), vm = source('vm.sqlite');
    rowBound(chat, 'requests'); rowBound(chat, 'native_sessions');
    const requests = chat.query<{ id: string }, []>("SELECT id FROM main.requests WHERE typeof(id)='text' AND length(CAST(id AS BLOB))<=128 ORDER BY id LIMIT 20001").all();
    if (requests.length !== chat.query<{ rows: number }, []>('SELECT count(*) AS rows FROM main.requests').get()!.rows) refuse();
    const knownRequests = new Set(requests.map(row => { identity(row.id); return row.id; }));
    const saved = new Map<string, HostSessionReference>();
    for (const row of chat.query<{ request_id: string; phase: string; session_id: string; branch_id: string }, []>('SELECT request_id,phase,session_id,branch_id FROM main.native_sessions ORDER BY request_id,phase LIMIT 20001').all()) {
      if (!knownRequests.has(row.request_id) || typeof row.phase !== 'string' || row.phase !== 'work' && (!/^interpretation_[1-9][0-9]{0,15}$/.test(row.phase) || !Number.isSafeInteger(Number(row.phase.slice(15))))) refuse();
      const key = row.request_id + '/' + row.phase; if (saved.has(key)) refuse(); saved.set(key, ref(row.session_id, row.branch_id));
    }
    const chatRoot = join(runtimeDirectory, 'native-chat'), observedPhases = new Set<string>();
    for (const ownerId of names(chatRoot)) {
      if (!knownRequests.has(ownerId)) { unowned('chat', ownerId); continue; }
      const phases = names(join(chatRoot, ownerId)); if (!phases.length) hold('chat', ownerId, null, 'correlation_missing');
      for (const phase of phases) {
        const key = ownerId + '/' + phase, selected = saved.get(key);
        if (!selected) {
          if (phase === 'work' || /^interpretation_[1-9][0-9]{0,15}$/.test(phase) && Number.isSafeInteger(Number(phase.slice(15)))) {
            add('chat', ownerId, phase, join(chatRoot, ownerId, phase), []); hold('chat', ownerId, phase, 'correlation_missing');
          } else unowned('chat', key);
          continue;
        }
        observedPhases.add(key); add('chat', ownerId, phase, join(chatRoot, ownerId, phase), [selected]);
      }
    }
    for (const [key, selected] of saved) if (!observedPhases.has(key)) { const [ownerId, phase] = key.split('/') as [string, string]; add('chat', ownerId, phase, join(chatRoot, ownerId, phase), [selected]); }
    jsonBounds(model, 'records');
    const modelRows = model.query<{ id: string; record_id: string; contract: string; state: string; session: string | null; session_type: string }, []>("SELECT id,json_extract(json,'$.id') AS record_id,json_extract(json,'$.contract') AS contract,json_extract(json,'$.state') AS state,json_extract(json,'$.session') AS session,json_type(json,'$.session') AS session_type FROM main.records ORDER BY id LIMIT 20001").all();
    const knownModels = new Map<string, HostSessionReference | null>();
    for (const row of modelRows) {
      identity(row.id); if (row.id !== row.record_id || row.contract !== 's15-model-selection/v1' || !['selected', 'running', 'completed', 'held', 'failed', 'reconcile_only'].includes(row.state) || !['null', 'object'].includes(row.session_type) || row.state === 'completed' && row.session_type !== 'object') refuse();
      if (row.session_type === 'null') knownModels.set(row.id, null);
      else { const session = JSON.parse(row.session!); if (!session || Object.keys(session).sort().join(',') !== 'branchId,id') refuse(); knownModels.set(row.id, ref(session.id, session.branchId)); }
    }
    const modelRoot = join(runtimeDirectory, 'native-model'), observedModels = new Set<string>();
    for (const ownerId of names(modelRoot)) {
      if (!knownModels.has(ownerId)) { unowned('model', ownerId); continue; }
      const selected = knownModels.get(ownerId); observedModels.add(ownerId); add('model', ownerId, null, join(modelRoot, ownerId), selected ? [selected] : []);
      if (!selected) hold('model', ownerId, null, 'correlation_missing');
    }
    for (const [ownerId, selected] of knownModels) if (!observedModels.has(ownerId)) {
      if (selected) add('model', ownerId, null, join(modelRoot, ownerId), [selected]);
      else hold('model', ownerId, null, 'correlation_missing');
    }
    rowBound(vm, 'vm_sessions'); const attempts = new Map<string, S16NativeVmCustody>(), ambiguous = new Set<string>();
    for (const row of vm.query<{ id: string; vm_id: string; work_id: string; attempt_id: string; state: string; mode: string; generation: number }, []>("SELECT id,vm_id,work_id,attempt_id,state,mode,generation FROM main.vm_sessions WHERE substr(attempt_id,1,7)='github_' ORDER BY id LIMIT 20001").all()) {
      for (const value of [row.id, row.vm_id, row.work_id]) identity(value);
      if (!/^github_[a-f0-9]{32}$/.test(row.attempt_id) || row.mode !== 'work' || !['opening', 'active', 'stopping', 'closed', 'unknown'].includes(row.state) || !Number.isSafeInteger(row.generation) || row.generation < 1) refuse();
      if (attempts.has(row.attempt_id)) ambiguous.add(row.attempt_id);
      else attempts.set(row.attempt_id, { sessionId: row.id, vmId: row.vm_id, workId: row.work_id, attemptId: row.attempt_id, state: row.state, generation: row.generation });
    }
    const requiredAttempts = new Set<string>(), unsettledWorks = new Set<string>(), github = connections.has('github.sqlite') ? source('github.sqlite', 'id') : undefined;
    if (github) {
      jsonBounds(github, 'records', "WHERE kind='selection'");
      for (const row of github.query<{ id: string; selection_id: string; work_id: string; state: string; source: string | null }, []>("SELECT id,json_extract(json,'$.id') AS selection_id,json_extract(json,'$.workId') AS work_id,json_extract(json,'$.state') AS state,json_extract(json,'$.evidence.source.ref') AS source FROM main.records WHERE kind='selection' ORDER BY id LIMIT 20001").all()) {
        identity(row.id); identity(row.work_id); if (row.id !== row.selection_id || !['selected', 'implementing', 'reviewable', 'reconcile_only'].includes(row.state) || row.source !== null && (typeof row.source !== 'string' || row.source.length > 4096)) refuse();
        if (typeof row.source === 'string' && /^vm:github_[a-f0-9]{32}$/.test(row.source)) requiredAttempts.add(row.source.slice(3));
        if (['implementing', 'reconcile_only'].includes(row.state)) unsettledWorks.add(row.work_id);
      }
    }
    const physicalGithub = names(githubDirectory);
    for (const ownerId of new Set([...physicalGithub, ...requiredAttempts, ...[...attempts].filter(([, owner]) => owner.state !== 'closed' || unsettledWorks.has(owner.workId)).map(([id]) => id)])) {
      const owner = attempts.get(ownerId);
      if (!owner) { unowned('github', ownerId); if (requiredAttempts.has(ownerId)) hold('github', ownerId, null, 'owner_unavailable'); continue; }
      if (ambiguous.has(ownerId)) { unowned('github', ownerId); hold('github', ownerId, null, 'ambiguous_owner'); continue; }
      add('github', ownerId, null, join(githubDirectory, ownerId), [], owner, requiredAttempts.has(ownerId)); hold('github', ownerId, null, 'github_discovery_required');
      if (!github) hold('github', ownerId, null, 'owner_unavailable');
      if (owner.state !== 'closed') hold('github', ownerId, null, 'github_attempt_unsettled');
      if (unsettledWorks.has(owner.workId)) hold('github', ownerId, null, 'github_work_unsettled');
    }
  } catch (error) { if (error instanceof AppError) throw error; return refuse(); }
  if (roots.length + pending.length + untracked.length > bound || [...inventories.values()].reduce((total, value) => total + value.length, 0) > bound) refuse('s16_ops_native_bounds');
  const unchanged = (path: string, before: BigIntStats) => {
      opsPath(path); const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (!stat?.isDirectory() || stat.isSymbolicLink() || stat.dev !== before.dev || stat.ino !== before.ino || stat.uid !== before.uid || stat.mode !== before.mode) refuse('s16_ops_native_changed');
  };
  const assertCurrent = () => {
    current();
    for (const [path, before] of entries) unchanged(path, before);
    for (const path of missing) if (lstatSync(path, { throwIfNoEntry: false })) refuse('s16_ops_native_changed');
    for (const [path, before] of inventories) if (JSON.stringify(readdirSync(path).sort()) !== JSON.stringify(before)) refuse('s16_ops_native_changed');
  }; assertCurrent();
  const selected = new Map(roots.map(root => [root.id, root]));
  const rootGuard = (id: string) => {
    const root = selected.get(id); if (!root?.available) refuse('s16_ops_native_unavailable');
    const scoped = new Map<string, BigIntStats>();
    for (const child of ['', 'workspace', 'home', 'sessions']) {
      const path = child ? join(root.directory, child) : root.directory, before = entries.get(path); if (!before) refuse(); scoped.set(path, before);
    }
    for (let path = dirname(root.directory); ; path = dirname(path)) {
      const before = entries.get(path); if (before) scoped.set(path, before); if (dirname(path) === path) break;
    }
    const names = inventories.get(root.directory); if (!names) refuse();
    return () => {
      current(); for (const [path, before] of scoped) unchanged(path, before);
      if (JSON.stringify(readdirSync(root.directory).sort()) !== JSON.stringify(names)) refuse('s16_ops_native_changed');
    };
  };
  return Object.freeze({ roots: Object.freeze(roots), pending: Object.freeze(pending), untracked: Object.freeze(untracked), assertCurrent, rootGuard });
}
