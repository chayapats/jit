import { createHash } from 'node:crypto';
import { lstatSync, type BigIntStats } from 'node:fs';
import { isAbsolute, join, normalize } from 'node:path';
import { AppError } from '../../errors';
import { opsPath } from '../../s14/ops-files';
import { identity } from '../../s15/conversation/validation';
import { readS16GithubCurrentReferences, type S16GithubCurrentReferences } from '../../s15/github/maintenance';
import { fileExpectedPayloads, type FileExpectedPayloads } from '../files/maintenance';
import { assertS16ExclusiveInstallationLease, type S16InstallationLease } from './installation-lease';
import type { S16LedgerSource } from './ledger-set';

/** Current metadata pins only. This catalog is neither a full current cohort nor activation authority. */
export interface S16CurrentPayloadReferences {
  readonly contract: 's16-current-payload-references/v1'; readonly installationId: string;
  readonly file: FileExpectedPayloads | null; readonly github: S16GithubCurrentReferences;
}
/** Protected composition supplies the actual current readers and genuine retained installation exclusion. */
export interface S16CurrentPayloadReferenceOptions {
  directory: string; installationId: string; lease: S16InstallationLease; sources: readonly S16LedgerSource[]; guard(): void;
}
/** Original current reference projection. Revalidation rereads SQL even when only a WAL changed. */
export interface S16CurrentPayloadReferenceObservation {
  readonly value: Readonly<S16CurrentPayloadReferences>; readonly sha256: string;
  assertCurrent(): void;
}
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
function refuse(code = 's16_ops_references_invalid'): never { throw new AppError(code, 409); }
const same = (a: BigIntStats, b: BigIntStats) => ['dev', 'ino', 'uid', 'mode', 'nlink', 'size', 'mtimeNs', 'ctimeNs'].every(key => a[key as keyof BigIntStats] === b[key as keyof BigIntStats]);
function encode(value: S16CurrentPayloadReferences): string {
  const text = JSON.stringify(value); if (Buffer.byteLength(text) > 8388608) refuse('s16_ops_references_bounds'); return text;
}
/**
 * Reads exact current FILE/GitHub/DATA15 references without requiring or opening their payload paths.
 * Current withdrawals and pending states remain current. Required corrupt/missing SQL refuses; this
 * does not initialize stores, inspect an archive, settle effects or permit any replacement/admission.
 */
export function captureS16CurrentPayloadReferences(options: S16CurrentPayloadReferenceOptions): S16CurrentPayloadReferenceObservation {
  const { directory, installationId, lease } = options; identity(installationId);
  if (!isAbsolute(directory) || normalize(directory) !== directory) refuse();
  const selected = (name: string) => {
    const rows = options.sources.filter(source => source.name === name); if (rows.length > 1) refuse(); return rows[0];
  };
  const file = selected('files.sqlite'), github = selected('github.sqlite'), disclosure = selected('disclosure.sqlite');
  const guard = () => {
    assertS16ExclusiveInstallationLease(lease, directory);
    if ((options.guard() as unknown) !== undefined) refuse('s16_ops_guard_invalid');
    if ([file, github, disclosure].some(source => source?.database.inTransaction)) refuse('s16_ops_sources_busy');
  }; guard();
  const collect = () => {
    guard(); const entries = new Map<string, BigIntStats | null>();
    for (const [name, source] of [['files.sqlite', file], ['github.sqlite', github], ['disclosure.sqlite', disclosure]] as const) {
      const path = join(directory, 'runtime', name); opsPath(path);
      const before = lstatSync(path, { bigint: true, throwIfNoEntry: false });
      if (!!before !== !!source) refuse('s16_ops_references_missing');
      if (before && (process.getuid?.() === undefined || before.uid !== BigInt(process.getuid!()) || !before.isFile() || before.isSymbolicLink() || before.nlink !== 1n || before.mode & 0o7177n || before.size < 512n || before.size > 1073741824n)) refuse();
      if (source && source.database.filename !== path) refuse(); entries.set(path, before ?? null);
    }
    if (file && file.reader.applicationId !== 0x4a495446) refuse();
    const value: S16CurrentPayloadReferences = Object.freeze({ contract: 's16-current-payload-references/v1', installationId,
      file: file ? fileExpectedPayloads(file.database, installationId, guard) : null,
      github: readS16GithubCurrentReferences({ directory, installationId, lease, source: github, disclosure, guard }) });
    encode(value);
    const check = () => {
      guard();
      for (const [path, before] of entries) {
        const after = lstatSync(path, { bigint: true, throwIfNoEntry: false });
        if (before ? !after || !same(before, after) : after) refuse('s16_ops_references_changed');
      } guard();
    }; check(); return { value, check };
  };
  const original = collect(), sha256 = hash(encode(original.value));
  return Object.freeze({ value: original.value, sha256, assertCurrent() {
    original.check(); const latest = collect(); if (hash(encode(latest.value)) !== sha256) refuse('s16_ops_references_changed'); original.check();
  } });
}
