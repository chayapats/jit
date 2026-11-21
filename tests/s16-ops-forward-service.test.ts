import { afterEach, expect, test } from 'bun:test';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { AppError } from '../src/errors';
import { ConnectionVault } from '../src/exec/connections';
import { S14Application } from '../src/s14/application';
import { s14Policy } from '../src/s14/policy';
import { S14Store } from '../src/s14/store';
import { JitClient } from '../src/s16/client';
import { adoptS16Operations } from '../src/s16/operations/adoption';
import { openS16ControlMaintenance } from '../src/s16/operations/control-maintenance';
import { openS16InstallationLease, type S16InstallationLease } from '../src/s16/operations/installation-lease';
import { assertS16OperationsOwnerBinding } from '../src/s16/operations/operations-owner';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { composedFixture } from './fixtures/s15-composition';
import { VmManagers } from '../src/s15/vm/managers';
import type { VmManagement } from '../src/s15/vm/types';
import { RELEASE_CONTRACT } from 'schway/host';
import { buildPackage, installArtifactDependencies, readDependencyRecord, validateArtifact } from '../ops/package/bun-build';
import { spawnRunner } from '../src/ops/supervisor';
import { opsWrite } from '../src/s14/ops-files';

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const hash = (value: string | Uint8Array) => new Bun.CryptoHasher('sha256').update(value).digest('hex');

if (process.env.JIT_S16_FORWARD_SERVICE_CHILD !== '1') test('actual copied service package runs the owning forward-repair client scenario with unchanged seals', async () => {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-forward-service-package-'))), artifact = join(parent, 'artifact'), harness = join(parent, 'harness');
  const env = { PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? '/usr/bin:/bin') };
  const receipt = process.env.JIT_S16_FORWARD_SERVICE_RECEIPT;
  if (receipt && (!isAbsolute(receipt) || existsSync(receipt) || existsSync(receipt + '.tests.log'))) throw Error('fixture_receipt_must_be_fresh_absolute_path');
  try {
    const manifest = buildPackage({ srcDir: process.cwd(), outDir: artifact, engineContract: RELEASE_CONTRACT, engineRevision: null });
    const dependencies = await installArtifactDependencies(artifact, { bunPath: process.execPath, run: spawnRunner, timeoutMs: 120000, env });
    mkdirSync(join(harness, 'tests'), { recursive: true, mode: 0o700 }); cpSync(join(process.cwd(), 'tests/fixtures'), join(harness, 'tests/fixtures'), { recursive: true });
    cpSync(import.meta.path, join(harness, 'tests/s16-ops-forward-service.test.ts'));
    for (const name of ['src', 'node_modules']) symlinkSync(join(artifact, name), join(harness, name));
    cpSync(join(artifact, 'ops'), join(harness, 'ops'), { recursive: true }); mkdirSync(join(harness, 'ops/evidence'), { mode: 0o700 });
    cpSync(join(process.cwd(), 'ops/evidence/s15-stage.ts'), join(harness, 'ops/evidence/s15-stage.ts'));
    const child = Bun.spawn([process.execPath, 'test', '--timeout', '120000', 'tests/s16-ops-forward-service.test.ts'], { cwd: harness, env: { ...env, JIT_S16_FORWARD_SERVICE_CHILD: '1' }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }), timer = setTimeout(() => child.kill('SIGKILL'), 150000);
    let report = '';
    try { const [exit, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); report = out + error; expect({ exit, error: exit === 0 ? '' : error }).toEqual({ exit: 0, error: '' }); expect(out.trim()).toMatch(/^bun test v/); expect(error).toContain('1 pass'); expect(error).toContain('0 fail'); }
    finally { clearTimeout(timer); }
    expect(validateArtifact(artifact, { runtime: true }).ok).toBe(true); expect(readDependencyRecord(artifact)?.dependencyHash).toBe(dependencies.dependencyHash);
    if (receipt) {
      const revision = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' }), status = Bun.spawnSync(['git', 'status', '--porcelain'], { stdout: 'pipe', stderr: 'ignore' });
      const counts = /\n\s*(\d+) pass\n\s*(\d+) fail\n\s*(\d+) expect\(\) calls/.exec(report); if (!counts || Number(counts[1]) !== 1 || Number(counts[2]) !== 0) throw Error('fixture_test_counts_missing');
      opsWrite(receipt + '.tests.log', report);
      opsWrite(receipt, JSON.stringify({ contract: 's16-forward-service-package-evidence/v1', basis: 'actual_owning_service_and_client_with_scripted_transports', sourceCommit: revision.stdout.toString().trim(), sourceState: status.exitCode === 0 && !status.stdout.length ? 'clean' : 'unverified',
        packageContentHash: manifest.contentHash, dependencyHash: dependencies.dependencyHash, dependencyFiles: dependencies.dependencyFiles, lockHash: manifest.lockHash, engineContract: manifest.engineContract, engineRevision: manifest.engineRevision,
        platform: process.platform, arch: process.arch, bunVersion: Bun.version, driverSha256: hash(readFileSync(import.meta.path)), compositionFixtureSha256: hash(readFileSync(join(process.cwd(), 'tests/fixtures/s15-composition.ts'))), tests: { pass: 1, fail: 0, assertions: Number(counts[3]), logSha256: hash(report) },
        coverage: ['shipped_cli_initialization', 'actual_current_owner_session_and_csrf', 'service_dispatched_public_native_work', 'client_upload_and_committed_artifact', 'later_withdrawal', 'later_private_retirement', 'later_unknown_payment_claim', 'unchanged_current_sql_and_usage', 'completed_recovery_staging_retirement', 'same_client_and_request_receipts_after_repair', 'no_work_or_unknown_effect_replay'], artifactAfter: 'verified_unchanged', liveAccounts: false, physicalVm: 'scripted', nativeDevices: 'not_exercised', compatibleReleaseLifecycle: 'not_exercised', ownerHostCutover: 'not_exercised' }));
    }
  } finally { rmSync(parent, { recursive: true, force: true }); }
}, 180000);

/** Actual owning applications and client, with scripted provider/VM transports and disposable credentials. */
async function fixture() {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-forward-service-'))), directory = join(parent, 'installation'), path = join(parent, 'config.json');
  const base = s15StageConfig(directory, 'http://localhost:3099'), config = { ...base, installationId: 'fixture', files: true, computers: true, vm: { ...base.vm, id: 'vm' } };
  writeFileSync(path, JSON.stringify(config), { mode: 0o600 });
  const init = Bun.spawnSync([process.execPath, 'src/main.ts', 'init', '--s15', '--config', path], { cwd: process.cwd(), env: { PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? '/usr/bin:/bin') }, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: 25000 });
  expect({ exit: init.exitCode, error: init.stderr.toString() }).toEqual({ exit: 0, error: '' });
  let lease!: S16InstallationLease, store!: S14Store, app!: S14Application, token: string, managerId: string | undefined;
  const privateManagers = new Map<string, VmManagement>();
  const owner = () => app.authenticate(token).actor;
  const generation = () => store.read(tx => tx.get<{ generation: number }>('SELECT generation FROM owner')!.generation);
  const openOwner = () => {
    lease = openS16InstallationLease({ directory, mode: 'shared' }); assertS16OperationsOwnerBinding(lease, directory);
    store = new S14Store(join(directory, 'owner/owner.sqlite'));
    app = new S14Application(store, { policy: s14Policy({}), chat: { async reply() { throw new AppError('s15_conversation_required'); } }, now: () => 1000 });
  };
  const closeOwner = async () => { await app.signIns.close(); store.close(); lease.close(); };
  openOwner(); const password = crypto.randomUUID(); await app.provisionOwner(password); token = await app.login(password);
  const f = await composedFixture('default', false, undefined, options => {
    for (const rule of options.proposedPolicy!.rules) { if (!rule.adapters.includes('s16_files')) rule.adapters.push('s16_files'); if (!rule.operations.includes('artifact_create')) rule.operations.push('artifact_create'); }
    options.proposedPolicy!.budget!.ceiling.spendMinor = '10000';
    const manager = options.vm.managers.get('manager')!;
    return { ...options, directory: join(directory, 'runtime'), create: false, installationId: config.installationId, files: {}, computers: { idleStopMs: 1800000, sweepMs: 0 }, browser: { ...options.browser!, resource: { id: 'browser', revision: 1, generation: 1 } },
      owner: { authenticate(value) { lease.assertCurrent(); const auth = app.authenticate(value); return { proof: auth.actor, csrf: auth.csrf }; }, generation,
        verifyOwner(proof) { try { lease.assertCurrent(); store.read(tx => app.requireOwner(tx, proof as ReturnType<typeof owner>)); return { id: 'owner', generation: generation(), expiresAt: 900000 }; } catch { return null; } },
        verifyCsrf: (expected, supplied) => app.verifyCsrf(expected, supplied) },
      vm: { ...options.vm, managementVault: new ConnectionVault(join(directory, 'vault'), { forbidden: [join(directory, 'runtime')] }), managers: new Map([['manager', manager], ...(managerId ? [[managerId, manager] as const] : []), ...privateManagers]) } };
  }, true, owner);
  // The real registry writer records the scripted VM binding. This is no physical VM enrollment proof.
  if (!(f.service.vmManagers instanceof VmManagers)) throw Error('fixture_managers_missing');
  const manager = f.service.vmManagers.get('manager')!;
  const selectedManagerId = f.service.vmManagers.register(f.owner, { kind: 'lima', instance: 'jit-work-fixture' }).managerId;
  managerId = selectedManagerId; f.service.vmManagers.set(selectedManagerId, manager);
  const key = join(parent, 'fixture-key'), known = join(parent, 'fixture-known-hosts');
  writeFileSync(key, 'Disposable scripted SSH marker.', { mode: 0o600 }); writeFileSync(known, 'Disposable host marker.', { mode: 0o600 });
  f.service.vmStore.save({ ...f.service.vmStore.registration('vm'), managerId: selectedManagerId, endpoint: { host: 'fixture.invalid', port: 22, user: 'jit', identityFile: key, knownHostsFile: known } });
  let serving = true;
  const closeService = async () => { if (!serving) return; await f.service.close(); await closeOwner(); serving = false; };
  const reopenService = async () => { if (serving) throw Error('fixture_service_still_open'); openOwner(); await f.reopen(); serving = true; };
  const client = new JitClient({ origin: config.origin, fetch: request => f.service.fetch(new Request(request, { headers: { ...Object.fromEntries(request.headers), cookie: 'jit_s14=' + token, origin: config.origin } })) });
  const addPrivate = (id: string) => {
    if (!(f.service.vmManagers instanceof VmManagers)) throw Error('fixture_managers_missing');
    const registered = f.service.vmManagers.register(f.owner, { kind: 'lima', instance: 'jit-work-' + id.replaceAll('_', '-') }), identity = 'fixture-' + id;
    const privateManager: VmManagement = { ...manager, async inspect() { return { ...await manager.inspect(), identity }; } };
    privateManagers.set(registered.managerId, privateManager); f.service.vmManagers.set(registered.managerId, privateManager);
    f.service.vmStore.save({ ...f.service.vmStore.registration('vm'), id, managerId: registered.managerId, machineIdentity: identity, endpoint: { ...f.service.vmStore.registration('vm').endpoint, host: id.replaceAll('_', '-') + '.invalid' } });
    f.service.computerScopes!.assignPrivate(id, 'bot');
  };
  cleanup.push(async () => { await closeService(); await f.close(); rmSync(parent, { recursive: true, force: true }); });
  return { f, config, directory, client, closeService, reopenService, addPrivate };
}

if (process.env.JIT_S16_FORWARD_SERVICE_CHILD === '1') test('forward repair returns actual service-created bytes through the original authenticated shared client without resurrecting withdrawn history or replaying work', async () => {
  const { f, config, directory, client, closeService, reopenService, addPrivate } = await fixture();
  await client.bootstrap();
  const publication = (stage: string) => { try { f.service.conversation.publish(f.owner, 'message_1', () => {}); } catch (error) { throw Error('fixture_publication_' + stage + '_' + (error as AppError).code); } };
  const uploads = [], artifacts = [], receipts = [];
  for (let at = 0; at < 2; at++) {
    // Distinct scripted working computers keep the first file's VM lineage out of the second work.
    // Merely using another conversation would not remove data already disclosed into a shared VM.
    if (at) await client.computerCommand({ contract: 's16-computer-command/v1', requestId: 'retire_file_computer_' + (at - 1), kind: 'retire_private', vmId: 'vm_file_' + (at - 1) });
    addPrivate('vm_file_' + at);
    const bytes = Buffer.from('Original service input ' + at + '.\n'), conversationId = 'conversation_' + at;
    const pending = await client.createUpload({ requestId: 'upload_' + at, conversationId, name: 'notes.txt', bytes: bytes.length, sha256: hash(bytes) });
    const upload = await client.uploadBytes(pending.id, bytes); expect(upload.state).toBe('ready'); uploads.push(upload);
    f.script = [{ type: 'tool_call', id: 'read_' + at, name: 'file_read', arguments: { id: upload.id, offset: 0 } }, { type: 'tool_call', id: 'create_' + at, name: 'file_create', arguments: { name: 'brief.md', text: '# Service brief ' + at + '\n' } }];
    receipts.push(await client.send({ contract: 's16-conversation/v2', requestId: 'message_' + at, conversationId, text: 'Read these notes and create a Markdown brief.', continuation: null, files: [{ id: upload.id, sha256: upload.receipt!.sha256 }] }));
    await f.service.drain(); const request = await client.request('message_' + at); expect(request.row.state).toBe('done');
    const artifact = request.row.files!.artifacts[0]!; expect(Buffer.from(await client.artifactBytes(artifact)).toString()).toBe('# Service brief ' + at + '\n'); artifacts.push(artifact);
  }
  expect((await client.computers()).computers.find(row => row.id === 'vm_file_1')).toMatchObject({ scope: { kind: 'private', botId: 'bot' }, retired: false });
  publication('private_assignment');
  await closeService(); adoptS16Operations(config, 'service_adopt');
  let ctx = openS16ControlMaintenance(config), backup = ctx.pointCapture('service_backup'), point;
  try { point = await backup.capture(); } finally { await backup.close(); ctx.close(); }
  await reopenService(); await client.bootstrap(); publication('reopen'); await client.withdrawUpload(uploads[0]!.id); publication('withdrawal');
  await expect(client.artifactBytes(artifacts[0]!)).rejects.toMatchObject({ status: 409 });
  await client.computerCommand({ contract: 's16-computer-command/v1', requestId: 'retire_private_after_point', kind: 'retire_private', vmId: 'vm_file_1' });
  publication('private_retirement');
  // The owning POLICY service claims a protected effect without putting account data into the file VM.
  // The network-free payment fixture mutates once and loses its response; no authority row is seeded.
  const pay = f.payment.pay.bind(f.payment); f.payment.pay = async quote => { await pay(quote); throw Error('fixture_lost_payment_response'); };
  const admitted = f.service.policy.owner.admit(f.owner, { requestId: 'unknown_payment', intent: 'execute', access: 'effect', purpose: f.policyInput.purposes[0]!, bot: f.policyInput.bots[0]!, resources: [f.policyInput.resources[2]!], recipients: [f.policyInput.recipients[1]!], selection: f.choice, selectionPin: null, expiresAt: 800000 });
  const actor = f.service.policy.control.bindWork(admitted.work!.id), prepared = f.service.policy.work.prepare(actor, { slot: 'invoice', adapter: 'fixture_payment', proposal: { quoteId: 'invoice', quoteVersion: 'v1' } });
  expect(prepared.decision.state).toBe('hold'); expect(f.payment.mutationCalls).toBe(0);
  const action = { id: prepared.action.id, revision: prepared.action.revision, actionHash: prepared.action.actionHash };
  f.service.policy.owner.decide(f.owner, { requestId: 'approve_fixture_payment', action, decision: 'approve', expiresAt: 800000 });
  expect((await f.service.policy.work.dispatch(actor, action)).outcome).toBe('unknown'); expect(f.payment.mutationCalls).toBe(1);
  const usage = f.service.policy.control.usage(); expect(usage.unsettled).toBeGreaterThan(0); expect(usage.charged.calls).toBeGreaterThan(0);
  publication('unknown_effect');
  expect(Buffer.from(await client.artifactBytes(artifacts[1]!)).toString()).toBe('# Service brief 1\n');
  const prompts = f.modelPrompts.length, vmCalls = f.vmCalls.length;
  await closeService();
  unlinkSync(join(directory, 'runtime/file-bytes', uploads[1]!.id + '.blob'));
  unlinkSync(join(directory, 'runtime/file-bytes', artifacts[1]!.id + '.blob'));
  ctx = openS16ControlMaintenance(config); const before = ctx.sources.map(row => hash(row.database.serialize())), cap = ctx.restorePoint('service_restore', point!.pointId);
  try {
    const recovered = await cap.repair(); expect(recovered.state).toBe('complete'); expect(ctx.sources.map(row => hash(row.database.serialize()))).toEqual(before); await cap.close();
    expect(ctx.retireStaging('service_retire_recovery', { sourceRequestId: 'service_restore' }).state).toBe('removed'); expect(existsSync(join(directory, 'operations/forward-recovery', recovered.operationId))).toBe(false); expect(ctx.sources.map(row => hash(row.database.serialize()))).toEqual(before);
  } finally { await cap.close(); ctx.close(); }
  expect(existsSync(join(directory, 'runtime/file-bytes', uploads[0]!.id + '.blob'))).toBe(false);
  await reopenService(); await client.bootstrap();
  expect((await client.computers()).computers.find(row => row.id === 'vm_file_1')).toMatchObject({ scope: { kind: 'private', botId: 'bot' }, retired: true });
  expect(f.service.computerScopes!.assigned('bot')).toEqual([]);
  expect(f.service.policy.owner.actionSlip(f.owner, action).state).toBe('unknown'); expect(f.service.policy.control.usage()).toEqual(usage);
  await expect(f.service.policy.work.dispatch(f.service.policy.control.bindWork(admitted.work!.id), action)).rejects.toThrow();
  await f.service.drain(); expect(f.payment.mutationCalls).toBe(1);
  expect((await client.uploadStatus(uploads[0]!.id)).state).toBe('withdrawn');
  await expect(client.artifactBytes(artifacts[0]!)).rejects.toMatchObject({ status: 409 });
  expect(Buffer.from(await client.artifactBytes(artifacts[1]!)).toString()).toBe('# Service brief 1\n');
  expect((await client.request('message_1')).receipt).toEqual(receipts[1]!);
  expect((await client.snapshot('conversation_1')).conversation.rows.some(row => row.requestId === 'message_1')).toBe(true);
  expect({ prompts: f.modelPrompts.length, vmCalls: f.vmCalls.length }).toEqual({ prompts, vmCalls });
  expect(readFileSync(join(directory, 'runtime/file-bytes', uploads[1]!.id + '.blob')).toString()).toBe('Original service input 1.\n');
}, 120000);
