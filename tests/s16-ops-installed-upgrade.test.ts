import { afterAll, afterEach, beforeAll, expect, test } from 'bun:test';
import { chmodSync, constants, copyFileSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { RELEASE_CONTRACT } from 'schway/host';
import { buildPackage, installArtifactDependencies, readDependencyRecord, validateArtifact } from '../ops/package/bun-build';
import { openS16InstalledUpgrade, type S16InstalledUpgrade } from '../ops/package/installer/s16-installed-upgrade';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { spawnRunner, type CommandRunner } from '../src/ops/supervisor';
import { s16ReleaseFixtureRunner } from './fixtures/s16-release-job';
import { opsDirectory, opsWrite } from '../src/s14/ops-files';

let root: string;
const packages: { path: string; hash: string; dependencyHash: string; dependencyFiles: number; lockHash: string; sourceCommit: string }[] = [], caps: S16InstalledUpgrade[] = [];
const env = { PATH: dirname(process.execPath) + ':/usr/bin:/bin:/usr/sbin:/sbin' };
beforeAll(async () => {
  const receipt = process.env.JIT_S16_INSTALLED_UPGRADE_RECEIPT;
  if (receipt && (!isAbsolute(receipt) || existsSync(receipt))) throw Error('fixture_receipt_must_be_fresh_absolute_path');
  if (receipt) opsDirectory(dirname(receipt));
  root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-installed-upgrade-')));
  for (const [name, revision] of [['old', '23cfb85d1051ab52b42fefd421c85cd86388f6c3'], ['current', null]] as const) {
    let source = process.cwd();
    if (revision) {
      source = join(root, 'old-source'); mkdirSync(source);
      const archive = join(root, 'old.tar'), result = await spawnRunner(['git', 'archive', '--format=tar', '--output=' + archive, revision], { cwd: process.cwd(), env, timeoutMs: 30000 });
      if (result.exitCode !== 0 || (await spawnRunner(['/usr/bin/tar', '-xf', archive, '-C', source], { env, timeoutMs: 30000 })).exitCode !== 0) throw Error('fixture_archive_failed');
    }
    const staging = join(root, name), manifest = buildPackage({ srcDir: source, outDir: staging, engineContract: RELEASE_CONTRACT, engineRevision: null });
    const dependencies = await installArtifactDependencies(staging, { bunPath: process.execPath, run: spawnRunner, env, timeoutMs: 120000 });
    const path = join(root, manifest.artifactId); renameSync(staging, path);
    const sourceCommit = revision ?? Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' }).stdout.toString().trim();
    packages.push({ path, hash: manifest.contentHash, dependencyHash: dependencies.dependencyHash, dependencyFiles: dependencies.dependencyFiles, lockHash: manifest.lockHash, sourceCommit });
  }
}, 120000);
afterEach(() => { for (const cap of caps.splice(0).reverse()) cap.close(); });
afterAll(() => {
  try {
    for (const pkg of packages) { const checked = validateArtifact(pkg.path, { runtime: true }); expect(checked.ok && checked.manifest?.contentHash === pkg.hash && readDependencyRecord(pkg.path)?.dependencyHash === pkg.dependencyHash).toBe(true); }
    const receipt = process.env.JIT_S16_INSTALLED_UPGRADE_RECEIPT;
    if (receipt) {
      const source = Bun.spawnSync(['git', 'rev-parse', 'HEAD'], { stdout: 'pipe', stderr: 'ignore' }), status = Bun.spawnSync(['git', 'status', '--porcelain'], { stdout: 'pipe', stderr: 'ignore' });
      opsWrite(receipt, JSON.stringify({ contract: 's16-installed-upgrade-artifact-evidence/v1', sourceCommit: source.stdout.toString().trim(), sourceState: source.exitCode === 0 && status.exitCode === 0 && !status.stdout.length && packages[1]?.sourceCommit === source.stdout.toString().trim() ? 'clean' : 'unverified',
        packages: packages.map(({ path: _path, ...pkg }) => pkg), platform: process.platform, arch: process.arch, bunVersion: Bun.version, engineContract: RELEASE_CONTRACT, engineRevision: 'unverified', artifactsAfter: 'verified_unchanged', testOutcomes: 'separate_test_log_required',
        driverSha256: new Bun.CryptoHasher('sha256').update(readFileSync(import.meta.path)).digest('hex'), controller: 'actual_copied_protected_helpers', rootSelection: 'actual_filesystem_and_process_lease', accountSystemdHttp: 'scripted_fixture_ports', identityTransition: 'fixture_runner_not_linux_enforcement', liveAccounts: false, nativeDevices: 'not_exercised', uninstallReinstall: 'not_exercised' }));
    }
  }
  finally { if (root) rmSync(root, { recursive: true, force: true }); }
});
async function fixture(failTrial = false) {
  const sandbox = realpathSync(mkdtempSync(join(root, 'installation-'))), prefix = join(sandbox, 'opt/jit-s15'), home = join(sandbox, 'var/lib/jit-s15'), state = join(home, 'state'), configPath = join(sandbox, 's15.json'), unitPath = join(sandbox, 'jit-s15.service'), bunPath = join(prefix, 'bin/bun');
  mkdirSync(join(prefix, 'bin'), { recursive: true }); mkdirSync(join(prefix, 'releases')); mkdirSync(home, { recursive: true });
  copyFileSync(process.execPath, bunPath, constants.COPYFILE_FICLONE); chmodSync(bunPath, 0o755);
  const a = join(prefix, 'releases', packages[0]!.path.split('/').at(-1)!); cpSync(packages[0]!.path, a, { recursive: true }); symlinkSync(a, join(prefix, 'current'));
  writeFileSync(configPath, JSON.stringify({ ...s15StageConfig(state, 'http://localhost:3041'), files: true }), { mode: 0o600 });
  writeFileSync(unitPath, `[Service]\nUser=jit-fixture\nGroup=jit-fixture\nExecStart=${bunPath} ${prefix}/current/src/main.ts serve --s15 --config ${configPath}\n`, { mode: 0o644 });
  for (const args of [['src/main.ts', 'init', '--s15', '--config', configPath], ['src/s16/operations-cli.ts', 'adopt', '--s15', '--config', configPath, '--request-id', 'installed_adopt']]) {
    const result = await spawnRunner([bunPath, ...args], { cwd: packages[1]!.path, env, timeoutMs: 30000 }); expect(result).toMatchObject({ exitCode: 0, timedOut: false });
  }
  const observed = { ActiveState: 'active', SubState: 'running', MainPID: '741' }, effects: string[] = [];
  const helper = s16ReleaseFixtureRunner(root, env);
  const run: CommandRunner = async (argv, settings) => {
    if (argv[0] === '/usr/bin/getent') return { exitCode: 0, timedOut: false, stdout: `jit-fixture:x:${process.getuid!()}:${process.getgid!()}::${home}:/usr/sbin/nologin\n` };
    if (argv[0] !== '/usr/bin/systemctl') return helper(argv, settings);
    if (argv[2] !== 'jit-s15.service') throw Error('fixture_unexpected_unit');
    if (argv[1] === 'show') return { exitCode: 0, timedOut: false, stdout: Object.entries({ LoadState: 'loaded', ...observed, ControlPID: '0', Job: '', FragmentPath: unitPath, DropInPaths: '', NeedDaemonReload: 'no', User: 'jit-fixture', Group: 'jit-fixture', KillMode: 'mixed', SendSIGKILL: 'yes' }).map(([k, v]) => `${k}=${v}\n`).join('') };
    effects.push(argv[1]!);
    if (argv[1] === 'stop') Object.assign(observed, { ActiveState: 'inactive', SubState: 'dead', MainPID: '0' });
    else if (argv[1] === 'start') Object.assign(observed, { ActiveState: 'active', SubState: 'running', MainPID: String(742 + effects.length) });
    else throw Error('fixture_unexpected_host_change');
    return { exitCode: 0, timedOut: false, stdout: '' };
  };
  const input = { source: packages[1]!.path, installation: { configPath, state, unitPath, unit: 'jit-s15.service', prefix, home, user: 'jit-fixture', bunPath } };
  const options = { run, pathPolicy: { root, uid: process.getuid!() }, sleep: async () => {}, fetch: async () => new Response('', { status: failTrial && readlinkSync(join(prefix, 'current')) !== a ? 503 : 200 }) };
  const open = (source = input.source, after?: (boundary: 'located' | 'completed') => void) => { const cap = openS16InstalledUpgrade({ ...input, source }, { ...options, ...(after ? { after } : {}) }); caps.push(cap); return cap; };
  const control = () => JSON.parse(readFileSync(join(state, 'operations/control.json'), 'utf8'));
  const config = readFileSync(configPath), unit = readFileSync(unitPath), composition = readFileSync(join(state, 'runtime/composition.json')), stateInode = lstatSync(state).ino;
  const retained = () => { expect(readFileSync(configPath)).toEqual(config); expect(readFileSync(unitPath)).toEqual(unit); expect(readFileSync(join(state, 'runtime/composition.json'))).toEqual(composition); expect(lstatSync(state).ino).toBe(stateInode); };
  return { input, open, effects, control, retained, a, target: join(prefix, 'releases', packages[1]!.path.split('/').at(-1)!) };
}

test('installed adapter publishes the sealed package and runs actual guarded helpers; terminal rerun never restarts the service', async () => {
  const f = await fixture(), cap = f.open(), result = await cap.run();
  const competing = f.open(); await expect(competing.run()).rejects.toThrow(); competing.close(); cap.close();
  expect(result).toMatchObject({ release: f.target, outcome: 'selected_healthy' }); expect(f.effects).toEqual(['stop', 'start']); f.retained();
  expect(f.control().requests.filter((r: { kind: string }) => r.kind === 'upgrade')).toHaveLength(1);
  expect(existsSync(join(f.input.installation.state, 'owner/owner.sqlite.ops/fence.json'))).toBe(false);
  const retry = f.open(), before = readFileSync(join(f.input.installation.state, 'operations/control.json')); expect(await retry.run()).toEqual({ release: f.target, outcome: 'unchanged', job: null }); retry.close();
  expect(f.effects).toEqual(['stop', 'start']); expect(readFileSync(join(f.input.installation.state, 'operations/control.json'))).toEqual(before); f.retained();
  const rawSource = join(f.input.installation.home, 'raw-source'); cpSync(packages[1]!.path, rawSource, { recursive: true }); rmSync(join(rawSource, 'manifest.json'));
  const rebuilt = f.open(rawSource); expect(await rebuilt.run()).toEqual({ release: f.target, outcome: 'unchanged', job: null }); rebuilt.close();
  expect(f.effects).toEqual(['stop', 'start']); expect(readFileSync(join(f.input.installation.state, 'operations/control.json'))).toEqual(before); f.retained();
}, 90000);

test('original locator resumes before a newly requested unavailable source and does not allocate another job', async () => {
  const f = await fixture(), interrupted = f.open(undefined, boundary => { if (boundary === 'located') throw Error('fixture_interrupted_locator'); });
  await expect(interrupted.run()).rejects.toThrow('fixture_interrupted_locator'); interrupted.close(); expect(f.effects).toEqual([]);
  const locatorPath = join(f.input.installation.prefix, '.s16-selector/installer.json'), original = JSON.parse(readFileSync(locatorPath, 'utf8'));
  const resumed = f.open(join(root, 'unavailable-source')); await expect(resumed.run()).rejects.toThrow(); resumed.close();
  expect(readlinkSync(join(f.input.installation.prefix, 'current'))).toBe(f.target); expect(f.effects).toEqual(['stop', 'start']);
  expect(JSON.parse(readFileSync(locatorPath, 'utf8'))).toEqual({ ...original, terminal: true });
  expect(f.control().requests.filter((r: { kind: string }) => r.kind === 'upgrade')).toHaveLength(1); f.retained();
}, 90000);

test('failed installed trial uses actual fresh-current compatible fallback without replacing composition/config or units', async () => {
  const f = await fixture(true), cap = f.open(), result = await cap.run(); cap.close();
  expect(result).toMatchObject({ release: f.a, outcome: 'fallback_healthy' }); expect(f.effects).toEqual(['stop', 'start', 'stop', 'start']);
  expect(f.control().requests.filter((r: { kind: string }) => r.kind === 'upgrade')).toHaveLength(2); expect(f.control().points).toHaveLength(2); f.retained();
}, 120000);

test('missing original adoption refuses before staging, stopping or legacy fallback', async () => {
  const f = await fixture(), path = join(f.input.installation.state, 'operations/control.json'); renameSync(path, path + '.retained');
  const cap = f.open(); await expect(cap.run()).rejects.toThrow('s16_installed_upgrade_adoption_required'); cap.close();
  expect(existsSync(path)).toBe(false); expect(f.effects).toEqual([]); expect(existsSync(f.target)).toBe(false); f.retained();
}, 30000);
