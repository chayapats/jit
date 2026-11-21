import { createHash } from 'node:crypto';
import { lstatSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { canonical } from '../../../src/s15/conversation/validation';
import type { S16ControlMaintenance } from '../../../src/s16/operations/control-maintenance';
import type { S16LedgerWriteCut } from '../../../src/s16/operations/ledger-write-cut';
import type { S16PointPackage } from '../../../src/s16/operations/point-files';
import type { S16NativeNamespace } from '../../../src/s16/operations/native-namespace';
import { validateArtifact } from '../bun-build';
import { assertRootTree, type RootPathPolicy } from '../trusted-paths';

const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const sha = (value: string) => /^[a-f0-9]{64}$/.test(value);
function refuse(code = 's16_package_probe_refused'): never { throw Error(code); }
/** Protected original operator pins. No ordinary client, model or archive chooses these paths/hashes. */
export interface S16PackageProbeInput {
  targetDirectory: string; packageSha256: string; configPath: string; configurationSha256: string;
}
/** Private metadata observation only; conclusive disposal is required before an operator consumes it. */
export interface S16PackageProbeObservation {
  contract: 's16-package-current-readers/v1'; state: 'readable'; configurationSha256: string; ownerIdentitySha256: string;
  package: Readonly<S16PointPackage>; controlSha256: string;
  sql: readonly { name: string; applicationId: number; format: number; logicalSha256: string }[];
  custody: { fileSha256: string; githubSha256: string; externalSha256: string; helperSha256: string; nativeNamespaceSha256: string };
  native: 'namespace_metadata_only'; helpers: 'current_metadata_not_physical_settlement';
}
/** Original target resources remain available for same-capability disposal after any failed observation/close. */
export interface S16PackageReaderProbe { readonly released: boolean; observe(): Promise<Readonly<S16PackageProbeObservation>>; close(): void }
/** Only trusted fixture composition may supply a fake-root policy; the CLI uses the production root-owned policy. */
export interface S16PackageProbeOptions { pathPolicy?: RootPathPolicy }

/** Bounded per-row metadata encoding preserves small-set hashes without command-array limits on native roots. */
export function s16PackageNativeNamespaceSha256(namespace: Pick<S16NativeNamespace, 'roots' | 'pending' | 'untracked'>): string {
  const fields = ['pending', 'roots', 'untracked'] as const;
  if (fields.some(field => !Array.isArray(namespace[field]) || namespace[field].length > 20000)) refuse('s16_package_probe_namespace_bounds');
  const encoded = '{' + fields.map(field => JSON.stringify(field) + ':[' + namespace[field].map(row => canonical(row)).join(',') + ']').join(',') + '}';
  if (Buffer.byteLength(encoded) > 4194304) refuse('s16_package_probe_namespace_bounds'); return hash(encoded);
}

/**
 * Verifies and loads the actual target package's readers, then returns before opening current sources.
 * This capability grants no selector write, gate clearance, migration or service/client acceptance.
 */
export async function openS16PackageReaderProbe(input: S16PackageProbeInput, options: S16PackageProbeOptions = {}): Promise<S16PackageReaderProbe> {
  if (!sha(input.packageSha256) || !sha(input.configurationSha256) || [input.targetDirectory, input.configPath].some(path => !isAbsolute(path) || path !== resolve(path) || path.length > 4096)) refuse();
  const verified = () => {
    assertRootTree(input.targetDirectory, options.pathPolicy);
    const checked = validateArtifact(input.targetDirectory, { runtime: true });
    if (!checked.ok || checked.manifest?.contentHash !== input.packageSha256 || checked.manifest.bunVersion !== Bun.version) refuse('s16_package_probe_artifact_changed');
  };
  verified();
  // Each module resolves its own package and genuine private capability maps. No target API is emulated.
  const load = (path: string) => import(pathToFileURL(join(input.targetDirectory, path)).href);
  const configModule = await load('src/s15/runtime-config.ts') as typeof import('../../../src/s15/runtime-config');
  const contextModule = await load('src/s16/operations/control-maintenance.ts') as typeof import('../../../src/s16/operations/control-maintenance');
  const stateModule = await load('src/s16/operations/operations-state.ts') as typeof import('../../../src/s16/operations/operations-state');
  const packageModule = await load('src/s16/operations/package-custody.ts') as typeof import('../../../src/s16/operations/package-custody');
  if (typeof configModule.readS15RuntimeConfig !== 'function' || typeof contextModule.openS16ControlMaintenance !== 'function' || typeof stateModule.readS16OperationsFence !== 'function' || typeof stateModule.canonicalS16OperationsControl !== 'function' || typeof packageModule.inspectS16ExecutingPackage !== 'function') refuse('s16_package_probe_reader_unavailable');
  verified();
  let context: S16ControlMaintenance | undefined, cut: S16LedgerWriteCut | undefined, released = false, busy = false, attempted = false;
  const releaseCut = () => { cut?.close(); };
  const guard = () => { if (released) refuse('s16_package_probe_closed'); context?.assertCurrent(); };
  return Object.freeze<S16PackageReaderProbe>({ get released() { return released; }, close() {
    if (released) return; if (busy) refuse('s16_package_probe_busy');
    releaseCut(); context?.close(); released = true;
  }, async observe() {
    guard(); if (busy || attempted) refuse('s16_package_probe_already_observed'); busy = true; attempted = true;
    try {
      verified(); const config = configModule.readS15RuntimeConfig(input.configPath);
      if (hash(canonical(config)) !== input.configurationSha256) refuse('s16_package_probe_configuration_changed');
      // A reader probe never initializes an unadopted installation or creates its first operations journal.
      if (!lstatSync(join(config.directory, 'operations/control.json'), { throwIfNoEntry: false })?.isFile()) refuse('s16_package_probe_adoption_required');
      const fencePath = join(config.directory, 'owner/owner.sqlite.ops/fence.json');
      context = contextModule.openS16ControlMaintenance(config, lstatSync(fencePath, { throwIfNoEntry: false }) ? { operationFence: stateModule.readS16OperationsFence(config.directory) } : {});
      if (typeof context.currentLedgerCut !== 'function' || typeof context.fileCustody !== 'function' || typeof context.githubArtifacts !== 'function' || typeof context.externalCustody !== 'function' || typeof context.helperCustody !== 'function' || typeof context.nativeNamespace !== 'function') refuse('s16_package_probe_reader_unavailable');
      const current = context, journal = current.operations(), controlSha256 = hash(stateModule.canonicalS16OperationsControl(journal.read())), binary = packageModule.inspectS16ExecutingPackage(current.sources);
      if (binary.contentHash !== input.packageSha256) refuse('s16_package_probe_artifact_changed');
      const files = current.fileCustody(), github = current.githubArtifacts(), external = current.externalCustody(), native = current.nativeNamespace();
      const namespaceSha256 = s16PackageNativeNamespaceSha256(native);
      const helpers = await current.helperCustody(); guard();
      const captureSql = () => {
        guard(); if (cut && !cut.released) refuse('s16_ops_source_release_unknown'); const held = current.currentLedgerCut(); cut = held;
        try {
          files.assertCurrent(); github.assertCurrent(); native.assertCurrent();
          if (!current.sources.length || current.sources.length > 256) refuse('s16_package_probe_source_bounds');
          return current.sources.map(source => {
            const applicationId = source.database.query<{ application_id: number }, []>('PRAGMA application_id').get()?.application_id;
            const format = source.database.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version;
            if (applicationId !== source.reader.applicationId || format === undefined || !source.reader.formats.includes(format)) refuse('s16_package_probe_reader_unsupported');
            return { name: source.name, applicationId, format, logicalSha256: hash(held.serialize(source.name)) };
          }).sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
        } finally { releaseCut(); }
      };
      const sql = captureSql(); external.assertCurrent(); await helpers.assertCurrent(); external.assertCurrent(); guard();
      if (canonical(captureSql()) !== canonical(sql) || hash(stateModule.canonicalS16OperationsControl(journal.read())) !== controlSha256 || canonical(packageModule.inspectS16ExecutingPackage(current.sources)) !== canonical(binary)) refuse('s16_package_probe_current_changed');
      files.assertCurrent(); github.assertCurrent(); external.assertCurrent(); native.assertCurrent(); verified(); guard();
      return Object.freeze({ contract: 's16-package-current-readers/v1', state: 'readable', configurationSha256: input.configurationSha256, ownerIdentitySha256: hash(current.ownerIdentity), package: binary, controlSha256,
        sql: Object.freeze(sql.map(row => Object.freeze(row))), custody: Object.freeze({ fileSha256: files.sha256, githubSha256: github.sha256, externalSha256: external.sha256, helperSha256: helpers.sha256, nativeNamespaceSha256: namespaceSha256 }),
        native: 'namespace_metadata_only', helpers: 'current_metadata_not_physical_settlement' });
    } finally { busy = false; }
  } });
}

if (import.meta.main) {
  let probe: S16PackageReaderProbe | undefined;
  try {
    const args = process.argv.slice(2), names = ['--target', '--package-sha256', '--config', '--configuration-sha256'];
    if (args.length !== 8 || names.some((name, at) => args[at * 2] !== name)) refuse();
    probe = await openS16PackageReaderProbe({ targetDirectory: args[1]!, packageSha256: args[3]!, configPath: args[5]!, configurationSha256: args[7]! });
    const observation = await probe.observe(); probe.close(); console.log(JSON.stringify(observation));
  } catch { try { probe?.close(); } catch { /* Original gate remains; unknown resources are never certified released. */ } console.error('s16_package_probe_refused'); process.exitCode = 1; }
}
