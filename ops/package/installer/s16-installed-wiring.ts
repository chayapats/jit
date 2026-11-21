import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonical } from '../../../src/s15/conversation/validation';
import type { S15RuntimeConfig } from '../../../src/s15/runtime-config';
import { spawnRunner, type CommandRunner } from '../../../src/ops/supervisor';
import { validateArtifact } from '../bun-build';
import { assertRootPath, assertRootTree } from '../trusted-paths';
import { bindS16InstalledService, type S16InstalledServiceOptions } from './s16-installed-service';
import { openS16RootReleaseSelector } from './s16-release-selector';
import { openS16RootJobFiles } from './s16-root-job-files';
import { openS16RootWiringJob, type S16RootWiringJob, type S16RootWiringJobInput, type S16WiringSupervisor } from './s16-root-wiring-job';
import { readS16Wiring, s16AbsentWiring, s16WiringLayout, s16WiringSha256, validateS16WiringValue, type S16WiringValue } from './s16-wiring-value';

const digest = (value: unknown) => new Bun.CryptoHasher('sha256').update(canonical(value)).digest('hex');
function refuse(code = 's16_installed_wiring_refused'): never { throw Error(code); }
interface Locator { contract: 's16-installed-wiring-dispatch/v1'; remove: S16RootWiringJobInput; restore: S16RootWiringJobInput | null }
interface Activation { controller: boolean; keyring: boolean | null; keyringActive: boolean | null }
/** Only the fixed installed wiring is eligible; optional fake-root/account ports are explicit fixtures. */
export interface S16InstalledWiringOptions extends Omit<S16InstalledServiceOptions, 'retainedUnit'> {
  layoutRoot?: string; user?: string;
  /** The existing manager/kernel proof must stop only Jit's named working VMs, retaining disks and unknown effects. */
  stopWorkingVms(config: S15RuntimeConfig): Promise<void>;
  after?: (at: 'located' | 'removed' | 'restored') => void;
}
/** Fresh boot health is distinct from a historical root wiring receipt. */
export interface S16InstalledWiringResult { state: 'unchanged' | 'removed' | 'restored'; release: string | null; health: 'not_observed' | 'healthy' }
/** Original root resources survive an unknown close; retain and dispose the same capability. */
export interface S16InstalledWiring { readonly released: boolean; run(): Promise<Readonly<S16InstalledWiringResult>>; close(): void }

/** Installed uninstall/reinstall dispatcher; no identity/config/credential creation or state reconstruction. */
export function openS16InstalledWiring(direction: 'remove' | 'restore', bunPath: string, options: S16InstalledWiringOptions): S16InstalledWiring {
  const layout = s16WiringLayout(options.layoutRoot), policy = options.pathPolicy ?? {}, user = options.user ?? 'jit-s15', run = options.run ?? spawnRunner;
  if (!['remove', 'restore'].includes(direction) || bunPath !== join(layout.prefix, 'bin/bun') || user !== 'jit-s15' && (!options.layoutRoot || policy.uid === undefined)) refuse();
  const selector = openS16RootReleaseSelector({ prefix: layout.prefix, pathPolicy: policy }); let released = false, busy = false, attempted = false, job: S16RootWiringJob | undefined;
  const guard = () => { if (released) refuse('s16_installed_wiring_closed'); selector.read(); };
  const after = (at: Parameters<NonNullable<S16InstalledWiringOptions['after']>>[0]) => { guard(); if ((options.after?.(at) as unknown) !== undefined) refuse(); guard(); };
  const serviceInput = { configPath: layout.config, state: layout.state, unitPath: layout.files.controller, unit: 'jit-s15.service', prefix: layout.prefix, home: layout.home, user, bunPath };
  return Object.freeze<S16InstalledWiring>({ get released() { return released; }, close() { if (released) return; if (busy) refuse('s16_installed_wiring_busy'); job?.close(); selector.close(); released = true; }, async run() {
    if (released || busy || attempted) refuse('s16_installed_wiring_already_attempted'); attempted = true; busy = true;
    try {
      selector.acquire(); const dispatch = openS16RootJobFiles(selector, layout.prefix, join(layout.prefix, '.s16-selector/wiring-dispatch'), policy);
      let locator = dispatch.read('current.json') as Locator | undefined;
      if (locator !== undefined && (!locator || Object.keys(locator).sort().join(',') !== 'contract,remove,restore' || locator.contract !== 's16-installed-wiring-dispatch/v1' || locator.remove?.direction !== 'remove' || locator.remove.originalRemovalRequestId !== null || locator.restore !== null && (locator.restore.direction !== 'restore' || locator.restore.originalRemovalRequestId !== locator.remove.requestId))) refuse('s16_installed_wiring_locator_changed');
      if (!locator && direction === 'restore') return Object.freeze({ state: 'unchanged', release: selector.read().targetDirectory, health: 'not_observed' });
      const jobFiles = (requestId: string) => openS16RootJobFiles(selector, layout.prefix, join(layout.prefix, '.s16-selector/wiring-jobs', digest(requestId)), policy);
      const retained = (command: S16RootWiringJobInput): { wiring: S16WiringValue } | undefined => {
        const ownPath = join(layout.prefix, '.s16-selector/wiring-jobs', digest(command.requestId));
        let snapshot = lstatSync(ownPath, { throwIfNoEntry: false }) ? jobFiles(command.requestId).read('snapshot.json') as { wiring: S16WiringValue } | undefined : undefined;
        if (snapshot === undefined && command.direction === 'restore') {
          const originalPath = join(layout.prefix, '.s16-selector/wiring-jobs', digest(command.originalRemovalRequestId)); if (!lstatSync(originalPath, { throwIfNoEntry: false })?.isDirectory()) refuse('s16_installed_wiring_original_missing');
          snapshot = jobFiles(command.originalRemovalRequestId!).read('snapshot.json') as typeof snapshot;
        }
        if (snapshot !== undefined) { if (!snapshot) refuse('s16_installed_wiring_snapshot_changed'); validateS16WiringValue(snapshot.wiring); }
        return snapshot;
      };
      const binding = async (command?: S16RootWiringJobInput) => {
        const snapshot = command ? retained(command) : undefined;
        let bytes: Buffer;
        if (snapshot) { const unit = snapshot.wiring.files.controller; if (!unit) refuse('s16_installed_wiring_original_unit_missing'); bytes = Buffer.from(unit.bytes, 'base64'); }
        else { assertRootPath(layout.files.controller, policy); const stat = lstatSync(layout.files.controller); if (!stat.isFile() || stat.nlink !== 1 || stat.size > 8192) refuse('s16_installed_wiring_original_unit_missing'); bytes = readFileSync(layout.files.controller); }
        const cap = await bindS16InstalledService(serviceInput, { ...options, retainedUnit: { bytes, selector } });
        if (command && canonical(command.service) !== canonical({ user: cap.identity.user, uid: cap.identity.uid, gid: cap.identity.gid, home: cap.identity.home })) refuse('s16_installed_wiring_original_identity_changed');
        return cap;
      };
      const execute = async (command: S16RootWiringJobInput) => {
        const cap = await binding(command), files = () => {
          if (!lstatSync(join(layout.prefix, '.s16-selector/wiring-jobs', digest(command.requestId)), { throwIfNoEntry: false })?.isDirectory()) refuse('s16_installed_wiring_original_missing');
          return jobFiles(command.requestId);
        };
        const call = async (argv: string[], accepted = [0]) => {
          await cap.assertRetained(); const result = await run(argv, { cwd: '/', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }, timeoutMs: 120000 });
          if (!accepted.includes(result.exitCode) || result.timedOut || Buffer.byteLength(result.stdout) >= 65536) refuse('s16_installed_wiring_manager_unknown'); await cap.assertRetained(); return result.stdout.trim();
        };
        const asUser = (args: string[]) => ['/usr/sbin/runuser', '-u', user, '--', '/usr/bin/env', '-i', `HOME=${layout.home}`, `XDG_RUNTIME_DIR=/run/user/${cap.identity.uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${cap.identity.uid}/bus`, 'PATH=/usr/bin:/bin', '/usr/bin/systemctl', '--user', ...args];
        const enabled = async (keyring: boolean) => { const value = await call(keyring ? asUser(['is-enabled', 'gnome-keyring-daemon.service']) : ['/usr/bin/systemctl', 'is-enabled', 'jit-s15.service'], [0, 1]); if (!['enabled', 'disabled'].includes(value)) refuse('s16_installed_wiring_activation_unknown'); return value === 'enabled'; };
        const validateActivation = (value: Activation | undefined): Activation => {
          if (!value || Object.keys(value).sort().join(',') !== 'controller,keyring,keyringActive' || typeof value.controller !== 'boolean' || value.keyring !== null && typeof value.keyring !== 'boolean' || value.keyringActive !== null && typeof value.keyringActive !== 'boolean' || (value.keyring === null) !== (value.keyringActive === null)) refuse('s16_installed_wiring_activation_changed'); return value;
        };
        const supervisor: S16WiringSupervisor = {
          assertRetained: () => cap.assertRetained(), stop: () => cap.stopRetained(), assertStopped: () => cap.assertStoppedRetained(), stopWorkingVms: () => options.stopWorkingVms(cap.config),
          async removeActivation() {
            const old = files().read('activation.json') as Activation | undefined;
            let original = old;
            if (original === undefined) {
              const hasKeyring = readS16Wiring(layout, cap.identity.uid, policy).files.keyring !== null;
              const keyringActive = hasKeyring ? await call(asUser(['is-active', 'gnome-keyring-daemon.service']), [0, 3]) : null;
              if (keyringActive !== null && !['active', 'inactive', 'failed'].includes(keyringActive)) refuse('s16_installed_wiring_activation_unknown');
              original = { controller: await enabled(false), keyring: hasKeyring ? await enabled(true) : null, keyringActive: keyringActive === null ? null : keyringActive === 'active' }; files().publish('activation.json', original);
            }
            validateActivation(original);
            const done = files().read('deactivated.json');
            // Older completed jobs disabled local keyring enablement. Preserve
            // their original receipt; new jobs leave both local/global links alone.
            if (done !== undefined && canonical(done) === canonical({ activationSha256: digest(original), state: 'disabled' })) return;
            const stopped = { activationSha256: digest(original), state: 'controller_disabled_keyring_stopped' };
            if (done !== undefined && canonical(done) !== canonical(stopped)) refuse('s16_installed_wiring_activation_changed');
            if (await enabled(false)) await call(['/usr/bin/systemctl', 'disable', 'jit-s15.service']);
            if (await enabled(false)) refuse('s16_installed_wiring_activation_unknown');
            if (original.keyring !== null) {
              if (await enabled(true) !== original.keyring) refuse('s16_installed_wiring_activation_changed');
              await call(asUser(['stop', 'gnome-keyring-daemon.service']));
              if (await enabled(true) !== original.keyring) refuse('s16_installed_wiring_activation_changed');
              const active = await call(asUser(['is-active', 'gnome-keyring-daemon.service']), [0, 3]); if (!['inactive', 'failed'].includes(active)) refuse('s16_installed_wiring_activation_unknown');
            }
            files().publish('deactivated.json', stopped);
          },
          async reload() { await call(['/usr/bin/systemctl', 'daemon-reload']); },
          async restoreActivation() {
            const original = validateActivation(jobFiles(command.originalRemovalRequestId!).read('activation.json') as Activation | undefined);
            if (await enabled(false) !== original.controller) await call(['/usr/bin/systemctl', original.controller ? 'enable' : 'disable', 'jit-s15.service']);
            if (await enabled(false) !== original.controller) refuse('s16_installed_wiring_activation_unknown');
            if (original.keyring !== null) {
              await call(asUser(['daemon-reload']));
              const old = jobFiles(command.originalRemovalRequestId!).read('deactivated.json');
              const legacy = canonical(old) === canonical({ activationSha256: digest(original), state: 'disabled' });
              if (!legacy && canonical(old) !== canonical({ activationSha256: digest(original), state: 'controller_disabled_keyring_stopped' })) refuse('s16_installed_wiring_activation_changed');
              if (legacy && await enabled(true) !== original.keyring) await call(asUser([original.keyring ? 'enable' : 'disable', 'gnome-keyring-daemon.service']));
              if (await enabled(true) !== original.keyring) refuse('s16_installed_wiring_activation_unknown');
              await call(asUser([original.keyringActive ? 'start' : 'stop', 'gnome-keyring-daemon.service']));
              const active = await call(asUser(['is-active', 'gnome-keyring-daemon.service']), [0, 3]); if (original.keyringActive ? active !== 'active' : !['inactive', 'failed'].includes(active)) refuse('s16_installed_wiring_activation_unknown');
            }
          },
        };
        job = openS16RootWiringJob(command, { supervisor, run, pathPolicy: policy, layoutRoot: layout.root, selector });
        const result = await job.run(); job.close(); job = undefined; return result;
      };
      if (direction === 'remove') {
        if (locator?.restore) await execute(locator.restore);
        if (!locator || locator.restore) {
          const cap = await binding(), current = selector.read().targetDirectory;
          if (!current || !lstatSync(join(layout.state, 'operations/control.json'), { throwIfNoEntry: false })?.isFile()) refuse('s16_installed_wiring_adoption_required');
          assertRootTree(current, policy); const checked = validateArtifact(current, { runtime: true });
          if (!checked.ok || checked.manifest?.bunVersion !== Bun.version || !existsSync(join(current, 'ops/package/installer/s16-wiring-maintenance.ts'))) refuse('s16_installed_wiring_upgrade_first');
          const remove: S16RootWiringJobInput = { requestId: 'installed_remove_' + randomUUID().replaceAll('-', ''), direction: 'remove', originalRemovalRequestId: null, bunPath, service: { user, uid: cap.identity.uid, gid: cap.identity.gid, home: layout.home } };
          const next: Locator = { contract: 's16-installed-wiring-dispatch/v1', remove, restore: null }; dispatch.replace('current.json', locator, next); locator = next; after('located');
        }
        await execute(locator.remove); after('removed');
        const snapshot = retained(locator.remove)!;
        if (s16WiringSha256(readS16Wiring(layout, locator.remove.service.uid, policy)) !== s16WiringSha256(s16AbsentWiring(snapshot.wiring.files.keyring))) refuse('s16_installed_wiring_removed_value_changed');
        return Object.freeze({ state: 'removed', release: selector.read().targetDirectory, health: 'not_observed' });
      }
      await execute(locator!.remove);
      if (!locator!.restore) {
        const restore: S16RootWiringJobInput = { ...locator!.remove, requestId: 'installed_restore_' + randomUUID().replaceAll('-', ''), direction: 'restore', originalRemovalRequestId: locator!.remove.requestId };
        const next: Locator = { ...locator!, restore }; dispatch.replace('current.json', locator, next); locator = next; after('located');
      }
      await execute(locator!.restore!); after('restored');
      const cap = await binding(locator!.restore!);
      if (!await cap.healthy()) { await cap.assertStopped(); await cap.start(); if (!await cap.healthy()) { await cap.stopRetained(); refuse('s16_installed_wiring_reinstall_health_failed'); } }
      return Object.freeze({ state: 'restored', release: selector.read().targetDirectory, health: 'healthy' });
    } finally { busy = false; }
  } });
}
