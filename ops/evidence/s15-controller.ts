import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { composeS15 } from '../../src/s15/composition';
import { RemoteVmManagement } from '../../src/s15/vm/remote';
import { FixturePaymentPort, createFixturePaymentAdapter } from '../../src/s15/payments';
import { zero, equal } from '../../src/s15/policy/validation';
import type { PolicyInput, Ref } from '../../src/s15/policy';
import type { ApprovedModelRoute } from '../../src/s15/model';
import { browserSite } from '../../tests/fixtures/s15-browser';
import type { BrowserOperation, BrowserResult } from '../../src/s15/browser';

// Opt-in paired controller process. Secret relay material arrives over stdin and is never persisted/logged.
if (process.env.JIT_S15_ARM64_EVIDENCE !== '1') throw Error('explicit_s15_evidence_opt_in_required');
const input = JSON.parse(await Bun.stdin.text()) as { relay: string; bootstrap: string; credential: string; user: string; port: number; sha: string; browser: string; output: string };
const ref = (id: string): Ref => ({ id, revision: 1, generation: 1 }), proof = {}, now = Date.now(), until = now + 3600000;
const selection = { route: ref('route'), model: ref('model'), effort: 'low' }, modelBound = { ...zero(), calls: 1, steps: 1, activeMs: 10000 };
const route: ApprovedModelRoute = { selection, provider: 'codex', modelId: 'fixture-model', account: ref('provider_account'), billing: ref('subscription'), recipient: ref('provider'), charge: 'subscription', availability: 'available', efforts: ['low'], effortEvidence: 'requested_only', upperBound: modelBound, rank: { ordinary: 0, difficult: 0 } };
const report: Record<string, unknown> = { contract: 's15-arm64-evidence/v1', sha: input.sha, architecture: process.arch, controller: 'jit-s15-arm', workingVm: 'jit-work-arm', modelInference: 'not_run', ownerCredentials: 'not_used', startedAt: new Date().toISOString(), cases: {} };
const cases = report.cases as Record<string, unknown>, site = browserSite(), manager = new RemoteVmManagement({ origin: input.relay, credential: () => input.credential, allowLoopback: true });
const catalog = new Map<string, { ref: Ref; active: boolean }>();
for (const [kind, names] of Object.entries({ purpose: ['evidence', 'interpret'], bot: ['bot'], resource: ['computer', 'account'], recipient: ['provider', 'payee', 'other'], route: ['route'], model: ['model'] })) for (const id of names) catalog.set(`${kind}:${id}`, { ref: ref(id), active: true });
const policy: PolicyInput = { purposes: [ref('evidence'), ref('interpret')], interpretationPurpose: ref('interpret'), bots: [ref('bot')], resources: [ref('computer'), ref('account')], recipients: [ref('provider'), ref('payee')], selections: [selection], expiresAt: until,
  budget: { currency: 'USD', startsAt: now - 1000, expiresAt: until, concurrency: 8, ceiling: { attempts: 1000, steps: 1000, calls: 10000, reads: 10000, outputBytes: 1000000000, activeMs: 100000000, spendMinor: '0' } },
  rules: [{ id: 'controlled_fixture', mode: 'ordinary', purposes: [ref('evidence')], bots: [ref('bot')], resources: [ref('computer'), ref('account')], recipients: [ref('payee')], selections: [selection], adapters: ['working_vm', 'protected_browser', 'fixture_payment'], operations: ['vm_write', 'vm_shell', 'vm_system_admin', 'vm_snapshot', 'browser_request', 'pay'], classes: ['guest_local_admin', 'guest_system_admin', 'ordinary_edit', 'communication', 'financial', 'disclosure', 'new_egress'], expiresAt: until, recurrence: null }] };
mkdirSync(input.output, { recursive: true, mode: 0o700 });
const payment = new FixturePaymentPort([{ id: 'fixture_invoice', version: 'v1', purpose: ref('evidence'), account: ref('account'), payee: ref('payee'), currency: 'USD', amount: '1.00', memo: 'No real financial transport', expiresAt: until }]);
const service = await composeS15({ runtime: 's15', directory: join(input.output, 'protected'), create: true, installationId: 'live_' + now, origin: 'http://localhost:3001', proposedPolicy: policy,
  owner: { authenticate() { throw Error('no_ambient_session'); }, verifyOwner: p => p === proof ? { id: 'evidence_owner', generation: 1, expiresAt: until } : null, generation: () => 1, verifyCsrf() { throw Error('no_ambient_csrf'); } },
  catalogs: { current: (kind, id) => catalog.get(`${kind}:${id}`) ?? null, allows: () => true },
  conversation: { ownerId: 'evidence_owner', bot: ref('bot'), selection, route: { provider: 'codex', model: 'fixture-model' }, limits: { modelCalls: 3, toolCalls: 10, outputBytes: 32768, activeMs: 30000 }, modelCallUpperBound: modelBound },
  model: { registry: { list: () => [route], current: s => equal(s, selection) ? route : null, pins: () => ({ route: null, model: null, effort: null }) }, limits: { turns: 3, attempts: 1, activeMs: 30000, outputBytes: 32768, contextWindow: 32768, inputChars: 65536 } },
  vm: { id: 'arm', resource: ref('computer'), managers: new Map([['remote_lima', manager]]), destination: () => null,
    upperBound: op => ({ ...zero(), calls: 1, reads: ['read', 'setup'].includes(op.kind) ? 1 : 0, outputBytes: op.outputBytes, activeMs: op.timeoutMs }) },
  browser: { mode: 'general', resource: ref('account'), fences: [], executablePath: input.browser, site: site.site, upperBound: { ...zero(), steps: 1, reads: 1, outputBytes: 2097152, activeMs: 30000 } },
  adapters: [createFixturePaymentAdapter({ port: payment, currencies: [{ currency: 'USD', minorUnit: 2 }], upperBound: { ...zero(), calls: 1 } })],
});
const owner = service.policy.owner.authenticate(proof); service.policy.owner.install(owner, 'evidence_policy', 0, policy);
const sessions: Awaited<ReturnType<typeof service.vm.openAttempt>>[] = [];
const admit = (resource: 'computer' | 'account' = 'computer') => {
  const work = service.policy.owner.admit(owner, { requestId: crypto.randomUUID().replaceAll('-', ''), intent: 'execute', access: 'effect', purpose: ref('evidence'), bot: ref('bot'), resources: [ref(resource)], recipients: [ref('payee')], selection, selectionPin: null, expiresAt: until - 1000, readLimit: 1000 }).work!;
  return { work, actor: service.policy.control.bindWork(work.id) };
};
const open = async (mode: 'work' | 'system' = 'work') => { const { actor, work } = admit(); const session = await service.vm.openAttempt(actor, { vmId: 'arm', workId: work.id, attemptId: `chat_${work.id}`, mode }); sessions.push(session); return { actor, session }; };
const check = (value: unknown, message: string) => { if (!value) throw Error(message); };
try {
  const setup = await service.enrollment.begin(owner);
  const bootstrap = await fetch(input.bootstrap, { method: 'POST', headers: { authorization: 'Bearer ' + input.credential, 'content-type': 'application/json' }, body: JSON.stringify({ publicKey: setup.publicKey }) }); check(bootstrap.ok, 'public_key_bootstrap_failed');
  const machine = await service.enrollment.checkMachine(owner, { setupId: setup.setupId, host: '127.0.0.1', port: input.port, user: input.user, managerId: 'remote_lima' });
  report.enrollment = await service.enrollment.useMachine(owner, { id: 'arm', checkId: machine.checkId, fingerprint: machine.fingerprint, transportProfile: machine.transportProfile });
  const first = await open(), root = first.session.backend.workspaceRoot;
  const admin = await first.session.backend.spawn({ command: 'sudo -n id -u; sudo -n iptables -F; sudo -n ip6tables -F; test ! -d /home/jit-s15; test ! -S /var/run/docker.sock || docker info --format "{{.Name}}"', cwd: root, timeoutMs: 20000 }); check(admin.exitCode === 0 && admin.stdout.startsWith('0'), 'guest_root_failed'); cases.guestRoot = { passed: true, basis: 'guest_reported', output: admin.stdout.trim() };
  const transport = new (await import('../../src/s15/vm/transport')).VmSshTransport(service.vmStore.registration('arm').endpoint);
  cases.egressAfterFirewallFlush = { passed: await (await import('../../src/s15/vm/network')).probeVmDirectEgress(transport), managementNetwork: (await manager.inspect()).network };
  check((cases.egressAfterFirewallFlush as { passed: boolean }).passed, 'egress_bypass');
  const protectedProbe = await first.session.backend.spawn({ command: 'test ! -e /home/jit-s15/evidence && test ! -e /Users && test ! -S /var/run/libvirt/libvirt-sock && printf protected-paths-absent', cwd: root }); check(protectedProbe.stdout === 'protected-paths-absent', 'protected_paths_visible'); cases.protectedPaths = { passed: true, basis: 'guest_reported plus protected mount/network inventory' };
  await first.session.backend.spawn({ command: 'printf baseline | sudo -n tee /var/lib/jit-evid15-marker >/dev/null', cwd: root }); await first.session.close();
  const system = await open('system'), snapshot = service.vmStore.db.query<{ id: string }, []>('SELECT id FROM vm_snapshots ORDER BY rowid DESC LIMIT 1').get()!;
  const removed = await system.session.backend.spawn({ command: 'sudo -n rm /var/lib/jit-evid15-marker && test ! -e /var/lib/jit-evid15-marker', cwd: system.session.backend.workspaceRoot }); check(removed.exitCode === 0, 'guest_marker_removal_failed');
  const usage = service.policy.control.usage(); await service.vm.recover(owner, { vmId: 'arm', snapshotId: snapshot.id }); check(equal(usage, service.policy.control.usage()), 'policy_rewound'); await service.vm.start(owner, 'arm');
  const restored = await open(); const marker = await restored.session.backend.spawn({ command: 'cat /var/lib/jit-evid15-marker', cwd: restored.session.backend.workspaceRoot }); check(marker.stdout === 'baseline', 'snapshot_restore_failed'); await restored.session.close(); cases.snapshotRecovery = { passed: true, snapshot: snapshot.id, protectedPolicyUnchanged: true, prevention: false };
  const { actor } = admit('account'), browser = service.browser!.open(actor);
  const run = (operation: Omit<Extract<BrowserOperation, { kind: 'navigate' }>, 'generation'> | { kind: 'read' | 'click'; target?: string }) => browser.execute({ ...operation, generation: browser.state().generation } as BrowserOperation);
  const nav = await run({ kind: 'navigate', url: site.origin + '/clean-task' }); check(nav.state === 'ok', 'browser_navigation_failed');
  const read = await run({ kind: 'read' }); check(read.state === 'observed', 'browser_observation_failed');
  if (read.state !== 'observed') throw Error('browser_observation_failed');
  const buttons = read.observation.elements.filter(e => e.name === 'confirm'), held = await run({ kind: 'click', target: buttons[0]!.id }); check(held.state === 'held', 'communication_bypassed'); check(!site.received.some(r => r.path === '/message'), 'message_dispatched');
  cases.browserCommunicationHold = { passed: true, state: held.state }; browser.release(); await browser.settled();
  const fresh = service.browser!.open(actor); check((await fresh.execute({ kind: 'navigate', url: site.origin + '/attacks', generation: fresh.state().generation })).state === 'ok', 'attack_page_failed');
  await new Promise(resolve => setTimeout(resolve, 1200)); const forbidden = ['/background', '/beacon', '/socket', '/events', '/popup', '/frame', '/hidden-submit', '/worker.js']; check(forbidden.every(path => !site.received.some(r => r.path === path)), 'browser_network_bypass'); cases.browserBypass = { passed: true, blocked: forbidden }; fresh.release();
  const prepared = service.policy.work.prepare(actor, { slot: 'financial', adapter: 'fixture_payment', proposal: { quoteId: 'fixture_invoice', quoteVersion: 'v1' } }); check(prepared.decision.state === 'hold' && payment.mutationCalls === 0, 'financial_bypassed'); cases.paymentPolicy = { passed: true, realSettlement: 'not_run', decision: prepared.decision };
  report.usage = service.policy.control.usage(); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error instanceof Error ? error.message : 'evidence_failed'; process.exitCode = 1; }
finally { await Promise.allSettled(sessions.map(s => s.close())); await service.close(); site.close(); report.finishedAt = new Date().toISOString(); writeFileSync(join(input.output, 'results.json'), JSON.stringify(report, null, 2), { mode: 0o600 }); }
console.log(JSON.stringify({ status: report.status, cases: Object.keys(cases), sha: input.sha }));
