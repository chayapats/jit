import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHost } from 'schway/host';
import { AppError } from '../src/errors';
import { openS16NativeRoot } from '../src/s16/operations/native-root';
import { resolveS16NativeNamespace, type S16NativeNamespaceOptions } from '../src/s16/operations/native-namespace';
import { openS16RuntimeMaintenance } from '../src/s16/operations/runtime-maintenance';
import { composedFixture } from './fixtures/s15-composition';

type Fixture = Awaited<ReturnType<typeof composedFixture>>;
const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture(work = true) {
  const f = await composedFixture(); cleanup.push(() => f.close());
  if (work) expect((await f.chat('Run the requested command in the working computer')).state).toBe('completed');
  await f.service.close();
  const maintenance = openS16RuntimeMaintenance({ directory: f.directory, installationId: 'fixture', browserResourceId: 'account' }); cleanup.push(() => maintenance.close());
  const options: S16NativeNamespaceOptions = { runtimeDirectory: f.directory, githubDirectory: join(f.parent, 'native-github'), installationId: 'fixture', sources: maintenance.sources, guard: maintenance.assertCurrent };
  const database = (name: string) => maintenance.sources.find(source => source.name === name)!.database;
  return { f, maintenance, options, database, resolve: () => resolveS16NativeNamespace(options) };
}
function nativeDirectory(path: string) { mkdirSync(path, { recursive: true, mode: 0o700 }); for (const name of ['workspace', 'home', 'sessions']) mkdirSync(join(path, name), { mode: 0o700 }); }

test('real composed CHAT interpretation/MODEL work resolve their exact saved roots and capture under the retained namespace guard', async () => {
  const f = await fixture(), namespace = f.resolve(); expect(namespace.pending).toEqual([]); expect(namespace.untracked).toEqual([]);
  expect(namespace.roots.some(root => root.kind === 'chat' && root.phase?.startsWith('interpretation_'))).toBe(true);
  expect(namespace.roots.some(root => root.kind === 'model')).toBe(true);
  for (const root of namespace.roots) {
    expect(root).toMatchObject({ correlation: 'saved', available: true, vm: null }); expect(Object.isFrozen(root.references[0])).toBe(true);
    const cap = await openS16NativeRoot({ directory: root.directory, installationId: 'fixture', id: root.id, references: root.references, guard: namespace.assertCurrent }); cleanup.push(() => cap.close());
    const captured = await cap.capture(); cap.verify(captured.bytes, captured.sha256); namespace.assertCurrent();
  }
  expect(f.resolve().roots).toEqual(namespace.roots); f.maintenance.close(); expect(() => namespace.assertCurrent()).toThrow();
});

test('an explicitly empty current owning namespace does not initialize any missing native root', async () => {
  const f = await fixture(false), namespace = f.resolve(); expect(namespace.roots).toEqual([]); expect(namespace.pending).toEqual([]); expect(namespace.untracked).toEqual([]);
  for (const path of [join(f.f.directory, 'native-chat'), join(f.f.directory, 'native-model'), f.options.githubDirectory]) expect(existsSync(path)).toBe(false);
  namespace.assertCurrent();
});

test('per-root guards retain original ancestry and root inventory without treating sibling discovery as current publication', async () => {
  const f = await fixture(), namespace = f.resolve(), root = namespace.roots[0]!, guard = namespace.rootGuard(root.id); guard();
  expect(() => namespace.rootGuard('f'.repeat(32))).toThrow();
  const sibling = join(f.f.directory, 'native-model', 'untracked_new'); nativeDirectory(sibling);
  guard(); expect(() => namespace.assertCurrent()).toThrow(expect.objectContaining({ code: 's16_ops_native_changed' })); rmSync(sibling, { recursive: true });
  writeFileSync(join(root.directory, 'unexpected'), '', { mode: 0o600 }); expect(guard).toThrow(expect.objectContaining({ code: 's16_ops_native_changed' }));
});

test('a completed owning MODEL record cannot omit its saved native identity', async () => {
  const f = await fixture(); f.database('model.sqlite').exec("UPDATE records SET json=json_set(json,'$.session',NULL,'$.state','completed')");
  expect(() => resolveS16NativeNamespace({ ...f.options, guard() {} })).toThrow(expect.objectContaining({ code: 's16_ops_native_custody_invalid' }));
});

test('a sessionless current MODEL intent without a physical root remains explicitly pending without initializing native storage', async () => {
  const f = await fixture(false), model = f.database('model.sqlite');
  model.query('INSERT INTO records (id,json) VALUES (?,?)').run('original_selection', JSON.stringify({ contract: 's15-model-selection/v1', id: 'original_selection', state: 'reconcile_only', session: null }));
  const namespace = resolveS16NativeNamespace({ ...f.options, guard() {} }); expect(namespace.roots).toEqual([]);
  expect(namespace.pending).toEqual([{ kind: 'model', ownerId: 'original_selection', phase: null, reason: 'correlation_missing' }]); expect(existsSync(join(f.f.directory, 'native-model'))).toBe(false);
});

test('retained CHAT work roots from the non-MODEL path remain selectable through their real public native references', async () => {
  const f = await fixture(), chat = f.resolve().roots.find(root => root.kind === 'chat')!, directory = join(f.f.directory, 'native-chat', chat.ownerId, 'work'); nativeDirectory(directory);
  const host = await createHost({ workspaceRoot: join(directory, 'workspace'), homeDirectory: join(directory, 'home'), sessionDirectory: join(directory, 'sessions'), context: { policy: 'strict', systemPrompt: 'Retained native fixture.', sections: [] }, tools: { policy: 'exact', hostedLookup: 'off', definitions: [] }, limits: { maxTurns: 1, maxConcurrentTools: 1, contextWindow: 32768, maxInputChars: 1024 } }); cleanup.push(() => host.close());
  const session = await host.createSession(), reference = { ...session.reference }; await session.retire(); await session.close();
  f.database('conversation.sqlite').query('INSERT INTO native_sessions VALUES (?,?,?,?)').run(chat.ownerId, 'work', reference.id, reference.branchId);
  const namespace = resolveS16NativeNamespace({ ...f.options, guard() {} }), selected = namespace.roots.find(root => root.kind === 'chat' && root.phase === 'work')!;
  expect(selected.references).toEqual([reference]); expect(namespace.pending).toEqual([]);
  const cap = await openS16NativeRoot({ directory: selected.directory, installationId: 'fixture', id: selected.id, references: selected.references, guard: namespace.assertCurrent }); cleanup.push(() => cap.close()); const captured = await cap.capture(); cap.verify(captured.bytes, captured.sha256);
});

test('saved branches remain opaque during capture, and deep public quarantine refuses invalid ancestry even when shape/hash validation passes', async () => {
  const f = await fixture(); f.database('model.sqlite').exec("UPDATE records SET json=json_set(json,'$.session.branchId','saved_branch')");
  const namespace = resolveS16NativeNamespace({ ...f.options, guard() {} }), root = namespace.roots.find(root => root.kind === 'model')!;
  expect(root.references[0]!.branchId).toBe('saved_branch'); const cap = await openS16NativeRoot({ directory: root.directory, installationId: 'fixture', id: root.id, references: root.references, guard: namespace.assertCurrent }); cleanup.push(() => cap.close());
  const captured = await cap.capture(); cap.verify(captured.bytes, captured.sha256); expect(root.references[0]!.branchId).toBe('saved_branch');
  const quarantine = join(f.f.parent, 'native-quarantine'); mkdirSync(quarantine, { mode: 0o700 });
  await expect(cap.verifyQuarantine(captured.bytes, captured.sha256, quarantine)).rejects.toThrow(expect.objectContaining({ code: 's16_ops_native_quarantined' }));
  expect(existsSync(join(quarantine, root.id))).toBe(true); expect(root.references[0]!.branchId).toBe('saved_branch');
});

test('a retained optional GitHub ledger cannot be omitted to claim a smaller empty native namespace', async () => {
  const f = await fixture(false); expect(() => resolveS16NativeNamespace({ ...f.options, sources: f.options.sources.filter(source => source.name !== 'github.sqlite') })).toThrow(expect.objectContaining({ code: 's16_ops_source_unavailable' }));
});

test.each(['root', 'sessions'] as const)('a missing required %s remains explicit without an empty replacement', async kind => {
  const f = await fixture(), root = f.resolve().roots.find(root => root.kind === 'model')!;
  const missing = kind === 'root' ? root.directory : join(root.directory, 'sessions'); rmSync(missing, { recursive: true });
  const namespace = f.resolve(), observed = namespace.roots.find(row => row.id === root.id)!;
  expect(observed.available).toBe(false); expect(namespace.pending).toContainEqual({ kind: 'model', ownerId: root.ownerId, phase: null, reason: kind === 'root' ? 'missing_root' : 'partial_root' });
  await expect(openS16NativeRoot({ directory: observed.directory, installationId: 'fixture', id: observed.id, references: observed.references, guard: namespace.assertCurrent })).rejects.toThrow();
  expect(existsSync(missing)).toBe(false); namespace.assertCurrent();
});

test('all three physical namespaces report unowned roots/phases and additional root-level material instead of silently shrinking selection', async () => {
  const f = await fixture(), original = f.resolve(), chat = original.roots.find(root => root.kind === 'chat')!;
  mkdirSync(join(f.f.directory, 'native-chat', 'unowned_request'), { mode: 0o700 });
  mkdirSync(join(f.f.directory, 'native-chat', chat.ownerId, 'unexpected_phase'), { mode: 0o700 });
  mkdirSync(join(f.f.directory, 'native-model', 'unowned_selection'), { mode: 0o700 });
  nativeDirectory(join(f.options.githubDirectory, 'github_' + 'b'.repeat(32)));
  writeFileSync(join(chat.directory, 'unowned'), 'not selected', { mode: 0o600 });
  const namespace = f.resolve(); expect(namespace.untracked.map(row => row.kind).sort()).toEqual(['chat', 'chat', 'chat', 'github', 'model']);
  expect(namespace.roots).toHaveLength(original.roots.length); namespace.assertCurrent();
});

test('a known request phase created before native correlation remains pending and cannot become a successful empty snapshot', async () => {
  const f = await fixture(), chat = f.resolve().roots.find(root => root.kind === 'chat')!, path = join(f.f.directory, 'native-chat', chat.ownerId, 'interpretation_2');
  nativeDirectory(path); const namespace = f.resolve(), unresolved = namespace.roots.find(root => root.directory === path)!;
  expect(unresolved).toMatchObject({ references: [], correlation: 'discovery_required', available: true });
  expect(namespace.pending).toContainEqual({ kind: 'chat', ownerId: chat.ownerId, phase: 'interpretation_2', reason: 'correlation_missing' });
});

test.each(['inventory', 'replacement', 'mode', 'new-missing-parent'] as const)('changed current namespace %s invalidates the original guard', async kind => {
  const f = await fixture(), namespace = f.resolve(), root = namespace.roots[0]!;
  if (kind === 'inventory') writeFileSync(join(root.directory, 'extra'), '', { mode: 0o600 });
  if (kind === 'replacement') { renameSync(root.directory, root.directory + '-old'); nativeDirectory(root.directory); }
  if (kind === 'mode') chmodSync(root.directory, 0o755);
  if (kind === 'new-missing-parent') mkdirSync(f.options.githubDirectory, { mode: 0o700 });
  expect(() => namespace.assertCurrent()).toThrow(expect.objectContaining({ code: 's16_ops_native_changed' }));
});

test.each(['identity', 'reader', 'path', 'model-contract', 'session', 'phase'] as const)('foreign or corrupt current %s refuses rather than reconstructing native ownership', async kind => {
  const f = await fixture(), model = f.database('model.sqlite'), chat = f.database('conversation.sqlite');
  if (kind === 'identity') model.exec("UPDATE identity SET installation='foreign'");
  if (kind === 'reader') model.exec('PRAGMA user_version=99');
  if (kind === 'model-contract') model.exec("UPDATE records SET json=json_set(json,'$.contract','future-model')");
  if (kind === 'session') model.exec("UPDATE records SET json=json_set(json,'$.session',json('{\"id\":\"not-a-native-ref\",\"branchId\":\"main\"}'))");
  if (kind === 'phase') chat.exec("UPDATE native_sessions SET phase='../../foreign'");
  const options = { ...f.options, ...(kind === 'path' ? { runtimeDirectory: f.f.parent } : {}), guard() {} };
  expect(() => resolveS16NativeNamespace(options)).toThrow();
});

test('original GitHub VM custody remains discovery-only and unsettled, with no invented saved branch or native settlement', async () => {
  const f = await fixture(false), attempt = 'github_' + 'a'.repeat(32), vm = f.database('vm.sqlite');
  vm.query('INSERT INTO vm_sessions VALUES (?,?,?,?,?,?,?,?)').run('vm_original', 'vm', 'work_original', attempt, 'work', 'unknown', 'fixture_unit', 3);
  nativeDirectory(join(f.options.githubDirectory, attempt));
  // Protocol fixture over the real owning schema. No application constructor/VM is run to repair it.
  const namespace = resolveS16NativeNamespace({ ...f.options, guard() {} }), root = namespace.roots.find(root => root.kind === 'github')!;
  expect(root).toMatchObject({ ownerId: attempt, references: [], correlation: 'discovery_required', vm: { sessionId: 'vm_original', vmId: 'vm', workId: 'work_original', attemptId: attempt, state: 'unknown', generation: 3 } });
  expect(namespace.pending.map(row => row.reason).sort()).toEqual(['github_attempt_unsettled', 'github_discovery_required']);
  expect(vm.query('SELECT state,generation,attempt_id FROM vm_sessions').get()).toEqual({ state: 'unknown', generation: 3, attempt_id: attempt });
});

test('successful GitHub evidence requires its exact current VM owner and missing native bytes remain pending', async () => {
  const f = await fixture(false), attempt = 'github_' + 'a'.repeat(32), vm = f.database('vm.sqlite'), github = f.database('github.sqlite');
  vm.query('INSERT INTO vm_sessions VALUES (?,?,?,?,?,?,?,?)').run('vm_original', 'vm', 'work_original', attempt, 'work', 'closed', 'fixture_unit', 1);
  github.query('INSERT INTO records VALUES (?,?,?)').run('selection', 'selection_original', JSON.stringify({ id: 'selection_original', workId: 'work_original', state: 'reviewable', evidence: { source: { ref: 'vm:' + attempt } } }));
  let namespace = resolveS16NativeNamespace({ ...f.options, guard() {} }); expect(namespace.roots[0]).toMatchObject({ kind: 'github', ownerId: attempt, available: false });
  expect(namespace.pending.map(row => row.reason).sort()).toEqual(['github_discovery_required', 'missing_root']); expect(existsSync(join(f.options.githubDirectory, attempt))).toBe(false);
  vm.exec('DELETE FROM vm_sessions'); namespace = resolveS16NativeNamespace({ ...f.options, guard() {} });
  expect(namespace.pending).toContainEqual({ kind: 'github', ownerId: attempt, phase: null, reason: 'owner_unavailable' }); expect(namespace.untracked).toContainEqual({ kind: 'github', alias: attempt });
});

test('unsettled GitHub work retains its original closed VM attempt even when native correlation and physical bytes are absent', async () => {
  const f = await fixture(false), attempt = 'github_' + 'a'.repeat(32);
  f.database('vm.sqlite').query('INSERT INTO vm_sessions VALUES (?,?,?,?,?,?,?,?)').run('vm_original', 'vm', 'work_original', attempt, 'work', 'closed', 'fixture_unit', 1);
  f.database('github.sqlite').query('INSERT INTO records VALUES (?,?,?)').run('selection', 'selection_original', JSON.stringify({ id: 'selection_original', workId: 'work_original', state: 'reconcile_only', evidence: null }));
  const namespace = resolveS16NativeNamespace({ ...f.options, guard() {} }); expect(namespace.roots[0]).toMatchObject({ ownerId: attempt, available: false, vm: { state: 'closed', workId: 'work_original' } }); expect(namespace.pending.some(row => row.reason === 'missing_root')).toBe(true); expect(namespace.pending.some(row => row.reason === 'github_work_unsettled')).toBe(true);
});

test('ambiguous GitHub attempts never select the first VM owner as authoritative', async () => {
  const f = await fixture(false), vm = f.database('vm.sqlite'), attempt = 'github_' + 'a'.repeat(32);
  for (const suffix of ['a', 'b']) vm.query('INSERT INTO vm_sessions VALUES (?,?,?,?,?,?,?,?)').run('vm_' + suffix, 'vm', 'work_' + suffix, attempt, 'work', 'closed', 'fixture_' + suffix, 1);
  nativeDirectory(join(f.options.githubDirectory, attempt)); const namespace = resolveS16NativeNamespace({ ...f.options, guard() {} });
  expect(namespace.roots).toEqual([]); expect(namespace.pending).toContainEqual({ kind: 'github', ownerId: attempt, phase: null, reason: 'ambiguous_owner' }); expect(namespace.untracked).toContainEqual({ kind: 'github', alias: attempt }); expect(vm.query('SELECT id FROM vm_sessions').all()).toHaveLength(2);
});

test('sessionless MODEL roots and an emptied known CHAT parent remain pending rather than an inferred complete empty namespace', async () => {
  const f = await fixture(), before = f.resolve(), chat = before.roots.find(root => root.kind === 'chat')!, model = before.roots.find(root => root.kind === 'model')!;
  f.database('model.sqlite').exec("UPDATE records SET json=json_set(json,'$.session',NULL,'$.state','reconcile_only')");
  f.database('conversation.sqlite').exec('DELETE FROM native_sessions'); rmSync(chat.directory, { recursive: true });
  const namespace = resolveS16NativeNamespace({ ...f.options, guard() {} });
  expect(namespace.roots.find(root => root.id === model.id)).toMatchObject({ references: [], correlation: 'discovery_required' });
  expect(namespace.pending).toContainEqual({ kind: 'model', ownerId: model.ownerId, phase: null, reason: 'correlation_missing' }); expect(namespace.pending).toContainEqual({ kind: 'chat', ownerId: chat.ownerId, phase: null, reason: 'correlation_missing' });
});

test('owning query overflow refuses without loading a truncated inventory or creating native state', async () => {
  const f = await fixture(false), vm = f.database('vm.sqlite'), insert = vm.query('INSERT INTO vm_sessions VALUES (?,?,?,?,?,?,?,?)');
  vm.transaction(() => { for (let index = 0; index <= 20_000; index++) insert.run('session_' + index, 'vm', 'work', 'attempt_' + index, 'work', 'closed', 'fixture', 1); })();
  expect(() => resolveS16NativeNamespace({ ...f.options, guard() {} })).toThrow(expect.objectContaining({ code: 's16_ops_native_bounds' })); expect(vm.query<{ rows: number }, []>('SELECT count(*) AS rows FROM vm_sessions').get()!.rows).toBe(20_001); expect(existsSync(f.options.githubDirectory)).toBe(false);
});

test('owning guard loss and closed sources cannot certify an old native namespace', async () => {
  const f = await fixture(); let live = true; const namespace = resolveS16NativeNamespace({ ...f.options, guard() { if (!live) throw new AppError('fixture_owner_changed', 409); f.options.guard(); } });
  live = false; expect(() => namespace.assertCurrent()).toThrow(expect.objectContaining({ code: 'fixture_owner_changed' }));
  f.maintenance.close(); expect(() => f.resolve()).toThrow();
});
