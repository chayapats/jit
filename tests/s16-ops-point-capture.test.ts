import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { RELEASE_CONTRACT } from 'schway/host';
import { buildPackage, installArtifactDependencies, validateArtifact } from '../ops/package/bun-build';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { spawnRunner } from '../src/ops/supervisor';
import { openS16ControlMaintenance } from '../src/s16/operations/control-maintenance';
import { pointFormatFixture } from './fixtures/s16-point';

let parent: string, artifact: string;
const cleanup: (() => void)[] = [], requestId = 'backup_original';
const env = { PATH: dirname(process.execPath) + ':' + (process.env.PATH ?? '/usr/bin:/bin') };
beforeAll(async () => {
  parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-point-package-'))); artifact = join(parent, 'artifact');
  buildPackage({ srcDir: process.cwd(), outDir: artifact, engineContract: RELEASE_CONTRACT, engineRevision: null });
  await installArtifactDependencies(artifact, { bunPath: process.execPath, run: spawnRunner, env, timeoutMs: 120000 });
}, 120000);
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
afterAll(() => { if (parent) rmSync(parent, { recursive: true, force: true }); });
async function run(args: string[]) {
  const child = Bun.spawn([process.execPath, ...args], { cwd: artifact, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }), timer = setTimeout(() => child.kill('SIGKILL'), 25000);
  try { const [exit, out, error] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]); return { exit, out, error }; } finally { clearTimeout(timer); }
}
async function fixture(notifications = true) {
  const root = realpathSync(mkdtempSync(join(parent, 'state-'))), directory = join(root, 'installation'), config = join(root, 'config.json'); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(config, JSON.stringify({ ...s15StageConfig(directory, 'http://localhost:3041'), files: true, ...(notifications ? { notifications: true } : {}) }), { mode: 0o600 });
  const selected = ['--s15', '--config', config], init = await run(['src/main.ts', 'init', ...selected]); expect({ exit: init.exit, error: init.error }).toEqual({ exit: 0, error: '' });
  const setup = `import {join} from 'node:path';import {FileStore} from './src/s16/files/store';import {readS15RuntimeConfig} from './src/s15/runtime-config';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance';const config=readS15RuntimeConfig(${JSON.stringify(config)}),ctx=openS16ControlMaintenance(config),ownerId=ctx.ownerIdentity;ctx.close();const store=new FileStore({path:join(config.directory,'runtime/files.sqlite'),directory:join(config.directory,'runtime/file-bytes'),installationId:config.installationId,create:false,resource:{id:'computer',revision:1,generation:1},requireOwner:()=>({id:ownerId,generation:1})});try{const bytes=Buffer.from('Private original current input.\\n'),upload=store.create({}, {requestId:'file_original',conversationId:'conversation',name:'notes.txt',bytes:bytes.length,sha256:new Bun.CryptoHasher('sha256').update(bytes).digest('hex')});await store.write({},upload.id,new Blob([bytes]).stream());console.log(JSON.stringify({uploadId:upload.id}));}finally{await store.close();}`;
  const seeded = await run(['-e', setup]); expect({ exit: seeded.exit, error: seeded.error }).toEqual({ exit: 0, error: '' }); const uploadId = JSON.parse(seeded.out).uploadId as string;
  const adopted = await run(['src/s16/operations-cli.ts', 'adopt', ...selected, '--request-id', 'adoption_original']); expect({ exit: adopted.exit, error: adopted.error }).toEqual({ exit: 0, error: '' });
  const control = () => JSON.parse(readFileSync(join(directory, 'operations/control.json'), 'utf8'));
  const request = () => control().requests.find((row: { requestId: string }) => row.requestId === requestId);
  const backup = (...extra: string[]) => run(['src/s16/operations-cli.ts', 'backup', ...selected, '--request-id', requestId, ...extra]);
  return { root, directory, config, selected, uploadId, control, request, backup };
}

test('actual copied operator publishes the complete selected point with genuine package/external receipts and preserves owning bytes', async () => {
  const f = await fixture(), paths = ['owner/owner.sqlite', 'owner/owner.sqlite.lifecycle.sqlite', 'runtime/files.sqlite', 'runtime/file-bytes/' + f.uploadId + '.blob'], before = paths.map(path => readFileSync(join(f.directory, path)));
  const first = await f.backup(); expect({ exit: first.exit, error: first.error }).toEqual({ exit: 0, error: '' }); const result = JSON.parse(first.out), point = join(f.directory, 'operations/points', result.pointId);
  expect(f.request()).toMatchObject({ status: 'complete', phase: 'complete', actions: [{ kind: 'capture_native', state: 'confirmed' }, { kind: 'own_staging', state: 'confirmed' }, { kind: 'capture_backend', state: 'confirmed' }, { kind: 'own_staging', state: 'confirmed' }, { kind: 'replace', state: 'confirmed' }] });
  expect(f.control().points).toHaveLength(1); expect(paths.map(path => readFileSync(join(f.directory, path)))).toEqual(before);
  const manifest = JSON.parse(readFileSync(join(point, 'manifest.json'), 'utf8')), references = JSON.parse(readFileSync(join(point, 'references.json'), 'utf8'));
  expect(manifest.package.contentHash).toBe(validateArtifact(artifact, { runtime: true }).manifest!.contentHash);
  expect(references.external.contract).toBe('s16-external-custody/v1'); expect(references.external).not.toHaveProperty('basis');
  expect(references.external.client.ownerGeneration).toBeNull(); expect(references.external.retained.vapid.present).toBe(false);
  const fileCatalog = JSON.parse(readFileSync(join(point, 'payloads', result.pointId, 'file_cohort.json'), 'utf8')), githubCatalog = JSON.parse(readFileSync(join(point, 'payloads', result.pointId, 'github_cohort.json'), 'utf8'));
  expect(fileCatalog.contract).toBe('s16-file-cohort/v1'); expect(fileCatalog.files[0]).toMatchObject({ state: 'ready', trust: 'owning_pinned', rowId: f.uploadId }); expect(githubCatalog.contract).toBe('s16-github-artifact-cohort/v1');
  expect(await f.backup()).toEqual(first); expect(existsSync(join(f.directory, 'owner/owner.sqlite.ops/fence.json'))).toBe(false);
  const retired = await run(['src/s16/operations-cli.ts', 'cleanup', ...f.selected, '--request-id', 'retire_original', '--point-id', result.pointId]); expect(retired.exit).toBe(0); expect(existsSync(point)).toBe(false);
  const staging = await run(['src/s16/operations-cli.ts', 'retire-staging', ...f.selected, '--request-id', 'staging_original', '--source-request-id', requestId]); expect({ exit: staging.exit, error: staging.error }).toEqual({ exit: 0, error: '' });
  expect(readdirSync(join(f.directory, 'operations/native-staging', result.operationId))).toEqual([]); expect(readdirSync(join(f.directory, 'operations/point-staging', result.operationId))).toEqual([]); expect(paths.map(path => readFileSync(join(f.directory, path)))).toEqual(before);
  const again = await f.backup(); expect(again.exit).toBe(1); expect(JSON.parse(again.error).error).toBe('s16_ops_point_unavailable'); expect(existsSync(point)).toBe(false);
}, 30000);

test.each(['admitted', 'capturing', 'native', 'intent', 'plan', 'sql', 'payload', 'manifest', 'observed', 'verifying', 'publish_intent', 'published', 'publication_observed', 'receipt', 'complete'] as const)('actual SIGKILL after %s resumes original backup without duplicate action, point or application recovery', async boundary => {
  const f = await fixture(), code = `import {readS15RuntimeConfig} from './src/s15/runtime-config';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance';const ctx=openS16ControlMaintenance(readS15RuntimeConfig(${JSON.stringify(f.config)})),cap=ctx.pointCapture('${requestId}',{after(at){if(at===${JSON.stringify(boundary)})process.kill(process.pid,'SIGKILL');}});await cap.capture();throw Error('fixture_did_not_interrupt');`;
  const killed = await run(['-e', code]); expect(killed.error).toBe(''); expect(killed.exit).not.toBe(0); const original = f.request(); expect(original).toBeDefined();
  const recovered = await f.backup(); expect({ exit: recovered.exit, error: recovered.error }).toEqual({ exit: 0, error: '' });
  expect(JSON.parse(recovered.out).operationId).toBe(original.id); expect(f.request().createdAt).toBe(original.createdAt); expect(f.request().admittedRevision).toBe(original.admittedRevision);
  expect(f.request().actions).toHaveLength(5); expect(f.request().actions.slice(0, original.actions.length).map((row: { id: string }) => row.id)).toEqual(original.actions.map((row: { id: string }) => row.id));
  expect(f.control().points).toHaveLength(1); expect(readdirSync(join(f.directory, 'operations/points'))).toEqual([original.pointId]); expect(f.request().status).toBe('complete');
}, 30000);

test('published missing bytes refuse without rewriting the candidate or dropping the original unknown publication gate', async () => {
  const f = await fixture(), code = `import {readS15RuntimeConfig} from './src/s15/runtime-config';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance';const ctx=openS16ControlMaintenance(readS15RuntimeConfig(${JSON.stringify(f.config)})),cap=ctx.pointCapture('${requestId}',{after(at){if(at==='published')process.kill(process.pid,'SIGKILL');}});await cap.capture();`;
  const killed = await run(['-e', code]); expect(killed.error).toBe(''); const original = f.request(), point = join(f.directory, 'operations/points', original.pointId), files = readdirSync(join(point, 'payloads', original.pointId)), name = files.find(name => name.startsWith('file_'))!;
  const path = join(point, 'payloads', original.pointId, name); unlinkSync(path); const retry = await f.backup(); expect(retry.exit).toBe(1); expect(existsSync(path)).toBe(false);
  expect(f.request().id).toBe(original.id); expect(f.request().status).toBe('unknown'); expect(existsSync(join(f.directory, 'owner/owner.sqlite.ops/fence.json'))).toBe(true); expect(f.control().points).toHaveLength(0);
});

test('unsealed source execution refuses before creating an operation or staging and retains the original owning context', async () => {
  const f = await pointFormatFixture(); cleanup.push(f.dispose); const before = readFileSync(join(f.directory, 'operations/control.json')), capture = f.context.pointCapture('unsealed_original');
  await expect(capture.capture()).rejects.toThrow(expect.objectContaining({ code: 's16_ops_verified_package_required' }));
  expect(readFileSync(join(f.directory, 'operations/control.json'))).toEqual(before); expect(existsSync(join(f.directory, 'operations/point-staging'))).toBe(false);
  expect(() => f.context.retireSources()).toThrow(expect.objectContaining({ code: 's16_ops_source_release_unknown' })); f.context.assertCurrent();
  expect(() => f.context.close()).toThrow(expect.objectContaining({ code: 's16_ops_source_release_unknown' })); await capture.close(); f.context.close();
});

test('a newly selected feature without its owning persisted store refuses before an operation or empty initialization', async () => {
  const f = await fixture(false), config = JSON.parse(readFileSync(f.config, 'utf8')); config.notifications = true; writeFileSync(f.config, JSON.stringify(config)); const before = f.control();
  const result = await f.backup(); expect(result.exit).toBe(1); expect(JSON.parse(result.error).error).toBe('s16_ops_selected_store_missing'); expect(f.control()).toEqual(before);
  expect(existsSync(join(f.directory, 'runtime/notifications.sqlite'))).toBe(false); expect(existsSync(join(f.directory, 'operations/point-staging'))).toBe(false);
});

test('incomplete corrupt staging is observed not applied and only a distinct local capture attempt may proceed', async () => {
  const f = await fixture(), code = `import {readS15RuntimeConfig} from './src/s15/runtime-config';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance';const ctx=openS16ControlMaintenance(readS15RuntimeConfig(${JSON.stringify(f.config)})),cap=ctx.pointCapture('${requestId}',{after(at){if(at==='sql')process.kill(process.pid,'SIGKILL');}});await cap.capture();`;
  const killed = await run(['-e', code]); expect(killed.error).toBe(''); const original = f.request(), action = original.actions.find((row: { kind: string }) => row.kind === 'capture_backend'), stage = join(f.directory, 'operations/point-staging', original.id, action.id, 'data');
  const path = join(stage, 'ledgers', original.pointId, 'model.sqlite'); writeFileSync(path, 'interrupted local copy', { mode: 0o600 }); const failed = await f.backup(); expect(failed.exit).toBe(1);
  expect(f.request().actions.find((row: { id: string }) => row.id === action.id).state).toBe('not_applied'); expect(existsSync(join(f.directory, 'operations/points', original.pointId))).toBe(false);
  const same = await f.backup(); expect(same.exit).toBe(1); expect(JSON.parse(same.error).error).toBe('s16_ops_point_distinct_attempt_required');
  const next = await f.backup('--attempt', 'second'); expect({ exit: next.exit, error: next.error }).toEqual({ exit: 0, error: '' }); expect(f.request().id).toBe(original.id); expect(f.request().actions).toHaveLength(9);
  expect(f.request().actions.find((row: { id: string }) => row.id === action.id).state).toBe('not_applied'); expect(readFileSync(path, 'utf8')).toBe('interrupted local copy'); expect(f.control().points).toHaveLength(1);
}, 30000);


test('actual copied operator aborts a present corrupt capture manifest without relabelling original uncertainty, then retires all owned staging', async () => {
  const f = await fixture(), killed = await run(['-e', `import {readS15RuntimeConfig} from './src/s15/runtime-config';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance';const ctx=openS16ControlMaintenance(readS15RuntimeConfig(${JSON.stringify(f.config)})),cap=ctx.pointCapture('${requestId}',{after(at){if(at==='manifest')process.kill(process.pid,'SIGKILL');}});await cap.capture();`]);
  expect(killed.exit).not.toBe(0); expect(killed.error).toBe(''); const original = f.request(), action = original.actions.find((row: { kind: string }) => row.kind === 'capture_backend'), path = join(f.directory, 'operations/point-staging', original.id, action.id, 'data/manifest.json'); writeFileSync(path, '{torn metadata');
  const retry = await f.backup(); expect(retry.exit).toBe(1); const unknown = f.request(); expect(unknown.status).toBe('unknown');
  const aborted = await run(['src/s16/operations-cli.ts', 'abort-backup', ...f.selected, '--request-id', requestId]); expect({ exit: aborted.exit, error: aborted.error }).toEqual({ exit: 0, error: '' }); expect(f.request().actions).toEqual(unknown.actions); expect(f.request().status).toBe('discarded'); expect(readFileSync(path, 'utf8')).toBe('{torn metadata');
  const removed = await run(['src/s16/operations-cli.ts', 'retire-staging', ...f.selected, '--request-id', 'staging_original', '--source-request-id', requestId]); expect({ exit: removed.exit, error: removed.error }).toEqual({ exit: 0, error: '' }); expect(existsSync(path)).toBe(false); expect(existsSync(join(f.directory, 'owner/owner.sqlite.ops/fence.json'))).toBe(false); expect(f.control().points).toHaveLength(0);
  const next = await run(['src/s16/operations-cli.ts', 'backup', ...f.selected, '--request-id', 'backup_next']); expect({ exit: next.exit, error: next.error }).toEqual({ exit: 0, error: '' }); expect(f.control().points).toHaveLength(1); expect(f.request().actions).toEqual(unknown.actions);
}, 30000);

test.each(['quarantine_intent', 'quarantined', 'quarantine_observed', 'discarded'] as const)('actual SIGKILL at abort %s reconciles original unknown publication and owned inode without a replacement point', async boundary => {
  const f = await fixture(), killed = await run(['-e', `import {readS15RuntimeConfig} from './src/s15/runtime-config';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance';const ctx=openS16ControlMaintenance(readS15RuntimeConfig(${JSON.stringify(f.config)})),cap=ctx.pointCapture('${requestId}',{after(at){if(at==='published')process.kill(process.pid,'SIGKILL');}});await cap.capture();`]); expect(killed.exit).not.toBe(0); expect(killed.error).toBe('');
  const original = f.request(), point = join(f.directory, 'operations/points', original.pointId), manifest = join(point, 'manifest.json'); writeFileSync(manifest, '{partial archive metadata');
  const interrupted = await run(['-e', `import {readS15RuntimeConfig} from './src/s15/runtime-config';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance';import {readS16OperationsFence} from './src/s16/operations/operations-state';const config=readS15RuntimeConfig(${JSON.stringify(f.config)}),ctx=openS16ControlMaintenance(config,{operationFence:readS16OperationsFence(config.directory)});ctx.abortBackup('${requestId}',{after(at){if(at===${JSON.stringify(boundary)})process.kill(process.pid,'SIGKILL');}});`]); expect(interrupted.exit).not.toBe(0); expect(interrupted.error).toBe('');
  const result = await run(['src/s16/operations-cli.ts', 'abort-backup', ...f.selected, '--request-id', requestId]); expect({ exit: result.exit, error: result.error }).toEqual({ exit: 0, error: '' }); expect(f.request().id).toBe(original.id); expect(f.request().actions.slice(0, original.actions.length)).toEqual(original.actions); expect(existsSync(point)).toBe(false); expect(f.control().points).toHaveLength(0); expect(f.request().actions.at(-1)).toMatchObject({ kind: 'quarantine_point', state: 'confirmed' });
}, 30000);

test.each(['admitted', 'prepared', 'activating', 'intent', 'plan', 'file', 'directory', 'observed', 'complete'] as const)('actual SIGKILL at staging retirement %s resumes original immutable removal plan and preserves retained point', async boundary => {
  const f = await fixture(), backup = await f.backup(); expect({ exit: backup.exit, error: backup.error }).toEqual({ exit: 0, error: '' }); const saved = JSON.parse(backup.out), point = join(f.directory, 'operations/points', saved.pointId), manifest = readFileSync(join(point, 'manifest.json'));
  const killed = await run(['-e', `import {readS15RuntimeConfig} from './src/s15/runtime-config';import {openS16ControlMaintenance} from './src/s16/operations/control-maintenance';const ctx=openS16ControlMaintenance(readS15RuntimeConfig(${JSON.stringify(f.config)}));ctx.retireStaging('staging_original',{sourceRequestId:'${requestId}',after(at){if(at===${JSON.stringify(boundary)})process.kill(process.pid,'SIGKILL');}});`]); expect(killed.exit).not.toBe(0); expect(killed.error).toBe(''); const original = f.control().requests.find((row: { requestId: string }) => row.requestId === 'staging_original'); expect(original).toBeDefined();
  const resumed = await run(['src/s16/operations-cli.ts', 'retire-staging', ...f.selected, '--request-id', 'staging_original', '--source-request-id', requestId]); expect({ exit: resumed.exit, error: resumed.error }).toEqual({ exit: 0, error: '' }); expect(JSON.parse(resumed.out).operationId).toBe(original.id); expect(readFileSync(join(point, 'manifest.json'))).toEqual(manifest); expect(await f.backup()).toEqual(backup); expect(f.control().points).toHaveLength(1);
}, 30000);
