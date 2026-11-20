import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { opsAtomic, opsDirectory, opsWrite } from '../src/s14/ops-files';
import { readS15RuntimeConfig } from '../src/s15/runtime-config';
import { adoptS16Operations } from '../src/s16/operations/adoption';
import { openS16ControlMaintenance } from '../src/s16/operations/control-maintenance';
import { ownS16Staging } from '../src/s16/operations/owned-staging';
import { canonicalS16OperationsControl, readS16OperationsFence, s16BackupAbortActions, validateS16OperationsControl } from '../src/s16/operations/operations-state';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const requestId = 'backup_original', target = 'd'.repeat(64), cohort = 'e'.repeat(64);
/** Actual current owning stores/exclusion; deliberately corrupt local capture bytes, not an aggregate backup proof. */
async function fixture(role: 'native' | 'point' = 'point') {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-staging-lifecycle-'))), directory = join(parent, 'state'), configPath = join(parent, 'config.json'); cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  writeFileSync(configPath, JSON.stringify(s15StageConfig(directory, 'http://localhost:3041')), { mode: 0o600 });
  const child = Bun.spawn([process.execPath, 'src/main.ts', 'init', '--s15', '--config', configPath], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]); expect({ exit, error }).toEqual({ exit: 0, error: '' });
  const config = readS15RuntimeConfig(configPath); adoptS16Operations(config, 'adoption_original');
  let ctx = openS16ControlMaintenance(config); cleanup.push(() => ctx.close());
  const open = () => { ctx.close(); ctx = openS16ControlMaintenance(config, existsSync(join(directory, 'owner/owner.sqlite.ops/fence.json')) ? { operationFence: readS16OperationsFence(directory) } : {}); return ctx; };
  const journal = ctx.operations(); journal.begin({ requestId, kind: 'backup', hash: 'c'.repeat(64) }, journal.read().revision); journal.advance(requestId, journal.read().revision, 'capturing');
  const captureId = (role === 'native' ? 'native_set_original_' : 'point_capture_original_') + 'f'.repeat(64);
  journal.recordIntent(requestId, journal.read().revision, { id: captureId, kind: role === 'native' ? 'capture_native' : 'capture_backend', priorSha256: null, targetSha256: null });
  const owned = ownS16Staging(directory, journal, requestId, role, captureId, ctx.assertCurrent), original = journal.read().requests[0]!;
  const plan = join(owned.root, 'plan.json'); opsWrite(plan, '{interrupted metadata');
  const file = role === 'point' ? join(owned.data, 'ledgers', original.pointId!, 'model.sqlite') : join(owned.data, 'plan.json'); opsDirectory(join(file, '..')); opsWrite(file, 'partial bytes');
  journal.block(requestId, journal.read().revision, 's16_ops_capture_interrupted', captureId);
  const protectedPaths = ['owner/owner.sqlite', 'owner/owner.sqlite.lifecycle.sqlite', 'runtime/model.sqlite', 's16-operations.lock.sqlite', 'recipients.sqlite'].map(path => join(directory, path)), before = protectedPaths.map(path => readFileSync(path));
  return { parent, directory, configPath, config, owned, captureId, original, plan, file, open, get context() { return ctx; }, unchanged() { expect(protectedPaths.map(path => readFileSync(path))).toEqual(before); } };
}

test.each(['native', 'point'] as const)('abort preserves unknown %s capture facts and explicit retirement removes corrupt owned bytes without changing current authority', async role => {
  const f = await fixture(role), actions = f.context.operations().read().requests[0]!.actions;
  const abort = f.context.abortBackup(requestId), state = f.context.operations().read();
  expect(state.contract).toBe('s16-operations-control/v3'); expect(state.requests[0]!.actions).toEqual(actions); expect(state.requests[0]).toMatchObject({ status: 'discarded', abort: { priorPhase: 'capturing', point: 'absent', captureResources: 'released' } });
  expect(existsSync(join(f.directory, 'owner/owner.sqlite.ops/fence.json'))).toBe(false); expect(readFileSync(f.plan, 'utf8')).toBe('{interrupted metadata');
  const ctx = f.open(); expect(ctx.abortBackup(requestId)).toEqual(abort);
  const result = ctx.retireStaging('retire_original', { sourceRequestId: requestId }); expect(result.state).toBe('removed'); expect(existsSync(f.owned.root)).toBe(false);
  expect(ctx.retireStaging('retire_original', { sourceRequestId: requestId })).toEqual(result); expect(ctx.abortBackup(requestId)).toEqual(abort); expect(ctx.operations().read().requests[0]!.actions).toEqual(actions);
  expect(existsSync(join(f.directory, 'operations/staging-retention', result.operationId))).toBe(true); f.unchanged();
  opsDirectory(f.owned.root); opsWrite(join(f.owned.root, 'reappeared'), 'do not delete');
  expect(() => ctx.retireStaging('retire_original', { sourceRequestId: requestId })).toThrow(expect.objectContaining({ code: 's16_ops_staging_reappeared' })); expect(readFileSync(join(f.owned.root, 'reappeared'), 'utf8')).toBe('do not delete');
});

test('abort refuses while an original capture capability is retained and generic discard cannot abandon unknown facts', async () => {
  const f = await fixture(), journal = f.context.operations(), before = journal.read(), capture = f.context.pointCapture(requestId);
  expect(() => journal.advance(requestId, before.revision, 'discarded')).toThrow(); expect(() => f.context.abortBackup(requestId)).toThrow(expect.objectContaining({ code: 's16_ops_source_release_unknown' })); expect(journal.read()).toEqual(before);
  await capture.close(); f.context.abortBackup(requestId); f.unchanged();
});

test.each(['actions', 'scope', 'phase', 'resources', 'other_effect'] as const)('v3 codec refuses a forged abort %s while retaining the original receipt', async corruption => {
  const f = await fixture(); f.context.abortBackup(requestId); const control = JSON.parse(JSON.stringify(f.context.operations().read())), request = control.requests[0];
  if (corruption === 'actions') request.actions[0].state = 'confirmed';
  if (corruption === 'scope') request.abort.scopeSha256 = '0'.repeat(64);
  if (corruption === 'phase') request.abort.priorPhase = 'activating';
  if (corruption === 'resources') request.abort.captureResources = 'unknown';
  if (corruption === 'other_effect') { request.actions[0].kind = 'select_package'; request.actions[0].targetSha256 = target; request.abort.actionsSha256 = s16BackupAbortActions(request); }
  expect(() => validateS16OperationsControl(control)).toThrow(); f.unchanged();
});

test.each(['admitted', 'prepared', 'activating', 'intent', 'plan', 'file', 'directory', 'observed', 'complete'] as const)('retirement resumes its original plan after interruption at %s', async boundary => {
  const f = await fixture(); f.context.abortBackup(requestId); let interrupted = false;
  expect(() => f.context.retireStaging('retire_original', { sourceRequestId: requestId, after(at) { if (!interrupted && at === boundary) { interrupted = true; throw Error('fixture_interrupted'); } } })).toThrow('fixture_interrupted');
  expect(interrupted).toBe(true); const old = f.context.operations().read().requests[1]!, actions = old.actions;
  const ctx = f.open(), result = ctx.retireStaging('retire_original', { sourceRequestId: requestId }); expect(result.operationId).toBe(old.id); expect(ctx.operations().read().requests[1]!.createdAt).toBe(old.createdAt); expect(ctx.operations().read().requests[1]!.actions.map(row => row.id)).toEqual(actions.length ? actions.map(row => row.id) : [ctx.operations().read().requests[1]!.actions[0]!.id]);
  expect(ctx.operations().read().requests[1]!.actions).toHaveLength(1); expect(existsSync(f.owned.root)).toBe(false); f.unchanged();
});

test.each(['changed', 'extra', 'symlink', 'directory'] as const)('retirement refuses %s bytes/members after preparation', async mutation => {
  const f = await fixture(); f.context.abortBackup(requestId);
  expect(() => f.context.retireStaging('retire_original', { sourceRequestId: requestId, after(at) { if (at === 'plan') throw Error('fixture_interrupted'); } })).toThrow('fixture_interrupted');
  const original = readFileSync(f.file);
  if (mutation === 'changed') writeFileSync(f.file, 'substituted data');
  if (mutation === 'extra') opsWrite(join(f.owned.root, 'unexpected.json'), 'extra');
  if (mutation === 'symlink') { rmSync(f.file); symlinkSync(join(f.directory, 'runtime/model.sqlite'), f.file); }
  if (mutation === 'directory') { renameSync(f.owned.data, join(f.owned.root, 'old-data')); mkdirSync(f.owned.data, { mode: 0o700 }); }
  const ctx = f.open(); expect(() => ctx.retireStaging('retire_original', { sourceRequestId: requestId })).toThrow(); expect(existsSync(f.owned.root)).toBe(true); expect(readFileSync(f.plan, 'utf8')).toBe('{interrupted metadata'); if (mutation === 'extra') expect(readFileSync(f.file)).toEqual(original); f.unchanged();
});

async function publishedFixture() {
  const f = await fixture(), journal = f.context.operations(); journal.observeAction(requestId, journal.read().revision, f.captureId, 'applied', target); journal.resume(requestId, journal.read().revision); journal.advance(requestId, journal.read().revision, 'verifying', { targetSha256: target, cohortSha256: cohort });
  journal.recordIntent(requestId, journal.read().revision, { id: 'point_publish_' + target, kind: 'replace', priorSha256: null, targetSha256: target });
  const point = join(f.directory, 'operations/points', f.original.pointId!); opsDirectory(join(point, '..')); renameSync(f.owned.data, point); journal.block(requestId, journal.read().revision, 's16_ops_publication_interrupted', 'point_publish_' + target);
  return { ...f, point };
}
test.each(['quarantine_intent', 'quarantined', 'quarantine_observed', 'discarded'] as const)('owned unregistered corrupt published data is quarantined and abort resumes original %s boundary', async boundary => {
  const f = await publishedFixture(), originalActions = f.context.operations().read().requests[0]!.actions; let interrupted = false;
  expect(() => f.context.abortBackup(requestId, { after(at) { if (!interrupted && at === boundary) { interrupted = true; throw Error('fixture_interrupted'); } } })).toThrow('fixture_interrupted'); expect(interrupted).toBe(true);
  const ctx = f.open(), result = ctx.abortBackup(requestId), request = ctx.operations().read().requests[0]!; expect(result.state).toBe('discarded'); expect(request.actions.slice(0, originalActions.length)).toEqual(originalActions); expect(request.actions.at(-1)).toMatchObject({ kind: 'quarantine_point', state: 'confirmed' });
  expect(existsSync(f.point)).toBe(false); expect(readFileSync(join(f.owned.data, 'ledgers', f.original.pointId!, 'model.sqlite'), 'utf8')).toBe('partial bytes'); ctx.retireStaging('retire_original', { sourceRequestId: requestId }); expect(existsSync(f.owned.root)).toBe(false); expect(ctx.abortBackup(requestId)).toEqual(result); f.unchanged();
});

test('quarantine refuses an unowned point or occupied destination, and abort refuses retained points', async () => {
  const f = await publishedFixture(), before = f.context.operations().read(); renameSync(f.point, f.point + '-original'); opsDirectory(f.point);
  expect(() => f.context.abortBackup(requestId)).toThrow(); expect(f.context.operations().read()).toEqual(before); rmdirSync(f.point); renameSync(f.point + '-original', f.point);
  opsDirectory(f.owned.data); expect(() => f.context.abortBackup(requestId)).toThrow(); rmdirSync(f.owned.data);
  const journal = f.context.operations(); journal.observeAction(requestId, journal.read().revision, 'point_publish_' + target, 'applied', target); journal.resume(requestId, journal.read().revision); journal.retainPoint(requestId, journal.read().revision, { sha256: target, bytes: 13 });
  expect(() => f.context.abortBackup(requestId)).toThrow(); expect(existsSync(f.point)).toBe(true); f.unchanged();
});


test('capture never recreates missing independently owned data', async () => {
  const f = await fixture(), journal = f.context.operations(), before = journal.read();
  rmSync(f.owned.data, { recursive: true });
  expect(() => ownS16Staging(f.directory, journal, requestId, 'point', f.captureId, f.context.assertCurrent)).toThrow(); expect(existsSync(f.owned.data)).toBe(false); expect(journal.read()).toEqual(before);
  f.context.abortBackup(requestId); f.unchanged();
});

test('abort does not claim point absence through an aliased point parent', async () => {
  const f = await fixture(), before = f.context.operations().read(), parent = join(f.directory, 'operations/points'); symlinkSync(f.parent, parent);
  expect(() => f.context.abortBackup(requestId)).toThrow(); expect(f.context.operations().read()).toEqual(before); f.unchanged();
});


test('unowned nonempty staging refuses ownership before journal mutation; legacy corrupt bytes remain after logical abort', async () => {
  const f = await fixture(), journal = f.context.operations(); journal.observeAction(requestId, journal.read().revision, f.captureId, 'not_applied', null); journal.resume(requestId, journal.read().revision);
  const captureId = 'point_capture_other_' + 'a'.repeat(64); journal.recordIntent(requestId, journal.read().revision, { id: captureId, kind: 'capture_backend', priorSha256: null, targetSha256: null });
  const root = join(f.directory, 'operations/point-staging', f.original.id, captureId); opsDirectory(join(root, 'data')); opsWrite(join(root, 'plan.json'), '{unowned interrupted metadata'); const before = journal.read();
  expect(() => ownS16Staging(f.directory, journal, requestId, 'point', captureId, f.context.assertCurrent)).toThrow(); expect(journal.read()).toEqual(before);
  f.context.abortBackup(requestId); const discarded = journal.read(); expect(() => f.context.retireStaging('retire_original', { sourceRequestId: requestId })).toThrow(expect.objectContaining({ code: 's16_ops_staging_ownership_invalid' })); expect(journal.read()).toEqual(discarded); expect(readFileSync(join(root, 'plan.json'), 'utf8')).toBe('{unowned interrupted metadata'); f.unchanged();
});


test('abort reconciles only an original empty ownership intent after its durable write, preserving unknown capture facts', async () => {
  const f = await fixture(), journal = f.context.operations(); journal.observeAction(requestId, journal.read().revision, f.captureId, 'not_applied', null); journal.resume(requestId, journal.read().revision);
  const captureId = 'point_capture_other_' + 'a'.repeat(64); journal.recordIntent(requestId, journal.read().revision, { id: captureId, kind: 'capture_backend', priorSha256: null, targetSha256: null });
  let armed = true; const interrupted = f.context.operations({ after(at) { if (armed && at === 'write') { armed = false; throw Error('ownership_response_loss'); } } });
  expect(() => ownS16Staging(f.directory, interrupted, requestId, 'point', captureId, f.context.assertCurrent)).toThrow('ownership_response_loss'); const before = journal.read().requests[0]!, ownId = before.actions.at(-1)!.id; expect(before.actions.at(-1)!.state).toBe('intent');
  journal.block(requestId, journal.read().revision, 's16_ops_capture_interrupted', captureId); const captureBefore = journal.read().requests[0]!.actions.find(row => row.id === captureId);
  const ctx = f.open(); ctx.abortBackup(requestId); const discarded = ctx.operations().read().requests[0]!; expect(discarded.actions.find(row => row.id === ownId)!.state).toBe('confirmed'); expect(discarded.actions.find(row => row.id === captureId)).toEqual(captureBefore);
  ctx.retireStaging('retire_original', { sourceRequestId: requestId }); expect(existsSync(f.owned.root)).toBe(false); f.unchanged();
});


test('oversized owned temporary file refuses retirement before a new gate or streaming the file', async () => {
  const f = await fixture(); f.context.abortBackup(requestId); truncateSync(f.file, 1073741825); const before = f.context.operations().read();
  expect(() => f.context.retireStaging('retire_original', { sourceRequestId: requestId })).toThrow(expect.objectContaining({ code: 's16_ops_staging_bounds' })); expect(f.context.operations().read()).toEqual(before); expect(existsSync(join(f.directory, 'owner/owner.sqlite.ops/fence.json'))).toBe(false); expect(existsSync(f.file)).toBe(true); f.unchanged();
});


test('retirement recognizes absent staging when interruption preceded ownership and never guesses provenance if it reappears', async () => {
  const f = await fixture(), journal = f.context.operations(); journal.observeAction(requestId, journal.read().revision, f.captureId, 'not_applied', null); journal.resume(requestId, journal.read().revision);
  const captureId = 'point_capture_other_' + 'a'.repeat(64); journal.recordIntent(requestId, journal.read().revision, { id: captureId, kind: 'capture_backend', priorSha256: null, targetSha256: null }); journal.block(requestId, journal.read().revision, 's16_ops_capture_interrupted', captureId); const original = journal.read().requests[0]!.actions;
  f.context.abortBackup(requestId); const result = f.context.retireStaging('retire_original', { sourceRequestId: requestId }); expect(result.state).toBe('removed'); expect(existsSync(f.owned.root)).toBe(false); expect(journal.read().requests[0]!.actions).toEqual(original);
  const root = join(f.directory, 'operations/point-staging', f.original.id, captureId); opsDirectory(root); opsWrite(join(root, 'plan.json'), '{unowned metadata'); expect(() => f.context.retireStaging('retire_original', { sourceRequestId: requestId })).toThrow(); expect(readFileSync(join(root, 'plan.json'), 'utf8')).toBe('{unowned metadata'); f.unchanged();
});


test('legacy v2 terminal metadata without a staging tree promotes once and retains the normalized original source binding', async () => {
  const f = await fixture(); f.context.close(); rmSync(f.owned.root, { recursive: true });
  // Closed legacy-format vector only: no producer/point/physical outcome is claimed by these metadata bytes.
  const path = join(f.directory, 'operations/control.json'), control = JSON.parse(readFileSync(path, 'utf8')), source = control.requests[0];
  control.contract = 's16-operations-control/v2'; delete source.abort; source.actions = []; source.status = 'complete'; source.phase = 'complete'; source.reason = null; source.targetSha256 = target; source.cohortSha256 = cohort;
  opsAtomic(path, JSON.parse(canonicalS16OperationsControl(control)));
  const ctx = f.open(), journal = ctx.operations(); journal.begin({ requestId, kind: 'backup', hash: source.hash, pointId: source.pointId }, journal.read().revision);
  const result = ctx.retireStaging('retire_original', { sourceRequestId: requestId }); expect(result.state).toBe('removed'); expect(ctx.operations().read().contract).toBe('s16-operations-control/v3'); expect(ctx.retireStaging('retire_original', { sourceRequestId: requestId })).toEqual(result); expect(ctx.operations().read().requests[0]).toMatchObject({ ...source, abort: null }); f.unchanged();
});
