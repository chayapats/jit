import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { lookup } from 'node:dns/promises';
import { connect } from 'node:net';
import { registerProtectedBrowser, type BrowserEgressPorts, type BrowserMode, type BrowserSitePolicy } from '../../src/s15/browser';
import type { BrowserClock } from '../../src/s15/browser/gateway';
import type { BrowserEngine, EngineOptions } from '../../src/s15/browser/engine';
import { fixture, ref } from './s15-policy';

/** A public-classified stand-in answer for the controlled loopback servers. It is never dialed. */
export const fixturePublicAddress = '93.184.215.14';
/**
 * Fixture DNS/dial seams (BROW15-03). Production refuses the loopback servers these tests use, because an IP
 * literal answers itself and 127.0.0.1 is not public. Here `127.0.0.1` answers with {@link fixturePublicAddress},
 * which still passes the real public-address rule, and the dial seam maps exactly that answer back to the loopback
 * listener on the URL's port. Every other name keeps the system resolver and a direct dial of its checked answer.
 */
export const loopbackFixtureEgress: BrowserEgressPorts = {
  resolve: async host => host === '127.0.0.1' ? [{ address: fixturePublicAddress, family: 4 }] : lookup(host, { all: true, verbatim: true }),
  connect: (address, port) => connect({ host: address === fixturePublicAddress ? '127.0.0.1' : address, port }),
};
/** Controlled real HTTP fixture, with ephemeral credentials never printed, tracked or stored in receipts. */
export function browserSite(options: { delayMs?: number } = {}) {
  const password = randomBytes(24).toString('hex'), secret = randomBytes(20), session = randomBytes(24).toString('hex'), proof = randomBytes(24).toString('hex');
  let beforeResponse: ((path: string, request: Request) => Promise<void>) | null = null;
  let secondFactor = false; const received: { path: string; method: string; body: string }[] = [];
  const totp = (time = Date.now()) => { const bytes = Buffer.alloc(8); bytes.writeBigUInt64BE(BigInt(Math.floor(time / 30000))); const hash = createHmac('sha1', secret).update(bytes).digest(), offset = hash[19]! & 15; return String((hash.readUInt32BE(offset) & 0x7fffffff) % 1000000).padStart(6, '0'); };
  const html = (body: string, status = 200, headers: Record<string, string> = {}) => new Response(`<!doctype html><html><body>${body}</body></html>`, { status, headers: { 'content-type': 'text/html; charset=utf-8', ...headers } });
  const form = (action: string, fields: string, label = 'Continue') => `<form method="post" action="${action}">${fields}<button name="confirm" type="submit">${label}</button></form>`;
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, async fetch(request) {
    const url = new URL(request.url), path = url.pathname, body = await request.text();
    // Never retain credential-bearing login requests in the observable request log.
    if (!['/login', '/two-factor'].includes(path)) received.push({ path: path + url.search, method: request.method, body });
    await beforeResponse?.(path, request);
    if (options.delayMs && (request.method === 'POST' || path === '/')) await Bun.sleep(options.delayMs);
    if (path === '/') return html(`<h1>Controlled website</h1><a href="/task">Task</a><a href="/login">Sign in</a><a href="/attacks">Limits</a><div id="js">Static fallback</div><script src="/app.js"></script>`);
    if (path === '/app.js') return new Response(`document.querySelector('#js').textContent='JavaScript executed';fetch('/background',{method:'POST',body:'must not leave'});`, { headers: { 'content-type': 'application/javascript' } });
    if (path === '/login' && request.method === 'GET') return html(form('/login', '<input name="password" type="password" autocomplete="current-password">', 'Sign in'));
    if (path === '/login' && request.method === 'POST') {
      const value = new URLSearchParams(body).get('password') ?? '';
      secondFactor = value.length === password.length && timingSafeEqual(Buffer.from(value), Buffer.from(password));
      return secondFactor ? html(form('/two-factor', '<input name="otp" autocomplete="one-time-code">', 'Verify')) : html('Rejected', 401);
    }
    if (path === '/two-factor' && request.method === 'POST') {
      const code = new URLSearchParams(body).get('otp');
      if (!secondFactor || code !== totp()) return html('Rejected', 401);
      const headers = new Headers({ 'content-type': 'text/html' });
      headers.append('set-cookie', `jit_session=${session}; HttpOnly; SameSite=Strict; Path=/; Expires=Wed, 01 Jan 2031 00:00:00 GMT`);
      headers.append('set-cookie', `jit_proof=${proof}; HttpOnly; SameSite=Lax; Path=/; Max-Age=3600`);
      return new Response('<h1>Signed in</h1><a href="/task">Task</a>', { headers });
    }
    if (path === '/session') return html('Session observation', request.headers.get('cookie')?.includes(`jit_session=${session}`) && request.headers.get('cookie')?.includes(`jit_proof=${proof}`) ? 200 : 401);
    if (path === '/task') return html(`<h1>Website task</h1>${form('/message', '<input name="recipient" value="team"><textarea name="message">Exact message</textarea><select name="channel"><option value="team">Team</option><option value="support">Support</option></select>', 'Read more')}${form('/checkout', '<input name="amount" value="2500"><input name="currency" value="USD">', 'Continue')}${form('/edit', '<input name="note" value="Reversible note">', 'Save')}<a href="/leak?private=business-note">Public search</a><a href="/redirect">Redirect</a><a href="/download">Download</a><a href="/popup" target="_blank">Popup</a><input name="upload" type="file">`);
    if (path === '/clean-task') return html(`<h1>Website task</h1>${form('/message', '<input name="recipient" value="team"><textarea name="message">Exact message</textarea><select name="channel"><option value="team">Team</option><option value="support">Support</option></select>', 'Read more')}${form('/checkout', '<input name="amount" value="2500"><input name="currency" value="USD">', 'Continue')}${form('/edit', '<input name="note" value="Reversible note">', 'Save')}<a href="/leak?private=business-note">Public search</a><a href="/redirect">Redirect</a><a href="/download">Download</a><a href="/popup" target="_blank">Popup</a>`);
    if (['/message', '/checkout', '/edit'].includes(path)) return html(`<h1>Request accepted</h1><a href="/clean-task">Back</a>`);
    if (path === '/redirect') return new Response(null, { status: 302, headers: { location: '/unknown-effect?private=redirected' } });
    if (path === '/download') return new Response('inert fixture file', { headers: { 'content-type': 'text/plain', 'content-disposition': 'attachment; filename=fixture.txt' } });
    if (path === '/attacks') return html(`<h1>Attack probes</h1><div id="js">Static fallback</div><script>document.querySelector('#js').textContent='JavaScript executed';fetch('/background',{method:'POST',body:'blocked'});navigator.sendBeacon('/beacon','blocked');try{new WebSocket('ws://'+location.host+'/socket')}catch{};try{new EventSource('/events')}catch{};try{window.open('/popup')}catch{};try{let f=document.createElement('iframe');f.src='/frame';document.body.append(f)}catch{};try{new Worker('/worker.js')}catch{};try{navigator.serviceWorker.register('/worker.js').catch(()=>{})}catch{};let p=document.createElement('p');p.textContent='All network probes attempted';document.body.append(p);</script><meta http-equiv="refresh" content="1;url=/unknown-effect?private=refresh"><a href="javascript:fetch('/hidden-submit',{method:'POST'})">Hidden submit</a>`);
    return html('Unknown endpoint', 404);
  } });
  const origin = server.url.origin;
  const verifyResponse = (r: { status: number; body: Uint8Array }): 'succeeded' | 'unknown' => r.status === 200 && Buffer.from(r.body).includes(Buffer.from('Request accepted')) ? 'succeeded' : 'unknown';
  const site: BrowserSitePolicy = {
    loginDocuments: [origin + '/login', origin + '/two-factor'], session: { url: origin + '/session', cookie: 'jit_session', signedInStatus: 200, signedOutStatus: 401 },
    observable: url => { const u = new URL(url); return u.origin === origin && ['/', '/clean-task', '/message', '/checkout', '/edit', '/attacks'].includes(u.pathname); },
    classify(r) {
      const u = new URL(r.url); if (u.origin !== origin) return null;
      if (u.pathname === '/download') return { kind: 'unsupported', code: 'download_unsupported' };
      if (['/login', '/two-factor'].includes(u.pathname) && r.method === 'POST') return { kind: 'login' };
      if (['GET', 'HEAD'].includes(r.method) && !u.search && ['/', '/app.js', '/login', '/session', '/task', '/clean-task', '/attacks', '/redirect', '/download'].includes(u.pathname)) return { kind: 'read', private: ['/session', '/task', '/clean-task'].includes(u.pathname) };
      if (u.pathname === '/leak' && r.method === 'GET' && [...u.searchParams.keys()].join() === 'private') return { kind: 'effect', verifyResponse, classes: ['disclosure', 'new_egress'], recipients: [ref('other')], transaction: null, impact: 'reversible' };
      if (u.search || r.method !== 'POST') return null;
      const fields = new URLSearchParams(Buffer.from(r.bodyBase64, 'base64').toString());
      if (u.pathname === '/message' && [...fields.keys()].every(k => ['recipient', 'message', 'channel', 'confirm'].includes(k))) return { kind: 'effect', verifyResponse, classes: ['communication'], recipients: [ref('payee')], transaction: null, impact: 'reversible' };
      if (u.pathname === '/edit' && [...fields.keys()].every(k => ['note', 'confirm'].includes(k))) return { kind: 'effect', verifyResponse, classes: ['ordinary_edit'], recipients: [], transaction: null, impact: 'reversible' };
      if (u.pathname === '/checkout' && fields.get('currency') === 'USD' && /^[1-9][0-9]{0,6}$/.test(fields.get('amount') ?? '')) return { kind: 'effect', verifyResponse, classes: ['financial'], recipients: [ref('payee')], transaction: { payee: ref('payee'), account: ref('account'), currency: 'USD', minorUnit: 2, amountMinor: fields.get('amount')!, quoteId: 'checkout_quote', quoteVersion: '1', quoteExpiresAt: 80000 }, impact: 'reversible' };
      return null;
    },
  };
  return { origin, site, received, set beforeResponse(fn: ((path: string, request: Request) => Promise<void>) | null) { beforeResponse = fn; }, password: () => password, code: () => totp(), close: () => server.stop(true) };
}
/** Real policy service and disposable protected profile shared by deterministic and opt-in engine tests. */
export async function browserFixture(mode: BrowserMode, site: BrowserSitePolicy, factory?: (options: EngineOptions) => Promise<BrowserEngine>, clock?: BrowserClock, egress: BrowserEgressPorts = loopbackFixtureEgress) {
  const dir = mkdtempSync(join(tmpdir(), 'jit-protected-browser-'));
  const gateway = await registerProtectedBrowser({ runtime: 's15', continuity: { path: join(dir, 'continuity.sqlite'), create: true }, mode, resource: ref('account'), fences: [{ kind: 'input', ref: ref('input') }], profilePath: join(dir, 'profile'), executablePath: process.env.JIT_BROWSER_EXECUTABLE ?? '/usr/bin/chromium', site, upperBound: { attempts: 0, steps: 1, calls: 0, reads: 1, outputBytes: 2097152, activeMs: 30000, spendMinor: '0' }, now: () => 1000, egress }, factory, clock);
  const f = fixture({ adapters: [gateway.adapter], reads: [gateway.readHandler] });
  f.input.budget!.ceiling = { attempts: 1000, steps: 1000, calls: 1000, reads: 1000, outputBytes: 2_000_000_000, activeMs: 30_000_000, spendMinor: '100' };
  f.input.rules[0]!.adapters.push('protected_browser'); f.input.rules[0]!.operations.push('browser_request');
  f.install(); gateway.attach(f.service); const actor = f.admit({ access: 'effect', readLimit: 1000 }).actor!, work = gateway.open(actor);
  return { ...f, approve(action: import('../../src/s15/policy').ActionRef) { f.service.owner.decide(f.owner, { requestId: 'approve_' + action.id, action, decision: 'approve', expiresAt: 20000 }); }, gateway, work, actor, async cleanup() { await gateway.close(); f.cleanup(); rmSync(dir, { recursive: true, force: true }); } };
}
