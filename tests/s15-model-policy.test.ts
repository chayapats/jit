import { afterEach, expect, test } from 'bun:test';
import type { ActionAdapter } from '../src/s15/policy';
import { unknownUsage } from '../src/s15/policy/validation';
import { modelWorkFixture, modelBound, ordinary, difficult, ref } from './fixtures/s15-model-work';

const cleanups: (() => void)[] = []; afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
function setup(subscription = true, adapters: ActionAdapter[] = []) { const f = modelWorkFixture({ budget: false, subscription, adapters }); cleanups.push(() => f.cleanup()); return f; }

test('budget=null still holds every metered route and every route without the protected subscription registry', () => {
  const f = setup(false), source = f.source('source');
  expect(() => f.policy.work.reserveModelCall(source.actor!, { requestId: 'paid', selection: ordinary, upperBound: modelBound() })).toThrow('finite_budget_required');
  expect(f.policy.control.usage().charged.calls).toBe(0);
  const other = setup(); other.routes[0]!.charge = 'metered'; const paid = other.source('paid');
  expect(() => other.policy.work.reserveModelCall(paid.actor!, { requestId: 'paid', selection: ordinary, upperBound: modelBound() })).toThrow('finite_budget_required');
});

test('subscription model exception never funds actions or reads when the monetary budget is absent', () => {
  const adapter: ActionAdapter = { id: 'fixture', version: 1, prepare() { return { operation: 'edit', classes: ['ordinary_edit'], resources: [ref('repo')], recipients: [], payload: { text: 'exact' }, fences: [], upperBound: modelBound(), expiresAt: 800000, transaction: null, github: null, impact: 'reversible' }; }, async perform() { throw Error('must_not_send'); } };
  const f = setup(true, [adapter]), source = f.source('source');
  expect(f.policy.work.prepare(source.actor!, { slot: 'effect', adapter: 'fixture', proposal: {} }).decision).toEqual({ state: 'hold', code: 'finite_budget_required' });
  expect(f.policy.work.reserveRead(source.actor!, { requestId: 'read', resource: ref('repo'), operation: 'read', exactPayload: { path: 'test.txt' }, fences: [], upperBound: { ...modelBound(), reads: 1 } })).toEqual({ state: 'deny', code: 'read_bound_exhausted' });
  expect(f.policy.control.reservations()).toHaveLength(0);
});

test('subscription reservations retain finite concurrency across work IDs and finite per-work calls/time', () => {
  const f = setup(), source = f.source('source'), other = f.source('other');
  const first = f.policy.work.reserveModelCall(source.actor!, { requestId: 'one', selection: ordinary, upperBound: modelBound() });
  expect(() => f.policy.work.reserveModelCall(other.actor!, { requestId: 'other', selection: ordinary, upperBound: modelBound() })).toThrow('capacity_busy');
  f.policy.work.guardReservation(source.actor!, first.id); expect(() => f.policy.work.guardReservation(source.actor!, first.id)).toThrow('already_claimed');
  f.policy.control.settleReservation(first.id, unknownUsage(), true);
  for (let i = 1; i < 6; i++) { const r = f.policy.work.reserveModelCall(source.actor!, { requestId: 'call_' + i, selection: ordinary, upperBound: modelBound() }); f.policy.work.guardReservation(source.actor!, r.id); f.policy.control.settleReservation(r.id, unknownUsage(), true); }
  expect(() => f.policy.work.reserveModelCall(source.actor!, { requestId: 'excess', selection: ordinary, upperBound: modelBound() })).toThrow('budget_exhausted');
  expect(f.policy.control.usage().charged.calls).toBe(6);
});

test('subscription guard rechecks current approval and finite bounds after reservation and restart', () => {
  const f = setup(), source = f.source('source');
  const r = f.policy.work.reserveModelCall(source.actor!, { requestId: 'one', selection: ordinary, upperBound: modelBound() });
  f.routes[0]!.charge = 'metered'; expect(() => f.policy.work.guardReservation(source.actor!, r.id)).toThrow('finite_budget_required');
  f.routes[0]!.charge = 'subscription'; f.reopen();
  expect(() => f.policy.work.guardReservation(f.policy.control.bindWork(source.authority!.id), r.id)).toThrow('reconciliation_required');
  expect(f.policy.control.usage().unsettled).toBe(1);
});

test('POLICY still intersects selection pins and rejects missing finite technical call bounds', () => {
  const f = setup(), source = f.source('source', { selectionPin: ordinary });
  expect(() => f.policy.work.reserveModelCall(source.actor!, { requestId: 'pin', selection: difficult, upperBound: modelBound() })).toThrow('selection_pinned');
  expect(() => f.policy.work.reserveModelCall(source.actor!, { requestId: 'time', selection: ordinary, upperBound: { ...modelBound(), activeMs: 0 } })).toThrow('cost_unknown');
  expect(() => f.policy.work.reserveModelCall(source.actor!, { requestId: 'money', selection: ordinary, upperBound: { ...modelBound(), spendMinor: '1' } })).toThrow('cost_unknown');
});
