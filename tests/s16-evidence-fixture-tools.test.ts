import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { s16FixtureLibraryHash } from '../ops/evidence/s16-fixture-tools';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() { const root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-parser-pins-'))); roots.push(root); return root; }

test('parser pins retain actual library and readable bytecode changes without publishing paths', () => {
  const root = fixture(); writeFileSync(join(root, 'parser.py'), 'fixture source'); mkdirSync(join(root, '__pycache__')); writeFileSync(join(root, '__pycache__/parser.pyc'), 'fixture bytecode');
  const before = s16FixtureLibraryHash(root); expect(before.files).toBe(2); expect(JSON.stringify(before)).not.toContain(root);
  writeFileSync(join(root, '__pycache__/parser.pyc'), 'changed executable bytecode'); expect(s16FixtureLibraryHash(root).sha256).not.toBe(before.sha256);
  const bytecode = s16FixtureLibraryHash(root); writeFileSync(join(root, 'parser.py'), 'changed source'); expect(s16FixtureLibraryHash(root).sha256).not.toBe(bytecode.sha256);
});

test.each(['file', 'directory', 'root'] as const)('a parser library %s symlink cannot import unbounded or foreign custody', kind => {
  const root = fixture(), library = join(root, 'library'); mkdirSync(library); writeFileSync(join(root, 'outside.py'), 'unowned');
  if (kind === 'file') symlinkSync('../outside.py', join(library, 'linked.py'));
  if (kind === 'directory') symlinkSync('..', join(library, 'linked'));
  if (kind === 'root') symlinkSync('library', join(root, 'alias'));
  expect(() => s16FixtureLibraryHash(kind === 'root' ? join(root, 'alias') : library)).toThrow('s16_fixture_library_invalid');
});

test('a parser library cannot exceed the finite traversal depth', () => {
  const root = fixture(); let path = root;
  for (let depth = 0; depth < 17; depth++) { path = join(path, 'nested'); mkdirSync(path); }
  expect(() => s16FixtureLibraryHash(root)).toThrow('s16_fixture_library_bounds');
});
