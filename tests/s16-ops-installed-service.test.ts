import { afterEach, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindS16InstalledService } from '../ops/package/installer/s16-installed-service';
import type { CommandRunner } from '../src/ops/supervisor';
import { s15StageConfig } from '../ops/evidence/s15-stage';
import { openS16RootReleaseSelector } from '../ops/package/installer/s16-release-selector';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'jit-installed-service-'))); roots.push(root);
  const prefix = join(root, 'opt/jit-s15'), home = join(root, 'var/lib/jit-s15'), state = join(home, 'state'), configPath = join(root, 's15.json'), unitPath = join(root, 'jit-s15.service'), bunPath = join(prefix, 'bin/bun');
  mkdirSync(state, { recursive: true }); mkdirSync(join(prefix, 'bin'), { recursive: true });
  writeFileSync(bunPath, 'Inert executable witness: this fixture never executes Bun.', { mode: 0o755 });
  writeFileSync(configPath, JSON.stringify(s15StageConfig(state, 'http://localhost:3041')), { mode: 0o600 });
  writeFileSync(unitPath, `[Service]\nUser=jit-fixture\nGroup=jit-fixture\nExecStart=${bunPath} ${prefix}/current/src/main.ts serve --s15 --config ${configPath}\n`, { mode: 0o644 });
  let passwd = `jit-fixture:x:${process.getuid!()}:${process.getgid!()}:${''}:${home}:/usr/sbin/nologin`;
  const observed: Record<string, string> = { LoadState: 'loaded', ActiveState: 'inactive', SubState: 'dead', MainPID: '0', ControlPID: '0', Job: '', FragmentPath: unitPath, DropInPaths: '', NeedDaemonReload: 'no', User: 'jit-fixture', Group: 'jit-fixture', KillMode: 'mixed', SendSIGKILL: 'yes' };
  const commands: string[][] = []; let healthy = true, httpCalls = 0;
  const run: CommandRunner = async argv => {
    commands.push(argv);
    if (argv[0] === '/usr/bin/getent') return { exitCode: 0, timedOut: false, stdout: passwd + '\n' };
    if (argv[0] !== '/usr/bin/systemctl' || argv[2] !== 'jit-s15.service') throw Error('unexpected_fixture_command');
    if (argv[1] === 'show') return { exitCode: 0, timedOut: false, stdout: argv[3]!.slice('--property='.length).split(',').map(key => `${key}=${observed[key]}\n`).join('') };
    if (argv[1] === 'start') Object.assign(observed, { ActiveState: 'active', SubState: 'running', MainPID: '741' });
    else if (argv[1] === 'stop') Object.assign(observed, { ActiveState: 'inactive', SubState: 'dead', MainPID: '0' });
    else throw Error('unexpected_fixture_effect');
    return { exitCode: 0, timedOut: false, stdout: '' };
  };
  const input = { configPath, state, unitPath, unit: 'jit-s15.service', prefix, home, user: 'jit-fixture', bunPath };
  const options = { run, pathPolicy: { root, uid: process.getuid!() }, sleep: async () => {}, fetch: (async (url: string, options: RequestInit) => {
    httpCalls++; expect(String(url)).toBe('http://localhost:3041/s14/login'); expect(new Headers(options?.headers).get('host')).toBe('localhost:3041'); expect(options?.redirect).toBe('manual');
    return new Response('', { status: healthy ? 200 : 503 });
  }) };
  return { input, options, observed, commands, setPasswd: (value: string) => { passwd = value; }, setHealth: (value: boolean) => { healthy = value; }, httpCalls: () => httpCalls };
}

test('installed manager adapter proves original stop and process-stable loopback health without config/unit changes', async () => {
  const f = fixture(), config = readFileSync(f.input.configPath), unit = readFileSync(f.input.unitPath), cap = await bindS16InstalledService(f.input, f.options);
  await cap.assertStopped(); await cap.start(); expect(await cap.healthy()).toBe(true); await cap.stop(); await cap.assertStopped();
  expect(f.commands.filter(argv => ['start', 'stop'].includes(argv[1]!))).toEqual([['/usr/bin/systemctl', 'start', 'jit-s15.service'], ['/usr/bin/systemctl', 'stop', 'jit-s15.service']]);
  expect(f.httpCalls()).toBe(1); expect(readFileSync(f.input.configPath)).toEqual(config); expect(readFileSync(f.input.unitPath)).toEqual(unit);
});

test.each([
  ['MainPID', '81'], ['MainPID', ''], ['ControlPID', '17'], ['Job', '42'], ['LoadState', 'not-found'], ['SubState', 'stop-sigterm'],
  ['DropInPaths', '/etc/systemd/system/jit-s15.service.d/override.conf'], ['NeedDaemonReload', 'yes'], ['User', 'someone-else'], ['FragmentPath', '/another.service'],
  ['KillMode', 'process'], ['SendSIGKILL', 'no'],
] as const)('installed manager refuses unknown or unsettled %s=%s before start', async (key, value) => {
  const f = fixture(), cap = await bindS16InstalledService(f.input, f.options); f.observed[key] = value;
  await expect(cap.start()).rejects.toThrow(); expect(f.commands.some(argv => argv[1] === 'start')).toBe(false); expect(f.httpCalls()).toBe(0);
});

test.each(['config_bytes', 'unit_inode', 'identity', 'writable_config'] as const)('changed original %s refuses before any supervisor effect', async mode => {
  const f = fixture(), cap = await bindS16InstalledService(f.input, f.options);
  if (mode === 'config_bytes') writeFileSync(f.input.configPath, readFileSync(f.input.configPath, 'utf8') + ' ');
  if (mode === 'unit_inode') { const bytes = readFileSync(f.input.unitPath); renameSync(f.input.unitPath, f.input.unitPath + '.retained'); writeFileSync(f.input.unitPath, bytes); }
  if (mode === 'identity') f.setPasswd(`jit-fixture:x:990:990::${f.input.home}:/usr/sbin/nologin`);
  if (mode === 'writable_config') chmodSync(f.input.configPath, 0o666);
  await expect(cap.stop()).rejects.toThrow(); expect(f.commands.some(argv => argv[0] === '/usr/bin/systemctl')).toBe(false);
});

test('readiness is finite and a process replacement during HTTP is never certified healthy', async () => {
  const f = fixture(), cap = await bindS16InstalledService(f.input, f.options); await cap.start(); f.setHealth(false);
  expect(await cap.healthy()).toBe(false); expect(f.httpCalls()).toBe(30);
  f.setHealth(true); const changed = await bindS16InstalledService(f.input, { ...f.options, fetch: async () => { f.observed.MainPID = '742'; return new Response('', { status: 200 }); } });
  expect(await changed.healthy()).toBe(false);
});

test('local VMM identity is preserved and UID drift refuses before a controller effect', async () => {
  const f = fixture(), configured = JSON.parse(readFileSync(f.input.configPath, 'utf8'));
  configured.vm.local = true; configured.vm.vmm = { user: 'jit-s15-vmm', uid: 1002, directory: '/var/lib/jit-s15-vm', launcher: join(f.input.prefix, 'libexec/jit-s15-vmm') };
  writeFileSync(f.input.configPath, JSON.stringify(configured), { mode: 0o600 });
  let vmmUid = 1002;
  const run: CommandRunner = (argv, settings) => argv[0] === '/usr/bin/getent' && argv[2] === 'jit-s15-vmm' ? Promise.resolve({ exitCode: 0, timedOut: false, stdout: `jit-s15-vmm:x:${vmmUid}:1002::/var/lib/jit-s15-vmm:/usr/sbin/nologin\n` }) : f.options.run(argv, settings);
  const cap = await bindS16InstalledService(f.input, { ...f.options, run }); await cap.assertStopped(); vmmUid++;
  await expect(cap.stop()).rejects.toThrow('s16_installed_service_vmm_changed'); expect(f.commands.some(argv => argv[1] === 'stop')).toBe(false);
});

test('missing and duplicate manager fields and successful HTTP with no live PID remain unknown', async () => {
  const f = fixture(), cap = await bindS16InstalledService(f.input, f.options); delete f.observed.MainPID;
  await expect(cap.assertStopped()).rejects.toThrow('s16_installed_service_state_unknown');
  f.observed.MainPID = '0'; f.observed.ActiveState = 'active'; f.observed.SubState = 'running'; expect(await cap.healthy()).toBe(false); expect(f.httpCalls()).toBe(0);
  const duplicate = await bindS16InstalledService(f.input, { ...f.options, run: async (argv, options) => { const result = await f.options.run(argv, options); return argv[1] === 'show' ? { ...result, stdout: result.stdout + 'Job=\n' } : result; } });
  await expect(duplicate.assertStopped()).rejects.toThrow('s16_installed_service_state_unknown');
});

test('only genuine held root exclusion and original unit bytes permit retained missing-unit stop recovery', async () => {
  const f = fixture(), bytes = readFileSync(f.input.unitPath), root = openS16RootReleaseSelector({ prefix: f.input.prefix, pathPolicy: f.options.pathPolicy }); root.acquire();
  try {
    unlinkSync(f.input.unitPath);
    await expect(bindS16InstalledService(f.input, f.options)).rejects.toThrow('s16_installed_service_unit_changed');
    await expect(bindS16InstalledService(f.input, { ...f.options, retainedUnit: { bytes, selector: { ...root } } })).rejects.toThrow('s16_root_selector_capability_mismatch');
    const cap = await bindS16InstalledService(f.input, { ...f.options, retainedUnit: { bytes, selector: root } });
    f.observed.LoadState = 'not-found'; await cap.stopRetained(); await cap.assertStoppedRetained();
    f.observed.MainPID = '81'; await expect(cap.assertStoppedRetained()).rejects.toThrow('s16_installed_service_not_stopped');
    root.close(); await expect(cap.assertRetained()).rejects.toThrow('s16_root_selector_not_acquired');
  } finally { root.close(); }
});
