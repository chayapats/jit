import { createHash } from 'node:crypto';
import { lstatSync, opendirSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { AppError } from '../../errors';
import { opsPath } from '../../s14/ops-files';
import { identity } from '../conversation/validation';
import { digest as policyDigest, ref as policyRef } from '../policy/validation';
import { assertS16ExclusiveInstallationLease, type S16InstallationLease } from '../../s16/operations/installation-lease';
import type { S16LedgerSource } from '../../s16/operations/ledger-set';
import { verifyS16PayloadSources, type S16PayloadSource } from '../../s16/operations/payload-set';

type Correlation = Readonly<{ table: 'records' | 'receipts' | 'disclosure'; kind: string; rowId: string; slot: string; state: string | null }>;
/** Current hash-addressed byte custody only; references never grant publication, recipient or effect authority. */
export interface S16GithubArtifactCohort {
  contract: 's16-github-artifact-cohort/v1'; installationId: string; present: boolean; namespace: boolean; lineage: boolean;
  bundles: readonly Readonly<{ id: string; bytes: number; sha256: string; references: readonly Correlation[] }>[];
}
/** Protected current composition owns the source, namespace and exclusion; archives supply none of these. */
export interface S16GithubArtifactOptions {
  directory: string; installationId: string; lease: S16InstallationLease; source: S16LedgerSource | undefined; disclosure: S16LedgerSource | undefined; guard(): void;
}
/** Original current byte/reference cut with host-only descriptors and live revalidation. */
export interface S16GithubArtifactObservation {
  readonly value: Readonly<S16GithubArtifactCohort>; readonly sha256: string; readonly sources: readonly Readonly<S16PayloadSource>[];
  assertCurrent(): void;
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: BigIntStats, b: BigIntStats) => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key as keyof BigIntStats] === b[key as keyof BigIntStats]);
const kinds = new Set(['connection', 'connection_history', 'report', 'issue', 'selection', 'work_evidence', 'action', 'action_family', 'remote_result', 'capture', 'babysit']);
function refuse(code = 's16_ops_github_custody_invalid'): never { throw new AppError(code, 409); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse(); return value as Record<string, unknown>; }
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
function encode(value: S16GithubArtifactCohort | S16GithubCurrentReferences): string { const text = JSON.stringify(value); if (Buffer.byteLength(text) > 4194304) refuse('s16_ops_github_bounds'); return text; }

type Entry = (path: string, dir?: boolean, optional?: boolean) => BigIntStats | null;
/** Both complete custody and missing-byte recovery use the same bounded current owning SQL parser. */
function currentReferenceRows(options: S16GithubArtifactOptions, entry: Entry): Map<string, Correlation[]> {
  const { directory, installationId, source, disclosure } = options;
  const references = new Map<string, Correlation[]>(); let correlations = 0;
  const main = join(directory, 'runtime/github.sqlite'), database = entry(main, false, !source);
  if (!!database !== !!source || source && (source.name !== 'github.sqlite' || source.database.filename !== main || source.reader.applicationId !== 0x4a473135)) refuse();
  if (database && (database.size < 512n || database.size > 1073741824n)) refuse('s16_ops_github_bounds');
  const bundle = (value: unknown): string => { const ref = object(value); if (Object.keys(ref).sort().join(',') !== 'generation,id,revision' || typeof ref.id !== 'string' || !/^bundle_[a-f0-9]{64}$/.test(ref.id) || ref.revision !== 1 || ref.generation !== 1) return refuse(); return ref.id; };
  const add = (value: unknown, row: Omit<Correlation, 'slot' | 'state'>, slot: string, state: string | null) => {
    const id = bundle(value); if (++correlations > 50000) refuse('s16_ops_github_bounds'); const refs = references.get(id) ?? []; refs.push(Object.freeze({ ...row, slot, state })); references.set(id, refs); return id;
  };
  const evidence = (value: unknown, row: Omit<Correlation, 'slot' | 'state'>, slot: string, state: string | null) => add(object(value).bundle, row, slot, state);
  const selection = (value: unknown, row: Omit<Correlation, 'slot' | 'state'>, slot: string, expectedId?: string): string | null => {
    const s = object(value); identity(s.id as string); identity(s.workId as string);
    if (expectedId !== undefined && s.id !== expectedId || !['selected', 'implementing', 'reviewable', 'reconcile_only'].includes(s.state as string) || s.state === 'reviewable' && s.evidence === null) refuse();
    return s.evidence === null ? null : evidence(s.evidence, row, slot, s.state as string);
  };
  if (source) {
    const db = source.database;
    const bytes = db.query<{ page_count: number }, []>('PRAGMA main.page_count').get()!.page_count * db.query<{ page_size: number }, []>('PRAGMA main.page_size').get()!.page_size;
    if (!Number.isSafeInteger(bytes) || bytes < 512 || bytes > 1073741824) refuse('s16_ops_github_bounds');
    if (db.query<{ application_id: number }, []>('PRAGMA main.application_id').get()?.application_id !== 0x4a473135 || db.query<{ user_version: number }, []>('PRAGMA main.user_version').get()?.user_version !== 1 || db.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get()?.quick_check !== 'ok' || db.query('PRAGMA foreign_key_check').get()) refuse();
    const schemaBounds = db.query<{ n: number; invalid: number }, []>("SELECT count(*) n,coalesce(sum(length(CAST(name AS BLOB))>128 OR length(CAST(tbl_name AS BLOB))>128 OR (sql IS NOT NULL AND length(CAST(sql AS BLOB))>8192)),0) invalid FROM main.sqlite_schema").get();
    if (!schemaBounds || schemaBounds.n > 6 || schemaBounds.invalid) refuse('s16_ops_github_bounds');
    const tables = ['identity', 'records', 'receipts'], allowed = new Set(tables.flatMap(table => [table, 'sqlite_autoindex_' + table + '_1']));
    if (db.query<{ type: string; name: string }, []>('SELECT type,name FROM main.sqlite_schema LIMIT 7').all().some(row => !allowed.has(row.name) || !['table', 'index'].includes(row.type))) refuse();
    const columns = { identity: ['id:TEXT'], records: ['kind:TEXT', 'id:TEXT', 'json:TEXT'], receipts: ['id:TEXT', 'hash:TEXT', 'json:TEXT'] };
    for (const table of tables as (keyof typeof columns)[]) if (db.query<{ name: string; type: string }, []>('PRAGMA main.table_info(' + table + ')').all().map(row => row.name + ':' + row.type.toUpperCase()).join(',') !== columns[table].join(',')) refuse();
    const identityBounds = db.query<{ n: number; invalid: number }, []>("SELECT count(*) n,coalesce(sum(typeof(id)<>'text' OR length(CAST(id AS BLOB))>128),0) invalid FROM main.identity").get();
    if (!identityBounds || identityBounds.n !== 1 || identityBounds.invalid) refuse();
    const ids = db.query<{ id: string }, []>('SELECT id FROM main.identity LIMIT 2').all(); if (ids.length !== 1 || ids[0]!.id !== installationId) refuse();
    let rows = 0, jsonBytes = 0;
    for (const table of ['records', 'receipts'] as const) {
      const bounds = db.query<{ n: number; bytes: number; invalid: number }, []>(`SELECT count(*) n,coalesce(sum(length(CAST(json AS BLOB))),0) bytes,coalesce(sum(typeof(id)<>'text' OR length(CAST(id AS BLOB))>256 OR typeof(json)<>'text' OR length(CAST(json AS BLOB))>1048576 OR json_valid(json)=0${table === 'records' ? " OR typeof(kind)<>'text' OR length(CAST(kind AS BLOB))>128" : " OR typeof(hash)<>'text' OR length(hash)<>64 OR hash GLOB '*[^a-f0-9]*'"}),0) invalid FROM main.${table}`).get();
      if (!bounds || bounds.invalid || (rows += bounds.n) > 50000 || (jsonBytes += bounds.bytes) > 67108864) refuse('s16_ops_github_bounds');
    }
    for (const table of ['records', 'receipts'] as const) for (const raw of db.query<{ id: string; kind?: string; body: Uint8Array }, []>(`SELECT id,${table === 'records' ? 'kind,' : ''}CAST(json AS BLOB) body FROM main.${table} ORDER BY ${table === 'records' ? 'kind,' : ''}id`).iterate()) {
      if (!/^[A-Za-z0-9_-]{1,256}$/.test(raw.id) || table === 'records' && !kinds.has(raw.kind!)) refuse();
      const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw.body))), row = { table, kind: raw.kind ?? 'selection_receipt', rowId: raw.id };
      if (table === 'receipts') { if (raw.id.startsWith('select_')) selection(value, row, 'receipt.evidence'); }
      else if (raw.kind === 'selection') selection(value, row, 'selection.evidence', raw.id);
      else if (raw.kind === 'action') {
        if (value.id !== raw.id) refuse(); const selected = selection(value.selection, row, 'action.selection.evidence'), actual = evidence(value.evidence, row, 'action.evidence', null), effect = add(object(value.effect).bundle, row, 'action.effect', null);
        if (selected === null || selected !== actual || effect !== actual) refuse();
      } else if (raw.kind === 'work_evidence' && typeof value.repository !== 'string' && !(Object.hasOwn(value, 'action') && Object.hasOwn(value, 'observation'))) evidence(value, row, 'work_evidence.bundle', null);
    }
  }
  // DATA15 records a captured artifact before GithubService can publish selection evidence.
  // Its typed derived slot must not disappear merely because the later GitHub commit was lost.
  const lineagePath = join(directory, 'runtime/disclosure.sqlite'), lineageFile = entry(lineagePath, false, !disclosure);
  if (!!lineageFile !== !!disclosure) refuse();
  if (disclosure) {
    const db = disclosure.database;
    if (!lineageFile || lineageFile.size < 512n || lineageFile.size > 1073741824n || disclosure.name !== 'disclosure.sqlite' || db.filename !== lineagePath || disclosure.reader.applicationId !== 0x4a445135 || db.query<{ application_id: number }, []>('PRAGMA main.application_id').get()?.application_id !== 0x4a445135 || db.query<{ user_version: number }, []>('PRAGMA main.user_version').get()?.user_version !== 1) refuse();
    const pages = db.query<{ page_count: number }, []>('PRAGMA main.page_count').get()!.page_count * db.query<{ page_size: number }, []>('PRAGMA main.page_size').get()!.page_size;
    if (!Number.isSafeInteger(pages) || pages > 1073741824 || db.query<{ quick_check: string }, []>('PRAGMA quick_check(1)').get()?.quick_check !== 'ok' || db.query('PRAGMA foreign_key_check').get()) refuse();
    const schemaBounds = db.query<{ n: number; invalid: number }, []>("SELECT count(*) n,coalesce(sum(length(CAST(name AS BLOB))>128 OR length(CAST(tbl_name AS BLOB))>128 OR (sql IS NOT NULL AND length(CAST(sql AS BLOB))>8192)),0) invalid FROM main.sqlite_schema").get();
    if (!schemaBounds || schemaBounds.n > 6 || schemaBounds.invalid) refuse('s16_ops_github_bounds');
    const columns = { identity: ['installation:TEXT'], records: ['id:TEXT', 'json:TEXT'], commands: ['id:TEXT', 'hash:TEXT', 'json:TEXT'] }, tables = Object.keys(columns) as (keyof typeof columns)[], allowed = new Set(tables.flatMap(table => [table, 'sqlite_autoindex_' + table + '_1']));
    if (db.query<{ type: string; name: string }, []>('SELECT type,name FROM main.sqlite_schema LIMIT 7').all().some(row => !allowed.has(row.name) || !['table', 'index'].includes(row.type))) refuse();
    for (const table of tables) if (db.query<{ name: string; type: string }, []>('PRAGMA main.table_info(' + table + ')').all().map(row => row.name + ':' + row.type.toUpperCase()).join(',') !== columns[table].join(',')) refuse();
    const identities = db.query<{ n: number; invalid: number }, []>("SELECT count(*) n,coalesce(sum(typeof(installation)<>'text' OR length(CAST(installation AS BLOB))>128),0) invalid FROM main.identity").get();
    if (!identities || identities.n !== 1 || identities.invalid || db.query<{ installation: string }, []>('SELECT installation FROM main.identity LIMIT 1').get()?.installation !== installationId) refuse();
    const bounds = db.query<{ n: number; bytes: number; invalid: number }, []>("SELECT count(*) n,coalesce(sum(length(CAST(json AS BLOB))),0) bytes,coalesce(sum(typeof(id)<>'text' OR length(CAST(id AS BLOB))>128 OR typeof(json)<>'text' OR length(CAST(json AS BLOB))>131072 OR json_valid(json)=0),0) invalid FROM main.records").get();
    if (!bounds || bounds.n > 10000 || bounds.bytes > 67108864 || bounds.invalid) refuse('s16_ops_github_bounds');
    for (const row of db.query<{ id: string; body: Uint8Array }, []>('SELECT id,CAST(json AS BLOB) body FROM main.records ORDER BY id').iterate()) {
      const value = object(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(row.body))); if (value.kind !== 'derived') continue;
      policyRef(value.ref); if (value.id !== row.id || row.id !== 'derived_' + policyDigest('s15.disclosure.derived.v1', value.ref)) refuse();
      if (value.format === 'artifact' && value.ref.id.startsWith('bundle_')) add(value.ref, { table: 'disclosure', kind: 'derived', rowId: row.id }, 'disclosure.derived.ref', null);
    }
  }
  return references;
}

/**
 * Enumerates and verifies every owning bundle and exact retained reference without store boot/recovery,
 * Git decoding, credentials, gateway calls or mutation settlement. Unreferenced bytes stay unreferenced.
 */
export function captureS16GithubArtifacts(options: S16GithubArtifactOptions): S16GithubArtifactObservation {
  const { directory, installationId, lease, source, disclosure } = options; identity(installationId);
  if (!isAbsolute(directory) || normalize(directory) !== directory) refuse();
  const guard = () => { assertS16ExclusiveInstallationLease(lease, directory); if ((options.guard() as unknown) !== undefined) refuse('s16_ops_guard_invalid'); }; guard();
  const collect = () => {
    guard(); const entries = new Map<string, BigIntStats | null>();
    const entry = (path: string, dir = false, optional = false) => {
      opsPath(path); const s = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (!s) { if (!optional) return refuse('s16_ops_github_missing'); entries.set(path, null); return null; }
      if (process.getuid?.() === undefined || s.uid !== BigInt(process.getuid!()) || s.isSymbolicLink() || (dir ? !s.isDirectory() : !s.isFile() || s.nlink !== 1n) || s.mode & (dir ? 0o7077n : 0o7177n)) return refuse();
      entries.set(path, s); return s;
    };
    const references = currentReferenceRows(options, entry), root = join(directory, 'github-artifacts'), namespace = entry(root, true, !source);
    const names: string[] = [];
    if (namespace) { const dir = opendirSync(root); try { for (;;) { const next = dir.readSync(); if (!next) break; if (names.length >= 20000 || !/^bundle_[a-f0-9]{64}$/.test(next.name)) refuse('s16_ops_github_bounds'); names.push(next.name); } } finally { dir.closeSync(); } }
    if (!source && names.length) refuse(); names.sort(); const present = new Set(names); if ([...references.keys()].some(id => !present.has(id))) refuse('s16_ops_github_missing');
    let total = 0; const sources: S16PayloadSource[] = [], bundles: S16GithubArtifactCohort['bundles'][number][] = [];
    for (const id of names) {
      const path = join(root, id), stat = entry(path)!; if (stat.size > 1073741824n || (total += Number(stat.size)) > 4294967296) refuse('s16_ops_github_bounds');
      const sha256 = id.slice(7), bytes = Number(stat.size); sources.push(Object.freeze({ name: 'github_' + id + '.bundle', path, bytes, sha256 })); bundles.push(freeze({ id, bytes, sha256, references: references.get(id) ?? [] }));
    }
    const value: S16GithubArtifactCohort = { contract: 's16-github-artifact-cohort/v1', installationId, present: source !== undefined, namespace: namespace !== null, lineage: disclosure !== undefined, bundles }; encode(value);
    const check = () => { guard(); for (const [path, before] of entries) { const after = lstatSync(path, { bigint: true, throwIfNoEntry: false }); if (before ? !after || !same(before, after) : after) refuse('s16_ops_github_changed'); } guard(); }; check(); verifyS16PayloadSources(sources, guard); check();
    return { value: freeze(value), sources: Object.freeze(sources), check };
  };
  const original = collect(), sha256 = sha(encode(original.value));
  return Object.freeze({ value: original.value, sources: original.sources, sha256, assertCurrent() { original.check(); const latest = collect(); if (sha(encode(latest.value)) !== sha256) refuse('s16_ops_github_changed'); original.check(); } });
}

/** Current SQL correlations only; no namespace, byte availability, publication or execution permission is asserted. */
export interface S16GithubCurrentReferences {
  readonly contract: 's16-github-current-references/v1'; readonly installationId: string;
  readonly present: boolean; readonly lineage: boolean;
  readonly bundles: readonly Readonly<{ id: string; sha256: string; references: readonly Correlation[] }>[];
}
/**
 * Reads current owning GitHub/DATA15 pins under genuine protected exclusion without touching bundle
 * paths. Missing bytes can be repaired only by a separately authenticated candidate and coordinator.
 */
export function readS16GithubCurrentReferences(options: S16GithubArtifactOptions): Readonly<S16GithubCurrentReferences> {
  const { directory, installationId, lease, source, disclosure } = options; identity(installationId);
  if (!isAbsolute(directory) || normalize(directory) !== directory) refuse();
  const guard = () => {
    assertS16ExclusiveInstallationLease(lease, directory);
    if ((options.guard() as unknown) !== undefined) refuse('s16_ops_guard_invalid');
    if (source?.database.inTransaction || disclosure?.database.inTransaction) refuse('s16_ops_sources_busy');
  }; guard();
  const entries = new Map<string, BigIntStats | null>();
  const entry: Entry = (path, dir = false, optional = false) => {
    opsPath(path); const stat = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!stat) { if (!optional) refuse('s16_ops_github_missing'); entries.set(path, null); return null; }
    if (process.getuid?.() === undefined || stat.uid !== BigInt(process.getuid!()) || stat.isSymbolicLink() || (dir ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) || stat.mode & (dir ? 0o7077n : 0o7177n)) refuse();
    entries.set(path, stat); return stat;
  };
  const references = currentReferenceRows(options, entry);
  const value: S16GithubCurrentReferences = { contract: 's16-github-current-references/v1', installationId, present: source !== undefined, lineage: disclosure !== undefined,
    bundles: [...references].sort(([a], [b]) => a.localeCompare(b)).map(([id, references]) => ({ id, sha256: id.slice(7), references })) };
  encode(value); guard();
  for (const [path, before] of entries) { const after = lstatSync(path, { bigint: true, throwIfNoEntry: false }); if (before ? !after || !same(before, after) : after) refuse('s16_ops_github_changed'); }
  guard(); return freeze(value);
}
