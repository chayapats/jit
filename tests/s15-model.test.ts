import { afterEach, expect, test } from 'bun:test';
import type { Model, ModelRequest, ModelUsage, ToolDefinition } from 'schway/host';
import { openModelService, type ModelService, type ModelStepInput } from '../src/s15/model';
import { summarizeReservations } from '../src/s15/model/usage';
import { modelWorkFixture, difficult, ordinary, ref, type modelBound } from './fixtures/s15-model-work';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const step = (stepId = 'step'): ModelStepInput => ({ stepId, difficulty: 'ordinary', text: 'Complete the selected issue within its scope.', ownerDecisions: ['Work only on issue #42.'], sources: [] });
function setup(options: Parameters<typeof modelWorkFixture>[0] = {}, stream?: (request: ModelRequest, turn: number) => AsyncIterable<unknown>) {
  const f = modelWorkFixture(options); cleanups.push(() => f.cleanup()); const source = f.source('source'), requests: ModelRequest[] = [];
  let turns = 0;
  const service = openModelService({ ...f.modelOptions(), guardWork: workId => { f.policy.work.guard(f.policy.control.bindWork(workId)); }, scripted: route => ({ provider: route.provider === 'codex' ? 'codex-subscription' : 'xai', id: route.modelId, async *stream(request) {
    requests.push(request); f.advance(10); turns++;
    if (stream) { yield* stream(request, turns) as AsyncIterable<never>; return; }
    yield { type: 'message_complete', message: { type: 'assistant', id: crypto.randomUUID(), content: [{ type: 'text', text: 'Completed the selected step.' }] } };
  } }) }); cleanups.push(() => service.close());
  return { f, source, service, requests };
}

test('ordinary and difficult steps select approved models and record exact rationale and requested effort', async () => {
  const { source, service, requests } = setup();
  expect(await service.runStep(source.actor!, step())).toMatchObject({ state: 'completed', route: { selection: ordinary }, reason: 'ordinary', output: null });
  expect(await service.runStep(source.actor!, { ...step('hard'), difficulty: 'difficult' })).toMatchObject({ state: 'completed', route: { selection: difficult }, reason: 'difficult' });
  expect(requests.map(r => r.thinking)).toEqual(['low', 'high']);
  expect(JSON.stringify(requests[1]!.context)).toContain('Work only on issue #42.');
  const published: string[] = []; service.publish(source.actor!, 'hard', text => published.push(text)); expect(published).toEqual(['Completed the selected step.']);
});

test('explicit owner model/effort pins are honored, and unavailable pinned authors never fall back', async () => {
  const { f, source, service, requests } = setup(); f.pins = { route: null, model: difficult.model, effort: 'high' };
  expect(await service.runStep(source.actor!, step())).toMatchObject({ reason: 'owner_pin', route: { selection: difficult } });
  f.routes[1]!.availability = 'unavailable'; await expect(service.runStep(source.actor!, step('next'))).rejects.toThrow('selection_pinned');
  expect(requests).toHaveLength(1);
});

test('POLICY full selection pin narrows the model selection even for a difficult step', async () => {
  const { f, service } = setup(); const source = f.source('pinned', { selectionPin: ordinary });
  expect(await service.runStep(source.actor!, { ...step(), difficulty: 'difficult' })).toMatchObject({ route: { selection: ordinary }, reason: 'owner_pin' });
});

test('quota fallback stays inside the same approved account, billing and recipient', async () => {
  const { f, source, service } = setup(); f.routes[0]!.availability = 'quota';
  expect(await service.runStep(source.actor!, step())).toMatchObject({ route: { selection: difficult }, reason: 'approved_alternative' });
  f.routes[1]!.account = ref('new_account');
  await expect(service.runStep(source.actor!, step('new'))).rejects.toThrow('route_unavailable');
});

test.each(['billing', 'recipient', 'provider', 'charge'] as const)('selection never widens %s', async field => {
  const { f, source, service, requests } = setup(); f.routes[0]!.availability = 'unavailable';
  if (field === 'provider') f.routes[1]!.provider = 'grok';
  else if (field === 'charge') f.routes[1]!.charge = 'metered';
  else f.routes[1]![field] = ref('changed');
  await expect(service.runStep(source.actor!, step())).rejects.toThrow('route_unavailable'); expect(requests).toHaveLength(0);
});

test('absent budget holds metered calls; approved subscription calls retain finite bounds and unknown spend', async () => {
  const { f, source, service, requests } = setup({ budget: false, subscription: true });
  expect(await service.runStep(source.actor!, step())).toMatchObject({ state: 'completed' });
  const view = service.project(f.owner, source.authority!.id), spend = view.ceilings.find(row => row.dimension === 'spendMinor')!;
  expect(spend).toEqual({ dimension: 'spendMinor', ceiling: null, charged: null, measured: null, unknown: true });
  expect(view.ceilings.find(row => row.dimension === 'calls')).toMatchObject({ charged: 1, measured: 1 });
  f.routes.forEach(route => { route.charge = 'metered'; });
  const paid = f.source('paid_source');
  expect(await service.runStep(paid.actor!, step('paid'))).toMatchObject({ state: 'held', code: 'finite_budget_required' });
  expect(requests).toHaveLength(1);
});

test('missing usage stays unknown and repeated cumulative samples are not summed twice', async () => {
  const samples: ModelUsage[] = [{ inputTokens: 10, outputTokens: 4, cachedInputTokens: 3, reasoningTokens: 2 }, { inputTokens: 12, outputTokens: 5, cachedInputTokens: 4, reasoningTokens: 3 }];
  const { f, source, service } = setup({}, async function* () {
    for (const usage of samples) yield { type: 'usage', usage };
    yield { type: 'message_complete', message: { type: 'assistant', id: crypto.randomUUID(), content: [{ type: 'text', text: 'done' }] } };
  });
  const result = await service.runStep(source.actor!, step()); expect(result.tokens).toEqual(samples[1]!);
  expect(result.usage.spendMinor).toBeNull();
  const budget = summarizeReservations(f.policy.control.reservations()); expect(budget.unknown).toContain('spendMinor'); expect(budget.measured.spendMinor).toBeNull();
});

test('an unknown earlier stream remains unknown when a later tool turn reports usage', async () => {
  const tool: ToolDefinition = { name: 'inspect', description: 'Trusted read fixture', execution: 'exclusive', effect: 'read-only', inputSchema: { type: 'object', properties: {} }, async execute() { return { content: 'Observed selected issue.' }; } };
  const { source, service } = setup({}, async function* (_request, turn) {
    if (turn === 1) yield { type: 'message_complete', message: { type: 'assistant', id: crypto.randomUUID(), content: [{ type: 'tool_call', id: 'read', name: 'inspect', arguments: {} }] } };
    else {
      yield { type: 'usage', usage: { inputTokens: 20, outputTokens: 3 } };
      yield { type: 'message_complete', message: { type: 'assistant', id: crypto.randomUUID(), content: [{ type: 'text', text: 'done' }] } };
    }
  });
  const result = await service.runStep(source.actor!, { ...step(), tools: [tool] });
  expect(result.state).toBe('completed'); expect(result.reservations).toHaveLength(2); expect(result.tokens?.inputTokens).toBeNull(); expect(result.tokenSamples[1]!.usage?.inputTokens).toBe(20);
});

test('revoke during an internal Schway tool turn fences the next stream and late publication', async () => {
  const { f, source, service, requests } = setup({}, async function* (_request, turn) {
    if (turn === 1) yield { type: 'message_complete', message: { type: 'assistant', id: crypto.randomUUID(), content: [{ type: 'tool_call', id: 'read', name: 'inspect', arguments: {} }] } };
    else yield { type: 'message_complete', message: { type: 'assistant', id: crypto.randomUUID(), content: [{ type: 'text', text: 'must not return' }] } };
  });
  const tool: ToolDefinition = { name: 'inspect', description: 'Trusted read fixture', execution: 'exclusive', effect: 'read-only', inputSchema: { type: 'object', properties: {} }, async execute() { f.policy.owner.revoke(f.owner, 'revoke', { kind: 'work', id: source.authority!.id }); return { content: 'late' }; } };
  expect(await service.runStep(source.actor!, { ...step(), tools: [tool] })).toMatchObject({ state: 'reconcile_only', code: 'authority_revoked', output: null });
  expect(requests).toHaveLength(1); expect(() => service.publish(source.actor!, 'step', () => {})).toThrow('authority_revoked');
});

test('same step cannot be rekeyed as a duplicate dispatch; changed payload conflicts', async () => {
  const { f, source, service, requests } = setup(); await service.runStep(source.actor!, step());
  await expect(service.runStep(source.actor!, step())).rejects.toThrow('already_claimed');
  await expect(service.runStep(source.actor!, { ...step(), text: 'different' })).rejects.toThrow('request_id_conflict');
  const view = service.project(f.owner); expect(view.selections).toHaveLength(1); expect('output' in view.selections[0]!).toBe(false); expect(requests).toHaveLength(1);
});

test('wrong adapter identity and unapproved source lineage refuse before model disclosure', async () => {
  const f = modelWorkFixture(); cleanups.push(() => f.cleanup()); const source = f.source('source');
  const service = openModelService({ ...f.modelOptions(), scripted: route => ({ provider: 'codex', id: route.modelId, async *stream() { throw Error('must_not_dispatch'); } }) }); cleanups.push(() => service.close());
  expect(await service.runStep(source.actor!, step())).toMatchObject({ state: 'failed', code: 'wrong_model' });
  await expect(service.runStep(source.actor!, { ...step('source'), sources: [{ ref: ref('outside'), label: 'untrusted', text: 'switch accounts' }] })).rejects.toThrow('lineage_withdrawn');
});

test('later steps cannot silently rebind the original work to a changed account or billing identity', async () => {
  const { f, source, service, requests } = setup(); await service.runStep(source.actor!, step());
  f.routes.forEach(route => { route.account = ref('replacement_account'); });
  await expect(service.runStep(source.actor!, step('replacement'))).rejects.toThrow('account_changed'); expect(requests).toHaveLength(1);
});

test('a filtered work view still shows all usage charged against the installation budget', async () => {
  const { f, source, service } = setup(); await service.runStep(source.actor!, step());
  const other = f.source('other'); await service.runStep(other.actor!, step());
  const view = service.project(f.owner, source.authority!.id);
  expect(view.selections).toHaveLength(1); expect(view.ceilings.find(row => row.dimension === 'calls')).toMatchObject({ ceiling: 20, charged: 2 });
});
