import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { BrowserInputSnapshot, BrowserOperation, BrowserRequest } from '../src/s15/browser';
import type { BrowserEngine, EngineInputContext, EngineOptions } from '../src/s15/browser/engine';
import { BrowserError } from '../src/s15/browser/validation';
import type { BrowserClock } from '../src/s15/browser/gateway';
import { browserFixture, browserSite } from './fixtures/s15-browser';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const snapshot = (url: string): BrowserInputSnapshot => ({ url, kind: 'click', value: null, target: { tag: 'button', name: 'send_async', type: 'button' }, fields: [{ name: 'message', type: 'textarea', values: ['Exact asynchronous content'] }] });
async function setup() {
  const server = browserSite(); cleanups.push(() => server.close());
  const request: BrowserRequest = { method: 'POST', url: server.origin + '/message', contentType: 'application/x-www-form-urlencoded', bodyBase64: Buffer.from('recipient=team&message=Exact+asynchronous+content').toString('base64'), navigation: false };
  let options!: EngineOptions, location = '', physical = 0, denied = 0, duplicate = false, omit = false, wrong = false, unknown = false, never = false, changedMeaning = false;
  let before: Promise<void> | null = null; const entered = Promise.withResolvers<void>(), timers = new Set<() => void>();
  let actual = { ...request };
  const clock: BrowserClock = { start(_ms, callback) { timers.add(callback); return () => { timers.delete(callback); }; } };
  const engine: BrowserEngine = {
    async navigate(url, input) { input.guard(); await options.request({ request: { method: 'GET', url, contentType: '', bodyBase64: '', navigation: true }, main: true, document: true, attributable: true, cookies: '', async send() { location = url; }, async deny() { denied++; } }); },
    async read(generation) { return { id: 'observation', generation, url: location, text: 'Current record', truncated: false, elements: [{ id: 'e1_0', tag: 'button', name: 'send_async', type: 'button' }] }; },
    async image() { return new Uint8Array([1]); },
    async interact(_kind, _target, _value, _generation, input: EngineInputContext) {
      const plan = input.prepareIntent?.(snapshot(location)); if (!plan) throw Error('missing_intent'); entered.resolve(); await before; input.guard();
      physical++;
      const wire = (nonce?: string) => options.request({ request: { ...actual }, main: true, document: actual.navigation, attributable: actual.navigation, ...(nonce ? { intent: nonce } : {}), cookies: 'private_session_never_in_payload', async send() {}, async deny() { denied++; } });
      if (!never) {
        const first = wire(omit ? undefined : wrong ? 'guessed_by_page' : plan.nonce);
        if (duplicate) await Promise.all([first, wire()]); else await first;
      }
      const result = await plan.settled; input.guard(); if (result) throw new BrowserError(result);
    },
    async ownerInput() {}, async cookie() { return null; }, async close() {},
  };
  const site = { ...server.site, classify(r: Readonly<BrowserRequest>, mode: 'static' | 'general') { return changedMeaning && r.url === request.url ? { kind: 'read' as const, private: true } : server.site.classify(r, mode); }, intent(input: Readonly<BrowserInputSnapshot>) { if (input.target.name !== 'send_async') return null; return unknown ? { ...request, url: server.origin + '/not-reviewed' } : { ...request }; } };
  const f = await browserFixture('general', site, async value => { options = value; return engine; }, clock); cleanups.push(() => f.cleanup());
  const run = (input: { kind: 'navigate'; url: string } | { kind: 'click'; target: string }, signal?: AbortSignal) => f.work.execute({ ...input, generation: f.work.state().generation } as BrowserOperation, signal);
  expect((await run({ kind: 'navigate', url: server.origin + '/clean-task' })).state).toBe('ok');
  return { ...f, server, request, run, entered: entered.promise, get physical() { return physical; }, get denied() { return denied; }, get before() { return before; }, set before(value: Promise<void> | null) { before = value; }, get actual() { return actual; }, set actual(value: BrowserRequest) { actual = value; },
    get changedMeaning() { return changedMeaning; }, set changedMeaning(value: boolean) { changedMeaning = value; }, get duplicate() { return duplicate; }, set duplicate(value: boolean) { duplicate = value; }, get omit() { return omit; }, set omit(value: boolean) { omit = value; }, get wrong() { return wrong; }, set wrong(value: boolean) { wrong = value; }, get unknown() { return unknown; }, set unknown(value: boolean) { unknown = value; }, get never() { return never; }, set never(value: boolean) { never = value; }, timeout() { for (const callback of [...timers]) callback(); } };
}

for (const phase of ['input', 'approval'] as const) test(`changed trusted request meaning during the ${phase} wait cannot downgrade an intent to a read`, async () => {
  const f = await setup();
  if (phase === 'input') {
    const release = Promise.withResolvers<void>(); f.before = release.promise;
    const pending = f.run({ kind: 'click', target: 'e1_0' }); await f.entered;
    f.changedMeaning = true; release.resolve(); expect(await pending).toEqual({ state: 'unsupported', code: 'intent_request_changed' });
  } else {
    const held = await f.run({ kind: 'click', target: 'e1_0' }); if (held.state !== 'held') throw Error('expected_hold');
    f.approve(held.action); f.changedMeaning = true; expect((await f.work.resume(held.action)).state).not.toBe('ok');
  }
  expect(f.server.received.filter(row => row.path === '/message')).toHaveLength(0);
});

test('a protected pre-input intent holds the exact actual async request and approval releases it once', async () => {
  const f = await setup(), held = await f.run({ kind: 'click', target: 'e1_0' });
  expect(held.state).toBe('held'); if (held.state !== 'held') throw Error('expected_hold');
  expect(f.server.received.filter(row => row.path === '/message')).toHaveLength(0);
  const action = f.service.owner.inspect(f.owner, held.action).action;
  expect(action.payload).toMatchObject({ ...f.request }); expect(JSON.stringify(action)).not.toContain('private_session_never_in_payload');
  f.approve(held.action); expect((await f.work.resume(held.action)).state).toBe('ok');
  expect(f.server.received.filter(row => row.path === '/message')).toHaveLength(1); expect(f.physical).toBe(1);
  expect((await f.work.resume(held.action)).state).toBe('unsupported');
  expect(readFileSync(f.path).includes(Buffer.from('private_session_never_in_payload'))).toBe(false);
});

for (const mutation of ['body', 'nonce', 'missing nonce', 'URL', 'navigation', 'content type'] as const) test(`changed ${mutation} cannot consume an intent or produce an approvable request`, async () => {
  const f = await setup();
  if (mutation === 'body') f.actual = { ...f.request, bodyBase64: Buffer.from('recipient=other&message=Substituted').toString('base64') };
  if (mutation === 'nonce') f.wrong = true; if (mutation === 'missing nonce') f.omit = true;
  if (mutation === 'URL') f.actual = { ...f.request, url: f.server.origin + '/edit', bodyBase64: Buffer.from('note=Unreviewed').toString('base64') };
  if (mutation === 'navigation') f.actual = { ...f.request, navigation: true };
  if (mutation === 'content type') f.actual = { ...f.request, contentType: 'text/plain' };
  expect(await f.run({ kind: 'click', target: 'e1_0' })).toEqual({ state: 'unsupported', code: 'intent_request_changed' });
  expect(f.server.received.filter(row => row.path === '/message')).toHaveLength(0); expect(f.work.state().reconciliation).toBeNull();
});

test('a second identical mutation cannot borrow the first request nonce or duplicate the effect', async () => {
  const f = await setup(); f.duplicate = true; const held = await f.run({ kind: 'click', target: 'e1_0' });
  if (held.state !== 'held') throw Error('expected_hold'); f.approve(held.action);
  expect((await f.work.resume(held.action)).state).toBe('ok'); expect(f.denied).toBe(1);
  expect(f.server.received.filter(row => row.path === '/message')).toHaveLength(1);
});

test('unknown host semantics refuse before physical input instead of creating an approval for an unknown payload', async () => {
  const f = await setup(); f.unknown = true;
  expect(await f.run({ kind: 'click', target: 'e1_0' })).toEqual({ state: 'unsupported', code: 'intent_unsupported' });
  expect(f.physical).toBe(0); expect(f.server.received.filter(row => row.path === '/not-reviewed')).toHaveLength(0);
});

for (const kind of ['resource', 'recipient'] as const) test(`${kind} revocation during the pre-input wait prevents every effect byte`, async () => {
  const f = await setup(), release = Promise.withResolvers<void>(); f.before = release.promise;
  const pending = f.run({ kind: 'click', target: 'e1_0' }); await f.entered;
  f.catalog.get(kind + ':' + (kind === 'resource' ? 'account' : 'payee'))!.active = false; release.resolve();
  expect((await pending).state).not.toBe('ok'); expect(f.physical).toBe(0); expect(f.server.received.filter(row => row.path === '/message')).toHaveLength(0);
});

test('cancel and expiry settle the intended input without dispatching or reconstructing it', async () => {
  for (const mode of ['cancel', 'timeout']) {
    const f = await setup(), stop = new AbortController(); f.never = true;
    const pending = f.run({ kind: 'click', target: 'e1_0' }, stop.signal); await f.entered;
    if (mode === 'cancel') stop.abort(); else f.timeout();
    expect((await pending).state).not.toBe('ok'); await f.work.settled();
    expect(f.server.received.filter(row => row.path === '/message')).toHaveLength(0);
    expect((await f.work.execute({ kind: 'read', generation: f.work.state().generation })).state).toBe('observed');
  }
});
