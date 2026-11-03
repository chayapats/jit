import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, lstatSync, writeFileSync } from 'node:fs';
import { cpus, homedir, release, totalmem } from 'node:os';
import { join, resolve } from 'node:path';
import { composeS15, type S15CompositionOptions } from '../../src/s15/composition';
import { ConnectionVault } from '../../src/exec/connections';
import { zero, equal } from '../../src/s15/policy/validation';
import type { PolicyInput, Ref } from '../../src/s15/policy';
import type { ApprovedModelRoute } from '../../src/s15/model';
import { QemuVmManagement, VmManagers, localVmImages, qemuArgvFacts, defaultVmLimits } from '../../src/s15/vm';
import type { VmProxyLog } from '../../src/s15/vm/proxy';
import { localVmFileHash } from '../../src/s15/vm/local';
import { qmpExchange } from '../../src/s15/vm/qmp';
import { probeVmDirectEgress } from '../../src/s15/vm/network';
import { VmSshTransport } from '../../src/s15/vm/transport';
import { vmHostCommand } from '../../src/s15/vm/host';

/**
 * Opt-in x64 live evidence for the Jit-managed nested KVM working VM (VM15-02). Run on the controller host
 * as a disposable non-root evidence identity in the `kvm` group with a lingering user manager. It creates a
 * fresh protected state directory and working VM, runs the selected cases, records exact build/config/image
 * hashes under the ignored `.local/s15-evidence-x64/`, and stops the working VM afterwards. No model
 * inference, owner credential, real recipient or money is used.
 *
 * `--sha <commit>` (required) · `--cases provision,root,apt,egress,snapshot,restart` (default) plus optional
 * `docker`, `concurrency` and `soak` · `--soak-minutes <n>` (default 60).
 */
const required = ['provision', 'root', 'apt', 'egress', 'snapshot', 'restart'] as const;
const optional = ['docker', 'concurrency', 'soak'] as const;
type Case = typeof required[number] | typeof optional[number];

function sourceTreeHash(root: string): string {
  const files: string[] = [];
  const walk = (path: string) => { for (const name of readdirSync(join(root, path)).sort()) { const relative = path ? `${path}/${name}` : name, s = lstatSync(join(root, relative)); if (s.isDirectory()) walk(relative); else if (s.isFile()) files.push(relative); } };
  for (const top of ['src', 'ops', 'vendor']) walk(top);
  files.push('package.json', 'bun.lock', 'tsconfig.json');
  const tree = createHash('sha256');
  for (const file of files.sort()) tree.update(`${file}\0${createHash('sha256').update(readFileSync(join(root, file))).digest('hex')}\n`);
  return tree.digest('hex');
}

export async function runS15X64Evidence(argv = process.argv.slice(2)): Promise<void> {
  if (process.env.JIT_S15_X64_EVIDENCE !== '1' || process.platform !== 'linux' || process.arch !== 'x64') throw Error('explicit_x64_evidence_opt_in_required');
  if (process.getuid?.() === 0) throw Error('evidence_must_not_run_as_root');
  const flag = (name: string) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
  const sha = flag('--sha'); if (!sha || !/^[a-f0-9]{40}$/.test(sha)) throw Error('exact_build_sha_required');
  const selected = (flag('--cases') ?? required.join(',')).split(',') as Case[];
  if (selected.some(c => ![...required, ...optional].includes(c as never))) throw Error('unknown_case');
  const soakMinutes = Number(flag('--soak-minutes') ?? '60'); if (!Number.isSafeInteger(soakMinutes) || soakMinutes < 1 || soakMinutes > 1440) throw Error('invalid_soak_minutes');
  const output = resolve(process.env.JIT_S15_EVIDENCE_DIRECTORY ?? `.local/s15-evidence-x64/run-${sha.slice(0, 12)}-${Date.now()}`); mkdirSync(output, { recursive: true, mode: 0o700 });
  const ref = (id: string): Ref => ({ id, revision: 1, generation: 1 }), proof = {}, now = Date.now(), until = now + 6 * 3600000;
  const selection = { route: ref('route'), model: ref('model'), effort: 'low' }, modelBound = { ...zero(), calls: 1, steps: 1, activeMs: 10000 };
  const route: ApprovedModelRoute = { selection, provider: 'codex', modelId: 'fixture-model', account: ref('provider_account'), billing: ref('subscription'), recipient: ref('provider'), charge: 'subscription', availability: 'available', efforts: ['low'], effortEvidence: 'requested_only', upperBound: modelBound, rank: { ordinary: 0, difficult: 0 } };
  const qemuVersion = (Buffer.from((await vmHostCommand(['/usr/bin/qemu-system-x86_64', '--version'], { timeoutMs: 10000, maxBytes: 4096 })).stdout).toString().split('\n')[0] ?? '').trim();
  const report: Record<string, unknown> = { contract: 's15-x64-evidence/v1', sha, sourceTreeHash: sourceTreeHash(process.cwd()), bun: Bun.version, architecture: process.arch, kernel: release(), qemu: qemuVersion,
    host: { cpus: cpus().length, memoryBytes: totalmem() }, image: localVmImages.x86_64, cases: {}, selected, modelInference: 'not_run', ownerCredentials: 'not_used', recipients: 'none', money: 'none', startedAt: new Date().toISOString() };
  const cases = report.cases as Record<string, unknown>, proxyLog: VmProxyLog[] = [];
  const catalog = new Map<string, { ref: Ref; active: boolean }>();
  for (const [kind, names] of Object.entries({ purpose: ['evidence', 'interpret'], bot: ['bot'], resource: ['computer'], recipient: ['provider'], route: ['route'], model: ['model'] })) for (const id of names) catalog.set(`${kind}:${id}`, { ref: ref(id), active: true });
  const policy: PolicyInput = { purposes: [ref('evidence'), ref('interpret')], interpretationPurpose: ref('interpret'), bots: [ref('bot')], resources: [ref('computer')], recipients: [ref('provider')], selections: [selection], expiresAt: until,
    budget: { currency: 'USD', startsAt: now - 1000, expiresAt: until, concurrency: 8, ceiling: { attempts: 100000, steps: 100000, calls: 1000000, reads: 1000000, outputBytes: 100000000000, activeMs: 10000000000, spendMinor: '0' } },
    rules: [{ id: 'controlled_vm', mode: 'ordinary', purposes: [ref('evidence')], bots: [ref('bot')], resources: [ref('computer')], recipients: [], selections: [selection], adapters: ['working_vm'], operations: ['vm_write', 'vm_shell', 'vm_system_admin', 'vm_snapshot'], classes: ['guest_local_admin', 'guest_system_admin', 'ordinary_edit'], expiresAt: until, recurrence: null }] };
  // Protected state needs a short path: QMP/proxy Unix sockets live in it (see `qemuStateDirectoryMax`).
  const protectedDirectory = resolve(process.env.JIT_S15_STATE_DIRECTORY ?? join(homedir(), `x64-${now.toString(36)}`));
  report.protectedDirectory = protectedDirectory;
  const options = (create: boolean): S15CompositionOptions => ({ runtime: 's15', directory: protectedDirectory, create, installationId: 'x64_' + now, origin: 'http://localhost:3001', proposedPolicy: policy,
    owner: { authenticate() { throw Error('no_ambient_session'); }, verifyOwner: p => p === proof ? { id: 'evidence_owner', generation: 1, expiresAt: until } : null, generation: () => 1, verifyCsrf() { throw Error('no_ambient_csrf'); } },
    catalogs: { current: (kind, id) => catalog.get(`${kind}:${id}`) ?? null, allows: () => true },
    conversation: { ownerId: 'evidence_owner', bot: ref('bot'), selection, route: { provider: 'codex', model: 'fixture-model' }, limits: { modelCalls: 3, toolCalls: 10, outputBytes: 32768, activeMs: 30000 }, modelCallUpperBound: modelBound },
    model: { registry: { list: () => [route], current: s => equal(s, selection) ? route : null, pins: () => ({ route: null, model: null, effort: null }) }, limits: { turns: 3, attempts: 1, activeMs: 30000, outputBytes: 32768, contextWindow: 32768, inputChars: 65536 } },
    vm: { id: 'x64', resource: ref('computer'), managers: new Map(), managementVault: new ConnectionVault(join(output, 'vault'), { forbidden: [protectedDirectory] }), destination: () => null,
      limits: { ...defaultVmLimits, commandMs: 300_000, sessionMs: 3_600_000 }, local: { proxyLog: entry => proxyLog.push(entry) },
      upperBound: op => ({ ...zero(), calls: 1, reads: ['read', 'setup'].includes(op.kind) ? 1 : 0, outputBytes: op.outputBytes, activeMs: op.timeoutMs }) },
  });
  let service = await composeS15(options(true));
  let owner = service.policy.owner.authenticate(proof); service.policy.owner.install(owner, 'evidence_policy', 0, policy);
  service.team.register(owner, 'resource_computer', 0, { ...ref('computer'), contract: 's15-team-resource/v1', label: 'computer', kind: 'workspace', scope: { kind: 'team' }, purposes: ['evidence'], allowedBots: null, deniedBots: [], operations: ['read', 'write', 'input'], active: true, coordinationKey: 'computer' });
  const sessions: Awaited<ReturnType<typeof service.vm.openAttempt>>[] = [];
  const open = async (mode: 'work' | 'system' = 'work') => {
    const work = service.policy.owner.admit(owner, { requestId: crypto.randomUUID().replaceAll('-', ''), intent: 'execute', access: 'effect', purpose: ref('evidence'), bot: ref('bot'), resources: [ref('computer')], recipients: [], selection, selectionPin: null, expiresAt: until - 1000, readLimit: 1000 }).work!;
    const session = await service.workingVm.openAttempt(service.policy.control.bindWork(work.id), { vmId: 'x64', workId: work.id, attemptId: `chat_${work.id}`, mode }); sessions.push(session); return session;
  };
  const shell = async (session: Awaited<ReturnType<typeof open>>, command: string, timeoutMs = 300_000) => session.backend.spawn({ command, cwd: session.backend.workspaceRoot, timeoutMs });
  const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
  const close = async (session: Awaited<ReturnType<typeof open>>) => { await session.close(); sessions.splice(sessions.indexOf(session), 1); };
  let managerId = '', manager: QemuVmManagement | null = null;
  const local = () => { const m = service.vmManagers.get(managerId); if (!(m instanceof QemuVmManagement)) throw Error('local_manager_missing'); return manager = m; };
  try {
    report.stage = 'provision';
    const started = Date.now();
    if (!(service.vmManagers instanceof VmManagers)) throw Error('local_manager_unavailable');
    managerId = service.vmManagers.register(owner, { kind: 'qemu' }).managerId;
    const status = await service.enrollment.enrollLocal(owner, { id: 'x64', managerId });
    const machine = await local().inspect(), argv = await (async () => { const pid = Number(machine.boot.split(':')[0]); return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replace(/\0$/, '').split('\0'); })();
    const base = join(protectedDirectory, 'vm-local', 'images', `${localVmImages.x86_64.sha256}.qcow2`);
    cases.provision = { passed: status.state === 'ready' && status.networkIsolated, seconds: Math.round((Date.now() - started) / 1000), status, resources: local().resources,
      image: { sha256Recomputed: await localVmFileHash(base), pinned: localVmImages.x86_64.sha256, baseMode: (lstatSync(base).mode & 0o777).toString(8) },
      hypervisor: { network: machine.network, argvExact: qemuArgvFacts(argv, { name: local().identity.name, architecture: 'x86_64', machineDirectory: local().machineDirectory, proxySocket: join(protectedDirectory, 'vm-local', 'proxy.sock') }).exact, argvHash: createHash('sha256').update(argv.join('\0')).digest('hex'), qemuUser: process.getuid?.() } };
    writeFileSync(join(output, 'qemu-argv.json'), JSON.stringify(argv, null, 2), { mode: 0o600 });
    check((cases.provision as { passed: boolean }).passed, 'provision_failed');
    if (selected.includes('root')) {
      report.stage = 'root';
      // Guest-reported cross-check of the hypervisor argv: no 9p/virtiofs mounts and no virtio console/9p/vsock/fs devices.
      const s = await open(), result = await shell(s, "sudo -n id -u; sudo -n systemctl --version | head -1; echo virtio: $(cat /sys/bus/virtio/devices/*/device | sort | tr '\\n' ' '); if grep -qE ' (9p|virtiofs) ' /proc/mounts || grep -qE '^0x00(03|09|13|1a)$' /sys/bus/virtio/devices/*/device; then echo shared-device-present; elif test -e /home/jit-s15-evid; then echo controller-path-visible; else printf protected-paths-absent; fi");
      cases.root = { passed: result.exitCode === 0 && result.stdout.startsWith('0\n') && result.stdout.includes('protected-paths-absent'), basis: 'guest_reported', output: result.stdout.trim() };
      await close(s); check((cases.root as { passed: boolean }).passed, 'guest_root_failed');
    }
    if (selected.includes('apt')) {
      report.stage = 'apt';
      const before = proxyLog.length, s = await open();
      const result = await shell(s, 'sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -q update >/tmp/jit-apt.log 2>&1 && sudo -n env DEBIAN_FRONTEND=noninteractive apt-get -q -y --no-install-recommends install tree >>/tmp/jit-apt.log 2>&1 && tree --version; echo exit=$?; tail -3 /tmp/jit-apt.log');
      const hosts = [...new Set(proxyLog.slice(before).map(e => `${e.host}:${e.state}`))];
      cases.apt = { passed: result.exitCode === 0 && /^tree v/m.test(result.stdout) && hosts.some(h => h.endsWith(':closed')), output: result.stdout.trim().slice(0, 2000), proxyDestinations: hosts };
      await close(s); check((cases.apt as { passed: boolean }).passed, 'apt_through_proxy_failed');
    }
    if (selected.includes('egress')) {
      report.stage = 'egress';
      const s = await open();
      const flush = await shell(s, 'for t in iptables ip6tables; do if command -v $t >/dev/null; then sudo -n $t -P INPUT ACCEPT; sudo -n $t -P OUTPUT ACCEPT; sudo -n $t -P FORWARD ACCEPT; sudo -n $t -F; sudo -n $t -t nat -F 2>/dev/null; echo flushed-$t; else echo absent-$t; fi; done; if command -v nft >/dev/null; then sudo -n nft flush ruleset && echo flushed-nft; fi');
      const extra = await shell(s, `printf %s ${Buffer.from(egressProbes).toString('base64')} | base64 -d | python3 -I -`);
      const transport = new VmSshTransport(service.vmStore.registration('x64').endpoint);
      const denied = await probeVmDirectEgress(transport), probes = JSON.parse(extra.stdout.trim().split('\n').at(-1) ?? '{}');
      const leak = Object.entries(probes).some(([k, v]) => k !== 'proxyWithoutLease' && v === true);
      cases.egress = { passed: denied && !leak && String(probes.proxyWithoutLease).includes('407') && (await local().inspect()).network === 'proxy-only', flush: flush.stdout.trim(), directEgressProbeDenied: denied, probes, managementNetwork: (await local().inspect()).network, basis: 'guest probes after guest firewall flush; isolation enforced by QEMU restrict=on outside the guest' };
      await close(s); check((cases.egress as { passed: boolean }).passed, 'egress_bypass');
    }
    if (selected.includes('snapshot')) {
      report.stage = 'snapshot';
      const first = await open(); await shell(first, 'printf baseline | sudo -n tee /var/lib/jit-evid15-marker >/dev/null'); await close(first);
      const rowsBefore = service.enrollment.status(owner, 'x64').capabilities;
      const system = await open('system'), snapshot = service.vm.snapshots(owner, 'x64')[0]!;
      const removed = await shell(system, 'sudo -n rm /var/lib/jit-evid15-marker && test ! -e /var/lib/jit-evid15-marker && echo removed'); await close(system);
      const usage = service.policy.control.usage(), generation = service.vmStore.registration('x64').generation;
      await service.vm.recover(owner, { vmId: 'x64', snapshotId: snapshot.id });
      const stopped = (await local().inspect()).state, unchanged = equal(usage, service.policy.control.usage());
      const rowsAfter = service.enrollment.status(owner, 'x64').capabilities;
      await service.vm.start(owner, 'x64');
      const restored = await open(), marker = await shell(restored, 'cat /var/lib/jit-evid15-marker'); await close(restored);
      cases.snapshot = { passed: removed.stdout.includes('removed') && stopped === 'stopped' && unchanged && marker.stdout === 'baseline' && rowsAfter.filter(r => r.id !== 'network-isolated').every(r => r.state === 'proven'), snapshot: snapshot.id, live: true,
        removedOutput: removed.stdout.trim(), markerAfterRestore: marker.stdout.trim(), markerExit: marker.exitCode,
        stateAfterRestore: stopped, policyUsageUnchanged: unchanged, generationAdvanced: service.vmStore.registration('x64').generation > generation, capabilitiesBefore: rowsBefore, capabilitiesAfter: rowsAfter, prevention: false };
      check((cases.snapshot as { passed: boolean }).passed, 'snapshot_restore_failed');
    }
    if (selected.includes('restart')) {
      report.stage = 'restart';
      const before = await local().inspect(), uptime = async () => { const s = await open(), r = await shell(s, 'cut -d. -f1 /proc/uptime'); await close(s); return Number(r.stdout.trim()); };
      const upBefore = await uptime();
      await service.close(); const survived = (await new QemuVmManagement(local().identity, local().host).inspect()).boot === before.boot;
      service = await composeS15(options(false)); owner = service.policy.owner.authenticate(proof); await service.vm.reattach();
      const after = await local().inspect(), upAfter = await uptime(), row = service.vmStore.registration('x64');
      cases.restart = { passed: survived && after.boot === before.boot && row.state === 'ready' && upAfter >= upBefore, survivedControllerExit: survived, sameBoot: after.boot === before.boot, guestUptimeBefore: upBefore, guestUptimeAfter: upAfter, registration: { state: row.state, generation: row.generation } };
      check((cases.restart as { passed: boolean }).passed, 'controller_restart_reattach_failed');
    }
    if (selected.includes('docker')) {
      report.stage = 'docker';
      const s = await open();
      const result = await shell(s, 'sudo -n sh -c \'install -d /etc/systemd/system/docker.service.d && printf "[Service]\\nEnvironment=HTTPS_PROXY=%s\\nEnvironment=HTTP_PROXY=%s\\n" "$HTTPS_PROXY" "$HTTP_PROXY" > /etc/systemd/system/docker.service.d/jit-proxy.conf && systemctl daemon-reload && systemctl restart docker\' && sudo -n docker run --rm hello-world | grep -m1 "Hello from Docker"; echo exit=$?; sudo -n rm -f /etc/systemd/system/docker.service.d/jit-proxy.conf');
      cases.docker = { passed: result.stdout.includes('Hello from Docker'), output: result.stdout.trim().slice(0, 2000), basis: 'guest_reported' }; await close(s);
    }
    if (selected.includes('concurrency')) {
      report.stage = 'concurrency';
      const [a, b] = await Promise.all([open(), open()]), t0 = Date.now();
      const results = await Promise.all([shell(a!, 'sleep 5; echo a'), shell(b!, 'sleep 5; echo b')]);
      cases.concurrency = { passed: results.every(r => r.exitCode === 0) && Date.now() - t0 < 9000, elapsedMs: Date.now() - t0 }; await close(a!); await close(b!);
    }
    if (selected.includes('soak')) {
      report.stage = 'soak';
      const deadline = Date.now() + soakMinutes * 60000; let iterations = 0, failures = 0;
      while (Date.now() < deadline) { iterations++; try { const s = await open(), r = await shell(s, 'sudo -n sh -c "dd if=/dev/zero of=/var/tmp/jit-soak bs=1M count=64 conv=fsync status=none && rm /var/tmp/jit-soak" && echo ok'); if (!r.stdout.includes('ok')) failures++; await close(s); } catch { failures++; } await Bun.sleep(5000); }
      cases.soak = { passed: failures === 0, minutes: soakMinutes, iterations, failures };
    }
    report.status = Object.values(cases).every(c => (c as { passed: boolean }).passed) ? 'passed' : 'failed';
  } catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : 'evidence_failed'; process.exitCode = 1; }
  finally {
    await Promise.allSettled(sessions.map(s => s.close()));
    const vm = manager as QemuVmManagement | null;
    // Diagnostics only on failure: the guest console ring buffer is guest-controlled text, never evidence.
    if (vm && report.status !== 'passed') try { writeFileSync(join(output, 'console.json'), JSON.stringify(await qmpExchange(join(vm.machineDirectory, 'qmp.sock'), [{ execute: 'ringbuf-read', arguments: { device: 'console', size: 1048576, format: 'utf8' } }], { timeoutMs: 5000 })), { mode: 0o600 }); } catch { /* No running console. */ }
    try { if (managerId) { await local().stop(); report.finalVmState = (await local().inspect()).state; } }
    catch (error) { report.finalVmState = 'stop_failed'; report.stopError = error instanceof Error ? error.message : 'unknown'; }
    await service.close().catch(() => {});
    report.proxyDestinations = [...new Set(proxyLog.map(e => `${e.host}:${e.state}`))];
    report.finishedAt = new Date().toISOString();
    writeFileSync(join(output, 'results.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    writeFileSync(join(output, 'manifest.json'), JSON.stringify({ sha, sourceTreeHash: report.sourceTreeHash, image: localVmImages.x86_64, qemu: qemuVersion, bun: Bun.version, kernel: release(), selected, output }, null, 2), { mode: 0o600 });
  }
  console.log(JSON.stringify({ status: report.status, stage: report.stage, cases: Object.fromEntries(Object.entries(cases).map(([k, v]) => [k, (v as { passed: boolean }).passed])), output, finalVmState: report.finalVmState }));
}
/** Extra guest probes beyond `probeVmDirectEgress`: slirp DNS, ICMP, host/slirp gateways and the proxy without a lease. */
const egressProbes = `import socket,subprocess,json
def tcp(h,p):
 s=socket.socket(socket.AF_INET,socket.SOCK_STREAM);s.settimeout(2)
 try:
  s.connect((h,p));return True
 except OSError:return False
 finally:s.close()
def udp_dns(h):
 s=socket.socket(socket.AF_INET,socket.SOCK_DGRAM);s.settimeout(2)
 try:
  s.sendto(bytes.fromhex('123401000001000000000000076578616d706c6503636f6d0000010001'),(h,53));s.recv(512);return True
 except OSError:return False
 finally:s.close()
def proxy_without_lease():
 try:
  s=socket.create_connection(('192.168.5.100',3128),3)
  s.sendall(b'CONNECT archive.ubuntu.com:443 HTTP/1.1\\r\\nHost: archive.ubuntu.com\\r\\n\\r\\n');line=s.recv(64).decode('latin1').split('\\r\\n')[0];s.close();return line
 except OSError as e:return 'error:'+type(e).__name__
ping=subprocess.run(['ping','-c','1','-W','2','1.1.1.1'],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode==0
print(json.dumps({'dnsUdpSlirp':udp_dns('192.168.5.3'),'dnsTcpSlirp':tcp('192.168.5.3',53),'dnsUdpPublic':udp_dns('1.1.1.1'),'icmpPublic':ping,'hostSsh':tcp('192.168.5.2',22),'hostHttp':tcp('192.168.5.2',80),'defaultSlirpHost':tcp('10.0.2.2',22),'publicHttps':tcp('1.1.1.1',443),'publicHttp':tcp('8.8.8.8',80),'proxyWithoutLease':proxy_without_lease()}))
`;
if (import.meta.main) await runS15X64Evidence();
