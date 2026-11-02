import { afterEach, expect, test } from 'bun:test';
import { communicationClasses } from '../src/s15/effects';
import type { BrowserSitePolicy } from '../src/s15/browser';
import { browserFixture } from './fixtures/s15-browser';
import { recordEngine } from './fixtures/s15-effect-browser';
import { ref } from './fixtures/s15-policy';
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

test.each(['email', 'message', 'public_post', 'github_comment'] as const)('actual browser %s route cannot bypass the same final-content approval gate', async route => {
  let deliveries = 0;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    if (request.method === 'POST') { deliveries++; const body = await request.text(); return new Response(body, { headers: { 'content-type': 'text/plain' } }); }
    return new Response('<html><body><form method="post"><button>Read more</button></form></body></html>', { headers: { 'content-type': 'text/html' } });
  } }); cleanup.push(() => server.stop(true)); const origin = server.url.origin;
  const finalBody = new URLSearchParams({ to: 'other-person', content: 'Exact final content', attachments: 'report-v1' }).toString();
  const site: BrowserSitePolicy = { loginDocuments: [], session: null, observable: url => new URL(url).origin === origin,
    classify(request) {
      if (request.url !== `${origin}/${route}`) return null;
      if (request.method === 'GET' && !request.bodyBase64) return { kind: 'read', private: true };
      if (request.method !== 'POST' || Buffer.from(request.bodyBase64, 'base64').toString() !== finalBody) return null;
      return { kind: 'effect', classes: communicationClasses(route), recipients: [ref('payee')], transaction: null, impact: 'reversible', ...(route === 'github_comment' ? { github: { repository: ref('account'), issue: 1, target: 'main', head: 'a'.repeat(40), evidenceHash: 'b'.repeat(64), checksPassed: true, reviewsPassed: true, acceptancePassed: true, production: 'none', deploymentFence: null } as const } : {}), verifyResponse: response => response.status === 200 && Buffer.from(response.body).toString() === finalBody ? 'succeeded' : 'unknown' };
    },
  };
  const engine = recordEngine(), f = await browserFixture('general', site, engine.factory); cleanup.push(() => f.cleanup());
  await f.work.execute({ kind: 'navigate', url: `${origin}/${route}`, generation: f.work.state().generation });
  engine.next = { url: `${origin}/${route}`, method: 'POST', contentType: 'application/x-www-form-urlencoded', bodyBase64: Buffer.from(finalBody).toString('base64'), navigation: true };
  const held = await f.work.execute({ kind: 'submit', target: 'e1_1', generation: f.work.state().generation }); expect(held.state).toBe('held'); expect(deliveries).toBe(0); if (held.state !== 'held') throw Error('expected_hold');
  const slip = f.service.owner.actionSlip(f.owner, held.action); expect(slip.action.classes).toContain('communication'); expect(JSON.parse(Buffer.from(slip.payloadBytesBase64, 'base64').toString()).bodyBase64).toBe(Buffer.from(finalBody).toString('base64'));
  f.approve(held.action); expect((await f.work.resume(held.action)).state).toBe('ok'); expect(deliveries).toBe(1);
  expect((await f.work.resume(held.action)).state).toBe('unsupported'); expect(deliveries).toBe(1);
});
