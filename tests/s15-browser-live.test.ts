import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { BrowserOperation, BrowserResult, BrowserObservation, BrowserSitePolicy } from '../src/s15/browser';
import { browserFixture, browserSite } from './fixtures/s15-browser';

const live = describe.skipIf(process.env.JIT_BROWSER_LIVE !== '1');
const observed = (result: BrowserResult): BrowserObservation => { expect(result.state).toBe('observed'); if (result.state !== 'observed') throw Error(JSON.stringify(result)); return result.observation; };

live('opt-in real protected browser engine', () => {
  for (const mode of ['static', 'general'] as const) {
    test(`${mode}: actual navigation, JS boundary, login/TOTP, exact send/payment/disclosure holds, edit, redirect/popup/download denial`, async () => {
      const server = browserSite(); const f = await browserFixture(mode, server.site);
      const run = (input: Omit<Extract<BrowserOperation, { kind: 'navigate' }>, 'generation'> | { kind: 'read' | 'screenshot' | 'click'; target?: string } | { kind: 'type' | 'select'; target: string; value: string }): Promise<BrowserResult> => f.work.execute({ ...input, generation: f.work.state().generation } as BrowserOperation);
      const nav = async (path: string) => { expect(await run({ kind: 'navigate', url: server.origin + path })).toMatchObject({ state: 'ok' }); };
      const click = async (name: string) => { const page = observed(await run({ kind: 'read' })); const target = page.elements.find(e => e.name === name); expect(target).toBeDefined(); return run({ kind: 'click', target: target!.id }); };
      const reset = async () => { const owner = await f.gateway.owner.takeover(f.owner); f.gateway.owner.handBack(f.owner, owner.generation, true); await nav('/clean-task'); };
      try {
        await nav('/');
        const page = observed(await run({ kind: 'read' })); expect(page.text).toContain(mode === 'general' ? 'JavaScript executed' : 'Static fallback');
        expect(server.received.some(r => r.path === '/background')).toBe(false);
        await nav('/login'); expect((await run({ kind: 'screenshot' })).state).toBe('denied');
        const owner = await f.gateway.owner.takeover(f.owner); expect((await f.gateway.owner.frame(f.owner, owner.generation)).length).toBeGreaterThan(100);
        await f.gateway.owner.input(f.owner, owner.generation, { kind: 'type', field: 'password', value: server.password() });
        await f.gateway.owner.input(f.owner, owner.generation, { kind: 'click', field: 'confirm' });
        await f.gateway.owner.input(f.owner, owner.generation, { kind: 'type', field: 'otp', value: server.code() });
        await f.gateway.owner.input(f.owner, owner.generation, { kind: 'click', field: 'confirm' });
        expect(f.gateway.owner.handBack(f.owner, owner.generation).login).toBe('checking');
        expect(await f.gateway.owner.checkSession(f.owner)).toBe('signed_in');
        await nav('/clean-task');
        const fields = observed(await run({ kind: 'read' }));
        const message = fields.elements.find(e => e.name === 'message')!, oldButton = fields.elements.find(e => e.name === 'confirm')!;
        expect((await run({ kind: 'type', target: message.id, value: 'Updated message from browser' })).state).toBe('ok');
        expect(await run({ kind: 'click', target: oldButton.id })).toMatchObject({ state: 'unsupported', code: 'stale_target' });
        const channel = observed(await run({ kind: 'read' })).elements.find(e => e.name === 'channel')!;
        expect((await run({ kind: 'select', target: channel.id, value: 'support' })).state).toBe('ok');
        const send = await click('confirm');
        if (send.state !== 'held') throw Error(JSON.stringify(send)); expect(send.state).toBe('held');
        const action = f.service.owner.inspect(f.owner, send.action).action;
        expect(action.payload).toMatchObject({ method: 'POST', url: server.origin + '/message' });
        const body = new URLSearchParams(Buffer.from((action.payload as { bodyBase64: string }).bodyBase64, 'base64').toString());
        expect(body.get('message')).toBe('Updated message from browser'); expect(body.get('channel')).toBe('support');
        expect(server.received.some(r => r.path === '/message')).toBe(false);
        f.approve(send.action); expect((await f.work.resume(send.action)).state).toBe('ok');
        expect(server.received.filter(r => r.path === '/message')).toHaveLength(1);
        await nav('/clean-task');
        let snapshot = observed(await run({ kind: 'read' })); const buttons = snapshot.elements.filter(e => e.name === 'confirm');
        const payment = await run({ kind: 'click', target: buttons[1]!.id }); expect(payment.state).toBe('held');
        if (payment.state === 'held') expect(f.service.owner.inspect(f.owner, payment.action).action.transaction?.amountMinor).toBe('2500');
        expect(server.received.some(r => r.path === '/checkout')).toBe(false); await reset();
        snapshot = observed(await run({ kind: 'read' })); const edit = snapshot.elements.filter(e => e.name === 'confirm')[2]!;
        expect((await run({ kind: 'click', target: edit.id })).state).toBe('ok'); expect(server.received.some(r => r.path === '/edit')).toBe(true);
        await nav('/clean-task'); const leak = await click('Public search'); expect(leak.state).toBe('held'); expect(server.received.some(r => r.path.startsWith('/leak'))).toBe(false); await reset();
        expect(await click('Popup')).toMatchObject({ state: 'unsupported', code: 'effect_unsupported' }); expect(server.received.some(r => r.path === '/popup')).toBe(false);
        expect(await click('Download')).toMatchObject({ state: 'unsupported', code: 'download_unsupported' }); expect(server.received.some(r => r.path === '/download')).toBe(false);
        await nav('/clean-task'); expect((await click('Redirect')).state).toBe('unsupported'); expect(server.received.some(r => r.path.startsWith('/unknown-effect'))).toBe(false);
        await nav('/attacks'); if (mode === 'general') expect(observed(await run({ kind: 'read' })).text).toContain('All network probes attempted'); await new Promise(resolve => setTimeout(resolve, 1200));
        for (const path of ['/background', '/beacon', '/socket', '/events', '/popup', '/frame', '/hidden-submit', '/worker.js']) expect(server.received.some(r => r.path === path)).toBe(false);
      } finally { await f.cleanup(); server.close(); }
    }, 60000);
  }
  test('general: real JavaScript application read-only task without a bespoke business API', async () => {
    const origin = 'https://excalidraw.com';
    const site: BrowserSitePolicy = {
      loginDocuments: [], session: null,
      observable: url => new URL(url).origin === origin,
      classify(r) {
        const u = new URL(r.url);
        if (!['GET', 'HEAD'].includes(r.method) || u.search || r.bodyBase64) return null;
        if (u.origin === origin && (u.pathname === '/' || /^\/(assets|fonts)\/[A-Za-z0-9_./-]+\.(js|css|woff2?|svg|png|json)$/.test(u.pathname))) return { kind: 'read', private: false };
        if (u.origin === 'https://fonts.excalidraw.com' && /^\/[A-Za-z0-9_./-]+\.woff2$/.test(u.pathname)) return { kind: 'read', private: false };
        return null;
      },
    };
    const f = await browserFixture('general', site);
    try {
      const result = await f.work.execute({ kind: 'navigate', url: origin + '/', generation: f.work.state().generation }); if (result.state !== 'ok') throw Error(JSON.stringify(result)); expect(result.state).toBe('ok');
      const page = observed(await f.work.execute({ kind: 'read', generation: f.work.state().generation }));
      // This toolbar is produced by the client application, not the static fallback page.
      expect(page.text).toContain('Shapes'); expect(page.text).toContain('Canvas actions'); expect(page.text).not.toContain('enable JavaScript');
      expect(page.elements.length).toBeGreaterThan(3);
      const image = await f.work.execute({ kind: 'screenshot', generation: f.work.state().generation }); expect(image.state).toBe('image');
      if (image.state === 'image' && process.env.JIT_BROWSER_EVIDENCE_DIR) { mkdirSync(process.env.JIT_BROWSER_EVIDENCE_DIR, { recursive: true }); writeFileSync(join(process.env.JIT_BROWSER_EVIDENCE_DIR, 'public-js.png'), Buffer.from(image.pngBase64, 'base64')); }
      console.log(JSON.stringify({ evidence: 'public_js_read', site: origin, mode: 'general', textBytes: Buffer.byteLength(page.text), observedControls: page.elements.length, task: 'Read the client-rendered drawing toolbar', observed: ['Shapes', 'Canvas actions'] }));
    } finally { await f.cleanup(); }
  }, 60000);
});
