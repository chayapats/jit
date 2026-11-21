import { randomUUID } from 'node:crypto';
import { chmodSync, chownSync, existsSync, lstatSync, mkdirSync, opendirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { RELEASE_CONTRACT } from 'schway/host';
import { canonical } from '../../../src/s15/conversation/validation';
import { readS15RuntimeConfig } from '../../../src/s15/runtime-config';
import { opsSyncDirectory } from '../../../src/s14/ops-files';
import { spawnRunner, type CommandRunner } from '../../../src/ops/supervisor';
import { assertRootPath, assertRootTree, type RootPathPolicy } from '../trusted-paths';
import { validateArtifact } from '../bun-build';
import { openS16RootReleaseSelector, s16RootSelectorValue } from './s16-release-selector';
import { openS16RootJobFiles } from './s16-root-job-files';
import { bindS16InstalledService, type S16InstalledService, type S16InstalledServiceOptions } from './s16-installed-service';
import { readS16Wiring, s16AbsentWiring, s16WiringLayout, s16WiringSha256, validateS16WiringValue, type S16WiringValue } from './s16-wiring-value';

const digest = (value: unknown) => new Bun.CryptoHasher('sha256').update(canonical(value)).digest('hex');
function refuse(code = 's16_first_setup_refused'): never { throw Error(code); }
/** Trusted first-host provisioning output. Generated root units are not supplied by an ordinary client/archive. */
export interface S16FirstSetupInput {
  contract: 's16-first-selected-setup/v1'; release: string; packageSha256: string; configurationSha256: string; rawConfigurationSha256: string;
  bunPath: string; service: { user: string; uid: number; gid: number; home: string }; wiring: S16WiringValue;
}
/** Private-pipe owner delivery and fake-root/manager ports remain outside persisted intent metadata. */
export interface S16FirstSetupOptions extends Omit<S16InstalledServiceOptions, 'retainedUnit'> {
  layoutRoot?: string;
  /** Existing installer private fd/terminal preparation; no plaintext link may be returned or persisted. */
  prepareOwnerLink(input: Readonly<S16FirstSetupInput>): Promise<void>;
  after?: (at: 'intent' | 'selected' | 'wiring' | 'init_intent' | 'initialized' | 'adopted' | 'trial' | 'result') => void;
}
/** Completion is current state plus observed first boot, never owner login/host acceptance. */
export interface S16FirstSetupResult { contract: 's16-first-selected-setup-result/v1'; inputSha256: string; release: string; state: 'healthy' }
/** Original root capability is retained for disposal after an unknown boundary. */
export interface S16FirstSetup { readonly released: boolean; run(): Promise<Readonly<S16FirstSetupResult>>; close(): void }

/**
 * First selected setup only. Undefined input resumes the independently retained
 * original intent; existing protected state is never initialized again.
 */
export function openS16FirstSetup(initial: S16FirstSetupInput | undefined, options: S16FirstSetupOptions): S16FirstSetup {
  const layout = s16WiringLayout(options.layoutRoot), policy: RootPathPolicy = options.pathPolicy ?? {}, run = options.run ?? spawnRunner;
  initial = initial === undefined ? undefined : JSON.parse(canonical(initial)) as S16FirstSetupInput;
  const selector = openS16RootReleaseSelector({ prefix: layout.prefix, pathPolicy: policy }); let released = false, busy = false, attempted = false;
  const guard = () => { if (released) refuse('s16_first_setup_closed'); selector.read(); };
  const after = (at: Parameters<NonNullable<S16FirstSetupOptions['after']>>[0]) => { guard(); if ((options.after?.(at) as unknown) !== undefined) refuse(); guard(); };
  const validate = (input: S16FirstSetupInput) => {
    if (!input || Object.keys(input).sort().join(',') !== 'bunPath,configurationSha256,contract,packageSha256,rawConfigurationSha256,release,service,wiring' || input.contract !== 's16-first-selected-setup/v1' ||
      !input.service || Object.keys(input.service).sort().join(',') !== 'gid,home,uid,user' || !/^[a-z_][a-z0-9_-]{0,31}$/.test(input.service.user) || ![input.service.uid, input.service.gid].every(id => Number.isSafeInteger(id) && id > 0 && id <= 4294967294) ||
      input.service.home !== layout.home || input.bunPath !== join(layout.prefix, 'bin/bun') || dirname(input.release) !== join(layout.prefix, 'releases') || ![input.packageSha256, input.configurationSha256, input.rawConfigurationSha256].every(sha => /^[a-f0-9]{64}$/.test(sha))) refuse('s16_first_setup_input_changed');
    validateS16WiringValue(input.wiring); if (!input.wiring.files.controller) refuse('s16_first_setup_unit_missing');
    for (const [key, value] of Object.entries(input.wiring.files)) if (value && value.uid !== (key === 'keyring' ? input.service.uid : policy.uid ?? 0)) refuse('s16_first_setup_input_changed');
  };
  return Object.freeze<S16FirstSetup>({ get released() { return released; }, close() { if (released) return; if (busy) refuse('s16_first_setup_busy'); selector.close(); released = true; }, async run() {
    if (released || busy || attempted) refuse('s16_first_setup_already_attempted'); busy = true; attempted = true;
    try {
      selector.acquire(); const files = openS16RootJobFiles(selector, layout.prefix, join(layout.prefix, '.s16-selector/first-setup'), policy);
      let input = files.read('input.json') as S16FirstSetupInput | undefined, newIntent = false;
      if (input === undefined) {
        if (!initial) refuse('s16_first_setup_original_missing'); validate(initial);
        if (lstatSync(layout.state, { throwIfNoEntry: false }) || selector.read().targetDirectory !== null || s16WiringSha256(readS16Wiring(layout, initial.service.uid, policy)) !== s16WiringSha256(s16AbsentWiring(initial.wiring.files.keyring))) refuse('s16_first_setup_original_absence_required');
        input = initial; newIntent = true;
      } else { validate(input); if (initial && canonical(initial) !== canonical(input)) refuse('s16_first_setup_input_changed'); }
      const original = input;
      const priorResult = files.read('result.json') as S16FirstSetupResult | undefined;
      if (priorResult !== undefined) {
        if (!priorResult || Object.keys(priorResult).sort().join(',') !== 'contract,inputSha256,release,state' || priorResult.contract !== 's16-first-selected-setup-result/v1' || priorResult.inputSha256 !== digest(original) || priorResult.release !== original.release || priorResult.state !== 'healthy') refuse('s16_first_setup_result_changed');
        return Object.freeze(priorResult);
      }
      const assertRetained = async () => {
        guard(); validate(original); assertRootPath(layout.config, policy); assertRootPath(original.bunPath, policy); assertRootTree(original.release, policy);
        const checked = validateArtifact(original.release, { runtime: true }), config = readS15RuntimeConfig(layout.config);
        if (!checked.ok || checked.manifest?.contentHash !== original.packageSha256 || checked.manifest.artifactId !== basename(original.release) || checked.manifest.bunVersion !== Bun.version || checked.manifest.engineContract !== RELEASE_CONTRACT ||
          config.directory !== layout.state || digest(config) !== original.configurationSha256 || new Bun.CryptoHasher('sha256').update(readFileSync(layout.config)).digest('hex') !== original.rawConfigurationSha256 ||
          !['ops/package/installer/s16-first-setup.ts', 'ops/package/installer/s16-package-probe.ts', 'src/s16/operations-cli.ts'].every(entry => existsSync(join(original.release, entry)))) refuse('s16_first_setup_binding_changed');
        const account = await run(['/usr/bin/getent', 'passwd', original.service.user], { cwd: '/', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }, timeoutMs: 30000 }), fields = account.stdout.trim().split(':');
        if (account.exitCode !== 0 || account.timedOut || fields.length !== 7 || fields[0] !== original.service.user || fields[2] !== String(original.service.uid) || fields[3] !== String(original.service.gid) || fields[5] !== original.service.home || !['/usr/sbin/nologin', '/sbin/nologin', '/bin/false', '/usr/bin/false'].includes(fields[6]!)) refuse('s16_first_setup_identity_changed');
        const version = await run(['/usr/sbin/runuser', '-u', original.service.user, '--', '/usr/bin/env', '-i', `HOME=${original.service.home}`, 'PATH=/usr/bin:/bin', original.bunPath, '--version'], { cwd: original.release, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }, timeoutMs: 30000 });
        if (version.exitCode !== 0 || version.timedOut || version.stdout.trim() !== checked.manifest.bunVersion) refuse('s16_first_setup_bun_changed');
      };
      const call = async (entry: string, args: string[], timeoutMs = 120000) => {
        await assertRetained();
        const result = await run(['/usr/sbin/runuser', '-u', original.service.user, '--', '/usr/bin/env', '-i', `HOME=${original.service.home}`, `XDG_RUNTIME_DIR=/run/user/${original.service.uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${original.service.uid}/bus`, 'PATH=/usr/bin:/bin', original.bunPath, join(original.release, entry), ...args], { cwd: original.release, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }, timeoutMs });
        if (result.exitCode !== 0 || result.timedOut || Buffer.byteLength(result.stdout) >= 65536) refuse('s16_first_setup_command_failed'); await assertRetained(); return result.stdout;
      };
      await assertRetained(); if (newIntent) files.publish('input.json', original); after('intent');
      const selected = selector.read().targetDirectory; if (selected !== null && selected !== original.release) refuse('s16_first_setup_current_changed');
      selector.select(s16RootSelectorValue(null).sha256, original.release, original.packageSha256); after('selected');
      for (const key of ['controller', 'journal', 'proxy'] as const) {
        const path = layout.files[key], now = readS16Wiring(layout, original.service.uid, policy).files[key], wanted = original.wiring.files[key];
        if (canonical(now) === canonical(wanted)) continue; if (now !== null || wanted === null) refuse('s16_first_setup_wiring_changed');
        assertRootPath(path, policy); mkdirSync(dirname(path), { recursive: true, mode: 0o755 }); assertRootPath(path, policy);
        const directory = opendirSync(dirname(path)); let count = 0, temporaryCount = 0;
        try { for (;;) { const entry = directory.readSync(); if (!entry) break; if (++count > 4096 || entry.name.startsWith('.jit-first-setup-') && ++temporaryCount >= 16) refuse('s16_first_setup_temporary_capacity'); } } finally { directory.closeSync(); }
        const temporary = join(dirname(path), '.jit-first-setup-' + randomUUID());
        writeFileSync(temporary, Buffer.from(wanted.bytes, 'base64'), { flag: 'wx', mode: 0o600 }); chmodSync(temporary, wanted.mode); if (policy.uid === undefined) chownSync(temporary, wanted.uid, wanted.gid);
        const owned = lstatSync(temporary, { bigint: true });
        try { guard(); if (lstatSync(path, { throwIfNoEntry: false })) refuse('s16_first_setup_wiring_changed'); renameSync(temporary, path); opsSyncDirectory(dirname(path)); }
        finally { const now = lstatSync(temporary, { bigint: true, throwIfNoEntry: false }); if (now?.dev === owned.dev && now.ino === owned.ino && now.nlink === 1n) unlinkSync(temporary); }
      }
      if (s16WiringSha256(readS16Wiring(layout, original.service.uid, policy)) !== s16WiringSha256(original.wiring)) refuse('s16_first_setup_wiring_changed'); after('wiring');
      const initialize = files.read('init-intent.json'), state = lstatSync(layout.state, { throwIfNoEntry: false });
      if (!state) {
        if (initialize !== undefined) refuse('s16_first_setup_initialization_unknown');
        files.publish('init-intent.json', { contract: 's16-first-setup-init/v1', inputSha256: digest(original), state: 'absent' }); after('init_intent');
        await call('src/main.ts', ['init', '--s15', '--config', layout.config]);
      } else if (initialize === undefined || canonical(initialize) !== canonical({ contract: 's16-first-setup-init/v1', inputSha256: digest(original), state: 'absent' }) || !state.isDirectory() || state.isSymbolicLink() || state.uid !== original.service.uid || state.mode & 0o077) refuse('s16_first_setup_state_changed');
      after('initialized');
      // A prior trial may have survived loss of the root process. Settle the
      // original controller before taking any current-source/adoption exclusion.
      const service: S16InstalledService = await bindS16InstalledService({ configPath: layout.config, state: layout.state, unitPath: layout.files.controller, unit: 'jit-s15.service', prefix: layout.prefix, home: layout.home, user: original.service.user, bunPath: original.bunPath }, { ...options, retainedUnit: { bytes: Buffer.from(original.wiring.files.controller!.bytes, 'base64'), selector } });
      await service.stopRetained();
      // Initializer is never retried for an existing directory. Actual adoption
      // validates every current owning store and resumes only its original gate.
      JSON.parse(await call('src/s16/operations-cli.ts', ['adopt', '--s15', '--config', layout.config, '--request-id', 'first_setup_' + digest(original)]));
      files.publish('adoption.json', { inputSha256: digest(original), requestId: 'first_setup_' + digest(original) }); after('adopted');
      const proof = JSON.parse(await call('ops/package/installer/s16-package-probe.ts', ['--target', original.release, '--package-sha256', original.packageSha256, '--config', layout.config, '--configuration-sha256', original.configurationSha256]));
      if (proof.contract !== 's16-package-current-readers/v1' || proof.state !== 'readable' || proof.package?.contentHash !== original.packageSha256 || proof.configurationSha256 !== original.configurationSha256 || typeof proof.ownerIdentitySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(proof.ownerIdentitySha256)) refuse('s16_first_setup_current_unreadable');
      files.publish('owner.json', { inputSha256: digest(original), ownerIdentitySha256: proof.ownerIdentitySha256 });
      await options.prepareOwnerLink(Object.freeze(original)); await assertRetained();
      const manager = async (args: string[]) => { await service.assertCurrent(); const result = await run(['/usr/bin/systemctl', ...args], { cwd: '/', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }, timeoutMs: 120000 }); if (result.exitCode !== 0 || result.timedOut) refuse('s16_first_setup_manager_unknown'); await service.assertCurrent(); };
      await manager(['daemon-reload']); await manager(['enable', 'jit-s15.service']);
      try { if (!await service.healthy()) { await service.assertStopped(); await service.start(); } after('trial'); if (!await service.healthy()) refuse('s16_first_setup_health_failed'); }
      catch (failure) { await service.stopRetained(); throw failure; }
      const result: S16FirstSetupResult = { contract: 's16-first-selected-setup-result/v1', inputSha256: digest(original), release: original.release, state: 'healthy' };
      files.publish('result.json', result); after('result'); return Object.freeze(result);
    } finally { busy = false; }
  } });
}
