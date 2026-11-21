import { afterEach, expect, test } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readS16OperationsFence } from '../src/s16/operations/operations-state';
import { s16PointMemberPath } from '../src/s16/operations/point-files';
import { pointFormatFixture } from './fixtures/s16-point';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture(count = 1) { const f = await pointFormatFixture(count); cleanup.push(f.dispose); return f; }
const requestId = 'cleanup_original';
const removal = (f: Awaited<ReturnType<typeof fixture>>) => f.context.operations().read().requests.find(row => row.requestId === requestId)!;
function planPath(f: Awaited<ReturnType<typeof fixture>>) { const request = removal(f); return join(f.directory, 'operations/retention', request.id, request.actions[0]!.id, 'plan.json'); }

test('explicit original retention removes only historical point files and preserves current private state and receipts', async () => {
  const f = await fixture(), paths = ['owner/owner.sqlite', 'owner/owner.sqlite.lifecycle.sqlite', 'runtime/files.sqlite', 'runtime/file-bytes/' + f.uploadId + '.blob'];
  const before = paths.map(path => readFileSync(join(f.directory, path))), backup = f.context.operations().read().requests[0]!;
  const result = f.context.removePoint(requestId, { pointId: f.pointId }); expect(result.state).toBe('removed'); expect(existsSync(f.root)).toBe(false);
  expect(removal(f)).toMatchObject({ status: 'complete', phase: 'complete', actions: [{ state: 'confirmed', kind: 'remove_point', priorSha256: f.expected.manifestSha256, observedSha256: null }] });
  expect(f.context.operations().read().points).toEqual([]); expect(f.context.operations().read().requests[0]).toEqual(backup);
  expect(existsSync(planPath(f))).toBe(true); expect(JSON.stringify(JSON.parse(readFileSync(planPath(f), 'utf8')))).not.toContain(f.directory);
  expect(paths.map(path => readFileSync(join(f.directory, path)))).toEqual(before);
  expect(existsSync(join(f.directory, 'owner/owner.sqlite.ops/fence.json'))).toBe(false);
  f.open(); const journal = f.context.operations(); journal.begin({ requestId: 'later_export', kind: 'export', hash: 'e'.repeat(64) }, journal.read().revision); journal.advance('later_export', journal.read().revision, 'discarded');
  expect(journal.read().revision).toBeGreaterThan(result.revision); expect(f.context.removePoint(requestId, { pointId: f.pointId })).toEqual(result);
});

test.each(['admitted', 'prepared', 'activating', 'intent', 'plan', 'file', 'directory', 'observed', 'receipt', 'complete'] as const)('response loss after %s resumes original operation/action and bounded plan', async boundary => {
  const f = await fixture(); let armed = true;
  expect(() => f.context.removePoint(requestId, { pointId: f.pointId, after(at) { if (armed && at === boundary) { armed = false; throw Error('fixture_response_loss'); } } })).toThrow('fixture_response_loss');
  const original = removal(f), priorPlan = existsSync(join(f.directory, 'operations/retention')) ? readFileSync(planPath(f)) : undefined;
  if (boundary !== 'complete') expect(readS16OperationsFence(f.directory).operationId).toBe(original.id);
  f.open(); const result = f.context.removePoint(requestId, { pointId: f.pointId }); expect(result.operationId).toBe(original.id);
  expect(removal(f).createdAt).toBe(original.createdAt); expect(removal(f).actions).toHaveLength(1);
  if (original.actions.length) expect(removal(f).actions[0]!.id).toBe(original.actions[0]!.id);
  if (priorPlan) expect(readFileSync(planPath(f))).toEqual(priorPlan);
  expect(existsSync(f.root)).toBe(false); expect(removal(f).status).toBe('complete');
});

test.each(['intent', 'file', 'directory', 'receipt'] as const)('actual SIGKILL after %s retains original durable plan/action and forward removal', async boundary => {
  const f = await fixture(); f.context.close();
  const code = `import {readS15RuntimeConfig} from './src/s15/runtime-config';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance';const config=readS15RuntimeConfig(${JSON.stringify(f.configPath)}),ctx=openS16ControlMaintenance(config);ctx.removePoint('${requestId}',{pointId:'${f.pointId}',after(at){if(at===${JSON.stringify(boundary)})process.kill(process.pid,'SIGKILL');}});throw Error('fixture_no_interrupt');`;
  const child = Bun.spawn([process.execPath, '-e', code], { stdin: 'ignore', stdout: 'ignore', stderr: 'pipe' }), timer = setTimeout(() => child.kill('SIGKILL'), 20000);
  try { const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]); expect(error).toBe(''); expect(exit).not.toBe(0); } finally { clearTimeout(timer); }
  f.open(); const original = removal(f); expect(original.status).toBe('running');
  const result = f.context.removePoint(requestId, { pointId: f.pointId }); expect(result.operationId).toBe(original.id); expect(removal(f).actions).toHaveLength(1); expect(removal(f).actions[0]!.id).toBe(original.actions[0]!.id); expect(existsSync(f.root)).toBe(false);
});

test.each(['extra', 'changed', 'inode', 'plan-corrupt', 'plan-missing'] as const)('partial removal refuses %s and keeps the original fence without deleting substituted bytes', async kind => {
  const f = await fixture(); let interrupted = false;
  expect(() => f.context.removePoint(requestId, { pointId: f.pointId, after(at) { if (!interrupted && at === 'file') { interrupted = true; throw Error('fixture_partial'); } } })).toThrow('fixture_partial');
  const remaining = f.inventory.files.find(row => existsSync(s16PointMemberPath(f.root, f.pointId, row.scope, row.name)))!, target = s16PointMemberPath(f.root, f.pointId, remaining.scope, remaining.name);
  let changed = target;
  if (kind === 'extra') { changed = join(f.root, 'unowned.txt'); writeFileSync(changed, 'unowned', { mode: 0o600 }); }
  if (kind === 'changed') writeFileSync(target, 'substituted', { mode: 0o600 });
  if (kind === 'inode') { const bytes = readFileSync(target); renameSync(target, target + '.old'); writeFileSync(target, bytes, { mode: 0o600 }); unlinkSync(target + '.old'); }
  if (kind === 'plan-corrupt') writeFileSync(planPath(f), '{}', { mode: 0o600 });
  if (kind === 'plan-missing') unlinkSync(planPath(f));
  const before = readFileSync(changed), original = removal(f); f.open(); expect(() => f.context.removePoint(requestId, { pointId: f.pointId })).toThrow();
  expect(readFileSync(changed)).toEqual(before); expect(readS16OperationsFence(f.directory).operationId).toBe(original.id);
  expect(f.context.operations().read().points[0]!.state).toBe('removing'); expect(removal(f).actions).toHaveLength(1);
});

test('completed retry never removes a reappeared directory or changes its original receipt', async () => {
  const f = await fixture(); f.context.removePoint(requestId, { pointId: f.pointId }); const before = removal(f);
  mkdirSync(f.root, { mode: 0o700 }); writeFileSync(join(f.root, 'new.txt'), 'new unrelated bytes', { mode: 0o600 });
  expect(() => f.context.removePoint(requestId, { pointId: f.pointId })).toThrow(expect.objectContaining({ code: 's16_ops_point_reappeared' }));
  expect(readFileSync(join(f.root, 'new.txt'), 'utf8')).toBe('new unrelated bytes'); expect(removal(f)).toEqual(before);
});

test('unfinished work and another request cannot acquire or alter historical retention', async () => {
  const f = await fixture(), journal = f.context.operations(); journal.begin({ requestId: 'restore_original', kind: 'restore', hash: 'f'.repeat(64), pointId: f.pointId }, journal.read().revision);
  expect(() => f.context.removePoint(requestId, { pointId: f.pointId })).toThrow(expect.objectContaining({ code: 's16_ops_operation_busy' }));
  expect(existsSync(f.root)).toBe(true); expect(readdirSync(join(f.directory, 'operations'))).not.toContain('retention');
});

test('a plan with more than 256 original members preserves the complete owning inventory and streams removal', async () => {
  const f = await fixture(300); expect(f.inventory.files.length).toBeGreaterThan(300);
  f.context.removePoint(requestId, { pointId: f.pointId });
  const plan = JSON.parse(readFileSync(planPath(f), 'utf8')); expect(plan.files).toEqual(f.inventory.files);
  expect(plan.files.filter((row: { name: string }) => row.name.startsWith('file_'))).toHaveLength(300);
  expect(existsSync(f.root)).toBe(false); expect(readdirSync(join(f.directory, 'runtime/file-bytes'))).toHaveLength(300);
});

test('lost maintenance gate is rebuilt only for the original cleanup with its same plan and request identity', async () => {
  const f = await fixture(); let armed = true;
  expect(() => f.context.removePoint(requestId, { pointId: f.pointId, after(at) { if (armed && at === 'file') { armed = false; throw Error('fixture_partial'); } } })).toThrow();
  const original = removal(f), plan = readFileSync(planPath(f)); f.context.close(); unlinkSync(join(f.directory, 'owner/owner.sqlite.ops/fence.json'));
  f.open(); expect(() => f.context.removePoint('different_request', { pointId: f.pointId })).toThrow();
  const result = f.context.removePoint(requestId, { pointId: f.pointId }); expect(result.operationId).toBe(original.id); expect(readFileSync(planPath(f))).toEqual(plan);
});

test('actual protected CLI removes a receipted point and returns original deduplicated output without application startup', async () => {
  const f = await fixture(); f.context.close();
  const run = async (extra: string[] = []) => {
    const child = Bun.spawn([process.execPath, 'src/s16/operations-cli.ts', 'cleanup', '--s15', '--config', f.configPath, '--request-id', requestId, '--point-id', f.pointId, ...extra], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
    const [exit, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { exit, out, error };
  };
  const first = await run(); expect(first.exit).toBe(0); expect(first.error).toBe(''); expect(JSON.parse(first.out)).toMatchObject({ state: 'removed', pointId: f.pointId, requestId });
  expect(await run()).toEqual(first); const bad = await run(['--point-id', f.pointId]); expect(bad.exit).toBe(1); expect(JSON.parse(bad.error).error).toBe('s16_ops_command_invalid');
  f.open(); expect(removal(f).status).toBe('complete'); expect(existsSync(f.root)).toBe(false);
});
