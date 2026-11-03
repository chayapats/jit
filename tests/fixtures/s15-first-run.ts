import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Model } from 'schway/host';
import { ConnectionVault } from '../../src/exec/connections';
import { AppError } from '../../src/errors';
import { s15InstallerConfig } from '../../ops/package/installer/s15';
import { composeS15, type S15CompositionOptions } from '../../src/s15/composition';
import { runtimeDisclosure } from '../../src/s15/disclosure/runtime';
import { s15GithubRecipient } from '../../src/s15/github/connection';
import { githubConnectionRuntime } from '../../src/s15/github/runtime';
import type { ApprovedModelRoute } from '../../src/s15/model';
import { s15DefaultCatalog, s15SubscriptionModels } from '../../src/s15/policy/defaults';
import { equal } from '../../src/s15/policy/validation';
import { VmSshTransport } from '../../src/s15/vm/transport';
import type { VmManagement } from '../../src/s15/vm/types';

const uid = () => crypto.randomUUID().replaceAll('-', '');
export const fixtureToken = 'github_pat_' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(3);

/** Scripted GitHub REST fixture: identity, repository listing and the bounded readiness snapshot reads. Records every call. */
export function githubFixture() {
  const calls: { path: string; method: string; authorization: string | null }[] = [];
  const repos = [{ full_name: 'chayapats/jit-s15-sandbox', default_branch: 'main', private: true, permissions: { admin: false, push: true, pull: true } }, { full_name: 'chayapats/other-repo', default_branch: 'main', private: false, permissions: { admin: false, push: false, pull: true } }];
  const base = 'a'.repeat(40);
  const state = { status: 200, expiry: '2027-01-15 00:00:00 UTC' as string | null };
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input)), path = url.pathname, headers = new Headers(init?.headers);
    calls.push({ path: path + url.search, method: init?.method ?? 'GET', authorization: headers.get('authorization') });
    if (url.origin !== 'https://api.github.com') return new Response(null, { status: 404 });
    if (headers.get('authorization') !== `Bearer ${fixtureToken}`) return Response.json({ message: 'Bad credentials' }, { status: 401 });
    if (state.status !== 200) return Response.json({ message: 'refused' }, { status: state.status });
    if (path === '/user') return Response.json({ login: 'chayapats' }, { headers: state.expiry ? { 'github-authentication-token-expiration': state.expiry } : {} });
    if (path === '/user/repos') return Response.json(repos);
    const root = '/repos/chayapats/jit-s15-sandbox';
    if (!path.startsWith(root)) return Response.json({ message: 'Not Found' }, { status: 404 });
    if (path === `${root}/git/ref/heads/main`) return Response.json({ object: { sha: base } });
    if (path === `${root}/branches/main/protection`) return Response.json({ message: 'Branch not protected' }, { status: 404 });
    if (path === `${root}/issues`) return Response.json([{ number: 7, title: 'Add a greeting', body: '## Deliverable\nPrint a greeting.\n## Acceptance criteria\n- [ ] The greeting prints\n', assignees: [], state: 'open' }]);
    if (path === `${root}/issues/7/comments`) return Response.json([]);
    if (path === `${root}/branches`) return Response.json([{ name: 'main' }]);
    if (path === `${root}/pulls`) return Response.json([]);
    return Response.json({ message: 'Not Found' }, { status: 404 });
  }) as typeof globalThis.fetch;
  return { fetch, calls, state };
}

/**
 * Boots the production composition from the installer-generated configuration (`s15InstallerConfig`), wired the way
 * `runS15` wires it: protected default catalog, subscription registry, default policy and the Web GitHub connection.
 * Only the owner session, model, VM transport and GitHub HTTP are scripted; no inference, VM or GitHub is contacted.
 */
export async function firstRunFixture(tune?: (options: S15CompositionOptions, config: ReturnType<typeof s15InstallerConfig>) => S15CompositionOptions) {
  const parent = realpathSync(mkdtempSync(join(tmpdir(), 'jit-first-run-'))), directory = join(parent, 'runtime');
  const config = { ...s15InstallerConfig({ installationId: 's15_0123456789abcdef', vmm: null, origin: 'http://localhost:3098' }), directory: parent };
  let abandoned = false, now = Date.UTC(2026, 10, 3, 9), turn = 0, service!: Awaited<ReturnType<typeof composeS15>>;
  const proof = {}, session = uid(), csrf = uid(), github = githubFixture();
  let interpretation: Record<string, unknown> = { intent: 'execute', purposeId: 'owner_requested_work', resourceIds: ['computer'], access: 'reversible_write', subject: null };
  let script: ({ type: 'tool_call'; id: string; name: string; arguments: Record<string, unknown> } | { type: 'text'; text: string })[] = [{ type: 'tool_call', id: uid(), name: 'bash', arguments: { command: 'printf first-run' } }];
  const vmCalls: string[] = [], prompts: string[] = [];
  const routes: ApprovedModelRoute[] = structuredClone(config.models);
  const manager: VmManagement = { async inspect() { return { state: 'running', identity: 'fixture', boot: 'boot', cpuCount: 2, memoryBytes: 1e9, diskBytes: 1e9, network: 'isolated', nicMac: '52:54:00:12:34:56' }; }, async stop() {}, async start() {}, async snapshot() {}, async restore() {}, async retireSnapshot() {} };
  const endpoint = { host: 'fixture.invalid', port: 22, user: 'jit', identityFile: '/protected/key', knownHostsFile: '/protected/known' };
  class Transport extends VmSshTransport {
    override async control(argv: readonly string[]) { return argv.some(a => a.includes('nicMacs')) ? '{"nicMacs":["52:54:00:12:34:56"]}' : '{"reachable":[false,false,false,false,false,false]}'; }
    override async openScope(_unit: string, _ms: number, guard: () => void) { guard(); }
    override async closeScope() { return true; }
    override async invoke(request: Record<string, unknown>, input: Parameters<VmSshTransport['invoke']>[1]) {
      input.beforeStart(); vmCalls.push(String(request.op));
      if (request.op === 'init') return {};
      if (request.op === 'spawn') return { stdout: Buffer.from('first-run').toString('base64'), stderr: '', exitCode: 0, timedOut: false, truncated: false, totalBytes: 9 };
      if (request.op === 'realpath') return { path: request.path };
      throw Error('unsupported fixture operation');
    }
  }
  const model: Model = { provider: 'codex-subscription', id: 'gpt-6.1-sol', async *stream(request) {
    prompts.push(JSON.stringify(request));
    const parts = turn++ === 0 ? script : [{ type: 'text' as const, text: 'Done with observed tool evidence.' }];
    yield { type: 'message_complete', message: { type: 'assistant', id: uid(), content: parts } };
  } };
  const interpreter: Model = { provider: 'codex-subscription', id: 'gpt-6.1-sol', async *stream(request) { prompts.push(JSON.stringify(request)); turn = 0; yield { type: 'message_complete', message: { type: 'assistant', id: uid(), content: [{ type: 'text', text: JSON.stringify(interpretation) }] } }; } };
  const vault = new ConnectionVault(join(parent, 'vault'), { forbidden: [directory] });
  // Mirrors runS15: explicit rows first, then the protected default catalog.
  const defaultCatalog = s15DefaultCatalog(config.models);
  const catalogs: S15CompositionOptions['catalogs'] = { current: (kind, id) => config.catalog.find(row => row.kind === kind && row.ref.id === id) ?? defaultCatalog.find(row => row.kind === kind && row.ref.id === id) ?? null, allows: () => true };
  const options = (create: boolean): S15CompositionOptions => {
    const base: S15CompositionOptions = { runtime: 's15', directory, create, installationId: config.installationId, origin: config.origin,
      owner: { authenticate(token) { if (token !== session) throw new AppError('authentication_required', 401); return { proof, csrf }; }, verifyOwner: p => p === proof ? { id: 'owner', generation: 1, expiresAt: now + 3_600_000 } : null, generation: () => 1, verifyCsrf(expected, supplied) { if (expected !== supplied) throw new AppError('csrf_rejected', 403); } },
      catalogs, disclosure: runtimeDisclosure(config.disclosure!, config.models, catalogs, [], { ...s15GithubRecipient }),
      team: { maxConcurrentOperations: config.team!.maxConcurrentOperations, retention: () => null },
      conversation: config.conversation, proposedPolicy: config.policy,
      model: { limits: config.modelLimits, registry: { list: () => routes, current: selection => routes.find(r => equal(r.selection, selection)) ?? null, pins: () => ({ route: null, model: null, effort: null }) }, scripted: () => model }, interpreter,
      subscriptionModels: s15SubscriptionModels(() => routes, config.team!.maxConcurrentOperations),
      defaultPolicy: { concurrency: config.team!.maxConcurrentOperations },
      githubWeb: { vault, fetch: github.fetch, runtime: input => githubConnectionRuntime({ directory: parent, vmId: config.vm.id, route: config.conversation.route, modelCallUpperBound: config.conversation.modelCallUpperBound, ...input }) },
      clock: { now: () => now, monotonicNow: () => now, sleep: (_ms, signal) => new Promise((_, reject) => { signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); }) },
      vm: { id: config.vm.id, resource: config.vm.resource, managers: new Map([['manager', manager]]), transport: () => new Transport(endpoint), upperBound: () => config.vm.upperBound, destination: () => null } };
    return tune ? tune(base, config) : base;
  };
  const enroll = () => service.vmStore.save({ id: config.vm.id, generation: 1, endpoint, managerId: 'manager', state: 'ready', networkCheckedAt: now, networkIsolated: true, maxSessions: 2, reason: null, machineIdentity: 'fixture', boot: 'boot', bindingMac: '52:54:00:12:34:56' });
  service = await composeS15(options(true)); enroll();
  const owner = () => service.policy.owner.authenticate(proof);
  const headers = { cookie: `jit_s14=${session}`, origin: config.origin, 'x-csrf-token': csrf };
  return { config, parent, directory, routes, vault, github, vmCalls, prompts, csrf,
    get service() { return service; }, owner, get now() { return now; }, advance(ms: number) { now += ms; },
    set interpretation(value: Record<string, unknown>) { interpretation = value; }, set script(value: typeof script) { script = value; },
    async page(path: string, locale = 'th') { const response = await service.fetch(new Request(config.origin + path, { headers: { ...headers, 'accept-language': locale } })); return { status: response.status, html: await response.text(), location: response.headers.get('location') }; },
    async form(path: string, fields: Record<string, string>) { const response = await service.fetch(new Request(config.origin + path, { method: 'POST', headers: { ...headers, "accept-language": "en", "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ csrf, requestId: uid(), ...fields }) })); return { status: response.status, html: await response.text(), location: response.headers.get('location') }; },
    async chat(text: string, requestId = uid()) {
      const command = { contract: 's15-conversation/v1' as const, requestId, conversationId: 'first', text, continuation: null };
      const response = await service.fetch(new Request(config.origin + '/api/s15/conversations/first/messages', { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify(command) }));
      if (response.status !== 202) throw Error(await response.text());
      await service.conversation.drain(); return service.conversation.view(owner(), requestId);
    },
    options,
    async reopen(tuneAgain?: typeof tune) { await service.close(); if (tuneAgain) tune = tuneAgain; service = await composeS15(options(false)); },
    /** The test closed the service itself and left no live one; cleanup only removes the directory. */
    abandon() { abandoned = true; },
    async close() { if (!abandoned) await service.close(); rmSync(parent, { recursive: true, force: true }); },
  };
}
