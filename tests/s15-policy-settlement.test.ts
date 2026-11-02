import { afterEach, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import type { ActionAdapter, AdapterResult } from '../src/s15/policy';
import { unknownUsage } from '../src/s15/policy/validation';
import { actionRef, bound, draft, fixture, ref, selection, type Fixture } from './fixtures/s15-policy';

const fixtures: Fixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
function setup(adapters: ActionAdapter[] = []) {
  const f = fixture({ adapters }); fixtures.push(f);
  for (const adapter of adapters) f.input.rules[0]!.adapters.push(adapter.id);
  f.install(); return f;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const verified = (outcome: 'succeeded' | 'failed' = 'succeeded'): AdapterResult => ({ outcome, actual: { ...unknownUsage(), calls: 1, spendMinor: '3' }, transportSettled: true });
const unknown = (): AdapterResult => ({ outcome: 'unknown', actual: unknownUsage(), transportSettled: false });
function gatedAdapter() {
  const sendStarted = deferred<void>(), readStarted = deferred<void>();
  const send = deferred<AdapterResult>(), read = deferred<AdapterResult>();
  let sends = 0, reads = 0;
  const adapter: ActionAdapter = {
    id: 'settlement_fixture', version: 1,
    prepare: () => draft(),
    async perform(action, context) { return context.commit(action.payload, async () => { sends++; sendStarted.resolve(); return send.promise; }); },
    async reconcile() { reads++; readStarted.resolve(); return read.promise; },
  };
  return { adapter, sendStarted, readStarted, send, read, get sends() { return sends; }, get reads() { return reads; } };
}
function prepare(f: Fixture, adapter: ActionAdapter) {
  const { actor } = f.admit();
  const action = f.service.work.prepare(actor!, { slot: 'effect', adapter: adapter.id, proposal: {} }).action;
  return { actor: actor!, action };
}

test.each(['work', 'interpretation'] as const)('model dispatch consumes one durable permission for %s, including rebinding and restart', async mode => {
  const f = setup();
  if (mode === 'interpretation') { f.input.interpretationPurpose = ref('purpose'); f.install(); }
  const authority = mode === 'interpretation' ? f.service.owner.prepareInterpretation(f.owner, { requestId: 'interpret', selection, expiresAt: 90000 }).authority : f.admit().receipt.work!;
  const actor = f.service.control.bindWork(authority.id);
  const reservation = f.service.work.reserveModelCall(actor, { requestId: 'model_call', selection, upperBound: bound() });
  const rebound = f.service.control.bindWork(authority.id);
  expect(() => f.service.work.guardReservation(rebound, reservation.id)).toThrow('reconciliation_required');
  let sends = 0;
  const attempts = await Promise.allSettled([1, 2].map(() => Promise.resolve().then(() => { f.service.work.guardReservation(actor, reservation.id); sends++; })));
  expect(attempts.filter(r => r.status === 'fulfilled')).toHaveLength(1);
  expect(attempts.filter(r => r.status === 'rejected').map(r => r.reason.message)).toEqual(['already_claimed']);
  f.reopen();
  expect(() => f.service.work.guardReservation(f.service.control.bindWork(authority.id), reservation.id)).toThrow('already_claimed');
  expect(f.service.control.usage()).toEqual({ charged: bound(), unsettled: 1 });
  expect(sends).toBe(1);
});

test('restart cannot adopt even an unconsumed model invocation, and its unknown capacity remains held', () => {
  const f = setup(), work = f.admit().receipt.work!, actor = f.service.control.bindWork(work.id);
  const reservation = f.service.work.reserveModelCall(actor, { requestId: 'model_call', selection, upperBound: bound() });
  f.reopen(); const rebound = f.service.control.bindWork(work.id);
  expect(() => f.service.work.guardReservation(rebound, reservation.id)).toThrow('reconciliation_required');
  expect(() => f.service.work.reserveModelCall(rebound, { requestId: 'model_call', selection, upperBound: bound() })).toThrow('reservation_already_claimed');
  expect(f.service.control.usage()).toEqual({ charged: bound(), unsettled: 1 });
});

test('a lost operation can use bounded read-back when ordinary concurrency is one', async () => {
  let sends = 0, reads = 0;
  const adapter: ActionAdapter = { id: 'recovery_fixture', version: 1, prepare: () => draft(),
    async perform(action, context) { return context.commit(action.payload, async () => { sends++; throw new Error('fixture_reply_lost'); }); },
    async reconcile() { reads++; return verified(); },
  };
  const f = setup([adapter]); f.input.budget!.concurrency = 1; f.install(); const { actor, action } = prepare(f, adapter);
  expect((await f.service.work.dispatch(actor, actionRef(action))).outcome).toBe('unknown');
  expect(() => f.service.work.reserveModelCall(actor, { requestId: 'blocked', selection, upperBound: bound() })).toThrow('capacity_busy');
  const observed = await f.service.owner.reconcile(f.owner, actionRef(action), 'read_back');
  expect(observed.outcome).toBe('succeeded'); expect(observed.basis).toBe('remote_verified');
  expect(f.service.control.usage()).toEqual({ charged: { ...bound(), calls: 2, reads: 1 }, unsettled: 0 });
  expect(f.service.work.reserveModelCall(actor, { requestId: 'after_recovery', selection, upperBound: bound() }).id).toBeString();
  expect(sends).toBe(1); expect(reads).toBe(1);
});

test('a completed unknown read releases its own recovery slot, retains the effect slot and charges each bounded read', async () => {
  let read = 0;
  const adapter: ActionAdapter = { id: 'recovery_fixture', version: 1, prepare: () => draft(),
    async perform(action, context) { return context.commit(action.payload, async () => unknown()); },
    async reconcile() { return ++read === 1 ? unknown() : verified(); },
  };
  const f = setup([adapter]); f.input.budget!.concurrency = 1; f.install(); const { actor, action } = prepare(f, adapter);
  await f.service.work.dispatch(actor, actionRef(action));
  expect((await f.service.owner.reconcile(f.owner, actionRef(action), 'unknown_read')).outcome).toBe('unknown');
  expect(f.service.control.usage().unsettled).toBe(1);
  expect((await f.service.owner.reconcile(f.owner, actionRef(action), 'verified_read')).outcome).toBe('succeeded');
  expect(f.service.control.usage()).toEqual({ charged: { ...bound(), calls: 3, reads: 2 }, unsettled: 0 });
});

test.each(['succeeded', 'failed'] as const)('a slow unknown read cannot downgrade live dispatch %s or retain finished-read capacity', async outcome => {
  const port = gatedAdapter(), f = setup([port.adapter]), { actor, action } = prepare(f, port.adapter);
  const dispatch = f.service.work.dispatch(actor, actionRef(action)); await port.sendStarted.promise;
  const reading = f.service.owner.reconcile(f.owner, actionRef(action), 'slow_read');
  try {
    await Promise.race([port.readStarted.promise, reading.then(() => { throw new Error('read ended before its barrier'); })]);
    port.send.resolve(verified(outcome)); expect((await dispatch).outcome).toBe(outcome);
    expect(f.service.control.usage().unsettled).toBe(1);
    port.read.resolve(unknown()); const result = await reading;
    expect(result).toEqual(f.service.owner.inspect(f.owner, actionRef(action)).observation!);
    expect(result.outcome).toBe(outcome); expect(result.basis).toBe('remote_verified'); expect(result.actual.calls).toBe(1);
    expect(f.service.control.usage()).toEqual({ charged: { ...bound(), calls: 2, reads: 1 }, unsettled: 0 });
    expect(await f.service.owner.reconcile(f.owner, actionRef(action), 'idempotent')).toEqual(result);
    expect(port.sends).toBe(1); expect(port.reads).toBe(1);
  } finally { port.send.resolve(verified(outcome)); port.read.resolve(unknown()); await Promise.allSettled([dispatch, reading]); }
});

test('verified read-back also survives a later lost dispatch reply', async () => {
  const port = gatedAdapter(), f = setup([port.adapter]), { actor, action } = prepare(f, port.adapter);
  const dispatch = f.service.work.dispatch(actor, actionRef(action)); await port.sendStarted.promise;
  const reading = f.service.owner.reconcile(f.owner, actionRef(action), 'verified_read');
  try {
    await port.readStarted.promise; port.read.resolve(verified()); expect((await reading).outcome).toBe('succeeded');
    port.send.resolve(unknown()); expect((await dispatch).outcome).toBe('succeeded');
    expect(f.service.owner.inspect(f.owner, actionRef(action)).observation?.basis).toBe('remote_verified');
    expect(f.service.control.usage().unsettled).toBe(0);
  } finally { port.send.resolve(unknown()); port.read.resolve(verified()); await Promise.allSettled([dispatch, reading]); }
});

test('the durable recovery lane permits only one read per action and keeps ordinary admissions separate', async () => {
  const port = gatedAdapter(), f = setup([port.adapter]), { actor, action } = prepare(f, port.adapter);
  port.send.resolve(unknown()); await f.service.work.dispatch(actor, actionRef(action));
  const first = f.service.owner.reconcile(f.owner, actionRef(action), 'first_read');
  await port.readStarted.promise;
  const other = fixture({ path: f.path, create: false, adapters: [port.adapter] }); fixtures.unshift(other);
  const second = other.service.owner.reconcile(other.owner, actionRef(action), 'second_read');
  port.read.resolve(unknown());
  await expect(second).rejects.toThrow('recovery_busy'); await first;
  expect(port.reads).toBe(1); expect(f.service.control.usage().charged.calls).toBe(2); expect(f.service.control.usage().unsettled).toBe(1);
});

test('recovery still refuses exhausted finite call/read budget without another read or charge', async () => {
  const port = gatedAdapter(), f = setup([port.adapter]); f.input.budget!.ceiling.calls = 1; f.input.budget!.concurrency = 1; f.install(); const { actor, action } = prepare(f, port.adapter);
  port.send.resolve(unknown()); await f.service.work.dispatch(actor, actionRef(action));
  await expect(f.service.owner.reconcile(f.owner, actionRef(action), 'out_of_budget')).rejects.toThrow('budget_exhausted');
  expect(port.reads).toBe(0); expect(f.service.control.usage()).toEqual({ charged: bound(), unsettled: 1 });
});

test('finished read settlement commits even if effect observation publication fails', async () => {
  const port = gatedAdapter(), f = setup([port.adapter]), { actor, action } = prepare(f, port.adapter);
  port.send.resolve(unknown()); await f.service.work.dispatch(actor, actionRef(action));
  const db = new Database(f.path, { strict: true });
  try {
    db.exec("CREATE TRIGGER fixture_observation_failure BEFORE INSERT ON observations BEGIN SELECT RAISE(ABORT,'fixture_observation_failure'); END");
    const reading = f.service.owner.reconcile(f.owner, actionRef(action), 'failed_observation');
    await port.readStarted.promise; port.read.resolve(verified());
    await expect(reading).rejects.toThrow('fixture_observation_failure');
    expect(f.service.control.usage().unsettled).toBe(1);
    expect(f.service.owner.inspect(f.owner, actionRef(action)).observation?.outcome).toBe('unknown');
    db.exec('DROP TRIGGER fixture_observation_failure');
    expect((await f.service.owner.reconcile(f.owner, actionRef(action), 'after_fault')).outcome).toBe('succeeded');
    expect(f.service.control.usage()).toEqual({ charged: { ...bound(), calls: 3, reads: 2 }, unsettled: 0 });
  } finally { port.read.resolve(verified()); db.close(); }
});
