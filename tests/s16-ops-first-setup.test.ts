import { afterAll, expect, beforeAll, test } from 'bun:test';
import { chmodSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { RELEASE_CONTRACT } from 'schway/host';
import { buildPackage, installArtifactDependencies, validateArtifact } from '../ops/package/bun-build';
import { openS16FirstSetup, type S16FirstSetupInput, type S16FirstSetupOptions } from '../ops/package/installer/s16-first-setup';
import { readS16Wiring, s16WiringLayout } from '../ops/package/installer/s16-wiring-value';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { canonical } from '../src/s15/conversation/validation';
import { spawnRunner, type CommandRunner } from '../src/ops/supervisor';

let root: string, artifact: string, artifactHash: string;
const env = { PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin' }, hash = (value: string | Uint8Array) => new Bun.CryptoHasher('sha256').update(value).digest('hex');
beforeAll(async () => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-first-selected-')));
  const staging = join(root, 'build'), manifest = buildPackage({ srcDir: process.cwd(), outDir: staging, engineContract: RELEASE_CONTRACT, engineRevision: null });
  await installArtifactDependencies(staging, { bunPath: process.execPath, run: spawnRunner, env, timeoutMs: 120000 }); artifact = join(root, manifest.artifactId); renameSync(staging, artifact); artifactHash = manifest.contentHash;
}, 120000);
afterAll(() => { try { const checked = validateArtifact(artifact, { runtime: true }); expect(checked.ok && checked.manifest?.contentHash === artifactHash).toBe(true); } finally { if (root) rmSync(root, { recursive: true, force: true }); } });
async function fixture() {
  const sandbox = realpathSync(mkdtempSync(join(root, 'host-'))), layout = s16WiringLayout(sandbox), release = join(layout.prefix, 'releases', basename(artifact)), bun = join(layout.prefix, 'bin/bun');
  mkdirSync(dirname(release), { recursive: true }); cpSync(artifact, release, { recursive: true }); mkdirSync(dirname(bun)); copyFileSync(process.execPath, bun, constants.COPYFILE_FICLONE); chmodSync(bun, 0o755); mkdirSync(layout.home, { recursive: true }); mkdirSync(dirname(layout.config), { recursive: true });
  const config = { ...s15StageConfig(layout.state, 'http://localhost:3041'), files: true, vm: { ...s15StageConfig(layout.state, 'http://localhost:3041').vm, local: false } }, raw = JSON.stringify(config);
  writeFileSync(layout.config, raw, { mode: 0o600 });
  const unit = `[Service]\nUser=jit-fixture\nGroup=jit-fixture\nExecStart=${bun} ${layout.prefix}/current/src/main.ts serve --s15 --config ${layout.config}\nKillMode=mixed\n\n[Install]\nWantedBy=multi-user.target\n`;
  const wiring = { contract: 's16-installed-wiring-value/v1' as const, files: { controller: { bytes: Buffer.from(unit).toString('base64'), uid: process.getuid!(), gid: process.getgid!(), mode: 0o644 }, journal: null, proxy: null, keyring: null } };
  const input: S16FirstSetupInput = { contract: 's16-first-selected-setup/v1', release, packageSha256: artifactHash, configurationSha256: hash(canonical(config)), rawConfigurationSha256: hash(raw), bunPath: bun, service: { user: 'jit-fixture', uid: process.getuid!(), gid: process.getgid!(), home: layout.home }, wiring };
  const counts = { initialize: 0, starts: 0, stops: 0, ownerPreparation: 0 }; let running = false, healthy = true, onStart: (() => Promise<void>) | undefined;
  const run: CommandRunner = async (argv, options) => {
    const result = (stdout = '', exitCode = 0) => ({ stdout, exitCode, timedOut: false });
    if (argv[0] === '/usr/bin/getent') return result(`jit-fixture:x:${process.getuid!()}:${process.getgid!()}::${layout.home}:/usr/sbin/nologin\n`);
    if (argv[0] === '/usr/bin/systemctl') {
      if (argv[1] === 'show') {
        const fields: Record<string, string> = { LoadState: 'loaded', ActiveState: running ? 'active' : 'inactive', SubState: running ? 'running' : 'dead', MainPID: running ? '901' : '0', ControlPID: '0', Job: '', FragmentPath: layout.files.controller, DropInPaths: '', NeedDaemonReload: 'no', User: 'jit-fixture', Group: 'jit-fixture', KillMode: 'mixed', SendSIGKILL: 'yes' };
        return result(argv[3]!.slice('--property='.length).split(',').map(key => `${key}=${fields[key]}\n`).join(''));
      }
      if (argv[1] === 'stop') { running = false; counts.stops++; }
      else if (argv[1] === 'start') { running = true; counts.starts++; await onStart?.(); }
      else if (!['daemon-reload', 'enable'].includes(argv[1]!)) throw Error('fixture_unexpected_manager_command');
      return result();
    }
    if (JSON.stringify(argv.slice(0, 6)) !== JSON.stringify(['/usr/sbin/runuser', '-u', 'jit-fixture', '--', '/usr/bin/env', '-i'])) throw Error('fixture_unexpected_identity_command');
    const bunIndex = argv.indexOf(bun); if (bunIndex < 0) throw Error('fixture_bun_missing'); const entry = argv[bunIndex + 1]!;
    if (entry === '--version') return spawnRunner([bun, '--version'], { ...options, env });
    if (entry.endsWith('/s16-package-probe.ts')) {
      const args = argv.slice(bunIndex + 2);
      return spawnRunner([bun, '-e', `import{openS16PackageReaderProbe}from${JSON.stringify(entry)};const cap=await openS16PackageReaderProbe({targetDirectory:${JSON.stringify(args[1])},packageSha256:${JSON.stringify(args[3])},configPath:${JSON.stringify(args[5])},configurationSha256:${JSON.stringify(args[7])}},{pathPolicy:${JSON.stringify({ root, uid: process.getuid!() })}});try{const value=await cap.observe();cap.close();console.log(JSON.stringify(value));}finally{cap.close();}`], { ...options, env });
    }
    if (argv.slice(bunIndex + 2).includes('init')) counts.initialize++;
    return spawnRunner([bun, ...argv.slice(bunIndex + 1)], { ...options, env });
  };
  const options: S16FirstSetupOptions = { run, layoutRoot: sandbox, pathPolicy: { root, uid: process.getuid!() }, sleep: async () => {}, fetch: async () => new Response('', { status: healthy ? 200 : 503 }), async prepareOwnerLink() { counts.ownerPreparation++; } };
  const open = (initial: S16FirstSetupInput | undefined = input, after?: S16FirstSetupOptions['after']) => openS16FirstSetup(initial, { ...options, ...(after ? { after } : {}) });
  const resume = (after?: S16FirstSetupOptions['after']) => openS16FirstSetup(undefined, { ...options, ...(after ? { after } : {}) });
  const execute = (code: string) => spawnRunner([bun, '-e', code], { cwd: release, env, timeoutMs: 30000 });
  return { sandbox, layout, release, input, counts, open, resume, execute, setHealth: (value: boolean) => { healthy = value; }, onStart: (hook: () => Promise<void>) => { onStart = hook; } };
}

test('first selected setup runs actual initializer/adoption/readers once and keeps terminal retry inert', async () => {
  const f = await fixture(), setup = f.open(); let result;
  try { result = await setup.run(); } finally { setup.close(); }
  expect(result).toMatchObject({ state: 'healthy', release: f.release }); expect(f.counts).toEqual({ initialize: 1, starts: 1, stops: 1, ownerPreparation: 1 });
  expect(readFileSync(f.layout.config, 'utf8')).toBe(JSON.stringify({ ...s15StageConfig(f.layout.state, 'http://localhost:3041'), files: true, vm: { ...s15StageConfig(f.layout.state, 'http://localhost:3041').vm, local: false } }));
  expect(readS16Wiring(s16WiringLayout(f.sandbox), process.getuid!(), { root, uid: process.getuid!() })).toEqual(f.input.wiring);
  const control = readFileSync(join(f.layout.state, 'operations/control.json')), before = { ...f.counts }, retry = f.resume();
  try { expect(await retry.run()).toEqual(result); } finally { retry.close(); }
  expect(f.counts).toEqual(before); expect(readFileSync(join(f.layout.state, 'operations/control.json'))).toEqual(control);
}, 120000);

test('first health failure preserves later actual owning file and original owner session for continuation without another init', async () => {
  const f = await fixture(), tokenPath = join(f.sandbox, 'owner-token.fixture.json'); let written: { id: string; sha256: string } | undefined;
  f.onStart(async () => {
    if (written) return;
    const code = `import{join}from'node:path';import{writeFileSync}from'node:fs';import{S14Store}from'./src/s14/store';import{S14Application}from'./src/s14/application';import{s14Policy}from'./src/s14/policy';import{FileStore}from'./src/s16/files/store';const ownerStore=new S14Store(${JSON.stringify(join(f.layout.state, 'owner/owner.sqlite'))}),app=new S14Application(ownerStore,{policy:s14Policy({}),chat:{async reply(){throw Error('unused');}}});await app.provisionOwner('Disposable fixture password');const token=await app.login('Disposable fixture password'),actor=app.authenticate(token).actor;writeFileSync(${JSON.stringify(tokenPath)},JSON.stringify({token}),{mode:0o600,flag:'wx'});const store=new FileStore({path:${JSON.stringify(join(f.layout.state, 'runtime/files.sqlite'))},directory:${JSON.stringify(join(f.layout.state, 'runtime/file-bytes'))},installationId:'s15_staged_controller',create:false,resource:{id:'computer',revision:1,generation:1},requireOwner:()=>({id:actor.ownerId,generation:1})});try{const bytes=Buffer.from('Retain owning file after first trial'),sha256=new Bun.CryptoHasher('sha256').update(bytes).digest('hex'),upload=store.create(actor,{requestId:'first_trial_input',conversationId:'first_trial_conversation',name:'trial.txt',bytes:bytes.length,sha256});await store.write(actor,upload.id,new Blob([bytes]).stream());console.log(JSON.stringify({id:upload.id,sha256}));}finally{await store.close();await app.signIns.close();ownerStore.close();}`;
    const result = await f.execute(code); expect(result).toMatchObject({ exitCode: 0, timedOut: false }); written = JSON.parse(result.stdout);
  });
  f.setHealth(false); const first = f.open(); try { await expect(first.run()).rejects.toThrow('s16_first_setup_health_failed'); } finally { first.close(); }
  expect(written).toBeDefined(); const blob = join(f.layout.state, 'runtime/file-bytes', written!.id + '.blob'), original = readFileSync(blob), session = readFileSync(tokenPath);
  f.setHealth(true); const resume = f.resume(); try { expect((await resume.run()).state).toBe('healthy'); } finally { resume.close(); }
  expect(f.counts.initialize).toBe(1); expect(readFileSync(blob)).toEqual(original); expect(hash(readFileSync(blob))).toBe(written!.sha256); expect(readFileSync(tokenPath)).toEqual(session);
  const authenticated = await f.execute(`import{readFileSync}from'node:fs';import{S14Store}from'./src/s14/store';import{S14Application}from'./src/s14/application';import{s14Policy}from'./src/s14/policy';const store=new S14Store(${JSON.stringify(join(f.layout.state, 'owner/owner.sqlite'))}),app=new S14Application(store,{policy:s14Policy({}),chat:{async reply(){throw Error('unused');}}});try{const actor=app.authenticate(JSON.parse(readFileSync(${JSON.stringify(tokenPath)},'utf8')).token).actor;console.log(JSON.stringify({owner:actor.ownerId}));}finally{await app.signIns.close();store.close();}`);
  expect(authenticated).toMatchObject({ exitCode: 0 }); expect(JSON.parse(authenticated.stdout)).toEqual({ owner: 'owner' });
}, 120000);

test.each(['entire_state', 'owning_store'] as const)('missing %s after original initialization intent refuses without another initializer', async mode => {
  const f = await fixture(), setup = f.open(undefined, at => { if (at === 'initialized') throw Error('fixture_after_init'); });
  try { await expect(setup.run()).rejects.toThrow('fixture_after_init'); } finally { setup.close(); }
  const path = mode === 'entire_state' ? f.layout.state : join(f.layout.state, 'runtime/work.sqlite'); rmSync(path, { recursive: true, force: true });
  const resume = f.resume(); try { await expect(resume.run()).rejects.toThrow(); } finally { resume.close(); }
  expect(f.counts.initialize).toBe(1); expect(existsSync(path)).toBe(false); expect(f.counts.starts).toBe(0);
}, 90000);

test('a retained original setup intent before any initialization resumes its original package and units', async () => {
  const f = await fixture(), setup = f.open(undefined, at => { if (at === 'intent') throw Error('fixture_before_selection'); });
  try { await expect(setup.run()).rejects.toThrow('fixture_before_selection'); } finally { setup.close(); }
  expect(f.counts.initialize).toBe(0); const resume = f.resume(); try { expect((await resume.run()).release).toBe(f.release); } finally { resume.close(); }
  expect(f.counts.initialize).toBe(1);
}, 120000);
