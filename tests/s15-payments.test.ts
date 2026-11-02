import { afterEach, describe, expect, test } from 'bun:test';
import { createFixturePaymentAdapter, FixturePaymentPort, parsePaymentAmount, type PaymentQuote, type PaymentScript } from '../src/s15/payments';
import type { Rule, WorkActor } from '../src/s15/policy';
import { actionRef, bound, fixture, ref, rule, type Fixture } from './fixtures/s15-policy';
const fixtures: Fixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const quote = (id = 'invoice', changes: Partial<PaymentQuote> = {}): PaymentQuote => ({ id, version: 'v1', purpose: ref('purpose'), account: ref('account'), payee: ref('payee'), currency: 'USD', amount: '12.34', memo: 'Fixture invoice only', expiresAt: 90000, ...changes });
function setup(scripts: PaymentScript[] = [], hook?: () => Promise<void>) {
  const port = new FixturePaymentPort([quote()], scripts);
  const adapter = createFixturePaymentAdapter({ port, currencies: [{ currency: 'USD', minorUnit: 2 }, { currency: 'JPY', minorUnit: 0 }], upperBound: bound(), ...(hook ? { beforeDispatch: hook } : {}) });
  const f = fixture({ adapters: [adapter] }); fixtures.push(f); f.install();
  const prepare = (w: WorkActor, id = 'invoice', version = 'v1', slot = id) => f.service.work.prepare(w, { slot, adapter: 'fixture_payment', proposal: { quoteId: id, quoteVersion: version } });
  const recurring = (changes: Partial<NonNullable<Rule['recurrence']>> = {}) => {
    const r = rule('rent'); r.mode = 'recurring_payment'; r.recurrence = { payee: ref('payee'), account: ref('account'), currency: 'USD', minorUnit: 2, amountCeilingMinor: '1500', minIntervalMs: 10000, maxPayments: 3, totalCeilingMinor: '4000', startsAt: 0, ...changes };
    const revision = f.service.owner.current(f.owner)!.revision; f.service.owner.approveRecurringRule(f.owner, 'recurring_' + revision, revision, r); return r;
  };
  return { f, port, prepare, recurring };
}
describe('exact financial approval without a real payment provider', () => {
  test('a general invoice/purchase/transfer stays held until final transaction approval', async () => {
    const { f, port, prepare } = setup(), w = f.admit().actor!, p = prepare(w); expect(p.decision).toEqual({ state: 'hold', code: 'approval_required' }); expect(p.action.transaction?.amountMinor).toBe('1234'); expect(port.mutationCalls).toBe(0);
    await expect(f.service.work.dispatch(w, actionRef(p.action))).rejects.toThrow('approval_required'); f.approve(p.action); expect((await f.service.work.dispatch(w, actionRef(p.action))).outcome).toBe('succeeded'); expect(port.mutationCalls).toBe(1);
    await expect(f.service.work.dispatch(w, actionRef(p.action))).rejects.toThrow('already_claimed');
  });
  test('operating compute spend permission is never financial transaction permission', () => {
    const { f, port, prepare } = setup(); f.input.budget!.ceiling.spendMinor = '999999'; f.install(); const w = f.admit().actor!; expect(prepare(w).decision.state).toBe('hold'); expect(port.mutationCalls).toBe(0);
  });
  test.each(['amount', 'payee', 'currency', 'account', 'memo', 'version'] as const)('changing final %s cannot reuse an old approval', field => {
    const { f, port, prepare } = setup(), w = f.admit().actor!, a = prepare(w).action; f.approve(a);
    const q = quote(); if (field === 'amount') q.amount = '12.35'; if (field === 'payee') q.payee = ref('other'); if (field === 'currency') { q.currency = 'JPY'; q.amount = '12'; } if (field === 'account') q.account = ref('repo'); if (field === 'memo') q.memo = 'changed'; if (field === 'version') q.version = 'v2'; port.setQuote(q);
    const next = prepare(w, q.id, q.version).action; expect(next.revision).toBe(a.revision + 1); expect(next.actionHash).not.toBe(a.actionHash); expect(f.service.work.evaluate(w, actionRef(next)).state).toBe('hold'); expect(port.mutationCalls).toBe(0);
  });
  test('stale/expired quote refuses, including quote changes after claim', async () => {
    let change: () => void = () => {};
    const { f, port, prepare } = setup([], async () => change()); const w = f.admit().actor!; expect(() => prepare(w, 'invoice', 'v0')).toThrow('stale_quote'); const a = prepare(w).action; f.approve(a); change = () => port.setQuote(quote('invoice', { version: 'v2' })); const result = await f.service.work.dispatch(w, actionRef(a)); expect(result.outcome).toBe('not_dispatched'); expect(result.code).toBe('stale_quote'); expect(port.mutationCalls).toBe(0);
    port.setQuote(quote('expired', { expiresAt: f.now })); expect(() => prepare(w, 'expired')).toThrow('expired');
  });
  test('unknown/lost response becomes reconcile-only even through a fresh work/slot/restart', async () => {
    const { f, port, prepare } = setup(['lost_response']); const w = f.admit().actor!, a = prepare(w).action; f.approve(a); expect((await f.service.work.dispatch(w, actionRef(a))).outcome).toBe('unknown'); expect(port.mutationCalls).toBe(1); expect(f.service.control.usage().unsettled).toBe(1);
    const second = f.admit().actor!; expect(() => prepare(second, 'invoice', 'v1', 'attempt_two')).toThrow('already_claimed'); f.reopen(); const owner = f.service.owner.authenticate('fixture_owner_session'); const recovered = f.service.control.bindWork(a.workId); await expect(f.service.work.dispatch(recovered, actionRef(a))).rejects.toThrow('already_claimed');
    const result = await f.service.owner.reconcile(owner, actionRef(a), 'read_back'); expect(result.outcome).toBe('succeeded'); expect(result.basis).toBe('remote_verified'); expect(port.reconcileReads).toBe(1); expect(port.mutationCalls).toBe(1); expect(f.service.control.usage().unsettled).toBe(0);
    await expect(f.service.work.dispatch(recovered, actionRef(a))).rejects.toThrow('already_claimed');
  });
  test('ambiguous read-back and owner did-not-occur statements never restore dispatch authority', async () => {
    const { f, port, prepare } = setup(['unknown']); const w = f.admit().actor!, a = prepare(w).action; f.approve(a); await f.service.work.dispatch(w, actionRef(a)); f.service.owner.recordStatement(f.owner, actionRef(a), 'owner_statement', 'did_not_occur'); expect((await f.service.owner.reconcile(f.owner, actionRef(a), 'read_back')).outcome).toBe('unknown'); await expect(f.service.work.dispatch(w, actionRef(a))).rejects.toThrow('already_claimed'); expect(port.mutationCalls).toBe(1);
  });
  test('unsupported currency is never converted or assumed from operating currency', () => {
    const { f, port, prepare } = setup(); port.setQuote(quote('unknown_currency', { currency: 'ZZZ' })); expect(() => prepare(f.admit().actor!, 'unknown_currency')).toThrow('currency_unsupported'); expect(port.mutationCalls).toBe(0);
  });
});
describe('separately approved recurring payment rules', () => {
  test('a recurring rule cannot be smuggled into ordinary policy install', () => {
    const { f, recurring } = setup(); const r = recurring(); const altered = structuredClone(r); altered.recurrence!.amountCeilingMinor = '9000'; const input = { ...f.input, rules: [rule(), altered] }; expect(() => f.service.owner.install(f.owner, 'smuggle', f.service.owner.current(f.owner)!.revision, input)).toThrow('recurring_approval_required');
  });
  test('exact payee/account/currency/ceiling/frequency permits a bounded recurring charge', async () => {
    const { f, port, prepare, recurring } = setup(); recurring(); const w = f.admit().actor!, a = prepare(w); expect(a.decision.state).toBe('allow'); expect((await f.service.work.dispatch(w, actionRef(a.action))).outcome).toBe('succeeded');
    port.setQuote(quote('next')); const early = prepare(w, 'next'); expect(early.decision).toEqual({ state: 'hold', code: 'approval_required' }); f.now += 10000; expect(f.service.work.evaluate(w, actionRef(early.action)).state).toBe('allow'); expect((await f.service.work.dispatch(w, actionRef(early.action))).outcome).toBe('succeeded'); expect(port.mutationCalls).toBe(2);
  });
  test.each(['payee', 'account', 'currency', 'ceiling'] as const)('recurring %s deviation is held for exact approval', field => {
    const { f, port, prepare, recurring } = setup(); recurring(); const q = quote(); if (field === 'payee') q.payee = ref('other'); if (field === 'account') q.account = ref('repo'); if (field === 'currency') { q.currency = 'JPY'; q.amount = '12'; } if (field === 'ceiling') q.amount = '15.01'; port.setQuote(q); expect(prepare(f.admit().actor!).decision).toEqual({ state: 'hold', code: 'approval_required' }); expect(port.mutationCalls).toBe(0);
  });
  test('concurrent distinct invoices atomically reserve frequency, with no extra/early charge', async () => {
    const { f, port, prepare, recurring } = setup(); recurring(); port.setQuote(quote('second')); const w = f.admit().actor!, a = prepare(w).action, b = prepare(w, 'second').action; const results = await Promise.allSettled([f.service.work.dispatch(w, actionRef(a)), f.service.work.dispatch(w, actionRef(b))]); expect(results.filter(r => r.status === 'fulfilled').length).toBe(1); expect(port.mutationCalls).toBe(1); expect(f.service.control.usage().charged.spendMinor).toBe('3');
  });
  test('frequency remains charged after unknown and across reapproval/policy revisions', async () => {
    const { f, port, prepare, recurring } = setup(['unknown']); recurring(); const w = f.admit().actor!, a = prepare(w).action; await f.service.work.dispatch(w, actionRef(a)); recurring(); port.setQuote(quote('second')); const next = prepare(f.admit().actor!, 'second'); expect(next.decision.state).toBe('hold'); expect(port.mutationCalls).toBe(1);
  });
  test.each(['count', 'total'] as const)('finite recurring %s exhaustion is held', async which => {
    const { f, port, prepare, recurring } = setup(); recurring(which === 'count' ? { maxPayments: 1 } : { totalCeilingMinor: '1500' }); const w = f.admit().actor!; await f.service.work.dispatch(w, actionRef(prepare(w).action)); f.now += 10000; port.setQuote(quote('second')); expect(prepare(w, 'second').decision.state).toBe('hold'); expect(port.mutationCalls).toBe(1);
  });
});
describe('money precision', () => {
  test.each([['12.34', 2, '1234'], ['12.3', 2, '1230'], ['12', 0, '12'], ['0.01', 2, '1']])('parses %s at precision %s exactly', (amount, precision, expected) => expect(parsePaymentAmount(amount, precision as number)).toBe(expected as string));
  test.each(['01.00', '-1', '1e2', '1.001', '0', '0.00', ' 1.00', '+1', 'NaN', '1.', '.1'])('rejects invalid decimal %s', amount => expect(() => parsePaymentAmount(amount, 2)).toThrow());
  test('rejects float input and a currency precision mismatch', () => { expect(() => parsePaymentAmount(12.34, 2)).toThrow('invalid_amount'); expect(() => parsePaymentAmount('12.34', 0)).toThrow('amount_precision'); });
});

test('current owner can reconcile a prior payment after originating work expires', async () => {
  const { f, port, prepare } = setup(['lost_response']); const w = f.admit({ expiresAt: 10000 }).actor!, a = prepare(w).action; f.service.owner.decide(f.owner, { requestId: 'approve_short_work', action: actionRef(a), decision: 'approve', expiresAt: 9999 }); await f.service.work.dispatch(w, actionRef(a)); f.now = 10000; expect((await f.service.owner.reconcile(f.owner, actionRef(a), 'read_after_work_expiry')).outcome).toBe('succeeded'); expect(port.mutationCalls).toBe(1); await expect(f.service.work.dispatch(w, actionRef(a))).rejects.toThrow('expired');
});

test('unknown obligation cannot be cloned to a different account under a fresh work', async () => {
  const { f, port, prepare } = setup(['unknown']); const w = f.admit().actor!, a = prepare(w).action; f.approve(a); await f.service.work.dispatch(w, actionRef(a)); port.setQuote(quote('invoice', { account: ref('repo'), version: 'v2' })); const next = f.admit().actor!; expect(() => prepare(next, 'invoice', 'v2')).toThrow('already_claimed'); expect(port.mutationCalls).toBe(1);
});
test('overlapping recurring rules remain ambiguous even when only one has remaining frequency', async () => {
  const { f, port, prepare, recurring } = setup(); const first = recurring(); const w = f.admit().actor!; await f.service.work.dispatch(w, actionRef(prepare(w).action)); const second = structuredClone(first); second.id = 'other_rent'; f.service.owner.approveRecurringRule(f.owner, 'other_recurring', f.service.owner.current(f.owner)!.revision, second); port.setQuote(quote('second')); expect(prepare(f.admit().actor!, 'second').decision).toEqual({ state: 'hold', code: 'ambiguous_rule' });
});
