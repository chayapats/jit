import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { createHostCredentialLifecycle, hostCapabilities } from 'schway/host';
import { openModelService, type ApprovedModelRoute, type ModelOptions, type ModelStepInput } from '../src/s15/model';
import { modelWorkFixture } from './fixtures/s15-model-work';
import { ROUTE_MODEL, routeTransport } from './fixtures/s15-route-transport';

// MODEL15-03 (#381): an uncached listing first renews the route credential without inference (schway#455),
// through one credential lifecycle shared with the step's route host. Scripted transports only; no network.
const cleanups: (() => unknown)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const step = (stepId = 'step'): ModelStepInput => ({ stepId, difficulty: 'ordinary', text: 'Complete the selected issue within its scope.', ownerDecisions: ['Work only on issue #42.'], sources: [] });

function setup(transport: ReturnType<typeof routeTransport>, extra: Partial<ModelOptions> = {}, charge: ApprovedModelRoute['charge'] = 'subscription') {
  const f = modelWorkFixture(); cleanups.push(() => f.cleanup());
  for (const row of f.routes) { row.provider = 'grok'; row.charge = charge; }
  f.routes[0]!.modelId = ROUTE_MODEL.grok;
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
