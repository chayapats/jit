import { afterEach, expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { JitClient } from '../src/s16/client';
import type { BrowserEngine } from '../src/s15/browser/engine';
import { composedFixture } from './fixtures/s15-composition';

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
