import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDisclosureService, type RecipientApproval } from '../src/s15/disclosure';
import { registerProtectedBrowser, type BrowserOperation, type BrowserRequest } from '../src/s15/browser';
import type { BrowserEngine, EngineOptions } from '../src/s15/browser/engine';
import { fixture, ref } from './fixtures/s15-policy';

const cleanups: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'jit-disclosure-browser-')); cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const received: { url: string; body: string }[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request): Promise<Response> {
    const url = new URL(request.url); received.push({ url: request.url, body: await request.text() });
    return url.pathname === '/redirect' ? new Response(null, { status: 302, headers: { location: server.url.origin + '/new?private=redirected' } }) : new Response('Observed website content', { headers: { 'content-type': 'text/html' } });
  } }); cleanups.push(() => server.stop(true));
  const origin = server.url.origin, approvals: RecipientApproval[] = [];
  const d = openDisclosureService({ runtime: 's15', path: join(dir, 'lineage.sqlite'), create: true, installationId: 'browser_disclosure', now: () => 1000,
    catalogs: { source: r => ['public', 'private'].includes(r.id) ? { ref: r, resource: ref('account'), classification: r.id as 'public' | 'private', active: true, ownerReleasable: true } : null,
      recipient: r => ['payee', 'new_service'].includes(r.id) ? { ref: r, active: true } : null, approvals: () => approvals },
    routes: [{ id: 'browser', kind: 'browser', resolve: (_work, payload) => {
      const u = new URL((payload as { url: string }).url); return u.origin !== origin ? null : [ref(u.pathname === '/new' ? 'new_service' : 'payee')];
    } }], browserSource: (_w, url) => ref(new URL(url).pathname === '/private' ? 'private' : 'public') }); cleanups.push(() => d.close());
  let engineOptions!: EngineOptions, currentUrl = '', next: BrowserRequest | null = null, attributable = true, denied = 0;
  const get = (url: string): BrowserRequest => ({ method: 'GET', url, contentType: '', bodyBase64: '', navigation: true });
  const request = async (r: BrowserRequest) => engineOptions.request({ request: r, main: true, document: true, attributable, cookies: '', send: async () => { currentUrl = r.url; }, deny: async () => { denied++; } });
  const engine: BrowserEngine = { navigate: async url => request(get(url)), interact: async () => { if (next) await request(next); },
    read: async generation => ({ id: 'observed', generation, url: currentUrl, text: 'Private derived content', truncated: false, elements: [] }), image: async () => new Uint8Array([1]), cookie: async () => null, ownerInput: async () => {}, close: async () => {} };
  const gateway = await registerProtectedBrowser({ runtime: 's15', mode: 'general', resource: ref('account'), fences: [], continuity: { path: join(dir, 'browser.sqlite'), create: true },
    profilePath: join(dir, 'profile'), executablePath: '/unused', site: { classify: r => new URL(r.url).origin !== origin ? null : r.method === 'GET' ? { kind: 'read', private: new URL(r.url).pathname === '/private' } : { kind: 'effect', classes: ['ordinary_edit'], recipients: [], transaction: null, impact: 'reversible', verifyResponse: () => 'succeeded' }, observable: () => true, loginDocuments: [], session: null },
    upperBound: { attempts: 0, calls: 1, steps: 1, reads: 1, outputBytes: 10000, activeMs: 100, spendMinor: '0' }, now: () => 1000, disclosure: d.browser('browser') }, async options => { engineOptions = options; return engine; });
  const f = fixture({ adapters: [gateway.adapter], reads: [gateway.readHandler], catalogs: base => d.catalogs(base) });
  cleanups.push(() => f.cleanup()); cleanups.push(() => gateway.close());
  for (const id of ['private', 'public']) f.add('lineage', ref(id)); f.add('recipient', ref('new_service'));
  f.input.rules[0]!.adapters.push('protected_browser'); f.input.rules[0]!.operations.push('browser_request');
  f.input.budget!.ceiling.outputBytes = 1000000;
  f.install(); gateway.attach(f.service); d.attach(f.service); const actor = f.admit({ access: 'effect' }).actor!, work = gateway.open(actor);
  const execute = (input: Omit<Extract<BrowserOperation, { kind: 'navigate' }>, 'generation'> | { kind: 'read' | 'screenshot' | 'click'; target?: string }) => work.execute({ ...input, generation: work.state().generation } as BrowserOperation);
  const approve = (action: import('../src/s15/policy').ActionRef) => f.service.owner.decide(f.owner, { requestId: 'approval_' + action.id, action, decision: 'approve', expiresAt: 20000 });
  return { f, d, gateway, work, actor, received, origin, get, execute, approve, approvals, set next(r: BrowserRequest) { next = r; }, set attributable(v: boolean) { attributable = v; }, denied: () => denied };
}

test('ordinary public pages and public queries do not need a per-page approval', async () => {
  const x = await setup(); expect((await x.execute({ kind: 'navigate', url: x.origin + '/public' })).state).toBe('ok');
  expect((await x.execute({ kind: 'navigate', url: x.origin + '/new?q=public+information' })).state).toBe('ok'); expect(x.received).toHaveLength(2);
});

test.each(['query', 'form', 'upload'] as const)('actual browser %s cannot disguise a new private recipient as a public request', async kind => {
  const x = await setup(); await x.execute({ kind: 'navigate', url: x.origin + '/private' });
  if (kind === 'query') x.next = x.get(x.origin + '/new?q=Derived+private+text');
  else x.next = { method: 'POST', url: x.origin + '/new', contentType: kind === 'upload' ? 'text/plain' : 'application/x-www-form-urlencoded', bodyBase64: Buffer.from('Derived private upload').toString('base64'), navigation: true };
  const held = await x.execute({ kind: 'click', target: 'e1_1' }); expect(held.state).toBe('held'); if (held.state !== 'held') throw Error('expected_hold');
  expect(x.received).toHaveLength(1);
  const slip = x.f.service.owner.actionSlip(x.f.owner, held.action); expect(slip.action.disclosure?.dataClasses).toContain('private'); expect(slip.action.disclosure?.recipients).toEqual([ref('new_service')]);
  x.approve(held.action); expect((await x.work.resume(held.action)).state).toBe('ok'); expect(x.received).toHaveLength(2);
});

test('redirect follow-up and unattributable script disclosure never reach a recipient', async () => {
  const x = await setup(); await x.execute({ kind: 'navigate', url: x.origin + '/private' });
  x.approvals.push({ recipient: ref('payee'), purpose: ref('purpose'), resources: [ref('account')], dataClasses: ['private'], sources: null, expiresAt: 60000 });
  expect(await x.execute({ kind: 'navigate', url: x.origin + '/redirect' })).toMatchObject({ state: 'unsupported', code: 'redirect_unsupported' });
  expect(x.received.some(r => r.url.includes('/new'))).toBe(false);
  x.attributable = false; x.next = x.get(x.origin + '/new?q=private');
  expect(await x.execute({ kind: 'click', target: 'e1_1' })).toMatchObject({ state: 'unsupported', code: 'unattributable_request' });
  expect(x.received.some(r => r.url.includes('/new'))).toBe(false);
});

test('read and screenshot publication retain the browser source before later model/tool use', async () => {
  const x = await setup(); await x.execute({ kind: 'navigate', url: x.origin + '/private' });
  expect((await x.execute({ kind: 'screenshot' })).state).toBe('image');
  x.d.derive(x.actor, ref('screenshot'), 'screenshot'); const sibling = x.f.admit({ access: 'effect' }).actor!; x.d.inherit(sibling, ref('screenshot'));
  const outbound = x.d.browser('browser').inspect(x.f.service.work.guard(sibling), x.get(x.origin + '/new?q=summary'));
  expect(outbound.classes).toContain('disclosure'); expect(outbound.disclosure?.dataClasses).toContain('private');
});
