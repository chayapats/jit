import { randomUUID } from 'node:crypto';
import { cpSync, lstatSync, renameSync, rmSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { RELEASE_CONTRACT } from 'schway/host';
import { canonical } from '../../../src/s15/conversation/validation';
import { opsRead, opsSyncDirectory, opsWrite } from '../../../src/s14/ops-files';
import { spawnRunner } from '../../../src/ops/supervisor';
import { artifactContentHash, buildPackage, readDependencyRecord, validateArtifact, type BuildManifest } from '../bun-build';
import { assertRootPath, assertRootTree, type RootPathPolicy } from '../trusted-paths';
import { freezeInstallerArtifact, giveInstallerStaging } from './trusted-paths';
import { bindS16InstalledService, type S16InstalledServiceInput, type S16InstalledServiceOptions } from './s16-installed-service';
import { openS16RootReleaseSelector } from './s16-release-selector';
import { openS16ReleaseJob, type S16ReleaseJob, type S16ReleaseJobInput, type S16ReleaseJobResult } from './s16-release-job';

function refuse(code = 's16_installed_upgrade_refused'): never { throw Error(code); }
const digest = (value: unknown) => new Bun.CryptoHasher('sha256').update(canonical(value)).digest('hex');
/** Protected original installed layout plus an explicit trusted source/artifact. */
export interface S16InstalledUpgradeInput { installation: S16InstalledServiceInput; source: string }
/** Disposable fixture ports only; production uses root ownership, actual identities/systemd and loopback health. */
export interface S16InstalledUpgradeOptions extends S16InstalledServiceOptions { after?: (boundary: 'located' | 'completed') => void }
/** No-op returns no new operation; fallback reports the healthy prior executable over current data. */
export interface S16InstalledUpgradeResult { release: string; outcome: 'unchanged' | S16ReleaseJobResult['outcome']; job: Readonly<S16ReleaseJobResult> | null }
/** Original root capability is retained on failure until the same owner disposes it. */
export interface S16InstalledUpgrade { readonly released: boolean; run(): Promise<Readonly<S16InstalledUpgradeResult>>; close(): void }
interface Locator { contract: 's16-installed-upgrade/v1'; input: S16ReleaseJobInput; terminal: boolean }

/** A code comparison for raw-source reruns only, never a package custody/selection authority. */
function codeIdentity(path: string, manifest: BuildManifest): string {
  return artifactContentHash(path, { ...manifest, artifactId: 'raw-source-comparison', builtAt: 'raw-source-comparison' });
}

/**
 * Routes an adopted installation through its original guarded job. Staging and
 * locator publication share genuine root exclusion; config, accounts, unit bytes,
 * owner credentials, working VMs and current composition are never rewritten.
 */
export function openS16InstalledUpgrade(input: S16InstalledUpgradeInput, options: S16InstalledUpgradeOptions = {}): S16InstalledUpgrade {
  const layout = Object.freeze({ ...input.installation }), source = resolve(input.source), policy: RootPathPolicy = options.pathPolicy ?? {}, run = options.run ?? spawnRunner;
  if (layout.bunPath !== join(layout.prefix, 'bin/bun')) refuse();
  const selector = openS16RootReleaseSelector({ prefix: layout.prefix, pathPolicy: policy }), locatorPath = join(layout.prefix, '.s16-selector/installer.json');
  let released = false, busy = false, attempted = false, job: S16ReleaseJob | undefined;
  const guard = () => { if (released) refuse('s16_installed_upgrade_closed'); selector.read(); };
  const readLocator = (): Locator | undefined => {
    guard(); assertRootPath(locatorPath, policy); const stat = lstatSync(locatorPath, { bigint: true, throwIfNoEntry: false }); if (!stat) return;
    if (!stat.isFile() || stat.nlink !== 1n || stat.size > 65536n || stat.mode & 0o7177n) refuse('s16_installed_upgrade_locator_changed');
    const raw = opsRead(locatorPath, 65536).toString('utf8'), value = JSON.parse(raw) as Locator, after = lstatSync(locatorPath, { bigint: true });
    if (stat.dev !== after.dev || stat.ino !== after.ino || stat.ctimeNs !== after.ctimeNs || stat.mtimeNs !== after.mtimeNs || stat.size !== BigInt(Buffer.byteLength(raw)) || canonical(value) !== raw ||
      Object.keys(value).sort().join(',') !== 'contract,input,terminal' || value.contract !== 's16-installed-upgrade/v1' || typeof value.terminal !== 'boolean') refuse('s16_installed_upgrade_locator_changed');
    return value;
  };
  const publish = (value: Locator, expected: Locator | undefined) => {
    if (canonical(readLocator() ?? null) !== canonical(expected ?? null)) refuse('s16_installed_upgrade_locator_changed');
    const temp = locatorPath + '.next-' + randomUUID(), encoded = canonical(value); if (Buffer.byteLength(encoded) > 65536) refuse();
    opsWrite(temp, encoded); const original = lstatSync(temp, { bigint: true });
    try {
      guard(); assertRootPath(temp, policy);
      if (canonical(readLocator() ?? null) !== canonical(expected ?? null)) refuse('s16_installed_upgrade_locator_changed');
      renameSync(temp, locatorPath); opsSyncDirectory(dirname(locatorPath)); if (canonical(readLocator()) !== encoded) refuse('s16_installed_upgrade_locator_changed');
    } finally { const now = lstatSync(temp, { bigint: true, throwIfNoEntry: false }); if (now?.dev === original.dev && now.ino === original.ino && now.nlink === 1n) unlinkSync(temp); }
  };
  const qualify = (path: string) => {
    assertRootTree(path, policy); const checked = validateArtifact(path, { runtime: true });
    if (!checked.ok || !checked.manifest || checked.manifest.artifactId !== basename(path) || checked.manifest.bunVersion !== Bun.version || checked.manifest.engineContract !== RELEASE_CONTRACT) refuse('s16_installed_upgrade_package_unqualified');
    return checked.manifest;
  };
  return Object.freeze({ get released() { return released; }, close() {
    if (released) return; if (busy) refuse('s16_installed_upgrade_busy'); job?.close(); selector.close(); released = true;
  }, async run() {
    if (released || busy || attempted) refuse('s16_installed_upgrade_already_attempted'); attempted = true; busy = true;
    let staging: string | undefined, frozenContainer: string | undefined;
    const owned: { path: string; dev: number; ino: number }[] = [];
    try {
      selector.acquire();
      const service = await bindS16InstalledService(layout, options);
      // Routing by presence never establishes adoption. The actual sealed helper
      // validates the independent binding and all owning current stores.
      const control = lstatSync(join(layout.state, 'operations/control.json'), { throwIfNoEntry: false });
      if (!control?.isFile() || control.isSymbolicLink()) refuse('s16_installed_upgrade_adoption_required');
      const execute = async (command: S16ReleaseJobInput) => {
        if (command.selection.prefix !== layout.prefix || command.selection.configPath !== layout.configPath || command.selection.configurationSha256 !== digest(service.config) ||
          canonical(command.service) !== canonical({ user: service.identity.user, uid: service.identity.uid, home: service.identity.home }) || command.bunPath !== layout.bunPath) refuse('s16_installed_upgrade_original_binding_changed');
        await service.assertCurrent(); job = openS16ReleaseJob(command, { service, run, pathPolicy: policy, selector });
        const result = await job.run(); job.close(); job = undefined; await service.assertCurrent(); return result;
      };
      let locator = readLocator();
      if (locator) {
        const previous = await execute(locator.input);
        if (!locator.terminal) {
          const next: Locator = { ...locator, terminal: true }; publish(next, locator); locator = next;
          // An interrupted failed trial must report its original outcome first.
          if (previous.outcome === 'fallback_healthy') return Object.freeze({ release: locator.input.selection.sourceDirectory, outcome: previous.outcome, job: previous });
        }
      }
      await service.assertCurrent();
      const current = selector.read().targetDirectory; if (!current) refuse('s16_installed_upgrade_current_missing'); const prior = qualify(current);
      assertRootTree(source, policy);
      staging = join(layout.prefix, '.s16-install-staging-' + randomUUID());
      const explicitArtifact = lstatSync(join(source, 'manifest.json'), { throwIfNoEntry: false }) !== undefined;
      if (explicitArtifact) cpSync(source, staging, { recursive: true });
      else buildPackage({ srcDir: source, outDir: staging, engineContract: RELEASE_CONTRACT, engineRevision: null });
      const staged = lstatSync(staging); owned.push({ path: staging, dev: staged.dev, ino: staged.ino });
      const checked = validateArtifact(staging);
      if (!checked.ok || !checked.manifest) refuse('s16_installed_upgrade_package_unqualified');
      if (explicitArtifact ? prior.contentHash === checked.manifest.contentHash : codeIdentity(current, prior) === codeIdentity(staging, checked.manifest)) {
        // No selector or controller mutation. This is not a fresh health receipt.
        return Object.freeze({ release: current, outcome: 'unchanged' as const, job: null });
      }
      const dependenciesReady = validateArtifact(staging, { runtime: true }).ok;
      if (!dependenciesReady) {
        if (policy.uid !== undefined) refuse('s16_installed_upgrade_fixture_dependencies_required');
        giveInstallerStaging(staging, service.identity.uid, service.identity.gid);
        const installed = await run(['/usr/sbin/runuser', '-u', service.identity.user, '--', '/usr/bin/env', '-i', `HOME=${service.identity.home}`, `XDG_RUNTIME_DIR=/run/user/${service.identity.uid}`, 'PATH=/usr/bin:/bin', layout.bunPath, join(staging, 'ops/package/bun-build.ts'), 'install-deps', staging], { cwd: service.identity.home, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }, timeoutMs: 600000 });
        if (installed.exitCode !== 0 || installed.timedOut) refuse('s16_installed_upgrade_dependencies_unknown');
      }
      const frozen = freezeInstallerArtifact(staging, join(layout.prefix, 'releases'), checked.manifest, policy); frozenContainer = frozen.container;
      const container = lstatSync(frozenContainer); owned.push({ path: frozenContainer, dev: container.dev, ino: container.ino });
      const priorDeps = readDependencyRecord(current), nextDeps = readDependencyRecord(frozen.artifact), next = checked.manifest;
      if (!priorDeps || !nextDeps || next.bunVersion !== Bun.version || next.engineContract !== RELEASE_CONTRACT || prior.engineContract !== next.engineContract || prior.engineRevision !== next.engineRevision || prior.lockHash !== next.lockHash || priorDeps.dependencyHash !== nextDeps.dependencyHash || priorDeps.dependencyFiles !== nextDeps.dependencyFiles) refuse('s16_installed_upgrade_incompatible_runtime');
      const target = join(layout.prefix, 'releases', checked.manifest.artifactId);
      assertRootPath(target, policy);
      if (lstatSync(target, { throwIfNoEntry: false })) { if (qualify(target).contentHash !== checked.manifest.contentHash) refuse('s16_installed_upgrade_package_changed'); }
      else { renameSync(frozen.artifact, target); opsSyncDirectory(dirname(target)); }
      if (qualify(target).contentHash !== next.contentHash) refuse('s16_installed_upgrade_package_changed');
      const command: S16ReleaseJobInput = { selection: { requestId: 'installed_upgrade_' + randomUUID().replaceAll('-', ''), prefix: layout.prefix, configPath: layout.configPath, configurationSha256: digest(service.config),
        operatorSha256: next.contentHash, sourceDirectory: current, sourceSha256: prior.contentHash, targetDirectory: target, targetSha256: next.contentHash }, operatorDirectory: target, bunPath: layout.bunPath,
        service: { user: service.identity.user, uid: service.identity.uid, home: service.identity.home } };
      const located: Locator = { contract: 's16-installed-upgrade/v1', input: command, terminal: false }; publish(located, locator); locator = located;
      guard(); if ((options.after?.('located') as unknown) !== undefined) refuse(); guard();
      const result = await execute(command); publish({ ...locator, terminal: true }, locator);
      guard(); if ((options.after?.('completed') as unknown) !== undefined) refuse(); guard();
      return Object.freeze({ release: result.outcome === 'selected_healthy' ? target : current, outcome: result.outcome, job: result });
    } finally {
      try {
        // Unknown/substituted custody is retained, never deleted by a reused name.
        for (const original of owned.reverse()) {
          guard(); const now = lstatSync(original.path, { throwIfNoEntry: false });
          if (now && now.isDirectory() && now.dev === original.dev && now.ino === original.ino) rmSync(original.path, { recursive: true });
        }
      } finally { busy = false; }
    }
  } });
}
