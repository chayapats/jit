import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHost, MAX_SNAPSHOT_SESSIONS } from 'schway/host';
import { AppError } from '../src/errors';
import { openS16NativeRoot, type S16NativeRootOptions } from '../src/s16/operations/native-root';
import { openS16RuntimeMaintenance } from '../src/s16/operations/runtime-maintenance';
import { composedFixture } from './fixtures/s15-composition';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (value: Uint8Array) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
async function fixture(maxInputChars = 1024) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-native-root-'))); cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const directory = join(parent, 'native'); mkdirSync(directory, { mode: 0o700 });
  const paths = { workspaceRoot: join(directory, 'workspace'), homeDirectory: join(directory, 'home'), sessionDirectory: join(directory, 'sessions') };
  for (const path of Object.values(paths)) mkdirSync(path, { mode: 0o700 });
  const host = await createHost({ ...paths, context: { policy: 'strict', systemPrompt: 'Native custody fixture.', sections: [] }, tools: { policy: 'exact', hostedLookup: 'off', definitions: [] }, limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 1, contextWindow: 131072, maxInputChars, deadlineMs: 1000 } });
  cleanup.push(() => host.close());
  const options: S16NativeRootOptions = { directory, id: 'a'.repeat(32), installationId: 'fixture', references: [], now: () => 123, guard() {} };
  const open = async (extra: Partial<S16NativeRootOptions> = {}) => { const cap = await openS16NativeRoot({ ...options, ...extra }); cleanup.push(() => cap.close()); return cap; };
  const session = async (state: 'active' | 'retired' | 'deleted' = 'active') => {
    const created = await host.createSession(), ref = { ...created.reference }; if (state !== 'active') await created.retire(); await created.close();
    if (state === 'deleted') await host.deleteSession(ref); return ref;
  };
  return { parent, directory, paths, host, options, open, session };
}

test('actual public native inventory and opaque capture retain active, retired and deleted custody without home/credential files or execution', async () => {
  const f = await fixture(), active = await f.session(), retired = await f.session('retired'), deleted = await f.session('deleted');
  writeFileSync(join(f.paths.homeDirectory, 'private-home-marker'), 'fixture-private-home-only', { mode: 0o600 });
  const cap = await f.open({ references: [retired, active, deleted] }), observed = await cap.inspect();
  expect(observed.missing).toEqual([]); expect(observed.uncorrelated).toEqual([]); expect(observed.inventory.map(row => row.state).sort()).toEqual(['active', 'deleted', 'retired']);
  const captured = await cap.capture(); expect(captured.sha256).toBe(hash(captured.bytes)); cap.verify(captured.bytes, captured.sha256);
  const value = JSON.parse(Buffer.from(captured.bytes).toString('utf8'));
  expect(value).toMatchObject({ contract: 's16-native-root/v1', id: f.options.id, installationId: 'fixture', capturedAt: 123, workspaceRoot: f.paths.workspaceRoot });
  expect(value.references).toHaveLength(3); expect(value.snapshot.sessions).toHaveLength(2);
  expect(value.snapshot.sessions.find((row: { id: string }) => row.id === retired.id).retired).toBe(true);
  expect(value.snapshot.sessions.find((row: { id: string }) => row.id === deleted.id)).toBeUndefined();
  expect(f.host.validateSessionSnapshot(value.snapshot).status).toBe('valid');
  expect(Buffer.from(captured.bytes).toString('utf8')).not.toContain('fixture-private-home-only'); expect(Buffer.from(captured.bytes).toString('utf8')).not.toContain(Buffer.from('fixture-private-home-only').toString('base64'));
  expect((await f.host.listSessions()).sessions).toEqual(observed.inventory);
});

test('a live actual native owner blocks snapshot; closing the original handle permits the same saved reference without creating another session', async () => {
  const f = await fixture(), live = await f.host.createSession(); cleanup.push(() => live.close());
  const ref = { ...live.reference }, cap = await f.open({ references: [ref] });
  expect((await cap.inspect()).inventory[0]!.reference.id).toBe(ref.id);
  await expect(cap.capture()).rejects.toThrow(); await live.close(); const captured = await cap.capture(); cap.verify(captured.bytes, captured.sha256);
  expect((await f.host.listSessions()).sessions.map(row => row.reference.id)).toEqual([ref.id]);
});

test('missing known correlations and discovered orphans stay explicit and cannot produce a smaller successful snapshot', async () => {
  const f = await fixture(), known = await f.session(), orphan = await f.session('retired'), absent = { id: crypto.randomUUID(), branchId: 'main' };
  const cap = await f.open({ references: [known, absent] }), report = await cap.inspect();
  expect(report.missing).toEqual([absent]); expect(report.uncorrelated.map(row => row.reference.id)).toEqual([orphan.id]);
  await expect(cap.capture()).rejects.toThrow(expect.objectContaining({ code: 's16_ops_native_reconciliation_required' }));
  expect((await f.host.listSessions()).sessions).toHaveLength(2);
});

test('explicit empty and deleted-only inventory are retained as metadata rather than inferred from missing storage or fabricated snapshots', async () => {
  const f = await fixture(), empty = await f.open(), first = await empty.capture(); empty.verify(first.bytes, first.sha256);
  expect(JSON.parse(Buffer.from(first.bytes).toString())).toMatchObject({ inventory: [], references: [], snapshot: null });
  await empty.close(); const ref = await f.session('deleted'), cap = await f.open({ references: [ref] }), second = await cap.capture(); cap.verify(second.bytes, second.sha256);
  expect(JSON.parse(Buffer.from(second.bytes).toString())).toMatchObject({ inventory: [{ state: 'deleted' }], references: [ref], snapshot: null });
});

test.each(['missing', 'mode', 'symlink', 'not-directory'] as const)('unavailable existing native %s refuses before initialization or repair', async kind => {
  const f = await fixture(); await f.host.close(); const path = f.paths.sessionDirectory;
  if (kind === 'missing') rmSync(path, { recursive: true });
  if (kind === 'mode') chmodSync(path, 0o755);
  if (kind === 'symlink') { renameSync(path, path + '-real'); symlinkSync(path + '-real', path); }
  if (kind === 'not-directory') { rmSync(path, { recursive: true }); writeFileSync(path, 'not a directory', { mode: 0o600 }); }
  await expect(f.open()).rejects.toThrow(); if (kind === 'missing') expect(existsSync(path)).toBe(false);
});

test.each(['hash', 'component', 'installation', 'workspace', 'opaque-artifact', 'retirement', 'deleted-resurrection', 'extra'] as const)('independent receipt/native validation refuses changed %s without restoring or modifying current custody', async kind => {
  const f = await fixture(), ref = await f.session('retired'), cap = await f.open({ references: [ref] }), original = await cap.capture();
  const value = JSON.parse(Buffer.from(original.bytes).toString('utf8'));
  if (kind === 'component') value.id = 'b'.repeat(32);
  if (kind === 'installation') value.installationId = 'foreign';
  if (kind === 'workspace') value.workspaceRoot = join(f.parent, 'foreign');
  if (kind === 'opaque-artifact') value.snapshot.sessions[0].artifacts[0].dataBase64 = Buffer.from('corrupt').toString('base64');
  if (kind === 'retirement') value.inventory[0].state = 'active';
  if (kind === 'deleted-resurrection') value.inventory[0].state = 'deleted';
  if (kind === 'extra') value.authority = true;
  const bytes = Buffer.from(JSON.stringify(value)); expect(() => cap.verify(bytes, kind === 'hash' ? '0'.repeat(64) : hash(bytes))).toThrow();
  cap.verify(original.bytes, original.sha256); expect((await f.host.listSessions()).sessions[0]!.state).toBe('retired');
});

test('owner guard loss across an actual public async boundary refuses stale metadata and opaque capture', async () => {
  const f = await fixture(), ref = await f.session(); let current = true;
  const cap = await f.open({ references: [ref], guard() { if (!current) throw new AppError('fixture_owner_changed', 409); } });
  const attempt = cap.capture(); current = false; await expect(attempt).rejects.toThrow(expect.objectContaining({ code: 'fixture_owner_changed' }));
  current = true; expect((await f.host.listSessions()).sessions).toHaveLength(1); const captured = await cap.capture(); cap.verify(captured.bytes, captured.sha256);
});

test('native scope and correlations are retained independently of mutable caller options or returned inspection objects', async () => {
  const f = await fixture(), ref = await f.session(), selected = [{ ...ref }];
  const input = { ...f.options, references: selected }, cap = await openS16NativeRoot(input); cleanup.push(() => cap.close());
  selected[0]!.id = crypto.randomUUID(); input.id = 'b'.repeat(32); input.installationId = 'changed';
  const captured = await cap.capture(); expect(JSON.parse(Buffer.from(captured.bytes).toString())).toMatchObject({ id: 'a'.repeat(32), installationId: 'fixture', references: [ref] });
  expect(Object.isFrozen((await cap.inspect()).inventory[0]!.reference)).toBe(true); cap.verify(captured.bytes, captured.sha256);
});

test('public snapshot identity bounds refuse before a root is initialized or an inventory is truncated', async () => {
  const f = await fixture(); const references = Array.from({ length: MAX_SNAPSHOT_SESSIONS + 1 }, () => ({ id: crypto.randomUUID(), branchId: 'main' }));
  const directory = join(f.parent, 'must-not-create'); await expect(f.open({ directory, references })).rejects.toThrow(expect.objectContaining({ code: 's16_ops_native_bounds' })); expect(existsSync(directory)).toBe(false);
  const actual = []; for (let index = 0; index <= MAX_SNAPSHOT_SESSIONS; index++) actual.push(await f.session());
  const cap = await f.open({ references: actual.slice(0, MAX_SNAPSHOT_SESSIONS) }); await expect(cap.inspect()).rejects.toThrow(expect.objectContaining({ code: 's16_ops_native_bounds' }));
  expect((await f.host.listSessions()).sessions).toHaveLength(MAX_SNAPSHOT_SESSIONS + 1);
});

test('a replaced native directory invalidates an existing capability before its new path can be inspected or captured', async () => {
  const f = await fixture(), ref = await f.session(), cap = await f.open({ references: [ref] });
  renameSync(f.paths.sessionDirectory, f.paths.sessionDirectory + '-original'); mkdirSync(f.paths.sessionDirectory, { mode: 0o700 });
  await expect(cap.inspect()).rejects.toThrow(expect.objectContaining({ code: 's16_ops_native_changed' })); await expect(cap.capture()).rejects.toThrow();
});

test('close refuses outstanding public operations until their original promises settle; it cannot report early native release', async () => {
  const f = await fixture(), ref = await f.session(), cap = await f.open({ references: [ref] });
  const capture = cap.capture(), observed = capture.then(() => null, (error: unknown) => error), closing = cap.close();
  await expect(closing).rejects.toThrow(expect.objectContaining({ code: 's16_ops_native_busy' }));
  expect(await observed).toMatchObject({ code: 's16_ops_native_closed' }); await cap.close(); await expect(cap.inspect()).rejects.toThrow(expect.objectContaining({ code: 's16_ops_native_closed' }));
  expect((await f.host.listSessions()).sessions).toHaveLength(1);
});

test('a real native conversation larger than command JSON limits captures and verifies through supported public snapshots', async () => {
  const f = await fixture(300_000), session = await f.host.createSession(), ref = { ...session.reference }; cleanup.push(() => session.close());
  await session.submit({ text: 'public-native-fixture '.repeat(10_000) }, { provider: 'codex-subscription', id: 'fixture', async *stream() {
    yield { type: 'message_complete', message: { type: 'assistant', id: crypto.randomUUID(), content: [{ type: 'text', text: 'Recorded fixture input.' }] } };
  } });
  await session.retire(); await session.close(); const cap = await f.open({ references: [ref] }), captured = await cap.capture();
  expect(captured.bytes.byteLength).toBeGreaterThan(131_072); cap.verify(captured.bytes, captured.sha256);
  expect(JSON.parse(Buffer.from(captured.bytes).toString()).snapshot.sessions[0].retired).toBe(true);
});

test('actual owning CHAT interpretation and MODEL work correlations capture after composed service closure under retained CHAT exclusion', async () => {
  const f = await composedFixture(); cleanup.push(() => f.close()); const work = await f.chat('Run the requested command in the working computer'); expect(work.state).toBe('completed'); await f.service.close();
  const maintenance = openS16RuntimeMaintenance({ directory: f.directory, installationId: 'fixture', browserResourceId: 'account' }); cleanup.push(() => maintenance.close());
  const database = maintenance.sources.find(source => source.name === 'conversation.sqlite')!.database;
  const rows = database.query<{ request_id: string; phase: string; session_id: string; branch_id: string }, []>('SELECT request_id,phase,session_id,branch_id FROM native_sessions ORDER BY request_id,phase').all();
  expect(rows.some(row => row.phase.startsWith('interpretation_'))).toBe(true);
  const models = maintenance.sources.find(source => source.name === 'model.sqlite')!.database;
  const modelRows = models.query<{ id: string; session_id: string; branch_id: string }, []>("SELECT id,json_extract(json,'$.session.id') AS session_id,json_extract(json,'$.session.branchId') AS branch_id FROM records WHERE json_type(json,'$.session')='object' ORDER BY id").all(); expect(modelRows.length).toBeGreaterThan(0);
  const roots = [...rows.map(row => ({ ...row, directory: join(f.directory, 'native-chat', row.request_id, row.phase) })), ...modelRows.map(row => ({ ...row, directory: join(f.directory, 'native-model', row.id) }))];
  for (const [index, row] of roots.entries()) {
    const cap = await openS16NativeRoot({ directory: row.directory, installationId: 'fixture', id: index.toString(16).padStart(32, '0'), references: [{ id: row.session_id, branchId: row.branch_id }], guard: maintenance.assertCurrent }); cleanup.push(() => cap.close());
    const captured = await cap.capture(); cap.verify(captured.bytes, captured.sha256);
    const value = JSON.parse(Buffer.from(captured.bytes).toString()); expect(value.snapshot.sessions[0].id).toBe(row.session_id); expect(value.snapshot.sessions[0].branchId).toBe(row.branch_id); expect(value.snapshot.sessions[0].retired).toBe(true);
  }
  expect(database.query('SELECT request_id,phase,session_id,branch_id FROM native_sessions ORDER BY request_id,phase').all()).toEqual(rows);
  expect(models.query("SELECT id,json_extract(json,'$.session.id') AS session_id,json_extract(json,'$.session.branchId') AS branch_id FROM records WHERE json_type(json,'$.session')='object' ORDER BY id").all()).toEqual(modelRows); maintenance.assertCurrent();
});
