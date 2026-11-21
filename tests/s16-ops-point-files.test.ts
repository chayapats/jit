import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, mkdirSync, readFileSync, renameSync, symlinkSync, truncateSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { inspectS16PointFiles, s16PointMemberPath, s16RecoveryPointText } from '../src/s16/operations/point-files';
import { pointFormatFixture } from './fixtures/s16-point';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() { const f = await pointFormatFixture(); cleanup.push(f.dispose); return f; }

test('receipted fixed inventory authenticates every actual SQL/FILE/native component without boot or mutation', async () => {
  const f = await fixture(), before = readFileSync(join(f.directory, 'operations/control.json'));
  const observed = inspectS16PointFiles(f.root, f.expected, f.context.assertCurrent);
  expect(observed).toEqual(f.inventory); expect(observed.files.length).toBeGreaterThan(20); expect(observed.directories).toHaveLength(5);
  expect(observed.files.some(row => row.name.startsWith('file_'))).toBe(true);
  expect(observed.files.some(row => row.name === 'native_plan.json')).toBe(true);
  expect(observed.bytes).toBe(observed.files.reduce((n, row) => n + row.bytes, 0));
  expect(Object.isFrozen(observed.manifest.configuration.runtime)).toBe(true);
  expect(readFileSync(join(f.directory, 'operations/control.json'))).toEqual(before);
  expect(JSON.stringify(observed)).not.toContain(f.directory);
});

test.each(['hash', 'missing', 'extra', 'directory', 'symlink', 'hardlink', 'mode', 'size', 'inode'] as const)('invalid %s point refuses without repairing, booting or deleting it', async kind => {
  const f = await fixture(), row = f.inventory.files.find(row => row.name.startsWith('file_'))!, path = s16PointMemberPath(f.root, f.pointId, row.scope, row.name);
  if (kind === 'hash') writeFileSync(path, Buffer.alloc(row.bytes, 65));
  if (kind === 'missing') unlinkSync(path);
  if (kind === 'extra') writeFileSync(join(f.root, 'unowned.txt'), 'unowned', { mode: 0o600 });
  if (kind === 'directory') mkdirSync(join(f.root, 'unowned'), { mode: 0o700 });
  if (kind === 'symlink') { unlinkSync(path); symlinkSync(join(f.directory, 'runtime/file-bytes', f.uploadId + '.blob'), path); }
  if (kind === 'hardlink') linkSync(path, join(f.parent, 'alias'));
  if (kind === 'mode') chmodSync(path, 0o644);
  if (kind === 'size') truncateSync(path, 1073741825);
  if (kind === 'inode') { renameSync(path, path + '.old'); writeFileSync(path, readFileSync(path + '.old'), { mode: 0o600 }); }
  expect(() => inspectS16PointFiles(f.root, f.expected, f.context.assertCurrent)).toThrow();
  expect(existsSync(f.root)).toBe(true); expect(readFileSync(join(f.directory, 'runtime/file-bytes', f.uploadId + '.blob'))).toEqual(f.data);
});

test.each(['manifestSha256', 'configurationSha256', 'cohortSha256', 'installationId', 'ownerIdentity', 'operationId', 'requestId', 'bytes', 'capturedAt'] as const)('candidate cannot substitute independent current %s', async key => {
  const f = await fixture(), expected = { ...f.expected, [key]: typeof f.expected[key] === 'number' ? 123 : key.endsWith('Sha256') ? '0'.repeat(64) : 'foreign' };
  expect(() => inspectS16PointFiles(f.root, expected, f.context.assertCurrent)).toThrow();
});

test('file membership inserted during final readback is caught before inventory is returned', async () => {
  const f = await fixture(); let calls = 0, armed = false;
  inspectS16PointFiles(f.root, f.expected, () => { calls++; f.context.assertCurrent(); });
  const trigger = calls - 2; calls = 0;
  expect(() => inspectS16PointFiles(f.root, f.expected, () => {
    f.context.assertCurrent(); if (++calls === trigger) { armed = true; writeFileSync(join(f.root, 'unowned.txt'), 'unowned', { mode: 0o600 }); }
  })).toThrow(); expect(armed).toBe(true);
});

test('closed manifest distinguishes file custody from native/live or restore authority', async () => {
  const f = await fixture(), value = structuredClone(f.manifest);
  expect(() => s16RecoveryPointText({ ...value, extra: 'unreviewed' } as typeof value)).toThrow();
  expect(() => s16RecoveryPointText({ ...value, components: value.components.map((row, index) => index ? row : { ...row, custody: 'restore_authority' }) })).toThrow();
  expect(() => inspectS16PointFiles(f.root, f.expected, () => true as unknown as void)).toThrow();
});
