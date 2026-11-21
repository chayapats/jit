import { randomUUID } from 'node:crypto';
import { lstatSync, opendirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { canonical } from '../../../src/s15/conversation/validation';
import { opsDirectory, opsRead, opsSyncDirectory, opsWrite } from '../../../src/s14/ops-files';
import { assertRootPath, type RootPathPolicy } from '../trusted-paths';
import { assertS16RootReleaseSelectorFor, type S16RootReleaseSelector } from './s16-release-selector';

/** Root-private bounded metadata only; these bytes never substitute for current-controller authority. */
export interface S16RootJobFiles {
  read(name: string): unknown | undefined;
  publish(name: string, value: unknown): void;
  replace(name: string, expected: unknown | undefined, value: unknown): void;
}
/** Opens fixed private job metadata only under the original acquired root installation capability. */
export function openS16RootJobFiles(selector: S16RootReleaseSelector, prefix: string, directory: string, policy: RootPathPolicy = {}, capacity = 64): S16RootJobFiles {
  if (resolve(directory) !== directory || !directory.startsWith(join(prefix, '.s16-selector') + '/') || !Number.isSafeInteger(capacity) || capacity < 1 || capacity > 256) throw Error('s16_root_job_scope_invalid');
  const guard = () => { assertS16RootReleaseSelectorFor(selector, prefix, policy.uid ?? 0); assertRootPath(directory, policy); };
  const entry = (path: string, dir = false) => {
    guard(); const stat = lstatSync(path, { bigint: true });
    if (stat.uid !== BigInt(policy.uid ?? 0) || (dir ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) || stat.mode & (dir ? 0o7077n : 0o7177n)) throw Error('s16_root_job_path_untrusted'); return stat;
  };
  guard(); opsDirectory(directory); entry(directory, true); opsSyncDirectory(dirname(directory));
  const pathOf = (name: string) => { if (!/^[a-z][a-z0-9-]{0,63}\.json$/.test(name)) throw Error('s16_root_job_name_invalid'); return join(directory, name); };
  const sameValue = (a: unknown | undefined, b: unknown | undefined) => a === undefined ? b === undefined : b !== undefined && canonical(a) === canonical(b);
  const read = (name: string): unknown | undefined => {
    const path = pathOf(name); guard(); if (!lstatSync(path, { throwIfNoEntry: false })) return;
    const before = entry(path); if (before.size > 65536n) throw Error('s16_root_job_bounds');
    const raw = opsRead(path, 65536).toString('utf8'), value = JSON.parse(raw), now = entry(path);
    if (before.dev !== now.dev || before.ino !== now.ino || before.ctimeNs !== now.ctimeNs || before.mtimeNs !== now.mtimeNs || before.size !== BigInt(Buffer.byteLength(raw)) || canonical(value) !== raw) throw Error('s16_root_job_metadata_changed');
    return value;
  };
  const write = (name: string, expected: unknown | undefined, value: unknown) => {
    guard(); const encoded = canonical(value); if (Buffer.byteLength(encoded) > 65536) throw Error('s16_root_job_bounds');
    if (!sameValue(read(name), expected)) throw Error('s16_root_job_metadata_changed');
    const entries = opendirSync(directory); let count = 0; try { while (entries.readSync()) if (++count > capacity) throw Error('s16_root_job_capacity'); } finally { entries.closeSync(); }
    if (count >= capacity && expected === undefined) throw Error('s16_root_job_capacity');
    const temporary = join(directory, '.publish-' + randomUUID()); opsWrite(temporary, encoded); const original = entry(temporary);
    try {
      guard(); const now = entry(temporary);
      if (now.dev !== original.dev || now.ino !== original.ino || now.mtimeNs !== original.mtimeNs || now.ctimeNs !== original.ctimeNs || !sameValue(read(name), expected)) throw Error('s16_root_job_metadata_changed');
      renameSync(temporary, pathOf(name)); opsSyncDirectory(directory); if (canonical(read(name)) !== encoded) throw Error('s16_root_job_metadata_changed');
    } finally { const now = lstatSync(temporary, { bigint: true, throwIfNoEntry: false }); if (now?.dev === original.dev && now.ino === original.ino && now.nlink === 1n && now.mtimeNs === original.mtimeNs && now.ctimeNs === original.ctimeNs) { unlinkSync(temporary); opsSyncDirectory(directory); } }
  };
  return Object.freeze<S16RootJobFiles>({ read, publish(name, value) { const old = read(name); if (old !== undefined) { if (canonical(old) !== canonical(value)) throw Error('s16_root_job_metadata_changed'); return; } write(name, undefined, value); }, replace: write });
}
