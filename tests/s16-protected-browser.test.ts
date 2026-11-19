import { afterEach, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { JitClient } from '../src/s16/client';
import type { BrowserEngine } from '../src/s15/browser/engine';
import { composedFixture, ref } from './fixtures/s15-composition';

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
async function setup() {
  let inputs = 0, before: Promise<void> | null = null; const entered = Promise.withResolvers<void>();
  const f = await composedFixture('default', false, undefined, options => {
    const engine: BrowserEngine = {
      async navigate() {}, async read(generation) { return { id: 'unused', generation, url: 'https://login.fixture.test/', text: '', truncated: false, elements: [] }; },
      async location() { return 'https://login.fixture.test/'; },
      async image() { return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8eQAAAAASUVORK5CYII=', 'base64'); },
      async ownerControls() { return [{ id: 'o1_0', label: 'Password', kind: 'password' }]; },
      async ownerInput(_input, control) { entered.resolve(); await before; control.guard(); inputs++; },
      async interact() {}, async cookie() { return null; }, async close() {},
    };
    return { ...options, browser: { ...options.browser!, site: { ...options.browser!.site, loginDocuments: ['https://login.fixture.test/'] }, factory: async () => engine } };
  }); cleanups.push(() => f.close());
  const client = new JitClient({ origin: 'http://localhost:3099', async fetch(request) { const url = new URL(request.url); return f.request(url.pathname + url.search, request.method, request.method === 'POST' ? await request.json() : undefined, Object.fromEntries(request.headers)); } });
  await client.bootstrap();
  return { f, client, entered: entered.promise, get inputs() { return inputs; }, get before() { return before; }, set before(value: Promise<void> | null) { before = value; } };
}

test('composed protected owner sign-in works without an active Bot lease and keeps input out of every store', async () => {
  const s = await setup(), { f, client } = s;
  expect((await client.bootstrap()).capabilities.protectedBrowser?.available).toBe(true);
  const view = await client.protectedBrowser(), takeover = { contract: 's16-protected-browser-command/v1' as const, requestId: 'takeover_once', generation: view.generation, kind: 'takeover' as const };
  const controlled = await client.protectedBrowserCommand(takeover);
  expect(controlled.view.login).toBe('owner_control'); expect((await client.protectedBrowserCommand(takeover)).view.generation).toBe(controlled.view.generation);
  expect(await client.protectedBrowserControls(controlled.view.generation)).toEqual([{ id: 'o1_0', label: 'Password', kind: 'password' }]);
  expect((await client.protectedBrowserFrame(controlled.view.generation)).type).toBe('image/png');
  const secret = 'synthetic-' + crypto.randomUUID(), input = { contract: 's16-protected-browser-command/v1' as const, requestId: 'input_once', generation: controlled.view.generation, kind: 'input' as const, input: { kind: 'type' as const, field: 'o1_0', value: secret } };
  await client.protectedBrowserCommand(input); await client.protectedBrowserCommand(input); expect(s.inputs).toBe(1);
  const forbidden = await f.request('/api/s16/client/protected-browser/commands', 'POST', { ...input, requestId: 'raw_selector', input: { ...input.input, field: 'password' } }); expect(forbidden.status).toBe(400);
  for (const entry of readdirSync(f.directory, { recursive: true, withFileTypes: true })) if (entry.isFile()) expect(readFileSync(join(entry.parentPath, entry.name)).includes(Buffer.from(secret))).toBe(false);
  const returned = await client.protectedBrowserCommand({ contract: 's16-protected-browser-command/v1', requestId: 'hand_back_once', generation: controlled.view.generation, kind: 'hand_back', cancel: false });
  expect(returned.view.login).toBe('checking'); await expect(client.protectedBrowserFrame(controlled.view.generation)).rejects.toMatchObject({ code: 'stale_input' });
});

test('concurrent input retries join one attempt and current owner authority is rechecked after the wait', async () => {
  const s = await setup(), view = await s.client.protectedBrowser();
  const controlled = await s.client.protectedBrowserCommand({ contract: 's16-protected-browser-command/v1', requestId: 'takeover', generation: view.generation, kind: 'takeover' });
  const release = Promise.withResolvers<void>(); s.before = release.promise;
  const command = { contract: 's16-protected-browser-command/v1' as const, requestId: 'shared_input', generation: controlled.view.generation, kind: 'input' as const, input: { kind: 'click' as const, field: 'o1_0' } };
  const results = Promise.allSettled([s.client.protectedBrowserCommand(command), s.client.protectedBrowserCommand(command)]); await s.entered; expect(s.inputs).toBe(0);
  s.f.generation = 2; release.resolve();
  for (const result of await results) { expect(result.status).toBe('rejected'); if (result.status === 'rejected') expect(['authentication_required', 'client_response_stale']).toContain(result.reason.code); }
  expect(s.inputs).toBe(0);
});

test('all protected owner routes enforce authenticated origin and CSRF and reject unknown command keys', async () => {
  const s = await setup(), base = '/api/s16/client/protected-browser';
  for (const suffix of ['', '/controls?generation=1', '/frame?generation=1']) expect((await s.f.request(base + suffix, 'GET', undefined, { cookie: 'jit_s14=forged' })).status).toBe(401);
  const command = { contract: 's16-protected-browser-command/v1', requestId: 'forged', generation: 1, kind: 'takeover' };
  for (const headers of [{ origin: 'https://untrusted.example' }, { 'x-csrf-token': 'forged' }]) expect((await s.f.request(base + '/commands', 'POST', command, headers)).status).toBe(403);
  expect((await s.f.request(base + '/commands', 'POST', { ...command, approve: true })).status).toBe(400);
  expect((await s.f.request(base + '?generation=1')).status).toBe(400);
});

test('a read-only configured browser truthfully reports that protected sign-in is unavailable', async () => {
  const f = await composedFixture(); cleanups.push(() => f.close());
  const response = await f.request('/api/s16/client/protected-browser'); expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ contract: 's16-protected-browser/v1', signIn: false, login: 'not_signed_in' });
});

for (const phase of ['owner_control', 'checking'] as const) test(`a completed Bot releases its lease during ${phase} without fencing owner control or the session probe`, async () => {
  const s = await setup(), { f, client } = s, gateway = f.service.browser!;
  const admit = () => {
    const receipt = f.service.policy.owner.admit(f.owner, { requestId: crypto.randomUUID().replaceAll('-', ''), intent: 'execute', access: 'effect', purpose: ref('purpose'), bot: ref('bot'), resources: [ref('account')], recipients: [ref('provider'), ref('browser_service')], selection: f.choice, selectionPin: null, expiresAt: 800000, readLimit: 100 });
    if (!receipt.work) throw Error('work_not_admitted'); return f.service.policy.control.bindWork(receipt.work.id);
  };
  const work = gateway.open(admit()), initial = await client.protectedBrowser();
  let controlled = (await client.protectedBrowserCommand({ contract: 's16-protected-browser-command/v1', requestId: 'takeover', generation: initial.generation, kind: 'takeover' })).view;
  if (phase === 'checking') controlled = (await client.protectedBrowserCommand({ contract: 's16-protected-browser-command/v1', requestId: 'hand_back', generation: controlled.generation, kind: 'hand_back', cancel: false })).view;
  work.release();
  expect(await client.protectedBrowser()).toMatchObject({ generation: controlled.generation, login: phase });
  if (phase === 'owner_control') {
    await client.protectedBrowserCommand({ contract: 's16-protected-browser-command/v1', requestId: 'transient_input', generation: controlled.generation, kind: 'input', input: { kind: 'type', field: 'o1_0', value: 'synthetic-after-work-completion' } }); expect(s.inputs).toBe(1);
  }
  const next = gateway.open(admit()); expect(next.state()).toMatchObject({ generation: controlled.generation, login: phase }); next.release();
});

test('Bot settlement and release do not wait for or cancel independent owner input', async () => {
  const s = await setup(), { f, client } = s;
  const receipt = f.service.policy.owner.admit(f.owner, { requestId: 'input_overlap_work', intent: 'execute', access: 'effect', purpose: ref('purpose'), bot: ref('bot'), resources: [ref('account')], recipients: [ref('provider'), ref('browser_service')], selection: f.choice, selectionPin: null, expiresAt: 800000, readLimit: 100 });
  if (!receipt.work) throw Error('work_not_admitted'); const work = f.service.browser!.open(f.service.policy.control.bindWork(receipt.work.id));
  const initial = await client.protectedBrowser(), view = (await client.protectedBrowserCommand({ contract: 's16-protected-browser-command/v1', requestId: 'overlap_takeover', generation: initial.generation, kind: 'takeover' })).view;
  const release = Promise.withResolvers<void>(); s.before = release.promise;
  const ownerInput = client.protectedBrowserCommand({ contract: 's16-protected-browser-command/v1', requestId: 'overlap_input', generation: view.generation, kind: 'input', input: { kind: 'type', field: 'o1_0', value: 'synthetic-overlap' } });
  try {
    await s.entered;
    // The owner status response is a separate protocol barrier while owner input is still deliberately held.
    expect(await Promise.race([work.settled().then(() => 'settled'), client.protectedBrowser().then(() => 'status')])).toBe('settled');
    work.release(); expect((await client.protectedBrowser()).generation).toBe(view.generation);
  } finally { release.resolve(); await ownerInput; }
  expect(s.inputs).toBe(1);
});

for (const status of [401, 403]) test(`a ${status} protected frame fences another private frame whose body arrives later`, async () => {
  const s = await setup(), release = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(); let frames = 0;
  const client = new JitClient({ origin: 'http://localhost:3099', async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.endsWith('/protected-browser/frame')) return s.f.request(url.pathname, request.method, undefined, Object.fromEntries(request.headers));
    if (++frames > 1) return Response.json({ error: status === 401 ? 'authentication_required' : 'authorization_required' }, { status });
    const body = new ReadableStream<Uint8Array>({ async start(controller) { entered.resolve(); await release.promise; controller.enqueue(new Uint8Array(40)); controller.close(); } });
    return new Response(body, { headers: { 'content-type': 'image/png' } });
  } });
  await client.bootstrap();
  const pending = client.protectedBrowserFrame(1).then(() => 'published', error => error.code as string);
  try { await entered.promise; await expect(client.protectedBrowserFrame(1)).rejects.toMatchObject({ code: status === 401 ? 'authentication_required' : 'authorization_required' }); }
  finally { release.resolve(); }
  expect(await pending).toBe('client_response_stale');
});
