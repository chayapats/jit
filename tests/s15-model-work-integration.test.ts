import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Model } from 'schway/host';
import { ConversationApplication, ConversationStore, createConversationPolicy, createConversationPolicyTools } from '../src/s15/conversation';
import { createModelProjectionHandler, openModelService } from '../src/s15/model';
import { createResponsibilityProjectionHandler, openWorkService } from '../src/s15/work';
import { zero } from '../src/s15/policy/validation';
import { modelWorkFixture, ordinary, ref } from './fixtures/s15-model-work';

const cleanups: (() => void)[] = []; afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
test('a real authenticated CHAT assignment retains its exact authority as durable responsibility through a CI wait', async () => {
  const f = modelWorkFixture(); cleanups.push(() => f.cleanup());
  f.catalog.set('purpose:interpret', { ref: ref('interpret'), active: true }); f.configuration.purposes.push(ref('interpret'));
  f.configuration.interpretationPurpose = ref('interpret'); f.policy.owner.install(f.owner, 'enable_interpretation', 1, f.configuration);
  const policy = createConversationPolicy(f.policy, { ownerId: 'owner', ownerGeneration: () => 1, bot: ref('bot'), selection: ordinary, route: { provider: 'codex', model: 'ordinary' },
    limits: { modelCalls: 4, toolCalls: 4, outputBytes: 4096, activeMs: 10000 }, modelCallUpperBound: { ...zero(), calls: 1, spendMinor: '1' } });
  let reads = 0, turns = 0;
  const tools = createConversationPolicyTools(f.policy, [{ name: 'read_check', description: 'Read the selected issue checks', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, access: 'read', resource: ref('repo'), operation: 'read', upperBound: { ...zero(), reads: 1, outputBytes: 1024 }, fences: [], payload: () => ({ issue: 42 }),
    async perform(payload, context) { return context.dispatch(payload, async () => { reads++; return { content: 'Selected issue #42 check is pending.' }; }); } }]);
  const scripted: Model = { provider: 'codex', id: 'ordinary', async *stream(request) {
    const text = request.systemPrompt.includes('JIT_ISOLATED_INTERPRETATION_V1') ? JSON.stringify({ intent: 'execute', purposeId: 'purpose', resourceIds: ['repo'], access: 'reversible_write', subject: 'issue:42' }) : null;
    yield { type: 'message_complete', message: { type: 'assistant', id: crypto.randomUUID(), content: text ? [{ type: 'text', text }] : turns++ === 0 ? [{ type: 'tool_call', id: 'read', name: 'read_check', arguments: {} }] : [{ type: 'text', text: 'Selected work is waiting for CI.' }] } };
  } };
  const store = new ConversationStore(join(f.root, 'chat.sqlite'), 'fixture', true); cleanups.push(() => store.close());
  const chat = new ConversationApplication(store, { policy, tools, model: scripted, nativeDirectory: join(f.root, 'chat-native'), clock: f.clock });
  const command = { contract: 's15-conversation/v1' as const, requestId: 'chat_assignment', conversationId: 'conversation', text: 'Implement issue #42 and keep responsibility until checks pass.', continuation: null };
  chat.submit(f.owner, command); await chat.drain();
  const view = chat.view(f.owner, command.requestId); expect(view.state).toBe('completed'); expect(reads).toBe(1);
  const work = openWorkService({ ...f.workOptions(), conversation: chat }); cleanups.push(() => work.close());
  const r = work.assign(f.owner, { requestId: 'assign_real_chat', sourceRequestId: command.requestId, completion: 'Selected issue exact-head checks pass.', triggers: ['ci'], stallPolicy: { noProgressApproaches: 3, reserveCalls: 1, maxAttempts: 8 } });
  expect(r.workId).toBe(view.authority!.id); expect(r.originalText).toBe(command.text); expect(r.subject).toBe('issue:42');
  work.wait(r.id, { requestId: 'wait_real_chat', kind: 'ci', key: 'head_1', evidenceRefs: [view.evidence[0]!.id] });
  chat.submit(f.owner, command); await chat.drain(); expect(reads).toBe(1);
  expect(work.project(f.owner, r.id)).toMatchObject({ state: 'waiting', stopImpact: { heldAttempts: [] } });
});

test('owner JSON projections are authenticated, read-only and do not start work or erase unknown usage', async () => {
  const f = modelWorkFixture({ budget: false, subscription: true }); cleanups.push(() => f.cleanup()); f.source('source');
  const work = openWorkService(f.workOptions()); cleanups.push(() => work.close()); const r = work.assign(f.owner, { requestId: 'assign', sourceRequestId: 'source', completion: 'Checks pass.', triggers: ['ci'], stallPolicy: { noProgressApproaches: 3, reserveCalls: 1, maxAttempts: 8 } });
  const model = openModelService(f.modelOptions()); cleanups.push(() => model.close());
  const authenticate = (request: Request) => f.policy.owner.authenticate(request.headers.get('x-session') === 'fixture' ? 'fixture_owner' : null);
  const workHandler = createResponsibilityProjectionHandler(work, authenticate), modelHandler = createModelProjectionHandler(model, authenticate);
  const get = (path: string) => new Request('https://fixture.invalid' + path, { headers: { 'x-session': 'fixture' } });
  expect(workHandler(new Request('https://fixture.invalid/s15/responsibilities/' + r.id)).status).toBe(401);
  const response = workHandler(get('/s15/responsibilities/' + r.id)); expect(response.headers.get('Cache-Control')).toBe('no-store'); expect(await response.json()).toMatchObject({ id: r.id, state: 'ready' });
  expect(modelHandler(get('/s15/models')).status).toBe(200); expect(await modelHandler(get('/s15/models')).json()).toMatchObject({ currency: null });
  expect(workHandler(new Request('https://fixture.invalid/s15/responsibilities/' + r.id, { method: 'POST', headers: { 'x-session': 'fixture' } })).status).toBe(405);
  expect(modelHandler(new Request('https://fixture.invalid/s15/models', { method: 'POST', headers: { 'x-session': 'fixture' } })).status).toBe(405);
  expect(f.policy.control.reservations()).toHaveLength(0); expect(work.project(f.owner, r.id).attempts).toHaveLength(0);
});
