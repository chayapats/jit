import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { chmodSync, existsSync, linkSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openS16InstallationLease, type S16InstallationLease } from '../src/s16/operations/installation-lease';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { s15CredentialKey } from '../src/s15/credentials';

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fixture() {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'jit-installation-lease-'))); cleanup.push(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, 's16-operations.lock.sqlite') };
}
function open(directory: string, mode: 'shared' | 'exclusive' = 'shared', create = false): S16InstallationLease {
  const lease = openS16InstallationLease({ directory, mode, create }); cleanup.push(() => lease.close()); return lease;
}
async function childLease(directory: string, mode: 'shared' | 'exclusive') {
  const code = `import { openS16InstallationLease } from './src/s16/operations/installation-lease'; const lease = openS16InstallationLease({ directory: process.env.JIT_LEASE_TEST_ROOT!, mode: '${mode}' }); console.log('held'); await Bun.stdin.text(); lease.close();`;
  const child = Bun.spawn([process.execPath, '-e', code], { env: { ...process.env, JIT_LEASE_TEST_ROOT: directory }, stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  cleanup.push(async () => { if (child.exitCode === null) { child.kill(); await child.exited; } });
  const reader = child.stdout.getReader(), first = await reader.read(); expect(new TextDecoder().decode(first.value)).toBe('held\n'); reader.releaseLock();
  return { child, async release() { child.stdin.end(); const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text()]); expect({ exit, error }).toEqual({ exit: 0, error: '' }); } };
}

test('participating processes share a retained read lease, and maintenance stays excluded until every original reader closes', async () => {
  const f = fixture(), first = open(f.directory, 'shared', true), other = await childLease(f.directory, 'shared');
  const bytes = readFileSync(f.path); first.assertCurrent();
  expect(() => open(f.directory, 'exclusive')).toThrow(); first.close();
  expect(() => open(f.directory, 'exclusive')).toThrow(); await other.release();
  const maintenance = open(f.directory, 'exclusive'); maintenance.assertCurrent();
  expect(() => open(f.directory, 'shared')).toThrow(); maintenance.close();
  expect(readFileSync(f.path)).toEqual(bytes); expect(open(f.directory).assertCurrent()).toBeUndefined();
});

test('an exclusive maintenance process excludes participating local commands and OS death releases its original lock without unlinking state', async () => {
  const f = fixture(); open(f.directory, 'shared', true).close(); const bytes = readFileSync(f.path), other = await childLease(f.directory, 'exclusive');
  expect(() => open(f.directory)).toThrow(); other.child.kill('SIGKILL'); await other.child.exited;
  open(f.directory).assertCurrent(); expect(readFileSync(f.path)).toEqual(bytes);
});

test.each(['missing', 'empty', 'reader', 'foreign', 'wal', 'singleton', 'symlink', 'hardlink', 'mode', 'receipt-missing', 'receipt-changed'] as const)('existing %s lease refuses without initialization, mode repair, downgrade or replacement', kind => {
  const f = fixture(); open(f.directory, 'shared', true).close();
  if (kind === 'missing') unlinkSync(f.path);
  if (kind === 'empty') writeFileSync(f.path, '');
  if (['reader', 'foreign', 'wal', 'singleton'].includes(kind)) {
    const db = new Database(f.path, { readwrite: true, create: false });
    try {
      if (kind === 'reader') db.exec('PRAGMA user_version=99');
      if (kind === 'foreign') db.exec('PRAGMA application_id=123');
      if (kind === 'wal') db.exec('PRAGMA journal_mode=WAL');
      if (kind === 'singleton') db.exec('DELETE FROM lease');
    } finally { db.close(true); }
  }
  if (kind === 'symlink') { renameSync(f.path, f.path + '-original'); symlinkSync(f.path + '-original', f.path); }
  if (kind === 'hardlink') linkSync(f.path, f.path + '-other');
  if (kind === 'mode') chmodSync(f.path, 0o644);
  if (kind === 'receipt-missing') unlinkSync(join(f.directory, 's16-operations.lease.json'));
  if (kind === 'receipt-changed') writeFileSync(join(f.directory, 's16-operations.lease.json'), '{}');
  const before = existsSync(f.path) ? readFileSync(f.path) : null;
  expect(() => open(f.directory)).toThrow(); expect(() => open(f.directory, 'shared', true)).toThrow();
  if (before) expect(readFileSync(f.path)).toEqual(before); else expect(existsSync(f.path)).toBe(false);
});

test('retained inode and closed capabilities cannot silently become another installation lease', () => {
  const f = fixture(), lease = open(f.directory, 'shared', true); renameSync(f.path, f.path + '-retained');
  expect(() => lease.assertCurrent()).toThrow(); expect(() => open(f.directory, 'exclusive')).toThrow();
  lease.close(); expect(() => lease.assertCurrent()).toThrow(); expect(existsSync(f.path)).toBe(false);
});

async function cli(args: string[], secret?: string) {
  const child = Bun.spawn([process.execPath, 'src/main.ts', ...args], { stdin: secret === undefined ? 'ignore' : new TextEncoder().encode(secret), stdout: 'pipe', stderr: 'pipe' });
  cleanup.push(async () => { if (child.exitCode === null) { child.kill(); await child.exited; } });
  const [exit, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { exit, out, error };
}

test('real selected CLI init/credential paths participate before owner/vault access, share normal service scope and release on command failure', async () => {
  const f = fixture(), directory = join(f.directory, 'state'), config = join(f.directory, 'config.json');
  writeFileSync(config, JSON.stringify(s15StageConfig(directory, 'http://localhost:3041')), { mode: 0o600 });
  const init = await cli(['init', '--s15', '--config', config]); expect({ exit: init.exit, error: init.error }).toEqual({ exit: 0, error: '' });
  const source = join(directory, 'owner/owner.sqlite'), ownerBefore = readFileSync(source), maintenance = open(directory, 'exclusive');
  const key = 'fixture_ops_secret', file = join(directory, 'vault', s15CredentialKey('s15_staged_controller', key));
  const refused = await cli(['credential', '--s15', '--config', config, '--key', key, '--secret-stdin'], 'fixture-protected-value\n');
  expect(refused.exit).not.toBe(0); expect(refused.out).not.toContain('fixture-protected-value'); expect(refused.error).not.toContain('fixture-protected-value'); expect(existsSync(file)).toBe(false); expect(readFileSync(source)).toEqual(ownerBefore);
  maintenance.close(); const shared = open(directory);
  const stored = await cli(['credential', '--s15', '--config', config, '--key', key, '--secret-stdin'], 'fixture-protected-value\n');
  expect({ exit: stored.exit, error: stored.error }).toEqual({ exit: 0, error: '' }); expect(JSON.parse(stored.out)).toEqual({ state: 'credential_stored' }); expect(existsSync(file)).toBe(true);
  shared.close();
  const failed = await cli(['credential', '--s15', '--config', config, '--key', 'bad', '--secret-stdin'], '\n'); expect(failed.exit).not.toBe(0);
  open(directory, 'exclusive').assertCurrent();
});
