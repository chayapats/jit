import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createHostCredentialLifecycle, hostCapabilities } from 'schway/host';
import { AppError } from '../src/errors';
import { openModelService, type ApprovedModelRoute, type ModelOptions, type ModelStepInput } from '../src/s15/model';
import { modelWorkFixture } from './fixtures/s15-model-work';
import { ROUTE_MODEL, routeTransport } from './fixtures/s15-route-transport';

// MODEL15-03 (#381): an uncached listing first renews the route credential without inference (schway#455),
// through one credential lifecycle shared with the step's route host. Scripted transports only; no network.
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const step = (stepId = 'step'): ModelStepInput => ({ stepId, difficulty: 'ordinary', text: 'Complete the selected issue within its scope.', ownerDecisions: ['Work only on issue #42.'], sources: [] });

function setup(transport: ReturnType<typeof routeTransport>, extra: Partial<ModelOptions> = {}, charge: ApprovedModelRoute['charge'] = 'subscription', provider: ApprovedModelRoute['provider'] = 'grok') {
  const f = modelWorkFixture(); cleanups.push(() => f.cleanup());
  for (const row of f.routes) { row.provider = provider; row.charge = charge; }
  f.routes[0]!.modelId = ROUTE_MODEL[provider];
  const source = f.source('source');
  const service = openModelService({ ...f.modelOptions(), guardWork: workId => { f.policy.work.guard(f.policy.control.bindWork(workId)); },
    clock: { ...f.clock, async sleep(ms, signal) { if (ms >= 10000) return f.clock.sleep(ms, signal); f.advance(ms); } },
    routeAuth: { store: transport.store, fetch: transport.fetch }, ...extra });
  return { f, source, service };
}

test('the pinned Schway advertises route renewal', () => {
  expect(hostCapabilities().routeRenewalContract).toBe('schway.host.route-renewal/v1');
});

test('a fresh process with an expired token renews once before listing, then completes the step', async () => {
  const t = routeTransport('grok'); t.expire();
  const { service, source } = setup(t); cleanups.push(() => service.close());
  const record = await service.runStep(source.actor!, step());
  expect(record).toMatchObject({ state: 'completed', code: null, catalogRenewal: { outcome: 'renewed', renewalRequests: 1, status: 'configured-unverified' } });
  // The renewal is the first request: no catalog or inference precedes it, and it is counted once for the step.
  expect(t.log).toEqual(['renewal', 'catalog', 'inference']);
  expect(record.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 1 });
});

test('a valid token renews nothing: fresh, zero token requests', async () => {
  const t = routeTransport('grok'), { service, source } = setup(t); cleanups.push(() => service.close());
  const record = await service.runStep(source.actor!, step());
  expect(record).toMatchObject({ state: 'completed', catalogRenewal: { outcome: 'fresh', renewalRequests: 0 }, providerRequests: { initialSends: 1, authRetrySends: 0, renewalRequests: 0 } });
  expect(t.renewals).toHaveLength(0); expect(t.log).toEqual(['catalog', 'inference']);
  // A later step reuses the cached choice: no renewal call and no catalog request.
  expect(await service.runStep(source.actor!, step('two'))).toMatchObject({ state: 'completed', catalogRenewal: null });
  expect(t.log).toEqual(['catalog', 'inference', 'inference']);
});

for (const [name, prepare, code, requests] of [
  ['no refresh token (needs-login)', (t: ReturnType<typeof routeTransport>) => t.expire({ refresh: false }), 'route_needs_login', 0],
  ['a refused grant (rejected)', (t: ReturnType<typeof routeTransport>) => t.expire(), 'route_rejected', 1],
  ['a rate-limited token endpoint', (t: ReturnType<typeof routeTransport>) => t.expire(), 'quota_exceeded', 1],
  ['an unreachable token endpoint', (t: ReturnType<typeof routeTransport>) => t.expire(), 'route_integration_unavailable', 1],
] as const) test(`a failed renewal after ${name} surfaces ${code} with no catalog or inference`, async () => {
  const response = name.startsWith('a refused') ? { status: 400 } : name.startsWith('a rate') ? { status: 429 } : name.startsWith('an unreachable') ? 'unreachable' as const : 'ok' as const;
  const t = routeTransport('grok', { renewalResponse: response }); prepare(t);
  const { f, service, source } = setup(t); cleanups.push(() => service.close());
  const record = await service.runStep(source.actor!, step());
  expect(record).toMatchObject({ state: 'failed', code, catalogRenewal: { outcome: 'failed', renewalRequests: requests }, providerRequests: { initialSends: 0, authRetrySends: 0, renewalRequests: requests } });
  expect(t.catalogs).toHaveLength(0); expect(t.bodies).toHaveLength(0); expect(f.policy.control.reservations()).toEqual([]);
});

test('a renewal cancelled before its token request reports cancelled and sends nothing', async () => {
  const t = routeTransport('grok'); t.expire();
  const { service, source } = setup(t); cleanups.push(() => service.close());
  const controller = new AbortController();
  t.onNextRead(() => controller.abort());
  const record = await service.runStep(source.actor!, step(), controller.signal);
  expect(record).toMatchObject({ state: 'failed', code: 'cancelled', catalogRenewal: { outcome: 'cancelled', renewalRequests: 0 } });
  expect(t.log).toEqual([]);
});

test('a renewal cancelled after its token request left reports cancelled; shutdown waits for the rotated token', async () => {
  const sent = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const t = routeTransport('grok', { renewal: async () => { sent.resolve(); await release.promise; } }); t.expire();
  const { service, source } = setup(t);
  const controller = new AbortController(), running = service.runStep(source.actor!, step(), controller.signal);
  await sent.promise; controller.abort();
  const record = await running;
  expect(record).toMatchObject({ state: 'failed', code: 'cancelled', catalogRenewal: { outcome: 'cancelled', renewalRequests: 1 } });
  expect(t.log).toEqual(['renewal']);
  // The token request still runs; the service-owned lifecycle reports busy until it is stored, and close retries.
  let closed = false; const closing = service.close().then(() => { closed = true; });
  await Bun.sleep(120); expect(closed).toBe(false);
  release.resolve(); await closing;
  expect(closed).toBe(true); expect(JSON.parse(t.stored()!).refreshToken).toBe('fixture-rotated');
  expect(t.log).toEqual(['renewal']);
});

test('a renewal and a run on one shared lifecycle send one token request, counted once', async () => {
  const renewing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const t = routeTransport('grok', { renewal: async () => { renewing.resolve(); await release.promise; } });
  const lifecycle = createHostCredentialLifecycle({ store: t.store }); cleanups.push(() => lifecycle.close());
  const { f, service, source } = setup(t, { routeAuth: { lifecycle, fetch: t.fetch } }); cleanups.push(() => service.close());
  expect(await service.runStep(source.actor!, step('warm'))).toMatchObject({ state: 'completed' });
  // A second service (a fresh catalog cache) shares the lifecycle; its pre-listing renewal joins the run's renewal.
  const sibling = openModelService({ ...f.modelOptions(), path: join(f.root, 'model-sibling.sqlite'), nativeDirectory: join(f.root, 'native-sibling'),
    clock: { ...f.clock, async sleep(ms, signal) { if (ms >= 10000) return f.clock.sleep(ms, signal); f.advance(ms); } }, routeAuth: { lifecycle, fetch: t.fetch } });
  cleanups.push(() => sibling.close());
  t.expire();
  const run = service.runStep(source.actor!, step('run'));
  await renewing.promise;
  const other = f.source('other'), listing = sibling.runStep(other.actor!, step('listed'));
  await Bun.sleep(50); release.resolve();
  const [ran, listed] = await Promise.all([run, listing]);
  expect([ran.state, listed.state]).toEqual(['completed', 'completed']);
  expect(t.renewals).toHaveLength(1);
  expect(ran.providerRequests!.renewalRequests + listed.providerRequests!.renewalRequests).toBe(1);
  expect(ran.providerRequests!.renewalRequests).toBe(1); expect(listed.catalogRenewal).toMatchObject({ renewalRequests: 0 });
});

test('a choice listed in the same step that Schway rejects is route_choice_refused, keeps its renewal count, and is not re-listed', async () => {
  const t = routeTransport('grok'); t.expire();
  const lifecycle = createHostCredentialLifecycle({ store: t.store }); cleanups.push(() => lifecycle.close());
  const { service, source } = setup(t, { routeAuth: { lifecycle, fetch: t.fetch } }); cleanups.push(() => service.close());
  // While the first listing (after a renewal) is in flight, a logout and a fresh sign-in start a new credential epoch.
  t.onCatalog(async () => { await lifecycle.logout('grok'); t.signIn(); });
  const refused = await service.runStep(source.actor!, step('one'));
  expect(refused).toMatchObject({ state: 'failed', code: 'route_choice_refused', catalogRenewal: { outcome: 'renewed', renewalRequests: 1, attempts: [{ outcome: 'renewed', renewalRequests: 1 }] },
    providerRequests: { initialSends: 0, authRetrySends: 0, renewalRequests: 1 } });
  expect(t.log).toEqual(['renewal', 'catalog']);
  // The rejected listing was dropped, so the next step lists the new epoch and completes.
  expect(await service.runStep(source.actor!, step('two'))).toMatchObject({ state: 'completed', catalogRenewal: { outcome: 'fresh', renewalRequests: 0 } });
  expect(t.log).toEqual(['renewal', 'catalog', 'catalog', 'inference']);
});

test('a cached choice that Schway rejects is listed once more, and the re-list renewal counts for the step', async () => {
  const t = routeTransport('grok'), lifecycle = createHostCredentialLifecycle({ store: t.store }); cleanups.push(() => lifecycle.close());
  const { service, source } = setup(t, { routeAuth: { lifecycle, fetch: t.fetch } }); cleanups.push(() => service.close());
  expect(await service.runStep(source.actor!, step('one'))).toMatchObject({ state: 'completed' });
  await lifecycle.logout('grok'); t.signIn(); t.expire();
  const record = await service.runStep(source.actor!, step('two'));
  expect(record).toMatchObject({ state: 'completed', code: null, catalogRenewal: { outcome: 'renewed', renewalRequests: 1, attempts: [{ outcome: 'renewed', renewalRequests: 1 }] },
    providerRequests: { initialSends: 1, authRetrySends: 0, renewalRequests: 1 } });
  expect(t.log).toEqual(['catalog', 'inference', 'renewal', 'catalog', 'inference']);
});

test('B1: a renewal in flight when the work is cancelled and the service closes still stores the rotated token', async () => {
  const sent = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const t = routeTransport('grok', { rotating: true, renewal: async () => { sent.resolve(); await release.promise; } }); t.expire();
  let closing = false;
  // Wired like the production composition: once closing, work authority refuses with `aborted`.
  const { f, service, source } = setup(t, { guardWork: workId => { if (closing) throw new AppError('aborted'); f.policy.work.guard(f.policy.control.bindWork(workId)); } });
  const controller = new AbortController(), running = service.runStep(source.actor!, step(), controller.signal);
  await sent.promise; controller.abort(); closing = true;
  expect(await running).toMatchObject({ state: 'failed', code: 'cancelled', catalogRenewal: { outcome: 'cancelled', renewalRequests: 1 } });
  const closed = service.close(); release.resolve(); await closed;
  // The credential write fence checks ownership only, so the late write of the rotated grant is kept.
  expect(JSON.parse(t.stored()!)).toMatchObject({ accessToken: 'fixture-renewed-1', refreshToken: 'fixture-rotated-1' });
  // A fresh process renews with the rotated grant: no sign-in is needed (a lost grant would be route_rejected).
  t.expire();
  const next = openModelService({ ...f.modelOptions(), path: join(f.root, 'model-next.sqlite'), nativeDirectory: join(f.root, 'native-next'),
    clock: { ...f.clock, async sleep(ms, signal) { if (ms >= 10000) return f.clock.sleep(ms, signal); f.advance(ms); } }, routeAuth: { store: t.store, fetch: t.fetch } });
  cleanups.push(() => next.close());
  expect(await next.runStep(source.actor!, step('next'))).toMatchObject({ state: 'completed', code: null, catalogRenewal: { outcome: 'renewed', renewalRequests: 1 } });
  expect(JSON.parse(t.stored()!).refreshToken).toBe('fixture-rotated-2');
});

test('Codex: a fresh process with an expired token renews once before listing, then completes', async () => {
  const t = routeTransport('codex'); t.expire();
  const { service, source } = setup(t, {}, 'subscription', 'codex'); cleanups.push(() => service.close());
  const record = await service.runStep(source.actor!, step());
  expect(record).toMatchObject({ state: 'completed', code: null, catalogRenewal: { outcome: 'renewed', renewalRequests: 1 }, providerRequests: { initialSends: 1, authRetrySends: 0, renewalRequests: 1 } });
  expect(t.log).toEqual(['renewal', 'catalog', 'inference']); expect(t.renewals[0]).toContain('auth.openai.com');
});

test('a run that joins an in-flight pre-listing renewal counts 0; one token request in total', async () => {
  const renewing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), joined = Promise.withResolvers<void>();
  const t = routeTransport('grok', { renewal: async () => { renewing.resolve(); await release.promise; } });
  const lifecycle = createHostCredentialLifecycle({ store: t.store }); cleanups.push(() => lifecycle.close());
  const { f, service: runner, source } = setup(t, { routeAuth: { lifecycle, fetch: t.fetch } }); cleanups.push(() => runner.close());
  expect(await runner.runStep(source.actor!, step('warm'))).toMatchObject({ state: 'completed' });
  const lister = openModelService({ ...f.modelOptions(), path: join(f.root, 'model-lister.sqlite'), nativeDirectory: join(f.root, 'native-lister'),
    clock: { ...f.clock, async sleep(ms, signal) { if (ms >= 10000) return f.clock.sleep(ms, signal); f.advance(ms); } }, routeAuth: { lifecycle, fetch: t.fetch } });
  cleanups.push(() => lister.close());
  t.expire();
  // The lister's pre-listing renewal starts first and holds the only token request.
  const other = f.source('other'), listing = lister.runStep(other.actor!, step('listed'));
  await renewing.promise;
  // The runner's cached choice needs no listing; its send reads the expired credential and joins that renewal.
  t.onNextRead(() => joined.resolve());
  const run = runner.runStep(source.actor!, step('run'));
  await joined.promise; release.resolve();
  const [listed, ran] = await Promise.all([listing, run]);
  expect([listed.state, ran.state]).toEqual(['completed', 'completed']);
  expect(t.renewals).toHaveLength(1);
  expect(listed.catalogRenewal).toMatchObject({ outcome: 'renewed', renewalRequests: 1 });
  expect(ran.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 0 });
});

test('a held renewal past its deadline is route_renewal_timeout, keeps its request count, and shutdown waits for it', async () => {
  const sent = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const t = routeTransport('grok', { renewal: async () => { sent.resolve(); await release.promise; } }); t.expire();
  // A 100 ms step bound makes the renewal deadline expire while the token request is held.
  const { service, source } = setup(t, { limits: { turns: 4, attempts: 1, activeMs: 100, outputBytes: 10000, contextWindow: 32768, inputChars: 65536 } });
  const record = await service.runStep(source.actor!, step());
  await sent.promise;
  expect(record).toMatchObject({ state: 'failed', code: 'route_renewal_timeout', catalogRenewal: { outcome: 'limit_exceeded', renewalRequests: 1 }, providerRequests: { initialSends: 0, authRetrySends: 0, renewalRequests: 1 } });
  expect(t.catalogs).toHaveLength(0); expect(t.bodies).toHaveLength(0); expect(t.log).toEqual(['renewal']);
  // The token request still runs; close() retries the lifecycle's busy close until it settles and stores the rotated token.
  let closed = false; const closing = service.close().then(() => { closed = true; });
  await Bun.sleep(120); expect(closed).toBe(false);
  release.resolve(); await closing;
  expect(closed).toBe(true); expect(JSON.parse(t.stored()!).refreshToken).toBe('fixture-rotated');
  expect(t.log).toEqual(['renewal']);
});

test('the credential write fence checks route ownership only', async () => {
  const { routeCredentialGuard } = await import('../src/s15/model');
  const { credentialReferenceForRoute } = await import('schway/host');
  const guard = routeCredentialGuard('grok');
  expect(() => guard(credentialReferenceForRoute('grok'))).not.toThrow();
  expect(() => guard(credentialReferenceForRoute('codex'))).toThrow('credential_owner_mismatch');
});

test('B5: a lifecycle still busy at the bound is reported as credential_close_incomplete, within a bound below the unit stop timeout', async () => {
  const { closeCredentialLifecycle, CREDENTIAL_CLOSE_BOUND_MS } = await import('../src/s15/model');
  const { HostError } = await import('schway/host');
  const unit = await Bun.file(join(import.meta.dir, '../ops/package/installer/s15.ts')).text();
  const stopSeconds = Number(/TimeoutStopSec=(\d+)/.exec(unit)![1]);
  expect(CREDENTIAL_CLOSE_BOUND_MS).toBeLessThanOrEqual(40_000); expect(CREDENTIAL_CLOSE_BOUND_MS).toBeLessThan(stopSeconds * 1000 - 15_000);
  const reported: string[] = []; let attempts = 0;
  const started = performance.now();
  const outcome = await closeCredentialLifecycle({ async close() { attempts++; throw new HostError('busy'); }, async logout() {} }, 150, code => { reported.push(code); });
  expect(outcome).toBe('credential_close_incomplete'); expect(reported).toEqual(['credential_close_incomplete']);
  expect(attempts).toBeGreaterThan(1); expect(performance.now() - started).toBeLessThan(1000);
  expect(await closeCredentialLifecycle({ async close() {}, async logout() {} }, 150, code => { reported.push(code); })).toBe('closed');
  expect(reported).toHaveLength(1);
});
