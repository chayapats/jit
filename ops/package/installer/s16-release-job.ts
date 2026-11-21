import { createHash, randomBytes } from 'node:crypto';
import { lstatSync, opendirSync, renameSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { canonical } from '../../../src/s15/conversation/validation';
import { opsDirectory, opsRead, opsSyncDirectory, opsWrite } from '../../../src/s14/ops-files';
import { type CommandRunner, spawnRunner } from '../../../src/ops/supervisor';
import { assertRootPath, assertRootTree, type RootPathPolicy } from '../trusted-paths';
import { validateArtifact } from '../bun-build';
import { validateS16GuardedSelectionInput, type S16GuardedSelectionAbort, type S16GuardedSelectionInput, type S16GuardedSelectionPlan, type S16GuardedSelectionReader, type S16GuardedSelectionReceipt } from './s16-guarded-selection';
import { openS16RootReleaseSelector, s16RootSelectorValue } from './s16-release-selector';

const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');
function refuse(code = 's16_release_job_refused'): never { throw Error(code); }
/** The supervisor must prove the controller stopped; it never stops or restores working VMs. */
export interface S16ReleaseService {
  stop(): Promise<void>;
  assertStopped(): Promise<void>;
  start(): Promise<void>;
  healthy(): Promise<boolean>;
}
/** Existing protected service identity and immutable operator; no account/configuration changes occur here. */
export interface S16ReleaseJobInput {
  selection: S16GuardedSelectionInput; operatorDirectory: string; bunPath: string;
  service: { user: string; uid: number; home: string };
}
/** Historical job result only; a retry does not claim that a later service is still healthy. */
export interface S16ReleaseJobResult {
  contract: 's16-release-job-result/v1'; inputSha256: string; outcome: 'selected_healthy' | 'fallback_healthy';
  selection: Readonly<S16GuardedSelectionReceipt>; fallback: Readonly<S16GuardedSelectionReceipt> | null;
}
/** Trusted composition only; alternate ownership/runner ports are explicit disposable fixture boundaries. */
export interface S16ReleaseJobOptions {
  service: S16ReleaseService; run?: CommandRunner; pathPolicy?: RootPathPolicy;
  after?(boundary: 'stopped' | 'plan' | 'armed' | 'selected' | 'completed' | 'trial' | 'fallback' | 'result'): void;
}
/** Retains the original root lease after unknown disposal; close before another qualified installer proceeds. */
export interface S16ReleaseJob { readonly released: boolean; run(): Promise<Readonly<S16ReleaseJobResult>>; close(): void }

/**
 * Coordinates a stopped controller, actual service-identity helper processes and a root-only selector.
 * Trial failure selects a compatible old executable over a fresh current cohort; no data is restored.
 */
export function openS16ReleaseJob(input: S16ReleaseJobInput, options: S16ReleaseJobOptions): S16ReleaseJob {
  let selection = validateS16GuardedSelectionInput(input.selection); const policy = options.pathPolicy ?? {}, runner = options.run ?? spawnRunner, service = options.service;
  if (Object.keys(input).sort().join(',') !== 'bunPath,operatorDirectory,selection,service' || Object.keys(input.service).sort().join(',') !== 'home,uid,user' ||
    !/^[a-z_][a-z0-9_-]{0,31}$/.test(input.service.user) || !Number.isSafeInteger(input.service.uid) || input.service.uid < 1 || input.service.uid > 4294967294 ||
    [input.operatorDirectory, input.bunPath, input.service.home].some(path => !isAbsolute(path) || resolve(path) !== path || path.length > 4096) || dirname(input.operatorDirectory) !== join(selection.prefix, 'releases')) refuse();
  input = JSON.parse(canonical(input)) as S16ReleaseJobInput;
  selection = input.selection;
  const root = openS16RootReleaseSelector({ prefix: selection.prefix, ...(options.pathPolicy ? { pathPolicy: options.pathPolicy } : {}) });
  let released = false, busy = false, acquired = false;
  const inputSha256 = digest(input), directory = join(selection.prefix, '.s16-selector/jobs', digest(selection.requestId));
  const guard = () => { if (released) refuse('s16_release_job_closed'); root.read(); assertRootPath(directory, policy); };
  const after = (at: Parameters<NonNullable<S16ReleaseJobOptions['after']>>[0]) => { guard(); if ((options.after?.(at) as unknown) !== undefined) refuse('s16_release_job_guard_invalid'); guard(); };
  const entry = (path: string, directory = false) => {
    guard(); const stat = lstatSync(path, { bigint: true });
    if (stat.uid !== BigInt(policy.uid ?? 0) || stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1n) || stat.mode & (directory ? 0o7077n : 0o7177n)) refuse('s16_release_job_path_untrusted'); return stat;
  };
  const read = (name: string): unknown | undefined => {
    const path = join(directory, name); if (!lstatSync(path, { throwIfNoEntry: false })) return;
    const before = entry(path); if (before.size > 65536n) refuse('s16_release_job_metadata_bounds'); const raw = opsRead(path, 65536), value = JSON.parse(raw.toString('utf8')), now = entry(path);
    if (canonical(value) !== raw.toString('utf8') || before.dev !== now.dev || before.ino !== now.ino || before.mtimeNs !== now.mtimeNs || before.ctimeNs !== now.ctimeNs || before.size !== now.size || BigInt(raw.length) !== now.size) refuse('s16_release_job_metadata_changed'); return value;
  };
  const publish = (name: string, value: unknown) => {
    const encoded = canonical(value); if (Buffer.byteLength(encoded) > 65536) refuse('s16_release_job_metadata_bounds');
    const old = read(name); if (old !== undefined) { if (canonical(old) !== encoded) refuse('s16_release_job_metadata_changed'); return; }
    const handle = opendirSync(directory); let count = 0; try { while (handle.readSync()) if (++count >= 64) refuse('s16_release_job_capacity'); } finally { handle.closeSync(); }
    const temporary = join(directory, '.publish-' + randomBytes(16).toString('hex')), destination = join(directory, name); opsWrite(temporary, encoded); const original = entry(temporary);
    try {
      guard(); if (lstatSync(destination, { throwIfNoEntry: false })) refuse('s16_release_job_metadata_changed');
      const now = entry(temporary); if (now.dev !== original.dev || now.ino !== original.ino || now.mtimeNs !== original.mtimeNs || now.ctimeNs !== original.ctimeNs || now.size !== original.size) refuse('s16_release_job_metadata_changed');
      renameSync(temporary, destination); opsSyncDirectory(directory);
      if (canonical(read(name)) !== encoded) refuse('s16_release_job_metadata_changed');
    } finally {
      const now = lstatSync(temporary, { bigint: true, throwIfNoEntry: false });
      if (now && now.dev === original.dev && now.ino === original.ino && now.nlink === 1n && now.mtimeNs === original.mtimeNs && now.ctimeNs === original.ctimeNs) { unlinkSync(temporary); opsSyncDirectory(directory); }
    }
  };
  const verifyOperator = () => {
    guard(); assertRootTree(input.operatorDirectory, policy); assertRootPath(input.bunPath, policy); const bun = lstatSync(input.bunPath), checked = validateArtifact(input.operatorDirectory, { runtime: true });
    if (!bun.isFile() || bun.nlink !== 1 || !(bun.mode & 0o111) || !checked.ok || checked.manifest?.contentHash !== selection.operatorSha256 || checked.manifest.bunVersion !== Bun.version) refuse('s16_release_job_operator_changed');
  };
  const call = async (packageDirectory: string, args: string[], stdin?: string): Promise<unknown> => {
    verifyOperator(); await service.assertStopped(); guard();
    const result = await runner(['/usr/sbin/runuser', '-u', input.service.user, '--', '/usr/bin/env', '-i', 'HOME=' + input.service.home,
      'XDG_RUNTIME_DIR=/run/user/' + input.service.uid, 'PATH=/usr/bin:/bin', input.bunPath, ...args], {
      cwd: packageDirectory, env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }, timeoutMs: 600000, ...(stdin === undefined ? {} : { stdin }) });
    guard(); await service.assertStopped(); if (result.exitCode !== 0 || result.timedOut || Buffer.byteLength(result.stdout) >= 65536) refuse('s16_release_job_helper_refused');
    return JSON.parse(result.stdout);
  };
  const helper = (command: S16GuardedSelectionInput, method: string, plan?: S16GuardedSelectionPlan, readers?: readonly S16GuardedSelectionReader[], reader?: S16GuardedSelectionReader) => call(input.operatorDirectory, [join(input.operatorDirectory, 'ops/package/installer/s16-guarded-selection.ts')], canonical({ input: command, method, ...(plan ? { plan } : {}), ...(readers ? { readers } : {}), ...(reader ? { reader } : {}) }));
  const readPackage = async (command: S16GuardedSelectionInput, plan: S16GuardedSelectionPlan, targetDirectory: string, packageSha256: string): Promise<S16GuardedSelectionReader> => {
    const observation = await call(targetDirectory, [join(input.operatorDirectory, 'ops/package/installer/s16-package-probe.ts'), '--target', targetDirectory, '--package-sha256', packageSha256, '--config', command.configPath, '--configuration-sha256', command.configurationSha256]) as S16GuardedSelectionReader['observation'];
    const backup = await call(targetDirectory, [join(targetDirectory, 'src/s16/operations-cli.ts'), 'backup', '--s15', '--config', command.configPath, '--request-id', plan.backup.requestId]) as S16GuardedSelectionReader['backup']; return { observation, backup };
  };
  const perform = async (command: S16GuardedSelectionInput, name: string): Promise<S16GuardedSelectionReceipt> => {
    const path = name + '-plan.json'; let plan = read(path) as S16GuardedSelectionPlan | undefined;
    if (plan === undefined) { plan = await helper(command, 'prepare') as S16GuardedSelectionPlan; publish(path, plan); }
    if (canonical(plan.input) !== canonical(command)) refuse('s16_release_job_plan_changed'); after('plan');
    const state = await helper(command, 'inspect', plan) as { phase: string; status: string; armed: boolean; receipt: S16GuardedSelectionReceipt | null };
    if (state.status === 'complete' && state.receipt) return state.receipt;
    if (!state.armed) {
      const readers: S16GuardedSelectionReader[] = [];
      for (const [targetDirectory, packageSha256] of [[command.sourceDirectory, command.sourceSha256], [command.targetDirectory, command.targetSha256]]) {
        readers.push(await readPackage(command, plan, targetDirectory!, packageSha256!));
      }
      await helper(command, 'arm', plan, readers);
    }
    after('armed');
    root.select(s16RootSelectorValue(command.sourceDirectory).sha256, command.targetDirectory, command.targetSha256); after('selected');
    const completed = await helper(command, 'complete', plan) as S16GuardedSelectionReceipt;
    if (completed.contract !== 's16-guarded-release-selection-result/v1' || completed.state !== 'selected' || completed.planSha256 !== digest(plan) || completed.operationId !== plan.operationId) refuse('s16_release_job_receipt_changed');
    after('completed'); return completed;
  };
  const stop = async () => { await service.stop(); await service.assertStopped(); guard(); after('stopped'); };
  return Object.freeze<S16ReleaseJob>({ get released() { return released; }, close() { if (released) return; if (busy) refuse('s16_release_job_busy'); root.close(); released = true; }, async run() {
    if (released || busy) refuse('s16_release_job_busy'); busy = true;
    try {
      if (!acquired) { root.acquire(); acquired = true; }
      const jobs = dirname(directory); assertRootPath(jobs, policy);
      if (lstatSync(jobs, { throwIfNoEntry: false })) {
        const handle = opendirSync(jobs); let count = 0; try { while (handle.readSync()) if (++count > 256) refuse('s16_release_job_capacity'); } finally { handle.closeSync(); }
        if (count >= 256 && !lstatSync(directory, { throwIfNoEntry: false })) refuse('s16_release_job_capacity');
      }
      opsDirectory(directory); entry(jobs, true); entry(directory, true); const savedInput = read('input.json');
      if (savedInput !== undefined && canonical(savedInput) !== canonical(input)) refuse('s16_release_job_command_changed'); publish('input.json', input);
      const previous = read('result.json') as S16ReleaseJobResult | undefined;
      if (previous !== undefined) { if (!previous || Object.keys(previous).sort().join(',') !== 'contract,fallback,inputSha256,outcome,selection' || previous.contract !== 's16-release-job-result/v1' || previous.inputSha256 !== inputSha256 || !['selected_healthy', 'fallback_healthy'].includes(previous.outcome)) refuse('s16_release_job_receipt_changed'); return Object.freeze(previous); }
      const aborted = read('fallback-aborted.json') as S16GuardedSelectionAbort | undefined;
      if (aborted !== undefined) { if (!aborted || aborted.contract !== 's16-guarded-release-abort/v1' || aborted.state !== 'not_selected' || !/^[a-f0-9]{64}$/.test(aborted.planSha256)) refuse('s16_release_job_receipt_changed'); refuse('s16_release_job_forward_recovery_required'); }
      verifyOperator(); await stop();
      const selected = await perform(selection, 'selection'); publish('selection.json', selected);
      const fallbackInput: S16GuardedSelectionInput = { ...selection, requestId: 'release_fallback_' + digest(selection.requestId), sourceDirectory: selection.targetDirectory, sourceSha256: selection.targetSha256, targetDirectory: selection.sourceDirectory, targetSha256: selection.sourceSha256 };
      let fallback = read('fallback.json') as S16GuardedSelectionReceipt | undefined;
      const fallbackStarted = read('fallback-plan.json') !== undefined;
      if (!fallback && !fallbackStarted) {
        if (root.read().sha256 !== s16RootSelectorValue(selection.targetDirectory).sha256) refuse('s16_release_job_current_changed');
        let started = false, healthy = false; try { await service.start(); started = true; } catch { /* Conclusive stop below reconciles even an unknown start. */ }
        guard(); after('trial'); if (started) try { healthy = await service.healthy(); } catch { /* Unknown health requires a stopped fresh-current fallback. */ }
        if (healthy) { const result: S16ReleaseJobResult = { contract: 's16-release-job-result/v1', inputSha256, outcome: 'selected_healthy', selection: selected, fallback: null }; publish('result.json', result); after('result'); return Object.freeze(result); }
        await stop();
      }
      if (!fallback) {
        try { fallback = await perform(fallbackInput, 'fallback'); publish('fallback.json', fallback); }
        catch (error) {
          const plan = read('fallback-plan.json') as S16GuardedSelectionPlan | undefined;
          if (!plan) throw error;
          // Only a fresh genuine current source read can discard a plan without
          // a selector intent. Any uncertain physical boundary remains fenced.
          const source = await readPackage(fallbackInput, plan, fallbackInput.sourceDirectory, fallbackInput.sourceSha256);
          const aborted = await helper(fallbackInput, 'abort', plan, undefined, source) as S16GuardedSelectionAbort;
          if (aborted.contract !== 's16-guarded-release-abort/v1' || aborted.state !== 'not_selected' || aborted.planSha256 !== digest(plan)) refuse('s16_release_job_receipt_changed');
          publish('fallback-aborted.json', aborted); refuse('s16_release_job_forward_recovery_required');
        }
      }
      after('fallback');
      if (root.read().sha256 !== s16RootSelectorValue(selection.sourceDirectory).sha256) refuse('s16_release_job_current_changed');
      await service.start(); guard(); if (!await service.healthy()) { await stop(); refuse('s16_release_job_fallback_health_failed'); }
      const result: S16ReleaseJobResult = { contract: 's16-release-job-result/v1', inputSha256, outcome: 'fallback_healthy', selection: selected, fallback }; publish('result.json', result); after('result'); return Object.freeze(result);
    } finally { busy = false; }
  } });
}
