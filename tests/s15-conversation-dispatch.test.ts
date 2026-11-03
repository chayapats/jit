import { afterEach, expect, test } from 'bun:test';
import { AppError } from '../src/errors';
import { runConversation } from '../src/s15/conversation/schway';
import type { ConversationRequest } from '../src/s15/conversation';
import { modelWorkFixture } from './fixtures/s15-model-work';
import { ROUTE_MODEL, routeTransport, sha256 } from './fixtures/s15-route-transport';

// MODEL15-02 (#372): the plain CHAT runtime authorizes and charges every physical send of its route model.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

function conversation(reserve: (count: number) => void) {
  const f = modelWorkFixture(); cleanups.push(() => f.cleanup());
  const request: ConversationRequest = structuredClone(f.source('source').record);
  request.authority!.route = { provider: 'grok', model: ROUTE_MODEL.grok };
  const reservations: { settled: number }[] = [], guards: string[] = [], usages: unknown[] = [];
  const run = (transport: ReturnType<typeof routeTransport>) => runConversation({ directory: `${f.root}/native`, request, definitions: [], signal: new AbortController().signal, clock: f.clock, scripted: undefined,
    routeAuth: { store: transport.store, fetch: transport.fetch }, guard: () => { guards.push('guard'); }, onUsage: usage => { usages.push(usage); },
    reserveModel: () => { reserve(reservations.length + 1); const row = { settled: 0 }; reservations.push(row); return { settle() { row.settled++; } }; },
    correlated: () => {} });
  return { run, reservations, guards, usages };
}

test('CHAT route model: the initial send and the Grok auth-retry resend each reserve through authorizeDispatch', async () => {
  const t = routeTransport('grok', { responses: [401, 'ok'] }), c = conversation(() => {});
  const output = await c.run(t);
  expect(output.text).toBe('Completed the selected step.');
  expect(t.bodies).toHaveLength(2); expect(sha256(t.bodies[1]!)).toBe(sha256(t.bodies[0]!));
  expect(c.reservations).toEqual([{ settled: 1 }, { settled: 1 }]);
  // The wrapper forwards `call` unchanged, so the stored HostRunUsage carries exact provider requests.
  expect(output.usage.providerRequests).toEqual({ initialSends: 1, authRetrySends: 1, renewalRequests: 1 });
});

test('CHAT route model: a refused auth-retry resend is auth_retry_refused (cause chained) and keeps usage evidence', async () => {
  const own = new AppError('budget_exhausted');
  const t = routeTransport('grok', { responses: [401, 'ok', 'ok'] }), c = conversation(count => { if (count > 1) throw own; });
  const error = await c.run(t).then(() => null, (reason: unknown) => reason);
  // Distinct from a real exhausted allowance; the authorizer's own error is chained, never re-created from wording.
  expect(error).toBeInstanceOf(AppError); expect((error as AppError).code).toBe('auth_retry_refused'); expect((error as Error).cause).toBe(own);
  expect(t.bodies).toHaveLength(1); expect(t.renewals).toHaveLength(1);
  expect(c.reservations).toEqual([{ settled: 1 }]);
  expect(c.usages).toEqual([expect.objectContaining({ providerRequests: { initialSends: 1, authRetrySends: 0, renewalRequests: 1 } })]);
});

test('CHAT route model: a refused first send rethrows the authorizer error itself and sends nothing', async () => {
  const own = new AppError('budget_exhausted');
  const t = routeTransport('grok'), c = conversation(() => { throw own; });
  await expect(c.run(t)).rejects.toBe(own);
  expect(t.bodies).toHaveLength(0); expect(c.reservations).toEqual([]);
  expect(c.usages).toEqual([expect.objectContaining({ providerRequests: { initialSends: 0, authRetrySends: 0, renewalRequests: 0 } })]);
});

test('CHAT route model: a provider failure after no refusal is reported as incomplete, never as an earlier refusal', async () => {
  const t = routeTransport('grok', { responses: [{ status: 400, message: 'fixture provider failure' }] }), c = conversation(() => {});
  await expect(c.run(t)).rejects.toMatchObject({ code: 'conversation_run_incomplete' });
  expect(t.bodies).toHaveLength(1); expect(c.reservations).toEqual([{ settled: 1 }]);
});
