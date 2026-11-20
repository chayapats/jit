import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { linkSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DurableJournal } from '../src/s15/durable-journal';
import { reserveDurableJournalPath } from '../src/s15/durable-ownership';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const appId = 0x4a46434a;
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-durable-owner-'))); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'state'); mkdirSync(directory, { mode: 0o700 }); const path = join(directory, 'journal.sqlite');
  const journal = new DurableJournal(path, 'fixture', true, appId); cleanup.push(() => journal.close()); return { root, directory, path, journal };
}
function child(code: string): unknown {
  const proc = Bun.spawnSync([process.execPath, '-e', code], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
  expect({ exit: proc.exitCode, error: proc.stderr.toString() }).toEqual({ exit: 0, error: '' }); return JSON.parse(proc.stdout.toString());
}
function locked(path: string) {
  return child(`import {DurableJournal} from './src/s15/durable-journal';let code='incorrectly_opened';try{const j=new DurableJournal(${JSON.stringify(path)},'fixture',false,${appId});j.close();}catch(error){code=error.code;}console.log(JSON.stringify({code}));`);
}

test('same-process duplicate/maintenance reservations refuse before header or lease fd close can weaken original OS locks', () => {
  const f = fixture(); f.journal.db.exec('BEGIN IMMEDIATE');
  expect(() => new DurableJournal(f.path, 'fixture', false, appId)).toThrow(expect.objectContaining({ code: 'runtime_already_open' }));
  expect(() => reserveDurableJournalPath(f.path)).toThrow(expect.objectContaining({ code: 'runtime_already_open' }));
  expect(child(`import {Database} from 'bun:sqlite';const db=new Database(${JSON.stringify(f.path)},{readwrite:true,create:false});db.exec('PRAGMA busy_timeout=10');let blocked=false;try{db.exec('BEGIN IMMEDIATE');}catch{blocked=true;}db.close(true);console.log(JSON.stringify({blocked}));`)).toEqual({ blocked: true });
  expect(locked(f.path)).toEqual({ code: 'runtime_already_open' }); f.journal.db.exec('ROLLBACK'); f.journal.close();
  expect(locked(f.path)).toEqual({ code: 'incorrectly_opened' });
});

test('canonical parent aliases share the same local reservation before any source descriptor opens', () => {
  const f = fixture(), alias = join(f.root, 'alias'); symlinkSync(f.directory, alias);
  expect(() => new DurableJournal(join(alias, 'journal.sqlite'), 'fixture', false, appId)).toThrow(expect.objectContaining({ code: 'runtime_already_open' }));
  expect(locked(f.path)).toEqual({ code: 'runtime_already_open' });
});

test('freshly bound inode ownership rejects hardlink aliases and retains identity after a pathname move', () => {
  const f = fixture(), alias = join(f.directory, 'alias.sqlite'); linkSync(f.path, alias);
  expect(() => reserveDurableJournalPath(alias)).toThrow(expect.objectContaining({ code: 'runtime_already_open' }));
  expect(() => new DurableJournal(alias, 'fixture', false, appId)).toThrow(expect.objectContaining({ code: 'runtime_already_open' }));
  const moved = join(f.directory, 'moved.sqlite'); renameSync(alias, moved); expect(() => reserveDurableJournalPath(moved)).toThrow(expect.objectContaining({ code: 'runtime_already_open' }));
  expect(locked(f.path)).toEqual({ code: 'runtime_already_open' });
});

test('unknown data close keeps local ownership and the actual original process lease until disposal succeeds', () => {
  const f = fixture(), original = f.journal.db.close.bind(f.journal.db); f.journal.db.close = () => { throw Error('fixture_close_unknown'); };
  try {
    expect(() => f.journal.close()).toThrow(expect.objectContaining({ code: 'runtime_release_unknown' })); expect(() => f.journal.tx(() => {})).toThrow();
    expect(() => new DurableJournal(f.path, 'fixture', false, appId)).toThrow(expect.objectContaining({ code: 'runtime_already_open' })); expect(locked(f.path)).toEqual({ code: 'runtime_already_open' });
  } finally { f.journal.db.close = original; }
  f.journal.close(); const next = new DurableJournal(f.path, 'fixture', false, appId); next.close();
});

test('known opener refusal releases only its own local reservation without repairing future metadata', () => {
  const f = fixture(); f.journal.close(); const db = new Database(f.path, { readwrite: true, create: false }); db.exec('PRAGMA user_version=2'); db.close(true);
  expect(() => new DurableJournal(f.path, 'fixture', false, appId)).toThrow(expect.objectContaining({ code: 'continuity_unavailable' }));
  const ownership = reserveDurableJournalPath(f.path); ownership.release();
  const original = new DurableJournal(f.path, 'fixture', false, appId, undefined, [1, 2]); expect(original.db.query<{ user_version: number }, []>('PRAGMA user_version').get()!.user_version).toBe(2); original.close();
});
