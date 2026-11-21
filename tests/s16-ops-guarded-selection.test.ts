import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { chmodSync, constants, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { RELEASE_CONTRACT } from 'schway/host';
import { buildPackage, installArtifactDependencies, readDependencyRecord, validateArtifact } from '../ops/package/bun-build';
import { openS16PackageReaderProbe } from '../ops/package/installer/s16-package-probe';
import { openS16RootReleaseSelector, type S16RootReleaseSelector } from '../ops/package/installer/s16-release-selector';
import type { S16GuardedSelectionInput, S16GuardedSelectionPlan, S16GuardedSelectionReader } from '../ops/package/installer/s16-guarded-selection';
import { openS16ReleaseJob, type S16ReleaseJob } from '../ops/package/installer/s16-release-job';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { spawnRunner, type CommandRunner } from '../src/ops/supervisor';
import { canonical } from '../src/s15/conversation/validation';
import { opsDirectory, opsWrite } from '../src/s14/ops-files';
import { s16ReleaseFixtureRunner } from './fixtures/s16-release-job';

let root: string, prefix: string;
interface FixturePackage { path: string; hash: string; sourceCommit: string; lockHash: string; dependencyHash: string; dependencyFiles: number }
let incompatible: FixturePackage;
const packages: FixturePackage[] = [], caps: S16RootReleaseSelector[] = [], jobs: S16ReleaseJob[] = [];
const env = { PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin' };
const digest = (value: unknown) => new Bun.CryptoHasher('sha256').update(canonical(value)).digest('hex');
beforeAll(async () => {
  const receipt = process.env.JIT_S16_GUARDED_RELEASE_RECEIPT;
  if (receipt && (!isAbsolute(receipt) || existsSync(receipt))) throw Error('fixture_receipt_must_be_fresh_absolute_path');
  if (receipt) opsDirectory(dirname(receipt));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-guarded-selection-'))); prefix = join(root, 'opt/jit-s15');
  mkdirSync(join(prefix, 'bin'), { recursive: true }); copyFileSync(process.execPath, join(prefix, 'bin/bun'), constants.COPYFILE_FICLONE); chmodSync(join(prefix, 'bin/bun'), 0o755);
  for (const [name, revision] of [['a', '23cfb85d1051ab52b42fefd421c85cd86388f6c3'], ['b', null], ['incompatible', '4e2a80f82c6345f23f97d531aa8a0dc2b53a0d0e']] as const) {
    let source = process.cwd();
    if (revision) {
      source = join(root, name + '-source'); mkdirSync(source, { mode: 0o700 }); const archive = join(root, name + '.tar');
      const archived = Bun.spawnSync(['git', 'archive', '--format=tar', '--output=' + archive, revision], { env, stdout: 'pipe', stderr: 'pipe' });
      if (archived.exitCode !== 0 || Bun.spawnSync(['/usr/bin/tar', '-xf', archive, '-C', source], { env, stdout: 'pipe', stderr: 'pipe' }).exitCode !== 0) throw Error('fixture_archive_failed');
    }
    const staging = join(root, name), manifest = buildPackage({ srcDir: source, outDir: staging, engineContract: RELEASE_CONTRACT, engineRevision: null });
    const dependencies = await installArtifactDependencies(staging, { bunPath: process.execPath, run: spawnRunner, env, timeoutMs: 120000 });
    const path = join(prefix, 'releases', manifest.artifactId); mkdirSync(dirname(path), { recursive: true }); renameSync(staging, path);
    const pkg = { path, hash: manifest.contentHash, sourceCommit: revision ?? Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString().trim(), lockHash: manifest.lockHash, dependencyHash: dependencies.dependencyHash, dependencyFiles: dependencies.dependencyFiles };
    if (name === 'incompatible') incompatible = pkg; else packages.push(pkg);
  }
}, 120000);
afterEach(() => { for (const job of jobs.splice(0).reverse()) job.close(); for (const cap of caps.splice(0).reverse()) cap.close(); if (prefix) rmSync(join(prefix, 'current'), { force: true }); });
afterAll(() => {
  try {
    for (const pkg of [...packages, incompatible]) { const checked = validateArtifact(pkg.path, { runtime: true }); expect(checked.ok && checked.manifest?.contentHash === pkg.hash && readDependencyRecord(pkg.path)?.dependencyHash === pkg.dependencyHash).toBe(true); }
    const receipt = process.env.JIT_S16_GUARDED_RELEASE_RECEIPT;
    if (receipt) {
      const source = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' }), status = Bun.spawnSync(['git', 'status', '--porcelain'], { stdout: 'pipe', stderr: 'ignore' });
      opsWrite(receipt, JSON.stringify({ contract: 's16-guarded-release-artifact-evidence/v1', sourceCommit: source.stdout.toString().trim(), sourceState: source.exitCode === 0 && status.exitCode === 0 && !status.stdout.length && packages[1]?.sourceCommit === source.stdout.toString().trim() ? 'clean' : 'unverified',
        packages: [...packages, incompatible].map(({ path: _path, ...pkg }) => pkg), platform: process.platform, arch: process.arch, bunVersion: Bun.version, engineContract: RELEASE_CONTRACT, engineRevision: 'unverified',
        driverSha256: new Bun.CryptoHasher('sha256').update(readFileSync(import.meta.path)).digest('hex'), runnerSha256: new Bun.CryptoHasher('sha256').update(readFileSync(join(import.meta.dir, 'fixtures/s16-release-job.ts'))).digest('hex'), artifactsAfter: 'verified_unchanged', testOutcomes: 'separate_test_log_required',
        controller: 'actual_copied_protected_operations', rootSelection: 'actual_filesystem_and_process_lease', native: 'explicit_empty_set_current_deep_verification', supervisor: 'scripted_fixture', identityTransition: 'fixture_runner_not_linux_enforcement', serviceClientLifecycle: 'not_exercised', liveAccounts: false, nativeDevices: 'not_exercised' }));
    }
  } finally { if (root) rmSync(root, { recursive: true, force: true }); }
});
async function run(directory: string, args: string[], timeoutMs = 25000) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: directory, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }), timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
  try { const [exit, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { exit, out, error }; } finally { clearTimeout(timer); }
}
async function fixture() {
  const state = realpathSync(mkdtempSync(join(root, 'state-'))), config = join(state, 'config.json'), directory = join(state, 'installation');
  const configured = { ...s15StageConfig(directory, 'http://localhost:3041'), files: true }; writeFileSync(config, JSON.stringify(configured), { mode: 0o600 });
  const initialized = await run(packages[1]!.path, ['src/main.ts', 'init', '--s15', '--config', config]); expect({ exit: initialized.exit, error: initialized.error }).toEqual({ exit: 0, error: '' });
  const adopted = await run(packages[1]!.path, ['src/s16/operations-cli.ts', 'adopt', '--s15', '--config', config, '--request-id', 'adopt_original']); expect({ exit: adopted.exit, error: adopted.error }).toEqual({ exit: 0, error: '' });
  symlinkSync(packages[0]!.path, join(prefix, 'current'));
  const policy = { root, uid: process.getuid!() }, selector = openS16RootReleaseSelector({ prefix, pathPolicy: policy }); caps.push(selector); selector.acquire();
  const input: S16GuardedSelectionInput = { requestId: 'upgrade_original', configPath: config, configurationSha256: digest(configured), operatorSha256: packages[1]!.hash, prefix,
    sourceDirectory: packages[0]!.path, sourceSha256: packages[0]!.hash, targetDirectory: packages[1]!.path, targetSha256: packages[1]!.hash };
  const marker = join(state, 'reached.fixture');
  const invoke = (method: 'prepare' | 'arm' | 'complete' | 'abort', plan?: S16GuardedSelectionPlan, readers?: S16GuardedSelectionReader[], boundary?: string) => run(packages[1]!.path, ['-e', `import{writeFileSync}from'node:fs';import{openS16GuardedSelection}from'./ops/package/installer/s16-guarded-selection';const cap=openS16GuardedSelection(${JSON.stringify(input)},{pathPolicy:${JSON.stringify(policy)},after(at){if(at===${JSON.stringify(boundary ?? '')}){writeFileSync(${JSON.stringify(marker)},at,{mode:0o600});process.kill(process.pid,'SIGKILL');}}});try{const value=await cap.${method === 'abort' ? 'abortBeforeSelection' : method}(${method === 'prepare' ? '' : JSON.stringify(plan) + (method === 'arm' ? ',' + JSON.stringify(readers) : method === 'abort' ? ',' + JSON.stringify(readers?.[0]) : '')});await cap.close();console.log(JSON.stringify(value??{state:'armed'}));}catch(error){try{await cap.close();}catch{}console.error(error.message);process.exitCode=1;}`]);
  const controlPath = join(directory, 'operations/control.json'), fencePath = join(directory, 'owner/owner.sqlite.ops/fence.json'), control = () => JSON.parse(readFileSync(controlPath, 'utf8'));
  const prepare = async () => { const result = await invoke('prepare'); expect({ exit: result.exit, error: result.error }).toEqual({ exit: 0, error: '' }); return JSON.parse(result.out) as S16GuardedSelectionPlan; };
  const readers = async (plan: S16GuardedSelectionPlan) => {
    const observed: S16GuardedSelectionReader[] = [];
    for (const pkg of packages) {
      const probe = await openS16PackageReaderProbe({ targetDirectory: pkg.path, packageSha256: pkg.hash, configPath: config, configurationSha256: input.configurationSha256 }, { pathPolicy: policy });
      let observation; try { observation = await probe.observe(); } finally { probe.close(); }
      const terminal = await run(pkg.path, ['src/s16/operations-cli.ts', 'backup', '--s15', '--config', config, '--request-id', plan.backup.requestId]);
      expect({ exit: terminal.exit, error: terminal.error }).toEqual({ exit: 0, error: '' }); observed.push({ observation, backup: JSON.parse(terminal.out) });
    } return observed;
  };
  const laterFile = () => run(packages[1]!.path, ['-e', `import{join}from'node:path';import{readS15RuntimeConfig}from'./src/s15/runtime-config';import{openS16ControlMaintenance}from'./src/s16/operations/control-maintenance';import{FileStore}from'./src/s16/files/store';const config=readS15RuntimeConfig(${JSON.stringify(config)}),ctx=openS16ControlMaintenance(config),ownerId=ctx.ownerIdentity;ctx.close();const store=new FileStore({path:join(config.directory,'runtime/files.sqlite'),directory:join(config.directory,'runtime/file-bytes'),installationId:config.installationId,create:false,resource:{id:'computer',revision:1,generation:1},requireOwner:()=>({id:ownerId,generation:1})});try{const bytes=Buffer.from('Later current protected input.'),upload=store.create({},{requestId:'later_input',conversationId:'conversation',name:'later.txt',bytes:bytes.length,sha256:new Bun.CryptoHasher('sha256').update(bytes).digest('hex')});await store.write({},upload.id,new Blob([bytes]).stream());console.log(JSON.stringify({id:upload.id}));}finally{await store.close();}`]);
  return { input, invoke, selector, control, controlPath, fencePath, prepare, readers, marker, laterFile, directory };
}

test('actual sealed packages arm original controller intent before root selection and complete without replacing current state', async () => {
  const f = await fixture(), plan = await f.prepare(), before = readFileSync(f.controlPath), original = f.control().requests.find((row: { requestId: string }) => row.requestId === f.input.requestId);
  expect(original).toMatchObject({ phase: 'capturing', status: 'running', actions: [{ kind: 'capture_backend', state: 'intent' }] }); expect(existsSync(f.fencePath)).toBe(true);
  const observations = await f.readers(plan); expect(readFileSync(f.controlPath)).toEqual(before);
  const armed = await f.invoke('arm', plan, observations); expect({ exit: armed.exit, error: armed.error }).toEqual({ exit: 0, error: '' });
  expect(f.control().requests.at(-1)).toMatchObject({ id: original.id, phase: 'activating', actions: [{ kind: 'capture_backend', state: 'confirmed' }, { kind: 'select_package', state: 'intent' }] });
  f.selector.select(f.selector.read().sha256, f.input.targetDirectory, f.input.targetSha256);
  const completed = await f.invoke('complete', plan); expect({ exit: completed.exit, error: completed.error }).toEqual({ exit: 0, error: '' });
  expect(JSON.parse(completed.out)).toMatchObject({ state: 'selected', operationId: original.id }); expect(existsSync(f.fencePath)).toBe(false); expect(f.control().points).toHaveLength(1);
  const done = readFileSync(f.controlPath); expect(await f.invoke('complete', plan)).toEqual(completed); expect(readFileSync(f.controlPath)).toEqual(done);
}, 30000);

test('completion before root effect refuses and leaves the original intent and fence available for retry', async () => {
  const f = await fixture(), plan = await f.prepare(), observations = await f.readers(plan); expect((await f.invoke('arm', plan, observations)).exit).toBe(0);
  const before = readFileSync(f.controlPath), fence = readFileSync(f.fencePath), refused = await f.invoke('complete', plan);
  expect(refused).toMatchObject({ exit: 1, error: 's16_release_selection_target_changed\n' }); expect(readFileSync(f.controlPath)).toEqual(before); expect(readFileSync(f.fencePath)).toEqual(fence);
  f.selector.select(f.selector.read().sha256, f.input.targetDirectory, f.input.targetSha256); expect((await f.invoke('complete', plan)).exit).toBe(0);
}, 30000);

test.each(['plan', 'reader', 'terminal', 'missing_reader'] as const)('changed %s refuses before arming or changing root selection', async mode => {
  const f = await fixture(), plan = await f.prepare(), observations = await f.readers(plan), before = readFileSync(f.controlPath), value = f.selector.read();
  if (mode === 'plan') plan.createdAt++;
  if (mode === 'reader') observations[0]!.observation = { ...observations[0]!.observation, configurationSha256: '0'.repeat(64) };
  if (mode === 'terminal') observations[0]!.backup = { ...observations[0]!.backup, pointId: '0'.repeat(32) };
  if (mode === 'missing_reader') observations.pop();
  const result = await f.invoke('arm', plan, observations); expect(result.exit).toBe(1); expect(readFileSync(f.controlPath)).toEqual(before); expect(existsSync(f.fencePath)).toBe(true); expect(f.selector.read()).toEqual(value);
}, 30000);

test.each(['backup', 'admitted', 'planned'] as const)('marked actual SIGKILL at %s resumes the original preparation without another point or request', async boundary => {
  const f = await fixture(), killed = await f.invoke('prepare', undefined, undefined, boundary); expect(killed.exit).not.toBe(0); expect(killed.error).toBe(''); expect(readFileSync(f.marker, 'utf8')).toBe(boundary);
  const before = f.control(), original = before.requests.find((row: { kind: string }) => row.kind === 'upgrade'), plan = await f.prepare();
  expect(f.control().points).toHaveLength(1); expect(f.control().requests.filter((row: { kind: string }) => row.kind === 'backup')).toHaveLength(1); expect(f.control().requests.filter((row: { kind: string }) => row.kind === 'upgrade')).toHaveLength(1);
  if (original) expect(plan).toMatchObject({ operationId: original.id, admittedRevision: original.admittedRevision, createdAt: original.createdAt });
  expect(existsSync(f.fencePath)).toBe(true); expect(f.selector.read().targetDirectory).toBe(f.input.sourceDirectory);
}, 30000);

test('a killed pre-admission backup cannot be rebound to later owning FileStore activity', async () => {
  const f = await fixture(), killed = await f.invoke('prepare', undefined, undefined, 'backup'); expect(killed.exit).not.toBe(0); expect(readFileSync(f.marker, 'utf8')).toBe('backup'); expect(existsSync(f.fencePath)).toBe(false);
  const written = await f.laterFile(); expect({ exit: written.exit, error: written.error }).toEqual({ exit: 0, error: '' }); const upload = JSON.parse(written.out), before = readFileSync(f.controlPath), path = join(f.directory, 'runtime/file-bytes', upload.id + '.blob'), bytes = readFileSync(path);
  const refused = await f.invoke('prepare'); expect(refused).toMatchObject({ exit: 1, error: 's16_release_selection_backup_not_current\n' });
  expect(readFileSync(f.controlPath)).toEqual(before); expect(readFileSync(path)).toEqual(bytes); expect(f.control().requests.some((row: { kind: string }) => row.kind === 'upgrade')).toBe(false); expect(existsSync(f.fencePath)).toBe(false);
}, 30000);

// Actual disposable filesystem/controller/helper processes; only supervisor and UID
// transition are explicit fixture ports. This does not establish Linux enforcement.
function fixtureServiceRunner(): CommandRunner { return s16ReleaseFixtureRunner(root, env); }

test('a stale root job refuses an unrelated current executable before stopping any service or admitting an upgrade', async () => {
  const f = await fixture();
  f.selector.select(f.selector.read().sha256, incompatible.path, incompatible.hash); f.selector.close();
  const before = readFileSync(f.controlPath); let stops = 0;
  const service = { async stop() { stops++; }, async assertStopped() {}, async start() {}, async healthy() { return true; } };
  const job = openS16ReleaseJob({ selection: f.input, operatorDirectory: packages[1]!.path, bunPath: join(prefix, 'bin/bun'), service: { user: 'jit-fixture', uid: process.getuid!() || 1001, home: root } }, { service, run: fixtureServiceRunner(), pathPolicy: { root, uid: process.getuid!() } }); jobs.push(job);
  await expect(job.run()).rejects.toThrow('s16_release_job_current_changed'); expect(stops).toBe(0); expect(readFileSync(f.controlPath)).toEqual(before); expect(existsSync(f.fencePath)).toBe(false);
}, 30000);

for (const trialFailure of [false, true]) test('root job ' + (trialFailure ? 'falls back over fresh current owning file activity' : 'starts the selected package and returns an inert historical result on retry'), async () => {
  const f = await fixture(); f.selector.close(); f.input.requestId = 'root_job_' + crypto.randomUUID().replaceAll('-', '');
  let active = true, stops = 0, starts = 0, laterId: string | undefined;
  const service = { async stop() { stops++; active = false; }, async assertStopped() { if (active) throw Error('fixture_service_still_active'); }, async start() {
    starts++; active = true; if (trialFailure && starts === 1) { const result = await f.laterFile(); expect({ exit: result.exit, error: result.error }).toEqual({ exit: 0, error: '' }); laterId = JSON.parse(result.out).id; }
  }, async healthy() { return !trialFailure || starts > 1; } };
  const job = openS16ReleaseJob({ selection: f.input, operatorDirectory: packages[1]!.path, bunPath: join(prefix, 'bin/bun'), service: { user: 'jit-fixture', uid: process.getuid!() || 1001, home: root } }, { service, run: fixtureServiceRunner(), pathPolicy: { root, uid: process.getuid!() } }); jobs.push(job);
  const result = await job.run(); expect(result.outcome).toBe(trialFailure ? 'fallback_healthy' : 'selected_healthy'); expect(active).toBe(true); expect(existsSync(f.fencePath)).toBe(false);
  expect(f.control().requests.filter((row: { kind: string }) => row.kind === 'upgrade')).toHaveLength(trialFailure ? 2 : 1); expect(f.control().points).toHaveLength(trialFailure ? 2 : 1);
  if (trialFailure) { expect(result.fallback?.state).toBe('selected'); expect(readFileSync(join(f.directory, 'runtime/file-bytes', laterId! + '.blob'), 'utf8')).toBe('Later current protected input.'); }
  const counts = { stops, starts }, control = readFileSync(f.controlPath); expect(await job.run()).toEqual(result); expect({ stops, starts }).toEqual(counts); expect(readFileSync(f.controlPath)).toEqual(control);
}, 90000);

test('an earlier actual reader can read the cohort but fails completed-backup semantics without changing the original gate', async () => {
  const f = await fixture(), plan = await f.prepare(), before = readFileSync(f.controlPath), fence = readFileSync(f.fencePath);
  const probe = await openS16PackageReaderProbe({ targetDirectory: incompatible.path, packageSha256: incompatible.hash, configPath: f.input.configPath, configurationSha256: f.input.configurationSha256 }, { pathPolicy: { root, uid: process.getuid!() } });
  try { expect((await probe.observe()).state).toBe('readable'); } finally { probe.close(); }
  const terminal = await run(incompatible.path, ['src/s16/operations-cli.ts', 'backup', '--s15', '--config', f.input.configPath, '--request-id', plan.backup.requestId]);
  expect(terminal.exit).toBe(1); expect(JSON.parse(terminal.error).error).toBe('s16_ops_request_conflict'); expect(readFileSync(f.controlPath)).toEqual(before); expect(readFileSync(f.fencePath)).toEqual(fence); expect(f.selector.read().targetDirectory).toBe(f.input.sourceDirectory);
}, 30000);

test('fresh source readership can discard only a pre-selection plan and its terminal retry preserves later owning activity', async () => {
  const f = await fixture(), plan = await f.prepare(), observations = await f.readers(plan), aborted = await f.invoke('abort', plan, observations);
  expect({ exit: aborted.exit, error: aborted.error }).toEqual({ exit: 0, error: '' }); expect(JSON.parse(aborted.out)).toMatchObject({ state: 'not_selected', operationId: plan.operationId }); expect(existsSync(f.fencePath)).toBe(false);
  expect(f.control().requests.at(-1)).toMatchObject({ phase: 'discarded', status: 'discarded', actions: [{ kind: 'capture_backend', state: 'confirmed' }] });
  expect((await f.laterFile()).exit).toBe(0); const before = readFileSync(f.controlPath); expect(await f.invoke('abort', plan, observations)).toEqual(aborted); expect(readFileSync(f.controlPath)).toEqual(before); expect(f.selector.read().targetDirectory).toBe(f.input.sourceDirectory);
}, 30000);

test('an original selector intent prevents pre-selection abort even before the physical path changed', async () => {
  const f = await fixture(), plan = await f.prepare(), observations = await f.readers(plan); expect((await f.invoke('arm', plan, observations)).exit).toBe(0);
  const before = readFileSync(f.controlPath), fence = readFileSync(f.fencePath), refused = await f.invoke('abort', plan, observations);
  expect(refused).toMatchObject({ exit: 1, error: 's16_release_selection_abort_unsafe\n' }); expect(readFileSync(f.controlPath)).toEqual(before); expect(readFileSync(f.fencePath)).toEqual(fence); expect(f.selector.read().targetDirectory).toBe(f.input.sourceDirectory);
}, 30000);

test('a reported unsupported fallback reader releases only its unarmed gate after fresh actual current-source proof', async () => {
  const f = await fixture(); f.selector.close(); f.input.requestId = 'unsupported_job_' + crypto.randomUUID().replaceAll('-', '');
  let active = true, starts = 0, stops = 0, laterId = '';
  const actual = fixtureServiceRunner(), run: CommandRunner = async (argv, settings) => {
    // Explicit target-reader fault; source proof/backup/abort use actual sealed processes.
    if (starts && argv[10]?.endsWith('/s16-package-probe.ts') && argv.includes(f.input.sourceDirectory)) return { exitCode: 1, stdout: '', timedOut: false };
    return actual(argv, settings);
  };
  const service = { async stop() { active = false; stops++; }, async assertStopped() { if (active) throw Error('fixture_not_stopped'); }, async start() { active = true; starts++; const result = await f.laterFile(); expect(result.exit).toBe(0); laterId = JSON.parse(result.out).id; }, async healthy() { return false; } };
  const job = openS16ReleaseJob({ selection: f.input, operatorDirectory: packages[1]!.path, bunPath: join(prefix, 'bin/bun'), service: { user: 'jit-fixture', uid: process.getuid!() || 1001, home: root } }, { service, run, pathPolicy: { root, uid: process.getuid!() } }); jobs.push(job);
  await expect(job.run()).rejects.toThrow('s16_release_job_forward_recovery_required');
  expect(active).toBe(false); expect(existsSync(f.fencePath)).toBe(false); expect(f.control().requests.filter((row: { kind: string; status: string }) => row.kind === 'upgrade').map((row: { status: string }) => row.status)).toEqual(['complete', 'discarded']);
  expect(readFileSync(join(f.directory, 'runtime/file-bytes', laterId + '.blob'), 'utf8')).toBe('Later current protected input.');
  const counts = { starts, stops }, before = readFileSync(f.controlPath); await expect(job.run()).rejects.toThrow('s16_release_job_forward_recovery_required'); expect({ starts, stops }).toEqual(counts); expect(readFileSync(f.controlPath)).toEqual(before);
}, 90000);

test.each(['stopped', 'plan', 'armed', 'selected', 'completed', 'trial', 'result'] as const)('marked actual root SIGKILL at %s resumes original request/point and conclusive service orchestration', async boundary => {
  const f = await fixture(); f.selector.close(); f.input.requestId = 'root_kill_' + crypto.randomUUID().replaceAll('-', '');
  const counters = join(dirname(f.input.configPath), 'service.fixture.json'), marker = join(dirname(f.input.configPath), 'root-reached.fixture');
  const jobInput = { selection: f.input, operatorDirectory: packages[1]!.path, bunPath: join(prefix, 'bin/bun'), service: { user: 'jit-fixture', uid: process.getuid!() || 1001, home: root } };
  const invoke = (at: string) => run(packages[1]!.path, ['-e', `import{existsSync,readFileSync,writeFileSync}from'node:fs';import{openS16ReleaseJob}from'./ops/package/installer/s16-release-job';import{s16ReleaseFixtureRunner}from${JSON.stringify(join(process.cwd(), 'tests/fixtures/s16-release-job.ts'))};const path=${JSON.stringify(counters)},counts=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{active:true,stops:0,starts:0},save=()=>writeFileSync(path,JSON.stringify(counts),{mode:0o600}),service={async stop(){counts.active=false;counts.stops++;save();},async assertStopped(){if(counts.active)throw Error('fixture_not_stopped');},async start(){counts.active=true;counts.starts++;save();},async healthy(){return true;}};const job=openS16ReleaseJob(${JSON.stringify(jobInput)},{service,run:s16ReleaseFixtureRunner(${JSON.stringify(root)},${JSON.stringify(env)}),pathPolicy:${JSON.stringify({ root, uid: process.getuid!() })},after(boundary){if(boundary===${JSON.stringify(at)}){writeFileSync(${JSON.stringify(marker)},boundary,{mode:0o600});process.kill(process.pid,'SIGKILL');}}});try{const result=await job.run();job.close();console.log(JSON.stringify(result));}catch(error){try{job.close();}catch{}console.error(error);process.exitCode=1;}`], 60000);
  const killed = await invoke(boundary); expect(killed.exit).not.toBe(0); expect(killed.error).toBe(''); expect(readFileSync(marker, 'utf8')).toBe(boundary);
  const interrupted = f.control(), original = interrupted.requests.find((row: { kind: string }) => row.kind === 'upgrade'), counts = readFileSync(counters);
  const resumed = await invoke(''); expect({ exit: resumed.exit, error: resumed.error }).toEqual({ exit: 0, error: '' });
  const receipt = JSON.parse(resumed.out); expect(receipt.outcome).toBe('selected_healthy'); if (original) expect(receipt.selection.operationId).toBe(original.id);
  expect(f.control().points).toHaveLength(1); expect(f.control().requests.filter((row: { kind: string }) => row.kind === 'upgrade')).toHaveLength(1); expect(f.control().requests.filter((row: { kind: string }) => row.kind === 'backup')).toHaveLength(1); expect(existsSync(f.fencePath)).toBe(false);
  expect(JSON.parse(readFileSync(counters, 'utf8')).active).toBe(true); if (boundary === 'result') expect(readFileSync(counters)).toEqual(counts);
}, 90000);

test('an activating journal without selector intent is rearmed through actual readers before any root effect', async () => {
  const f = await fixture(); f.input.requestId = 'intent_gap_' + crypto.randomUUID().replaceAll('-', ''); const plan = await f.prepare();
  const configured = await run(packages[1]!.path, ['-e', `import{readS15RuntimeConfig}from'./src/s15/runtime-config';import{openS16ControlMaintenance}from'./src/s16/operations/control-maintenance';import{readS16OperationsFence}from'./src/s16/operations/operations-state';import{canonical}from'./src/s15/conversation/validation';import{s16RootSelectorValue}from'./ops/package/installer/s16-release-selector';const plan=${JSON.stringify(plan)},hash=value=>new Bun.CryptoHasher('sha256').update(canonical(value)).digest('hex'),config=readS15RuntimeConfig(plan.input.configPath),ctx=openS16ControlMaintenance(config,{operationFence:readS16OperationsFence(config.directory)});try{const journal=ctx.operations(),action=journal.read().requests.find(row=>row.requestId===plan.input.requestId).actions[0];journal.observeAction(plan.input.requestId,journal.read().revision,action.id,'applied',hash(plan));for(const phase of ['verifying','prepared','activating'])journal.advance(plan.input.requestId,journal.read().revision,phase,{cohortSha256:hash(plan.cohort),targetSha256:s16RootSelectorValue(plan.input.targetDirectory).sha256});}finally{ctx.close();}`]);
  expect({ exit: configured.exit, error: configured.error }).toEqual({ exit: 0, error: '' }); expect(f.control().requests.at(-1)).toMatchObject({ phase: 'activating', actions: [{ kind: 'capture_backend', state: 'confirmed' }] });
  const input = { selection: f.input, operatorDirectory: packages[1]!.path, bunPath: join(prefix, 'bin/bun'), service: { user: 'jit-fixture', uid: process.getuid!() || 1001, home: root } }, path = join(prefix, '.s16-selector/jobs', digest(f.input.requestId));
  // Original root publication plus genuine controller phase boundaries; no selector intent is forged.
  opsDirectory(path); opsWrite(join(path, 'input.json'), canonical(input)); opsWrite(join(path, 'selection-plan.json'), canonical(plan)); f.selector.close();
  let active = true, armed = false; const service = { async stop() { active = false; }, async assertStopped() { if (active) throw Error('fixture_not_stopped'); }, async start() { active = true; }, async healthy() { return true; } };
  const job = openS16ReleaseJob(input, { service, run: fixtureServiceRunner(), pathPolicy: { root, uid: process.getuid!() }, after(at) { if (at === 'armed') { expect(f.control().requests.at(-1).actions.at(-1)).toMatchObject({ kind: 'select_package', state: 'intent' }); armed = true; } } }); jobs.push(job);
  expect((await job.run()).outcome).toBe('selected_healthy'); expect(armed).toBe(true); expect(existsSync(f.fencePath)).toBe(false);
}, 60000);

test('a previously completed command identity refuses before producing any pre-upgrade backup', async () => {
  const f = await fixture();
  // Genuine journal metadata protocol fixture; this does not claim an executed owner export.
  const seeded = await run(packages[1]!.path, ['-e', `import{readS15RuntimeConfig}from'./src/s15/runtime-config';import{openS16ControlMaintenance}from'./src/s16/operations/control-maintenance';const ctx=openS16ControlMaintenance(readS15RuntimeConfig(${JSON.stringify(f.input.configPath)}));try{const journal=ctx.operations(),requestId=${JSON.stringify(f.input.requestId)};journal.begin({requestId,kind:'export',hash:'${'c'.repeat(64)}'},journal.read().revision);for(const phase of ['capturing','verifying','complete'])journal.advance(requestId,journal.read().revision,phase,{cohortSha256:'${'c'.repeat(64)}',targetSha256:'${'c'.repeat(64)}'});}finally{ctx.close();}`]);
  expect({ exit: seeded.exit, error: seeded.error }).toEqual({ exit: 0, error: '' }); const before = readFileSync(f.controlPath);
  expect(await f.invoke('prepare')).toMatchObject({ exit: 1, error: 's16_release_selection_request_conflict\n' }); expect(readFileSync(f.controlPath)).toEqual(before); expect(f.control().points).toHaveLength(0); expect(existsSync(f.fencePath)).toBe(false); expect(existsSync(join(f.directory, 'operations/native-staging'))).toBe(false);
});
