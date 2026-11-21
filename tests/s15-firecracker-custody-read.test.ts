import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { createFirecrackerManagementRelay, firecrackerRpcCustody } from '../src/s15/vm/firecracker/rpc';
import { firecrackerRuntimeFixture } from './fixtures/s15-firecracker-runtime';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function fixture() { const f = await firecrackerRuntimeFixture(); cleanup.push(() => f.close()); return f; }
const changes = (f: Awaited<ReturnType<typeof fixture>>) => f.journal().db.query<{ n: number }, []>('SELECT total_changes() n').get()!.n;

test('owning metadata cut leaves unverified state, SQLite bytes and host effects unchanged and discloses no private context', async () => {
  const f = await fixture(), before = readFileSync(f.path), n = changes(f), first = f.runtime().custody();
  expect(first.computer.state).toBe('unverified'); expect(first.journal.rows).toEqual({ computers: 1, jobs: 0, snapshots: 0, instances: 1 }); expect(first.active).toBeNull(); expect(first.requested).toBeNull();
  expect(f.runtime().custody().journal.sha256).toBe(first.journal.sha256); expect(changes(f)).toBe(n); expect(readFileSync(f.path)).toEqual(before); expect(f.commands).toEqual([]); expect(f.requests).toEqual([]); expect(f.starts()).toBe(0);
  const text = JSON.stringify(first); expect(text).not.toContain(f.root); expect(text).not.toContain('hostBootId'); expect(text).not.toContain('context');
  const scope = { computerId: f.runtime().computerId, selectionSha256: f.runtime().selectionSha256, basis: 'protocol_fixture' as const }; expect(firecrackerRpcCustody(first, scope, null)).toEqual(first);
});

test('original unknown launch/context remains unknown through repeated cuts without inspect/reconcile/driver work', async () => {
  const f = await fixture(); await f.runtime().inspect(); f.lostLaunch(); const command = f.mutation(1, 'launch'); expect((await f.runtime().submit(command)).state).toBe('unknown');
  const n = changes(f), commands = [...f.commands], requests = [...f.requests], cut = f.runtime().custody(command.requestId);
  expect(cut.active).toMatchObject({ command, state: 'unknown' }); expect(cut.requested).toMatchObject({ requestId: command.requestId, receipt: { command, state: 'unknown' } });
  expect(f.runtime().custody(command.requestId)).toEqual(cut); expect(changes(f)).toBe(n); expect(f.commands).toEqual(commands); expect(f.requests).toEqual(requests); expect(f.starts()).toBe(1);
  expect(JSON.stringify(cut)).not.toContain(f.root); expect(JSON.stringify(cut)).not.toContain('invocationId'); expect(JSON.stringify(cut)).not.toContain('hostBootId');
});

test('checkpoint retirement changes the complete journal digest and retained tombstone count without exporting disks', async () => {
  const f = await fixture(); await f.runtime().inspect(); await f.runtime().submit(f.mutation(1, 'launch')); await f.runtime().submit(f.mutation(2, 'stop'));
  const tag = 'jit-' + 'a'.repeat(32); await f.runtime().submit(f.mutation(3, 'checkpoint', tag)); const live = f.runtime().custody();
  await f.runtime().submit(f.mutation(4, 'retire', tag)); const retired = f.runtime().custody(); expect(retired.journal.sha256).not.toBe(live.journal.sha256); expect(retired.journal.rows.snapshots).toBe(1);
  const n = changes(f); expect(f.runtime().custody().journal.sha256).toBe(retired.journal.sha256); expect(changes(f)).toBe(n); expect(JSON.stringify(retired)).not.toContain(f.disk);
});

test('current digest includes private context progress and refuses forgotten committed requests', async () => {
  const f = await fixture(); await f.runtime().inspect(); f.lostLaunch(); const command = f.mutation(1, 'launch'); await f.runtime().submit(command);
  const first = f.runtime().custody(), computer = f.runtime().current();
  f.journal().db.exec("UPDATE fc_jobs SET context=json_set(context,'$.coldDone',json('true'))");
  const changed = f.runtime().custody(); expect(changed.journal.sha256).not.toBe(first.journal.sha256); expect(changed.computer).toEqual(computer);
  await f.runtime().reconcile(command.requestId); await f.runtime().submit(f.mutation(2, 'stop'));
  f.journal().db.query('DELETE FROM fc_jobs WHERE request_id=?').run(command.requestId); expect(() => f.runtime().custody()).toThrow();
});

test('cuts retain accepted and not-sent original revisions without dispatch and allow later owning work', async () => {
  const f = await fixture(); await f.runtime().inspect(); const command = f.mutation(1, 'launch');
  f.journal().admit(command); const accepted = f.runtime().custody(command.requestId);
  expect(accepted.active?.state).toBe('accepted'); expect(f.starts()).toBe(0);
  f.journal().notSent(command.computerId, command.requestId); const notSent = f.runtime().custody(command.requestId);
  expect(notSent.active).toBeNull(); expect(notSent.requested?.receipt?.state).toBe('not_sent'); expect(notSent.computer.revision).toBe(2);
  await f.runtime().submit(f.mutation(2, 'launch')); expect(f.runtime().custody().computer.state).toBe('running'); expect(f.starts()).toBe(1);
});

test('running checkpoint unknown and later restore keep original launch history and snapshot tombstones readable', async () => {
  const f = await fixture(); await f.runtime().inspect(); await f.runtime().submit(f.mutation(1, 'launch'));
  const tag = 'jit-' + 'c'.repeat(32); f.lostLaunch(); const command = f.mutation(2, 'checkpoint', tag);
  expect((await f.runtime().submit(command)).state).toBe('unknown');
  const n = changes(f), commands = f.commands.length, cut = f.runtime().custody(command.requestId);
  expect(cut.active?.state).toBe('unknown'); expect(changes(f)).toBe(n); expect(f.commands).toHaveLength(commands);
  expect((await f.runtime().reconcile(command.requestId)).state).toBe('committed'); expect(f.runtime().custody().journal.rows.snapshots).toBe(1);
  await f.runtime().submit(f.mutation(3, 'stop')); await f.runtime().submit(f.mutation(4, 'restore', tag));
  expect(f.runtime().custody().computer.state).toBe('stopped');
  await f.runtime().submit(f.mutation(5, 'retire', tag)); expect(f.runtime().custody().journal.rows).toMatchObject({ jobs: 5, snapshots: 1 });
});

test('authenticated custody RPC reads original committed/absent receipts while never promoting unverified state', async () => {
  const f = await fixture(), credential = 'fixture_root_custody_' + 'a'.repeat(32), installationId = 'fixture';
  const relay = createFirecrackerManagementRelay(f.runtime(), { credential, installationId, port: 0 }); cleanup.push(() => relay.close());
  const read = async (requestId: string | null) => {
    const response = await fetch(relay.origin + '/v1/firecracker', { method: 'POST', headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' }, body: JSON.stringify({ contract: 's16-firecracker-management/v1', installationId, operation: 'custody', requestId }) }); expect(response.status).toBe(200); return (await response.json() as { result: unknown }).result;
  };
  const scope = { computerId: f.runtime().computerId, selectionSha256: f.runtime().selectionSha256, basis: 'protocol_fixture' as const }, absent = 'f'.repeat(32), n = changes(f);
  const first = firecrackerRpcCustody(await read(absent), scope, absent); expect(first.requested).toEqual({ requestId: absent, receipt: null }); expect(first.computer.state).toBe('unverified'); expect(changes(f)).toBe(n); expect(f.commands).toEqual([]);
  await f.runtime().inspect(); const command = f.mutation(1, 'launch'); await f.runtime().submit(command); const before = changes(f), count = f.commands.length;
  const current = firecrackerRpcCustody(await read(command.requestId), scope, command.requestId); expect(current.requested!.receipt).toMatchObject({ command, state: 'committed' }); expect(changes(f)).toBe(before); expect(f.commands).toHaveLength(count);
  f.authorize(false); const response = await fetch(relay.origin + '/v1/firecracker', { method: 'POST', headers: { Authorization: 'Bearer ' + credential, 'Content-Type': 'application/json' }, body: JSON.stringify({ contract: 's16-firecracker-management/v1', installationId, operation: 'custody', requestId: null }) }); expect(response.status).toBe(503);
});

test('oversized owning schema refuses before loading its text into the custody fingerprint', async () => {
  const f = await fixture(), db = f.journal().db;
  db.exec("DROP INDEX fc_one_active; CREATE UNIQUE INDEX fc_one_active /*" + 'x'.repeat(8193) + "*/ ON fc_jobs(computer_id) WHERE state IN ('accepted','dispatched','unknown')");
  const original = db.query, query = original.bind(db); let loaded = false, error: unknown;
  db.query = ((sql: string) => { if (sql.startsWith('SELECT type,name,tbl_name,sql')) loaded = true; return query(sql); }) as typeof db.query;
  try { f.runtime().custody(); } catch (value) { error = value; } finally { db.query = original; }
  expect(error).toMatchObject({ code: 'vm_firecracker_custody_bounds' }); expect(loaded).toBe(false); expect(f.commands).toEqual([]);
});

test('owning runtime applies instance byte bounds before its selected-instance decoder reads a row', async () => {
  const f = await fixture(), db = f.journal().db; db.query('UPDATE fc_instances SET data=?').run(JSON.stringify({ invalid: 'x'.repeat(65536) }));
  const original = db.query, query = original.bind(db); let loaded = false, error: unknown;
  db.query = ((sql: string) => { if (sql.startsWith('SELECT data FROM fc_instances')) loaded = true; return query(sql); }) as typeof db.query;
  try { f.runtime().custody(); } catch (value) { error = value; } finally { db.query = original; }
  expect(error).toMatchObject({ code: 'vm_firecracker_custody_bounds' }); expect(loaded).toBe(false); expect(f.commands).toEqual([]);
});

test.each(['reader', 'table', 'hash', 'active', 'context', 'bounds', 'tombstone'] as const)('corrupt helper %s refuses a custody reference without executing recovery', async kind => {
  const f = await fixture(); await f.runtime().inspect(); f.lostLaunch(); const command = f.mutation(1, 'launch'); expect((await f.runtime().submit(command)).state).toBe('unknown');
  if (kind === 'reader') f.journal().db.exec('PRAGMA user_version=99');
  if (kind === 'table') f.journal().db.exec('CREATE TABLE unknown_authority (id TEXT)');
  if (kind === 'hash') f.journal().db.exec("UPDATE fc_jobs SET hash='changed'");
  if (kind === 'active') f.journal().db.exec("UPDATE fc_computers SET data=json_set(data,'$.activeRequestId',NULL)");
  if (kind === 'context') f.journal().db.exec("UPDATE fc_jobs SET context='{}'");
  if (kind === 'bounds') f.journal().db.query('UPDATE fc_jobs SET context=?').run(JSON.stringify({ invalid: 'x'.repeat(65536) }));
  if (kind === 'tombstone') f.journal().db.query('INSERT INTO fc_snapshots VALUES (?,?,?,?,?)').run(command.computerId, 'jit-' + 'b'.repeat(32), 'c'.repeat(64), f.selected.disk.bytes, 1);
  const n = changes(f), commands = [...f.commands]; expect(() => f.runtime().custody(command.requestId)).toThrow(); expect(changes(f)).toBe(n); expect(f.commands).toEqual(commands);
});
