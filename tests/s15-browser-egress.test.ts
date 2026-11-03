import { afterEach, expect, test } from 'bun:test';
import { connect, type Socket } from 'node:net';
import { join } from 'node:path';
import { browserDestination, openBrowserEgress, type BrowserAddress, type BrowserEgressPorts, type BrowserOperation, type BrowserRequest, type BrowserResult, type BrowserSitePolicy } from '../src/s15/browser';
import { protectedEngineArgs, protectedEngineProxy, type BrowserEngine, type EngineOptions } from '../src/s15/browser/engine';
import { BrowserError } from '../src/s15/browser/validation';
import { en } from '../src/i18n/en';
import { th } from '../src/i18n/th';
import { browserFixture, browserSite, fixturePublicAddress } from './fixtures/s15-browser';

// BROW15-03: the broker resolves each destination once, refuses non-public answers and dials the checked address.
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const answers = (...addresses: string[]): BrowserAddress[] => addresses.map(address => ({ address, family: address.includes(':') ? 6 : 4 }));
const refusal = async (promise: Promise<unknown>): Promise<string> => { try { await promise; } catch (error) { if (error instanceof BrowserError) return error.code; throw error; } return 'allowed'; };

/** Loopback service that records every request it receives; it stands in for a controller-local service or a public site. */
function service() {
  const received: string[] = [];
  const server = Bun.serve({ hostname: '127.0.0.1', port: 0, fetch(request) { received.push(new URL(request.url).pathname); return new Response('<!doctype html><p>reached</p>', { headers: { 'content-type': 'text/html' } }); } });
  cleanup.push(() => server.stop(true));
  return { port: server.port!, received };
}
/** Scripted DNS and dial seams: each lookup takes the next answer list; a dial of the stand-in public address reaches the loopback service. */
function seams(...script: (BrowserAddress[] | Error)[]) {
  const lookups: string[] = [], dials: { address: string; port: number }[] = [];
  const ports: BrowserEgressPorts = {
    async resolve(host) { lookups.push(host); const next = script[Math.min(lookups.length, script.length) - 1]!; if (next instanceof Error) throw next; return next; },
    connect(address, port): Socket { dials.push({ address, port }); if (address !== fixturePublicAddress) throw new Error('unexpected_dial'); return connect({ host: '127.0.0.1', port }); },
  };
  return { ports, lookups, dials };
}

test('resolver fixtures: public answers are allowed and the first is pinned; every non-public answer refuses', async () => {
  const resolveTo = (list: BrowserAddress[]) => async () => list;
  expect(await browserDestination('https://public.example/a', resolveTo(answers('93.184.215.14', '93.184.215.15')))).toEqual({ host: 'public.example', port: 443, address: '93.184.215.14' });
  expect(await browserDestination('http://public.example:8080/a', resolveTo(answers('2606:2800:21f:cb07:6820:80da:af6b:8b2c')))).toEqual({ host: 'public.example', port: 8080, address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c' });
  expect(await browserDestination('http://public.example/', resolveTo(answers('8.8.8.8')))).toMatchObject({ port: 80 });
  const nonPublic = [
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '10.1.2.3', '172.16.0.1', '172.31.255.255', '192.168.0.10', '100.64.0.1', '100.100.100.200',
    '169.254.169.254', '169.254.10.1', '192.0.2.10', '198.18.0.1', '224.0.0.1', '255.255.255.255',
    '::1', '::', 'fc00::1', 'fd00:ec2::254', 'fe80::1', 'fe80::1%en0', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::ffff:10.0.0.1',
    '64:ff9b::7f00:1', '2001:db8::1', '2001:0db8:0000:0000::1', '2002:7f00:1::1', 'not-an-address', '',
  ];
  for (const address of nonPublic) expect([address, await refusal(browserDestination('https://approved.example/', resolveTo(answers(address))))]).toEqual([address, 'website_address_not_public']);
  // One non-public answer among public ones refuses the whole name, wherever it is in the list.
  expect(await refusal(browserDestination('https://approved.example/', resolveTo(answers('93.184.215.14', '127.0.0.1'))))).toBe('website_address_not_public');
  expect(await refusal(browserDestination('https://approved.example/', resolveTo(answers('10.0.0.1', '93.184.215.14'))))).toBe('website_address_not_public');
  expect(await refusal(browserDestination('https://approved.example/', resolveTo([])))).toBe('request_unavailable');
  expect(await refusal(browserDestination('https://approved.example/', async () => { throw new Error('ENOTFOUND'); }))).toBe('request_unavailable');
});

test('IP literals and loopback names are checked without a resolver seam: the system answer for localhost is refused too', async () => {
  for (const url of ['http://127.0.0.1:8080/', 'http://[::1]/', 'https://169.254.169.254/latest/meta-data/', 'http://[::ffff:127.0.0.1]/', 'http://0x7f.1/', 'http://2130706433/', 'http://10.0.0.8:8006/', 'http://localhost:3000/'])
    expect([url, await refusal(browserDestination(url))]).toEqual([url, 'website_address_not_public']);
});

test('the checked address is the one connected; a rebound second answer is refused before any byte is sent', async () => {
  const site = service(), dns = seams(answers(fixturePublicAddress), answers('127.0.0.1')), egress = openBrowserEgress(dns.ports); cleanup.push(() => egress.close());
  const first = await egress.route(`http://rebind.example:${site.port}/one`);
  expect(first.destination).toEqual({ host: 'rebind.example', port: site.port, address: fixturePublicAddress });
  const response = await first.fetch(`http://rebind.example:${site.port}/one`, { method: 'GET' }); expect(await response.text()).toContain('reached'); first.close();
  // One lookup per request, and the socket dialed exactly the checked answer: no second resolution at connect time.
  expect(dns.lookups).toEqual(['rebind.example']); expect(dns.dials).toEqual([{ address: fixturePublicAddress, port: site.port }]);
  expect(await refusal(egress.route(`http://rebind.example:${site.port}/two`))).toBe('website_address_not_public');
  expect(dns.lookups).toEqual(['rebind.example', 'rebind.example']); expect(dns.dials).toHaveLength(1); expect(site.received).toEqual(['/one']);
  // A route serves only its own destination, once.
  const route = await egress.route(`http://other.example:${site.port}/`).catch(() => null); expect(route).toBeNull();
  const again = openBrowserEgress(seams(answers(fixturePublicAddress)).ports); cleanup.push(() => again.close());
  const single = await again.route(`http://single.example:${site.port}/`);
  expect(await refusal(single.fetch(`http://elsewhere.example:${site.port}/`, {}))).toBe('request_unavailable');
  expect(await refusal(single.fetch(`http://single.example:${site.port}/`, {}))).toBe('request_unavailable');
  single.close(); again.close(); expect(await refusal(again.route(`http://single.example:${site.port}/`))).toBe('engine_unavailable');
});

test('proxy environment variables, including NO_PROXY, cannot move a broker request off its checked route', async () => {
  const site = service(), script = join(import.meta.dir, 'fixtures', 's15-browser-egress-env.ts');
  for (const env of [{ HTTP_PROXY: 'http://127.0.0.1:9', HTTPS_PROXY: 'http://127.0.0.1:9', ALL_PROXY: 'http://127.0.0.1:9', http_proxy: 'http://127.0.0.1:9' }, { NO_PROXY: '*', no_proxy: '*' }]) {
    const child = Bun.spawn([process.execPath, script, String(site.port)], { env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '/', ...env }, stdout: 'pipe', stderr: 'pipe' });
    const [out] = await Promise.all([new Response(child.stdout).text(), child.exited]);
    expect([Object.keys(env)[0], JSON.parse(out.trim())]).toEqual([Object.keys(env)[0], { status: 200, body: 'reached', dials: [fixturePublicAddress] }]);
  }
  expect(site.received).toEqual(['/env', '/env']);
});

/** Fake engine that sends real broker requests for navigations and for one scripted native submission. */
function engine() {
  let options!: EngineOptions, url = 'about:blank', next: BrowserRequest | null = null;
  const request = (r: BrowserRequest) => options.request({ request: r, cookies: '', main: true, document: true, attributable: true, async send() { url = r.url; }, async deny() {} });
  const fake: BrowserEngine = {
    async navigate(target) { await request({ method: 'GET', url: target, contentType: '', bodyBase64: '', navigation: true }); },
    async read(generation) { return { id: 'observation', generation, url, text: 'Observed', truncated: false, elements: [{ id: 'e1_1', tag: 'button', name: 'Save', type: 'submit' }] }; },
    async image() { return new Uint8Array([1]); },
    async interact(_kind, _target, _value, _generation, input) { input.guard(); if (next) { const r = next; next = null; await request(r); } },
    async ownerInput() {}, async cookie() { return null; }, async close() {},
  };
  return { factory: async (o: EngineOptions) => { options = o; return fake; }, set next(r: BrowserRequest) { next = r; } };
}

test('on the gateway an approved name that resolves to loopback is refused before any request reaches it, and the read is settled as not sent', async () => {
  const local = service(), origin = `http://approved.example:${local.port}`;
  const site: BrowserSitePolicy = { loginDocuments: [], session: null, observable: u => new URL(u).origin === origin, classify: r => new URL(r.url).origin === origin && r.method === 'GET' ? { kind: 'read', private: false } : null };
  const dns = seams(answers('127.0.0.1')), fake = engine(), f = await browserFixture('static', site, fake.factory, undefined, dns.ports); cleanup.push(() => f.cleanup());
  const run = (url: string): Promise<BrowserResult> => f.work.execute({ kind: 'navigate', url, generation: f.work.state().generation } as BrowserOperation);
  expect(await run(`${origin}/`)).toEqual({ state: 'unsupported', code: 'website_address_not_public' });
  expect(local.received).toEqual([]); expect(dns.dials).toEqual([]);
  expect(f.service.control.usage().unsettled).toBe(0); expect(f.work.state().reconciliation).toBeNull();
  // Production seams: the loopback literal itself is refused as well.
  const fixture = browserSite(); cleanup.push(() => fixture.close());
  const direct = await browserFixture('static', fixture.site, engine().factory, undefined, {}); cleanup.push(() => direct.cleanup());
  expect(await direct.work.execute({ kind: 'navigate', url: `${fixture.origin}/`, generation: direct.work.state().generation })).toEqual({ state: 'unsupported', code: 'website_address_not_public' });
  expect(fixture.received).toEqual([]);
});

test('rebinding on the gateway: a public first answer is read, a private later answer is refused, and approved effects to it are never dispatched', async () => {
  const fixture = browserSite(); cleanup.push(() => fixture.close());
  // The fixture origin is the loopback literal; its first answers are public stand-ins, later ones loopback.
  const publicAnswer = answers(fixturePublicAddress), dns = seams(publicAnswer, publicAnswer, answers('127.0.0.1'));
  const fake = engine(), f = await browserFixture('static', fixture.site, fake.factory, undefined, dns.ports); cleanup.push(() => f.cleanup());
  const nav = (path: string) => f.work.execute({ kind: 'navigate', url: fixture.origin + path, generation: f.work.state().generation });
  const click = () => f.work.execute({ kind: 'click', target: 'e1_1', generation: f.work.state().generation });
  const post = (path: string, data: string): BrowserRequest => ({ method: 'POST', url: fixture.origin + path, contentType: 'application/x-www-form-urlencoded', bodyBase64: Buffer.from(data).toString('base64'), navigation: true });
  expect(await nav('/clean-task')).toMatchObject({ state: 'ok' }); expect(await nav('/clean-task')).toMatchObject({ state: 'ok' });
  expect(dns.dials.map(d => d.address)).toEqual([fixturePublicAddress, fixturePublicAddress]);
  // A send held and approved before the name rebinds is dispatched after it: refused before commit, never sent.
  fake.next = post('/message', 'recipient=team&message=Exact'); const held = await click(); if (held.state !== 'held') throw Error(JSON.stringify(held));
  f.approve(held.action);
  expect(await f.work.resume(held.action)).toEqual({ state: 'denied', code: 'website_address_not_public' });
  expect(f.work.state().reconciliation).toBeNull();
  // A standing-policy edit and a read refuse the same way.
  fake.next = post('/edit', 'note=Reversible'); expect(await click()).toEqual({ state: 'denied', code: 'website_address_not_public' });
  expect(await nav('/clean-task')).toEqual({ state: 'unsupported', code: 'website_address_not_public' });
  expect(fixture.received.map(r => r.path)).toEqual(['/clean-task', '/clean-task']); expect(dns.dials).toHaveLength(2);
  expect(f.service.control.usage().unsettled).toBe(0);
});

test('Chromium keeps the deny-only proxy as its only path: QUIC, DNS, DNS-over-HTTPS and non-proxied WebRTC are off, with no proxy bypass', () => {
  for (const flag of ['--disable-quic', '--host-resolver-rules=MAP * ~NOTFOUND', '--force-webrtc-ip-handling-policy=disable_non_proxied_udp', '--disable-background-networking']) expect(protectedEngineArgs).toContain(flag);
  const features = protectedEngineArgs.find(a => a.startsWith('--disable-features='))!.slice('--disable-features='.length).split(',');
  for (const feature of ['DnsOverHttps', 'AsyncDns', 'WebTransport']) expect(features).toContain(feature);
  expect(protectedEngineArgs.some(a => a.startsWith('--proxy-bypass-list') || a.startsWith('--proxy-server') || a.startsWith('--enable-quic'))).toBe(false);
  expect(protectedEngineProxy('http://127.0.0.1:1')).toEqual({ server: 'http://127.0.0.1:1', bypass: '<-loopback>' });
});

test('the refusal has owner-facing copy in both languages', () => {
  expect(en['s15.code.website_address_not_public']).toBeTruthy(); expect(th['s15.code.website_address_not_public']).toBeTruthy();
});
