import { randomUUID } from 'node:crypto';
import { chmodSync, chownSync, existsSync, lstatSync, opendirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { canonical, identity } from '../../../src/s15/conversation/validation';
import { readS15RuntimeConfig } from '../../../src/s15/runtime-config';
import { opsSyncDirectory } from '../../../src/s14/ops-files';
import { spawnRunner, type CommandRunner } from '../../../src/ops/supervisor';
import { validateArtifact } from '../bun-build';
import { assertRootPath, assertRootTree, type RootPathPolicy } from '../trusted-paths';
import { assertS16RootReleaseSelectorFor, openS16RootReleaseSelector, type S16RootReleaseSelector } from './s16-release-selector';
import { openS16RootJobFiles } from './s16-root-job-files';
import { readS16Wiring, s16AbsentWiring, s16WiringLayout, s16WiringSha256, validateS16WiringValue, type S16WiringValue } from './s16-wiring-value';
import type { S16WiringInput, S16WiringPlan, S16WiringReceipt } from './s16-wiring-maintenance';

const digest = (value: unknown) => new Bun.CryptoHasher('sha256').update(canonical(value)).digest('hex');
function refuse(code = 's16_root_wiring_job_refused'): never { throw Error(code); }
/** Fixed original host identity; restoration refers only to a retained root removal job, never supplied unit bytes. */
export interface S16RootWiringJobInput {
  requestId: string; direction: 'remove' | 'restore'; originalRemovalRequestId: string | null; bunPath: string;
  service: { user: string; uid: number; gid: number; home: string };
}
/** Trusted manager port. Production integration must prove original identity, controller stop, VM stop and activation readback. */
export interface S16WiringSupervisor {
  assertRetained(): Promise<void>; stop(): Promise<void>; assertStopped(): Promise<void>;
  stopWorkingVms(): Promise<void>; removeActivation(): Promise<void>; restoreActivation(): Promise<void>;
  reload(): Promise<void>;
}
interface Snapshot {
  contract: 's16-root-wiring-snapshot/v1'; service: S16RootWiringJobInput['service']; configurationSha256: string; rawConfigurationSha256: string;
  state: { dev: number; ino: number; uid: number; gid: number; mode: number }; currentDirectory: string; currentSha256: string; wiring: S16WiringValue;
}
/** Historical wiring receipt; no service health, VM/effect settlement or data restoration is certified here. */
export interface S16RootWiringJobResult { contract: 's16-root-wiring-job-result/v1'; inputSha256: string; snapshotSha256: string; direction: 'remove' | 'restore'; receipt: S16WiringReceipt }
/** Explicit fake root/UID/runner/supervisor boundaries are disposable fixtures only. */
export interface S16RootWiringJobOptions {
  supervisor: S16WiringSupervisor; run?: CommandRunner; pathPolicy?: RootPathPolicy; layoutRoot?: string;
  /** The installed dispatcher owns exclusion across locator, unit recovery and subsequent boot. */
  selector?: S16RootReleaseSelector;
  after?: (at: 'stopped' | 'plan' | 'armed' | 'file' | 'wiring' | 'completed' | 'result') => void;
}
/** Original root resources survive unknown disposal; retry close on the same capability. */
export interface S16RootWiringJob { readonly released: boolean; run(): Promise<Readonly<S16RootWiringJobResult>>; close(): void }

/** Coordinates actual current-identity helper intents and only three fixed root-owned unit paths. */
export function openS16RootWiringJob(input: S16RootWiringJobInput, options: S16RootWiringJobOptions): S16RootWiringJob {
  identity(input.requestId); if (input.originalRemovalRequestId !== null) identity(input.originalRemovalRequestId);
  const layout = s16WiringLayout(options.layoutRoot), policy = options.pathPolicy ?? {}, run = options.run ?? spawnRunner, supervisor = options.supervisor;
  if (Object.keys(input).sort().join(',') !== 'bunPath,direction,originalRemovalRequestId,requestId,service' || Object.keys(input.service).sort().join(',') !== 'gid,home,uid,user' ||
    !['remove', 'restore'].includes(input.direction) || (input.direction === 'remove' ? input.originalRemovalRequestId !== null : input.originalRemovalRequestId === null || input.originalRemovalRequestId === input.requestId) ||
    !/^[a-z_][a-z0-9_-]{0,31}$/.test(input.service.user) || ![input.service.uid, input.service.gid].every(id => Number.isSafeInteger(id) && id > 0 && id <= 4294967294) || input.service.home !== layout.home || input.bunPath !== join(layout.prefix, 'bin/bun')) refuse();
  input = JSON.parse(canonical(input)) as S16RootWiringJobInput;
  const selector = options.selector ?? openS16RootReleaseSelector({ prefix: layout.prefix, pathPolicy: policy }), inputSha256 = digest(input), jobsPath = join(layout.prefix, '.s16-selector/wiring-jobs');
  if (options.selector) assertS16RootReleaseSelectorFor(selector, layout.prefix, policy.uid ?? 0);
  let released = false, busy = false, acquired = options.selector !== undefined;
  const guard = () => { if (released) refuse('s16_root_wiring_job_closed'); selector.read(); };
  const after = (at: Parameters<NonNullable<S16RootWiringJobOptions['after']>>[0]) => { guard(); if ((options.after?.(at) as unknown) !== undefined) refuse(); guard(); };
  const source = (snapshot: Snapshot) => {
    guard(); if (!snapshot || Object.keys(snapshot).sort().join(',') !== 'configurationSha256,contract,currentDirectory,currentSha256,rawConfigurationSha256,service,state,wiring' || snapshot.contract !== 's16-root-wiring-snapshot/v1' || canonical(snapshot.service) !== canonical(input.service) || dirname(snapshot.currentDirectory) !== join(layout.prefix, 'releases') ||
      ![snapshot.configurationSha256, snapshot.rawConfigurationSha256, snapshot.currentSha256].every(sha => /^[a-f0-9]{64}$/.test(sha)) || !snapshot.state || Object.keys(snapshot.state).sort().join(',') !== 'dev,gid,ino,mode,uid' || !Object.values(snapshot.state).every(n => Number.isSafeInteger(n) && n >= 0) || snapshot.state.uid !== input.service.uid || snapshot.state.mode & 0o022) refuse('s16_root_wiring_snapshot_changed');
    validateS16WiringValue(snapshot.wiring);
    for (const [key, value] of Object.entries(snapshot.wiring.files)) if (value !== null && value.uid !== (key === 'keyring' ? input.service.uid : policy.uid ?? 0)) refuse('s16_root_wiring_snapshot_changed');
    assertRootPath(layout.config, policy); const config = readS15RuntimeConfig(layout.config), state = lstatSync(layout.state);
    if (config.directory !== layout.state || digest(config) !== snapshot.configurationSha256 || new Bun.CryptoHasher('sha256').update(readFileSync(layout.config)).digest('hex') !== snapshot.rawConfigurationSha256 ||
      canonical({ dev: state.dev, ino: state.ino, uid: state.uid, gid: state.gid, mode: state.mode }) !== canonical(snapshot.state) || !state.isDirectory() || selector.read().targetDirectory !== snapshot.currentDirectory) refuse('s16_root_wiring_binding_changed');
    assertRootTree(snapshot.currentDirectory, policy); assertRootPath(input.bunPath, policy); const checked = validateArtifact(snapshot.currentDirectory, { runtime: true });
    if (!checked.ok || checked.manifest?.contentHash !== snapshot.currentSha256 || checked.manifest.artifactId !== basename(snapshot.currentDirectory) || checked.manifest.bunVersion !== Bun.version || !existsSync(join(snapshot.currentDirectory, 'ops/package/installer/s16-wiring-maintenance.ts'))) refuse('s16_root_wiring_operator_unavailable');
  };
  return Object.freeze<S16RootWiringJob>({ get released() { return released; }, close() { if (released) return; if (busy) refuse('s16_root_wiring_job_busy'); if (!options.selector) selector.close(); released = true; }, async run() {
    if (released || busy) refuse('s16_root_wiring_job_busy'); busy = true;
    try {
      if (!acquired) { selector.acquire(); acquired = true; }
      const base = openS16RootJobFiles(selector, layout.prefix, jobsPath, policy, 256), directory = join(jobsPath, digest(input.requestId));
      if (!lstatSync(directory, { throwIfNoEntry: false })) {
        const entries = opendirSync(jobsPath); let count = 0; try { while (entries.readSync()) if (++count >= 256) refuse('s16_root_wiring_capacity'); } finally { entries.closeSync(); }
      }
      const files = openS16RootJobFiles(selector, layout.prefix, directory, policy); files.publish('input.json', input);
      const previous = files.read('result.json') as S16RootWiringJobResult | undefined;
      if (previous !== undefined) {
        const originalPlan = files.read('plan.json') as S16WiringPlan | undefined, originalSnapshot = files.read('snapshot.json');
        if (!previous || Object.keys(previous).sort().join(',') !== 'contract,direction,inputSha256,receipt,snapshotSha256' || previous.contract !== 's16-root-wiring-job-result/v1' || previous.inputSha256 !== inputSha256 || previous.direction !== input.direction ||
          !originalPlan || originalSnapshot === undefined || previous.snapshotSha256 !== digest(originalSnapshot) || !previous.receipt || Object.keys(previous.receipt).sort().join(',') !== 'contract,operationId,planSha256,requestId,revision' || previous.receipt.contract !== 's16-installed-wiring-result/v1' || previous.receipt.requestId !== 'wiring_' + digest(input.requestId) || previous.receipt.operationId !== originalPlan.operationId || previous.receipt.planSha256 !== digest(originalPlan) || !Number.isSafeInteger(previous.receipt.revision) || previous.receipt.revision < 1) refuse('s16_root_wiring_result_changed');
        return Object.freeze(previous);
      }
      let snapshot = files.read('snapshot.json') as Snapshot | undefined;
      if (snapshot === undefined) {
        await supervisor.assertRetained();
        if (input.direction === 'restore') {
          const originalDirectory = join(jobsPath, digest(input.originalRemovalRequestId));
          if (!lstatSync(originalDirectory, { throwIfNoEntry: false })?.isDirectory()) refuse('s16_root_wiring_original_removal_incomplete');
          const original = openS16RootJobFiles(selector, layout.prefix, originalDirectory, policy);
          const originalInput = original.read('input.json') as S16RootWiringJobInput | undefined, originalResult = original.read('result.json') as S16RootWiringJobResult | undefined;
          snapshot = original.read('snapshot.json') as Snapshot | undefined;
          const originalPlan = original.read('plan.json') as S16WiringPlan | undefined;
          if (!originalInput || originalInput.direction !== 'remove' || originalInput.requestId !== input.originalRemovalRequestId || canonical(originalInput.service) !== canonical(input.service) || originalInput.bunPath !== input.bunPath || !originalResult || originalResult.direction !== 'remove' || originalResult.contract !== 's16-root-wiring-job-result/v1' || originalResult.inputSha256 !== digest(originalInput) || !snapshot || originalResult.snapshotSha256 !== digest(snapshot) || !originalPlan || originalResult.receipt?.planSha256 !== digest(originalPlan) || originalPlan.input.priorWiringSha256 !== s16WiringSha256(snapshot.wiring)) refuse('s16_root_wiring_original_removal_incomplete');
        } else {
          const currentDirectory = selector.read().targetDirectory; if (!currentDirectory) refuse('s16_root_wiring_current_missing');
          const checked = validateArtifact(currentDirectory, { runtime: true }), config = readS15RuntimeConfig(layout.config), state = lstatSync(layout.state);
          if (!checked.ok || !checked.manifest) refuse('s16_root_wiring_package_changed');
          snapshot = { contract: 's16-root-wiring-snapshot/v1', service: input.service, configurationSha256: digest(config), rawConfigurationSha256: new Bun.CryptoHasher('sha256').update(readFileSync(layout.config)).digest('hex'),
            state: { dev: state.dev, ino: state.ino, uid: state.uid, gid: state.gid, mode: state.mode }, currentDirectory, currentSha256: checked.manifest.contentHash, wiring: readS16Wiring(layout, input.service.uid, policy) };
        }
        source(snapshot); files.publish('snapshot.json', snapshot);
      }
      source(snapshot); await supervisor.assertRetained(); await supervisor.stop(); await supervisor.assertStopped(); after('stopped');
      const absent = s16AbsentWiring(snapshot.wiring.files.keyring), prior = input.direction === 'remove' ? snapshot.wiring : absent, target = input.direction === 'remove' ? absent : snapshot.wiring;
      const command: S16WiringInput = { requestId: 'wiring_' + digest(input.requestId), direction: input.direction, configPath: layout.config, configurationSha256: snapshot.configurationSha256,
        originalRemovalRequestId: input.direction === 'restore' ? 'wiring_' + digest(input.originalRemovalRequestId) : null, operatorSha256: snapshot.currentSha256, currentDirectory: snapshot.currentDirectory, currentSha256: snapshot.currentSha256, priorWiringSha256: s16WiringSha256(prior), targetWiringSha256: s16WiringSha256(target) };
      const helper = async (method: 'prepare' | 'inspect' | 'arm' | 'complete', plan?: S16WiringPlan) => {
        source(snapshot!); await supervisor.assertRetained();
        const argv = ['/usr/sbin/runuser', '-u', input.service.user, '--', '/usr/bin/env', '-i', `HOME=${input.service.home}`, `XDG_RUNTIME_DIR=/run/user/${input.service.uid}`, 'PATH=/usr/bin:/bin', input.bunPath, join(snapshot!.currentDirectory, 'ops/package/installer/s16-wiring-maintenance.ts')];
        const result = await run(argv, { cwd: snapshot!.currentDirectory, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }, stdin: canonical({ method, input: command, ...(plan ? { plan } : {}) }), timeoutMs: 120000 });
        if (result.exitCode !== 0 || result.timedOut || Buffer.byteLength(result.stdout) >= 65536) refuse('s16_root_wiring_helper_failed');
        source(snapshot!); return JSON.parse(result.stdout);
      };
      let plan = files.read('plan.json') as S16WiringPlan | undefined;
      if (plan === undefined) { plan = await helper('prepare') as S16WiringPlan; files.publish('plan.json', plan); }
      if (canonical(plan.input) !== canonical(command)) refuse('s16_root_wiring_original_plan_changed'); after('plan');
      let observed = await helper('inspect', plan) as { armed: boolean; receipt: S16WiringReceipt | null };
      if (!observed.receipt && !observed.armed) { await helper('arm', plan); observed = await helper('inspect', plan) as typeof observed; }
      if (!observed.receipt) {
        if (!observed.armed) refuse('s16_root_wiring_intent_missing'); after('armed');
        if (input.direction === 'remove') { await supervisor.stopWorkingVms(); await supervisor.removeActivation(); }
        await supervisor.assertStopped();
        for (const key of ['controller', 'journal', 'proxy'] as const) {
          source(snapshot); await supervisor.assertRetained(); const path = layout.files[key], actual = readS16Wiring(layout, input.service.uid, policy).files[key], wanted = target.files[key];
          if (canonical(actual) === canonical(wanted)) continue;
          if (input.direction === 'remove') { if (canonical(actual) !== canonical(prior.files[key])) refuse('s16_root_wiring_file_changed'); unlinkSync(path); opsSyncDirectory(dirname(path)); }
          else {
            if (actual !== null || wanted === null) refuse('s16_root_wiring_file_changed');
            const entries = opendirSync(dirname(path)); let count = 0, temporaryCount = 0;
            try { for (;;) { const entry = entries.readSync(); if (!entry) break; if (++count > 4096 || entry.name.startsWith('.jit-wiring-') && ++temporaryCount >= 16) refuse('s16_root_wiring_temporary_capacity'); } } finally { entries.closeSync(); }
            const temporary = join(dirname(path), '.jit-wiring-' + randomUUID()); assertRootPath(temporary, policy);
            writeFileSync(temporary, Buffer.from(wanted.bytes, 'base64'), { flag: 'wx', mode: 0o600 }); chmodSync(temporary, wanted.mode); if (policy.uid === undefined) chownSync(temporary, wanted.uid, wanted.gid);
            const original = lstatSync(temporary, { bigint: true });
            try {
              guard(); assertRootPath(path, policy); if (lstatSync(path, { throwIfNoEntry: false })) refuse('s16_root_wiring_file_changed');
              // Only root can write either parent; the genuine selector excludes
              // qualified installers. Orphan crash temporaries are never adopted.
              renameSync(temporary, path); opsSyncDirectory(dirname(path));
            } finally { const now = lstatSync(temporary, { bigint: true, throwIfNoEntry: false }); if (now?.dev === original.dev && now.ino === original.ino && now.nlink === 1n) unlinkSync(temporary); }
          }
          if (canonical(readS16Wiring(layout, input.service.uid, policy).files[key]) !== canonical(wanted)) refuse('s16_root_wiring_file_changed'); after('file');
        }
        if (s16WiringSha256(readS16Wiring(layout, input.service.uid, policy)) !== command.targetWiringSha256) refuse('s16_root_wiring_target_changed');
        await supervisor.reload();
        if (input.direction === 'restore') await supervisor.restoreActivation();
        await supervisor.assertStopped(); after('wiring'); observed = { armed: true, receipt: await helper('complete', plan) as S16WiringReceipt };
      }
      after('completed');
      if (!observed.receipt || observed.receipt.contract !== 's16-installed-wiring-result/v1' || observed.receipt.operationId !== plan.operationId || observed.receipt.planSha256 !== digest(plan)) refuse('s16_root_wiring_receipt_changed');
      const result: S16RootWiringJobResult = { contract: 's16-root-wiring-job-result/v1', inputSha256, snapshotSha256: digest(snapshot), direction: input.direction, receipt: observed.receipt };
      files.publish('result.json', result); after('result'); return Object.freeze(result);
    } finally { busy = false; }
  } });
}
