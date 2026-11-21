import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { chmodSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { RELEASE_CONTRACT } from 'schway/host';
import { buildPackage, installArtifactDependencies, readDependencyRecord, validateArtifact } from '../ops/package/bun-build';
import { s16AbsentWiring, readS16Wiring, s16WiringLayout, s16WiringSha256 } from '../ops/package/installer/s16-wiring-value';
import type { S16WiringInput, S16WiringPlan, S16WiringReceipt } from '../ops/package/installer/s16-wiring-maintenance';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { canonical } from '../src/s15/conversation/validation';
import { spawnRunner } from '../src/ops/supervisor';
import { openS16RootWiringJob, type S16RootWiringJobInput, type S16RootWiringJobOptions, type S16WiringSupervisor } from '../ops/package/installer/s16-root-wiring-job';
import { openS16InstalledWiring } from '../ops/package/installer/s16-installed-wiring';
import { opsDirectory, opsWrite } from '../src/s14/ops-files';

let root: string, artifact: string, artifactHash: string, sourceCommit: string, sourceClean: boolean;
const targets: string[] = [];
const env = { PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin' }, digest = (value: unknown) => new Bun.CryptoHasher('sha256').update(canonical(value)).digest('hex');
beforeAll(async () => {
  const receipt = process.env.JIT_S16_INSTALLED_WIRING_RECEIPT;
  if (receipt && (!isAbsolute(receipt) || existsSync(receipt))) throw Error('fixture_receipt_must_be_fresh_absolute_path'); if (receipt) opsDirectory(dirname(receipt));
  const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' }), status = Bun.spawnSync(['git', 'status', '--porcelain'], { stdout: 'pipe', stderr: 'ignore' });
  sourceCommit = revision.stdout.toString().trim(); sourceClean = revision.exitCode === 0 && status.exitCode === 0 && !status.stdout.length;
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-installed-wiring-')));
  const staging = join(root, 'build'), manifest = buildPackage({ srcDir: process.cwd(), outDir: staging, engineContract: RELEASE_CONTRACT, engineRevision: null });
  await installArtifactDependencies(staging, { bunPath: process.execPath, run: spawnRunner, env, timeoutMs: 120000 });
  artifact = join(root, manifest.artifactId); artifactHash = manifest.contentHash; renameSync(staging, artifact);
}, 120000);
afterAll(() => {
  try {
    const dependencies = readDependencyRecord(artifact);
    for (const path of [artifact, ...targets]) { const checked = validateArtifact(path, { runtime: true }); expect(checked.ok && checked.manifest?.contentHash === artifactHash && readDependencyRecord(path)?.dependencyHash === dependencies?.dependencyHash).toBe(true); }
    const receipt = process.env.JIT_S16_INSTALLED_WIRING_RECEIPT;
    if (receipt) {
      const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' }), status = Bun.spawnSync(['git', 'status', '--porcelain'], { stdout: 'pipe', stderr: 'ignore' });
      opsWrite(receipt, JSON.stringify({ contract: 's16-installed-wiring-artifact-evidence/v1', sourceCommit, sourceState: sourceClean && revision.exitCode === 0 && revision.stdout.toString().trim() === sourceCommit && status.exitCode === 0 && !status.stdout.length ? 'clean' : 'unverified',
        packageHash: artifactHash, dependencyHash: dependencies?.dependencyHash, dependencyFiles: dependencies?.dependencyFiles, lockHash: dependencies?.lockHash, copies: targets.length, artifactsAfter: 'verified_unchanged', testOutcomes: 'separate_test_log_required',
        platform: process.platform, arch: process.arch, bunVersion: Bun.version, engineContract: RELEASE_CONTRACT, engineRevision: 'unverified', driverSha256: new Bun.CryptoHasher('sha256').update(readFileSync(import.meta.path)).digest('hex'),
        controller: 'actual_copied_protected_helpers', rootSelectionAndWiring: 'actual_filesystem_and_process_leases', native: 'explicit_empty_namespace_metadata', accountManagerVmHttp: 'scripted_fixture_ports', identityTransition: 'fixture_runner_not_linux_enforcement', owningServiceClient: 'not_exercised', liveAccounts: false, nativeDevices: 'not_exercised' }));
    }
  } finally { if (root) rmSync(root, { recursive: true, force: true }); }
});
async function fixture() {
  const sandbox = realpathSync(mkdtempSync(join(root, 'host-'))), layout = s16WiringLayout(sandbox), pathPolicy = { root, uid: process.getuid!() };
  const target = join(layout.prefix, 'releases', basename(artifact)); mkdirSync(dirname(target), { recursive: true }); cpSync(artifact, target, { recursive: true }); targets.push(target); symlinkSync(target, join(layout.prefix, 'current'));
  mkdirSync(join(layout.prefix, 'bin')); copyFileSync(process.execPath, join(layout.prefix, 'bin/bun'), constants.COPYFILE_FICLONE); chmodSync(join(layout.prefix, 'bin/bun'), 0o755);
  const config = { ...s15StageConfig(layout.state, 'http://localhost:3041'), files: true }; mkdirSync(dirname(layout.config), { recursive: true }); writeFileSync(layout.config, JSON.stringify(config), { mode: 0o600 });
  for (const args of [['src/main.ts', 'init', '--s15', '--config', layout.config], ['src/s16/operations-cli.ts', 'adopt', '--s15', '--config', layout.config, '--request-id', 'wiring_adopt']]) {
    const result = await spawnRunner([process.execPath, ...args], { cwd: target, env, timeoutMs: 30000 }); expect(result).toMatchObject({ exitCode: 0, timedOut: false });
  }
  for (const [key, path] of Object.entries(layout.files)) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, key === 'controller' ? `[Service]\nUser=jit-fixture\nGroup=jit-fixture\nExecStart=${layout.prefix}/bin/bun ${layout.prefix}/current/src/main.ts serve --s15 --config ${layout.config}\n\n[Install]\nWantedBy=multi-user.target\n` : `# Inert ${key} unit fixture; no systemd process runs.\n`, { mode: 0o644 }); }
  const original = readS16Wiring(layout, process.getuid!(), pathPolicy), absent = s16AbsentWiring(original.files.keyring);
  const input: S16WiringInput = { requestId: 'wiring_remove', direction: 'remove', originalRemovalRequestId: null, configPath: layout.config, configurationSha256: digest(config), operatorSha256: artifactHash, currentDirectory: target, currentSha256: artifactHash, priorWiringSha256: s16WiringSha256(original), targetWiringSha256: s16WiringSha256(absent) };
  const invoke = (method: 'prepare' | 'inspect' | 'arm' | 'complete', command = input, plan?: S16WiringPlan) => spawnRunner([process.execPath, '-e', `import{openS16WiringMaintenance}from'./ops/package/installer/s16-wiring-maintenance';const cap=openS16WiringMaintenance(${JSON.stringify(command)},{layoutRoot:${JSON.stringify(sandbox)},pathPolicy:${JSON.stringify(pathPolicy)}});try{const value=cap.${method}(${method === 'prepare' ? '' : JSON.stringify(plan)});cap.close();console.log(JSON.stringify(value??{state:'armed'}));}catch(error){try{cap.close();}catch{}console.log(error.message);process.exitCode=1;}`], { cwd: target, env, timeoutMs: 30000 });
  const prepare = async (command = input) => { const result = await invoke('prepare', command); expect(result).toMatchObject({ exitCode: 0, timedOut: false }); return JSON.parse(result.stdout) as S16WiringPlan; };
  const fence = join(layout.state, 'owner/owner.sqlite.ops/fence.json'), controlPath = join(layout.state, 'operations/control.json'), configBytes = readFileSync(layout.config), compositionPath = join(layout.state, 'runtime/composition.json'), composition = readFileSync(compositionPath);
  const retained = () => { expect(readFileSync(layout.config)).toEqual(configBytes); expect(readFileSync(compositionPath)).toEqual(composition); expect(validateArtifact(target, { runtime: true }).manifest?.contentHash).toBe(artifactHash); };
  const effects = { stops: 0, vmStops: 0, disabled: 0, restored: 0 }; let running = true;
  const supervisor: S16WiringSupervisor = { async assertRetained() { expect(readFileSync(layout.config)).toEqual(configBytes); }, async stop() { running = false; effects.stops++; }, async assertStopped() { if (running) throw Error('fixture_controller_still_running'); }, async stopWorkingVms() { effects.vmStops++; }, async removeActivation() { effects.disabled++; }, async restoreActivation() { effects.restored++; }, async reload() {} };
  const run: S16RootWiringJobOptions['run'] = async (argv, options) => {
    if (JSON.stringify(argv.slice(0, 6)) !== JSON.stringify(['/usr/sbin/runuser', '-u', 'jit-fixture', '--', '/usr/bin/env', '-i']) || !argv[10]?.endsWith('/s16-wiring-maintenance.ts')) throw Error('fixture_unexpected_wiring_command');
    return spawnRunner([argv[9]!, '-e', `import{openS16WiringMaintenance}from${JSON.stringify(argv[10])};const command=await Bun.stdin.json(),cap=openS16WiringMaintenance(command.input,{layoutRoot:${JSON.stringify(sandbox)},pathPolicy:${JSON.stringify(pathPolicy)}});try{const value=cap[command.method](command.plan);cap.close();console.log(JSON.stringify(value??{state:'armed'}));}catch(error){try{cap.close();}catch{}console.log(error.message);process.exitCode=1;}`], { ...options, env });
  };
  const rootInput: S16RootWiringJobInput = { requestId: 'root_wiring_remove', direction: 'remove', originalRemovalRequestId: null, bunPath: join(layout.prefix, 'bin/bun'), service: { user: 'jit-fixture', uid: process.getuid!(), gid: process.getgid!(), home: layout.home } };
  const rootOptions: S16RootWiringJobOptions = { supervisor, run, pathPolicy, layoutRoot: sandbox };
  const rootJob = (command = rootInput, after?: S16RootWiringJobOptions['after']) => openS16RootWiringJob(command, { ...rootOptions, ...(after ? { after } : {}) });
  const installedEffects = { starts: 0, stops: 0, vmStops: 0, managerMutations: 0, keyringEnablementWrites: 0 }; let pid = 900, controllerEnabled = true, keyringEnabled = true, keyringActive = true;
  const installedRun: NonNullable<S16RootWiringJobOptions['run']> = async (argv, options) => {
    const result = (stdout = '', exitCode = 0) => ({ exitCode, timedOut: false, stdout });
    if (argv[0] === '/usr/bin/getent') return result(`jit-fixture:x:${process.getuid!()}:${process.getgid!()}::${layout.home}:/usr/sbin/nologin\n`);
    const userManager = argv[0] === '/usr/sbin/runuser' && argv[10] === '/usr/bin/systemctl';
    if (userManager) {
      const operation = argv[12];
      if (operation === 'is-enabled') return result(keyringEnabled ? 'enabled\n' : 'disabled\n', keyringEnabled ? 0 : 1);
      if (operation === 'is-active') return result(keyringActive ? 'active\n' : 'inactive\n', keyringActive ? 0 : 3);
      if (operation === 'enable') { installedEffects.keyringEnablementWrites++; keyringEnabled = true; }
      else if (operation === 'disable') { installedEffects.keyringEnablementWrites++; keyringEnabled = false; if (argv.includes('--now')) keyringActive = false; }
      else if (operation === 'start') keyringActive = true;
      else if (operation === 'stop') keyringActive = false;
      else if (operation !== 'daemon-reload') throw Error('fixture_unexpected_user_manager_command');
      installedEffects.managerMutations++; return result();
    }
    if (argv[0] !== '/usr/bin/systemctl') return run!(argv, options);
    if (argv[1] === 'show') {
      const loaded = existsSync(layout.files.controller), fields: Record<string, string> = { LoadState: loaded ? 'loaded' : 'not-found', ActiveState: running ? 'active' : 'inactive', SubState: running ? 'running' : 'dead', MainPID: running ? String(pid) : '0', ControlPID: '0', Job: '', FragmentPath: loaded ? layout.files.controller : '', DropInPaths: '', NeedDaemonReload: 'no', User: loaded ? 'jit-fixture' : '', Group: loaded ? 'jit-fixture' : '', KillMode: 'mixed', SendSIGKILL: 'yes' };
      const selected = argv[3]!.slice('--property='.length).split(','); return result(selected.map(key => `${key}=${fields[key]}\n`).join(''));
    }
    if (argv[1] === 'is-enabled') return result(controllerEnabled ? 'enabled\n' : 'disabled\n', controllerEnabled ? 0 : 1);
    if (argv[1] === 'stop') { running = false; installedEffects.stops++; return result('', existsSync(layout.files.controller) ? 0 : 5); }
    if (argv[1] === 'start') { running = true; pid++; installedEffects.starts++; }
    else if (argv[1] === 'enable') controllerEnabled = true;
    else if (argv[1] === 'disable') controllerEnabled = false;
    else if (argv[1] !== 'daemon-reload') throw Error('fixture_unexpected_system_manager_command');
    installedEffects.managerMutations++; return result();
  };
  const installed = (direction: 'remove' | 'restore') => openS16InstalledWiring(direction, rootInput.bunPath, { run: installedRun, pathPolicy, layoutRoot: sandbox, user: 'jit-fixture', sleep: async () => {}, fetch: async () => new Response('', { status: 200 }), async stopWorkingVms() { installedEffects.vmStops++; } });
  return { layout, pathPolicy, target, original, input, invoke, prepare, fence, controlPath, retained, rootInput, rootJob, effects, installed, installedEffects };
}

test('actual sealed helper fences fixed wiring removal and exact restoration without replacing current SQL/native or composition', async () => {
  const f = await fixture(), plan = await f.prepare(); expect(existsSync(f.fence)).toBe(true);
  expect(await f.invoke('arm', f.input, plan)).toMatchObject({ exitCode: 0 });
  for (const path of [f.layout.files.controller, f.layout.files.journal, f.layout.files.proxy]) unlinkSync(path);
  const removed = await f.invoke('complete', f.input, plan); expect(removed).toMatchObject({ exitCode: 0 }); const receipt = JSON.parse(removed.stdout) as S16WiringReceipt;
  expect(receipt).toMatchObject({ contract: 's16-installed-wiring-result/v1', operationId: plan.operationId }); expect(existsSync(f.fence)).toBe(false); f.retained();
  const restore: S16WiringInput = { ...f.input, requestId: 'wiring_restore', direction: 'restore', originalRemovalRequestId: f.input.requestId, priorWiringSha256: f.input.targetWiringSha256, targetWiringSha256: f.input.priorWiringSha256 }, restorePlan = await f.prepare(restore);
  expect(restorePlan.cohort).toEqual(plan.cohort); expect(await f.invoke('arm', restore, restorePlan)).toMatchObject({ exitCode: 0 });
  for (const [key, path] of Object.entries(f.layout.files)) { if (key === 'keyring') continue; const original = f.original.files[key as keyof typeof f.original.files]!; writeFileSync(path, Buffer.from(original.bytes, 'base64'), { flag: 'wx', mode: original.mode }); }
  expect(await f.invoke('complete', restore, restorePlan)).toMatchObject({ exitCode: 0 }); expect(existsSync(f.fence)).toBe(false);
  expect(readS16Wiring(f.layout, process.getuid!(), f.pathPolicy)).toEqual(f.original); f.retained();
  const later = readFileSync(f.controlPath); expect(JSON.parse((await f.invoke('complete', f.input, plan)).stdout)).toEqual(receipt); expect(readFileSync(f.controlPath)).toEqual(later); expect(readS16Wiring(f.layout, process.getuid!(), f.pathPolicy)).toEqual(f.original);
}, 90000);

test('changed current SQL after original wiring intent refuses completion and retains the original gate and later data', async () => {
  const f = await fixture(), plan = await f.prepare(); expect(await f.invoke('arm', f.input, plan)).toMatchObject({ exitCode: 0 });
  for (const path of [f.layout.files.controller, f.layout.files.journal, f.layout.files.proxy]) unlinkSync(path);
  const database = new Database(join(f.layout.state, 'runtime/work.sqlite'), { create: false, readwrite: true }); database.exec('CREATE TABLE fixture_later(value TEXT); INSERT INTO fixture_later VALUES (\'Retain later current data\')'); database.close();
  const result = await f.invoke('complete', f.input, plan); expect(result.exitCode).toBe(1); expect(existsSync(f.fence)).toBe(true);
  const retained = new Database(join(f.layout.state, 'runtime/work.sqlite'), { readonly: true }); expect(retained.query('SELECT value FROM fixture_later').get()).toEqual({ value: 'Retain later current data' }); retained.close(); f.retained();
}, 90000);

test('missing actual wiring readback cannot complete an unperformed intent', async () => {
  const f = await fixture(), plan = await f.prepare(); expect(await f.invoke('arm', f.input, plan)).toMatchObject({ exitCode: 0 });
  const before = readFileSync(f.controlPath); expect((await f.invoke('complete', f.input, plan)).exitCode).toBe(1); expect(readFileSync(f.controlPath)).toEqual(before); expect(existsSync(f.fence)).toBe(true);
  expect(readS16Wiring(f.layout, process.getuid!(), f.pathPolicy)).toEqual(f.original); f.retained();
}, 90000);

test('a partial physical removal retries only its original actual intent, never phase alone', async () => {
  const f = await fixture(), plan = await f.prepare();
  expect(JSON.parse((await f.invoke('inspect', f.input, plan)).stdout)).toEqual({ armed: false, receipt: null });
  expect(await f.invoke('arm', f.input, plan)).toMatchObject({ exitCode: 0 }); unlinkSync(f.layout.files.controller);
  expect(JSON.parse((await f.invoke('inspect', f.input, plan)).stdout)).toEqual({ armed: true, receipt: null });
  const original = readFileSync(f.controlPath); expect(await f.invoke('arm', f.input, plan)).toMatchObject({ exitCode: 0 }); expect(readFileSync(f.controlPath)).toEqual(original);
  for (const path of [f.layout.files.journal, f.layout.files.proxy]) unlinkSync(path);
  expect(await f.invoke('complete', f.input, plan)).toMatchObject({ exitCode: 0 }); expect(existsSync(f.fence)).toBe(false); f.retained();
}, 90000);

test('root job removes and restores only original root units through actual sealed helper intents; historical retry is inert', async () => {
  const f = await fixture(), remove = f.rootJob(); let removed;
  try { removed = await remove.run(); } finally { remove.close(); }
  expect(removed.direction).toBe('remove'); expect(readS16Wiring(f.layout, process.getuid!(), f.pathPolicy)).toEqual(s16AbsentWiring(f.original.files.keyring)); expect(f.effects).toEqual({ stops: 1, vmStops: 1, disabled: 1, restored: 0 }); f.retained();
  const restoreInput: S16RootWiringJobInput = { ...f.rootInput, requestId: 'root_wiring_restore', direction: 'restore', originalRemovalRequestId: f.rootInput.requestId }, restore = f.rootJob(restoreInput); let restored;
  try { restored = await restore.run(); } finally { restore.close(); }
  expect(restored.direction).toBe('restore'); expect(readS16Wiring(f.layout, process.getuid!(), f.pathPolicy)).toEqual(f.original); expect(existsSync(f.fence)).toBe(false); f.retained();
  const previous = { ...f.effects }, control = readFileSync(f.controlPath), retry = f.rootJob();
  try { expect(await retry.run()).toEqual(removed); } finally { retry.close(); }
  expect(f.effects).toEqual(previous); expect(readFileSync(f.controlPath)).toEqual(control); expect(readS16Wiring(f.layout, process.getuid!(), f.pathPolicy)).toEqual(f.original);
}, 120000);

test.each(['remove', 'restore'] as const)('root %s resumes partial actual unit publication from original private plans', async direction => {
  const f = await fixture(); let command = f.rootInput;
  if (direction === 'restore') { const remove = f.rootJob(); try { await remove.run(); } finally { remove.close(); } command = { ...command, requestId: 'root_wiring_restore', direction, originalRemovalRequestId: f.rootInput.requestId }; }
  let interrupted = false; const first = f.rootJob(command, at => { if (at === 'file' && !interrupted) { interrupted = true; throw Error('fixture_root_file_interrupted'); } });
  try { await expect(first.run()).rejects.toThrow('fixture_root_file_interrupted'); } finally { first.close(); }
  expect(existsSync(f.fence)).toBe(true); const resume = f.rootJob(command);
  try { expect((await resume.run()).direction).toBe(direction); } finally { resume.close(); }
  expect(readS16Wiring(f.layout, process.getuid!(), f.pathPolicy)).toEqual(direction === 'remove' ? s16AbsentWiring(f.original.files.keyring) : f.original); expect(existsSync(f.fence)).toBe(false); f.retained();
}, 120000);

test('installed dispatcher removes and reinstalls original wiring/activation then boots once; healthy rerun does not restart', async () => {
  const f = await fixture(), remove = f.installed('remove');
  try { expect(await remove.run()).toMatchObject({ state: 'removed', health: 'not_observed' }); } finally { remove.close(); }
  expect(readS16Wiring(f.layout, process.getuid!(), f.pathPolicy)).toEqual(s16AbsentWiring(f.original.files.keyring)); expect(f.installedEffects.vmStops).toBe(1); expect(f.installedEffects.starts).toBe(0); f.retained();
  const restore = f.installed('restore');
  try { expect(await restore.run()).toMatchObject({ state: 'restored', health: 'healthy' }); } finally { restore.close(); }
  expect(readS16Wiring(f.layout, process.getuid!(), f.pathPolicy)).toEqual(f.original); expect(f.installedEffects.starts).toBe(1); expect(existsSync(f.fence)).toBe(false); f.retained();
  expect(f.installedEffects.keyringEnablementWrites).toBe(0);
  const before = { ...f.installedEffects }, control = readFileSync(f.controlPath), retry = f.installed('restore');
  try { expect(await retry.run()).toMatchObject({ state: 'restored', health: 'healthy' }); } finally { retry.close(); }
  expect(f.installedEffects).toEqual(before); expect(readFileSync(f.controlPath)).toEqual(control); f.retained();
  const second = f.installed('remove'); try { expect((await second.run()).state).toBe('removed'); } finally { second.close(); }
  expect(f.installedEffects.vmStops).toBe(2); const current = JSON.parse(readFileSync(f.controlPath, 'utf8')); expect(current.requests.filter((row: { kind: string }) => row.kind === 'uninstall')).toHaveLength(2); f.retained();
}, 180000);

test('restoration cannot use a missing independently confirmed original uninstall', async () => {
  const f = await fixture(), remove = f.rootJob(); try { await remove.run(); } finally { remove.close(); }
  const restore: S16WiringInput = { ...f.input, requestId: 'forged_restore', direction: 'restore', originalRemovalRequestId: 'missing_original_uninstall', priorWiringSha256: f.input.targetWiringSha256, targetWiringSha256: f.input.priorWiringSha256 };
  const control = readFileSync(f.controlPath), result = await f.invoke('prepare', restore); expect(result.exitCode).toBe(1); expect(result.stdout.trim()).toBe('s16_wiring_original_removal_unconfirmed');
  expect(readFileSync(f.controlPath)).toEqual(control); expect(existsSync(f.fence)).toBe(false); expect(readS16Wiring(f.layout, process.getuid!(), f.pathPolicy)).toEqual(s16AbsentWiring(f.original.files.keyring)); f.retained();
}, 90000);

test('an occupied different root unit refuses partial restoration without overwriting it or clearing the original gate', async () => {
  const f = await fixture(), remove = f.rootJob(); try { await remove.run(); } finally { remove.close(); }
  const command: S16RootWiringJobInput = { ...f.rootInput, requestId: 'root_wiring_restore', direction: 'restore', originalRemovalRequestId: f.rootInput.requestId }, first = f.rootJob(command, at => { if (at === 'file') throw Error('fixture_interrupted_restore'); });
  try { await expect(first.run()).rejects.toThrow('fixture_interrupted_restore'); } finally { first.close(); }
  const unexpected = '# Preserve unexpected root unit custody.\n'; writeFileSync(f.layout.files.journal, unexpected, { mode: 0o644 });
  const resume = f.rootJob(command); try { await expect(resume.run()).rejects.toThrow('s16_root_wiring_file_changed'); } finally { resume.close(); }
  expect(readFileSync(f.layout.files.journal, 'utf8')).toBe(unexpected); expect(existsSync(f.fence)).toBe(true); f.retained();
}, 120000);
