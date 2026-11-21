import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, opendirSync, readSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { AppError } from '../../errors';
import { pinnedImagePattern } from '../../exec/box-runtime';
import { opsPath } from '../../s14/ops-files';
import { identity } from '../../s15/conversation/validation';
import type { S16LedgerSource } from '../operations/ledger-set';
import { assertS16ExclusiveInstallationLease, type S16InstallationLease } from '../operations/installation-lease';
import type { S16PayloadSource } from '../operations/payload-set';
import { fileExpectedPayloads, type FileExpectedPayloads } from './maintenance';
import { assertS16LedgerWriteCutFor, type S16LedgerWriteCut } from '../operations/ledger-write-cut';
import { s16ByteCustodyIdentities, type S16ByteCustodyIdentity } from '../operations/byte-custody-identity';
import type { FileUpload } from './types';

type Role = 'original' | 'representation' | 'artifact' | 'upload_fragment' | 'unpublished_original' | 'unpublished_representation' | 'parser_input' | 'parser_output';
/** Protected byte identities only. Untrusted custody never becomes a receipt or usable model input. */
export interface S16FileCohort {
  contract: 's16-file-cohort/v1'; installationId: string; present: boolean;
  files: readonly Readonly<{ name: string; role: Role; trust: 'owning_pinned' | 'untrusted'; rowId: string | null; jobId: string | null; state: FileUpload['state'] | 'artifact_metadata' | 'unobserved'; bytes: number; sha256: string }>[];
  pending: readonly Readonly<{ id: string; state: 'uploading' | 'validating' }>[];
  parser: Readonly<{ present: boolean; configuredGeneration: string | null; container: { name: string; originalJobId: null; generation: null; settlement: 'unobserved' }; jobs: readonly string[] }>;
}
/** Trusted current composition supplies the exact runtime source and genuine retained exclusion. */
export interface S16FileCohortOptions {
  directory: string; installationId: string; lease: S16InstallationLease; source: S16LedgerSource | undefined;
  configuredGeneration: string | null; guard(): void;
}
/** All present current custody and exact absent immutable pins, without repairing either. */
export interface S16CurrentFileCustody extends Omit<S16FileCohort, 'contract'> {
  contract: 's16-current-file-custody/v1'; missing: FileExpectedPayloads['files'];
}
/** Protected current composition may authenticate a genuine covering SQL writer cut. */
export interface S16CurrentFileCustodyOptions extends S16FileCohortOptions { cut?: S16LedgerWriteCut }
/** Host-only original damaged-current observation; physical entries are not target ownership. */
export interface S16CurrentFileObservation {
  readonly value: Readonly<S16CurrentFileCustody>; readonly sha256: string; readonly sources: readonly Readonly<S16PayloadSource>[];
  readonly entries: readonly S16ByteCustodyIdentity[]; assertCurrent(): void;
}
/** Original immutable current cut and host-only payload sources; archive metadata cannot construct the live guard. */
export interface S16FileObservation {
  readonly value: Readonly<S16FileCohort>; readonly sha256: string; readonly sources: readonly Readonly<S16PayloadSource>[];
  assertCurrent(): void;
}
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function refuse(code = 's16_ops_file_custody_invalid'): never { throw new AppError(code, 409); }
const equal = (a: BigIntStats, b: BigIntStats) => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key as keyof BigIntStats] === b[key as keyof BigIntStats]);
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const item of Object.values(value)) freeze(item); Object.freeze(value); } return value; }
function encode(value: S16FileCohort | S16CurrentFileCustody): string { const text = JSON.stringify(value); if (Buffer.byteLength(text) > 4194304) refuse('s16_ops_file_bounds'); return text; }
/**
 * Observes complete known FILE/parser byte custody without constructors, replay, decoding or cleanup.
 * Original receipt-pinned files and untrusted leftovers keep distinct roles. All original attributes,
 * absences and complete byte identities must remain unchanged when the live cut is revalidated.
 */
export function captureS16FileCohort(options: S16FileCohortOptions): S16FileObservation {
  return captureFileCustody(options, false) as S16FileObservation;
}
/** Observes all present FILE/parser custody and missing current immutable pins; never initializes or writes. */
export function captureS16CurrentFileCustody(options: S16CurrentFileCustodyOptions): S16CurrentFileObservation {
  return captureFileCustody(options, true) as S16CurrentFileObservation;
}
function captureFileCustody(options: S16CurrentFileCustodyOptions, allowMissing: boolean): S16FileObservation | S16CurrentFileObservation {
  const { directory, installationId, lease, source, configuredGeneration } = options;
  identity(installationId);
  if (!isAbsolute(directory) || normalize(directory) !== directory || configuredGeneration !== null && !pinnedImagePattern.test(configuredGeneration)) refuse();
  const guard = () => { assertS16ExclusiveInstallationLease(lease, directory); if ((options.guard() as unknown) !== undefined) refuse('s16_ops_guard_invalid');
    if (allowMissing) { if (options.cut) assertS16LedgerWriteCutFor(options.cut, source ? [source] : [], { subset: true }); else if (source?.database.inTransaction) refuse('s16_ops_sources_busy'); }
  }; guard();
  const collect = () => {
    guard(); const entries = new Map<string, BigIntStats | null>(), files: S16FileCohort['files'][number][] = [], sources: S16PayloadSource[] = [], jobs: string[] = [];
    let total = 0; const sourceNames = new Set<string>();
    const entry = (path: string, directory = false, optional = false): BigIntStats | null => {
      opsPath(path); const s = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (!s) { if (!optional) return refuse(); entries.set(path, null); return null; }
      if (process.getuid?.() === undefined || s.uid !== BigInt(process.getuid!()) || s.isSymbolicLink() || (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1n) || s.mode & (directory ? 0o7077n : 0o7177n)) return refuse();
      entries.set(path, s); return s;
    };
    const names = (path: string, bound: number) => {
      const result: string[] = [], dir = opendirSync(path);
      try { for (;;) { const row = dir.readSync(); if (!row) break; if (result.length >= bound) refuse('s16_ops_file_bounds'); result.push(row.name); } } finally { dir.closeSync(); }
      return result.sort();
    };
    const bytes = (path: string, limit: number) => {
      guard(); const before = entry(path)!;
      if (before.size > BigInt(limit) || total + Number(before.size) > 4294967296 || files.length >= 20000) refuse('s16_ops_file_bounds');
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK), h = createHash('sha256'), buffer = Buffer.alloc(65536); let at = 0;
      try {
        if (!equal(before, fstatSync(fd, { bigint: true }))) refuse('s16_ops_file_changed');
        while (at < Number(before.size)) { const n = readSync(fd, buffer, 0, Math.min(buffer.length, Number(before.size) - at), at); if (!n) refuse('s16_ops_file_changed'); h.update(buffer.subarray(0, n)); at += n; }
        if (readSync(fd, buffer, 0, 1, at) !== 0 || !equal(before, fstatSync(fd, { bigint: true })) || !equal(before, lstatSync(path, { bigint: true }))) refuse('s16_ops_file_changed');
      } finally { closeSync(fd); }
      total += at; guard(); return { bytes: at, sha256: h.digest('hex') };
    };
    const add = (path: string, key: string, role: Role, rowId: string | null, jobId: string | null, state: S16FileCohort['files'][number]['state'], limit: number, expected?: { bytes: number; sha256: string }) => {
      const observed = bytes(path, limit); if (expected && (observed.bytes !== expected.bytes || observed.sha256 !== expected.sha256)) refuse('s16_ops_file_integrity_failed');
      const name = 'file_' + sha(key) + '.blob';
      if (sourceNames.has(name)) refuse(); sourceNames.add(name);
      sources.push(Object.freeze({ name, path, ...observed })); files.push(freeze({ name, role, trust: expected ? 'owning_pinned' as const : 'untrusted' as const, rowId, jobId, state, ...observed })); return observed;
    };
    const runtime = join(directory, 'runtime'), data = join(runtime, 'file-bytes'), parser = join(runtime, 'file-parser');
    const dataEntry = entry(data, true, allowMissing || !source), parserEntry = entry(parser, true, true);
    if (source && (source.name !== 'files.sqlite' || source.database.filename !== join(runtime, 'files.sqlite') || source.reader.applicationId !== 0x4a495446) || !source && (dataEntry || parserEntry || configuredGeneration !== null)) refuse();
    let pending: S16FileCohort['pending'] = [], requiresParser = configuredGeneration !== null, recordsSha256: string | null = null;
    let missing: FileExpectedPayloads['files'] = [];
    if (source) {
      const listed = dataEntry ? names(data, 20000) : [], immutable = fileExpectedPayloads(source.database, installationId, guard), pinned = new Map(immutable.files.map(row => [row.name, row]));
      const listedNames = new Set(listed);
      pending = immutable.pending;
      const rows = source.database.query<{ id: string; json: string }, []>('SELECT id,json FROM records ORDER BY id LIMIT 10001').all();
      recordsSha256 = sha(JSON.stringify(rows));
      const owned = new Map<string, { row: Record<string, unknown>; suffix: string }>();
      for (const { id, json } of rows) {
        const row = JSON.parse(json) as Record<string, unknown>; identity(id);
        if (row.kind === 'upload') {
          if (!Number.isSafeInteger(row.expectedBytes) || Number(row.expectedBytes) < 1 || Number(row.expectedBytes) > 1048576 || !Number.isSafeInteger(row.bytes) || Number(row.bytes) < 0 || Number(row.bytes) > Number(row.expectedBytes) || typeof row.expectedHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.expectedHash) || ['created', 'uploading', 'validating'].includes(String(row.state)) && row.receipt !== null) refuse();
          if (typeof row.name !== 'string') refuse(); requiresParser ||= /\.(pdf|png|jpe?g)$/i.test(row.name) || (row.receipt as { contract?: unknown } | null)?.contract === 's16-file-receipt/v2';
          if (row.state === 'validating') {
            const originals = [id + '.part', id + '.blob'].filter(name => listedNames.has(name)); if (originals.length !== 1) refuse('s16_ops_file_missing_original');
          }
        }
        for (const suffix of ['.part', '.blob', '.blob.derived']) { const name = id + suffix; if (owned.has(name)) refuse(); owned.set(name, { row, suffix }); }
      }
      for (const name of listed) {
        const original = owned.get(name); if (!original) refuse(); const { row, suffix } = original, id = row.id as string, expected = pinned.get(name), state = row.kind === 'artifact' ? 'artifact_metadata' : row.state as FileUpload['state'];
        const role: Role = expected ? row.kind === 'artifact' ? 'artifact' : suffix === '.blob' ? 'original' : 'representation' : suffix === '.part' ? 'upload_fragment' : suffix === '.blob' ? 'unpublished_original' : 'unpublished_representation';
        const observed = add(join(data, name), 'data/' + name, role, id, null, state, 1048576, expected);
        if (!expected && row.kind === 'upload' && ['uploading', 'validating'].includes(state) && suffix !== '.blob.derived' && (observed.bytes > Number(row.expectedBytes) || (state === 'validating' || suffix === '.blob') && (observed.bytes !== row.expectedBytes || observed.sha256 !== row.expectedHash))) refuse('s16_ops_file_integrity_failed');
      }
      missing = immutable.files.filter(row => !listedNames.has(row.name));
      for (const row of missing) if (entry(join(data, row.name), false, true)) refuse('s16_ops_file_changed');
      if (missing.length && !allowMissing) refuse('s16_ops_file_missing_original');
    }
    if (requiresParser && !parserEntry) refuse('s16_ops_file_parser_missing');
    if (parserEntry) for (const job of names(parser, 64)) {
      if (!/^job-[A-Za-z0-9]{1,64}$/.test(job)) refuse(); const root = join(parser, job); entry(root, true); const jobId = sha(job); jobs.push(jobId);
      for (const side of names(root, 2)) {
        if (!['in', 'out'].includes(side)) refuse(); const path = join(root, side); entry(path, true);
        for (const name of names(path, side === 'in' ? 1 : 3)) {
          const limits: Record<string, number> = side === 'in' ? { input: 1048576 } : { 'result.json': 2048, 'text.txt': 2097152, 'clean.png': 16777216, 'model.png': 16777216, 'clean.jpg': 16777216, 'model.jpg': 16777216 };
          if (!Object.hasOwn(limits, name)) refuse(); add(join(path, name), 'parser/' + job + '/' + side + '/' + name, side === 'in' ? 'parser_input' : 'parser_output', null, jobId, 'unobserved', limits[name]!);
        }
      }
    }
    const check = () => { guard(); for (const [path, before] of entries) { const after = lstatSync(path, { bigint: true, throwIfNoEntry: false }); if (before ? !after || !equal(before, after) : after) refuse('s16_ops_file_changed'); } guard(); }; check();
    const base: S16FileCohort = { contract: 's16-file-cohort/v1', installationId, present: source !== undefined, files, pending, parser: { present: parserEntry !== null, configuredGeneration, container: { name: 'jit-sanitize-' + sha(directory + '/s16-files').slice(0, 32), originalJobId: null, generation: null, settlement: 'unobserved' }, jobs } };
    const value = allowMissing ? { ...base, contract: 's16-current-file-custody/v1' as const, missing } : base;
    encode(value); return { value: freeze(value), sources: Object.freeze(sources), entries: allowMissing ? s16ByteCustodyIdentities(entries) : undefined, recordsSha256, check };
  };
  const original = collect(), sha256 = sha(encode(original.value));
  return Object.freeze({ value: original.value, sources: original.sources, sha256, ...(allowMissing ? { entries: original.entries! } : {}), assertCurrent() { original.check(); const latest = collect(); if (sha(encode(latest.value)) !== sha256 || latest.recordsSha256 !== original.recordsSha256) refuse('s16_ops_file_changed'); original.check(); } }) as S16FileObservation | S16CurrentFileObservation;
}
