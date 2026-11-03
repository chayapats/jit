import { afterEach, expect, test } from 'bun:test';
import { composedFixture } from './fixtures/s15-composition';

// WORK15-02 (#367): an owner stall reply that waits for its own CHAT completion is a durable, protected binding.
const fixtures: Awaited<ReturnType<typeof composedFixture>>[] = [];
afterEach(async () => { for (const f of fixtures.splice(0)) await f.close(); });

async function pausedDuty() {
  const f = await composedFixture(); fixtures.push(f);
  const source = await f.chat('Run the requested diagnostic command');
  const work = f.service.work.assign(f.owner, { requestId: 'responsibility', sourceRequestId: source.receipt.rootRequestId, completion: 'Diagnose only this failure', triggers: ['schedule'], stallPolicy: { noProgressApproaches: 2, reserveCalls: 2, maxAttempts: 5 } });
  const settle = (handle: Parameters<typeof f.service.work.settle>[0]) => f.service.work.settle(handle, { transportSettled: true, executionSettled: true, effects: 'known', progress: 'none', evidenceRefs: ['diagnostic'], recommendation: 'Keep the original scope and inspect the configuration.', usage: { attempts: 1, steps: null, calls: null, reads: null, outputBytes: null, activeMs: null, spendMinor: null } });
  settle(f.service.work.beginAttempt(work.id, { eventId: source.receipt.rootRequestId, approach: 'first_diagnostic' }));
  f.service.work.observeEvent(work.id, { eventId: 'next_diagnostic', kind: 'schedule', key: 'diagnostic', purposeId: 'purpose', resourceIds: ['computer'], subject: null, evidenceRefs: ['failure'] });
  expect(settle(f.service.work.beginAttempt(work.id, { eventId: 'next_diagnostic', approach: 'second_diagnostic' })).state).toBe('paused');
  f.advance(1);
  return { f, duty: work.id };
}
const reply = (requestId: string, text = 'Run the next diagnostic within the same scope') => ({ contract: 's15-conversation/v1' as const, requestId, conversationId: 'conversation', text, continuation: null });
const row = (f: Awaited<ReturnType<typeof composedFixture>>, requestId: string) => f.service.conversation.store.db.query<{ state: string; code: string | null }, [string]>('SELECT state, code FROM resume_bindings_v1 WHERE request_id=?').get(requestId);

test('a stall reply bound before a restart resumes its duty once after restart, from the drain, with no page view', async () => {
  const { f, duty } = await pausedDuty();
  f.service.resumes.submit(f.owner, reply('stall_reply'), duty);
  // The binding commits with the reply itself: there is no moment where the request exists without it.
  expect(row(f, 'stall_reply')).toEqual({ state: 'pending', code: null });
  await f.service.conversation.drain();
  expect(f.service.conversation.view(f.owner, 'stall_reply').state).toBe('completed');
  expect(f.service.work.project(f.owner, duty).state).toBe('paused');
  await f.reopen();
  expect(f.service.work.project(f.owner, duty).state).toBe('paused');
  await f.service.drain();
  expect(f.service.work.project(f.owner, duty)).toMatchObject({ state: 'ready', readyEventId: 'stall_reply', report: { code: 'no_progress' } });
  expect(f.service.resumes.binding(f.owner, 'stall_reply')).toMatchObject({ state: 'resumed', dutyId: duty, code: null });
  // A second settlement pass is a no-op, and a replayed post returns the original receipt without a second binding.
  await f.service.drain(); expect(f.service.resumes.settle()).toEqual({ resumed: 0, refused: 0 });
  expect(f.service.resumes.submit(f.owner, reply('stall_reply'), duty).requestId).toBe('stall_reply');
  expect(f.service.conversation.store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM resume_bindings_v1').get()!.n).toBe(1);
});

test('a reply that ends refused/stopped records execution_not_authorized and the Web page shows it', async () => {
  const { f, duty } = await pausedDuty();
  f.service.resumes.submit(f.owner, reply('stopped_reply'), duty);
  f.service.conversation.stop(f.owner, 'stopped_reply');
  await f.service.drain();
  expect(row(f, 'stopped_reply')).toEqual({ state: 'refused', code: 'execution_not_authorized' });
  expect(f.service.work.project(f.owner, duty).state).toBe('paused');
  expect(f.service.resumes.refusal(f.owner, duty)).toBe('execution_not_authorized');
  const html = await (await f.request('/duties/' + duty)).text();
  expect(html).toContain('ยังทำหน้าที่นี้ต่อไม่ได้'); expect(html).toContain('execution_not_authorized');
});

test('an owner generation change before settlement refuses the binding instead of resuming', async () => {
  const { f, duty } = await pausedDuty();
  f.service.resumes.submit(f.owner, reply('old_owner_reply'), duty);
  await f.service.conversation.drain();
  f.generation = 2;
  await f.service.drain();
  expect(row(f, 'old_owner_reply')).toEqual({ state: 'refused', code: 'owner_changed' });
  f.generation = 1; await f.reopen(); await f.service.drain();
  expect(f.service.work.project(f.owner, duty).state).toBe('paused');
  expect(f.service.resumes.refusal(f.owner, duty)).toBe('owner_changed');
});

test('concurrent drains and a lost settlement commit still resume exactly once', async () => {
  const { f, duty } = await pausedDuty();
  f.service.resumes.submit(f.owner, reply('concurrent_reply'), duty);
  await f.service.conversation.drain();
  await Promise.all([f.service.drain(), f.service.drain(), Promise.resolve().then(() => f.service.resumes.settle())]);
  expect(row(f, 'concurrent_reply')).toEqual({ state: 'resumed', code: null });
  expect(f.service.work.project(f.owner, duty)).toMatchObject({ state: 'ready', readyEventId: 'concurrent_reply' });

  // A pass whose WORK resume committed but whose binding commit was lost is reconciled from WORK's own record.
  const second = await pausedDuty();
  second.f.service.resumes.submit(second.f.owner, reply('lost_commit'), second.duty);
  await second.f.service.conversation.drain();
  second.f.service.work.resume(second.f.owner, second.duty, 'lost_commit');
  await second.f.reopen(); await second.f.service.drain();
  expect(row(second.f, 'lost_commit')).toEqual({ state: 'resumed', code: null });
});

test('only a fresh, paused, same-conversation root reply can carry a binding', async () => {
  const { f, duty } = await pausedDuty();
  await f.chat('An ordinary message', 'ordinary');
  expect(() => f.service.resumes.submit(f.owner, reply('ordinary', 'An ordinary message'), duty)).toThrow('request_id_conflict');
  expect(() => f.service.resumes.submit(f.owner, { ...reply('elsewhere'), conversationId: 'other' }, duty)).toThrow('stale_revision');
  expect(() => f.service.resumes.submit(f.owner, { ...reply('continued'), continuation: { requestId: 'ordinary', revision: 1 } }, duty)).toThrow('invalid_body');
  expect(f.service.conversation.store.db.query<{ n: number }, []>('SELECT count(*) AS n FROM resume_bindings_v1').get()!.n).toBe(0);
  // The Web composer path uses the same durable binding; the handler keeps nothing in memory.
  expect((await f.form('/s15/forms/message', { requestId: 'web_reply', conversationId: 'conversation', text: 'Run the next diagnostic within the same scope', duty })).status).toBe(303);
  expect(row(f, 'web_reply')).not.toBeNull();
  await f.service.drain();
  expect(f.service.work.project(f.owner, duty)).toMatchObject({ state: 'ready', readyEventId: 'web_reply' });
});
