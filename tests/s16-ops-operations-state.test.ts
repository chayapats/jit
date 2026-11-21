import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { canonical } from '../src/s15/conversation/validation';
import { readS16OperationsControl, validateS16OperationsControl, type S16OperationsControl } from '../src/s16/operations/operations-state';

const cleanup: string[] = [];
afterEach(() => { for (const root of cleanup.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jit-operations-state-'))); cleanup.push(directory);
  mkdirSync(join(directory, 'operations'), { mode: 0o700 });
  const path = join(directory, 'operations/control.json');
  const state: S16OperationsControl = {
    contract: 's16-operations-control/v1', id: 'a'.repeat(32), installationId: 'installation', ownerIdentity: 'retained-owner-identity', revision: 1,
    adoption: { requestId: 'adopt_original', configurationSha256: 'b'.repeat(64), createdAt: 1 },
    requests: [{ id: 'c'.repeat(32), requestId: 'original_backup', kind: 'backup', hash: 'd'.repeat(64), phase: 'capturing', status: 'unknown', pointId: 'e'.repeat(32), cohortSha256: null, targetSha256: null, createdAt: 1, updatedAt: 2, revision: 1, reason: 's16_ops_native_unknown',
      actions: [{ id: 'original_backend_capture', kind: 'capture_backend', priorSha256: null, targetSha256: null, state: 'unknown' }] }], points: [],
  };
  const write = () => writeFileSync(path, canonical(state), { mode: 0o600 }); write();
  return { directory, path, state, write };
}

test('existing current metadata retains the exact original unknown request/action and remains read-only', () => {
  const f = fixture(), before = readFileSync(f.path); expect(readS16OperationsControl(f.directory)).toEqual(f.state);
  expect(readFileSync(f.path)).toEqual(before); expect(f.state.requests[0]!.status).toBe('unknown'); expect(f.state.requests[0]!.actions[0]!.state).toBe('unknown');
});

test.each(['future', 'extra', 'duplicate', 'two-active', 'false-complete', 'false-running', 'hash', 'revision', 'phase', 'point', 'epoch', 'reason', 'bytes', 'noncanonical', 'missing', 'symlink', 'hardlink', 'mode'] as const)('invalid current %s is refused without repair, empty reconstruction or an operation replay', kind => {
  const f = fixture(), request = f.state.requests[0]!;
  if (kind === 'future') (f.state as { contract: string }).contract = 's16-operations-control/v99';
  if (kind === 'extra') Object.assign(f.state, { candidateAuthority: true });
  if (kind === 'duplicate') f.state.requests.push(structuredClone(request));
  if (kind === 'two-active') f.state.requests.push({ ...structuredClone(request), id: 'f'.repeat(32), requestId: 'other_original' });
  if (kind === 'false-complete') { request.phase = 'complete'; request.status = 'complete'; }
  if (kind === 'false-running') request.status = 'running';
  if (kind === 'hash') request.hash = 'not-a-hash';
  if (kind === 'revision') request.revision = 2;
  if (kind === 'phase') request.phase = 'activating';
  if (kind === 'point') f.state.points.push({ id: 'e'.repeat(32), sha256: 'f'.repeat(64), bytes: 0, createdAt: 2, operationId: request.id, state: 'retained' });
  if (kind === 'epoch') request.updatedAt = 0;
  if (kind === 'reason') request.reason = '/private/host/path';
  f.write();
  if (kind === 'bytes') writeFileSync(f.path, ' '.repeat(4_194_305));
  if (kind === 'noncanonical') writeFileSync(f.path, readFileSync(f.path, 'utf8') + '\n');
  if (kind === 'missing') unlinkSync(f.path);
  if (kind === 'symlink') { unlinkSync(f.path); writeFileSync(join(f.directory, 'elsewhere'), canonical(f.state), { mode: 0o600 }); symlinkSync(join(f.directory, 'elsewhere'), f.path); }
  if (kind === 'hardlink') linkSync(f.path, join(f.directory, 'extra-link'));
  if (kind === 'mode') chmodSync(f.path, 0o644);
  const before = existsSync(f.path) ? readFileSync(f.path) : null;
  expect(() => readS16OperationsControl(f.directory)).toThrow(expect.objectContaining({ code: 's16_ops_control_invalid' }));
  if (before) expect(readFileSync(f.path)).toEqual(before); else expect(existsSync(f.path)).toBe(false);
});

test('a verified retained point binds the original backup manifest while later point removal does not erase its original completed receipt', () => {
  const f = fixture(), request = f.state.requests[0]!;
  Object.assign(request, { phase: 'complete', status: 'complete', targetSha256: 'f'.repeat(64), cohortSha256: '1'.repeat(64), reason: null }); request.actions[0]!.state = 'confirmed'; request.actions[0]!.targetSha256 = '2'.repeat(64);
  f.state.points.push({ id: request.pointId!, sha256: request.targetSha256!, bytes: 123, createdAt: 2, operationId: request.id, state: 'retained' });
  f.write(); expect(readS16OperationsControl(f.directory).points).toHaveLength(1);
  f.state.points = []; f.write(); expect(readS16OperationsControl(f.directory).requests[0]).toEqual(request);
});

test('an existing installation without operation state cannot be initialized by an inspection', () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jit-no-operations-state-'))); cleanup.push(directory);
  expect(() => readS16OperationsControl(directory)).toThrow(); expect(existsSync(join(directory, 'operations'))).toBe(false);
});

test('bounded state refuses an overfull original-receipt set before processing or evicting any receipt', () => {
  const f = fixture(); f.state.requests = Array.from({ length: 257 }, () => structuredClone(f.state.requests[0]!));
  expect(() => validateS16OperationsControl(f.state)).toThrow(); expect(f.state.requests).toHaveLength(257);
});
