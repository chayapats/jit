import { describe, expect, test } from 'bun:test';
import type { BrowserOperation, BrowserObservation, BrowserResult } from '../src/s15/browser';
import { browserFixture, browserSite } from './fixtures/s15-browser';
import { launchProtectedEngine } from '../src/s15/browser/engine';

const realBrowser = describe.skipIf(process.env.JIT_BROWSER_LIVE !== '1');
const observation = (result: BrowserResult): BrowserObservation => { if (result.state !== 'observed') throw Error(JSON.stringify(result)); return result.observation; };

async function scenario(mode: 'static' | 'general') {
  const server = browserSite(), trace: { path: string; navigation: boolean; sent: boolean; denied: boolean }[] = [], mutation = Promise.withResolvers<void>();
  const f = await browserFixture(mode, server.site, options => launchProtectedEngine({ ...options, async request(wire) {
    const path = new URL(wire.request.url).pathname;
    if (!path.startsWith('/dynamic')) return options.request(wire);
    const row = { path, navigation: wire.request.navigation, sent: false, denied: false }; trace.push(row);
    await options.request({ ...wire, async send(response) { row.sent = true; await wire.send(response); }, async deny() { row.denied = true; await wire.deny(); } });
    if (path === '/dynamic-send' && !wire.request.navigation) mutation.resolve();
  } }));
  const run = (input: { kind: 'navigate'; url: string } | { kind: 'read' } | { kind: 'click'; target: string } | { kind: 'type' | 'select'; target: string; value: string }) => f.work.execute({ ...input, generation: f.work.state().generation } as BrowserOperation);
  const navigate = async (path: string) => { expect(await run({ kind: 'navigate', url: server.origin + path })).toMatchObject({ state: 'ok' }); };
  const find = async (name: string) => { const page = observation(await run({ kind: 'read' })); const target = page.elements.find(e => e.name === name); if (!target) throw Error(JSON.stringify({ missing: name, page, trace, received: server.received.map(r => r.path) })); return target.id; };
  const login = async () => {
    await navigate('/login'); expect((await run({ kind: 'read' })).state).toBe('denied');
    const owner = await f.gateway.owner.takeover(f.owner);
    expect(await run({ kind: 'click', target: 'copied_target' })).toMatchObject({ state: 'denied' });
    await f.gateway.owner.input(f.owner, owner.generation, { kind: 'type', field: 'password', value: server.password() });
    await f.gateway.owner.input(f.owner, owner.generation, { kind: 'click', field: 'confirm' });
    await f.gateway.owner.input(f.owner, owner.generation, { kind: 'type', field: 'otp', value: server.code() });
    await f.gateway.owner.input(f.owner, owner.generation, { kind: 'click', field: 'confirm' });
    expect(f.gateway.owner.handBack(f.owner, owner.generation).login).toBe('checking');
    expect(await f.gateway.owner.checkSession(f.owner)).toBe('signed_in');
  };
  return { f, server, trace, mutation, run, navigate, find, login, async close() { await f.cleanup(); server.close(); } };
}

realBrowser('S16 protected modern-browser conformance', () => {
  test('static negative control cannot obtain or submit the JS-created authenticated task', async () => {
    const s = await scenario('static');
    try {
      await s.login(); await s.navigate('/dynamic');
      const page = observation(await s.run({ kind: 'read' })); expect(page.text).toContain('JavaScript required'); expect(page.elements).toEqual([]);
      for (const path of ['/dynamic-data', '/dynamic-xhr', '/dynamic-send']) expect(s.server.received.some(r => r.path === path)).toBe(false);
    } finally { await s.close(); }
  }, 60000);

  test('general performs real fetch/XHR hydration, edits a live form and sends exact approved bytes once', async () => {
    const s = await scenario('general');
    try {
      await s.login(); await s.navigate('/dynamic');
      const page = observation(await s.run({ kind: 'read' })); expect(page.text).toContain('Launch day: Friday / Launch project');
      for (const path of ['/dynamic-data', '/dynamic-xhr']) expect(s.server.received.filter(r => r.path === path && r.method === 'GET')).toHaveLength(1);
      const message = await s.find('message'); expect(await s.run({ kind: 'type', target: message, value: 'Friday launch approved for the team' })).toMatchObject({ state: 'ok' });
      const pending = await s.run({ kind: 'click', target: await s.find('confirm') });
      if (pending.state !== 'held') throw Error(JSON.stringify(pending));
      const action = s.f.service.owner.inspect(s.f.owner, pending.action).action;
      const body = Buffer.from((action.payload as { bodyBase64: string }).bodyBase64, 'base64').toString();
      expect(new URLSearchParams(body).get('message')).toBe('Friday launch approved for the team'); expect(action.recipients.map(r => r.id)).toEqual(['payee']);
      expect(s.server.received.filter(r => r.path === '/dynamic-send')).toHaveLength(0);
      s.f.approve(pending.action); expect(await s.f.work.resume(pending.action)).toMatchObject({ state: 'ok' });
      expect(s.server.received.filter(r => r.path === '/dynamic-send')).toEqual([{ path: '/dynamic-send', method: 'POST', body }]);
      expect((await s.f.work.resume(pending.action)).state).toBe('unsupported');
      await s.navigate('/dynamic'); expect(await s.run({ kind: 'select', target: await s.find('recipient'), value: 'support' })).toMatchObject({ state: 'ok' });
      const changed = await s.run({ kind: 'click', target: await s.find('confirm') }); if (changed.state !== 'held') throw Error(JSON.stringify(changed));
      expect(changed.action).not.toEqual(pending.action); expect(s.f.service.owner.inspect(s.f.owner, changed.action).action.recipients.map(r => r.id)).toEqual(['other']);
      expect((await s.f.work.resume(pending.action)).state).toBe('unsupported'); expect(s.server.received.filter(r => r.path === '/dynamic-send')).toHaveLength(1);
    } finally { await s.close(); }
  }, 60000);

  test('JS fetch mutation and submit-time recipient/body substitution cannot borrow a native input', async () => {
    const s = await scenario('general');
    try {
      await s.login(); await s.navigate('/dynamic');
      const attempt = await s.run({ kind: 'click', target: await s.find('xhr') });
      expect(['ok', 'unsupported']).toContain(attempt.state); if (attempt.state === 'unsupported') expect(attempt.code).toBe('unattributable_request');
      await s.mutation.promise; expect(s.trace.find(r => r.path === '/dynamic-send')).toMatchObject({ navigation: false, sent: false, denied: true });
      expect(s.server.received.filter(r => r.path === '/dynamic-send')).toHaveLength(0);
      await s.navigate('/dynamic-tamper');
      expect(await s.run({ kind: 'click', target: await s.find('confirm') })).toMatchObject({ state: 'unsupported', code: 'unattributable_request' });
      expect(s.server.received.filter(r => r.path === '/dynamic-send')).toHaveLength(0);
    } finally { await s.close(); }
  }, 60000);

  test('a real dispatched effect with an unverified response stays unknown and cannot be replayed', async () => {
    const s = await scenario('general'), classify = s.server.site.classify;
    s.server.site.classify = (request, mode) => { const result = classify(request, mode); if (result?.kind !== 'effect') return result; const { verifyResponse: _, ...unverified } = result; return unverified; };
    try {
      await s.login(); await s.navigate('/dynamic');
      const pending = await s.run({ kind: 'click', target: await s.find('confirm') }); if (pending.state !== 'held') throw Error(JSON.stringify(pending));
      s.f.approve(pending.action); expect(await s.f.work.resume(pending.action)).toMatchObject({ state: 'unknown', code: 'reconciliation_required' });
      expect(s.server.received.filter(r => r.path === '/dynamic-send')).toHaveLength(1); expect(s.f.work.state().reconciliation).toEqual(pending.action);
      expect(await s.run({ kind: 'navigate', url: s.server.origin + '/dynamic' })).toMatchObject({ state: 'unknown', code: 'reconciliation_required' });
      expect(s.server.received.filter(r => r.path === '/dynamic-send')).toHaveLength(1);
    } finally { await s.close(); }
  }, 60000);
});
