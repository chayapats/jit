import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import type { Model } from 'schway/host';
import { ConversationApplication, ConversationStore, conversationOwnerView, createConversationPolicy, type ConversationCommand, type ConversationPolicyWork, type ConversationToolPort } from '../src/s15/conversation';
import { createEffectsConversationTools } from '../src/s15/effects';
import type { BrowserWork } from '../src/s15/browser';
import { googleFixture, calendar, mail } from './fixtures/s15-effects';
import { recordFixture } from './fixtures/s15-effect-browser';
import { ref, selection, type Fixture } from './fixtures/s15-policy';
import { zero } from '../src/s15/policy/validation';
const cleanup: (() => Promise<unknown> | unknown)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
const unique = () => crypto.randomUUID().replaceAll('-', '');
const command = (text: string): ConversationCommand => ({ contract: 's15-conversation/v1', requestId: unique(), conversationId: 'conversation', text, continuation: null });
/** S16-D08: only the exact one-press command decides; it needs the slip the owner was shown. */
const decision = (view: { needsYou: { slip: { action: { id: string; revision: number; actionHash: string } } | null }[] }, verdict: 'approve' | 'deny' = 'approve', requestId = unique()) => { const a = view.needsYou[0]!.slip!.action; return { contract: 's15-conversation-decision/v1' as const, requestId, conversationId: 'conversation', action: { id: a.id, revision: a.revision, actionHash: a.actionHash }, decision: verdict }; };
function chat(f: Pick<Fixture, 'add' | 'input' | 'install' | 'service' | 'dir' | 'now'>, tools: ConversationToolPort<ConversationPolicyWork>, config: { access: 'reversible_write' | 'effect'; steps: (() => { name: string; arguments: unknown })[]; dispatchAction?: ReturnType<typeof createEffectsConversationTools>['dispatchAction'] }) {
  f.add('purpose', ref('interpret')); f.input.purposes.push(ref('interpret')); f.input.interpretationPurpose = ref('interpret'); f.install();
  let turn = 0, calls = 0;
  const model: Model = { provider: 'codex', id: 'scripted', async *stream(request) {
    calls++;
    if (request.systemPrompt.includes('JIT_ISOLATED_INTERPRETATION_V1')) { turn = 0; yield { type: 'message_complete', message: { type: 'assistant', id: unique(), content: [{ type: 'text', text: JSON.stringify({ intent: 'execute', purposeId: 'purpose', resourceIds: ['account', 'repo'], access: config.access, subject: null }) }] } }; return; }
    const step = config.steps[turn++]?.();
    yield { type: 'message_complete', message: { type: 'assistant', id: unique(), content: step ? [{ type: 'tool_call', id: unique(), ...step }] : [{ type: 'text', text: 'Completed requested work with observed tool evidence, or waiting on the exact final action.' }] } };
  } };
  const policy = createConversationPolicy(f.service, { ownerId: 'owner', ownerGeneration: () => 1, bot: ref('bot'), selection, route: { provider: 'codex', model: 'scripted' }, limits: { modelCalls: 8, toolCalls: 6, outputBytes: 32768, activeMs: 60000 }, modelCallUpperBound: { ...zero(), calls: 1, spendMinor: '1' } });
  if (config.dispatchAction) policy.dispatchAction = config.dispatchAction;
  const store = new ConversationStore(join(f.dir, 'effects-chat.sqlite'), 'test_installation', true); cleanup.push(() => store.close());
  const app = new ConversationApplication(store, { policy, tools, model, nativeDirectory: join(f.dir, 'native'), clock: { now: () => f.now, sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => { if (signal?.aborted) reject(new DOMException('Aborted', 'AbortError')); else signal?.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true }); }) } });
  cleanup.push(() => app.shutdown()); return { app, get calls() { return calls; } };
}

test('normal conversational solo-calendar request executes a real Google fixture call once without Work mode or approval', async () => {
  const g = googleFixture(); cleanup.push(() => g.f.cleanup());
  const c = chat(g.f, g.registration.tools, { access: 'reversible_write', steps: [() => ({ name: 'calendar_edit', arguments: calendar() })] }), request = command('Create a solo calendar block for my focus time.');
  const receipt = c.app.submit(g.f.owner, request); await c.app.drain(); expect(g.mutationCalls).toBe(1); expect(c.app.view(g.f.owner, request.requestId).state).toBe('completed');
  const view = conversationOwnerView(c.app, g.f.owner, 'conversation'); expect(view.needsYou).toHaveLength(0); expect(view.rows[0]!.evidence[0]!.content).toContain('Focus block');
  const calls = c.calls; expect(c.app.submit(g.f.owner, request)).toEqual(receipt); await c.app.drain(); expect(c.calls).toBe(calls); expect(g.mutationCalls).toBe(1);
});

test('normal send-it conversation holds the exact email; one presented chat approval sends once and owner output adds no communication hold', async () => {
  const g = googleFixture(); cleanup.push(() => g.f.cleanup()); const c = chat(g.f, g.registration.tools, { access: 'effect', steps: [() => ({ name: 'gmail_prepare_send', arguments: mail() })] });
  const request = command('Send this email to the recipient.'); c.app.submit(g.f.owner, request); await c.app.drain(); expect(g.mutationCalls).toBe(0);
  const view = conversationOwnerView(c.app, g.f.owner, 'conversation'); expect(view.needsYou).toHaveLength(1); expect(view.needsYou[0]!.slip!.action.classes).toEqual(['communication']);
  const approve = decision(view); c.app.decide(g.f.owner, approve); await c.app.drain(); expect(g.mutationCalls).toBe(1); expect(c.app.view(g.f.owner, approve.requestId).decision!.observation!.outcome).toBe('succeeded');
  c.app.decide(g.f.owner, approve); await c.app.drain(); expect(g.mutationCalls).toBe(1); expect(conversationOwnerView(c.app, g.f.owner, 'conversation').needsYou).toHaveLength(0);
  expect(c.app.store.request(approve.requestId).decision!.observation).not.toHaveProperty('evidence');
  g.f.allow = false; expect(JSON.stringify(c.app.view(g.f.owner, approve.requestId))).not.toContain(mail().body);
});

test.each([false, true])('conversational controlled document save with notification=%s uses the same browser request and exact gate', async notify => {
  const f = await recordFixture(); cleanup.push(() => f.cleanup()); f.work.release();
  let browser!: BrowserWork;
  const registration = { ...f.gateway, open(actor: Parameters<typeof f.gateway.open>[0]) { browser = f.gateway.open(actor); return browser; } };
  const bridge = createEffectsConversationTools(f.service, { browser: registration }); cleanup.push(() => bridge.close());
  const c = chat(f, bridge.tools, { access: notify ? 'effect' : 'reversible_write', dispatchAction: bridge.dispatchAction, steps: [() => ({ name: 'protected_browser', arguments: { kind: 'navigate', url: `${f.server.origin}/records/document`, generation: browser.state().generation } }), () => { f.engine.next = f.server.request('document', f.edit({ body: 'Saved from normal conversation' }, notify ? { notify: ['team'] } : {})); return { name: 'protected_browser', arguments: { kind: 'submit', target: 'e1_1', generation: browser.state().generation } }; }] });
  const request = command('Update my document with the requested note.'); c.app.submit(f.owner, request); await c.app.drain();
  const view = conversationOwnerView(c.app, f.owner, 'conversation'); expect(f.server.mutationCount).toBe(notify ? 0 : 1);
  if (notify) { expect(view.needsYou).toHaveLength(1); c.app.decide(f.owner, decision(view)); await c.app.drain(); expect(f.server.mutationCount).toBe(1); }
  else expect(view.needsYou).toHaveLength(0);
  expect(f.server.record('document').fields).toMatchObject({ body: 'Saved from normal conversation' });
});

test.each(['deny', 'cancel', 'stop', 'timeout'] as const)('a retained browser lease ends after %s and the next CHAT request can use it without sending the held request', async reason => {
  const timers = new Set<() => void>();
  const f = await recordFixture('static', undefined, { start(ms, callback) { expect(ms).toBe(30000); timers.add(callback); return () => { timers.delete(callback); }; } }); cleanup.push(() => f.cleanup()); f.work.release();
  let browser!: BrowserWork, session!: Awaited<ReturnType<ConversationToolPort<ConversationPolicyWork>['open']>>, notify = true;
  const registration = { ...f.gateway, open(actor: Parameters<typeof f.gateway.open>[0]) { browser = f.gateway.open(actor); return browser; } };
  const bridge = createEffectsConversationTools(f.service, { browser: registration }); cleanup.push(async () => { try { await bridge.close(); } catch {} });
  const tools: ConversationToolPort<ConversationPolicyWork> = { async open(work, input) { session = await bridge.tools.open(work, input); return session; } };
  const c = chat(f, tools, { access: 'effect', dispatchAction: bridge.dispatchAction, steps: [
    () => ({ name: 'protected_browser', arguments: { kind: 'navigate', url: `${f.server.origin}/records/document`, generation: browser.state().generation } }),
    () => { f.engine.next = f.server.request('document', f.edit({ body: notify ? 'Held notification' : 'Next authorized edit' }, notify ? { notify: ['team'] } : {})); return { name: 'protected_browser', arguments: { kind: 'submit', target: 'e1_1', generation: browser.state().generation } }; },
  ] });
  const first = command('Update my document.'); c.app.submit(f.owner, first); await c.app.drain(); const view = conversationOwnerView(c.app, f.owner, 'conversation'); expect(view.needsYou).toHaveLength(1); expect(f.server.mutationCount).toBe(0);
  if (reason === 'deny') { c.app.decide(f.owner, decision(view, 'deny')); await c.app.drain(); }
  else if (reason === 'cancel') await session.cancel();
  else if (reason === 'stop') c.app.stop(f.owner, first.requestId);
  else { expect(timers.size).toBe(1); for (const callback of [...timers]) callback(); }
  notify = false; const next = command('Update my document with the next note.'); c.app.submit(f.owner, next); await c.app.drain();
  expect(c.app.view(f.owner, next.requestId).state).toBe('completed'); expect(f.server.mutationCount).toBe(1); expect(f.server.record('document').fields).toMatchObject({ body: 'Next authorized edit' });
});
