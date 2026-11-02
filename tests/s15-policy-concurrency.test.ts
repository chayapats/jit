import { afterEach, expect, test } from 'bun:test';
import { actionRef, bound, fixture, ref, rule, selection, type Fixture } from './fixtures/s15-policy';
import { createFixturePaymentAdapter, FixturePaymentPort, type PaymentQuote } from '../src/s15/payments';
const fixtures: Fixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
function worker(command: object) {
  const child = Bun.spawn([process.execPath, new URL('./fixtures/s15-policy-worker.ts', import.meta.url).pathname, Buffer.from(JSON.stringify(command)).toString('base64')], { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' });
  const reader = child.stdout.getReader(); let buffered = '';
  const line = async (): Promise<string> => { while (!buffered.includes('\n')) { const r = await reader.read(); if (r.done) throw new Error('worker ended: ' + await new Response(child.stderr).text()); buffered += new TextDecoder().decode(r.value); } const end = buffered.indexOf('\n'), result = buffered.slice(0, end); buffered = buffered.slice(end + 1); return result; };
  return { child, line, go() { child.stdin.write('go\n'); child.stdin.flush(); } };
}
test('two protected processes atomically reserve a finite operating ceiling', async () => {
  const f = fixture(); fixtures.push(f); f.input.budget!.ceiling.spendMinor = '3'; f.install(); const work = f.admit().receipt.work!;
  const workers = ['one', 'two'].map(id => worker({ path: f.path, workId: work.id, mode: 'reserve', model: { requestId: id, selection, upperBound: bound() } }));
  try { expect(await Promise.all(workers.map(w => w.line()))).toEqual(['ready', 'ready']); workers.forEach(w => w.go()); const results = (await Promise.all(workers.map(w => w.line()))).map(x => JSON.parse(x)); expect(results.map(r => r.state).sort()).toEqual(['budget_exhausted', 'reserved']); expect(f.service.control.usage().charged.spendMinor).toBe('3'); expect(f.service.control.usage().unsettled).toBe(1); }
  finally { workers.forEach(w => w.child.stdin.end()); await Promise.all(workers.map(w => w.child.exited)); }
});
test('two protected processes claim one exact effect once before dispatch', async () => {
  const f = fixture(); fixtures.push(f); f.install(); const { receipt, actor } = f.admit(), a = f.prepare(actor!).action;
  const workers = [1, 2].map(() => worker({ path: f.path, workId: receipt.work!.id, mode: 'dispatch', action: actionRef(a) }));
  try { await Promise.all(workers.map(w => w.line())); workers.forEach(w => w.go()); const results = (await Promise.all(workers.map(w => w.line()))).map(x => JSON.parse(x)); expect(results.map(r => r.state).sort()).toEqual(['already_claimed', 'succeeded']); expect(results.reduce((sum, r) => sum + r.calls, 0)).toBe(1); expect(f.service.control.usage().charged.spendMinor).toBe('3'); }
  finally { workers.forEach(w => w.child.stdin.end()); await Promise.all(workers.map(w => w.child.exited)); }
});
test('crash after durable claim but before I/O remains unknown and cannot recreate a dispatch context', async () => {
  const f = fixture(); fixtures.push(f); f.install(); const { actor } = f.admit(), a = f.prepare(actor!).action;
  const w = worker({ path: f.path, workId: a.workId, mode: 'crash_before', action: actionRef(a) });
  try { expect(await w.line()).toBe('ready'); w.go(); expect(await w.line()).toBe('claimed'); w.child.kill('SIGKILL'); await w.child.exited; expect(f.service.owner.inspect(f.owner, actionRef(a)).observation?.outcome).toBe('unknown'); expect(f.service.control.usage().unsettled).toBe(1); await expect(f.service.work.dispatch(actor!, actionRef(a))).rejects.toThrow('already_claimed'); expect(f.calls).toBe(0); }
  finally { w.child.kill(); await w.child.exited; }
});
test('two processes reserve recurring frequency for distinct invoices under the same rule', async () => {
  const quotes: PaymentQuote[] = ['first', 'second'].map(id => ({ id, version: 'v1', purpose: ref('purpose'), account: ref('account'), payee: ref('payee'), currency: 'USD', amount: '12.34', memo: 'fixture', expiresAt: 90000 }));
  const port = new FixturePaymentPort(quotes), f = fixture({ adapters: [createFixturePaymentAdapter({ port, currencies: [{ currency: 'USD', minorUnit: 2 }], upperBound: bound() })] }); fixtures.push(f); f.install();
  const r = rule('rent'); r.mode = 'recurring_payment'; r.recurrence = { payee: ref('payee'), account: ref('account'), currency: 'USD', minorUnit: 2, amountCeilingMinor: '1500', minIntervalMs: 10000, maxPayments: 3, totalCeilingMinor: '4000', startsAt: 0 }; f.service.owner.approveRecurringRule(f.owner, 'recurring', 1, r);
  const { actor, receipt } = f.admit(); const actions = quotes.map(q => f.service.work.prepare(actor!, { slot: q.id, adapter: 'fixture_payment', proposal: { quoteId: q.id, quoteVersion: q.version } }).action);
  const workers = actions.map(a => worker({ path: f.path, workId: receipt.work!.id, mode: 'dispatch', action: actionRef(a), quotes }));
  try { await Promise.all(workers.map(w => w.line())); workers.forEach(w => w.go()); const results = (await Promise.all(workers.map(w => w.line()))).map(x => JSON.parse(x)); expect(results.map(r => r.state).sort()).toEqual(['approval_required', 'succeeded']); expect(results.reduce((sum, r) => sum + r.calls, 0)).toBe(1); }
  finally { workers.forEach(w => w.child.stdin.end()); await Promise.all(workers.map(w => w.child.exited)); }
});

test('crash after one fixture payment send but before response is unknown and never replayed', async () => {
  const quotes: PaymentQuote[] = [{ id: 'invoice', version: 'v1', purpose: ref('purpose'), account: ref('account'), payee: ref('payee'), currency: 'USD', amount: '12.34', memo: 'fixture', expiresAt: 90000 }];
  const port = new FixturePaymentPort(quotes), f = fixture({ adapters: [createFixturePaymentAdapter({ port, currencies: [{ currency: 'USD', minorUnit: 2 }], upperBound: bound() })] }); fixtures.push(f); f.install(); const { actor } = f.admit(), a = f.service.work.prepare(actor!, { slot: 'invoice', adapter: 'fixture_payment', proposal: { quoteId: 'invoice', quoteVersion: 'v1' } }).action; f.approve(a);
  const w = worker({ path: f.path, workId: a.workId, mode: 'crash_after', action: actionRef(a), quotes });
  try { expect(await w.line()).toBe('ready'); w.go(); expect(await w.line()).toBe('sent:1'); w.child.kill('SIGKILL'); await w.child.exited; expect(f.service.owner.inspect(f.owner, actionRef(a)).observation?.outcome).toBe('unknown'); await expect(f.service.work.dispatch(actor!, actionRef(a))).rejects.toThrow('already_claimed'); expect(f.service.control.usage().unsettled).toBe(1); }
  finally { w.child.kill(); await w.child.exited; }
});

test('two processes cannot over-reserve the same work read bound', async () => {
  const f = fixture({ reads: [{ operation: 'read', validate() {} }] }); fixtures.push(f); f.install(); const work = f.admit({ intent: 'inspect', access: 'read', readLimit: 1 }).receipt.work!;
  const workers = ['first', 'second'].map(id => worker({ path: f.path, workId: work.id, mode: 'reserve_read', read: { requestId: id, resource: ref('account'), operation: 'read', exactPayload: { path: '/workspace/evidence' }, upperBound: { attempts: 0, steps: 0, calls: 0, reads: 1, outputBytes: 0, activeMs: 0, spendMinor: '0' }, fences: [] } }));
  try { await Promise.all(workers.map(w => w.line())); workers.forEach(w => w.go()); const results = (await Promise.all(workers.map(w => w.line()))).map(x => JSON.parse(x)); expect(results.map(r => r.state).sort()).toEqual(['read_bound_exhausted', 'reserved']); expect(f.service.control.usage().charged.reads).toBe(1); }
  finally { workers.forEach(w => w.child.stdin.end()); await Promise.all(workers.map(w => w.child.exited)); }
});
