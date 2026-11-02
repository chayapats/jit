import { afterEach, expect, test } from 'bun:test';
import { join } from 'node:path';
import { openDisclosureService, type RecipientApproval, type DisclosureSource } from '../src/s15/disclosure';
import { openModelService, type ModelStepInput } from '../src/s15/model';
import { modelWorkFixture, ref } from './fixtures/s15-model-work';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function setup() {
  const f = modelWorkFixture(); cleanups.push(() => f.cleanup());
  const source: DisclosureSource = { ref: ref('private'), resource: ref('repo'), classification: 'business', active: true, ownerReleasable: true };
  const approvals: RecipientApproval[] = [];
  const d = openDisclosureService({ runtime: 's15', path: join(f.root, 'disclosure.sqlite'), create: true, installationId: 'fixture', now: f.clock.now,
    catalogs: { source: r => r.id === 'private' ? source : null, recipient: r => r.id === 'provider' ? { ref: r, active: true } : null, approvals: () => approvals },
    routes: [{ id: 'codex', kind: 'model', resolve: () => [ref('provider')] }] });
  d.attach(f.policy); cleanups.push(() => d.close());
  const work = f.source('work'); let calls = 0, onStream: (() => void) | null = null;
  const model = openModelService({ ...f.modelOptions(), disclosure: d.model(() => 'codex'), guardWork: () => {}, scripted: route => ({ provider: 'codex-subscription', id: route.modelId, async *stream() {
    calls++; onStream?.();
    yield { type: 'message_complete', message: { type: 'assistant', id: crypto.randomUUID(), content: [{ type: 'text', text: 'Derived result' }] } };
  } }) }); cleanups.push(() => model.close());
  const step = (stepId = 'step'): ModelStepInput => ({ stepId, difficulty: 'ordinary', text: 'Process the private result', ownerDecisions: [], sources: [] });
  const grant = () => approvals.push({ recipient: ref('provider'), purpose: ref('purpose'), resources: [ref('repo')], dataClasses: ['business'], sources: [ref('private')], expiresAt: 700000 });
  return { f, source, approvals, d, model, work, step, grant, calls: () => calls, set onStream(fn: () => void) { onStream = fn; } };
}

test('MODEL excludes a provider unapproved for private lineage before selection/reservation/stream', async () => {
  const x = setup(); x.d.read(x.work.actor!, ref('private'));
  await expect(x.model.runStep(x.work.actor!, x.step())).rejects.toThrow('recipient_unapproved');
  expect(x.calls()).toBe(0); expect(x.f.policy.control.reservations()).toHaveLength(0);
  x.grant(); expect(await x.model.runStep(x.work.actor!, x.step())).toMatchObject({ state: 'completed' }); expect(x.calls()).toBe(1);
});

test('MODEL does not disclose credential-shaped actual context to an already approved provider', async () => {
  const x = setup(); x.d.read(x.work.actor!, ref('private')); x.grant();
  await expect(x.model.runStep(x.work.actor!, { ...x.step(), text: 'Bearer ' + 'x'.repeat(24) })).rejects.toThrow('credential_content_refused');
  expect(x.calls()).toBe(0);
});

test('new private lineage acquired by a real tool blocks the following native model turn', async () => {
  const x = setup();
  let streams = 0;
  // Use a distinct host to exercise Schway's actual tool loop with the DATA15 selection guard.
  const model = openModelService({ ...x.f.modelOptions(), path: join(x.f.root, 'tool-model.sqlite'), disclosure: x.d.model(() => 'codex'), guardWork: () => {}, scripted: route => ({ provider: 'codex-subscription', id: route.modelId, async *stream() {
    streams++;
    yield { type: 'message_complete', message: { type: 'assistant', id: crypto.randomUUID(), content: [{ type: 'tool_call', id: 'read', name: 'private_read', arguments: {} }] } };
  } }) }); cleanups.push(() => model.close());
  const record = await model.runStep(x.work.actor!, { ...x.step(), tools: [{ name: 'private_read', description: 'Protected source read', effect: 'read-only', execution: 'exclusive', inputSchema: { type: 'object', properties: {} }, async execute() { x.d.read(x.work.actor!, ref('private')); return { content: 'Business margin 12%' }; } }] });
  expect(record).toMatchObject({ state: 'reconcile_only', code: 'recipient_unapproved', output: null }); expect(streams).toBe(1);
});

test('recipient approval revocation fences model publication and future steps', async () => {
  const x = setup(); x.d.read(x.work.actor!, ref('private')); x.grant();
  expect(await x.model.runStep(x.work.actor!, x.step())).toMatchObject({ state: 'completed' });
  x.approvals.splice(0);
  expect(() => x.model.publish(x.work.actor!, 'step', () => { throw Error('must not publish'); })).toThrow('recipient_unapproved');
  await expect(x.model.runStep(x.work.actor!, x.step('next'))).rejects.toThrow('recipient_unapproved'); expect(x.calls()).toBe(1);
});
