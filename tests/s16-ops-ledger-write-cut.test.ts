import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { readS15RuntimeConfig } from '../src/s15/runtime-config';
import { openS16ControlMaintenance } from '../src/s16/operations/control-maintenance';
import { openS16LedgerWriteCut, type S16LedgerWriteCut } from '../src/s16/operations/ledger-write-cut';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
async function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-current-cut-'))); cleanup.push(() => rmSync(parent, { recursive: true, force: true }));
  const path = join(parent, 'config.json'); writeFileSync(path, JSON.stringify(s15StageConfig(join(parent, 'state'), 'http://localhost:3041')), { mode: 0o600 });
  const child = Bun.spawn([process.execPath, 'src/main.ts', 'init', '--s15', '--config', path], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' });
  const [exit, error] = await Promise.all([child.exited, new Response(child.stderr).text(), new Response(child.stdout).text()]); expect({ exit, error }).toEqual({ exit: 0, error: '' });
  const config = readS15RuntimeConfig(path), context = openS16ControlMaintenance(config); cleanup.push(() => context.close());
  const paths = context.sources.map(source => source.database.filename);
  const competingWriters = () => {
    const script = `import {Database} from 'bun:sqlite';let blocked=0;for(const path of ${JSON.stringify(paths)}){const db=new Database(path,{readwrite:true,create:false});try{db.exec('PRAGMA busy_timeout=10; BEGIN IMMEDIATE; ROLLBACK');}catch{blocked++;}finally{db.close(true);}}console.log(JSON.stringify({blocked}));`;
    const result = Bun.spawnSync([process.execPath, '-e', script], { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 5000 });
    expect({ exit: result.exitCode, error: result.stderr.toString() }).toEqual({ exit: 0, error: '' }); return JSON.parse(result.stdout.toString()).blocked as number;
  };
  return { config, context, competingWriters };
}

test('actual complete current writer cut excludes every independent SQL writer and leaves all current images unchanged', async () => {
  const { context, competingWriters } = await fixture(), before = context.sources.map(source => source.database.serialize());
  expect(competingWriters()).toBe(0); const cut = context.currentLedgerCut(); cut.assertCurrent(); expect(cut.sources.map(source => source.name)).toEqual(context.sources.map(source => source.name).sort());
  expect(competingWriters()).toBe(context.sources.length);
  for (const source of cut.sources) expect(cut.serialize(source.name).subarray(0, 16).toString()).toBe('SQLite format 3\0');
  expect(() => context.retireSources()).toThrow('s16_ops_source_release_unknown');
  expect(() => context.currentPayloadReferences()).toThrow('s16_ops_sources_busy');
  cut.close(); cut.close(); expect(cut.released).toBe(true); expect(() => cut.assertCurrent()).toThrow('s16_ops_source_cut_closed');
  expect(competingWriters()).toBe(0); expect(context.sources.map(source => source.database.serialize())).toEqual(before); context.assertCurrent();
});

test.each(['rows', 'schema', 'format'] as const)('a guard that changes current %s cannot retain an allegedly unchanged writer cut', async kind => {
  const { context } = await fixture(), database = context.outer[0]!.database, before = database.serialize(); let change = false;
  const cut = openS16LedgerWriteCut({ sources: context.sources, guard() {
    context.assertCurrent(); if (change) { change = false; database.exec(kind === 'rows' ? "UPDATE memory_identity SET id='changed'" : kind === 'schema' ? 'ALTER TABLE memory_identity ADD COLUMN changed TEXT' : 'PRAGMA user_version=99'); }
  } });
  change = true; try { expect(() => cut.assertCurrent()).toThrow('s16_ops_source_cut_changed'); } finally { cut.close(); }
  expect(database.serialize()).toEqual(before); context.assertCurrent();
});

test('unknown rollback retains the original cut and process owner until the same disposal retry conclusively releases', async () => {
  const { config, context, competingWriters } = await fixture(), database = context.outer[0]!.database, exec = database.exec.bind(database), before = context.sources.map(source => source.database.serialize()), cut = context.currentLedgerCut();
  database.exec = sql => { if (sql === 'ROLLBACK') throw Error('fixture_rollback_unknown'); return exec(sql); };
  try {
    expect(() => context.close()).toThrow('s16_ops_source_release_unknown'); expect(cut.released).toBe(false); expect(competingWriters()).toBe(1);
    expect(() => openS16ControlMaintenance(config)).toThrow();
  } finally { database.exec = exec; }
  context.close(); expect(cut.released).toBe(true); expect(competingWriters()).toBe(0);
  const fresh = openS16ControlMaintenance(config); try { expect(fresh.sources.map(source => source.database.serialize())).toEqual(before); } finally { fresh.close(); }
});

test('an opener releases only its own partial cut and preserves a pre-existing source transaction', async () => {
  const { context } = await fixture(), last = [...context.sources].sort((a, b) => a.name.localeCompare(b.name)).at(-1)!.database; let retained: S16LedgerWriteCut | undefined;
  last.exec('BEGIN IMMEDIATE'); try {
    expect(() => openS16LedgerWriteCut({ sources: context.sources, guard: context.assertCurrent, retain(cut) { retained = cut; } })).toThrow('s16_ops_source_busy');
    expect(retained!.released).toBe(true); expect(context.sources.filter(source => source.database.inTransaction).map(source => source.database)).toEqual([last]);
  } finally { last.exec('ROLLBACK'); }
  const next = context.currentLedgerCut(); next.assertCurrent(); next.close();
});

test('only the original complete live cut can supply current references inside reserved transactions', async () => {
  const { context } = await fixture(), original = context.currentPayloadReferences(), cut = context.currentLedgerCut(), pinned = context.currentPayloadReferences(cut);
  expect(pinned.value).toEqual(original.value); pinned.assertCurrent();
  expect(() => context.currentPayloadReferences({ ...cut })).toThrow('s16_ops_source_cut_invalid');
  cut.close(); expect(() => pinned.assertCurrent()).toThrow('s16_ops_source_cut_closed'); expect(() => context.currentPayloadReferences(cut)).toThrow('s16_ops_source_cut_closed');
  const partial = openS16LedgerWriteCut({ sources: [context.sources[0]!], guard: context.assertCurrent });
  try { expect(() => context.currentPayloadReferences(partial)).toThrow('s16_ops_source_cut_invalid'); } finally { partial.close(); }
  context.currentPayloadReferences().assertCurrent();
});

test('current byte custody accepts only the original complete live writer cut and expires on its release or parent retirement', async () => {
  const { context } = await fixture(), original = [context.currentFileCustody().value, context.currentGithubCustody().value], cut = context.currentLedgerCut();
  const file = context.currentFileCustody(cut), github = context.currentGithubCustody(cut);
  expect([file.value, github.value]).toEqual(original); file.assertCurrent(); github.assertCurrent();
  for (const method of [context.currentFileCustody, context.currentGithubCustody]) expect(() => method({ ...cut })).toThrow('s16_ops_source_cut_invalid');
  cut.close(); expect(() => file.assertCurrent()).toThrow('s16_ops_source_cut_closed'); expect(() => github.assertCurrent()).toThrow('s16_ops_source_cut_closed');
  const partial = openS16LedgerWriteCut({ sources: [context.sources[0]!], guard: context.assertCurrent });
  try { for (const method of [context.currentFileCustody, context.currentGithubCustody]) expect(() => method(partial)).toThrow('s16_ops_source_cut_invalid'); } finally { partial.close(); }
  const fresh = context.currentGithubCustody(); context.retireSources(); expect(() => fresh.assertCurrent()).toThrow(); expect(() => context.currentFileCustody()).toThrow();
});

test('a fresh complete cut after actual WAL checkpoint retains the same current image while a new current write changes it', async () => {
  const { config, context } = await fixture(), database = context.runtime.sources.find(source => source.name === 'github.sqlite')!.database;
  database.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0'); context.close();
  let current = openS16ControlMaintenance(config);
  try {
    const source = current.runtime.sources.find(source => source.name === 'github.sqlite')!.database;
    source.query("INSERT INTO records VALUES ('report',?,?)").run('original_current', JSON.stringify({ state: 'unknown' }));
    current.assertCurrent(); const first = current.currentLedgerCut(), before = first.serialize('github.sqlite'); first.close(); current.close();
    current = openS16ControlMaintenance(config); const second = current.currentLedgerCut(), after = second.serialize('github.sqlite'); second.close();
    const header = Array.from({ length: 100 }, (_, at) => at).filter(at => before[at] !== after[at]);
    expect({ header, bodyChanged: !before.subarray(100).equals(after.subarray(100)) }).toEqual({ header: [], bodyChanged: false });
    current.runtime.sources.find(source => source.name === 'github.sqlite')!.database.query("UPDATE records SET json=? WHERE id='original_current'").run(JSON.stringify({ state: 'unknown', newCurrentFact: true }));
    const third = current.currentLedgerCut(); try { expect(third.serialize('github.sqlite').equals(before)).toBe(false); } finally { third.close(); }
  } finally { current.close(); }
});
