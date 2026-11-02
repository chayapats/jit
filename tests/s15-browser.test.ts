import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { BrowserOperation, BrowserRequest, BrowserSitePolicy, BrowserResult } from '../src/s15/browser';
import type { BrowserClock } from '../src/s15/browser/gateway';
import type { BrokerResponse } from '../src/s15/browser';
import type { BrowserEngine, EngineOptions, EngineInputContext } from '../src/s15/browser/engine';
import { denyProxy } from '../src/s15/browser/engine';
import { operation, validateRequest } from '../src/s15/browser/validation';
import { protectedBrowserTools } from '../src/s15/browser/tools';
import { browserFixture, browserSite } from './fixtures/s15-browser';

const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
function fake() {
  let options!: EngineOptions, url = '', next: BrowserRequest | null = null, cookie: string | null = null;
  let sent = 0, denied = 0, frames = 0, physicalInputs = 0, noWait = false;
  let beforeInput: ((input: EngineInputContext) => Promise<void>) | null = null, nextOwner: BrowserRequest | null = null;
  const responses: BrokerResponse[] = []; let afterNavigate: BrowserRequest | null = null; let blockRead: (() => Promise<void>) | null = null;
  const make = (target: string): BrowserRequest => ({ url: target, method: 'GET', contentType: '', bodyBase64: '', navigation: true });
  async function request(r: BrowserRequest, attributable = true) { await options.request({ request: r, cookies: cookie ?? '', main: true, document: true, attributable, async send(response) { sent++; url = r.url; responses.push(response); if (response.setCookies.length) cookie = response.setCookies.map(v => v.split(';')[0]).join('; '); }, async deny() { denied++; } }); }
  const engine: BrowserEngine = {
    async navigate(target) { await request(make(target)); if (afterNavigate) await request(afterNavigate, false); },
    async read(generation) { await blockRead?.(); return { id: 'observation', generation, url, text: 'Observed content', truncated: false, elements: [{ id: 'e1_1', tag: 'button', name: 'Read more', type: 'submit' }] }; },
    async image() { frames++; return new Uint8Array([1, 2, 3]); },
    async interact(_kind, _target, _value, _generation, input) { await beforeInput?.(input); input.guard(); physicalInputs++; if (next) { const r = next; next = null; const job = request(r); if (noWait) void job.catch(() => {}); else await job; } },
    async ownerInput(_value, input) { await beforeInput?.(input); input.guard(); physicalInputs++; if (nextOwner) { const r = nextOwner; nextOwner = null; const job = request(r); if (noWait) void job.catch(() => {}); else await job; } }, async cookie() { return cookie; }, async close() {},
  };
  return { responses, set noWait(value: boolean) { noWait = value; }, set beforeInput(fn: ((input: EngineInputContext) => Promise<void>) | null) { beforeInput = fn; }, set nextOwner(r: BrowserRequest) { nextOwner = r; }, get physicalInputs() { return physicalInputs; }, factory: async (o: EngineOptions) => { options = o; return engine; }, make, request, set afterNavigate(r: BrowserRequest) { afterNavigate = r; }, set next(r: BrowserRequest) { next = r; }, set cookie(v: string | null) { cookie = v; }, set blockRead(v: (() => Promise<void>) | null) { blockRead = v; }, get sent() { return sent; }, get denied() { return denied; }, get frames() { return frames; } };
}
async function setup(mode: 'static' | 'general' = 'static', clock?: BrowserClock) {
  const server = browserSite(), engine = fake(); cleanup.push(() => server.close());
  const f = await browserFixture(mode, server.site, engine.factory, clock); cleanup.push(() => f.cleanup());
  const execute = (input: Omit<Extract<BrowserOperation, { kind: 'navigate' }>, 'generation'> | { kind: 'read' | 'screenshot' | 'click'; target?: string }): Promise<BrowserResult> => f.work.execute({ ...input, generation: f.work.state().generation } as BrowserOperation);
  await execute({ kind: 'navigate', url: server.origin + '/clean-task' });
  return { ...f, server, engine, execute };
}
const post = (url: string, data: string): BrowserRequest => ({ method: 'POST', url, contentType: 'application/x-www-form-urlencoded', bodyBase64: Buffer.from(data).toString('base64'), navigation: true });

describe.each(['static', 'general'] as const)('protected browser %s mode', mode => {
  test('ordinary navigation/read uses real read claims without per-page approval', async () => {
    const f = await setup(mode); expect(f.engine.sent).toBe(1); const result = await f.execute({ kind: 'read' }); expect(result.state).toBe('observed');
    expect(f.service.control.usage().charged.reads).toBe(2);
  });
  test('misleading send button holds actual method, recipient and complete body, then releases once', async () => {
    const f = await setup(mode); f.engine.cookie = 'opaque_protected_cookie';
    f.engine.next = post(f.server.origin + '/message', 'recipient=team&message=Exact+message');
    const held = await f.execute({ kind: 'click', target: 'e1_1' }); expect(held.state).toBe('held'); if (held.state !== 'held') throw Error('expected_hold');
    expect(f.server.received.filter(r => r.path === '/message')).toHaveLength(0);
    const action = f.service.owner.inspect(f.owner, held.action).action;
    expect(action.payload).toMatchObject({ method: 'POST', url: f.server.origin + '/message', bodyBase64: Buffer.from('recipient=team&message=Exact+message').toString('base64') });
    expect(JSON.stringify(action)).not.toContain('opaque_protected_cookie'); expect(readFileSync(f.path).includes(Buffer.from('opaque_protected_cookie'))).toBe(false);
    f.approve(held.action); expect((await f.work.resume(held.action)).state).toBe('ok'); expect(f.server.received.filter(r => r.path === '/message')).toHaveLength(1);
    expect((await f.work.resume(held.action)).state).toBe('unsupported');
  });
  test('ordinary edit executes under standing policy and a payment is held with exact transaction', async () => {
    const f = await setup(mode); f.engine.next = post(f.server.origin + '/edit', 'note=Reversible+note'); expect((await f.execute({ kind: 'click', target: 'e1_1' })).state).toBe('ok');
    expect(f.server.received.some(r => r.path === '/edit')).toBe(true);
    f.engine.next = post(f.server.origin + '/checkout', 'amount=2500&currency=USD'); const result = await f.execute({ kind: 'click', target: 'e1_1' }); expect(result.state).toBe('held'); if (result.state !== 'held') return;
    expect(f.service.owner.inspect(f.owner, result.action).action.transaction?.amountMinor).toBe('2500'); expect(f.server.received.some(r => r.path === '/checkout')).toBe(false);
  });
  test('private query to a recipient is held; unknown and background requests are denied', async () => {
    const f = await setup(mode); f.engine.next = f.engine.make(f.server.origin + '/leak?private=business-note');
    const held = await f.execute({ kind: 'click', target: 'e1_1' }); expect(held.state).toBe('held'); expect(f.server.received.some(r => r.path.startsWith('/leak'))).toBe(false);
    await f.gateway.owner.takeover(f.owner);
    expect(f.engine.denied).toBeGreaterThan(0);
    await f.engine.request(post(f.server.origin + '/background', 'must=not_leave')); expect(f.server.received.some(r => r.path === '/background')).toBe(false);
  });
  test('unknown effects refuse, even if an agent supplies an approval-like object', async () => {
    const f = await setup(mode); f.engine.next = post(f.server.origin + '/unknown', 'send=true'); const result = await f.execute({ kind: 'click', target: 'e1_1' }); expect(result).toEqual({ state: 'unsupported', code: 'effect_semantics_unknown' }); expect(f.server.received.some(r => r.path === '/unknown')).toBe(false);
    const injected = await f.work.execute({ kind: 'evaluate', script: 'fetch("/send")', approved: true, generation: 1 } as unknown as BrowserOperation); expect(injected.state).toBe('denied');
  });
});

test('takeover fences input and reads; hand-back checks observed session rather than trusting the owner', async () => {
  const f = await setup(), initial = f.work.state().generation;
  const takeover = await f.gateway.owner.takeover(f.owner); expect(takeover.generation).toBeGreaterThan(initial);
  expect((await f.work.execute({ kind: 'read', generation: initial })).state).toBe('denied');
  expect((await f.execute({ kind: 'read' })).state).toBe('denied');
  expect((await f.gateway.owner.frame(f.owner, takeover.generation)).length).toBe(3);
  expect(f.gateway.owner.handBack(f.owner, takeover.generation).login).toBe('checking');
  expect(f.work.state().login).toBe('checking'); expect(await f.gateway.owner.checkSession(f.owner)).toBe('not_signed_in');
  await expect(f.gateway.owner.frame(f.owner, takeover.generation)).rejects.toThrow('stale_input');
  const again = await f.gateway.owner.takeover(f.owner); expect(f.gateway.owner.handBack(f.owner, again.generation, true).login).toBe('cancelled');
});

test('takeover after capture begins withholds a late observation', async () => {
  const f = await setup(); let release!: () => void; const wait = new Promise<void>(r => { release = r; }); f.engine.blockRead = () => wait;
  const pending = f.execute({ kind: 'read' }); const owner = await f.gateway.owner.takeover(f.owner); release(); expect((await pending).state).toBe('denied');
  f.gateway.owner.handBack(f.owner, owner.generation, true);
});

test('held action cannot survive takeover and hand-back as a new approval or request', async () => {
  const f = await setup(); f.engine.next = post(f.server.origin + '/message', 'recipient=team&message=Exact'); const held = await f.execute({ kind: 'click', target: 'e1_1' }); if (held.state !== 'held') throw Error('expected_hold');
  f.approve(held.action); const owner = await f.gateway.owner.takeover(f.owner); f.gateway.owner.handBack(f.owner, owner.generation, true);
  expect((await f.work.resume(held.action)).state).toBe('unsupported'); expect(f.server.received.some(r => r.path === '/message')).toBe(false);
});

test('policy revocation between hold and release prevents every network send', async () => {
  const f = await setup(); f.engine.next = post(f.server.origin + '/message', 'recipient=team&message=Exact'); const held = await f.execute({ kind: 'click', target: 'e1_1' }); if (held.state !== 'held') throw Error('expected_hold');
  f.approve(held.action); f.service.owner.revoke(f.owner, 'stop_browser', { kind: 'policy' });
  await expect(f.work.resume(held.action)).rejects.toThrow(); expect(f.server.received.some(r => r.path === '/message')).toBe(false);
});

test('secret capture is unavailable and copied owner objects cannot take over', async () => {
  const f = await setup(); await f.execute({ kind: 'navigate', url: f.server.origin + '/login' }); expect(await f.execute({ kind: 'screenshot' })).toEqual({ state: 'denied', code: 'secret_boundary' }); expect(f.engine.frames).toBe(0);
  await expect(f.gateway.owner.takeover({} as typeof f.owner)).rejects.toThrow('authentication_required');
});

test('finite operation schema and complete body checks reject alternate protocol/file paths', () => {
  for (const value of ['javascript:alert(1)', 'file:///etc/passwd', 'https://user:password@example.invalid/', 'https://example.invalid/#secret']) expect(() => operation({ kind: 'navigate', generation: 1, url: value })).toThrow();
  expect(() => validateRequest({ ...post('https://example.invalid/', ''), contentType: 'multipart/form-data; boundary=untrusted' })).toThrow('upload_unsupported');
  expect(() => validateRequest({ ...post('https://example.invalid/', ''), bodyBase64: 'a' })).toThrow('body_unsupported');
  expect(() => operation({ kind: 'type', target: 'button#send', value: 'text', generation: 1 })).toThrow('stale_target');
});

test('deny proxy refuses HTTP and CONNECT without forwarding', async () => {
  const proxy = await denyProxy(); cleanup.push(() => proxy.close()); const response = await fetch(proxy.url + '/anything'); expect(response.status).toBe(403); expect(proxy.count()).toBe(1);
});

test('Schway tools expose only finite browser JSON with host-bound authority', async () => {
  const f = await setup(); const tools = protectedBrowserTools(f.work); expect(tools.map(t => t.name)).toEqual(['protected_browser']);
  const result = await tools[0]!.execute({ kind: 'evaluate', script: 'stealCookies()' }, { workspace: '/untrusted' } as never); expect(result.isError).toBe(true);
});

test('current browser continuity survives process loss and never turns an armed effect into retry authority', async () => {
  const { browserContinuity } = await import('../src/s15/browser/state');
  const { mkdtempSync, rmSync } = await import('node:fs'); const { tmpdir } = await import('node:os'); const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'jit-browser-continuity-')); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const path = join(dir, 'current.sqlite'), a = { id: 'armed', revision: 1, actionHash: 'a'.repeat(64) };
  const first = browserContinuity(path, true, 'profile_resource'), previous = first.advance(); first.arm(a); first.close();
  const recovered = browserContinuity(path, false, 'profile_resource');
  try { expect(recovered.advance()).toBeGreaterThan(previous); expect(recovered.uncertain()).toEqual(a); expect(() => recovered.arm(a)).toThrow('reconciliation_required'); }
  finally { recovered.close(); }
  expect(() => browserContinuity(path, true, 'profile_resource')).toThrow('continuity_unavailable');
  expect(() => browserContinuity(path, false, 'other_resource')).toThrow('continuity_unavailable');
});

test('an observed HTTP response without verified business outcome stays unknown and blocks fresh effect retries', async () => {
  const f = await setup(), original = f.server.site.classify;
  f.server.site.classify = (request, mode) => { const meaning = original(request, mode); if (meaning?.kind !== 'effect') return meaning; const { verifyResponse: _, ...unverified } = meaning; return unverified; };
  f.engine.next = post(f.server.origin + '/message', 'recipient=team&message=Unverified');
  const result = await f.execute({ kind: 'click', target: 'e1_1' }); if (result.state !== 'held') throw Error('expected_hold');
  f.approve(result.action); expect(await f.work.resume(result.action)).toMatchObject({ state: 'unknown', code: 'reconciliation_required' });
  expect(f.work.state().reconciliation).toEqual(result.action);
  expect(await f.execute({ kind: 'click', target: 'e1_1' })).toMatchObject({ state: 'unknown', code: 'reconciliation_required' });
  expect(f.server.received.filter(r => r.path === '/message')).toHaveLength(1);
});

test('a settled host lease can pass to another work actor while every old closure remains fenced', async () => {
  const f = await setup(); f.work.release();
  const actor = f.admit().actor!, next = f.gateway.open(actor);
  expect(() => f.work.state()).toThrow('stale_input');
  expect((await f.work.execute({ kind: 'read', generation: next.state().generation })).state).toBe('denied');
  f.work.release(); expect(next.state().generation).toBeGreaterThan(1);
  expect((await next.execute({ kind: 'read', generation: next.state().generation })).state).toBe('observed'); next.release();
});

test('an automatic document submission cannot borrow a navigation input even when its endpoint is known', async () => {
  const f = await setup(); f.engine.afterNavigate = post(f.server.origin + '/edit', 'note=Unrequested');
  expect(await f.execute({ kind: 'navigate', url: f.server.origin + '/clean-task' })).toMatchObject({ state: 'unsupported', code: 'unattributable_request' });
  expect(f.server.received.some(r => r.path === '/edit')).toBe(false);
});


test('reopening with the same durable actor does not resurrect a released closure or its release', async () => {
  const f = await setup(); f.work.release(); const next = f.gateway.open(f.actor);
  expect(() => f.work.state()).toThrow('stale_input'); f.work.release();
  let release!: () => void; const wait = new Promise<void>(r => { release = r; }); f.engine.blockRead = () => wait;
  const pending = next.execute({ kind: 'read', generation: next.state().generation });
  expect((await f.work.execute({ kind: 'read', generation: next.state().generation })).state).toBe('denied');
  expect(await next.execute({ kind: 'read', generation: next.state().generation })).toMatchObject({ state: 'denied', code: 'input_busy' });
  release(); expect((await pending).state).toBe('observed'); next.release();
});

const gate = () => { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; };
function manualClock() {
  let now = 0; const timers = new Map<() => void, number>();
  return {
    start(ms: number, callback: () => void) { timers.set(callback, now + ms); return () => { timers.delete(callback); }; },
    advance(ms: number) { now += ms; for (const [callback, due] of timers) if (due <= now) { timers.delete(callback); callback(); } },
  };
}

test('P1 slow links and owner login wait for the actual intercepted response after input acknowledgment', async () => {
  const clock = manualClock(), f = await setup('static', clock); f.engine.noWait = true;
  const entered = gate(), response = gate();
  f.server.beforeResponse = async path => { if (path === '/') { entered.resolve(); await response.promise; } };
  f.engine.next = f.engine.make(f.server.origin + '/'); let completed = false;
  const click = f.execute({ kind: 'click', target: 'e1_1' }).then(r => { completed = true; return r; });
  await entered.promise; clock.advance(150); await Promise.resolve();
  expect(completed).toBe(false); expect(f.engine.sent).toBe(1);
  response.resolve(); expect((await click).state).toBe('ok'); expect(f.engine.sent).toBe(2);
  f.server.beforeResponse = null; await f.execute({ kind: 'navigate', url: f.server.origin + '/login' });
  const owner = await f.gateway.owner.takeover(f.owner), loginEntered = gate(), loginResponse = gate();
  f.server.beforeResponse = async path => { if (path === '/login') { loginEntered.resolve(); await loginResponse.promise; } };
  f.engine.nextOwner = post(f.server.origin + '/login', new URLSearchParams({ password: f.server.password() }).toString());
  let loginCompleted = false;
  const login = f.gateway.owner.input(f.owner, owner.generation, { kind: 'click', field: 'confirm' }).then(() => { loginCompleted = true; });
  await loginEntered.promise; clock.advance(150); await Promise.resolve(); expect(loginCompleted).toBe(false);
  loginResponse.resolve(); await login; expect(loginCompleted).toBe(true);
  f.gateway.owner.handBack(f.owner, owner.generation, true);
});

test.each(['timeout', 'cancel'] as const)('P1 %s after an approved effect is released retains the real transport and becomes reconcile-only', async reason => {
  const clock = manualClock(), f = await setup('static', clock), entered = gate(), response = gate(), controller = new AbortController();
  let transport: AbortSignal | null = null;
  f.server.beforeResponse = async (path, request) => { if (path === '/edit') { transport = request.signal; entered.resolve(); await response.promise; } };
  f.engine.noWait = true; f.engine.next = post(f.server.origin + '/edit', 'note=Slow+approved+edit');
  const operation = f.work.execute({ kind: 'click', target: 'e1_1', generation: f.work.state().generation }, controller.signal);
  await entered.promise;
  if (reason === 'timeout') clock.advance(30000); else controller.abort();
  expect(await operation).toMatchObject({ state: 'unknown', code: 'reconciliation_required' });
  expect((transport as AbortSignal | null)?.aborted).toBe(false);
  const action = f.work.state().reconciliation; expect(action).not.toBeNull();
  response.resolve(); await f.gateway.owner.takeover(f.owner);
  // Await the retained transport's policy observation; it is not a new dispatch or a timer-based retry.
  await f.gateway.close();
  expect(f.service.owner.inspect(f.owner, action!).observation?.outcome).toBe('unknown');
  expect((transport as AbortSignal | null)?.aborted).toBe(false);
  expect(f.server.received.filter(r => r.path === '/edit')).toHaveLength(1); expect(f.engine.sent).toBe(1);
});

test('P1 login keeps two Set-Cookie fields and their independent attributes out of ordinary headers and payloads', async () => {
  const f = await setup(); await f.execute({ kind: 'navigate', url: f.server.origin + '/login' });
  const owner = await f.gateway.owner.takeover(f.owner);
  f.engine.nextOwner = post(f.server.origin + '/login', new URLSearchParams({ password: f.server.password() }).toString());
  await f.gateway.owner.input(f.owner, owner.generation, { kind: 'click', field: 'confirm' });
  f.engine.nextOwner = post(f.server.origin + '/two-factor', new URLSearchParams({ otp: f.server.code() }).toString());
  await f.gateway.owner.input(f.owner, owner.generation, { kind: 'click', field: 'confirm' });
  const response = f.engine.responses.at(-1)!;
  expect(response.setCookies.length).toBe(2); expect(Object.hasOwn(response.headers, 'set-cookie')).toBe(false);
  expect(response.setCookies[0]!.includes('; Expires=Wed, 01 Jan 2031 00:00:00 GMT')).toBe(true);
  expect(response.setCookies[0]!.includes('; SameSite=Strict;')).toBe(true);
  expect(response.setCookies[1]!.includes('; SameSite=Lax;')).toBe(true); expect(response.setCookies[1]!.endsWith('; Max-Age=3600')).toBe(true);
  f.gateway.owner.handBack(f.owner, owner.generation); expect(await f.gateway.owner.checkSession(f.owner)).toBe('signed_in');
});

test('P1 tool cancellation while input awaits readiness prevents the later physical input and request release', async () => {
  const f = await setup(), entered = gate(), ready = gate(), controller = new AbortController();
  f.engine.beforeInput = async input => { expect(input.signal instanceof AbortSignal).toBe(true); entered.resolve(); await ready.promise; };
  f.engine.next = post(f.server.origin + '/edit', 'note=Must+not+leave');
  const tool = protectedBrowserTools(f.work)[0]!;
  const call = tool.execute({ kind: 'click', target: 'e1_1', generation: f.work.state().generation }, { workspace: '/untrusted', signal: controller.signal } as never);
  await entered.promise; controller.abort(); ready.resolve(); const result = await call;
  expect(JSON.parse(result.content)).toMatchObject({ state: 'denied', code: 'cancelled' }); expect(result.isError).toBe(true);
  expect(f.engine.physicalInputs).toBe(0); expect(f.server.received.some(r => r.path === '/edit')).toBe(false);
});

test('P1 cancellation withholds an observation captured after the tool signal was aborted', async () => {
  const f = await setup(), entered = gate(), captured = gate(), controller = new AbortController();
  f.engine.blockRead = async () => { entered.resolve(); await captured.promise; };
  const call = protectedBrowserTools(f.work)[0]!.execute({ kind: 'read', generation: f.work.state().generation }, { workspace: '/untrusted', signal: controller.signal } as never);
  await entered.promise; controller.abort(); captured.resolve(); const result = await call;
  expect(result.isError).toBe(true); expect(JSON.parse(result.content)).toMatchObject({ state: 'denied', code: 'cancelled' });
  expect(result.content).not.toContain('Observed content');
});

test('P1 an engine readiness timeout reports uncertainty without a successful input or any send', async () => {
  const f = await setup(); f.engine.beforeInput = async () => { const error = new Error('fixture deadline'); error.name = 'TimeoutError'; throw error; };
  expect(await f.execute({ kind: 'click', target: 'e1_1' })).toMatchObject({ state: 'unknown', code: 'operation_timeout' });
  expect(f.engine.physicalInputs).toBe(0); expect(f.engine.sent).toBe(1);
});
