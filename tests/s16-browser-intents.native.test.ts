import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import type { BrowserInputSnapshot, BrowserObservation, BrowserOperation, BrowserResult } from '../src/s15/browser';
import { browserFixture, browserSite } from './fixtures/s15-browser';

const native = process.env.JIT_BROWSER_LIVE === '1' ? test : test.skip;
const observation = (result: BrowserResult): BrowserObservation => { if (result.state !== 'observed') throw Error(JSON.stringify(result)); return result.observation; };

native('concurrent owner views keep current-document control IDs usable until takeover', async () => {
  const server = browserSite(), f = await browserFixture('general', server.site);
  try {
    expect((await f.work.execute({ kind: 'navigate', url: server.origin + '/login', generation: f.work.state().generation })).state).toBe('ok');
    const owner = await f.gateway.owner.takeover(f.owner);
    const [first, second] = await Promise.all([f.gateway.owner.controls(f.owner, owner.generation), f.gateway.owner.controls(f.owner, owner.generation)]);
    expect(first).toEqual(second);
    expect(await f.gateway.owner.controls(f.owner, owner.generation)).toEqual(first);
    const password = first.find(control => control.kind === 'password'); if (!password) throw Error('password_control_missing');
    await f.gateway.owner.input(f.owner, owner.generation, { kind: 'type', field: password.id, value: server.password() });
    const next = await f.gateway.owner.takeover(f.owner, owner.generation);
    const fresh = await f.gateway.owner.controls(f.owner, next.generation); expect(fresh.map(control => control.id)).not.toContain(password.id);
    await expect(f.gateway.owner.input(f.owner, next.generation, { kind: 'type', field: password.id, value: server.password() })).rejects.toMatchObject({ code: 'stale_target' });
    expect(server.attempts()).toEqual({ login: 0, verification: 0 });
  } finally { await f.cleanup(); server.close(); }
}, 60000);

async function scenario(mode: 'fetch' | 'xhr' | 'double' | 'tamper') {
  const server = browserSite({ asyncIntent: mode }), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  server.beforeResponse = async path => { if (path === '/dynamic-intent-ready') { entered.resolve(); await release.promise; } };
  const urls: string[] = [];
  const site = { ...server.site, observable(url: string, mode: 'static' | 'general') { urls.push(url); return server.site.observable(url, mode); }, intent(input: Readonly<BrowserInputSnapshot>) {
    if (input.kind !== 'click' || input.url !== server.origin + '/dynamic' || input.target.name !== 'xhr') return null;
    const fields = new Map(input.fields.map(field => [field.name, field.values]));
    if (fields.size !== input.fields.length || fields.size !== 2 || fields.get('recipient')?.length !== 1 || fields.get('message')?.length !== 1) return null;
    const recipient = fields.get('recipient')![0]!, message = fields.get('message')![0]!;
    if (!['team', 'support'].includes(recipient)) return null;
    return { method: 'POST', url: server.origin + '/dynamic-send', contentType: 'application/x-www-form-urlencoded;charset=UTF-8', bodyBase64: Buffer.from(new URLSearchParams({ recipient, message }).toString()).toString('base64'), navigation: false };
  } };
  const f = await browserFixture('general', site);
  const run = (input: { kind: 'navigate'; url: string } | { kind: 'read' | 'screenshot' } | { kind: 'click'; target: string } | { kind: 'type'; target: string; value: string }) => f.work.execute({ ...input, generation: f.work.state().generation } as BrowserOperation);
  const navigate = async (path: string) => { expect((await run({ kind: 'navigate', url: server.origin + path })).state).toBe('ok'); };
  const find = async (name: string) => { const data = observation(await run({ kind: 'read' })); const target = data.elements.find(element => element.name === name); if (!target) throw Error('missing_target_' + name); return target.id; };
  try {
    await navigate('/login'); expect((await run({ kind: 'read' })).state).toBe('denied');
    const owner = await f.gateway.owner.takeover(f.owner);
    for (const field of ['password', 'otp'] as const) {
      await f.gateway.owner.input(f.owner, owner.generation, { kind: 'type', field, value: field === 'password' ? server.password() : server.code() });
      await f.gateway.owner.input(f.owner, owner.generation, { kind: 'click', field: 'confirm' });
    }
    f.gateway.owner.handBack(f.owner, owner.generation); expect(await f.gateway.owner.checkSession(f.owner)).toBe('signed_in');
    await navigate('/dynamic');
  } catch (error) {
    release.resolve(); await f.cleanup(); server.close(); throw error;
  }
  return { server, f, run, find, urls, entered: entered.promise, release: () => release.resolve(), async close() { release.resolve(); await f.cleanup(); server.close(); } };
}

for (const transport of ['fetch', 'xhr', 'double'] as const) native(`actual ${transport} waits for the pre-input intent, holds exact bytes and dispatches once`, async () => {
  const s = await scenario(transport);
  try {
    expect((await s.run({ kind: 'type', target: await s.find('message'), value: 'Edited asynchronous record' })).state).toBe('ok');
    let returned = false; const pending = s.run({ kind: 'click', target: await s.find('xhr') }); void pending.then(() => { returned = true; });
    await s.entered; expect(returned).toBe(false); expect(s.server.received.filter(row => row.path === '/dynamic-send')).toHaveLength(0);
    s.release(); const held = await pending; expect(held.state).toBe('held'); if (held.state !== 'held') throw Error('expected_hold');
    const action = s.f.service.owner.inspect(s.f.owner, held.action).action;
    expect(action.payload).toMatchObject({ method: 'POST', navigation: false, bodyBase64: Buffer.from('recipient=team&message=Edited+asynchronous+record').toString('base64') });
    expect(JSON.stringify(action)).not.toContain(s.server.password()); expect(readFileSync(s.f.path).includes(Buffer.from(s.server.password()))).toBe(false);
    s.f.approve(held.action); expect((await s.f.work.resume(held.action)).state).toBe('ok');
    const received = s.server.received.filter(row => row.path === '/dynamic-send'); expect(received).toHaveLength(1); expect(received[0]!.body).toBe('recipient=team&message=Edited+asynchronous+record');
    expect((await s.f.work.resume(held.action)).state).toBe('unsupported');
  } finally { await s.close(); }
}, 60000);

native('a recipient substituted after input selection cannot produce a request or an approval', async () => {
  const s = await scenario('tamper');
  try {
    const pending = s.run({ kind: 'click', target: await s.find('xhr') }); await s.entered; s.release();
    expect(await pending).toEqual({ state: 'unsupported', code: 'intent_request_changed' });
    expect(s.server.received.filter(row => row.path === '/dynamic-send')).toHaveLength(0); expect(s.f.work.state().reconciliation).toBeNull();
  } finally { await s.close(); }
}, 60000);

native('SPA observations bind the actual safe route and refuse text and screenshots of a secret route', async () => {
  const s = await scenario('fetch');
  try {
    expect((await s.run({ kind: 'click', target: await s.find('route_next') })).state).toBe('ok');
    expect({ result: await s.run({ kind: 'read' }), urls: s.urls }).toMatchObject({ result: { state: 'observed', observation: { url: s.server.origin + '/dynamic-next' } } });
    expect((await s.run({ kind: 'screenshot' })).state).toBe('image');
    expect((await s.run({ kind: 'click', target: await s.find('route_secret') })).state).toBe('ok');
    for (const kind of ['read', 'screenshot'] as const) expect(await s.run({ kind })).toEqual({ state: 'denied', code: 'secret_boundary' });
  } finally { await s.close(); }
}, 60000);

native('completed Bot leases release during real owner input and a waiting session probe without losing custody', async () => {
  const s = await scenario('fetch');
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  try {
    expect((await s.run({ kind: 'navigate', url: s.server.origin + '/login' })).state).toBe('ok');
    const owner = await s.f.gateway.owner.takeover(s.f.owner), before = s.f.gateway.owner.state(s.f.owner);
    s.f.work.release(); expect(s.f.gateway.owner.state(s.f.owner)).toEqual(before);
    const controls = await s.f.gateway.owner.controls(s.f.owner, owner.generation), password = controls.find(control => control.kind === 'password');
    if (!password) throw Error('password_control_missing');
    await s.f.gateway.owner.input(s.f.owner, owner.generation, { kind: 'type', field: password.id, value: s.server.password() });
    const handBack = s.f.gateway.owner.handBack(s.f.owner, owner.generation);
    const waitingWork = s.f.gateway.open(s.f.admit({ access: 'effect', readLimit: 1000 }).actor!);
    s.server.beforeResponse = async path => { if (path === '/session') { entered.resolve(); await release.promise; } };
    const probe = s.f.gateway.owner.checkSession(s.f.owner); await entered.promise;
    waitingWork.release(); expect(s.f.gateway.owner.state(s.f.owner).generation).toBe(handBack.generation);
    release.resolve(); expect(await probe).toBe('signed_in');
    const next = s.f.gateway.open(s.f.admit({ access: 'effect', readLimit: 1000 }).actor!);
    try { expect((await next.execute({ kind: 'navigate', url: s.server.origin + '/dynamic', generation: next.state().generation })).state).toBe('ok'); expect((await next.execute({ kind: 'read', generation: next.state().generation })).state).toBe('observed'); }
    finally { next.release(); }
  } finally { release.resolve(); await s.close(); }
}, 60000);
