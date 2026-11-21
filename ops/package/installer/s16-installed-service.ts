import { lstatSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import type { CommandRunner } from '../../../src/ops/supervisor';
import { spawnRunner } from '../../../src/ops/supervisor';
import { personalServiceBinding } from '../../../src/s14/personal-origin';
import { readS15RuntimeConfig } from '../../../src/s15/runtime-config';
import { assertRootPath, type RootPathPolicy } from '../trusted-paths';
import type { S16ReleaseService } from './s16-release-job';

function refuse(code = 's16_installed_service_refused'): never { throw Error(code); }
/** Original installed identity and fixed public service paths; no provisioning is performed. */
export interface S16InstalledServiceInput {
  configPath: string; state: string; unitPath: string; unit: string; prefix: string; home: string; user: string; bunPath: string;
}
/** Only explicit disposable fixtures replace account/manager/HTTP ports and root ownership policy. */
export interface S16InstalledServiceOptions {
  run?: CommandRunner; pathPolicy?: RootPathPolicy; fetch?: (url: string, init: RequestInit) => Promise<Response>; sleep?: (ms: number) => Promise<void>;
}
/** Exact original config/unit/identity binding; guards are rechecked around every supervisor effect. */
export interface S16InstalledService extends S16ReleaseService {
  readonly identity: Readonly<{ user: string; uid: number; gid: number; home: string }>;
  readonly config: ReturnType<typeof readS15RuntimeConfig>;
  assertCurrent(): Promise<void>;
}

/** Validates an existing installed service without creating users, modifying config or touching controller state. */
export async function bindS16InstalledService(input: S16InstalledServiceInput, options: S16InstalledServiceOptions = {}): Promise<S16InstalledService> {
  input = Object.freeze({ ...input });
  if (!/^[a-z_][a-z0-9_-]{0,31}$/.test(input.user) || !/^[a-zA-Z0-9_-]+\.service$/.test(input.unit) ||
    [input.configPath, input.state, input.unitPath, input.prefix, input.home, input.bunPath].some(path => !isAbsolute(path) || resolve(path) !== path || /[\s\0]/.test(path))) refuse();
  const policy = options.pathPolicy ?? {}, run = options.run ?? spawnRunner;
  const call = async (argv: string[], timeoutMs = 30000, deadline = Infinity) => {
    const remaining = Math.min(timeoutMs, deadline - Date.now()); if (remaining < 1) refuse('s16_installed_service_deadline');
    const result = await run(argv, { cwd: '/', env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin' }, timeoutMs: remaining });
    if (result.exitCode !== 0 || result.timedOut || Buffer.byteLength(result.stdout) >= 65536) refuse('s16_installed_service_command_unknown');
    return result.stdout;
  };
  const pin = (path: string, metadataOnly = false) => {
    assertRootPath(path, policy); const before = lstatSync(path, { bigint: true });
    if (!before.isFile() || before.nlink !== 1n || !metadataOnly && before.size > 131072n) refuse();
    const bytes = metadataOnly ? Buffer.alloc(0) : readFileSync(path), after = lstatSync(path, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.ctimeNs !== after.ctimeNs || before.mtimeNs !== after.mtimeNs || before.size !== after.size || !metadataOnly && before.size !== BigInt(bytes.length)) refuse();
    return { path, stat: before, bytes, metadataOnly };
  };
  const pins = [pin(input.configPath), pin(input.unitPath), pin(input.bunPath, true)];
  const config = readS15RuntimeConfig(input.configPath);
  if (config.directory !== input.state) refuse('s16_installed_service_configuration_changed');
  const unit = pins[1]!.bytes.toString('utf8'), service = unit.split('[Service]\n');
  if (service.length !== 2) refuse('s16_installed_service_unit_changed');
  const fields = service[1]!.split(/^\[/m)[0]!.split('\n');
  for (const [name, expected] of [['User', input.user], ['Group', input.user], ['ExecStart', `${input.bunPath} ${input.prefix}/current/src/main.ts serve --s15 --config ${input.configPath}`]]) {
    const found = fields.filter(line => line.startsWith(name + '=')); if (found.length !== 1 || found[0] !== `${name}=${expected}`) refuse('s16_installed_service_unit_changed');
  }
  const passwd = (await call(['/usr/bin/getent', 'passwd', input.user])).trim();
  const account = passwd.split(':');
  if (account.length !== 7 || account[0] !== input.user || account[5] !== input.home || !['/usr/sbin/nologin', '/sbin/nologin', '/bin/false', '/usr/bin/false'].includes(account[6]!) || !/^[1-9]\d*$/.test(account[2]!) || !/^[1-9]\d*$/.test(account[3]!)) refuse('s16_installed_service_identity_changed');
  const identity = Object.freeze({ user: input.user, uid: Number(account[2]), gid: Number(account[3]), home: input.home });
  if (![identity.uid, identity.gid].every(id => Number.isSafeInteger(id) && id <= 4294967294)) refuse();
  let vmmAccount: { user: string; raw: string } | undefined;
  if (config.vm.local) {
    const vmm = config.vm.vmm;
    if (!vmm || vmm.user !== 'jit-s15-vmm' || vmm.directory !== '/var/lib/jit-s15-vm' || vmm.launcher !== join(input.prefix, 'libexec/jit-s15-vmm')) refuse('s16_installed_service_vmm_changed');
    const raw = (await call(['/usr/bin/getent', 'passwd', vmm.user])).trim(), fields = raw.split(':');
    if (vmm.uid === identity.uid || fields.length !== 7 || fields[0] !== vmm.user || fields[2] !== String(vmm.uid) || !/^[1-9]\d*$/.test(fields[3]!) || fields[5] !== '/var/lib/jit-s15-vmm' || !['/usr/sbin/nologin', '/sbin/nologin', '/bin/false', '/usr/bin/false'].includes(fields[6]!)) refuse('s16_installed_service_vmm_changed');
    vmmAccount = { user: vmm.user, raw };
  }
  const state = lstatSync(input.state, { bigint: true });
  if (!state.isDirectory() || state.uid !== BigInt(identity.uid) || state.mode & 0o022n) refuse('s16_installed_service_state_changed');
  const assertCurrent = async (deadline = Infinity) => {
    for (const original of pins) {
      const now = pin(original.path, original.metadataOnly);
      if (original.stat.dev !== now.stat.dev || original.stat.ino !== now.stat.ino || original.stat.size !== now.stat.size || original.stat.ctimeNs !== now.stat.ctimeNs || original.stat.mtimeNs !== now.stat.mtimeNs || !original.bytes.equals(now.bytes)) refuse('s16_installed_service_binding_changed');
    }
    const now = lstatSync(input.state, { bigint: true });
    if (now.dev !== state.dev || now.ino !== state.ino || now.uid !== state.uid || now.gid !== state.gid || now.mode !== state.mode || !now.isDirectory() || (await call(['/usr/bin/getent', 'passwd', input.user], 30000, deadline)).trim() !== passwd) refuse('s16_installed_service_identity_changed');
    if (vmmAccount && (await call(['/usr/bin/getent', 'passwd', vmmAccount.user], 30000, deadline)).trim() !== vmmAccount.raw) refuse('s16_installed_service_vmm_changed');
  };
  const observe = async (deadline = Infinity) => {
    await assertCurrent(deadline);
    const raw = await call(['/usr/bin/systemctl', 'show', input.unit, '--property=LoadState,ActiveState,SubState,MainPID,ControlPID,Job,FragmentPath,DropInPaths,NeedDaemonReload,User,Group'], 30000, deadline);
    const fields = new Map<string, string>();
    for (const line of raw.trimEnd().split('\n')) {
      const at = line.indexOf('='); if (at < 1 || fields.has(line.slice(0, at))) refuse('s16_installed_service_state_unknown'); fields.set(line.slice(0, at), line.slice(at + 1));
    }
    if ([...fields.keys()].sort().join(',') !== 'ActiveState,ControlPID,DropInPaths,FragmentPath,Group,Job,LoadState,MainPID,NeedDaemonReload,SubState,User' || fields.get('LoadState') !== 'loaded' ||
      fields.get('FragmentPath') !== input.unitPath || fields.get('DropInPaths') !== '' || fields.get('NeedDaemonReload') !== 'no' || fields.get('User') !== input.user || fields.get('Group') !== input.user ||
      !/^(0|[1-9]\d*)$/.test(fields.get('MainPID')!) || !/^(0|[1-9]\d*)$/.test(fields.get('ControlPID')!) || !['', '0'].includes(fields.get('Job')!)) refuse('s16_installed_service_state_unknown');
    await assertCurrent(deadline); return fields;
  };
  const assertStopped = async () => {
    const state = await observe();
    if (!['inactive', 'failed'].includes(state.get('ActiveState')!) || !['dead', 'failed'].includes(state.get('SubState')!) || state.get('MainPID') !== '0' || state.get('ControlPID') !== '0') refuse('s16_installed_service_not_stopped');
  };
  const active = (state: Map<string, string>) => state.get('ActiveState') === 'active' && state.get('SubState') === 'running' && Number.isSafeInteger(Number(state.get('MainPID'))) && Number(state.get('MainPID')) > 0 && state.get('ControlPID') === '0';
  const binding = personalServiceBinding(config.origin), host = binding.hostname.includes(':') ? `[${binding.hostname}]` : binding.hostname;
  return Object.freeze({ identity, config, assertCurrent, assertStopped,
    async stop() { await assertCurrent(); await call(['/usr/bin/systemctl', 'stop', input.unit], 120000); await assertStopped(); },
    async start() { await assertStopped(); await call(['/usr/bin/systemctl', 'start', input.unit], 120000); if (!active(await observe())) refuse('s16_installed_service_not_running'); },
    async healthy() {
      const deadline = Date.now() + 30000;
      for (let attempt = 0; attempt < 30 && Date.now() < deadline; attempt++) {
        const before = await observe(deadline); if (!active(before)) return false;
        let ok = false;
        try { const response = await (options.fetch ?? fetch)(`http://${host}:${binding.port}/s14/login`, { headers: { host: new URL(config.origin).host }, redirect: 'manual', signal: AbortSignal.timeout(Math.max(1, Math.min(1000, deadline - Date.now()))) }); ok = response.status === 200; await response.body?.cancel(); } catch { /* Bounded failed readiness, never presumed success. */ }
        const after = await observe(deadline); if (!active(after) || after.get('MainPID') !== before.get('MainPID')) return false;
        if (ok) return true;
        await (options.sleep ?? Bun.sleep)(Math.max(0, Math.min(500, deadline - Date.now())));
      }
      return false;
    },
  });
}
