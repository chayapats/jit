import { afterEach, expect, test } from 'bun:test';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConnectionVault } from '../src/exec/connections';

const cleanup: (() => void)[] = [];
const id = '11111111-1111-4111-8111-111111111111', alias = '22222222-2222-4222-8222-222222222222';
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() { const root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-existing-secret-'))); cleanup.push(() => rmSync(root, { recursive: true, force: true })); const directory = join(root, 'vault'), vault = new ConnectionVault(directory, { forbidden: [join(root, 'execution')] }); return { root, directory, vault }; }
test('existing-only vault read never creates missing storage and does not change the stored value', () => {
  const f = fixture(); expect(() => f.vault.readExisting(id)).toThrow(); expect(existsSync(f.directory)).toBe(false);
  f.vault.write(id, 'disposable-fixture-value'); const before = readFileSync(join(f.directory, id)); expect(f.vault.readExisting(id)).toBe('disposable-fixture-value'); expect(readFileSync(join(f.directory, id))).toEqual(before);
});
test.each(['symlink', 'hardlink', 'mode', 'directory', 'foreign-uid'] as const)('existing-only vault refuses %s without repair', kind => {
  const f = fixture(); f.vault.write(id, 'disposable-fixture-value'); const path = join(f.directory, id);
  if (kind === 'symlink') { symlinkSync(path, join(f.directory, alias)); expect(() => f.vault.readExisting(alias)).toThrow(); }
  if (kind === 'hardlink') { linkSync(path, join(f.directory, alias)); expect(() => f.vault.readExisting(id)).toThrow(); }
  if (kind === 'mode') { chmodSync(path, 0o644); expect(() => f.vault.readExisting(id)).toThrow(); }
  if (kind === 'directory') { mkdirSync(join(f.directory, alias), { mode: 0o700 }); expect(() => f.vault.readExisting(alias)).toThrow(); }
  if (kind === 'foreign-uid') { const foreign = new ConnectionVault(f.directory, { forbidden: [], uid: (process.getuid?.() ?? 0) + 1 }); expect(() => foreign.readExisting(id)).toThrow(); }
  expect(readFileSync(path).toString()).toBe('disposable-fixture-value');
});
