import { afterEach, expect, test } from 'bun:test';
import { existsSync, linkSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { opsDirectory, opsWrite } from '../src/s14/ops-files';
import { pointFormatFixture, pointFixtureHash } from './fixtures/s16-point';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
/** Original ownership/removal protocol only; opaque child bytes and terminal phase are explicit fixtures. */
async function fixture(complete = true, owned = true) {
  const f = await pointFormatFixture(); cleanup.push(f.dispose); let context = f.open();
  let next = 0; const journal = context.operations({ now: () => 30, id: () => (next++ ? 'f' : 'e').repeat(32) }), requestId = 'restore_original';
  journal.begin({ requestId, kind: 'restore', hash: 'f'.repeat(64), pointId: f.pointId }, journal.read().revision); journal.advance(requestId, journal.read().revision, 'capturing');
  const source = journal.read().requests.find(row => row.requestId === requestId)!, root = join(f.directory, 'operations/forward-recovery', source.id);
  if (owned) context.recoveryStage(requestId); else for (const role of ['ledgers', 'payloads', 'quarantine']) opsDirectory(join(root, role));
  const file = join(root, 'ledgers', source.id, 'model.sqlite'); opsDirectory(join(file, '..')); opsWrite(file, 'Opaque original current SQL fixture.');
  for (const path of ['candidate.json', 'current.json', 'plan.json', 'payloads/current-native/plan.json', 'payloads/current-native/data/manifest.json', 'payloads/current-native/data/' + 'a'.repeat(32) + '.json', 'payloads/current-native/scratch/' + 'a'.repeat(32) + '/sessions/opaque.bin', 'quarantine/' + 'b'.repeat(32) + '/sessions/opaque.bin']) {
    opsDirectory(join(root, path, '..')); opsWrite(join(root, path), 'Inert original recovery staging fixture.');
  }
  if (complete) { journal.advance(requestId, journal.read().revision, 'verifying', { cohortSha256: 'a'.repeat(64), targetSha256: 'b'.repeat(64) }); journal.advance(requestId, journal.read().revision, 'prepared'); journal.advance(requestId, journal.read().revision, 'activating'); journal.advance(requestId, journal.read().revision, 'complete'); }
  const original = journal.read().requests.find(row => row.requestId === requestId)!, before = context.sources.map(row => pointFixtureHash(row.database.serialize())), point = readFileSync(join(f.root, 'manifest.json')), canonical = readFileSync(join(f.directory, 'runtime/file-bytes', f.uploadId + '.blob'));
  return { f, requestId, root, file, original, get context() { return context; }, reopen() { context = f.open(); return context; }, unchanged() { expect(context.sources.map(row => pointFixtureHash(row.database.serialize()))).toEqual(before); expect(readFileSync(join(f.root, 'manifest.json'))).toEqual(point); expect(readFileSync(join(f.directory, 'runtime/file-bytes', f.uploadId + '.blob'))).toEqual(canonical); const current = context.operations().read().requests.find(row => row.requestId === requestId)!; expect({ ...current, abort: current.abort ?? null }).toEqual({ ...original, abort: original.abort ?? null }); } };
}

test('complete recovery staging retirement preserves all current stores, canonical bytes, point and original receipt, and refuses reappearance', async () => {
  const f = await fixture(), result = f.context.retireStaging('retire_original', { sourceRequestId: f.requestId });
  expect(result.state).toBe('removed'); expect(existsSync(f.root)).toBe(false); expect(f.context.retireStaging('retire_original', { sourceRequestId: f.requestId })).toEqual(result); f.unchanged();
  const request = f.context.operations().read().requests.find(row => row.requestId === 'retire_original')!, plan = JSON.parse(readFileSync(join(f.f.directory, 'operations/staging-retention', request.id, request.actions[0]!.id, 'plan.json'), 'utf8'));
  expect(plan.contract).toBe('s16-staging-retirement-plan/v2'); expect(plan.stages[0]).toMatchObject({ role: 'recovery', captureActionId: f.original.actions[0]!.id });
  opsDirectory(f.root); opsWrite(join(f.root, 'unowned'), 'Keep reappeared custody.');
  expect(() => f.context.retireStaging('retire_original', { sourceRequestId: f.requestId })).toThrow(expect.objectContaining({ code: 's16_ops_staging_reappeared' })); expect(readFileSync(join(f.root, 'unowned'), 'utf8')).toBe('Keep reappeared custody.');
});

test.each(['admitted', 'prepared', 'activating', 'intent', 'plan', 'file', 'directory', 'observed', 'complete'] as const)('recovery retirement retains original plan and action after interruption at %s', async boundary => {
  const f = await fixture(); let interrupted = false;
  expect(() => f.context.retireStaging('retire_original', { sourceRequestId: f.requestId, after(at) { if (!interrupted && at === boundary) { interrupted = true; throw Error('fixture_interrupted'); } } })).toThrow('fixture_interrupted'); expect(interrupted).toBe(true);
  const prior = f.context.operations().read().requests.find(row => row.requestId === 'retire_original')!, current = f.reopen(), result = current.retireStaging('retire_original', { sourceRequestId: f.requestId }), request = current.operations().read().requests.find(row => row.requestId === 'retire_original')!;
  expect(result.operationId).toBe(prior.id); expect(request.createdAt).toBe(prior.createdAt); expect(request.admittedRevision).toBe(prior.admittedRevision); expect(request.actions).toHaveLength(1); expect(prior.actions.every(row => row.id === request.actions[0]!.id && row.priorSha256 === request.actions[0]!.priorSha256 && row.targetSha256 === request.actions[0]!.targetSha256)).toBe(true); expect(existsSync(f.root)).toBe(false); f.unchanged();
});

test.each(['changed-file', 'extra-file', 'linked-file', 'substituted-root', 'missing-plan-after-unlink'] as const)('recovery retirement refuses %s after immutable preparation and preserves unknown custody', async mode => {
  const f = await fixture();
  expect(() => f.context.retireStaging('retire_original', { sourceRequestId: f.requestId, after(at) { if (at === (mode === 'missing-plan-after-unlink' ? 'file' : 'plan')) throw Error('fixture_interrupted'); } })).toThrow('fixture_interrupted');
  if (mode === 'changed-file') writeFileSync(f.file, 'Keep changed current staging.');
  if (mode === 'extra-file') opsWrite(join(f.root, 'unknown'), 'Keep unknown current staging.');
  if (mode === 'linked-file') linkSync(f.file, join(f.root, 'unexpected-alias'));
  if (mode === 'substituted-root') { renameSync(f.root, f.root + '.original'); opsDirectory(f.root); opsWrite(join(f.root, 'unknown'), 'Keep substituted root.'); }
  const request = f.context.operations().read().requests.find(row => row.requestId === 'retire_original')!;
  if (mode === 'missing-plan-after-unlink') unlinkSync(join(f.f.directory, 'operations/staging-retention', request.id, request.actions[0]!.id, 'plan.json'));
  expect(() => f.reopen().retireStaging('retire_original', { sourceRequestId: f.requestId })).toThrow(); expect(existsSync(f.root)).toBe(true);
  if (mode === 'changed-file') expect(readFileSync(f.file, 'utf8')).toBe('Keep changed current staging.');
  if (mode === 'extra-file') expect(readFileSync(join(f.root, 'unknown'), 'utf8')).toBe('Keep unknown current staging.');
  if (mode === 'substituted-root') expect(readFileSync(join(f.root, 'unknown'), 'utf8')).toBe('Keep substituted root.'); f.unchanged();
});

test.each(['nonterminal', 'unowned'] as const)('recovery retirement refuses %s restore before admission or removal', async mode => {
  const f = await fixture(mode !== 'nonterminal', mode !== 'unowned'), before = f.context.operations().read();
  expect(() => f.context.retireStaging('retire_original', { sourceRequestId: f.requestId })).toThrow(); expect(f.context.operations().read()).toEqual(before); expect(existsSync(f.root)).toBe(true); f.unchanged();
});

test.each(['missing-role', 'replaced-role'] as const)('recovery retirement refuses %s original child inode before admission without recreating it', async mode => {
  const f = await fixture(), role = join(f.root, 'payloads'), retained = f.root + '.payloads-retained', before = f.context.operations().read();
  renameSync(role, retained); if (mode === 'replaced-role') opsDirectory(role);
  expect(() => f.context.retireStaging('retire_original', { sourceRequestId: f.requestId })).toThrow(); expect(f.context.operations().read()).toEqual(before); expect(existsSync(role)).toBe(mode === 'replaced-role'); expect(existsSync(retained)).toBe(true); f.unchanged();
});
