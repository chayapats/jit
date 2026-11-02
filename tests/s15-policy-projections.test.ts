import { afterEach, expect, test } from 'bun:test';
import type { WorkActor } from '../src/s15/policy';
import { canonical } from '../src/s15/policy/validation';
import { actionRef, bound, fixture, held, ref, selection, type Fixture } from './fixtures/s15-policy';
import { createFixturePaymentAdapter, FixturePaymentPort, type PaymentQuote } from '../src/s15/payments';
const fixtures: Fixture[] = [];
const setup = () => { const f = fixture(); fixtures.push(f); f.install(); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

test('first-run proposal leaves every unconfigured finite field blank and cannot install', () => {
  const f = fixture(); fixtures.push(f); const proposal = f.service.owner.proposePolicy(f.owner, null); expect(proposal.installable).toBe(false); expect(proposal.fields.every(f => f.value === null)).toBe(true); expect(proposal.rows.find(r => r.id === 'github_personal')?.mode).toBe('off'); expect(() => f.service.owner.installProposal(f.owner, 'install', proposal.proposalHash)).toThrow('proposal_incomplete'); expect(f.service.owner.current(f.owner)).toBeNull();
});
test('policy install consumes the exact protected proposal hash and deduplicates after restart', () => {
  const f = fixture(); fixtures.push(f); const proposal = f.service.owner.proposePolicy(f.owner, f.input); expect(proposal.installable).toBe(true); expect(proposal.fields.find(x => x.path === 'budget.ceiling.spendMinor')?.value).toBe('100'); const installed = f.service.owner.installProposal(f.owner, 'install_proposal', proposal.proposalHash); expect(installed.revision).toBe(1); f.reopen(); const owner = f.service.owner.authenticate('fixture_owner_session'); expect(f.service.owner.installProposal(owner, 'install_proposal', proposal.proposalHash)).toEqual(installed); expect(() => f.service.owner.installProposal(owner, 'install_again', proposal.proposalHash)).toThrow('stale_policy');
});
test('altered proposal fields produce a different hash and a forged hash cannot install', () => {
  const f = fixture(); fixtures.push(f); const one = f.service.owner.proposePolicy(f.owner, f.input); f.input.budget!.ceiling.spendMinor = '101'; const two = f.service.owner.proposePolicy(f.owner, f.input); expect(two.proposalHash).not.toBe(one.proposalHash); expect(() => f.service.owner.installProposal(f.owner, 'forged', 'a'.repeat(64))).toThrow('proposal_incomplete');
});
test('ActionSlip exposes exact complete payload bytes, hashes, revision, expiry and reason', () => {
  const f = setup(), w = f.admit().actor!; held(f, 'send', ['communication']); const a = f.prepare(w).action, slip = f.service.owner.actionSlip(f.owner, actionRef(a)); expect(slip.state).toBe('pending'); expect(slip.reasonCode).toBe('approval_required'); expect(slip.canApprove).toBe(true); expect(Buffer.from(slip.payloadBytesBase64, 'base64').toString()).toBe(canonical(a.payload)); expect(slip.action).toEqual(a); expect(slip.expiresAt).toBe(a.expiresAt); f.approve(a); expect(f.service.owner.actionSlip(f.owner, actionRef(a)).state).toBe('approved');
});
test('changed ActionSlip retains old exact bytes and points to the new revision', () => {
  const f = setup(), w = f.admit().actor!; held(f, 'send', ['communication']); const a = f.prepare(w).action; f.approve(a); f.draft.payload = { body: 'changed' }; const newer = f.prepare(w).action, slip = f.service.owner.actionSlip(f.owner, actionRef(a)); expect(slip.state).toBe('changed'); expect(slip.canApprove).toBe(false); expect(slip.replacement).toEqual(actionRef(newer)); expect(slip.action.payload).toEqual(a.payload);
});
test('ActionSlip shows verified/unknown outcomes and owner statements separately', async () => {
  const f = setup(), w = f.admit().actor!, a = f.prepare(w).action; await f.service.work.dispatch(w, actionRef(a)); const success = f.service.owner.actionSlip(f.owner, actionRef(a)); expect(success.state).toBe('succeeded'); expect(success.reasonCode).toBeNull(); f.service.owner.recordStatement(f.owner, actionRef(a), 'statement', 'did_not_occur'); const slip = f.service.owner.actionSlip(f.owner, actionRef(a)); expect(slip.state).toBe('succeeded'); expect(slip.statements).toEqual([{ outcome: 'did_not_occur' }]);
});
test('expired and stale-rule slips cannot offer approval', () => {
  const f = setup(), w = f.admit().actor!; held(f, 'send', ['communication']); const a = f.prepare(w).action; f.now = a.expiresAt; expect(f.service.owner.actionSlip(f.owner, actionRef(a)).state).toBe('expired'); f.now = 1000; f.install(); const stale = f.service.owner.actionSlip(f.owner, actionRef(a)); expect(stale.state).toBe('stale_rules'); expect(stale.canApprove).toBe(false);
});
test('withdrawn lineage cannot be recovered through an exact-payload projection', () => {
  const f = setup(), w = f.admit().actor!; f.draft.fences = [{ kind: 'lineage', ref: ref('source') }]; const a = f.prepare(w).action; f.catalog.get('lineage:source')!.active = false; expect(() => f.service.owner.actionSlip(f.owner, actionRef(a))).toThrow('lineage_withdrawn');
});
test('chat decision only resolves one current pending action, not a stale last-presented revision', () => {
  const f = setup(), w = f.admit().actor!; held(f, 'send', ['communication']); const a = f.prepare(w, 'first').action, b = f.prepare(w, 'second').action; const input = { requestId: 'chat_approve', workIds: [a.workId], seen: actionRef(a), decision: 'approve' as const, expiresAt: 80000 }; expect(() => f.service.owner.decidePending(f.owner, input)).toThrow('approval_reference_required'); expect(f.service.work.evaluate(w, actionRef(a)).state).toBe('hold');
  f.approve(b, 'deny'); f.draft.payload = { body: 'changed after presentation' }; const newer = f.prepare(w, 'first').action; expect(() => f.service.owner.decidePending(f.owner, input)).toThrow('stale_action'); f.service.owner.decidePending(f.owner, { ...input, seen: actionRef(newer) }); expect(f.service.work.evaluate(w, actionRef(newer)).state).toBe('allow'); expect(f.calls).toBe(0);
});
test('recurring deviation slip includes the exact rule and every changed transaction field', () => {
  const q: PaymentQuote = { id: 'invoice', version: 'v1', purpose: ref('purpose'), account: ref('account'), payee: ref('payee'), currency: 'USD', amount: '12.34', memo: 'fixture', expiresAt: 90000 }, port = new FixturePaymentPort([q]);
  const f = fixture({ adapters: [createFixturePaymentAdapter({ port, currencies: [{ currency: 'USD', minorUnit: 2 }], upperBound: bound() })] }); fixtures.push(f); f.install(); const r = structuredClone(f.input.rules[0]!); r.id = 'recurring'; r.mode = 'recurring_payment'; r.recurrence = { payee: ref('payee'), account: ref('account'), currency: 'USD', minorUnit: 2, amountCeilingMinor: '1000', minIntervalMs: 10000, maxPayments: 3, totalCeilingMinor: '3000', startsAt: 0 }; f.service.owner.approveRecurringRule(f.owner, 'recurring', 1, r); const w = f.admit().actor!, a = f.service.work.prepare(w, { slot: 'invoice', adapter: 'fixture_payment', proposal: { quoteId: 'invoice', quoteVersion: 'v1' } }).action; const slip = f.service.owner.actionSlip(f.owner, actionRef(a)); expect(slip.recurring[0]?.deviations).toEqual(['amount_ceiling']); expect(slip.recurring[0]?.rule).toEqual(r); expect(slip.action.transaction?.amountMinor).toBe('1234');
});
test('pre-retrieval bootstrap is inference-only, one call/no tools and cannot admit itself as business work', () => {
  const f = setup(); f.add('purpose', ref('interpretation')); f.input.purposes.push(ref('interpretation')); f.input.interpretationPurpose = ref('interpretation'); f.install(); const input = { requestId: 'interpret_owner_message', selection, expiresAt: 90000 }, prepared = f.service.owner.prepareInterpretation(f.owner, input); expect(f.service.owner.prepareInterpretation(f.owner, input)).toEqual(prepared); expect(prepared.purposes).toEqual([ref('purpose')]); expect(prepared.authority.mode).toBe('interpretation'); expect(prepared.authority.request.resources).toEqual([]); expect(prepared.authority.request.recipients).toEqual([]); const actor = f.service.control.bindWork(prepared.authority.id); expect(() => f.prepare(actor)).toThrow('outside_scope'); const reservation = f.service.work.reserveModelCall(actor, { requestId: 'bootstrap', selection, upperBound: bound() }); expect(f.service.work.guardReservation(actor, reservation.id).id).toBe(reservation.id); expect(() => f.service.work.reserveModelCall(actor, { requestId: 'second_bootstrap', selection, upperBound: bound() })).toThrow('interpretation_call_claimed'); expect(() => f.admit({ purpose: ref('interpretation') })).toThrow('outside_scope'); expect(f.admit().receipt.work?.mode).toBe('work');
});
test('bootstrap cannot invent an interpretation purpose or acquire reads through its cost bound', () => {
  const f = setup(); expect(() => f.service.owner.prepareInterpretation(f.owner, { requestId: 'interpret', selection, expiresAt: 90000 })).toThrow('interpretation_policy_required'); f.input.interpretationPurpose = ref('purpose'); f.install(); const prepared = f.service.owner.prepareInterpretation(f.owner, { requestId: 'interpret', selection, expiresAt: 90000 }), actor: WorkActor = f.service.control.bindWork(prepared.authority.id); expect(() => f.service.work.reserveModelCall(actor, { requestId: 'read', selection, upperBound: { ...bound(), reads: 1 } })).toThrow('interpretation_call_claimed');
});

test('duplicate chat approval returns its original receipt even after the action stops being pending', () => {
  const f = setup(), w = f.admit().actor!; held(f, 'send', ['communication']); const a = f.prepare(w).action, input = { requestId: 'chat_approve', workIds: [a.workId], seen: actionRef(a), decision: 'approve' as const, expiresAt: 80000 }; f.service.owner.decidePending(f.owner, input); f.service.owner.decidePending(f.owner, input); expect(f.service.work.evaluate(w, actionRef(a)).state).toBe('allow'); expect(() => f.service.owner.decidePending(f.owner, { ...input, decision: 'deny' })).toThrow('request_id_conflict');
});

test('a live ActionSlip executes without offering another owner decision', async () => {
  const f = setup(), w = f.admit().actor!, a = f.prepare(w).action; let release!: () => void; f.before = () => new Promise<void>(resolve => { release = resolve; }); const run = f.service.work.dispatch(w, actionRef(a)); const during = f.service.owner.actionSlip(f.owner, actionRef(a)); expect(during.state).toBe('executing'); expect(during.canApprove).toBe(false); expect(during.reasonCode).toBeNull(); release(); await run; expect(f.service.owner.actionSlip(f.owner, actionRef(a)).state).toBe('succeeded');
});

test('bare decisions isolate withdrawn sibling payloads but cannot select the withdrawn action', () => {
  const f = setup(), w = f.admit().actor!; held(f, 'send', ['communication']);
  f.draft.fences = [{ kind: 'lineage', ref: ref('source') }]; const old = f.prepare(w, 'old').action;
  f.draft.fences = []; const current = f.prepare(w, 'current').action; f.catalog.get('lineage:source')!.active = false;
  const input = { requestId: 'chat_current', workIds: [current.workId], seen: actionRef(current), decision: 'approve' as const, expiresAt: 80000 };
  expect(() => f.service.owner.decidePending(f.owner, { ...input, requestId: 'withdrawn', seen: actionRef(old) })).toThrow('stale_action');
  expect(() => f.service.owner.decide(f.owner, { requestId: 'exact_withdrawn', action: actionRef(old), decision: 'approve', expiresAt: 80000 })).toThrow('authority_revoked');
  f.service.owner.decidePending(f.owner, input); expect(f.service.work.evaluate(w, actionRef(current)).state).toBe('allow'); expect(f.calls).toBe(0);
});
