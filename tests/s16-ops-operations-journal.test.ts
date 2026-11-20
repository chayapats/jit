import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { canonical } from '../src/s15/conversation/validation';
import { readS15RuntimeConfig } from '../src/s15/runtime-config';
import { s15CredentialKey } from '../src/s15/credentials';
import { adoptS16Operations } from '../src/s16/operations/adoption';
import { openS16ControlMaintenance } from '../src/s16/operations/control-maintenance';
import { openS16InstallationLease } from '../src/s16/operations/installation-lease';
import { assertS16OperationsOwnerBinding } from '../src/s16/operations/operations-owner';
import { canonicalS16OperationsControl, readS16OperationsControl, readS16OperationsFence, s16OperationsLimits, validateS16OperationsControl } from '../src/s16/operations/operations-state';
import type { S16OperationsJournal } from '../src/s16/operations/operations-journal';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const hash = 'b'.repeat(64), target = 'c'.repeat(64), cohort = 'd'.repeat(64);
const command = { requestId: 'backup_original', kind: 'backup' as const, hash };
async function cli(entry: string, args: string[], input?: string) {
  const child = Bun.spawn([process.execPath, entry, ...args], { stdin: input === undefined ? 'ignore' : new TextEncoder().encode(input), stdout: 'pipe', stderr: 'pipe' });
  const [out, error, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]); return { out, error, exit };
}
async function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-operations-journal-'))); cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const directory = join(parent, 'state'), configPath = join(parent, 'config.json');
  writeFileSync(configPath, JSON.stringify(s15StageConfig(directory, 'http://localhost:3041')), { mode: 0o600 });
  const init = await cli('src/main.ts', ['init', '--s15', '--config', configPath]); expect({ exit: init.exit, error: init.error }).toEqual({ exit: 0, error: '' });
  const config = readS15RuntimeConfig(configPath); adoptS16Operations(config, 'adoption_original', { now: () => 10, id: () => 'a'.repeat(32) });
  const owner = join(directory, 'owner/owner.sqlite'), fence = owner + '.ops/fence.json', control = join(directory, 'operations/control.json');
  const protectedPaths = [owner, owner + '.lifecycle.sqlite', join(directory, 's16-operations.lock.sqlite'), join(directory, 'recipients.sqlite')];
  const before = protectedPaths.map(path => readFileSync(path));
  return { directory, configPath, config, fence, control, unchanged() { expect(protectedPaths.map(path => readFileSync(path))).toEqual(before); } };
}
function context(f: Awaited<ReturnType<typeof fixture>>) {
  const ctx = openS16ControlMaintenance(f.config, existsSync(f.fence) ? { operationFence: readS16OperationsFence(f.directory) } : {}); cleanup.push(() => ctx.close()); return ctx;
}
const revision = (journal: S16OperationsJournal) => journal.read().revision;
function finishBackup(journal: S16OperationsJournal, requestId: string) {
  journal.advance(requestId, revision(journal), 'capturing');
  journal.advance(requestId, revision(journal), 'verifying', { targetSha256: target, cohortSha256: cohort });
  journal.retainPoint(requestId, revision(journal), { sha256: target, bytes: 123 });
  return journal.advance(requestId, revision(journal), 'complete');
}

test('owning journal upgrades only empty v1, retains original retries, CAS and terminal response-loss clearance without changing protected SQLite', async () => {
  const f = await fixture(), ctx = context(f), journal = ctx.operations({ now: () => 20, id: () => 'e'.repeat(32) });
  expect(journal.read().contract).toBe('s16-operations-control/v1');
  const first = journal.begin(command, 0); expect(first).toMatchObject({ revision: 1, fresh: true, request: { id: 'e'.repeat(32), admittedRevision: 1, createdAt: 20 } });
  expect(journal.read().contract).toBe('s16-operations-control/v2'); expect(existsSync(f.fence)).toBe(true);
  expect(journal.begin(command, 0)).toEqual({ ...first, fresh: false });
  const before = readFileSync(f.control);
  expect(() => journal.begin({ ...command, hash: target }, 1)).toThrow();
  expect(() => journal.begin({ ...command, requestId: 'other' }, 1)).toThrow();
  expect(() => journal.advance(command.requestId, 0, 'capturing')).toThrow(expect.objectContaining({ code: 's16_ops_revision_conflict' }));
  expect(() => journal.advance(command.requestId, 1, 'complete')).toThrow(); expect(readFileSync(f.control)).toEqual(before);
  const terminal = finishBackup(journal, command.requestId); expect(terminal.request.status).toBe('complete'); expect(existsSync(f.fence)).toBe(false);
  expect(journal.begin(command, 0)).toEqual({ ...terminal, fresh: false }); f.unchanged(); ctx.close();
  const lease = openS16InstallationLease({ directory: f.directory, mode: 'shared' }); lease.close();
});

test.each(['fence', 'write', 'clear'] as const)('interruption after durable %s resumes original request and keeps terminal clearance separate from replay', async boundary => {
  const f = await fixture(); let ctx = context(f), armed = true;
  let journal = ctx.operations({ id: () => 'e'.repeat(32), now: () => 20, after(at) { if (armed && at === boundary) { armed = false; throw Error('fixture-interruption'); } } });
  if (boundary === 'clear') { journal.begin(command, 0); expect(() => finishBackup(journal, command.requestId)).toThrow('fixture-interruption'); }
  else expect(() => journal.begin(command, 0)).toThrow('fixture-interruption');
  ctx.close(); ctx = context(f);
  journal = ctx.operations({ id() { throw Error('must retain operation identity'); }, now: () => 30 });
  const resumed = journal.begin(command, revision(journal));
  expect(resumed.request).toMatchObject({ id: 'e'.repeat(32), createdAt: 20, admittedRevision: 1 });
  if (boundary === 'clear') expect(resumed.request.status).toBe('complete'); else finishBackup(journal, command.requestId);
  expect(existsSync(f.fence)).toBe(false); f.unchanged();
});

test('a lost response after the terminal journal write clears only its original retained gate without allocating a replacement or repeating work', async () => {
  const f = await fixture(), ctx = context(f);
  const journal = ctx.operations({ id: () => 'e'.repeat(32), now: () => 20, after(boundary) {
    if (boundary === 'write' && journal.read().requests[0]?.status === 'complete') throw Error('fixture-terminal-response-loss');
  } });
  journal.begin(command, 0); expect(() => finishBackup(journal, command.requestId)).toThrow('fixture-terminal-response-loss');
  expect(existsSync(f.fence)).toBe(true); const receipt = readFileSync(f.control); ctx.close();
  const resumed = context(f).operations({ id() { throw Error('must not allocate'); }, now() { throw Error('must not change terminal time'); } });
  expect(resumed.begin(command, 0)).toMatchObject({ fresh: false, request: { id: 'e'.repeat(32), status: 'complete' } });
  expect(existsSync(f.fence)).toBe(false); expect(readFileSync(f.control)).toEqual(receipt); f.unchanged();
});

test('pending current metadata still blocks execution if its physical fence is lost; observational status cannot become writable-owner authority', async () => {
  const f = await fixture(), ctx = context(f), journal = ctx.operations({ id: () => 'e'.repeat(32) });
  journal.begin(command, 0); ctx.close(); unlinkSync(f.fence);
  expect(() => openS16InstallationLease({ directory: f.directory, mode: 'shared' })).toThrow(expect.objectContaining({ code: 's16_ops_reconciliation_required' }));
  const observer = openS16InstallationLease({ directory: f.directory, mode: 'shared', observation: true });
  try {
    expect(() => assertS16OperationsOwnerBinding(observer, f.directory)).toThrow(expect.objectContaining({ code: 's16_ops_observation_only' }));
    expect(() => openS16InstallationLease({ directory: f.directory, mode: 'shared' })).toThrow(); observer.assertCurrent();
    expect(() => openS16InstallationLease({ directory: f.directory, mode: 'exclusive' })).toThrow();
  } finally { observer.close(); }
  const status = await cli('src/s16/operations-cli.ts', ['status', '--s15', '--config', f.configPath]);
  expect(JSON.parse(status.out)).toMatchObject({ active: { requestId: command.requestId, phase: 'pending', status: 'running' } });
  expect(status.out).not.toContain('ownerIdentity'); expect(status.out).not.toContain('actions');
  const credential = await cli('src/main.ts', ['credential', '--s15', '--config', f.configPath, '--key', 'must_not_store', '--secret-stdin'], 'fixture-secret\n');
  expect(credential.exit).not.toBe(0); expect(credential.out + credential.error).not.toContain('fixture-secret');
  expect(existsSync(join(f.directory, 'vault', s15CredentialKey(f.config.installationId, 'must_not_store')))).toBe(false);
  const resumed = context(f), again = resumed.operations(); expect(again.begin(command, 0).fresh).toBe(false); expect(existsSync(f.fence)).toBe(true); f.unchanged();
});

test('unknown captures require owning readback and explicit resume; original intent hashes remain immutable on retries', async () => {
  const f = await fixture(), ctx = context(f), journal = ctx.operations({ id: () => 'e'.repeat(32) });
  journal.begin(command, 0); journal.advance(command.requestId, revision(journal), 'capturing');
  const intent = { id: 'native_original', kind: 'capture_native' as const, priorSha256: null, targetSha256: null };
  journal.recordIntent(command.requestId, revision(journal), intent);
  journal.recordIntent(command.requestId, revision(journal), { ...intent, id: 'backend_original', kind: 'capture_backend' });
  journal.block(command.requestId, revision(journal), 's16_ops_capture_unknown', intent.id);
  const blocked = journal.block(command.requestId, revision(journal), 's16_ops_capture_unknown', 'backend_original');
  expect(blocked.request.actions.every(action => action.state === 'unknown')).toBe(true);
  expect(() => journal.resume(command.requestId, revision(journal))).toThrow();
  expect(() => journal.advance(command.requestId, revision(journal), 'discarded')).toThrow();
  journal.observeAction(command.requestId, revision(journal), intent.id, 'applied', hash);
  const settled = journal.observeAction(command.requestId, revision(journal), 'backend_original', 'not_applied', null);
  expect(settled.request.status).toBe('blocked'); expect(settled.request.actions[0]).toMatchObject({ targetSha256: null, observedSha256: hash, state: 'confirmed' });
  journal.resume(command.requestId, revision(journal));
  expect(journal.recordIntent(command.requestId, 0, intent).fresh).toBe(false);
  expect(() => journal.recordIntent(command.requestId, revision(journal), { ...intent, targetSha256: hash })).toThrow();
  expect(journal.observeAction(command.requestId, 0, intent.id, 'applied', hash).fresh).toBe(false);
  const done = journal.advance(command.requestId, revision(journal), 'discarded'); expect(done.request.status).toBe('discarded'); expect(existsSync(f.fence)).toBe(false); f.unchanged();
});

test('maintenance gate is bound to the actual owner/configuration and cannot be replaced by another operation or archive-like tuple', async () => {
  const f = await fixture(), ctx = context(f), journal = ctx.operations({ id: () => 'e'.repeat(32) }); journal.begin(command, 0); ctx.close();
  const fence = readS16OperationsFence(f.directory), bytes = readFileSync(f.fence);
  expect(() => openS16ControlMaintenance(f.config)).toThrow();
  expect(() => openS16ControlMaintenance({ ...f.config, origin: 'http://localhost:3042' }, { operationFence: fence })).toThrow();
  expect(() => openS16ControlMaintenance(f.config, { operationFence: { ...fence, operationId: 'f'.repeat(32) } })).toThrow();
  expect(readFileSync(f.fence)).toEqual(bytes); const resumed = context(f); expect(resumed.operations().begin(command, 0).fresh).toBe(false); f.unchanged();
});

test('point retirement records original intent and absence before removing metadata, retaining the original backup receipt', async () => {
  const f = await fixture(), ctx = context(f); let id = 0;
  const journal = ctx.operations({ id: () => (++id).toString(16).padStart(32, '0') });
  const initial = journal.begin(command, 0); finishBackup(journal, command.requestId);
  const cleanupCommand = { requestId: 'cleanup_original', kind: 'cleanup' as const, hash, pointId: initial.request.pointId };
  journal.begin(cleanupCommand, revision(journal)); journal.advance(cleanupCommand.requestId, revision(journal), 'prepared', { cohortSha256: cohort, targetSha256: target });
  const planned = journal.planPointRemoval(cleanupCommand.requestId, revision(journal)); expect(journal.read().points[0]!.state).toBe('removing');
  expect(journal.planPointRemoval(cleanupCommand.requestId, 0).fresh).toBe(false);
  journal.advance(cleanupCommand.requestId, revision(journal), 'activating');
  expect(() => journal.recordPointRemoved(cleanupCommand.requestId, revision(journal))).toThrow();
  expect(() => journal.observeAction(cleanupCommand.requestId, revision(journal), planned.request.actions[0]!.id, 'applied', hash)).toThrow();
  journal.observeAction(cleanupCommand.requestId, revision(journal), planned.request.actions[0]!.id, 'applied', null);
  journal.recordPointRemoved(cleanupCommand.requestId, revision(journal)); expect(journal.read().points).toHaveLength(0);
  journal.advance(cleanupCommand.requestId, revision(journal), 'complete');
  expect(journal.read().requests[0]!.id).toBe(initial.request.id); expect(journal.read().requests[0]!.status).toBe('complete');
  expect(journal.begin(command, 0).fresh).toBe(false); expect(journal.read().points).toHaveLength(0); f.unchanged();
});

test('ten retained points refuse the next backup before retaining a new fence or evicting history', async () => {
  const f = await fixture(), ctx = context(f); let id = 0;
  const journal = ctx.operations({ id: () => (++id).toString(16).padStart(32, '0') });
  for (let index = 0; index < 10; index++) { const requestId = 'backup_' + index; journal.begin({ ...command, requestId }, revision(journal)); finishBackup(journal, requestId); }
  const before = readFileSync(f.control);
  expect(() => journal.begin({ ...command, requestId: 'overfull' }, revision(journal))).toThrow(expect.objectContaining({ code: 's16_ops_capacity' }));
  expect(readFileSync(f.control)).toEqual(before); expect(existsSync(f.fence)).toBe(false); expect(journal.read().points).toHaveLength(10); f.unchanged();
});

test('a known refused removal retains the point and original attempt; another explicitly identified attempt may proceed without rearming it', async () => {
  const f = await fixture(), ctx = context(f); let id = 0;
  const journal = ctx.operations({ id: () => (++id).toString(16).padStart(32, '0') });
  const backup = journal.begin(command, 0); finishBackup(journal, command.requestId);
  const requestId = 'cleanup_refusal'; journal.begin({ requestId, kind: 'cleanup', hash, pointId: backup.request.pointId }, revision(journal));
  journal.advance(requestId, revision(journal), 'prepared', { cohortSha256: cohort, targetSha256: target });
  journal.planPointRemoval(requestId, revision(journal), 'remove_first');
  journal.observeAction(requestId, revision(journal), 'remove_first', 'not_applied', target);
  expect(journal.read().points[0]!.state).toBe('retained');
  expect(journal.planPointRemoval(requestId, 0, 'remove_first').fresh).toBe(false); expect(journal.read().points[0]!.state).toBe('retained');
  journal.planPointRemoval(requestId, revision(journal), 'remove_second');
  expect(() => journal.planPointRemoval(requestId, revision(journal), 'remove_third')).toThrow();
  journal.advance(requestId, revision(journal), 'activating'); journal.observeAction(requestId, revision(journal), 'remove_second', 'applied', null);
  expect(() => journal.advance(requestId, revision(journal), 'discarded')).toThrow();
  journal.recordPointRemoved(requestId, revision(journal)); journal.advance(requestId, revision(journal), 'complete');
  const actions = journal.read().requests[1]!.actions; expect(actions.map(action => [action.id, action.state])).toEqual([['remove_first', 'not_applied'], ['remove_second', 'confirmed']]); f.unchanged();
});

test('journal reserves settlement capacity before admission and never evicts original receipts', async () => {
  const f = await fixture(), state = readS16OperationsControl(f.directory); state.contract = 's16-operations-control/v2'; state.revision = 1;
  const actions = Array.from({ length: 256 }, (_, index) => ({ id: 'action_' + index.toString().padStart(3, '0') + 'x'.repeat(80), kind: 'capture_native' as const, priorSha256: null, targetSha256: hash, state: 'confirmed' as const, observedSha256: hash }));
  while (true) {
    const index = state.requests.length, row = { id: index.toString(16).padStart(32, '0'), requestId: 'old_' + index, kind: 'export' as const, hash, phase: 'complete' as const, status: 'complete' as const, pointId: null, cohortSha256: cohort, targetSha256: target, createdAt: 10, updatedAt: 10, revision: 1, reason: null, configurationSha256: hash, admittedRevision: 1, actions };
    state.requests.push(row); if (Buffer.byteLength(JSON.stringify(state)) > s16OperationsLimits.bytes - 80_000) { state.requests.pop(); break; }
  }
  validateS16OperationsControl(state); writeFileSync(f.control, canonicalS16OperationsControl(state));
  const ctx = context(f), journal = ctx.operations({ id: () => 'e'.repeat(32) }), before = readFileSync(f.control);
  expect(() => journal.begin(command, 1)).toThrow(expect.objectContaining({ code: 's16_ops_capacity' }));
  expect(readFileSync(f.control)).toEqual(before); expect(existsSync(f.fence)).toBe(false); f.unchanged();
  ctx.close(); state.requests.splice(-2); writeFileSync(f.control, canonicalS16OperationsControl(state));
  const roomy = context(f).operations({ id: () => 'e'.repeat(32) });
  expect(Buffer.byteLength(readFileSync(f.control))).toBeGreaterThan(131_072);
  roomy.begin({ requestId: 'large_history_export', kind: 'export', hash }, 1);
  roomy.advance('large_history_export', revision(roomy), 'discarded');
  expect(roomy.read().requests.slice(0, -1)).toEqual(state.requests); expect(existsSync(f.fence)).toBe(false); f.unchanged();
});

test('nonempty legacy prototype metadata is observable and fenced, but the writer refuses to guess its historical conversion', async () => {
  const f = await fixture(), state = readS16OperationsControl(f.directory); state.revision = 1;
  state.requests.push({ id: 'e'.repeat(32), requestId: 'legacy_unknown', kind: 'export', hash, phase: 'capturing', status: 'unknown', pointId: null,
    cohortSha256: null, targetSha256: null, createdAt: 10, updatedAt: 10, revision: 1, reason: 's16_ops_capture_unknown', actions: [{ id: 'original_capture', kind: 'capture_native', priorSha256: null, targetSha256: null, state: 'unknown' }] });
  writeFileSync(f.control, canonicalS16OperationsControl(state)); const before = readFileSync(f.control);
  expect(() => openS16InstallationLease({ directory: f.directory, mode: 'shared' })).toThrow();
  const ctx = context(f), journal = ctx.operations(); expect(journal.read().requests[0]!.requestId).toBe('legacy_unknown');
  expect(() => journal.begin(command, 1)).toThrow(expect.objectContaining({ code: 's16_ops_control_upgrade_required' }));
  expect(() => journal.begin({ requestId: 'legacy_unknown', kind: 'export', hash }, 1)).toThrow(expect.objectContaining({ code: 's16_ops_control_upgrade_required' }));
  expect(readFileSync(f.control)).toEqual(before); expect(existsSync(f.fence)).toBe(false); f.unchanged();
});
