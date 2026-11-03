import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Install only on the NEW disposable arm64 controller. No existing host/service name is accepted.
if (process.env.JIT_S15_ARM64_EVIDENCE !== '1' || process.platform !== 'linux' || process.arch !== 'arm64' || process.getuid?.() !== 0) throw Error('disposable_controller_root_required');
const sha = process.argv[2]; if (!sha || !/^[a-f0-9]{40}$/.test(sha)) throw Error('exact_sha_required');
const build = `/home/jit-s15/releases/${sha}`, config = '/home/jit-s15/evidence/service-config.json';
if (!existsSync(join(build, 'src/s15/main.ts')) || existsSync(config)) throw Error('fresh_staged_service_required');
const run = async (argv: string[], cwd = build) => {
  const p = Bun.spawn(argv, { cwd, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' }); const timer = setTimeout(() => p.kill(), 300000);
  try { const [out, error, exit] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]); if (exit !== 0) throw Error('staging_command_failed:' + argv[0]); return out; } finally { clearTimeout(timer); }
};
const asUser = (args: string[]) => ['sudo', '-n', '-u', 'jit-s15', 'env', 'HOME=/home/jit-s15', ...args];
await run(['apt-get', 'install', '-y', '-qq', 'dbus-user-session', 'gnome-keyring']);
const uid = (await run(['id', '-u', 'jit-s15'])).trim();
await run(asUser(['bun', '-e', 'import {prepareInstallerHome} from "./ops/package/installer/installer";prepareInstallerHome("/home/jit-s15",true);']));
await run(['loginctl', 'enable-linger', 'jit-s15']); await run(['systemctl', 'start', `user@${uid}.service`]);
await run(asUser(['env', `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`, 'systemctl', '--user', 'enable', '--now', 'gnome-keyring-daemon.service']));
await run(asUser(['env', 'JIT_S15_ARM64_EVIDENCE=1', 'bun', 'ops/evidence/s15-stage.ts', '/home/jit-s15/staged-' + sha.slice(0, 12), config]));
await run(asUser(['bun', 'src/main.ts', 'init', '--s15', '--config', config]));
const unit = `[Unit]\nDescription=Isolated S15 evidence controller (${sha})\nAfter=network-online.target user@${uid}.service\nRequires=user@${uid}.service\n[Service]\nUser=jit-s15\nGroup=jit-s15\nWorkingDirectory=${build}\nEnvironment=HOME=/home/jit-s15\nEnvironment=XDG_RUNTIME_DIR=/run/user/${uid}\nEnvironment=DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus\nExecStart=/usr/local/bin/bun ${build}/src/main.ts serve --s15 --config ${config}\nRestart=on-failure\nTimeoutStopSec=45\nUMask=0077\nNoNewPrivileges=true\nPrivateTmp=true\n[Install]\nWantedBy=multi-user.target\n`;
writeFileSync('/etc/systemd/system/jit-s15-evidence.service', unit, { mode: 0o644, flag: 'wx' });
await run(['ln', '-sfn', build, '/home/jit-s15/current']);
await run(['systemctl', 'daemon-reload']); await run(['systemctl', 'enable', '--now', 'jit-s15-evidence.service']);
let status = 0;
for (let i = 0; i < 30; i++) { try { status = (await fetch('http://localhost:3041/s14/login')).status; if (status === 200) break; } catch {} await Bun.sleep(100); }
if (status !== 200) throw Error('staged_login_unavailable');
console.log(JSON.stringify({ contract: 's15-staged-service/v1', sha, service: 'jit-s15-evidence.service', build, config, httpLoginStatus: status, owner: 'not_provisioned', policy: 'not_installed', acceptance: 'pending' }));
