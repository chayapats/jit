import { afterEach, expect, test } from 'bun:test';
import type { ActionAdapter, ReconcileContext } from '../src/s15/policy';
import { unknownUsage, zero } from '../src/s15/policy/validation';
import { actionRef, draft, fixture } from './fixtures/s15-policy';
import { googleFixture, mail } from './fixtures/s15-effects';
const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });

test('recovery context bounds every physical read and cannot be reused after its invocation finishes', async () => {
  let context!: ReconcileContext, reads = 0, thirdReadRefused = false;
  const adapter: ActionAdapter = { id: 'two_read_recovery', version: 1, prepare: () => draft(), async perform(a, dispatch) { return dispatch.commit(a.payload, async () => ({ outcome: 'unknown', actual: unknownUsage(), transportSettled: true })); }, reconcileUpperBound: { ...zero(), calls: 2, reads: 2 }, async reconcile(_a, c) { context = c; c.beforeRead(); reads++; c.beforeRead(); reads++; try { c.beforeRead(); reads++; } catch { thirdReadRefused = true; } return { outcome: 'unknown', actual: unknownUsage(), transportSettled: true }; } };
  const f = fixture({ adapters: [adapter] }); cleanup.push(() => f.cleanup()); f.input.rules[0]!.adapters.push(adapter.id); f.install();
  const actor = f.admit().actor!, a = f.service.work.prepare(actor, { slot: 'effect', adapter: adapter.id, proposal: {} }).action;
  await f.service.work.dispatch(actor, actionRef(a)); const before = f.service.control.usage().charged;
  await f.service.owner.reconcile(f.owner, actionRef(a), 'two_reads'); expect(reads).toBe(2); expect(thirdReadRefused).toBe(true); expect(() => context.beforeRead()).toThrow('already_claimed');
  expect(f.service.control.usage().charged.calls - before.calls).toBe(2);
});

test('insufficient remaining recovery allowance refuses Gmail reconciliation before another provider read', async () => {
  const g = googleFixture(); cleanup.push(() => g.f.cleanup()); const actor = g.f.admit().actor!, a = g.prepare(actor, 'mail', mail()).action; g.f.approve(actionRef(a)); g.loseNextResponse = true;
  await g.f.service.work.dispatch(actor, actionRef(a)); const calls = g.calls;
  g.f.input.budget!.ceiling.calls = 4; g.f.install();
  await expect(g.f.service.owner.reconcile(g.f.owner, actionRef(a), 'exhausted_recovery')).rejects.toThrow('budget_exhausted'); expect(g.calls).toBe(calls); expect(g.mutationCalls).toBe(1);
});
