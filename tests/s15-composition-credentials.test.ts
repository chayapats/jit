import { afterEach, expect, test } from 'bun:test';
import type { ApprovedModelRoute } from '../src/s15/model';
import { equal } from '../src/s15/policy/validation';
import { composedFixture } from './fixtures/s15-composition';
import { ROUTE_MODEL, routeTransport } from './fixtures/s15-route-transport';

// MODEL15-03 (#381): the composition builds ONE credential lifecycle and passes it to every route host it composes,
// so CHAT and MODEL15 renewals on the same store share one single-flight token request.
const fixtures: Awaited<ReturnType<typeof composedFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

test('CHAT interpretation and a MODEL15 step that both need renewal share one token request', async () => {
  const renewing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), joined = Promise.withResolvers<void>();
  const t = routeTransport('grok', { renewal: async () => { renewing.resolve(); await release.promise; } }); t.expire();
  const f = await composedFixture('default', false, undefined, options => {
    const choice = options.conversation.selection;
    const route: ApprovedModelRoute = { selection: choice, provider: 'grok', modelId: ROUTE_MODEL.grok, account: { id: 'provider_account', revision: 1, generation: 1 }, billing: { id: 'subscription', revision: 1, generation: 1 },
      recipient: { id: 'provider', revision: 1, generation: 1 }, charge: 'subscription', availability: 'available', efforts: ['low'], effortEvidence: 'requested_only', upperBound: options.conversation.modelCallUpperBound, rank: { ordinary: 0, difficult: 0 } };
    // Route hosts only: no scripted interpreter or model, and the scripted transport stands in for the OS store.
    const { interpreter: _interpreter, ...rest } = options;
    return { ...rest, credentials: { store: t.store, fetch: t.fetch }, conversation: { ...options.conversation, route: { provider: 'grok', model: ROUTE_MODEL.grok } },
      model: { limits: options.model.limits, registry: { list: () => [route], current: selection => equal(selection, choice) ? route : null, pins: options.model.registry.pins } } };
  });
  fixtures.push(f);
  const receipt = f.service.policy.owner.admit(f.owner, { requestId: 'renewal_step', intent: 'execute', access: 'reversible_write', purpose: f.policyInput.purposes[0]!, bot: f.policyInput.bots[0]!,
    resources: [f.policyInput.resources[0]!], recipients: [], selection: f.choice, selectionPin: null, expiresAt: 800000 });
  const actor = f.service.policy.control.bindWork(receipt.work!.id);
  // MODEL15 renews before its first listing and holds the only token request open.
  const step = f.service.models.runStep(actor, { stepId: 'renewal_step', difficulty: 'ordinary', text: 'Report the computer state.', ownerDecisions: [], sources: [] });
  await renewing.promise;
  // CHAT's interpretation host reads the same expired credential and joins that renewal instead of sending its own.
  t.onNextRead(() => joined.resolve());
  const chatting = f.chat('What is on the computer?');
  await joined.promise; release.resolve();
  const [record, chat] = await Promise.all([step, chatting]);
  expect(t.renewals).toHaveLength(1);
  expect(record).toMatchObject({ state: 'completed', catalogRenewal: { outcome: 'renewed', renewalRequests: 1 }, providerRequests: { renewalRequests: 1 } });
  // CHAT sent inference with the shared renewed token and counted no renewal of its own.
  expect(chat.interpretationUsage?.providerRequests).toMatchObject({ initialSends: 1, authRetrySends: 0, renewalRequests: 0 });
  expect(t.log.filter(kind => kind === 'renewal')).toHaveLength(1); expect(t.log.filter(kind => kind === 'inference').length).toBeGreaterThanOrEqual(2);
});
