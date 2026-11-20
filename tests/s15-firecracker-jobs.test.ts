import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtempSync, readFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FirecrackerHostJobs, FirecrackerHostJournal, firecrackerHostCommand, type FirecrackerHostCommand, type FirecrackerHostJobDriver, type FirecrackerJobObservation } from '../src/s15/vm/firecracker/jobs';

// Real durable journal / barriers / protocol driver; none of this certifies native VM execution.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const id = (n: number) => n.toString(16).padStart(32, '0'), sha = 'a'.repeat(64), diskBytes = 128 * 1048576;
function journal(path = ':memory:', create = true) {
  const j = new FirecrackerHostJournal(path, { create }); let closed = false;
  const close = () => { if (!closed) { j.close(); closed = true; } }; cleanup.push(close); return { j, close };
}
function location() { const path = mkdtempSync(join(tmpdir(), 'jit-fc-jobs-')); cleanup.push(() => rmSync(path, { recursive: true, force: true })); return join(path, 'jobs.sqlite'); }
function install(j: FirecrackerHostJournal, computerId = 'jit-work-fixture') {
  j.register({ id: computerId, selectionSha256: sha, diskBytes, basis: 'protocol_fixture' });
  j.observe(computerId, { state: 'stopped', launchId: null, basis: 'protocol_fixture' });
}
function command(j: FirecrackerHostJournal, request = 1, computerId = 'jit-work-fixture', kind: 'launch' | 'stop' = 'launch'): FirecrackerHostCommand {
  const c = j.computer(computerId); return { contract: 's16-firecracker-host-command/v1', requestId: id(request), computerId, selectionSha256: sha, expectedRevision: c.revision, expectedLaunchId: c.launchId, kind };
}
function driver(extra: Partial<FirecrackerHostJobDriver> = {}) {
  let executions = 0, reads = 0;
  const port: FirecrackerHostJobDriver = { basis: 'protocol_fixture', async execute(job, control) {
    await control.guard(); control.record({ privateRecord: 'PROTECTED_CONTEXT_SENTINEL', original: job.command.requestId }); executions++;
    return { state: job.command.kind === 'launch' ? 'running' : 'stopped', launchId: job.command.kind === 'launch' ? job.command.requestId : job.command.expectedLaunchId, basis: 'protocol_fixture' };
  }, async readBack() { reads++; return null; }, ...extra };
  return { port, executions: () => executions, reads: () => reads };
}

test('closed commands cannot choose a path/argv, reinterpret a snapshot or coerce an object into a command kind', () => {
  const { j } = journal(); install(j); const original = command(j);
  for (const patch of [{ hostPath: '/outside' }, { kind: 'shell' }, { kind: 'launch', snapshotId: `jit-${id(2)}` }, { kind: 'restore', snapshotId: '../snapshot' }, { expectedRevision: 0 }, { expectedRevision: -0 }, { expectedLaunchId: 'pid:1' }, { requestId: id(1).toUpperCase() + 'x' }, { kind: { toString() { throw Error('must not coerce'); } } }]) expect(() => firecrackerHostCommand({ ...original, ...patch })).toThrow();
  expect(j.computer(original.computerId).revision).toBe(1); expect(j.db.query('SELECT * FROM fc_jobs').all()).toHaveLength(0);
});

test('configuration metadata is unverified and a changed selected host never overwrites an existing registration', () => {
  const { j } = journal(); j.register({ id: 'jit-work-fixture', selectionSha256: sha, diskBytes, basis: 'protocol_fixture' });
  expect(j.computer('jit-work-fixture').state).toBe('unverified');
  expect(() => j.admit(command(j))).toThrow(expect.objectContaining({ code: 'vm_firecracker_job_unsettled' }));
  expect(() => j.register({ id: 'jit-work-fixture', selectionSha256: 'b'.repeat(64), diskBytes, basis: 'protocol_fixture' })).toThrow(expect.objectContaining({ code: 'vm_firecracker_selection_changed' }));
  expect(j.computer('jit-work-fixture').selectionSha256).toBe(sha);
});

test('original committed identity survives actual SQLite close/reopen without another driver call or private-context export', async () => {
  const path = location(), first = journal(path); install(first.j); const request = command(first.j), d = driver();
  const committed = await new FirecrackerHostJobs(first.j, d.port).run(request, () => {});
  expect(committed.state).toBe('committed'); expect(committed.revision).toBe(2); expect(d.executions()).toBe(1);
  expect(JSON.stringify(committed)).not.toContain('PROTECTED_CONTEXT_SENTINEL');
  expect(first.j.context(request.computerId, request.requestId)).toEqual({ privateRecord: 'PROTECTED_CONTEXT_SENTINEL', original: request.requestId });
  first.close(); const second = journal(path, false); second.j.recover();
  expect(await new FirecrackerHostJobs(second.j, d.port).run(request, () => {})).toEqual(committed);
  expect(d.executions()).toBe(1); expect(second.j.computer(request.computerId).launchId).toBe(request.requestId);
});

test('duplicates do not erase the original live-driver fence; timeout keeps capacity and blocks read-back until that driver settles', async () => {
  const { j } = journal(); install(j); const request = command(j), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), ended = Promise.withResolvers<void>();
  let effects = 0, reads = 0;
  const d = driver({ async execute(job, control) {
    try { await control.guard(); control.record({ original: job.command.requestId }); effects++; entered.resolve(); await release.promise; await control.guard(); effects++; return { state: 'running', launchId: request.requestId, basis: 'protocol_fixture' }; }
    finally { ended.resolve(); }
  }, async readBack(job, control) { reads++; await control.guard(); return { state: 'running', launchId: job.command.requestId, basis: 'protocol_fixture' }; } });
  const jobs = new FirecrackerHostJobs(j, d.port), running = jobs.run(request, () => {}, { timeoutMs: 20 }); await entered.promise;
  expect((await jobs.run(request, () => {})).state).toBe('dispatched');
  expect((await running).state).toBe('unknown'); expect(j.computer(request.computerId).activeRequestId).toBe(request.requestId);
  expect((await jobs.reconcile(request.computerId, request.requestId, () => {})).state).toBe('unknown'); expect(reads).toBe(0);
  expect(() => j.admit({ ...command(j, 2), kind: 'stop' })).toThrow(expect.objectContaining({ code: 'vm_firecracker_job_unsettled' }));
  release.resolve(); await ended.promise; await Promise.resolve(); await Promise.resolve();
  expect((await jobs.reconcile(request.computerId, request.requestId, () => {})).state).toBe('committed');
  expect(effects).toBe(1); expect(reads).toBe(1);
});

test('authority revoked after effect withholds publication; current read authority can recover only that original receipt', async () => {
  const { j } = journal(); install(j); const request = command(j); let authorized = true, calls = 0;
  const d = driver({ async execute(job, control) { await control.guard(); calls++; authorized = false; return { state: 'running', launchId: job.command.requestId, basis: 'protocol_fixture' }; }, async readBack(job, control) { await control.guard(); return { state: 'running', launchId: job.command.requestId, basis: 'protocol_fixture' }; } });
  const jobs = new FirecrackerHostJobs(j, d.port), auth = () => { if (!authorized) throw Error('revoked'); };
  expect((await jobs.run(request, auth)).state).toBe('unknown'); expect(j.computer(request.computerId).state).toBe('uncertain');
  await expect(jobs.reconcile(request.computerId, request.requestId, auth)).rejects.toThrow('revoked');
  expect((await jobs.reconcile(request.computerId, request.requestId, () => {})).state).toBe('committed'); expect(calls).toBe(1);
});

test('accepted restart is provably not sent; dispatched restart stays unknown and cannot be replaced or cleared by an ordinary observation', async () => {
  const path = location(), a = journal(path); install(a.j); const accepted = command(a.j); a.j.admit(accepted); a.close();
  const b = journal(path, false); b.j.recover(); expect(b.j.receipt(accepted.computerId, accepted.requestId).state).toBe('not_sent'); expect(b.j.computer(accepted.computerId).revision).toBe(2);
  const dispatched = command(b.j, 2); b.j.admit(dispatched); b.j.dispatched(dispatched.computerId, dispatched.requestId); b.j.record(b.j.receipt(dispatched.computerId, dispatched.requestId), { original: 'retained' }); b.close();
  const c = journal(path, false); c.j.recover(); const d = driver(), jobs = new FirecrackerHostJobs(c.j, d.port);
  expect((await jobs.run(dispatched, () => {})).state).toBe('unknown'); expect(d.executions()).toBe(0);
  expect(c.j.context(dispatched.computerId, dispatched.requestId)).toEqual({ original: 'retained' });
  expect((await jobs.reconcile(dispatched.computerId, dispatched.requestId, () => {})).state).toBe('unknown'); expect(d.reads()).toBe(1);
  expect(() => c.j.admit(command(c.j, 3))).toThrow(expect.objectContaining({ code: 'vm_firecracker_job_unsettled' }));
  expect(() => c.j.observe(dispatched.computerId, { state: 'stopped', launchId: null, basis: 'protocol_fixture' })).toThrow(expect.objectContaining({ code: 'vm_firecracker_job_unsettled' }));
});

test('stale revision/selection/launch and a foreign computer cannot retarget or read an original command', async () => {
  const { j } = journal(); install(j); install(j, 'jit-work-other'); const request = command(j), d = driver();
  for (const patch of [{ expectedRevision: 2 }, { expectedLaunchId: id(8) }, { selectionSha256: 'b'.repeat(64) }]) expect(() => j.admit({ ...request, ...patch })).toThrow(expect.objectContaining({ code: 'vm_firecracker_job_stale' }));
  await new FirecrackerHostJobs(j, d.port).run(request, () => {});
  expect(() => j.admit({ ...request, computerId: 'jit-work-other' })).toThrow(expect.objectContaining({ code: 'vm_firecracker_job_conflict' }));
  expect(() => j.receipt('jit-work-other', request.requestId)).toThrow(expect.objectContaining({ code: 'vm_firecracker_job_not_found' }));
  expect(d.executions()).toBe(1);
});

test('snapshot tags retain immutable hashes through checkpoint/restore/retire and cannot be overwritten or reused', async () => {
  const { j } = journal(); install(j); const tag = `jit-${id(20)}`;
  const d = driver({ async execute(job, control) {
    await control.guard(); const c = job.command;
    if (c.kind === 'launch') return { state: 'running', launchId: c.requestId, basis: 'protocol_fixture' };
    if (c.kind === 'checkpoint') return { state: 'running', launchId: c.requestId, basis: 'protocol_fixture', snapshot: { id: c.snapshotId, sha256: 'c'.repeat(64), bytes: diskBytes } };
    return { state: 'stopped', launchId: c.expectedLaunchId, basis: 'protocol_fixture' };
  } });
  const jobs = new FirecrackerHostJobs(j, d.port); await jobs.run(command(j), () => {});
  const checkpoint: FirecrackerHostCommand = { ...command(j, 2), kind: 'checkpoint', snapshotId: tag };
  expect((await jobs.run(checkpoint, () => {})).observation?.snapshot?.sha256).toBe('c'.repeat(64));
  expect(() => j.admit({ ...command(j, 3), kind: 'checkpoint', snapshotId: tag })).toThrow(expect.objectContaining({ code: 'vm_firecracker_snapshot_unavailable' }));
  expect((await jobs.run({ ...command(j, 3), kind: 'restore', snapshotId: tag }, () => {})).state).toBe('committed');
  expect((await jobs.run({ ...command(j, 4), kind: 'retire', snapshotId: tag }, () => {})).state).toBe('committed');
  expect(() => j.admit({ ...command(j, 5), kind: 'restore', snapshotId: tag })).toThrow(expect.objectContaining({ code: 'vm_firecracker_snapshot_unavailable' }));
  expect(() => j.admit({ ...command(j, 5), kind: 'checkpoint', snapshotId: tag })).toThrow(expect.objectContaining({ code: 'vm_firecracker_snapshot_unavailable' }));
  expect(j.receipt(checkpoint.computerId, checkpoint.requestId).observation?.snapshot).toEqual({ id: tag, sha256: 'c'.repeat(64), bytes: diskBytes });
});

test.each(['basis', 'launch', 'state', 'extra'] as const)('an invalid %s observation cannot commit or release unknown capacity', async kind => {
  const { j } = journal(); install(j); const request = command(j);
  const facts: FirecrackerJobObservation = { state: 'running', launchId: request.requestId, basis: 'protocol_fixture' };
  if (kind === 'basis') facts.basis = 'protected_host'; if (kind === 'launch') facts.launchId = id(88); if (kind === 'state') facts.state = 'stopped';
  const value = kind === 'extra' ? { ...facts, credential: 'DO_NOT_EXPORT' } : facts;
  const d = driver({ async execute(_job, control) { await control.guard(); return value; } });
  const receipt = await new FirecrackerHostJobs(j, d.port).run(request, () => {});
  expect(receipt.state).toBe('unknown'); expect(receipt.observation).toBeNull(); expect(j.computer(request.computerId).activeRequestId).toBe(request.requestId);
});

test('non-owner/read refusal occurs before admission and old receipts remain available when the finite journal fills', async () => {
  const { j } = journal(); install(j); const d = driver(), jobs = new FirecrackerHostJobs(j, d.port);
  await expect(jobs.run(command(j), () => { throw Error('not authorized'); })).rejects.toThrow('not authorized');
  expect(j.db.query('SELECT * FROM fc_jobs').all()).toHaveLength(0);
  let original: FirecrackerHostCommand | null = null;
  for (let n = 1; n <= 4096; n++) { const c = command(j, n, 'jit-work-fixture', 'stop'); original ??= c; j.admit(c); j.dispatched(c.computerId, c.requestId); j.finish(c.computerId, c.requestId, { state: 'stopped', launchId: null, basis: 'protocol_fixture' }); }
  expect(() => j.admit(command(j, 4097))).toThrow(expect.objectContaining({ code: 'vm_firecracker_job_capacity' }));
  expect(j.admit(original!).fresh).toBe(false); expect(j.receipt(original!.computerId, original!.requestId).state).toBe('committed');
});

test('owned private database refuses a symlink and a future WAL reader format without resetting it', () => {
  const path = location(), { j } = journal(path); install(j); const link = path + '.link'; symlinkSync(path, link);
  expect(() => new FirecrackerHostJournal(link)).toThrow(expect.objectContaining({ code: 'vm_firecracker_journal_invalid' }));
  j.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA user_version=2');
  expect(readFileSync(path).readUInt32BE(60)).toBe(1);
  expect(() => new FirecrackerHostJournal(path)).toThrow(expect.objectContaining({ code: 'vm_firecracker_journal_invalid' }));
  expect(j.db.query('PRAGMA user_version').get()).toEqual({ user_version: 2 });
  const other = path + '.other'; const db = new Database(other); db.exec('CREATE TABLE owner_data(value TEXT)'); db.close();
  expect(() => new FirecrackerHostJournal(other)).toThrow(expect.objectContaining({ code: 'vm_firecracker_journal_invalid' }));
});
