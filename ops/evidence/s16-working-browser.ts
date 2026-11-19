import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { connect } from 'node:net';
import { lookup } from 'node:dns/promises';
import { createHash, randomUUID } from 'node:crypto';
import { Database } from 'bun:sqlite';
import { ComputerBrowser } from '../../src/s16/computers/browser';
import { ScreenControl } from '../../src/s16/computers/screen';
import { VmStore } from '../../src/s15/vm/store';
import { vmDesktopCdpStream } from '../../src/s15/vm/desktop-stream';
import { qmpExchange } from '../../src/s15/vm/qmp';
import { vmScreenCommands, vmScreenFrame, type VmScreenDevice } from '../../src/s15/vm/screen';
import { startVmRegistryProxy, type VmProxyLog } from '../../src/s15/vm/proxy';
import { limaRestrictedQemu, LimaVmManagement } from '../../src/s15/vm/management';
import { qemuDesktopProvisioning, qemuDesktopBrowser, qemuDesktopReadyKey, qemuDesktopLeaseWriter } from '../../src/s15/vm/qemu';
import { websiteSensitiveOnly } from '../../src/s15/browser/sites';
import { fixture, ref } from '../../tests/fixtures/s15-policy';
import type { VmEndpoint } from '../../src/s15/vm/types';
import type { OwnerActor } from '../../src/s15/policy';

const uid = () => randomUUID().replaceAll('-', '');
const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
const check = (value: unknown, code: string): void => { if (!value) throw Error(code); };
/** Opt-in disposable Lima/QEMU reference, not owner-host adoption or a nested-KVM attestation.
 * Uses the production desktop pin/installer, proxy, pipe relay, finite browser and POLICY-backed screen ports.
 * Raw credentials, TLS keys, frames, installation addresses and diagnostics stay in the ignored run directory. */
export async function runS16WorkingBrowserEvidence(): Promise<void> {
  if (process.env.JIT_S16_WORKING_BROWSER_EVIDENCE !== '1' || process.platform !== 'darwin' || process.arch !== 'arm64') throw Error('explicit_working_browser_reference_opt_in_required');
  const instance = process.env.JIT_S16_WORKING_INSTANCE ?? 'jit-work-arm';
  const directory = resolve(process.env.JIT_S16_WORKING_DIRECTORY ?? `.local/s16-working-browser-${Date.now()}`);
  check(directory.startsWith(resolve('.local') + '/'), 'private_evidence_directory_required');
  mkdirSync(directory, { recursive: true, mode: 0o700 }); chmodSync(directory, 0o700);
  const run = async (argv: string[], input?: Uint8Array, env?: Record<string, string>, timeout = 120000): Promise<string> => {
    const proc = Bun.spawn(argv, { stdin: input ?? 'ignore', stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
    const timer = setTimeout(() => proc.kill('SIGKILL'), timeout);
    const [code, stdout, stderr] = await Promise.all([proc.exited, new Response(proc.stdout).text(), new Response(proc.stderr).text()]); clearTimeout(timer);
    if (code !== 0) { writeFileSync(join(directory, 'last-command-error.txt'), stderr, { mode: 0o600 }); throw Error('evidence_command_failed_' + argv[0]); }
    return stdout;
  };
  const sha = (await run(['git', 'rev-parse', 'HEAD'])).trim();
  check(!(await run(['git', 'status', '--porcelain'])).trim(), 'exact_build_requires_clean_worktree');
  const report: Record<string, unknown> = { contract: 's16-working-browser-evidence/v1', sha, startedAt: new Date().toISOString(),
    topology: 'macos_management_separate_lima_qemu_arm64_desktop_working_vm', modelInference: 'not_run', liveAccount: 'not_used', productionAdoption: false };
  const stage = (value: string) => { report.stage = value; writeFileSync(join(directory, 'stage.txt'), value, { mode: 0o600 }); process.stdout.write(value + '\n'); };
  const fixtureHost = 'trusted.fixture-jit.org', fixtureAddress = '93.184.215.14', password = 'synthetic-' + randomUUID(), cookie = randomUUID();
  let logins = 0;
  await run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(directory, 'fixture.key'), '-out', join(directory, 'fixture.crt'), '-days', '2', '-subj', '/CN=' + fixtureHost, '-addext', 'subjectAltName=DNS:' + fixtureHost]);
  chmodSync(join(directory, 'fixture.key'), 0o600);
  const website = Bun.serve({ hostname: '127.0.0.1', port: 0, maxRequestBodySize: 8192, tls: { key: Bun.file(join(directory, 'fixture.key')), cert: Bun.file(join(directory, 'fixture.crt')) }, async fetch(request) {
    const url = new URL(request.url), signedIn = '<h1>Trusted signed-in workspace</h1><p>Team record: Launch plan is Friday.</p><a href="/record">Open team record</a>';
    if (url.pathname === '/login' && request.method === 'POST') {
      logins++; const fields = new URLSearchParams(await request.text());
      if (fields.get('password') !== password) return new Response('Rejected', { status: 401 });
      return new Response(signedIn, { headers: { 'content-type': 'text/html', 'set-cookie': 'jit_fixture=' + cookie + '; HttpOnly; Secure; SameSite=Lax; Path=/' } });
    }
    if (request.headers.get('cookie')?.includes('jit_fixture=' + cookie)) return new Response(signedIn, { headers: { 'content-type': 'text/html' } });
    return new Response('<!doctype html><meta charset="utf-8"><style>body{font:24px sans-serif}label{display:block;margin:24px}input,button{font:24px sans-serif;padding:12px}</style><h1>Trusted fixture sign in</h1><form method="post" action="/login"><label>Password <input autofocus type="password" name="password"></label><button>Sign in</button></form>', { headers: { 'content-type': 'text/html' } });
  } });
  const audit: VmProxyLog[] = [];
  const proxy = await startVmRegistryProxy({ hostname: '127.0.0.1', port: 0, guestHostname: '192.168.5.100', guestPort: 3128,
    hosts: ['storage.googleapis.com', 'ports.ubuntu.com', 'archive.ubuntu.com', 'security.ubuntu.com'], publicWeb: true, bytesPerSession: 1024 ** 3, log: row => audit.push(row),
    async resolve(host) {
      if (host === fixtureHost) return [{ address: fixtureAddress, family: 4 }];
      const answers = await lookup(host, { all: true, verbatim: true }); check(!answers.some(answer => answer.address === fixtureAddress), 'fixture_address_collision'); return answers;
    },
    connect: (address, port) => connect({ host: address === fixtureAddress && port === 443 ? '127.0.0.1' : address, port: address === fixtureAddress && port === 443 ? website.port! : port }),
  });
  const lease = proxy.lease('working_evidence_' + uid(), Date.now() + 7200000, undefined, { deny: host => websiteSensitiveOnly('https://' + host) });
  const wrapper = join(directory, 'qemu-restricted-desktop');
  // Reference-only adapter: Lima supplies its machine argv; add the same fixed GPU/input devices while
  // retaining the existing external restricted network wrapper. This does not modify a selected host manager.
  const wrapperCode = limaRestrictedQemu('/opt/homebrew/bin/qemu-system-aarch64', proxy.port).replace('os.execv(', "a+=['-device','virtio-gpu-pci,xres=1280,yres=800','-device','virtio-tablet-pci','-device','virtio-keyboard-pci']\nos.execv(");
  writeFileSync(wrapper, wrapperCode, { mode: 0o700 }); chmodSync(wrapper, 0o700); report.wrapperSha256 = hash(wrapperCode);
  const manager = new LimaVmManagement({ instance, env: { QEMU_SYSTEM_AARCH64: wrapper } });
  const guest = (argv: string[], input?: Uint8Array, timeout?: number) => run(['limactl', 'shell', '--workdir', '/', instance, ...argv], input, undefined, timeout);
  let claimed = false, controller: ComputerBrowser | undefined, store: VmStore | undefined, cleanupPolicy: (() => void) | undefined;
  let before: string[] = [];
  try {
    check((await manager.inspect()).state === 'stopped', 'disposable_working_vm_must_start_stopped');
    before = (await run(['limactl', 'snapshot', 'list', instance, '--quiet'])).trim().split('\n').filter(Boolean);
    writeFileSync(join(directory, 'snapshots-before.json'), JSON.stringify(before), { mode: 0o600 });
    claimed = true; stage('Starting restricted desktop working VM'); await run(['limactl', 'start', '--tty=false', instance], undefined, { QEMU_SYSTEM_AARCH64: wrapper });
    const row = JSON.parse((await run(['limactl', 'list', '--json', instance])).trim()), facts = await manager.inspect();
    check(facts.state === 'running' && facts.network === 'proxy-only', 'external_vm_boundary_unproven');
    report.network = facts.network;
    stage('Installing pinned production desktop profile'); const pin = qemuDesktopBrowser.aarch64;
    const installed = await guest(['sudo', '-n', 'python3', '-c', qemuDesktopProvisioning], Buffer.from(JSON.stringify({ proxy: lease.environment.HTTP_PROXY, url: pin.url, sha256: pin.sha256, version: qemuDesktopBrowser.version })), 2400000);
    writeFileSync(join(directory, 'provisioning.txt'), installed, { mode: 0o600 }); check(installed.includes('jit-desktop-ready-v1'), 'desktop_install_not_ready');
    const delivered = await guest(['sudo', '-n', 'python3', '-c', qemuDesktopLeaseWriter], Buffer.from(JSON.stringify({ proxy: lease.environment.HTTP_PROXY, version: qemuDesktopReadyKey })));
    check(delivered.includes('jit-desktop-lease-v1'), 'desktop_lease_unavailable');
    stage('Trusting only the synthetic fixture in the disposable guest');
    await run(['limactl', 'copy', join(directory, 'fixture.crt'), instance + ':/tmp/jit-working-fixture.crt']);
    await guest(['sudo', '-n', 'python3', '-c', `import os,subprocess
e={**os.environ,**dict(line.strip().split('=',1) for line in open('/etc/jit-desktop/proxy.env') if '=' in line),'DEBIAN_FRONTEND':'noninteractive'}
for a in [['apt-get','-qq','update'],['apt-get','-qq','-y','--no-install-recommends','install','libnss3-tools']]:subprocess.run(a,env=e,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,check=True,timeout=300)
`], undefined, 600000);
    await guest(['sudo', '-n', '-u', 'jit-desktop', 'python3', '-c', `import os,subprocess
d='/var/lib/jit-desktop/.pki/nssdb';os.makedirs(d,mode=0o700,exist_ok=True)
if not os.path.exists(d+'/cert9.db'):subprocess.run(['certutil','-N','--empty-password','-d','sql:'+d],check=True)
subprocess.run(['certutil','-D','-d','sql:'+d,'-n','jit-working-fixture'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
subprocess.run(['certutil','-A','-d','sql:'+d,'-n','jit-working-fixture','-t','C,,','-i','/tmp/jit-working-fixture.crt'],check=True)
`]);
    await guest(['sudo', '-n', 'systemctl', 'restart', 'jit-desktop.service']);
    const key = (await guest(['cat', '/etc/ssh/ssh_host_ed25519_key.pub'])).trim().split(/\s+/).slice(0, 2).join(' '), knownHosts = join(directory, 'known_hosts');
    writeFileSync(knownHosts, `[127.0.0.1]:${row.sshLocalPort} ${key}\n`, { mode: 0o600 });
    const endpoint: VmEndpoint = { host: '127.0.0.1', port: row.sshLocalPort, user: row.config.user.name, identityFile: row.IdentityFile, knownHostsFile: knownHosts };
    const vm = 'working_reference', qmp = join(row.dir, 'qmp.sock'); store = new VmStore(join(directory, 'screen.sqlite'));
    store.save({ id: vm, generation: 1, endpoint, managerId: 'reference_lima', state: 'ready', networkCheckedAt: Date.now(), networkIsolated: true, maxSessions: 2, reason: null, machineIdentity: facts.identity, boot: facts.boot, ...(facts.nicMac ? { bindingMac: facts.nicMac } : {}) });
    const policy = fixture(); cleanupPolicy = () => policy.cleanup();
    policy.add('resource', ref('computer')); policy.add('bot', ref('colleague'));
    policy.input.resources.push(ref('computer')); policy.input.bots.push(ref('colleague')); policy.input.rules[0]!.resources.push(ref('computer')); policy.input.rules[0]!.bots.push(ref('colleague')); policy.install();
    const device: VmScreenDevice = {
      async unavailable() { return (await manager.inspect()).state === 'running' ? null : 'vm_not_running'; },
      async capture() {
        const file = join(directory, 'frame-' + uid() + '.png');
        try { await qmpExchange(qmp, [{ execute: 'screendump', arguments: { filename: file, format: 'png' } }], { timeoutMs: 10000 }); return vmScreenFrame(readFileSync(file)); }
        finally { rmSync(file, { force: true }); }
      },
      async send(input) { await qmpExchange(qmp, vmScreenCommands(input), { timeoutMs: 10000 }); },
    };
    const screen = new ScreenControl<OwnerActor>({ store, requireOwner: owner => { policy.service.owner.current(owner); }, device: () => device, scope: () => ({ kind: 'shared' }), leaseMs: 600000, onTransition: () => controller?.invalidate(vm) });
    controller = new ComputerBrowser({ agentInput: id => screen.agentInput(id), assertAgent: id => screen.assertAgent(id), unavailable: () => device.unavailable(), stream: (_id, signal) => vmDesktopCdpStream(endpoint, { signal }),
      tier: host => host === fixtureHost ? 'trusted' : undefined, generation: id => screen.browserGeneration(id), observedGeneration: (id, generation) => screen.observedBrowserGeneration(id, generation), idleMs: 60000, callMs: 60000 });
    const open = (bot = 'bot') => {
      const admitted = policy.admit({ resources: [ref('computer')], bot: ref(bot), access: 'reversible_write' }); check(admitted.actor, 'work_not_admitted');
      const work = controller!.open(vm, () => { policy.service.work.guard(admitted.actor!); }, new AbortController().signal);
      return { execute: work.execute.bind(work), close: () => work.close(), async settled() {
        await work.settled(); policy.service.owner.revoke(policy.owner, 'reference_release_' + uid(), { kind: 'work', id: admitted.receipt.work!.id });
      } };
    };
    stage('Completing a real public documentation task');
    const publicRun = open(); let generation = 1;
    const execute = async (input: Record<string, unknown>) => { const result = await publicRun.execute(input.kind === 'state' ? input : { ...input, generation }); if (typeof result.generation === 'number') generation = result.generation; return result; };
    try {
      await execute({ kind: 'state' }); const docs = await execute({ kind: 'navigate', url: 'https://www.typescriptlang.org/docs/' });
      check(docs.state === 'observed' && String(docs.url).startsWith('https://www.typescriptlang.org/docs/'), 'public_docs_navigation_failed');
      const target = (docs.elements as { id: string; name: string }[]).find(element => element.name === 'Everyday Types'); check(target, 'public_docs_target_missing');
      check((await execute({ kind: 'click', target: target!.id })).state === 'ok', 'public_docs_click_failed');
      // Observe completion after the SPA acknowledgement; never repeat an input to obtain a preferred outcome.
      let observed = await execute({ kind: 'read' }); const deadline = Date.now() + 10000;
      while (observed.url === docs.url && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 100)); observed = await execute({ kind: 'read' }); }
      check(observed.state === 'observed' && String(observed.url).includes('/docs/handbook/2/everyday-types.html') && String(observed.text).includes('TypeScript'), 'public_docs_completion_unverified');
      report.publicTask = { passed: true, initialUrl: docs.url, selectedControl: target!.name, url: observed.url, textSha256: hash(String(observed.text)), customBusinessIntegration: false };
    } finally { publicRun.close(); await publicRun.settled(); }
    stage('Taking actual owner screen control for the trusted fixture');
    const loginRun = open();
    try { const state = await loginRun.execute({ kind: 'state' }); const login = await loginRun.execute({ kind: 'navigate', url: 'https://' + fixtureHost + '/', generation: state.generation }); check(login.state === 'observed' && String(login.text).includes('Trusted fixture sign in'), 'trusted_fixture_navigation_failed'); }
    finally { loginRun.close(); await loginRun.settled(); }
    let view = await screen.view(policy.owner, vm);
    view = (await screen.command(policy.owner, { contract: 's16-screen-command/v1', requestId: uid(), vmId: vm, kind: 'takeover', generation: view.generation })).view;
    check(view.state === 'owner', 'owner_takeover_unsettled');
    writeFileSync(join(directory, 'owner-before.png'), await screen.frame(policy.owner, vm, view.generation), { mode: 0o600 });
    const input = async (value: unknown) => { view = (await screen.command(policy.owner, { contract: 's16-screen-command/v1', requestId: uid(), vmId: vm, kind: 'input', generation: view.generation, takeoverId: view.takeoverId, input: value })).view; };
    // Coordinates belong to this fixed synthetic page and pinned 1280x800 desktop, never a model selector.
    await input({ kind: 'click', x: 280, y: 270, button: 'left', double: false }); await input({ kind: 'text', text: password }); await input({ kind: 'key', keys: ['ret'] });
    view = (await screen.command(policy.owner, { contract: 's16-screen-command/v1', requestId: uid(), vmId: vm, kind: 'hand_back', generation: view.generation, takeoverId: view.takeoverId })).view;
    check(view.state === 'agent', 'owner_hand_back_unsettled');
    const read = async (bot: string): Promise<Record<string, unknown>> => {
      const work = open(bot);
      try {
        const state = await work.execute({ kind: 'state' });
        const tab = (state.tabs as { id: string; url?: string }[]).find(tab => tab.url?.startsWith('https://' + fixtureHost + '/')); check(tab, 'fresh_trusted_tab_missing');
        return await work.execute({ kind: 'read', tab: tab!.id, generation: state.generation });
      } finally { work.close(); await work.settled(); }
    };
    let first = await read('bot'); const deadline = Date.now() + 10000;
    while (!String(first.text).includes('Launch plan is Friday.') && Date.now() < deadline) { await new Promise(resolve => setTimeout(resolve, 100)); first = await read('bot'); }
    const second = await read('colleague');
    check([first, second].every(result => result.state === 'observed' && String(result.text).includes('Launch plan is Friday.')), 'trusted_session_reuse_unverified'); check(logins === 1, 'trusted_login_repeated');
    const secretHash = hash(password);
    const policySnapshot = new Database(policy.path, { readonly: true });
    try { for (const bytes of [store.db.serialize(), policySnapshot.serialize()]) check(!Buffer.from(bytes).includes(Buffer.from(password)) && !Buffer.from(bytes).includes(Buffer.from(secretHash)), 'owner_input_was_stored'); }
    finally { policySnapshot.close(); }
    writeFileSync(join(directory, 'signed-in.png'), await screen.frame(policy.owner, vm, view.generation), { mode: 0o600 });
    report.trustedTask = { passed: true, ownerInput: 'actual_QMP_screen', distinctAuthorizedBots: 2, loginAttempts: logins, cookieCopied: false, ownerInputStoresClear: true };
    report.build = { desktopPin: qemuDesktopBrowser, desktopReadyKey: qemuDesktopReadyKey,
      guest: (await guest(['sh', '-c', `uname -m; uname -r; /opt/jit-desktop/chrome-${qemuDesktopBrowser.version}/chrome --version; sha256sum /opt/jit-desktop/chrome-${qemuDesktopBrowser.version}/chrome`])).trim(),
      bun: process.versions.bun, qemu: (await run(['/opt/homebrew/bin/qemu-system-aarch64', '--version'])).split('\n')[0] };
    report.state = 'passed';
  } catch (error) { report.state = 'failed'; report.code = error instanceof Error && /^[a-z0-9_]+$/.test(error.message) ? error.message : 'evidence_failed'; throw error; }
  finally {
    try {
      controller?.close(); store?.close(); cleanupPolicy?.();
    } finally {
      try {
        if (claimed) {
          stage('Stopping disposable working VM');
          const removed = await guest(['sudo', '-n', '-u', 'jit-desktop', 'certutil', '-D', '-d', 'sql:/var/lib/jit-desktop/.pki/nssdb', '-n', 'jit-working-fixture']).then(() => true, () => false);
          report.fixtureTrustAnchorRemoved = removed;
          await manager.stop(); check((await manager.inspect()).state === 'stopped', 'working_vm_stop_unverified');
          report.stopped = true;
          const after = (await run(['limactl', 'snapshot', 'list', instance, '--quiet'])).trim().split('\n').filter(Boolean);
          writeFileSync(join(directory, 'snapshots-after.json'), JSON.stringify(after), { mode: 0o600 }); check(before.every(tag => after.includes(tag)), 'baseline_snapshot_lost'); report.baselineSnapshotsRetained = true;
          if (report.state === 'passed') check(removed, 'fixture_trust_anchor_removal_failed');
        }
      } catch (error) { report.state = 'failed'; report.cleanup = 'unverified'; throw error; }
      finally {
        lease.close(); await proxy.close(); website.stop(true);
        report.finishedAt = new Date().toISOString(); writeFileSync(join(directory, 'proxy-audit.json'), JSON.stringify(audit), { mode: 0o600 }); writeFileSync(join(directory, 'receipt.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
      }
    }
  }
}
if (import.meta.main) await runS16WorkingBrowserEvidence();
