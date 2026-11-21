import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { assertS16RecoveryStageFor } from '../src/s16/operations/recovery-staging';
import { readS16OperationsControl } from '../src/s16/operations/operations-state';
import { pointFormatFixture } from './fixtures/s16-point';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const f = await pointFormatFixture(); cleanup.push(f.dispose); const context = f.context, journal = context.operations({ now: () => 30, id: () => 'e'.repeat(32) }), requestId = 'restore_original';
  journal.begin({ requestId, kind: 'restore', hash: 'f'.repeat(64), pointId: f.pointId }, journal.read().revision); journal.advance(requestId, journal.read().revision, 'capturing');
  const request = journal.read().requests.find(row => row.requestId === requestId)!;
  return { f, context, journal, requestId, request };
}

test('original current restore stage pins empty private roots before child writes without changing any current SQL or point', async () => {
  const { f, context, journal, requestId, request } = await fixture(), before = context.sources.map(source => source.database.serialize()), point = readFileSync(join(f.root, 'manifest.json')), stage = context.recoveryStage(requestId);
  stage.assertCurrent(); assertS16RecoveryStageFor(stage, requestId, request.id); expect(() => assertS16RecoveryStageFor({ ...stage }, requestId, request.id)).toThrow();
  const action = journal.read().requests.find(row => row.requestId === requestId)!.actions[0]!;
  expect(action).toMatchObject({ id: stage.actionId, kind: 'capture_backend', state: 'confirmed', observedSha256: action.targetSha256 });
  writeFileSync(join(stage.root, 'plan.json'), 'corrupt child cannot authenticate its own parent', { mode: 0o600 }); stage.assertCurrent();
  expect(context.recoveryStage(requestId).scopeSha256).toBe(stage.scopeSha256); expect(journal.read().requests.find(row => row.requestId === requestId)!.actions).toHaveLength(1);
  expect(context.sources.map(source => source.database.serialize())).toEqual(before); expect(readFileSync(join(f.root, 'manifest.json'))).toEqual(point);
  context.close(); expect(() => stage.assertCurrent()).toThrow();
});

test.each(['missing', 'replacement', 'extra', 'linked-metadata'] as const)('changed %s original staging refuses without recreating or removing bytes', async kind => {
  const { context, requestId } = await fixture(), stage = context.recoveryStage(requestId), path = stage.path('payloads');
  if (kind === 'missing' || kind === 'replacement') { renameSync(path, path + '.retained'); if (kind === 'replacement') mkdirSync(path, { mode: 0o700 }); }
  if (kind === 'extra') writeFileSync(join(stage.root, 'unowned'), 'keep', { mode: 0o600 });
  if (kind === 'linked-metadata') symlinkSync(join(stage.root, 'unowned'), join(stage.root, 'plan.json'));
  expect(() => stage.assertCurrent()).toThrow(); expect(() => context.recoveryStage(requestId)).toThrow();
  if (kind === 'missing') expect(existsSync(path)).toBe(false);
  if (kind === 'extra') expect(readFileSync(join(stage.root, 'unowned'), 'utf8')).toBe('keep');
});

test('unknown original ownership can confirm only its same empty namespace and does not resume other unknown effects', async () => {
  const { context, journal, requestId } = await fixture();
  expect(() => context.recoveryStage(requestId, { after(at) { if (at === 'intent') throw Error('fixture_response_loss'); } })).toThrow('fixture_response_loss');
  const before = journal.read().requests.find(row => row.requestId === requestId)!, action = before.actions[0]!;
  journal.block(requestId, journal.read().revision, 's16_ops_recovery_interrupted', action.id);
  const stage = context.recoveryStage(requestId), after = journal.read().requests.find(row => row.requestId === requestId)!;
  expect(after.id).toBe(before.id); expect(after.createdAt).toBe(before.createdAt); expect(after.status).toBe('blocked'); expect(after.actions).toHaveLength(1);
  expect(after.actions[0]).toMatchObject({ id: action.id, priorSha256: action.priorSha256, targetSha256: action.targetSha256, state: 'confirmed' }); stage.assertCurrent();
});

test('an unowned nonempty namespace cannot authenticate itself from a child plan', async () => {
  const { f, context, journal, requestId, request } = await fixture(), root = join(f.directory, 'operations/forward-recovery', request.id);
  mkdirSync(root, { recursive: true, mode: 0o700 }); writeFileSync(join(root, 'plan.json'), 'self-declared custody', { mode: 0o600 });
  const before = journal.read(); expect(() => context.recoveryStage(requestId)).toThrow(); expect(journal.read()).toEqual(before); expect(readFileSync(join(root, 'plan.json'), 'utf8')).toBe('self-declared custody');
});

test('nonempty original ownership uncertainty refuses observation instead of trusting child bytes', async () => {
  const { f, context, journal, requestId, request } = await fixture();
  expect(() => context.recoveryStage(requestId, { after(at) { if (at === 'intent') throw Error('fixture_response_loss'); } })).toThrow('fixture_response_loss');
  const path = join(f.directory, 'operations/forward-recovery', request.id, 'payloads/untrusted'); writeFileSync(path, 'keep original unknown', { mode: 0o600 });
  const before = journal.read(); expect(() => context.recoveryStage(requestId)).toThrow(); expect(journal.read()).toEqual(before); expect(readFileSync(path, 'utf8')).toBe('keep original unknown');
});

test.each(['directories', 'intent', 'observed'] as const)('actual SIGKILL at recovery ownership %s retains original operation and inode proof on retry', async boundary => {
  const { f, context, requestId, request } = await fixture(), before = context.sources.map(source => source.database.serialize()); context.close();
  const code = `import {readS15RuntimeConfig} from './src/s15/runtime-config';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance';import {readS16OperationsFence} from './src/s16/operations/operations-state';const config=readS15RuntimeConfig(${JSON.stringify(f.configPath)}),ctx=openS16ControlMaintenance(config,{operationFence:readS16OperationsFence(config.directory)});ctx.recoveryStage(${JSON.stringify(requestId)},{after(at){if(at===${JSON.stringify(boundary)})process.kill(process.pid,'SIGKILL');}});throw Error('fixture_not_killed');`;
  const child = Bun.spawnSync([process.execPath, '-e', code], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5000 }); expect(child.exitCode).not.toBe(0); expect(child.stderr.toString()).toBe('');
  const original = readS16OperationsControl(f.directory).requests.find(row => row.requestId === requestId)!, fresh = f.open(), stage = fresh.recoveryStage(requestId), current = fresh.operations().read().requests.find(row => row.requestId === requestId)!;
  expect(current.id).toBe(request.id); expect(current.createdAt).toBe(request.createdAt); expect(current.actions).toHaveLength(1); expect(current.actions[0]!.state).toBe('confirmed');
  if (original.actions.length) expect(current.actions[0]).toMatchObject({ id: original.actions[0]!.id, priorSha256: original.actions[0]!.priorSha256, targetSha256: original.actions[0]!.targetSha256 });
  stage.assertCurrent(); expect(fresh.sources.map(source => source.database.serialize())).toEqual(before);
});
