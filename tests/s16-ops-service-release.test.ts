import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { chmodSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RELEASE_CONTRACT } from 'schway/host';
import { buildPackage, installArtifactDependencies, readDependencyRecord, validateArtifact } from '../ops/package/bun-build';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { openS16ReleaseJob, type S16ReleaseJob } from '../ops/package/installer/s16-release-job';
import { inspectS16RootReleaseSelector } from '../ops/package/installer/s16-release-selector';
import { s16ReleaseFixtureRunner } from './fixtures/s16-release-job';
import { spawnRunner } from '../src/ops/supervisor';
import { canonical } from '../src/s15/conversation/validation';
import { opsDirectory, opsWrite } from '../src/s14/ops-files';
import type { JitClient } from '../src/s16/client';
import { s16WiringLayout } from '../ops/package/installer/s16-wiring-value';
import type { CommandRunner } from '../src/ops/supervisor';

let root: string, prefix: string, bun: string;
const packages: { path: string; hash: string; harness: string; sourceCommit: string; lockHash: string; dependencyHash: string; dependencyFiles: number }[] = [], cleanup: (() => Promise<void>)[] = [];
const observations: { outcome: string; ownerGeneration: number; policyRevision: number; originalPaymentCalls: number; currentPaymentCalls: number; originalCounters: Record<string, number>; trialWithheld: boolean; freshWork: boolean }[] = [];
const env = { PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin' };
const hash = (value: string | Uint8Array) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
beforeAll(async () => {
  const receipt = process.env.JIT_S16_SERVICE_RELEASE_RECEIPT;
  if (receipt && (!isAbsolute(receipt) || existsSync(receipt))) throw Error('fixture_receipt_must_be_fresh_absolute_path');
  if (receipt) opsDirectory(dirname(receipt));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-service-release-'))); prefix = join(root, 'opt/jit-s15'); bun = join(prefix, 'bin/bun'); mkdirSync(dirname(bun), { recursive: true }); copyFileSync(process.execPath, bun, constants.COPYFILE_FICLONE); chmodSync(bun, 0o755);
  for (const [name, revision] of [['a', '23cfb85d1051ab52b42fefd421c85cd86388f6c3'], ['b', null]] as const) {
    let source = process.cwd(); if (revision) {
      source = join(root, name + '-source'); mkdirSync(source); const archive = join(root, name + '.tar');
      if (Bun.spawnSync(['git', 'archive', '--format=tar', '--output=' + archive, revision], { env }).exitCode !== 0 || Bun.spawnSync(['/usr/bin/tar', '-xf', archive, '-C', source], { env }).exitCode !== 0) throw Error('fixture_archive_failed');
    }
    const staging = join(root, name), manifest = buildPackage({ srcDir: source, outDir: staging, engineContract: RELEASE_CONTRACT, engineRevision: null });
    const dependencies = await installArtifactDependencies(staging, { bunPath: bun, run: spawnRunner, env, timeoutMs: 120000 }); const path = join(prefix, 'releases', manifest.artifactId); mkdirSync(dirname(path), { recursive: true }); renameSync(staging, path);
    const harness = join(root, name + '-harness'); mkdirSync(join(harness, 'tests'), { recursive: true }); cpSync(join(process.cwd(), 'tests/fixtures'), join(harness, 'tests/fixtures'), { recursive: true });
    for (const entry of ['src', 'node_modules']) symlinkSync(join(path, entry), join(harness, entry)); cpSync(join(path, 'ops'), join(harness, 'ops'), { recursive: true }); cpSync(join(process.cwd(), 'ops/evidence'), join(harness, 'ops/evidence'), { recursive: true });
    packages.push({ path, hash: manifest.contentHash, harness, sourceCommit: revision ?? Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString().trim(), lockHash: manifest.lockHash, dependencyHash: dependencies.dependencyHash, dependencyFiles: dependencies.dependencyFiles });
  }
}, 180000);
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); rmSync(join(prefix, 'current'), { force: true }); });
afterAll(() => {
  try {
    for (const pkg of packages) { const checked = validateArtifact(pkg.path, { runtime: true }); expect(checked.ok && checked.manifest?.contentHash === pkg.hash && readDependencyRecord(pkg.path)?.dependencyHash === pkg.dependencyHash).toBe(true); }
    const receipt = process.env.JIT_S16_SERVICE_RELEASE_RECEIPT;
    if (receipt) {
      const source = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' }), status = Bun.spawnSync(['git', 'status', '--porcelain'], { stdout: 'pipe', stderr: 'ignore' });
      opsWrite(receipt, JSON.stringify({ contract: 's16-service-release-artifact-evidence/v1', sourceCommit: source.stdout.toString().trim(), sourceState: source.exitCode === 0 && status.exitCode === 0 && !status.stdout.length && packages[1]?.sourceCommit === source.stdout.toString().trim() ? 'clean' : 'unverified',
        packages: packages.map(({ path: _path, harness: _harness, ...pkg }) => pkg), platform: process.platform, arch: process.arch, bunVersion: Bun.version, engineContract: RELEASE_CONTRACT, engineRevision: 'unverified', artifactsAfter: 'verified_unchanged', testOutcomes: 'separate_test_log_required',
        driverSha256: hash(readFileSync(import.meta.path)), hostSha256: hash(readFileSync(join(import.meta.dir, 'fixtures/s16-service-release-host.ts'))), compositionSha256: hash(readFileSync(join(import.meta.dir, 'fixtures/s15-composition.ts'))), observations,
        controller: 'actual_copied_S14_owner_and_S15_service_processes', client: 'same_sealed_shared_transport_with_current_owner_session_and_csrf', native: 'actual_service_dispatched_public_native_work', supervisor: 'controlled_actual_process_stop_exit_and_start', identityTransition: 'fixture_runner_not_linux_enforcement',
        externalPorts: 'persistent_scripted_model_vm_payment_and_independent_retained_record_backend', renderedClient: 'not_exercised', installedLinuxLifecycle: 'not_exercised', liveAccounts: false, nativeDevices: 'not_exercised', ownerHostCutover: 'not_exercised' }));
    }
  } finally { if (root) rmSync(root, { recursive: true, force: true }); }
});

async function host(pkg: typeof packages[number], input: { mode: 'seed' | 'attach'; configPath: string; externalDirectory: string; authPath: string; externalBackendModule: string }) {
  let sequence = 0, readyResolve!: () => void, readyReject!: (error: Error) => void;
  const pending = new Map<number, { resolve(value: any): void; reject(error: Error): void }>();
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const child = Bun.spawn([bun, 'tests/fixtures/s16-service-release-host.ts'], { cwd: pkg.harness, env, stdin: Buffer.from(JSON.stringify(input)), stdout: 'ignore', stderr: 'pipe', ipc(message: any) {
    if (message.kind === 'ready') { readyResolve(); return; } if (message.kind === 'failed') { readyReject(Error('fixture_host_boot_failed:' + message.error + '\n' + message.detail)); return; }
    const wait = pending.get(message.seq); if (!wait) return; pending.delete(message.seq); if (message.ok) wait.resolve(message.value); else wait.reject(Error(message.error));
  } });
  const error = new Response(child.stderr).text(), timer = setTimeout(() => { child.kill('SIGKILL'); readyReject(Error('fixture_host_boot_timeout')); }, 30000);
  try { await Promise.race([ready, child.exited.then(() => { throw Error('fixture_host_exited_before_ready'); })]); } catch (failure) { child.kill('SIGKILL'); await child.exited; throw Error(String(failure) + ':' + await error); } finally { clearTimeout(timer); }
  const call = (kind: string, value?: unknown): Promise<any> => {
    const seq = ++sequence;
    return new Promise((resolve, reject) => { const timeout = setTimeout(() => { pending.delete(seq); reject(Error('fixture_host_request_timeout')); }, 60000); pending.set(seq, { resolve(value) { clearTimeout(timeout); resolve(value); }, reject(error) { clearTimeout(timeout); reject(error); } }); child.send({ seq, kind, value }); });
  };
  let closed = false;
  return { child, call, async close() {
    if (closed) return;
    try { if (child.exitCode === null) await call('close'); }
    catch (failure) { child.kill('SIGKILL'); await child.exited; closed = true; throw failure; }
    const timeout = setTimeout(() => child.kill('SIGKILL'), 10000);
    try { const exit = await child.exited; closed = true; if (exit !== 0) throw Error('fixture_host_close_failed:' + await error); }
    finally { clearTimeout(timeout); }
  } };
}

test('actual owning client/service starts from original first-selected setup and keeps new work untouched by setup response retry', async () => {
  const layout = s16WiringLayout(root), state = realpathSync(mkdtempSync(join(root, 'first-service-'))), externalDirectory = join(state, 'external'), authPath = join(state, 'owner.fixture.json'); mkdirSync(externalDirectory, { mode: 0o700 }); mkdirSync(dirname(layout.config), { recursive: true });
  const base = s15StageConfig(layout.state, 'http://localhost:3099'), config = { ...base, installationId: 'fixture', files: true, computers: true, vm: { ...base.vm, id: 'vm', local: false } }, raw = JSON.stringify(config); writeFileSync(layout.config, raw, { mode: 0o600 });
  writeFileSync(join(externalDirectory, 'external.fixture.json'), JSON.stringify({ contract: 's16-service-release-external-fixture/v1', counts: { model: 0, interpreter: 0, vm: 0, payment: 0, reconcile: 0, vmManagement: 0 }, files: {}, payment: {}, selectedManagerId: null, managers: { manager: { state: 'running', identity: 'fixture' } } }), { mode: 0o600 });
  const input = { configPath: layout.config, externalDirectory, authPath, externalBackendModule: join(packages[1]!.path, 'src/s15/effects/index.ts') }; let current: Awaited<ReturnType<typeof host>> | undefined, starts = 0, stops = 0;
  cleanup.push(async () => { await current?.close(); rmSync(state, { recursive: true, force: true }); rmSync(layout.home, { recursive: true, force: true }); rmSync(dirname(layout.config), { recursive: true, force: true }); for (const path of [layout.files.controller, layout.files.journal, layout.files.proxy]) rmSync(path, { force: true }); });
  const ActualClient = await import(pathToFileURL(join(packages[1]!.path, 'src/s16/client/index.ts')).href) as typeof import('../src/s16/client');
  const client: JitClient = new ActualClient.JitClient({ origin: config.origin, fetch: async request => {
    if (!current) throw Error('fixture_service_stopped'); const headers = new Headers(request.headers); headers.set('cookie', 'jit_s14=' + JSON.parse(readFileSync(authPath, 'utf8')).token); headers.set('origin', config.origin);
    const reply = await current.call('fetch', { url: request.url, method: request.method, headers: [...headers], body: request.body ? Buffer.from(await request.arrayBuffer()).toString('base64') : null }); return new Response([204, 205, 304].includes(reply.status) ? null : Buffer.from(reply.body, 'base64'), { status: reply.status, headers: reply.headers });
  } });
  const manager: CommandRunner = async (argv, settings) => {
    const response = (stdout = '', exitCode = 0) => ({ stdout, exitCode, timedOut: false });
    if (argv[0] === '/usr/bin/getent') return response(`jit-fixture:x:${process.getuid!()}:${process.getgid!()}::${layout.home}:/usr/sbin/nologin\n`);
    if (argv[0] === '/usr/bin/systemctl') {
      if (argv[1] === 'show') {
        const running = current?.child.exitCode === null, fields: Record<string, string> = { LoadState: 'loaded', ActiveState: running ? 'active' : 'inactive', SubState: running ? 'running' : 'dead', MainPID: running ? String(current!.child.pid) : '0', ControlPID: '0', Job: '', FragmentPath: layout.files.controller, DropInPaths: '', NeedDaemonReload: 'no', User: 'jit-fixture', Group: 'jit-fixture', KillMode: 'mixed', SendSIGKILL: 'yes' };
        return response(argv[3]!.slice('--property='.length).split(',').map(key => `${key}=${fields[key]}\n`).join(''));
      }
      if (argv[1] === 'stop') { stops++; await current?.close(); current = undefined; }
      else if (argv[1] === 'start') { starts++; current = await host(packages[1]!, { ...input, mode: existsSync(authPath) ? 'attach' : 'seed' }); }
      else if (!['daemon-reload', 'enable'].includes(argv[1]!)) throw Error('fixture_unexpected_first_manager_command'); return response();
    }
    if (JSON.stringify(argv.slice(0, 6)) !== JSON.stringify(['/usr/sbin/runuser', '-u', 'jit-fixture', '--', '/usr/bin/env', '-i'])) throw Error('fixture_unexpected_first_identity');
    const at = argv.indexOf(bun), entry = argv[at + 1]!; if (at < 0) throw Error('fixture_first_bun_missing');
    if (entry.endsWith('/s16-package-probe.ts')) {
      const args = argv.slice(at + 2); return spawnRunner([bun, '-e', `import{openS16PackageReaderProbe}from${JSON.stringify(entry)};const cap=await openS16PackageReaderProbe({targetDirectory:${JSON.stringify(args[1])},packageSha256:${JSON.stringify(args[3])},configPath:${JSON.stringify(args[5])},configurationSha256:${JSON.stringify(args[7])}},{pathPolicy:${JSON.stringify({ root, uid: process.getuid!() })}});try{const value=await cap.observe();cap.close();console.log(JSON.stringify(value));}finally{cap.close();}`], { ...settings, env });
    }
    return spawnRunner([bun, ...argv.slice(at + 1)], { ...settings, env });
  };
  const unit = `[Service]\nUser=jit-fixture\nGroup=jit-fixture\nExecStart=${bun} ${prefix}/current/src/main.ts serve --s15 --config ${layout.config}\nKillMode=mixed\n\n[Install]\nWantedBy=multi-user.target\n`;
  const ActualFirst = await import(pathToFileURL(join(packages[1]!.path, 'ops/package/installer/s16-first-setup.ts')).href) as typeof import('../ops/package/installer/s16-first-setup');
  const firstInput = { contract: 's16-first-selected-setup/v1' as const, release: packages[1]!.path, packageSha256: packages[1]!.hash, configurationSha256: hash(canonical(config)), rawConfigurationSha256: hash(raw), bunPath: bun, service: { user: 'jit-fixture', uid: process.getuid!(), gid: process.getgid!(), home: layout.home }, wiring: { contract: 's16-installed-wiring-value/v1' as const, files: { controller: { bytes: Buffer.from(unit).toString('base64'), uid: process.getuid!(), gid: process.getgid!(), mode: 0o644 }, journal: null, proxy: null, keyring: null } } };
  const options = { run: manager, layoutRoot: root, pathPolicy: { root, uid: process.getuid!() }, sleep: async () => {}, fetch: async () => { await client.bootstrap(); return new Response('', { status: 200 }); }, async prepareOwnerLink() { /* Private owner delivery is a separate labelled fixture port. */ } };
  const first = ActualFirst.openS16FirstSetup(firstInput, options); let result;
  try { result = await first.run(); } finally { first.close(); }
  expect(result.state).toBe('healthy'); expect(starts).toBe(1); expect(readFileSync(layout.config, 'utf8')).toBe(raw); await client.bootstrap(); await current!.call('assign_private', { id: 'private_vm_1' });
  const bytes = Buffer.from('First selected service input.\n'), pending = await client.createUpload({ requestId: 'first_input', conversationId: 'first_conversation', name: 'first.txt', bytes: bytes.length, sha256: hash(bytes) }), uploaded = await client.uploadBytes(pending.id, bytes);
  await current!.call('script', [{ type: 'tool_call', id: 'read_first', name: 'file_read', arguments: { id: uploaded.id, offset: 0 } }, { type: 'tool_call', id: 'create_first', name: 'file_create', arguments: { name: 'first.md', text: '# First selected output\n' } }]);
  const receipt = await client.send({ ...client.prepareMessage('first_conversation', 'Read these notes and create a Markdown brief.', [{ id: uploaded.id, sha256: uploaded.receipt!.sha256 }]), requestId: 'first_work' }); await current!.call('drain'); const view = await client.request('first_work'); expect(view.row.state).toBe('done');
  expect(Buffer.from(await client.artifactBytes(view.row.files!.artifacts[0]!)).toString()).toBe('# First selected output\n');
  const payment = await current!.call('unknown_payment'), before = await current!.call('facts', payment), auth = readFileSync(authPath), pid = current!.child.pid, supervisor = { starts, stops };
  const retry = ActualFirst.openS16FirstSetup(undefined, options); try { expect(await retry.run()).toEqual(result); } finally { retry.close(); }
  expect({ starts, stops }).toEqual(supervisor); expect(current!.child.pid).toBe(pid); expect(readFileSync(authPath)).toEqual(auth); expect((await client.request('first_work')).receipt).toEqual(receipt);
  expect(await current!.call('duplicate_payment', payment)).toEqual({ refused: true }); await current!.call('drain'); const after = await current!.call('facts', payment); expect(after.counts).toEqual(before.counts); expect(after.usage).toEqual(before.usage); expect(after.slip.state).toBe('unknown'); expect(after.counts.payment).toBe(1);
  observations.push({ outcome: 'first_selected_healthy', ownerGeneration: after.ownerGeneration, policyRevision: after.policy.revision, originalPaymentCalls: before.counts.payment, currentPaymentCalls: after.counts.payment, originalCounters: before.counts, trialWithheld: false, freshWork: true });
}, 180000);

for (const scenario of ['upgrade', 'fallback', 'installed'] as const) test('actual owning client/service ' + (scenario === 'fallback' ? 'retains trial withdrawals, private retirement, policy and unknown effect through compatible fallback' : scenario === 'installed' ? 'retains current work, authority and unknown effects through installed uninstall and reinstall' : 'retains original work and credentials through compatible package upgrade'), async () => {
  const fallback = scenario === 'fallback', installed = scenario === 'installed', layout = s16WiringLayout(root);
  const state = realpathSync(mkdtempSync(join(root, 'state-'))), directory = installed ? layout.state : join(state, 'installation'), configPath = installed ? layout.config : join(state, 'config.json'), externalDirectory = join(state, 'external'), authPath = join(state, 'owner.fixture.json'); mkdirSync(externalDirectory, { mode: 0o700 }); mkdirSync(dirname(configPath), { recursive: true });
  const base = s15StageConfig(directory, 'http://localhost:3099'), config = { ...base, installationId: 'fixture', files: true, computers: true, vm: { ...base.vm, id: 'vm' } }; writeFileSync(configPath, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(join(externalDirectory, 'external.fixture.json'), JSON.stringify({ contract: 's16-service-release-external-fixture/v1', counts: { model: 0, interpreter: 0, vm: 0, payment: 0, reconcile: 0, vmManagement: 0 }, files: {}, payment: {}, selectedManagerId: null, managers: { manager: { state: 'running', identity: 'fixture' } } }), { mode: 0o600 });
  symlinkSync(packages[0]!.path, join(prefix, 'current'));
  const initialized = await spawnRunner([bun, join(packages[0]!.path, 'src/main.ts'), 'init', '--s15', '--config', configPath], { cwd: packages[0]!.path, env, timeoutMs: 30000 }); expect(initialized.exitCode).toBe(0);
  const input = { configPath, externalDirectory, authPath, externalBackendModule: join(packages[1]!.path, 'src/s15/effects/index.ts') }; let current: Awaited<ReturnType<typeof host>> | undefined = await host(packages[0]!, { ...input, mode: 'seed' }); let job: S16ReleaseJob | undefined;
  cleanup.push(async () => { await current?.close(); job?.close(); rmSync(state, { recursive: true, force: true }); if (installed) { rmSync(layout.home, { recursive: true, force: true }); rmSync(dirname(layout.config), { recursive: true, force: true }); for (const path of [layout.files.controller, layout.files.journal, layout.files.proxy]) rmSync(path, { force: true }); } });
  const ActualClient = await import(pathToFileURL(join(packages[1]!.path, 'src/s16/client/index.ts')).href) as typeof import('../src/s16/client');
  const client: JitClient = new ActualClient.JitClient({ origin: config.origin, fetch: async request => {
    if (!current) throw Error('fixture_service_stopped'); const headers = new Headers(request.headers); headers.set('cookie', 'jit_s14=' + JSON.parse(readFileSync(authPath, 'utf8')).token); headers.set('origin', config.origin);
    const reply = await current.call('fetch', { url: request.url, method: request.method, headers: [...headers], body: request.body ? Buffer.from(await request.arrayBuffer()).toString('base64') : null });
    return new Response([204, 205, 304].includes(reply.status) ? null : Buffer.from(reply.body, 'base64'), { status: reply.status, headers: reply.headers });
  } });
  await client.bootstrap(); const retainedComputer = await current.call('assign_private', { id: 'private_vm_0' });
  const retainedInput = Buffer.from('Original retained service input.\n'), retainedPending = await client.createUpload({ requestId: 'retained_input', conversationId: 'retained_conversation', name: 'retained.txt', bytes: retainedInput.length, sha256: hash(retainedInput) }), retainedUpload = await client.uploadBytes(retainedPending.id, retainedInput);
  await current.call('script', [{ type: 'tool_call', id: 'read_retained', name: 'file_read', arguments: { id: retainedUpload.id, offset: 0 } }, { type: 'tool_call', id: 'create_retained', name: 'file_create', arguments: { name: 'retained.md', text: '# Retained original artifact\n' } }]);
  const firstReceipt = await client.send({ ...client.prepareMessage('retained_conversation', 'Read these notes and create a Markdown brief.', [{ id: retainedUpload.id, sha256: retainedUpload.receipt!.sha256 }]), requestId: 'retained_work' }); await current.call('drain');
  const retainedView = await client.request('retained_work'); expect(retainedView.row).toMatchObject({ state: 'done' });
  const retained = retainedView.row.files!.artifacts[0]!; expect(Buffer.from(await client.artifactBytes(retained)).toString()).toBe('# Retained original artifact\n');
  // A different private VM keeps later withdrawn input out of the retained work's VM lineage.
  await client.computerCommand({ contract: 's16-computer-command/v1', requestId: 'retire_retained_computer', kind: 'retire_private', vmId: retainedComputer.vmId });
  const privateComputer = await current.call('assign_private', { id: 'private_vm_1' });
  const bytes = Buffer.from('Original private service input.\n'), pending = await client.createUpload({ requestId: 'private_input', conversationId: 'private_conversation', name: 'notes.txt', bytes: bytes.length, sha256: hash(bytes) }), upload = await client.uploadBytes(pending.id, bytes);
  await current.call('script', [{ type: 'tool_call', id: 'read_input', name: 'file_read', arguments: { id: upload.id, offset: 0 } }, { type: 'tool_call', id: 'create_private', name: 'file_create', arguments: { name: 'private.md', text: '# Private original artifact\n' } }]);
  const privateReceipt = await client.send({ contract: 's16-conversation/v2', requestId: 'private_work', conversationId: 'private_conversation', text: 'Read these notes and create a Markdown brief.', continuation: null, files: [{ id: upload.id, sha256: upload.receipt!.sha256 }] }); await current.call('drain');
  const privateArtifact = (await client.request('private_work')).row.files!.artifacts[0]!; expect(Buffer.from(await client.artifactBytes(privateArtifact)).toString()).toBe('# Private original artifact\n');
  const availability = async (artifact: typeof retained) => {
    try { return { state: 'readable', sha256: hash(await client.artifactBytes(artifact)) }; }
    catch (error) { if ((error as { status?: number }).status !== 409) throw error; return { state: 'withheld', status: 409 }; }
  };
  const payment = await current.call('unknown_payment'); expect(await current.call('duplicate_payment', payment)).toEqual({ refused: true });
  await client.computerCommand({ contract: 's16-computer-command/v1', requestId: 'owner_sleep', kind: 'sleep', vmId: privateComputer.vmId });
  const baseline = await current.call('facts', payment), auth = readFileSync(authPath); expect(baseline.slip.state).toBe('unknown'); expect(baseline.counts.payment).toBe(1); expect(baseline.usage.unsettled).toBeGreaterThan(0);
  await current.close(); current = undefined;
  const adopted = await spawnRunner([bun, join(packages[1]!.path, 'src/s16/operations-cli.ts'), 'adopt', '--s15', '--config', configPath, '--request-id', 'lifecycle_adopt'], { cwd: packages[1]!.path, env, timeoutMs: 30000 }); expect(adopted.exitCode).toBe(0);
  let starts = 0, stops = 0, trial: any, trialAvailability: Awaited<ReturnType<typeof availability>>[] = [];
  const service = { async stop() { stops++; await current?.close(); current = undefined; }, async assertStopped() { if (current?.child.exitCode === null) throw Error('fixture_controller_still_running'); }, async start() {
    starts++; const selected = inspectS16RootReleaseSelector({ prefix, pathPolicy: { root, uid: process.getuid!() } }).targetDirectory, pkg = packages.find(pkg => pkg.path === selected); if (!pkg) throw Error('fixture_selected_package_missing'); current = await host(pkg, { ...input, mode: 'attach' });
  }, async healthy() {
    await client.bootstrap(); expect((await client.request('retained_work')).receipt).toEqual(firstReceipt);
    if (fallback && starts === 1) {
      await client.withdrawUpload(upload.id); await client.computerCommand({ contract: 's16-computer-command/v1', requestId: 'retire_private_in_trial', kind: 'retire_private', vmId: privateComputer.vmId }); await current!.call('policy_change'); trial = await current!.call('facts', payment);
      // The new policy fences publication under the old grant; fallback must keep that withholding.
      trialAvailability = [await availability(retained), await availability(privateArtifact)]; expect(trialAvailability).toEqual([{ state: 'withheld', status: 409 }, { state: 'withheld', status: 409 }]); return false;
    }
    return true;
  } };
  job = openS16ReleaseJob({ selection: { requestId: 'lifecycle_' + crypto.randomUUID().replaceAll('-', ''), configPath, configurationSha256: hash(canonical(config)), operatorSha256: packages[1]!.hash, prefix, sourceDirectory: packages[0]!.path, sourceSha256: packages[0]!.hash, targetDirectory: packages[1]!.path, targetSha256: packages[1]!.hash }, operatorDirectory: packages[1]!.path, bunPath: bun, service: { user: 'jit-fixture', uid: process.getuid!() || 1001, home: externalDirectory } }, { service, run: s16ReleaseFixtureRunner(root, env), pathPolicy: { root, uid: process.getuid!() } });
  const result = await job.run(); expect(result.outcome).toBe(fallback ? 'fallback_healthy' : 'selected_healthy'); await client.bootstrap();
  const final = await current!.call('facts', payment), expected = fallback ? trial : baseline;
  expect(final.policy).toEqual(expected.policy); expect(final.usage).toEqual(expected.usage); expect(final.vm).toEqual(expected.vm); expect(final.counts).toEqual(baseline.counts); expect(final.slip.state).toBe('unknown'); expect(final.ownerGeneration).toBe(baseline.ownerGeneration); expect(readFileSync(authPath)).toEqual(auth);
  expect((await client.request('retained_work')).receipt).toEqual(firstReceipt); expect((await client.request('private_work')).receipt).toEqual(privateReceipt);
  if (fallback) {
    expect([await availability(retained), await availability(privateArtifact)]).toEqual(trialAvailability); expect((await client.uploadStatus(upload.id)).state).toBe('withdrawn'); expect(final.assigned).toEqual([]);
    expect(readFileSync(join(directory, 'runtime/file-bytes', retained.id + '.blob'), 'utf8')).toBe('# Retained original artifact\n');
  } else { expect(Buffer.from(await client.artifactBytes(retained)).toString()).toBe('# Retained original artifact\n'); expect(Buffer.from(await client.artifactBytes(privateArtifact)).toString()).toBe('# Private original artifact\n'); }
  expect(await current!.call('duplicate_payment', payment)).toEqual({ refused: true }); await current!.call('drain'); expect((await current!.call('facts', payment)).counts).toEqual(baseline.counts);
  if (installed) {
    // The real selected service produces the later authority facts before any
    // unit mutation; its original shared client/session remains in use.
    await client.withdrawUpload(upload.id); await client.computerCommand({ contract: 's16-computer-command/v1', requestId: 'retire_before_uninstall', kind: 'retire_private', vmId: privateComputer.vmId }); await current!.call('policy_change');
    trial = await current!.call('facts', payment); trialAvailability = [await availability(retained), await availability(privateArtifact)]; expect(trialAvailability).toEqual([{ state: 'withheld', status: 409 }, { state: 'withheld', status: 409 }]);
    expect(await job.run()).toEqual(result); job.close(); job = undefined;
    for (const path of [layout.files.controller, layout.files.journal, layout.files.proxy]) mkdirSync(dirname(path), { recursive: true });
    writeFileSync(layout.files.controller, `[Service]\nUser=jit-fixture\nGroup=jit-fixture\nExecStart=${bun} ${prefix}/current/src/main.ts serve --s15 --config ${configPath}\nKillMode=mixed\n\n[Install]\nWantedBy=multi-user.target\n`, { mode: 0o644 });
    writeFileSync(layout.files.journal, '# Disposable journal fixture.\n', { mode: 0o644 }); writeFileSync(layout.files.proxy, '# Disposable proxy fixture.\n', { mode: 0o644 });
    const originalUnits = [layout.files.controller, layout.files.journal, layout.files.proxy].map(path => readFileSync(path)), originalConfig = readFileSync(configPath); let enabled = true;
    const originalArtifactHashes = [retained, privateArtifact].map(artifact => hash(readFileSync(join(directory, 'runtime/file-bytes', artifact.id + '.blob'))));
    const fixedHelpers = s16ReleaseFixtureRunner(root, env);
    const manager: CommandRunner = async (argv, settings) => {
      const response = (stdout = '', exitCode = 0) => ({ exitCode, stdout, timedOut: false });
      if (argv[0] === '/usr/bin/getent') return response(`jit-fixture:x:${process.getuid!()}:${process.getgid!()}::${layout.home}:/usr/sbin/nologin\n`);
      if (argv[0] === '/usr/bin/systemctl') {
        if (argv[1] === 'show') {
          const loaded = existsSync(layout.files.controller), running = current?.child.exitCode === null, fields: Record<string, string> = { LoadState: loaded ? 'loaded' : 'not-found', ActiveState: running ? 'active' : 'inactive', SubState: running ? 'running' : 'dead', MainPID: running ? String(current!.child.pid) : '0', ControlPID: '0', Job: '', FragmentPath: loaded ? layout.files.controller : '', DropInPaths: '', NeedDaemonReload: 'no', User: loaded ? 'jit-fixture' : '', Group: loaded ? 'jit-fixture' : '', KillMode: 'mixed', SendSIGKILL: 'yes' };
          return response(argv[3]!.slice('--property='.length).split(',').map(key => `${key}=${fields[key]}\n`).join(''));
        }
        if (argv[1] === 'is-enabled') return response(enabled ? 'enabled\n' : 'disabled\n', enabled ? 0 : 1);
        if (argv[1] === 'stop') { await service.stop(); return response('', existsSync(layout.files.controller) ? 0 : 5); }
        if (argv[1] === 'start') { await service.start(); return response(); }
        if (argv[1] === 'enable') enabled = true; else if (argv[1] === 'disable') enabled = false; else if (argv[1] !== 'daemon-reload') throw Error('fixture_unexpected_manager_command'); return response();
      }
      if (argv[10]?.endsWith('/s16-wiring-maintenance.ts')) return spawnRunner([argv[9]!, '-e', `import{openS16WiringMaintenance}from${JSON.stringify(argv[10])};const command=await Bun.stdin.json(),cap=openS16WiringMaintenance(command.input,{layoutRoot:${JSON.stringify(root)},pathPolicy:${JSON.stringify({ root, uid: process.getuid!() })}});try{const value=cap[command.method](command.plan);cap.close();console.log(JSON.stringify(value??{state:'armed'}));}catch(error){try{cap.close();}catch{}console.log(error.message);process.exitCode=1;}`], { ...settings, env });
      return fixedHelpers(argv, settings);
    };
    const ActualWiring = await import(pathToFileURL(join(packages[1]!.path, 'ops/package/installer/s16-installed-wiring.ts')).href) as typeof import('../ops/package/installer/s16-installed-wiring');
    const wiringOptions = { run: manager, layoutRoot: root, pathPolicy: { root, uid: process.getuid!() }, user: 'jit-fixture', sleep: async () => {}, fetch: async () => { await client.bootstrap(); return new Response('', { status: 200 }); }, async stopWorkingVms() {
      // Independent persistent VM port: no controller/state reseed and no model,
      // payment, reconcile or transport invocation is manufactured by uninstall.
      const external = JSON.parse(readFileSync(join(externalDirectory, 'external.fixture.json'), 'utf8')), stopped = new Set<string>();
      for (const vm of Object.values(external.managers) as { state: string; identity: string }[]) { if (vm.state === 'running' && !stopped.has(vm.identity)) { stopped.add(vm.identity); external.counts.vmManagement++; } vm.state = 'stopped'; }
      writeFileSync(join(externalDirectory, 'external.fixture.json'), JSON.stringify(external), { mode: 0o600 });
    } };
    const remove = ActualWiring.openS16InstalledWiring('remove', bun, wiringOptions); try { expect(await remove.run()).toMatchObject({ state: 'removed' }); } finally { remove.close(); }
    expect(current).toBeUndefined(); expect([layout.files.controller, layout.files.journal, layout.files.proxy].map(path => existsSync(path))).toEqual([false, false, false]); expect(readFileSync(authPath)).toEqual(auth);
    const afterStop = JSON.parse(readFileSync(join(externalDirectory, 'external.fixture.json'), 'utf8')).counts;
    expect({ ...afterStop, vmManagement: baseline.counts.vmManagement }).toEqual(baseline.counts);
    const reinstall = ActualWiring.openS16InstalledWiring('restore', bun, wiringOptions); try { expect(await reinstall.run()).toMatchObject({ state: 'restored', health: 'healthy' }); } finally { reinstall.close(); }
    expect([layout.files.controller, layout.files.journal, layout.files.proxy].map(path => readFileSync(path))).toEqual(originalUnits); expect(readFileSync(configPath)).toEqual(originalConfig); expect(readFileSync(authPath)).toEqual(auth);
    expect([retained, privateArtifact].map(artifact => hash(readFileSync(join(directory, 'runtime/file-bytes', artifact.id + '.blob'))))).toEqual(originalArtifactHashes);
    const reinstated = await current!.call('facts', payment); expect(reinstated.policy).toEqual(trial.policy); expect(reinstated.usage).toEqual(trial.usage); expect(reinstated.vm).toEqual(trial.vm); expect(reinstated.assigned).toEqual([]); expect(reinstated.counts).toEqual(afterStop); expect(reinstated.slip.state).toBe('unknown'); expect(reinstated.ownerGeneration).toBe(baseline.ownerGeneration);
    expect([await availability(retained), await availability(privateArtifact)]).toEqual(trialAvailability); expect((await client.uploadStatus(upload.id)).state).toBe('withdrawn'); expect((await client.request('retained_work')).receipt).toEqual(firstReceipt); expect((await client.request('private_work')).receipt).toEqual(privateReceipt);
    expect(await current!.call('duplicate_payment', payment)).toEqual({ refused: true }); await current!.call('drain'); expect((await current!.call('facts', payment)).counts).toEqual(afterStop);
    const pid = current!.child.pid, supervisor = { starts, stops }, repeated = ActualWiring.openS16InstalledWiring('restore', bun, wiringOptions);
    try { expect((await repeated.run()).health).toBe('healthy'); } finally { repeated.close(); }
    expect(current!.child.pid).toBe(pid); expect({ starts, stops }).toEqual(supervisor); expect((await current!.call('facts', payment)).counts).toEqual(afterStop);
  }
  if (fallback || installed) {
    await current!.call('assign_private', { id: 'private_vm_2' });
    const freshBytes = Buffer.from('Fresh current-policy input.\n'), freshPending = await client.createUpload({ requestId: 'fresh_input', conversationId: 'after_fallback', name: 'fresh.txt', bytes: freshBytes.length, sha256: hash(freshBytes) }), fresh = await client.uploadBytes(freshPending.id, freshBytes);
    await current!.call('script', [{ type: 'tool_call', id: 'read_fresh', name: 'file_read', arguments: { id: fresh.id, offset: 0 } }, { type: 'tool_call', id: 'create_fresh', name: 'file_create', arguments: { name: 'fresh.md', text: '# Fresh current-policy output\n' } }]);
    await client.send({ ...client.prepareMessage('after_fallback', 'Read these notes and create a Markdown brief.', [{ id: fresh.id, sha256: fresh.receipt!.sha256 }]), requestId: 'fresh_work' }); await current!.call('drain');
    const freshView = await client.request('fresh_work'); expect(freshView.row.state).toBe('done'); expect(Buffer.from(await client.artifactBytes(freshView.row.files!.artifacts[0]!)).toString()).toBe('# Fresh current-policy output\n');
    const after = await current!.call('facts', payment); expect(after.counts.payment).toBe(1); expect(after.counts.model).toBeGreaterThan(baseline.counts.model); expect(after.vm).toEqual(trial.vm); expect(after.slip.state).toBe('unknown'); expect(after.policy).toEqual(trial.policy);
  }
  if (job) { const pid = current!.child.pid, supervisor = { starts, stops }; expect(await job.run()).toEqual(result); expect({ starts, stops }).toEqual(supervisor); expect(current!.child.pid).toBe(pid); }
  expect(existsSync(join(directory, 'owner/owner.sqlite.ops/fence.json'))).toBe(false);
  const after = await current!.call('facts', payment); observations.push({ outcome: installed ? 'installed_reinstalled' : result.outcome, ownerGeneration: after.ownerGeneration, policyRevision: after.policy.revision, originalPaymentCalls: baseline.counts.payment, currentPaymentCalls: after.counts.payment, originalCounters: baseline.counts, trialWithheld: fallback || installed, freshWork: fallback || installed });
}, 360000);
