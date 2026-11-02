import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { LimaVmManagement, limaRestrictedQemu } from '../../src/s15/vm';
import { createVmManagementRelay } from '../../src/s15/vm/remote';
import { vmHostCommand, vmQuote } from '../../src/s15/vm/host';

/** Explicit disposable-host evidence only; never part of default tests, paid inference or owner cutover. */
export async function runS15Arm64Evidence() {
  if (process.env.JIT_S15_ARM64_EVIDENCE !== '1' || process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('explicit_arm64_evidence_opt_in_required');
  const directory = resolve(process.env.JIT_S15_EVIDENCE_DIRECTORY ?? '.local/s15-evidence'); mkdirSync(directory, { recursive: true, mode: 0o700 });
  const run = async (argv: string[], timeoutMs = 120000, input?: Uint8Array) => {
    const result = await vmHostCommand(argv, { timeoutMs, maxBytes: 2 * 1024 * 1024, ...(input ? { input } : {}) }); if (result.exitCode !== 0) throw Error('evidence_command_failed:' + argv[0]); return Buffer.from(result.stdout).toString();
  };
  const sha = (await run(['git', 'rev-parse', 'HEAD'])).trim();
  if ((await run(['git', 'status', '--porcelain'])).trim()) throw Error('exact_build_requires_clean_worktree');
  const wrapper = join(directory, 'qemu-restricted'); writeFileSync(wrapper, limaRestrictedQemu('/opt/homebrew/bin/qemu-system-aarch64', 3128), { mode: 0o700 }); chmodSync(wrapper, 0o700);
  const manager = new LimaVmManagement({ instance: 'jit-work-arm', env: { QEMU_SYSTEM_AARCH64: wrapper } });
  const credential = randomBytes(32).toString('base64url'), relay = createVmManagementRelay(manager, credential);
  const bootstrap = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    try {
      const expected = 'Bearer ' + credential, supplied = request.headers.get('authorization') ?? '';
      if (expected.length !== supplied.length || !timingSafeEqual(Buffer.from(expected), Buffer.from(supplied))) return new Response(null, { status: 401 });
      if (request.method !== 'POST' || Number(request.headers.get('content-length') ?? 0) > 1024) return new Response(null, { status: 400 });
      const text = await request.text(); if (Buffer.byteLength(text) > 1024) return new Response(null, { status: 413 }); const input = JSON.parse(text);
      if (Object.keys(input).join() !== 'publicKey' || !/^ssh-ed25519 [A-Za-z0-9+/=]{68} jit-working-vm$/.test(input.publicKey)) return new Response(null, { status: 400 });
      const command = `install -d -m 700 ~/.ssh && printf '%s\\n' ${vmQuote('restrict ' + input.publicKey)} >> ~/.ssh/authorized_keys && chmod 600 ~/.ssh/authorized_keys && if test -d /etc/cloud/cloud.cfg.d; then printf '%s\\n' 'ssh_deletekeys: false' | sudo -n tee /etc/cloud/cloud.cfg.d/99-jit-working-vm.cfg >/dev/null; fi && sudo -n sync`;
      await run(['limactl', 'shell', '--workdir', '/', 'jit-work-arm', 'sh', '-c', command]); return Response.json({ state: 'installed' });
    } catch { return new Response(null, { status: 503 }); }
  } });
  const working = JSON.parse(await run(['limactl', 'list', '--json', 'jit-work-arm']));
  const sshConfig = join(homedir(), '.lima/jit-s15-arm/ssh.config'), relayPort = 43151, bootstrapPort = 43152;
  let tunnel: ReturnType<typeof Bun.spawn> | null = null;
  const output = `/home/jit-s15/evidence/run-${sha.slice(0, 12)}-${Date.now()}`;
  try {
    const before = await run(['limactl', 'snapshot', 'list', 'jit-work-arm', '--quiet']); writeFileSync(join(directory, 'snapshots-before.txt'), before, { mode: 0o600 });
    if ((await manager.inspect()).state === 'stopped') await manager.start();
    tunnel = Bun.spawn(['ssh', '-F', sshConfig, '-N', '-o', 'ExitOnForwardFailure=yes', '-o', 'ServerAliveInterval=5', '-R', `${relayPort}:127.0.0.1:${new URL(relay.origin).port}`, '-R', `${bootstrapPort}:127.0.0.1:${bootstrap.port}`, '-R', `${working.sshLocalPort}:127.0.0.1:${working.sshLocalPort}`, 'lima-jit-s15-arm'], { stdin: 'ignore', stdout: 'ignore', stderr: 'ignore' });
    const browser = (await run(['limactl', 'shell', '--workdir', '/', 'jit-s15-arm', 'sudo', '-n', '-u', 'jit-s15', 'sh', '-c', 'find /home/jit-s15/.cache/ms-playwright -path "*/chrome-linux64/chrome" -type f | head -1'])).trim();
    if (!browser) throw Error('controller_chromium_not_installed');
    const archive = await run(['git', 'archive', '--format=tar', `--output=${join(directory, 'build.tar')}`, 'HEAD']); void archive;
    await run(['limactl', 'copy', join(directory, 'build.tar'), 'jit-s15-arm:/tmp/jit-s15-build.tar']);
    await run(['limactl', 'shell', '--workdir', '/', 'jit-s15-arm', 'sudo', '-n', 'sh', '-c', 'tar -xf /tmp/jit-s15-build.tar -C /home/jit-s15/build && chown -R jit-s15:jit-s15 /home/jit-s15/build']);
    await run(['limactl', 'shell', '--workdir', '/', 'jit-s15-arm', 'sudo', '-n', '-u', 'jit-s15', 'env', 'HOME=/home/jit-s15', 'sh', '-c', 'cd /home/jit-s15/build && bun install --frozen-lockfile']);
    const payload = Buffer.from(JSON.stringify({ relay: `http://127.0.0.1:${relayPort}`, bootstrap: `http://127.0.0.1:${bootstrapPort}`, credential, user: working.config.user.name, port: working.sshLocalPort, sha, browser, output }));
    const result = await run(['limactl', 'shell', '--workdir', '/', 'jit-s15-arm', 'sudo', '-n', '-u', 'jit-s15', 'env', 'HOME=/home/jit-s15', 'JIT_S15_ARM64_EVIDENCE=1', 'sh', '-c', 'cd /home/jit-s15/build && bun ops/evidence/s15-controller.ts'], 600000, payload);
    writeFileSync(join(directory, 'controller-summary.json'), result, { mode: 0o600 });
    await run(['limactl', 'shell', '--workdir', '/', 'jit-s15-arm', 'sudo', '-n', 'cp', output + '/results.json', '/tmp/jit-s15-results.json']);
    await run(['limactl', 'copy', 'jit-s15-arm:/tmp/jit-s15-results.json', join(directory, 'results.json')]);
  } finally {
    tunnel?.kill(); if (tunnel) await tunnel.exited; bootstrap.stop(true); relay.close(); await manager.stop().catch(() => {});
    const after = await run(['limactl', 'snapshot', 'list', 'jit-work-arm', '--quiet']); writeFileSync(join(directory, 'snapshots-after.txt'), after, { mode: 0o600 });
    const baseline = readFileSync(join(directory, 'snapshots-before.txt'), 'utf8').trim().split('\n').filter(Boolean); if (!baseline.every(tag => after.trim().split('\n').includes(tag))) throw Error('baseline_snapshot_missing');
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify({ sha, controller: 'jit-s15-arm', workingVm: 'jit-work-arm', output, baselineSnapshotsRetained: true, testedAt: new Date().toISOString(), controllerConfigHash: new Bun.CryptoHasher('sha256').update(readFileSync(join(homedir(), '.lima/jit-s15-arm/lima.yaml'))).digest('hex'), workingConfigHash: new Bun.CryptoHasher('sha256').update(readFileSync(join(homedir(), '.lima/jit-work-arm/lima.yaml'))).digest('hex'), schwayTarballHash: new Bun.CryptoHasher('sha256').update(readFileSync('vendor/schway-1.0.0-rc.2-697bf40.tgz')).digest('hex') }, null, 2), { mode: 0o600 });
  }
}
if (import.meta.main) await runS15Arm64Evidence();
