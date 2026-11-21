import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, mkdirSync, readlinkSync, renameSync, symlinkSync, unlinkSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { canonical } from '../../../src/s15/conversation/validation';
import { opsSyncDirectory } from '../../../src/s14/ops-files';
import { assertS16ExclusiveInstallationLease, openS16InstallationLease, type S16InstallationLease } from '../../../src/s16/operations/installation-lease';
import { validateArtifact } from '../bun-build';
import { assertRootPath, assertRootTree, type RootPathPolicy } from '../trusted-paths';

function refuse(code = 's16_root_selector_refused'): never { throw Error(code); }
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
/** Root path state only; package compatibility, application authority and historical attempts remain separate. */
export interface S16RootSelectorValue { readonly contract: 's16-root-selector-value/v1'; readonly targetDirectory: string | null; readonly sha256: string }
/** Trusted root installation layout. Alternate prefix/ownership policy is for explicit disposable fixtures only. */
export interface S16RootSelectorOptions { prefix?: string; pathPolicy?: RootPathPolicy }
/** Canonical current-path digest only; this value never proves target package health or controller authority. */
export function s16RootSelectorValue(targetDirectory: string | null): Readonly<S16RootSelectorValue> {
  if (targetDirectory !== null && (!isAbsolute(targetDirectory) || resolve(targetDirectory) !== targetDirectory)) refuse();
  const body = { contract: 's16-root-selector-value/v1' as const, targetDirectory }; return Object.freeze({ ...body, sha256: hash(body) });
}
function releasePath(prefix: string, path: string): string {
  if (!isAbsolute(path) || resolve(path) !== path || dirname(path) !== join(prefix, 'releases') || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(basename(path))) refuse('s16_root_selector_target_invalid');
  return path;
}
/** Read-only protected-host observation; the service identity can inspect public root metadata without a root lease. */
export function inspectS16RootReleaseSelector(options: S16RootSelectorOptions = {}): Readonly<S16RootSelectorValue> {
  const prefix = options.prefix ?? '/opt/jit-s15', policy = options.pathPolicy ?? {};
  if (!isAbsolute(prefix) || resolve(prefix) !== prefix) refuse(); assertRootPath(prefix, policy);
  const path = join(prefix, 'current'), stat = lstatSync(path, { throwIfNoEntry: false }); if (!stat) return s16RootSelectorValue(null);
  if (!stat.isSymbolicLink() || stat.uid !== (policy.uid ?? 0) || stat.nlink !== 1) refuse('s16_root_selector_entry_invalid');
  return s16RootSelectorValue(releasePath(prefix, resolve(prefix, readlinkSync(path))));
}
/** An original root filesystem capability, separate from the controller identity's current-state capabilities. */
export interface S16RootReleaseSelector {
  readonly released: boolean;
  /** Acquires exclusion before any read/write; failed bootstrap never opens the controller's state. */
  acquire(): void;
  read(): Readonly<S16RootSelectorValue>;
  /** Only a trusted coordinator supplies original current-value and package pins after durable controller intent. */
  select(expectedCurrentSha256: string, targetDirectory: string, packageSha256: string, after?: (boundary: 'staged' | 'selected' | 'synced') => void): Readonly<S16RootSelectorValue>;
  /** Unknown release retains the original capability for disposal retry. No retained lease file is removed. */
  close(): void;
}

/** Returns before opening any root lease; the caller retains original resources even if acquisition/selection fails. */
export function openS16RootReleaseSelector(options: S16RootSelectorOptions = {}): S16RootReleaseSelector {
  const prefix = options.prefix ?? '/opt/jit-s15', policy = options.pathPolicy ?? {}, uid = policy.uid ?? 0;
  if (!isAbsolute(prefix) || resolve(prefix) !== prefix) refuse();
  const currentPath = join(prefix, 'current'), coordination = join(prefix, '.s16-selector');
  let bootstrap: S16InstallationLease | undefined, lease: S16InstallationLease | undefined, released = false, attempted = false, busy = false;
  let originalPrefix: ReturnType<typeof lstatSync> | undefined;
  const guard = () => {
    if (released || !lease) refuse('s16_root_selector_not_acquired');
    assertRootPath(prefix, policy); const now = lstatSync(prefix);
    if (!originalPrefix || originalPrefix.dev !== now.dev || originalPrefix.ino !== now.ino) refuse('s16_root_selector_changed');
    assertS16ExclusiveInstallationLease(lease, coordination);
  };
  const read = () => { guard(); return inspectS16RootReleaseSelector({ prefix, pathPolicy: policy }); };
  const target = (directory: string, sha256: string) => {
    releasePath(prefix, directory); if (!/^[a-f0-9]{64}$/.test(sha256)) refuse();
    assertRootTree(directory, policy); const checked = validateArtifact(directory, { runtime: true });
    if (!checked.ok || checked.manifest?.contentHash !== sha256 || checked.manifest.artifactId !== basename(directory)) refuse('s16_root_selector_package_changed');
  };
  return Object.freeze<S16RootReleaseSelector>({ get released() { return released; }, acquire() {
    if (released || attempted) refuse('s16_root_selector_already_attempted'); attempted = true;
    assertRootPath(prefix, policy); mkdirSync(prefix, { recursive: true, mode: 0o755 }); assertRootPath(prefix, policy); originalPrefix = lstatSync(prefix);
    assertRootPath(coordination, policy); if (!lstatSync(coordination, { throwIfNoEntry: false })) mkdirSync(coordination, { mode: 0o700 });
    // The private role has no operations binding and cannot substitute for a controller-state lease.
    bootstrap = openS16InstallationLease({ directory: coordination, mode: 'shared', create: true }); bootstrap.close();
    lease = openS16InstallationLease({ directory: coordination, mode: 'exclusive' }); guard();
  }, read, select(expectedCurrentSha256, targetDirectory, packageSha256, after) {
    guard(); if (busy) refuse('s16_root_selector_busy'); if (!/^[a-f0-9]{64}$/.test(expectedCurrentSha256)) refuse(); target(targetDirectory, packageSha256);
    const desired = s16RootSelectorValue(targetDirectory), before = read(); if (before.sha256 === desired.sha256) return before;
    if (before.sha256 !== expectedCurrentSha256) refuse('s16_root_selector_stale');
    busy = true; let temp: string | undefined, originalTemp: ReturnType<typeof lstatSync> | undefined;
    const ownedTemp = () => {
      guard(); if (!temp) refuse(); const now = lstatSync(temp, { throwIfNoEntry: false });
      if (!now || !originalTemp || now.dev !== originalTemp.dev || now.ino !== originalTemp.ino || now.uid !== uid || !now.isSymbolicLink() || now.nlink !== 1 || readlinkSync(temp) !== targetDirectory) refuse('s16_root_selector_staging_changed');
    };
    const boundary = (at: Parameters<NonNullable<typeof after>>[0]) => { guard(); if ((after?.(at) as unknown) !== undefined) refuse('s16_root_selector_observer_invalid'); guard(); };
    try {
      if (before.targetDirectory !== null) { temp = join(prefix, '.current.next-' + randomBytes(16).toString('hex')); symlinkSync(targetDirectory, temp); originalTemp = lstatSync(temp); opsSyncDirectory(prefix); }
      boundary('staged'); if (read().sha256 !== before.sha256) refuse('s16_root_selector_stale');
      if (temp) { ownedTemp(); renameSync(temp, currentPath); } else symlinkSync(targetDirectory, currentPath);
      boundary('selected'); opsSyncDirectory(prefix); boundary('synced'); target(targetDirectory, packageSha256);
      const actual = read(); if (actual.sha256 !== desired.sha256) refuse('s16_root_selector_readback_unknown'); return actual;
    } finally {
      try { if (temp) { guard(); if (lstatSync(temp, { throwIfNoEntry: false })) { ownedTemp(); unlinkSync(temp); opsSyncDirectory(prefix); } } }
      finally { busy = false; }
    }
  }, close() { if (released) return; if (busy) refuse('s16_root_selector_busy'); bootstrap?.close(); lease?.close(); released = true; } });
}
