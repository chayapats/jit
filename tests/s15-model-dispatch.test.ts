import { afterEach, expect, test } from 'bun:test';
import { mkdirSync } from 'node:fs';
import { createHost, createHostCredentialLifecycle, HostError, hostCapabilities, isDispatchRefused, listRouteModels, type HostDispatch, type HostModelChoice, type Model, type ModelCallOptions } from 'schway/host';
import { AppError } from '../src/errors';
import { openModelService, routeControls, type ApprovedModelRoute, type ModelOptions, type ModelStepHooks, type ModelStepInput } from '../src/s15/model';
import { modelWorkFixture } from './fixtures/s15-model-work';
import { ROUTE_MODEL, routeTransport, sha256 } from './fixtures/s15-route-transport';

// MODEL15-02 (#372): every physical provider send goes through Schway's public `authorizeDispatch`, with
// catalog-backed exact effort pins and metered output caps. Scripted transports only; no network or account.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const step = (stepId = 'step'): ModelStepInput => ({ stepId, difficulty: 'ordinary', text: 'Complete the selected issue within its scope.', ownerDecisions: ['Work only on issue #42.'], sources: [] });
const GROK_DEFAULT_CAP = 16384;
/** Fresh public host directories under a fixture root. */
const dirs = (root: string) => { for (const part of ['w', 'h', 's']) mkdirSync(`${root}/${part}`, { recursive: true }); return { workspaceRoot: `${root}/w`, homeDirectory: `${root}/h`, sessionDirectory: `${root}/s` }; };

function setup(route: 'grok' | 'codex', charge: ApprovedModelRoute['charge'], transport: ReturnType<typeof routeTransport> | null, extra: Partial<ModelOptions> = {}, fixture: Parameters<typeof modelWorkFixture>[0] = {}) {
  const f = modelWorkFixture(fixture); cleanups.push(() => f.cleanup());
  for (const row of f.routes) { row.provider = route; row.charge = charge; }
  f.routes[0]!.modelId = ROUTE_MODEL[route];
  const source = f.source('source');
  const service = openModelService({ ...f.modelOptions(), guardWork: workId => { f.policy.work.guard(f.policy.control.bindWork(workId)); },
    // Backoff waits complete instantly; the listing deadline (10000 ms) only ends on abort.
    clock: { ...f.clock, async sleep(ms, signal) { if (ms >= 10000) return f.clock.sleep(ms, signal); f.advance(ms); } },
    ...(transport ? { routeAuth: { store: transport.store, fetch: transport.fetch } } : {}), ...extra });
  cleanups.push(() => service.close());
  return { f, source, service };
}
const body = (text: string) => JSON.parse(text) as { reasoning?: { effort?: string }; max_output_tokens?: number };

test('capabilities: the pinned Schway advertises dispatch authorization, provider requests, effort and output caps', () => {
  const capabilities = hostCapabilities();
  expect(capabilities.releaseContract).toBe('schway.host.release/v2');
  expect([capabilities.dispatchAuthorizationContract, capabilities.providerRequestsContract, capabilities.effortContract, capabilities.outputCapContract])
    .toEqual(['schway.host.dispatch-authorization/v1', 'schway.host.provider-requests/v1', 'schway.host.effort/v1', 'schway.host.output-cap/v1']);
});

test('HostDispatch and providerRequests: initial send and Grok 401 auth-retry each pass the authorizer and their own reservation', async () => {
  const t = routeTransport('grok', { responses: [401, 'ok'] }), { f, source, service } = setup('grok', 'metered', t);
  const record = await service.runStep(source.actor!, step());
  expect(record).toMatchObject({ state: 'completed', code: null });
  // Exactly two inference requests (initial + resend) and one renewal left the process; the body was resent unchanged.
  expect(t.bodies).toHaveLength(2); expect(t.renewals).toHaveLength(1); expect(t.bodies[1]).toBe(t.bodies[0]!);
  expect(body(t.bodies[0]!).reasoning?.effort).toBe('low'); expect(body(t.bodies[0]!).max_output_tokens).toBe(GROK_DEFAULT_CAP);
  // The recorded HostDispatch evidence equals the exact transported bytes, per physical send.
  const dispatch = (kind: HostDispatch['kind'], sequence: number, index: number) => ({ reservationId: record.reservations[index]!, kind, sequence, bodySha256: sha256(t.bodies[index]!), bodyBytes: Buffer.byteLength(t.bodies[index]!),
    effort: { requested: 'low' as const, sent: 'low' }, outputCap: { sent: GROK_DEFAULT_CAP }, authorizedAt: f.now });
  expect(record.physicalDispatches).toEqual([dispatch('initial', 1, 0), dispatch('auth-retry', 2, 1)]);
  // The wrapper forwarded `call` unchanged, so Schway's exact counts and per-attempt evidence are non-null.
  expect(record.providerRequests).toEqual({ initialSends: 1, authRetrySends: 1, renewalRequests: 1 });
  expect(record.effort.attempts).toEqual([{ requested: 'low', sent: 'low', reported: null }]);
  expect(record.controls).toEqual({ effort: { level: 'low', sent: 'low', evidence: 'account-catalog' }, maxOutputTokens: GROK_DEFAULT_CAP, cost: 'configured_upper_bound' });
  const reservations = f.policy.control.reservations(source.authority!.id);
  expect(reservations.map(r => [r.transportSettled, r.actual.calls, r.actual.attempts])).toEqual([[true, 1, 1], [true, 1, 1]]);
  expect(record.usage.calls).toBe(2);
});

test('with one capacity slot a Grok 401 auth-retry still resends: the rejected send settles before the resend reserves', async () => {
  const t = routeTransport('grok', { responses: [401, 'ok'] }), { f, source, service } = setup('grok', 'metered', t, {}, { concurrency: 1 });
  const record = await service.runStep(source.actor!, step());
  expect(record).toMatchObject({ state: 'completed', code: null });
  expect(t.bodies).toHaveLength(2); expect(record.physicalDispatches!.map(d => d.kind)).toEqual(['initial', 'auth-retry']);
  // Both charges stay nonrefundable: two settled reservations, one call each.
  expect(f.policy.control.reservations(source.authority!.id).map(r => [r.transportSettled, r.actual.calls])).toEqual([[true, 1], [true, 1]]);
});

test('a cancelled step aborts its held catalog request instead of leaving it in flight', async () => {
  const t = routeTransport('grok'); let catalogSignal: AbortSignal | null = null;
  const held: typeof t.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (!url.startsWith('https://api.x.ai/v1/models')) return t.fetch(input, init);
    catalogSignal = init?.signal ?? null;
    return new Promise<Response>((_, reject) => { init?.signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); });
  };
  const { source, service } = setup('grok', 'metered', { ...t, fetch: held } as unknown as ReturnType<typeof routeTransport>);
  const controller = new AbortController(), running = service.runStep(source.actor!, step(), controller.signal);
  for (let i = 0; i < 50 && !catalogSignal; i++) await Bun.sleep(5);
  expect(catalogSignal).not.toBeNull(); controller.abort();
  const record = await running;
  expect(record.code).toBe('cancelled'); expect(catalogSignal!.aborted).toBe(true); expect(t.bodies).toHaveLength(0);
});

test('an exhausted call allowance at the auth-retry refuses the resend: auth_retry_refused, refused evidence, no retry', async () => {
  let calls = 0; const hooks: ModelStepHooks = { beforeCall() { if (++calls > 1) throw new AppError('budget_exhausted'); } };
  const t = routeTransport('grok', { responses: [401, 'ok', 'ok'] }), { f, source, service } = setup('grok', 'metered', t, { limits: { turns: 4, attempts: 3, activeMs: 10000, outputBytes: 10000, contextWindow: 32768, inputChars: 65536 } });
  const record = await service.runStep(source.actor!, step(), undefined, hooks);
  // The renewal happened, but the refused resend never left the process and Schway did not retry it.
  expect(t.bodies).toHaveLength(1); expect(t.renewals).toHaveLength(1); expect(calls).toBe(2);
  // Distinct from a real exhausted allowance: the refused resend is recorded with its own cause and no reservation.
  expect(record).toMatchObject({ state: 'reconcile_only', code: 'auth_retry_refused', output: null });
  expect(record.physicalDispatches!.map(d => [d.kind, d.sequence, d.reservationId === null, d.refusal ?? null]))
    .toEqual([['initial', 1, false, null], ['auth-retry', 2, true, 'budget_exhausted']]);
  expect(record.physicalDispatches![1]!.bodySha256).toBe(sha256(t.bodies[0]!));
  expect(record.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 1 });
  expect(f.policy.control.reservations(source.authority!.id)).toHaveLength(1);
});

test('a claim revoked between plan and dispatch is refused inside authorizeDispatch and sends nothing', async () => {
  const t = routeTransport('grok'), { f, source, service } = setup('grok', 'metered', t);
  let revoked = false;
  // The revocation lands in the adapter's own pre-send credential read, after Jit's stream pre-check.
  t.onFirstReadAfterCatalog(() => { f.policy.owner.revoke(f.owner, 'revoke_dispatch', { kind: 'work', id: source.authority!.id }); revoked = true; });
  const record = await service.runStep(source.actor!, step());
  expect(revoked).toBe(true); expect(t.bodies).toHaveLength(0);
  expect(record.session).not.toBeNull(); expect(record.reservations).toEqual([]);
  expect(record.physicalDispatches).toEqual([expect.objectContaining({ kind: 'initial', sequence: 1, reservationId: null, refusal: 'authority_revoked' })]);
  // The route model saw the call (counts are exact, not null) and nothing was sent or counted.
  expect(record.providerRequests).toEqual({ initialSends: 0, authRetrySends: 0, renewalRequests: 0 });
  expect(record).toMatchObject({ state: 'failed', code: 'authority_revoked', output: null });
  expect(f.policy.control.reservations(source.authority!.id)).toEqual([]);
});

test('effort: a listed level is pinned exactly; an unlisted level is refused before any inference I/O', async () => {
  const t = routeTransport('grok', { levels: ['high'] }), { f, source, service } = setup('grok', 'subscription', t);
  const record = await service.runStep(source.actor!, step());
  expect(record).toMatchObject({ state: 'failed', code: 'effort_unsupported', controls: null, physicalDispatches: [], reservations: [] });
  expect(t.catalogs).toHaveLength(1); expect(t.bodies).toHaveLength(0);
  expect(f.policy.control.reservations()).toEqual([]);
});

test('catalogModel: choices are cached per process and owner, and an observed sign-in re-lists', async () => {
  const t = routeTransport('grok'), { source, service } = setup('grok', 'subscription', t);
  const first = await service.runStep(source.actor!, step('one'));
  expect(first).toMatchObject({ state: 'completed', controls: { effort: { level: 'low', sent: 'low', evidence: 'account-catalog' }, maxOutputTokens: null, cost: 'cost_bound_unknown' } });
  expect(first.physicalDispatches!.map(d => d.effort)).toEqual([{ requested: 'low', sent: 'low' }]);
  expect(await service.runStep(source.actor!, step('two'))).toMatchObject({ state: 'completed' });
  expect(t.catalogs).toHaveLength(1);
  // An observed sign-in to an account with other levels drops the cache; the next step lists that account.
  t.levels = ['high']; service.forgetRouteCatalog('grok');
  expect(await service.runStep(source.actor!, step('three'))).toMatchObject({ state: 'failed', code: 'effort_unsupported' });
  expect(t.catalogs).toHaveLength(2); expect(t.bodies).toHaveLength(2);
});

test('public contract: catalogModel must come from the same credential owner; no catalogModel plus thinking is refused before I/O', async () => {
  const listedBy = routeTransport('grok'), other = routeTransport('grok'), f = modelWorkFixture(); cleanups.push(() => f.cleanup());
  const listing = await listRouteModels({ route: 'grok', store: listedBy.store, fetch: listedBy.fetch });
  if (listing.status !== 'listed') throw new Error('fixture listing failed');
  const choice: HostModelChoice = listing.models.find(model => model.id === ROUTE_MODEL.grok)!;
  expect(choice.effort).toEqual({ levels: ['low', 'high'], offSendable: false, default: null, evidence: 'account-catalog' });
  expect(choice.outputCap).toEqual({ enforced: true, default: GROK_DEFAULT_CAP, maximum: GROK_DEFAULT_CAP });
  const host = (transport: ReturnType<typeof routeTransport>) => createHost({ ...dirs(`${f.root}/${crypto.randomUUID()}`),
    context: { policy: 'strict', systemPrompt: 'fixture', sections: [] }, tools: { policy: 'exact', definitions: [], hostedLookup: 'off' },
    limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 1, contextWindow: 4096, maxInputChars: 1024 }, auth: { route: 'grok', model: ROUTE_MODEL.grok, store: transport.store, fetch: transport.fetch } });
  const foreign = await host(other);
  try { await expect(foreign.auth!.createModel({ catalogModel: choice, effort: { level: 'low', mode: 'exact' } })).rejects.toBeInstanceOf(HostError); }
  finally { await foreign.close(); }
  const own = await host(listedBy);
  try {
    await expect(own.auth!.createModel({ catalogModel: choice, effort: { level: 'off', mode: 'exact' } })).rejects.toBeInstanceOf(HostError);
    const unpinned = await own.auth!.createModel();
    const drain = async () => { for await (const _event of unpinned.stream({ systemPrompt: 'fixture', context: [], items: [{ type: 'user', id: 'u', content: [{ type: 'text', text: 'hi' }] }], thinking: 'low' })) { /* drain */ } };
    await expect(drain()).rejects.toThrow();
    expect(listedBy.bodies).toHaveLength(0);
  } finally { await own.close(); }
});

test('output cap: Codex subscription pins no cap and stays cost_bound_unknown; Codex metered is refused before I/O', async () => {
  const t = routeTransport('codex'), { service, source } = setup('codex', 'subscription', t);
  const record = await service.runStep(source.actor!, step());
  expect(record).toMatchObject({ state: 'completed', controls: { maxOutputTokens: null, cost: 'cost_bound_unknown' }, providerRequests: { initialSends: 1, authRetrySends: 0, renewalRequests: 0 } });
  expect(record.physicalDispatches).toEqual([expect.objectContaining({ kind: 'initial', sequence: 1, bodySha256: sha256(t.bodies[0]!), outputCap: { sent: null }, effort: { requested: 'low', sent: 'low' } })]);
  expect(body(t.bodies[0]!).max_output_tokens).toBeUndefined(); expect(body(t.bodies[0]!).reasoning?.effort).toBe('low');
  const metered = routeTransport('codex'), refused = setup('codex', 'metered', metered);
  expect(await refused.service.runStep(refused.source.actor!, step())).toMatchObject({ state: 'failed', code: 'cost_bound_unknown', reservations: [] });
  expect(metered.bodies).toHaveLength(0);
});

test('output cap: a metered Grok route sends and requires its configured cap, never above the listed maximum', async () => {
  for (const [configured, sent] of [[2048, 2048], [999999, GROK_DEFAULT_CAP]] as const) {
    const t = routeTransport('grok'), { f, source, service } = setup('grok', 'metered', t); f.routes[0]!.maxOutputTokens = configured;
    const record = await service.runStep(source.actor!, step());
    expect(record).toMatchObject({ state: 'completed', controls: { maxOutputTokens: sent, cost: 'configured_upper_bound' } });
    expect(record.physicalDispatches!.map(d => d.outputCap.sent)).toEqual([sent]); expect(body(t.bodies[0]!).max_output_tokens).toBe(sent);
  }
  const choice = (enforced: boolean): HostModelChoice => ({ id: ROUTE_MODEL.grok, recommended: true, effort: { levels: ['low'], offSendable: false, default: null, evidence: 'account-catalog' }, outputCap: enforced ? { enforced, default: 100, maximum: 200 } : { enforced, default: null, maximum: null } });
  const g = modelWorkFixture(); cleanups.push(() => g.cleanup());
  const route: ApprovedModelRoute = { ...structuredClone(g.routes[0]!), modelId: ROUTE_MODEL.grok, provider: 'grok' };
  expect(() => routeControls({ ...route, charge: 'metered' }, choice(false))).toThrow('cost_bound_unknown');
  expect(routeControls({ ...route, charge: 'metered' }, choice(true)).maxOutputTokens).toBe(100);
  expect(routeControls({ ...route, charge: 'subscription' }, choice(true))).toEqual({ effort: { level: 'low', sent: 'low', evidence: 'account-catalog' }, maxOutputTokens: null, cost: 'cost_bound_unknown' });
  expect(() => routeControls({ ...route, charge: 'subscription' }, { ...choice(true), effort: { levels: ['low'], offSendable: false, default: null, evidence: 'none' } })).toThrow('effort_unsupported');
});

test('providerRequests: concurrent steps sharing a credential lifecycle count one shared renewal exactly once', async () => {
  const renewing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), joined = Promise.withResolvers<void>();
  const t = routeTransport('grok', { responses: [401, 'ok', 'ok'], renewal: async () => { renewing.resolve(); await release.promise; } });
  const lifecycle = createHostCredentialLifecycle({ store: t.store });
  const f = modelWorkFixture(); cleanups.push(() => f.cleanup());
  for (const row of f.routes) { row.provider = 'grok'; row.charge = 'subscription'; } f.routes[0]!.modelId = ROUTE_MODEL.grok;
  const a = f.source('a'), b = f.source('b');
  const service = openModelService({ ...f.modelOptions(), clock: { ...f.clock, async sleep(ms, signal) { if (ms >= 10000) return f.clock.sleep(ms, signal); f.advance(ms); } }, routeAuth: { lifecycle, fetch: t.fetch } });
  cleanups.push(() => service.close());
  // A's initial send is rejected and A starts the lifecycle's renewal; B (reusing A's cached catalog choice)
  // then reads credentials while that renewal is in flight.
  const first = service.runStep(a.actor!, step('a'));
  await renewing.promise;
  t.onNextRead(() => joined.resolve());
  const second = service.runStep(b.actor!, step('b'));
  await joined.promise; release.resolve();
  const [one, two] = await Promise.all([first, second]);
  expect([one.state, two.state]).toEqual(['completed', 'completed']);
  expect(t.renewals).toHaveLength(1); expect(t.bodies).toHaveLength(3);
  // The run that started the renewal counts it; the sibling counts zero, so summing never double-counts.
  expect(one.providerRequests).toEqual({ initialSends: 1, authRetrySends: 1, renewalRequests: 1 });
  expect(two.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 0 });
  expect(one.physicalDispatches!.map(d => d.kind)).toEqual(['initial', 'auth-retry']); expect(two.physicalDispatches!.map(d => d.kind)).toEqual(['initial']);
  expect(t.catalogs).toHaveLength(1);
  await lifecycle.close();
});

test('wrapper rule (public contract): forwarding `call` keeps exact counts; picking its fields makes them null', async () => {
  const f = modelWorkFixture(); cleanups.push(() => f.cleanup());
  const run = async (forward: (call: ModelCallOptions | undefined) => ModelCallOptions | undefined) => {
    const t = routeTransport('grok'), root = `${f.root}/${crypto.randomUUID()}`;
    const host = await createHost({ ...dirs(root),
      context: { policy: 'strict', systemPrompt: 'fixture', sections: [] }, tools: { policy: 'exact', definitions: [], hostedLookup: 'off' },
      limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 1, contextWindow: 4096, maxInputChars: 1024 }, auth: { route: 'grok', model: ROUTE_MODEL.grok, store: t.store, fetch: t.fetch } });
    try {
      const authorized: HostDispatch[] = [], route = await host.auth!.createModel({ authorizeDispatch: dispatch => { authorized.push(dispatch); } });
      const wrapper: Model = { provider: route.provider, id: route.id, stream: (request, call) => route.stream(request, forward(call)) };
      const session = await host.createSession();
      try { const result = await session.submit({ text: 'hi' }, wrapper); return { result, authorized }; }
      finally { await session.close(); }
    } finally { await host.close(); }
  };
  const forwarded = await run(call => call);
  expect(forwarded.result.outcome).toBe('completed'); expect(forwarded.authorized).toHaveLength(1);
  expect(forwarded.result.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 0, renewalRequests: 0 });
  expect(forwarded.result.usage.attempts[0]!.effort).not.toBeNull();
  const picked = await run(call => (call?.promptCacheKey ? { promptCacheKey: call.promptCacheKey } : {}));
  expect(picked.result.outcome).toBe('completed'); expect(picked.authorized).toHaveLength(1);
  expect(picked.result.usage.providerRequests).toBeNull(); expect(picked.result.usage.attempts[0]!.effort).toBeNull();
});

test('refusal identity: a thrown authorizer error is chained as cause, recognized by identity, never by copied wording', async () => {
  const t = routeTransport('grok'), f = modelWorkFixture(); cleanups.push(() => f.cleanup());
  const host = await createHost({ ...dirs(`${f.root}/${crypto.randomUUID()}`),
    context: { policy: 'strict', systemPrompt: 'fixture', sections: [] }, tools: { policy: 'exact', definitions: [], hostedLookup: 'off' },
    limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 1, contextWindow: 4096, maxInputChars: 1024 }, auth: { route: 'grok', model: ROUTE_MODEL.grok, store: t.store, fetch: t.fetch } });
  try {
    const own = new AppError('policy_revoked'), model = await host.auth!.createModel({ authorizeDispatch: () => { throw own; } });
    let caught: unknown;
    try { for await (const _event of model.stream({ systemPrompt: 'fixture', context: [], items: [{ type: 'user', id: 'u', content: [{ type: 'text', text: 'hi' }] }] })) { /* drain */ } }
    catch (error) { caught = error; }
    expect(isDispatchRefused(caught)).toBe(true); expect((caught as Error).cause).toBe(own); expect(t.bodies).toHaveLength(0);
    expect(isDispatchRefused(new Error((caught as Error).message))).toBe(false); expect(isDispatchRefused(new Error('wrapped', { cause: caught }))).toBe(false);
  } finally { await host.close(); }
});

test('B1 expiry: a cached choice completes through renewal after the access token expires', async () => {
  const t = routeTransport('grok'), { source, service } = setup('grok', 'subscription', t);
  expect(await service.runStep(source.actor!, step('one'))).toMatchObject({ state: 'completed' });
  t.expire();
  const record = await service.runStep(source.actor!, step('two'));
  expect(record).toMatchObject({ state: 'completed', code: null, providerRequests: { initialSends: 1, authRetrySends: 0, renewalRequests: 1 } });
  expect(t.catalogs).toHaveLength(1); expect(t.renewals).toHaveLength(1); expect(t.bodies).toHaveLength(2);
});

test('B1 status: an unavailable secure store surfaces route_store_unavailable, not route_unavailable', async () => {
  const t = routeTransport('grok'); t.readsFail = true;
  const { source, service } = setup('grok', 'subscription', t);
  expect(await service.runStep(source.actor!, step())).toMatchObject({ state: 'failed', code: 'route_store_unavailable' });
  expect(t.bodies).toHaveLength(0);
});

test('B1 provider rejection: a rejected resend surfaces the route status and drops the cached catalog', async () => {
  const t = routeTransport('grok', { responses: [401, 401, 'ok'] }), { f, source, service } = setup('grok', 'subscription', t);
  const rejected = await service.runStep(source.actor!, step('one'));
  expect(rejected.state).toBe('reconcile_only'); expect(['route_rejected', 'route_needs_login']).toContain(rejected.code!);
  expect(rejected.physicalDispatches!.map(d => d.kind)).toEqual(['initial', 'auth-retry']);
  service.reconcile(f.owner, rejected.id);
  expect(await service.runStep(source.actor!, step('two'))).toMatchObject({ state: 'completed' });
  expect(t.catalogs).toHaveLength(2);
});

test('B1 owner binding: after a lifecycle logout and sign-in the cached choice is refused by Schway and listed once more', async () => {
  const t = routeTransport('grok'), lifecycle = createHostCredentialLifecycle({ store: t.store });
  const { source, service } = setup('grok', 'subscription', null, { routeAuth: { lifecycle, fetch: t.fetch } });
  expect(await service.runStep(source.actor!, step('one'))).toMatchObject({ state: 'completed' });
  await lifecycle.logout('grok'); t.signIn();
  // The choice belongs to the previous credential epoch (a foreign owner now): createModel rejects it, Jit re-lists.
  const record = await service.runStep(source.actor!, step('two'));
  expect(record).toMatchObject({ state: 'completed', code: null });
  expect(t.catalogs).toHaveLength(2); expect(t.bodies).toHaveLength(2);
  await lifecycle.close();
});

/** A route model from a separate host, injected through Jit's scripted seam: Jit cannot authorize its sends. */
async function unauthorizedRouteModel(transport: ReturnType<typeof routeTransport>, root: string, options: { effort?: 'low' | 'high'; authorize?: (dispatch: HostDispatch) => void } = {}) {
  const listing = await listRouteModels({ route: 'grok', store: transport.store, fetch: transport.fetch });
  if (listing.status !== 'listed') throw new Error('fixture listing failed');
  const host = await createHost({ ...dirs(root), context: { policy: 'strict', systemPrompt: 'fixture', sections: [] }, tools: { policy: 'exact', definitions: [], hostedLookup: 'off' },
    limits: { maxTurns: 1, maxConcurrentTools: 1, maxAttempts: 1, contextWindow: 4096, maxInputChars: 1024 }, auth: { route: 'grok', model: ROUTE_MODEL.grok, store: transport.store, fetch: transport.fetch } });
  cleanups.push(() => { void host.close(); });
  return host.auth!.createModel({ catalogModel: listing.models.find(m => m.id === ROUTE_MODEL.grok)!, effort: { level: options.effort ?? 'low', mode: 'exact' }, ...(options.authorize ? { authorizeDispatch: options.authorize } : {}) });
}

test('B3 usage_invalid: exact Schway counts that exceed the sends Jit admitted withhold the output', async () => {
  const t = routeTransport('grok', { responses: [401, 'ok'] }), f = modelWorkFixture(); cleanups.push(() => f.cleanup());
  const inner = await unauthorizedRouteModel(t, `${f.root}/inner`);
  const { source, service } = setup('grok', 'subscription', null, { scripted: () => inner });
  const record = await service.runStep(source.actor!, step());
  // Jit admitted one send per stream; Schway counted an initial send and its auth-retry resend.
  expect(record.providerRequests).toEqual({ initialSends: 1, authRetrySends: 1, renewalRequests: 1 });
  expect(record).toMatchObject({ state: 'reconcile_only', code: 'usage_invalid', output: null, reservations: [expect.any(String)] });
});

test('B3 route_control_refused: a body that cannot carry the pinned effort is refused by identity before I/O', async () => {
  const t = routeTransport('grok'), f = modelWorkFixture(); cleanups.push(() => f.cleanup());
  const inner = await unauthorizedRouteModel(t, `${f.root}/inner`, { effort: 'high' });
  const { source, service } = setup('grok', 'subscription', null, { scripted: () => inner });
  expect(await service.runStep(source.actor!, step())).toMatchObject({ state: 'reconcile_only', code: 'route_control_refused', output: null });
  expect(t.bodies).toHaveLength(0);
});

test('B3 dispatch_refused: a refusal that carries no Jit code is still recognized by identity', async () => {
  const t = routeTransport('grok'), f = modelWorkFixture(); cleanups.push(() => f.cleanup());
  const inner = await unauthorizedRouteModel(t, `${f.root}/inner`, { authorize: () => { throw new Error('outside refusal'); } });
  const { source, service } = setup('grok', 'subscription', null, { scripted: () => inner });
  expect(await service.runStep(source.actor!, step())).toMatchObject({ state: 'reconcile_only', code: 'dispatch_refused', output: null });
  expect(t.bodies).toHaveLength(0);
});

test('B3 effort_unproven: a provider-reported applied effort that contradicts the exact pin withholds the output', async () => {
  const t = routeTransport('grok', { reported: 'high' }), { source, service } = setup('grok', 'subscription', t);
  const record = await service.runStep(source.actor!, step());
  expect(record.effort.attempts).toEqual([{ requested: 'low', sent: 'low', reported: 'high' }]);
  expect(record).toMatchObject({ state: 'reconcile_only', code: 'effort_unproven', output: null });
  const agreeing = routeTransport('grok', { reported: 'low' }), ok = setup('grok', 'subscription', agreeing);
  expect(await ok.service.runStep(ok.source.actor!, step())).toMatchObject({ state: 'completed', effort: { attempts: [{ requested: 'low', sent: 'low', reported: 'low' }] } });
});

test('B3 refusal identity through Jit: provider text that copies the refusal wording is never treated as a refusal', async () => {
  const probe = routeTransport('grok'), f = modelWorkFixture(); cleanups.push(() => f.cleanup());
  const refusing = await unauthorizedRouteModel(probe, `${f.root}/probe`, { authorize: () => { throw new Error('probe'); } });
  let wording = '';
  try { for await (const _event of refusing.stream({ systemPrompt: 'fixture', context: [], items: [{ type: 'user', id: 'u', content: [{ type: 'text', text: 'hi' }] }], thinking: 'low' })) { /* drain */ } }
  catch (error) { wording = (error as Error).message; }
  expect(wording.length).toBeGreaterThan(0);
  const t = routeTransport('grok', { responses: [{ status: 400, message: wording }] }), { source, service } = setup('grok', 'subscription', t);
  const record = await service.runStep(source.actor!, step());
  expect(record.code).not.toBe('dispatch_refused'); expect(record.state).toBe('reconcile_only');
  expect(record.physicalDispatches!.map(d => d.refusal ?? null)).toEqual([null]); expect(t.bodies).toHaveLength(1);
});
