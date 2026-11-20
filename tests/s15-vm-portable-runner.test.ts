import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vmRunnerSource } from '../src/s15/vm/runner';
import { VmStore } from '../src/s15/vm/store';
import { portableFiles, portablePath, portableTreeHash } from '../src/s15/vm/portable-protocol';
import { vmHash } from '../src/s15/vm/validation';

// Actual temporary-file/Python protocol conformance, never a VM, KVM or host-isolation receipt.
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function directory() { const root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-portable-'))); cleanup.push(() => rmSync(root, { recursive: true, force: true })); return root; }
async function fixture() {
  const root = directory(), tmp = root + '/.tmp-fixture', importId = 'a'.repeat(32);
  const files = portableFiles([{ path: 'result.txt', bytes: 6, sha256: vmHash('result') }, { path: 'src/note.md', bytes: 4, sha256: vmHash('note') }]), treeSha256 = portableTreeHash(files);
  const run = async (op: string, extra: Record<string, unknown> = {}) => {
    const request = { v: 1, id: 'original', root, tmp, cap: 1048576, op, importId, files, treeSha256, ...extra };
    const process = Bun.spawn(['python3', '-I', '-c', vmRunnerSource], { stdin: new Blob([JSON.stringify(request)]), stdout: 'pipe', stderr: 'pipe' });
    const [text, error, code] = await Promise.all([new Response(process.stdout).text(), new Response(process.stderr).text(), process.exited]);
    expect(error).toBe(''); expect(code).toBe(0); return JSON.parse(text) as { ok: boolean; code?: string; result?: { data?: string; path?: string | null } };
  };
  expect((await run('init')).ok).toBe(true); return { root, tmp, importId, files, treeSha256, run };
}

test('portable manifest bounds and closed paths exclude aliases, caches, homes, control/credential state', () => {
  for (const path of ['../a', 'a%2fb', '/a', 'a//b', 'a/./b', '.env', '.ssh/key', 'node_modules/a', 'browser/data', 'result.sqlite', 'a.pem', 'a\\b', 'a b', 'x/'.repeat(16) + 'a']) expect(() => portablePath(path)).toThrow();
  const unicode = 'src/\u0e1c\u0e25\u0e25\u0e31\u0e1e\u0e18\u0e4c.txt'; expect(portablePath(unicode)).toBe(unicode);
  const file = (path: string, bytes = 0) => ({ path, bytes, sha256: 'a'.repeat(64) });
  for (const files of [[file('A'), file('a')], [file('a'), file('a/b')], [file('a', 1048577)], Array.from({ length: 65 }, (_, i) => file('a' + i)), Array.from({ length: 17 }, (_, i) => file('a' + i, 1048576))]) expect(() => portableFiles(files)).toThrow();
});

test('actual portable read accepts regular single-link bytes and refuses links, oversized files and directories', async () => {
  const f = await fixture(); writeFileSync(join(f.root, 'result.txt'), 'result');
  expect((await f.run('portable_read', { path: join(f.root, 'result.txt') })).result?.data).toBe(Buffer.from('result').toString('base64'));
  symlinkSync('result.txt', join(f.root, 'alias')); expect((await f.run('portable_read', { path: join(f.root, 'alias') })).ok).toBe(false);
  linkSync(join(f.root, 'result.txt'), join(f.root, 'hard')); expect((await f.run('portable_read', { path: join(f.root, 'result.txt') })).ok).toBe(false);
  writeFileSync(join(f.root, 'large'), Buffer.alloc(1048577)); expect((await f.run('portable_read', { path: join(f.root, 'large') })).ok).toBe(false);
  expect((await f.run('portable_read', { path: f.tmp })).ok).toBe(false);
});

test('partial staging never publishes a final tree; original reads neither complete nor replay it', async () => {
  const f = await fixture(), stage = join(f.root, '.jit-import-' + f.importId), target = join(f.root, 'restored-' + f.importId);
  expect((await f.run('portable_begin')).ok).toBe(true);
  expect((await f.run('portable_put', { relative: 'result.txt', data: Buffer.from('result').toString('base64') })).ok).toBe(true);
  expect((await f.run('portable_commit')).ok).toBe(false); expect(existsSync(target)).toBe(false); expect(existsSync(stage)).toBe(true);
  expect((await f.run('portable_inspect')).result?.path).toBeNull(); expect(existsSync(target)).toBe(false);
  expect((await f.run('portable_begin')).ok).toBe(false); expect((await f.run('portable_put', { relative: 'result.txt', data: Buffer.from('result').toString('base64') })).code).toBe('EEXIST');
  expect(readFileSync(join(stage, 'result.txt'), 'utf8')).toBe('result');
});

test.skipIf(process.platform !== 'linux')('actual Linux no-replace rename commits all bytes once and original read-back validates the complete tree', async () => {
  const f = await fixture(); expect((await f.run('portable_begin')).ok).toBe(true);
  for (const [relative, data] of [['result.txt', 'result'], ['src/note.md', 'note']]) expect((await f.run('portable_put', { relative, data: Buffer.from(data!).toString('base64') })).ok).toBe(true);
  const target = join(f.root, 'restored-' + f.importId); mkdirSync(target);
  expect((await f.run('portable_commit')).code).toBe('EEXIST'); expect(existsSync(join(target, 'result.txt'))).toBe(false); rmSync(target);
  expect((await f.run('portable_commit')).result?.path).toBe(target); expect(readFileSync(join(target, 'src/note.md'), 'utf8')).toBe('note');
  expect((await f.run('portable_inspect')).result?.path).toBe(target);
  writeFileSync(join(target, 'result.txt'), 'edited'); expect((await f.run('portable_inspect')).ok).toBe(false);
});

test('portable reader adoption reaches the actual header, never downgrades physical bindings, and survives reopen', () => {
  const path = join(directory(), 'vm.sqlite'), store = new VmStore(path); cleanup.push(() => store.close());
  store.db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); expect(readFileSync(path).readUInt32BE(60)).toBe(1);
  expect(() => store.transaction(() => store.enablePortableState())).toThrow(); store.enablePortableState(); expect(readFileSync(path).readUInt32BE(60)).toBe(3);
  store.enableVsockBindings(); expect(readFileSync(path).readUInt32BE(60)).toBe(3);
  const reopened = new VmStore(path); cleanup.push(() => reopened.close()); reopened.assertPortableState(); expect(reopened.db.query('PRAGMA user_version').get()).toEqual({ user_version: 3 });
  expect([1, 2].includes(readFileSync(path).readUInt32BE(60))).toBe(false);
});

test('WAL-only adoption and missing independent import stamps refuse before portable guest bytes', () => {
  const path = join(directory(), 'vm.sqlite'), store = new VmStore(path); cleanup.push(() => store.close()); store.db.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA busy_timeout=1');
  const reader = new Database(path); cleanup.push(() => reader.close()); reader.exec('BEGIN'); reader.query('SELECT * FROM vm_registry').all();
  expect(() => store.enablePortableState()).toThrow(); expect(readFileSync(path).readUInt32BE(60)).toBe(1);
  reader.exec('ROLLBACK'); store.enablePortableState();
  store.db.exec('CREATE TABLE vm_working_imports (id TEXT PRIMARY KEY,state TEXT,data TEXT)');
  const scope = { vmId: 'vm', workId: 'work', attemptId: 'attempt', generation: 1 };
  expect(() => store.assertPortableImport('a'.repeat(32), scope, 'tree')).toThrow();
  store.db.query('INSERT INTO vm_working_imports VALUES (?,?,?)').run('a'.repeat(32), 'dispatched', JSON.stringify({ treeSha256: 'tree', destination: { generation: 1, attemptId: 'attempt', workId: 'work', vmId: 'vm' } }));
  expect(() => store.assertPortableImport('a'.repeat(32), scope, 'tree')).not.toThrow(); expect(() => store.assertPortableImport('a'.repeat(32), { ...scope, generation: 2 }, 'tree')).toThrow(); expect(() => store.assertPortableImport('a'.repeat(32), scope, 'other')).toThrow();
});
