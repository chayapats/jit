import { afterEach, expect, test } from 'bun:test';
import { chmodSync, fstatSync, linkSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { FirecrackerHostLock, type FirecrackerLockFixture } from '../src/s15/vm/firecracker/lock';
import { FirecrackerHostJournal, FirecrackerHostJobs } from '../src/s15/vm/firecracker/jobs';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function location() { const dir = mkdtempSync(resolve('.local/resolve-issues/427-lock-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true })); return dir; }
function fixture() {
  const active = new Set<string>(); const key = (fd: number) => { const s = fstatSync(fd, { bigint: true }); return `${s.dev}:${s.ino}`; };
  const port: FirecrackerLockFixture = { basis: 'protocol_fixture', acquire(fd) { const id = key(fd); if (active.has(id)) return false; active.add(id); return true; }, release(fd) { active.delete(key(fd)); } };
  return { port, active };
}
async function acquire(dir: string, port: FirecrackerLockFixture) { const lock = await FirecrackerHostLock.open(dir, port); cleanup.push(() => lock.close()); return lock; }

test('retained descriptor excludes another helper; close releases without unlinking the original inode', async () => {
  const dir = location(), f = fixture(), first = await acquire(dir, f.port); expect(first.basis).toBe('protocol_fixture'); first.current();
  await expect(FirecrackerHostLock.open(dir, f.port)).rejects.toMatchObject({ code: 'vm_firecracker_helper_locked' }); expect(f.active.size).toBe(1);
  first.close(); expect(() => first.current()).toThrow(); expect(f.active.size).toBe(0);
  const next = await acquire(dir, f.port); next.current(); expect(f.active.size).toBe(1);
});

test.each(['symlink', 'hardlink', 'permissions', 'contents', 'parent'] as const)('unsafe %s lock refuses before any acquisition', async kind => {
  const dir = location(), path = join(dir, '.jit-host.lock'), f = fixture();
  if (kind === 'symlink') { writeFileSync(join(dir, 'other'), '', { mode: 0o600 }); symlinkSync('other', path); }
  else { writeFileSync(path, kind === 'contents' ? 'stale PID is not authority' : '', { mode: 0o600 }); if (kind === 'hardlink') linkSync(path, join(dir, 'alias')); if (kind === 'permissions') chmodSync(path, 0o640); if (kind === 'parent') chmodSync(dir, 0o777); }
  await expect(FirecrackerHostLock.open(dir, f.port)).rejects.toMatchObject({ code: 'vm_firecracker_helper_locked' }); expect(f.active.size).toBe(0);
});

test('a replaced pathname fences its retained original descriptor instead of silently locking a new inode', async () => {
  const dir = location(), f = fixture(), lock = await acquire(dir, f.port), path = join(dir, '.jit-host.lock');
  renameSync(path, join(dir, 'old')); writeFileSync(path, '', { mode: 0o600 }); expect(() => lock.current()).toThrow();
  lock.close(); expect(f.active.size).toBe(0);
});

test('native driver/restart cannot run without a native process-lifetime singleton', async () => {
  const j = new FirecrackerHostJournal(':memory:'); cleanup.push(() => j.close());
  const driver = { basis: 'protected_host' as const, async execute(): Promise<never> { throw Error('must not execute'); }, async readBack() { return null; } };
  j.register({ id: 'jit-work-fixture', selectionSha256: 'a'.repeat(64), diskBytes: 128 * 1048576, basis: 'protected_host' });
  expect(() => new FirecrackerHostJobs(j, driver)).toThrow(expect.objectContaining({ code: 'vm_firecracker_helper_locked' }));
  expect(() => j.recover()).toThrow(expect.objectContaining({ code: 'vm_firecracker_helper_locked' }));
  const lock = await acquire(location(), fixture().port);
  expect(() => new FirecrackerHostJobs(j, driver, lock)).toThrow(); expect(() => j.recover(lock)).toThrow();
});

test('closing the helper lock during authorization fences a fixture driver before admission', async () => {
  const lock = await acquire(location(), fixture().port), j = new FirecrackerHostJournal(':memory:'); cleanup.push(() => j.close());
  j.register({ id: 'jit-work-fixture', selectionSha256: 'a'.repeat(64), diskBytes: 128 * 1048576, basis: 'protocol_fixture' }); j.observe('jit-work-fixture', { state: 'stopped', launchId: null, basis: 'protocol_fixture' });
  const jobs = new FirecrackerHostJobs(j, { basis: 'protocol_fixture', async execute(): Promise<never> { throw Error('must not execute'); }, async readBack() { return null; } }, lock);
  await expect(jobs.run({ contract: 's16-firecracker-host-command/v1', computerId: 'jit-work-fixture', requestId: '1'.repeat(32), expectedRevision: 1, expectedLaunchId: null, selectionSha256: 'a'.repeat(64), kind: 'launch' }, () => lock.close())).rejects.toMatchObject({ code: 'vm_firecracker_helper_locked' });
  expect(j.db.query('SELECT * FROM fc_jobs').all()).toHaveLength(0);
});

test.skipIf(process.platform === 'linux' && process.getuid?.() === 0)('native lock refuses this host before creating a lock file', async () => {
  const dir = location(); await expect(FirecrackerHostLock.open(dir)).rejects.toMatchObject({ code: 'vm_firecracker_helper_locked' });
});
