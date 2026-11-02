import { afterEach, expect, test } from 'bun:test';
import { openWorkService, type ResponsibilityEvent, type ResponsibilityPort } from '../src/s15/work';
import { modelWorkFixture, observed, ref } from './fixtures/s15-model-work';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });
const event = (eventId: string, extra: Partial<ResponsibilityEvent> = {}): ResponsibilityEvent => ({ eventId, kind: 'ci', key: 'head_1', purposeId: 'purpose', resourceIds: ['repo'], subject: 'issue:42', evidenceRefs: ['check_evidence'], ...extra });
const assignment = (sourceRequestId = 'source') => ({ requestId: 'assign_' + sourceRequestId, sourceRequestId, completion: 'Selected issue acceptance and exact-head checks pass.', triggers: ['ci', 'review', 'owner', 'assigned'] as ResponsibilityEvent['kind'][], stallPolicy: { noProgressApproaches: 3, reserveCalls: 1, maxAttempts: 8 } });
function setup() {
  const f = modelWorkFixture(); cleanups.push(() => f.cleanup()); const source = f.source('source');
  let service = openWorkService(f.workOptions()); cleanups.push(() => service.close());
  const responsibility = service.assign(f.owner, assignment());
  return { f, source, responsibility, get service() { return service; }, reopen() { service.close(); service = openWorkService({ ...f.workOptions(), create: false }); },
    next(eventId: string) { return service.observeEvent(responsibility.id, event(eventId, { kind: 'assigned' })); } };
}

test('authenticated assignment dedupes original conversation, and acceptance never authorizes an attempt', () => {
  const { f, service, responsibility } = setup();
  expect(service.assign(f.owner, assignment())).toEqual(responsibility);
  f.source('accepted', { intent: 'accept_obligation', access: 'read' });
  const accepted = service.assign(f.owner, assignment('accepted')); expect(accepted).toMatchObject({ state: 'accepted', workId: null });
  expect(() => service.beginAttempt(accepted.id, { eventId: 'accepted', approach: 'must not start' })).toThrow('execution_not_authorized');
  expect(() => service.assign({} as never, assignment())).toThrow('authentication_required');
  expect(f.policy.control.reservations()).toHaveLength(0);
});

test('an interrupted or still-running CHAT source cannot be rebound as a fresh ready responsibility', () => {
  const { f, service } = setup(); f.source('interrupted'); f.sources.get('interrupted')!.state = 'reconcile_only';
  expect(() => service.assign(f.owner, assignment('interrupted'))).toThrow('source_reconciliation_required');
  f.source('active'); f.sources.get('active')!.state = 'running';
  expect(() => service.assign(f.owner, assignment('active'))).toThrow('source_reconciliation_required');
});

test('two responsibilities cannot share one POLICY authority and defeat the scoped stop boundary', () => {
  const { f, source, service } = setup(); f.source('alias'); f.sources.get('alias')!.authority = source.record.authority;
  expect(() => service.assign(f.owner, assignment('alias'))).toThrow('responsibility_exists');
});

test('CI wait survives disconnect/restart without VM/model capacity; exact event starts one next attempt', () => {
  const f = setup(), { responsibility: r } = f;
  const handle = f.service.beginAttempt(r.id, { eventId: 'source', approach: 'Implement selected scope' });
  expect(() => f.service.wait(r.id, { requestId: 'premature', kind: 'ci', key: 'head_1', evidenceRefs: [] })).toThrow('settlement_required');
  f.service.settle(handle, observed({ progress: 'made' }));
  f.service.wait(r.id, { requestId: 'wait', kind: 'ci', key: 'head_1', evidenceRefs: ['head_evidence'] });
  f.f.advance(100000); f.reopen();
  expect(f.service.project(f.f.owner, r.id)).toMatchObject({ state: 'waiting', wait: { kind: 'ci', key: 'head_1' }, resumedAfterRestart: true, stopImpact: { heldAttempts: [] } });
  expect(f.service.observeEvent(r.id, event('wrong_head', { key: 'other_head' })).state).toBe('waiting');
  expect(f.service.observeEvent(r.id, event('ci_pass')).state).toBe('ready');
  const next = f.service.beginAttempt(r.id, { eventId: 'ci_pass', approach: 'Verify passing checks' }); f.service.guard(next);
  expect(() => f.service.beginAttempt(r.id, { eventId: 'ci_pass', approach: 'duplicate' })).toThrow('attempt_not_ready');
  f.service.observeEvent(r.id, event('ci_pass')); expect(f.service.project(f.f.owner, r.id).attempts).toHaveLength(2);
  expect(f.f.policy.control.usage().unsettled).toBe(0);
});

test('owner and review waits do not count as stalls even after a long fake-clock interval', () => {
  const f = setup(), { responsibility: r } = f;
  f.service.wait(r.id, { requestId: 'wait', kind: 'review', key: 'review_1', evidenceRefs: [] });
  f.f.advance(200000); expect(f.service.project(f.f.owner, r.id)).toMatchObject({ state: 'waiting', report: null, attempts: [] });
  f.service.observeEvent(r.id, event('review', { kind: 'review', key: 'review_1' }));
  f.service.wait(r.id, { requestId: 'owner_wait', kind: 'owner', key: 'approval_1', evidenceRefs: [] });
  expect(f.service.project(f.f.owner, r.id)).toMatchObject({ state: 'waiting', wait: { kind: 'owner' }, report: null });
});

test('distinct no-progress approaches produce an evidence-rich paused report while unrelated work continues', () => {
  const f = setup(), { responsibility: r } = f;
  for (let i = 0; i < 3; i++) {
    if (i) f.next('event_' + i);
    const handle = f.service.beginAttempt(r.id, { eventId: i ? 'event_' + i : 'source', approach: 'Approach ' + i });
    f.service.settle(handle, observed({ evidenceRefs: ['evidence_' + i] }));
  }
  const view = f.service.project(f.f.owner, r.id); expect(view.state).toBe('paused');
  expect(view.report).toMatchObject({ code: 'no_progress', otherAuthorizedWorkContinues: true }); expect(view.report!.attempts).toHaveLength(3);
  expect(view.report!.attempts[2]!.evidenceRefs).toEqual(['evidence_2']); expect(view.report!.recommendation).toContain('Inspect');
  f.f.source('other'); const other = f.service.assign(f.f.owner, assignment('other'));
  expect(() => f.service.beginAttempt(other.id, { eventId: 'other', approach: 'Independent selected responsibility' })).not.toThrow();
});

test('verified progress resets the no-progress sequence; repeating one approach is bounded by maxAttempts', () => {
  const f = setup(), { responsibility: r } = f;
  for (let i = 0; i < 5; i++) {
    if (i) f.next('event_' + i);
    const handle = f.service.beginAttempt(r.id, { eventId: i ? 'event_' + i : 'source', approach: i === 4 ? 'repeat' : 'method_' + i });
    f.service.settle(handle, observed({ progress: i === 2 ? 'made' : 'none' }));
  }
  expect(f.service.project(f.f.owner, r.id).state).toBe('ready');
  const second = setup();
  for (let i = 0; i < 8; i++) {
    if (i) second.next('same_' + i);
    const handle = second.service.beginAttempt(second.responsibility.id, { eventId: i ? 'same_' + i : 'source', approach: 'repeat' }); second.service.settle(handle, observed());
  }
  expect(second.service.project(second.f.owner, second.responsibility.id).report?.code).toBe('attempt_limit');
});

test('call headroom pauses before another attempt spends the final reserved call', () => {
  const f = modelWorkFixture(); cleanups.push(() => f.cleanup()); f.source('source');
  const service = openWorkService({ ...f.workOptions(), remainingCalls: () => 1 }); cleanups.push(() => service.close()); const r = service.assign(f.owner, assignment());
  expect(() => service.beginAttempt(r.id, { eventId: 'source', approach: 'would exhaust' })).toThrow('work_paused');
  expect(service.project(f.owner, r.id)).toMatchObject({ state: 'paused', report: { code: 'budget_headroom' }, attempts: [] });
});

test('outside-purpose and unselected-issue findings become proposals and cannot replace assigned work', () => {
  const { f, service, responsibility: r } = setup();
  expect(service.observeEvent(r.id, event('outside', { purposeId: 'outside', subject: 'issue:99' }))).toMatchObject({ state: 'ready', subject: 'issue:42', proposals: [{ eventId: 'outside', code: 'outside_purpose' }] });
  expect(() => service.beginAttempt(r.id, { eventId: 'outside', approach: 'Implement different issue' })).toThrow('attempt_not_ready');
  expect(service.project(f.owner, r.id).attempts).toHaveLength(0);
});

test('restart makes an active attempt unknown; read-only reconciliation never recreates its handle or effects', () => {
  const f = setup(), r = f.responsibility, handle = f.service.beginAttempt(r.id, { eventId: 'source', approach: 'Pending external operation' }); f.reopen();
  expect(f.service.project(f.f.owner, r.id)).toMatchObject({ state: 'reconcile_only', attempts: [{ state: 'unknown', capacityHeld: true, publicationFenced: true }] });
  expect(() => f.service.guard(handle)).toThrow('attempt_context_lost');
  expect(() => f.service.beginAttempt(r.id, { eventId: 'source', approach: 'retry unknown' })).toThrow('attempt_not_ready');
  const attempt = f.service.project(f.f.owner, r.id).attempts[0]!;
  expect(f.service.reconcile(r.id, attempt.id, observed({ effects: 'unknown' })).state).toBe('reconcile_only');
  expect(f.service.reconcile(r.id, attempt.id, observed({ progress: 'made' })).state).toBe('ready');
  expect(f.service.project(f.f.owner, r.id).attempts).toHaveLength(1);
});

test('scoped stop retains execution capacity until actual settlement and blocks late results', () => {
  const { f, service, responsibility: r } = setup(); f.source('other'); const other = service.assign(f.owner, assignment('other'));
  const handle = service.beginAttempt(r.id, { eventId: 'source', approach: 'Original operation' });
  expect(service.stop(f.owner, r.id, 'stop')).toMatchObject({ state: 'stopping' });
  expect(service.project(f.owner, r.id).stopImpact).toMatchObject({ responsibilityIds: [r.id], otherResponsibilities: 1 });
  expect(() => service.guard(handle)).toThrow('stopped');
  expect(service.settle(handle, observed({ transportSettled: true, executionSettled: false, effects: 'unknown' })).state).toBe('stopping');
  const attemptId = service.project(f.owner, r.id).attempts[0]!.id;
  expect(service.reconcile(r.id, attemptId, observed({ progress: 'made', complete: true })).state).toBe('stopped');
  expect(() => service.publish(handle, () => { throw Error('late publication'); })).toThrow('stopped');
  expect(() => service.beginAttempt(other.id, { eventId: 'other', approach: 'Continue unrelated work' })).not.toThrow();
});

test('progress and completion need evidence; model or cancellation claims cannot certify settlement', () => {
  const { f, service, responsibility: r } = setup(); const handle = service.beginAttempt(r.id, { eventId: 'source', approach: 'Original work' });
  expect(() => service.settle(handle, observed({ progress: 'made', evidenceRefs: [] }))).toThrow('progress_evidence_required');
  expect(() => service.settle(handle, observed({ progress: 'made', executionSettled: false, complete: true }))).toThrow('completion_evidence_required');
  service.settle(handle, observed({ progress: 'made', complete: true })); let published = false;
  service.publish(handle, () => { published = true; }); expect(published).toBe(true); expect(service.project(f.owner, r.id).state).toBe('completed');
});

test('work usage projection reports unknown parts without converting them to zero', () => {
  const { f, source, service, responsibility: r } = setup();
  const reservation = f.policy.work.reserveModelCall(source.actor!, { requestId: 'call', selection: source.authority!.request.selection, upperBound: { attempts: 1, steps: 1, calls: 1, reads: 0, outputBytes: 100, activeMs: 100, spendMinor: '3' } });
  f.policy.control.settleReservation(reservation.id, observed().usage, true);
  const view = service.project(f.owner, r.id); expect(view.budget.measured.spendMinor).toBeNull(); expect(view.budget.unknown).toContain('spendMinor'); expect(view.budget.charged.spendMinor).toBe('3');
});

test('scoped stop aborts the original attempt signal once and leaves another responsibility live', () => {
  const { f, service, responsibility: r } = setup(); f.source('other'); const other = service.assign(f.owner, assignment('other'));
  const first = service.beginAttempt(r.id, { eventId: 'source', approach: 'First scope' }), second = service.beginAttempt(other.id, { eventId: 'other', approach: 'Other scope' });
  let aborts = 0; service.signal(first).addEventListener('abort', () => aborts++);
  service.stop(f.owner, r.id, 'stop'); service.stop(f.owner, r.id, 'stop');
  expect(aborts).toBe(1); expect(service.signal(first).aborted).toBe(true); expect(service.signal(second).aborted).toBe(false);
});

test('rejected reconciliation cannot erase known transport, execution, usage or evidence facts', () => {
  const { f, service, responsibility: r } = setup(), handle = service.beginAttempt(r.id, { eventId: 'source', approach: 'Observed scope' });
  service.settle(handle, observed({ executionSettled: false, effects: 'unknown', progress: 'made' }));
  const before = service.project(f.owner, r.id).attempts[0]!;
  expect(() => service.reconcile(r.id, before.id, observed({ transportSettled: false, executionSettled: true, effects: 'known', progress: 'made' }))).toThrow('settlement_conflict');
  expect(service.project(f.owner, r.id).attempts[0]).toEqual(before);
  expect(service.reconcile(r.id, before.id, observed({ progress: 'made' })).state).toBe('ready');
});

test('only a fresh authenticated same-scope instruction resumes a stall, preserving original authority and report', () => {
  const f = setup(), r = f.responsibility;
  for (let i = 0; i < 3; i++) { if (i) f.next('event_' + i); const handle = f.service.beginAttempt(r.id, { eventId: i ? 'event_' + i : 'source', approach: 'method_' + i }); f.service.settle(handle, observed()); }
  expect(f.service.observeEvent(r.id, event('new_ci')).state).toBe('paused');
  f.f.advance(1); f.f.source('resume'); const resumed = f.service.resume(f.f.owner, r.id, 'resume');
  expect(resumed).toMatchObject({ state: 'ready', workId: r.workId, readyEventId: 'resume', report: { code: 'no_progress' } });
  expect(() => f.service.beginAttempt(r.id, { eventId: 'resume', approach: 'Fresh owner-approved approach' })).not.toThrow();
  expect(() => f.service.resume({} as never, r.id, 'resume')).toThrow('authentication_required');
});

test('resume rejects pre-pause instructions across restart and stopped or revoked fresh CHAT work', () => {
  const f = setup(), r = f.responsibility;
  f.f.source('older_different_instruction'); f.f.advance(10);
  for (let i = 0; i < 3; i++) { if (i) f.next('pause_' + i); const handle = f.service.beginAttempt(r.id, { eventId: i ? 'pause_' + i : 'source', approach: 'method_' + i }); f.service.settle(handle, observed()); }
  const paused = f.service.project(f.f.owner, r.id); expect(paused.state).toBe('paused'); f.reopen();
  expect(() => f.service.resume(f.f.owner, r.id, 'older_different_instruction')).toThrow('fresh_instruction_required');
  f.f.advance(1); f.f.source('stopped_fresh'); f.f.sources.get('stopped_fresh')!.state = 'stopped';
  expect(() => f.service.resume(f.f.owner, r.id, 'stopped_fresh')).toThrow('execution_not_authorized');
  f.f.advance(1); const revoked = f.f.source('revoked_fresh');
  f.f.policy.owner.revoke(f.f.owner, 'revoke_fresh_chat_work', { kind: 'work', id: revoked.authority!.id });
  expect(() => f.service.resume(f.f.owner, r.id, 'revoked_fresh')).toThrow('authority_revoked');
  expect(f.service.project(f.f.owner, r.id)).toMatchObject({ state: 'paused', stallCheckpoint: 0, report: { at: paused.report!.at } });
  f.f.advance(1); f.f.source('eligible_fresh'); const resumed = f.service.resume(f.f.owner, r.id, 'eligible_fresh');
  expect(resumed).toMatchObject({ state: 'ready', workId: r.workId, readyEventId: 'eligible_fresh', stallCheckpoint: 3 });
});

test('a same-timestamp CHAT instruction cannot establish that it was received after the pause', () => {
  const f = setup(), r = f.responsibility;
  for (let i = 0; i < 3; i++) { if (i) f.next('same_clock_' + i); const handle = f.service.beginAttempt(r.id, { eventId: i ? 'same_clock_' + i : 'source', approach: 'method_' + i }); f.service.settle(handle, observed()); }
  f.f.source('same_timestamp');
  expect(() => f.service.resume(f.f.owner, r.id, 'same_timestamp')).toThrow('fresh_instruction_required');
  expect(f.service.project(f.f.owner, r.id).state).toBe('paused');
});

test('unknown merge reconciled as remotely verified merged completes the responsibility without reviving old publication', () => {
  const { f, service, responsibility: r } = setup(); const handle = service.beginAttempt(r.id, { eventId: 'source', approach: 'Merge exact approved head' });
  const unknown = service.settle(handle, observed({ transportSettled: false, executionSettled: false, effects: 'unknown' }));
  expect(unknown.state).toBe('reconcile_only'); const attemptId = unknown.attempts[0]!.id;
  const verified = service.reconcile(r.id, attemptId, observed({ complete: true, progress: 'made', basis: 'remote_verified', evidenceRefs: ['remote_verified_merge'] }));
  expect(verified.state).toBe('completed'); expect(verified.attempts[0]).toMatchObject({ state: 'settled', capacityHeld: false, effects: 'known', publicationFenced: true, reconciliation: { basis: 'remote_verified', complete: true } });
  expect(() => service.publish(handle, () => { throw Error('must_not_publish_old_merge_output'); })).toThrow('publication_withheld');
  expect(() => service.guard(handle)).toThrow('attempt_not_active');
  expect(service.project(f.owner, r.id).state).toBe('completed');
});

test('a remotely checked but still unknown merge remains reconcile-only with no replacement attempt', () => {
  const { service, responsibility: r } = setup(), handle = service.beginAttempt(r.id, { eventId: 'source', approach: 'Merge exact head' });
  const unknown = service.settle(handle, observed({ effects: 'unknown' }));
  const checked = service.reconcile(r.id, unknown.attempts[0]!.id, observed({ effects: 'unknown', basis: 'remote_verified', evidenceRefs: ['inconclusive_readback'] }));
  expect(checked.state).toBe('reconcile_only'); expect(checked.attempts[0]).toMatchObject({ effects: 'unknown', publicationFenced: true, capacityHeld: false });
  expect(() => service.beginAttempt(r.id, { eventId: 'replacement', approach: 'Retry merge' })).toThrow('attempt_not_ready');
  expect(() => service.publish(handle, () => {})).toThrow('publication_withheld');
});

test.each(['owner_statement', 'uncertain', 'omitted'] as const)('unverified reconciliation (%s) cannot close an unknown merge or certify settled capacity', basis => {
  const { service, responsibility: r } = setup(), handle = service.beginAttempt(r.id, { eventId: 'source', approach: 'Merge selected head' });
  const before = service.settle(handle, observed({ transportSettled: false, executionSettled: false, effects: 'unknown' }));
  const claimed = observed({ complete: true, progress: 'made', evidenceRefs: ['statement'] });
  if (basis === 'omitted') delete claimed.basis; else claimed.basis = basis;
  const after = service.reconcile(r.id, before.attempts[0]!.id, claimed);
  expect(after.state).toBe('reconcile_only'); expect(after.attempts[0]).toMatchObject({ state: 'unknown', effects: 'unknown', capacityHeld: true, transportSettled: false, executionSettled: false, publicationFenced: true, reconciliation: { basis: basis === 'omitted' ? 'uncertain' : basis } });
  expect(() => service.publish(handle, () => {})).toThrow('publication_withheld');
});

test('verified terminal reconciliation records completion after execution expiry without renewing authority', () => {
  const { f, service, responsibility: r } = setup(), handle = service.beginAttempt(r.id, { eventId: 'source', approach: 'Merge selected head' });
  const unknown = service.settle(handle, observed({ effects: 'unknown' })); f.advance(800000);
  const result = service.reconcile(r.id, unknown.attempts[0]!.id, observed({ complete: true, progress: 'made', evidenceRefs: ['verified_merge_after_expiry'] }));
  expect(result.state).toBe('completed'); expect(() => service.publish(handle, () => {})).toThrow('expired');
});
