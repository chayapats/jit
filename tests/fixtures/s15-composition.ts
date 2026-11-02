import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Model } from 'schway/host';
import { composeS15, type S15CompositionOptions } from '../../src/s15/composition';
import { VmSshTransport } from '../../src/s15/vm/transport';
import type { VmManagement } from '../../src/s15/vm/types';
import { equal, zero } from '../../src/s15/policy/validation';
import type { PolicyInput, Ref, Rule } from '../../src/s15/policy';
import { GithubProtocolFixture, coding, repo } from './s15-github';
import { googleFixture } from './s15-effects';
import { recordEngine, documentRecord, taskRecord, businessRecord } from './s15-effect-browser';
import { openFixtureRecordService } from '../../src/s15/effects';
import { createFixturePaymentAdapter, FixturePaymentPort } from '../../src/s15/payments';

export const ref = (id: string): Ref => ({ id, revision: 1, generation: 1 });
const uid = () => crypto.randomUUID().replaceAll('-', '');
export const bound = () => ({ ...zero(), attempts: 1, steps: 1, calls: 1, reads: 0, outputBytes: 32768, activeMs: 10000 });
/** Boots the production composition in-process. Every model and VM transport is scripted; no inference or live account is used. */
export async function composedFixture(profile: 'default' | 'personal' = 'default') {
  const parent = mkdtempSync(join(tmpdir(), 'jit-composed-')), directory = join(parent, 'protected');
  let now = 1000, generation = 1, sourceLive = true, service!: Awaited<ReturnType<typeof composeS15>>, turn = 0;
  const google = googleFixture(), engine = recordEngine();
  const recordService = openFixtureRecordService({ runtime: 's15', path: join(parent, 'records.sqlite'), create: true, resource: ref('account'), rule: () => ref('business_rule'), recipients: () => [{ id: 'new_recipient', ref: ref('new_recipient') }] });
  for (const record of [documentRecord(), taskRecord(), businessRecord()]) recordService.seed(record);
  const proof = {}, secretSession = uid(), csrf = uid(), protocol = new GithubProtocolFixture();
  let interpretation = { intent: 'execute', purposeId: 'purpose', resourceIds: ['computer'], access: 'reversible_write', subject: null as string | null };
  let script: ({ type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> } | { type: 'text'; text: string })[] = [{ type: 'tool_call', id: uid(), name: 'bash', arguments: { command: 'printf composed' } }];
  const choice = { route: ref('route'), model: ref('model'), effort: 'low' };
  const records = new Map<string, { ref: Ref; active: boolean }>();
  for (const [kind, names] of Object.entries({ purpose: ['purpose', 'interpret'], bot: ['bot', 'specialist'], resource: ['computer', 'repo', 'account'], recipient: ['provider', 'payee', 'new_recipient'], route: ['route'], model: ['model'], lineage: ['bundle'] })) for (const id of names) records.set(`${kind}:${id}`, { ref: ref(id), active: true });
  const ordinary: Rule = { id: 'ordinary', mode: 'ordinary', purposes: [ref('purpose')], bots: [ref('bot'), ref('specialist')], resources: [ref('computer'), ref('repo'), ref('account')], recipients: [ref('payee')], selections: [choice],
    adapters: ['working_vm', 's15_github', 'fixture_payment', 'protected_browser', 'gmail_send', 'google_calendar'], operations: ['vm_write', 'vm_shell', 'vm_snapshot', 'vm_system_admin', 'push', 'pr_create', 'pr_update', 'review_reply', 'merge', 'pay', 'browser_request', 'send', 'create', 'update'], classes: ['ordinary_edit', 'guest_local_admin', 'guest_system_admin', 'github_publish', 'communication', 'github_merge', 'production', 'financial', 'major_change', 'disclosure'], expiresAt: 900000, recurrence: null };
  const policy: PolicyInput = { purposes: [ref('purpose'), ref('interpret')], interpretationPurpose: ref('interpret'), bots: [ref('bot'), ref('specialist')], resources: [...ordinary.resources], recipients: [ref('provider'), ref('payee')], selections: [choice],
    budget: { currency: 'USD', startsAt: 0, expiresAt: 900000, concurrency: 10, ceiling: { attempts: 1000, steps: 1000, calls: 10000, reads: 10000, outputBytes: 1000000000, activeMs: 100000000, spendMinor: '100' } }, rules: [ordinary], expiresAt: 900000 };
  if (profile === 'personal') policy.rules.push({ ...structuredClone(ordinary), id: 'publish', mode: 'personal_github_publish', classes: ['github_publish', 'communication'], github: { repository: ref('repo'), target: 'main' } }, { ...structuredClone(ordinary), id: 'merge', mode: 'personal_github_merge', classes: ['github_merge'], github: { repository: ref('repo'), target: 'main', requiredChecks: ['ci'], requiredApprovals: 1, requireCodeOwners: false } });
  const files = new Map<string, Uint8Array>(), vmCalls: string[] = []; let liveVm = 0, implementations = 0, snapshots = 0;
  const manager: VmManagement = { async inspect() { return { state: 'running', identity: 'fixture', boot: 'boot', cpuCount: 2, memoryBytes: 1e9, diskBytes: 1e9, network: 'isolated', nicMac: '52:54:00:12:34:56' }; }, async stop() {}, async snapshot() { snapshots++; }, async restore() {}, async retireSnapshot() {} };
  const endpoint = { host: 'fixture.invalid', port: 22, user: 'jit', identityFile: '/protected/key', knownHostsFile: '/protected/known' };
  class Transport extends VmSshTransport {
    override async control(argv: readonly string[]) { return argv.some(a => a.includes('nicMacs')) ? '{"nicMacs":["52:54:00:12:34:56"]}' : '{"reachable":[false,false,false,false,false,false]}'; }
    override async openScope(_unit: string, _ms: number, guard: () => void) { guard(); liveVm++; }
    override async closeScope() { liveVm--; return true; }
    override async invoke(request: Record<string, unknown>, input: Parameters<VmSshTransport['invoke']>[1]) {
      input.beforeStart(); vmCalls.push(String(request.op));
      if (request.op === 'init') return {};
      if (request.op === 'spawn') return { stdout: Buffer.from('composed').toString('base64'), stderr: '', exitCode: 0, timedOut: false, truncated: false, totalBytes: 8 };
      if (request.op === 'realpath') return { path: request.path };
      if (request.op === 'write') { files.set(String(request.path), Buffer.from(String(request.data), 'base64')); return {}; }
      if (request.op === 'read') return { data: Buffer.from(files.get(String(request.path)) ?? []).toString('base64') };
      if (request.op === 'list') return { entries: [] };
      throw Error('unsupported fixture operation');
    }
  }
  const payment = new FixturePaymentPort([{ id: 'invoice', version: 'v1', purpose: ref('purpose'), account: ref('account'), payee: ref('payee'), currency: 'USD', amount: '5.00', memo: 'Controlled fixture only', expiresAt: 800000 }]);
  const modelPrompts: string[] = [];
  const model: Model = { provider: 'codex-subscription', id: 'fixture-model', async *stream(request) {
    modelPrompts.push(JSON.stringify(request));
    const parts = turn++ === 0 ? script : [{ type: 'text' as const, text: 'Completed with observed tool evidence.' }];
    yield { type: 'message_complete', message: { type: 'assistant', id: uid(), content: parts } };
  } };
  const interpreter: Model = { provider: 'codex-subscription', id: 'fixture-model', async *stream() { turn = 0; yield { type: 'message_complete', message: { type: 'assistant', id: uid(), content: [{ type: 'text', text: JSON.stringify(interpretation) }] } }; } };
  const options = (create: boolean): S15CompositionOptions => ({ runtime: 's15', directory, create, installationId: 'fixture', origin: 'http://localhost:3099',
    owner: { authenticate(token) { if (token !== secretSession) throw Error('unauthorized'); return { proof, csrf }; }, verifyOwner: p => p === proof ? { id: 'owner', generation, expiresAt: 900000 } : null, generation: () => generation, verifyCsrf(expected, supplied) { if (expected !== supplied) throw Error('csrf_rejected'); } },
    catalogs: { current: (kind, id) => records.get(`${kind}:${id}`) ?? null, allows: () => sourceLive }, proposedPolicy: policy,
    conversation: { ownerId: 'owner', bot: ref('bot'), selection: choice, route: { provider: 'codex', model: 'fixture-model' }, limits: { modelCalls: 5, toolCalls: 10, outputBytes: 32768, activeMs: 30000 }, modelCallUpperBound: bound() },
    team: { maxConcurrentOperations: 8, retention: () => ({ kind: 'team' }) },
    model: { limits: { turns: 5, attempts: 1, activeMs: 30000, outputBytes: 32768, contextWindow: 32768, inputChars: 65536 }, registry: { list: () => [route], current: selection => equal(selection, choice) ? route : null, pins: () => ({ route: null, model: null, effort: null }) }, scripted: () => model }, interpreter,
    clock: { now: () => now, monotonicNow: () => now, sleep: (_ms, signal) => new Promise((_, reject) => { signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); }) },
    vm: { id: 'vm', resource: ref('computer'), managers: new Map([['manager', manager]]), transport: () => new Transport(endpoint), upperBound: op => ({ ...zero(), calls: 1, reads: ['setup', 'read'].includes(op.kind) ? 1 : 0, outputBytes: op.outputBytes, activeMs: op.timeoutMs }), destination: () => null },
    github: { repositories: [repo], gateway: protocol.gateway, limits: { snapshotMaxAgeMs: 20000, waitMs: 10, stallMs: 10000, maxNoProgress: 2, maxAttempts: 4, readUpperBound: { ...zero(), calls: 1, reads: 1 }, actionUpperBound: { ...zero(), calls: 1 } }, workspace: () => ({ async implement() { implementations++; return coding(); } }) },
    google: google.options,
    browser: { mode: 'general', resource: ref('account'), fences: [], executablePath: '/fixture/chromium', site: recordService.site, upperBound: { ...zero(), steps: 1, reads: 1, outputBytes: 65536, activeMs: 30000 }, factory: engine.factory, now: () => now },
    adapters: [createFixturePaymentAdapter({ port: payment, currencies: [{ currency: 'USD', minorUnit: 2 }], upperBound: { ...zero(), calls: 1 } })],
  });
  const route: import('../../src/s15/model').ApprovedModelRoute = { selection: choice, provider: 'codex', modelId: 'fixture-model', account: ref('provider_account'), billing: ref('subscription'), recipient: ref('provider'), charge: 'subscription', availability: 'available', efforts: ['low'], effortEvidence: 'requested_only', upperBound: bound(), rank: { ordinary: 0, difficult: 0 } };
  service = await composeS15(options(true)); let owner = service.policy.owner.authenticate(proof);
  service.policy.owner.install(owner, 'install', 0, policy);
  for (const resource of policy.resources) service.team.register(owner, 'resource_' + resource.id, 0, { ...resource, contract: 's15-team-resource/v1', label: resource.id, kind: resource.id === 'computer' ? 'workspace' : 'account', scope: { kind: 'team' }, purposes: ['purpose'], allowedBots: null, deniedBots: [], operations: ['read', 'write', 'input'], active: true, coordinationKey: resource.id });
  service.vmStore.save({ id: 'vm', generation: 1, endpoint, managerId: 'manager', state: 'ready', networkCheckedAt: 1000, networkIsolated: true, maxSessions: 2, reason: null, machineIdentity: 'fixture', boot: 'boot', bindingMac: '52:54:00:12:34:56' });
  const headers = { cookie: `jit_s14=${secretSession}`, origin: 'http://localhost:3099', 'x-csrf-token': csrf, 'content-type': 'application/json' };
  return { parent, directory, options, modelPrompts, google, engine, recordService, policyInput: policy, route, protocol, payment, files, vmCalls, records, choice,
    get service() { return service; }, get owner() { return owner; }, get liveVm() { return liveVm; }, get implementations() { return implementations; }, get snapshots() { return snapshots; },
    get now() { return now; }, advance(ms: number) { now += ms; }, set generation(v: number) { generation = v; }, set sourceLive(v: boolean) { sourceLive = v; },
    set interpretation(value: typeof interpretation) { interpretation = value; }, set script(value: typeof script) { script = value; },
    async request(path: string, method = 'GET', value?: unknown, supplied: Record<string, string> = {}) { return service.fetch(new Request('http://localhost:3099' + path, { method, headers: { ...headers, ...supplied }, ...(value === undefined ? {} : { body: JSON.stringify(value) }) })); },
    async chat(text: string, commandId = uid()) { const command = { contract: 's15-conversation/v1' as const, requestId: commandId, conversationId: 'conversation', text, continuation: null }; const response = await this.request('/api/s15/conversations/conversation/messages', 'POST', command); if (response.status !== 202) throw Error(await response.text()); await service.conversation.drain(); return service.conversation.view(owner, commandId); },
    async reopen() { await service.close(); service = await composeS15(options(false)); owner = service.policy.owner.authenticate(proof); },
    async close() { await service.close(); protocol.close(); google.f.cleanup(); recordService.close(); rmSync(parent, { recursive: true, force: true }); },
  };
}
