import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { googleFixture, mail, calendar } from './fixtures/s15-effects';
import { ref, actionRef as ar } from './fixtures/s15-policy';
import { canonical } from '../src/s15/policy/validation';

const cleanup: (() => void)[] = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
const setup = () => { const g = googleFixture(); cleanup.push(() => g.f.cleanup()); return g; };

test('solo calendar creates immediately under an ordinary rule with observed exact calendar/time evidence', async () => {
  const g = setup(), actor = g.f.admit({ access: 'reversible_write' }).actor!, p = calendar(), prepared = g.prepare(actor, 'calendar', p);
  expect(prepared.decision.state).toBe('allow'); expect(prepared.action.classes).toEqual(['ordinary_edit']);
  expect((await g.f.service.work.dispatch(actor, ar(prepared.action))).outcome).toBe('succeeded'); expect(g.mutationCalls).toBe(1);
  const evidence = g.registration.evidence(actor, ar(prepared.action))!;
  expect(evidence.observed).toMatchObject({ timezone: 'Asia/Bangkok', event: p.event });
  expect(g.wire[0]).toMatchObject({ method: 'POST', url: 'https://www.googleapis.com/calendar/v3/calendars/test-calendar/events?sendUpdates=none' });
  expect(() => g.prepare(actor, 'calendar', p)).toThrow('already_claimed');
  expect(JSON.stringify(prepared)).not.toContain(g.token); expect(readFileSync(g.f.path).includes(Buffer.from(g.token))).toBe(false);
});

test('calendar update binds a work-observed etag, uses If-Match and returns a fresh-version undo proposal', async () => {
  const g = setup(), actor = g.f.admit().actor!, p = calendar(); const created = g.prepare(actor, 'calendar', p, 'create'); await g.f.service.work.dispatch(actor, ar(created.action));
  const eventId = g.registration.evidence(actor, ar(created.action))!.providerId;
  const next = { ...p, operation: 'update' as const, eventId, version: '"v1"', event: { ...p.event, summary: 'Changed' } };
  expect(() => g.prepare(actor, 'calendar', next, 'update')).toThrow('calendar_read_required');
  await g.registration.readEvent(actor, eventId, 'read_one'); const update = g.prepare(actor, 'calendar', next, 'update');
  expect(update.decision.state).toBe('allow'); expect((await g.f.service.work.dispatch(actor, ar(update.action))).outcome).toBe('succeeded');
  expect(g.wire.find(r => r.method === 'PATCH')!.ifMatch).toBe('"v1"');
  expect(g.registration.evidence(actor, ar(update.action))!.undo).toMatchObject({ version: '"v2"', event: p.event });
});

test.each(['add', 'remove', 'notify'] as const)('calendar %s cannot hide participant communication as a solo edit', async mode => {
  const g = setup(), actor = g.f.admit({ access: 'effect' }).actor!, p = calendar();
  if (mode === 'add') p.event.attendees.push('recipient@example.test');
  if (mode === 'notify') p.sendUpdates = 'all';
  if (mode === 'remove') {
    const initial = g.prepare(actor, 'calendar', { ...p, event: { ...p.event, attendees: ['recipient@example.test'] } }, 'initial'); g.f.approve(ar(initial.action)); await g.f.service.work.dispatch(actor, ar(initial.action));
    const eventId = [...g.events.keys()][0]!; await g.registration.readEvent(actor, eventId, 'read_before_remove'); p.operation = 'update'; p.eventId = eventId; p.version = '"v1"';
  }
  const prepared = g.prepare(actor, 'calendar', p, 'change'); expect(prepared.decision).toMatchObject({ state: 'hold', code: 'approval_required' }); expect(prepared.action.classes).toContain('communication');
  expect(g.mutationCalls).toBe(mode === 'remove' ? 1 : 0);
});

test('calendar rejects ambiguous/timezone inputs and an actually-read stale version cannot overwrite a concurrent edit', async () => {
  const g = setup(), actor = g.f.admit().actor!, p = calendar(); expect(() => g.prepare(actor, 'calendar', { ...p, timezone: 'UTC' })).toThrow('personal_timezone_offset_mismatch');
  const create = g.prepare(actor, 'calendar', p); await g.f.service.work.dispatch(actor, ar(create.action)); const key = [...g.events.keys()][0]!;
  await g.registration.readEvent(actor, key, 'read_old'); const update = g.prepare(actor, 'calendar', { ...p, operation: 'update', eventId: key, version: '"v1"', event: { ...p.event, summary: 'ours' } }, 'update');
  g.events.set(key, { ...g.events.get(key)!, etag: '"concurrent"', summary: 'theirs' });
  expect((await g.f.service.work.dispatch(actor, ar(update.action))).outcome).toBe('failed'); expect(g.events.get(key)!.summary).toBe('theirs'); expect(g.mutationCalls).toBe(1);
});

test('send request always holds final message; one exact approval sends once with matching sent-copy evidence', async () => {
  const g = setup(), actor = g.f.admit({ access: 'effect' }).actor!, p = mail(), prepared = g.prepare(actor, 'mail', p);
  expect(prepared.decision).toEqual({ state: 'hold', code: 'approval_required' }); expect(g.mutationCalls).toBe(0);
  const slip = g.f.service.owner.actionSlip(g.f.owner, ar(prepared.action)), bytes = JSON.parse(Buffer.from(slip.payloadBytesBase64, 'base64').toString());
  expect(bytes.message).toEqual(p); g.f.approve(ar(prepared.action));
  expect((await g.f.service.work.dispatch(actor, ar(prepared.action))).outcome).toBe('succeeded'); expect(g.mutationCalls).toBe(1);
  expect(g.registration.evidence(actor, ar(prepared.action))!.observed).toMatchObject(p);
  await expect(g.f.service.work.dispatch(actor, ar(prepared.action))).rejects.toThrow('already_claimed');
});

test.each(['to', 'body', 'attachment'] as const)('changed final %s supersedes the old approval and requires a new exact decision', async field => {
  const g = setup(), actor = g.f.admit().actor!, p = mail();
  g.attachments.set('report', { id: 'report', revision: 1, name: 'report.txt', mediaType: 'text/plain', dataBase64: Buffer.from('exact report').toString('base64') });
  const one = g.prepare(actor, 'mail', p); g.f.approve(ar(one.action));
  if (field === 'to') p.to = ['other@example.test']; if (field === 'body') p.body += '\nchanged'; if (field === 'attachment') p.attachments = [{ id: 'report', revision: 1 }];
  const two = g.prepare(actor, 'mail', p); expect(two.action.id).toBe(one.action.id); expect(two.action.revision).toBe(2); expect(two.decision.state).toBe('hold');
  await expect(g.f.service.work.dispatch(actor, ar(one.action))).rejects.toThrow('stale_action');
  g.f.approve(ar(two.action)); expect((await g.f.service.work.dispatch(actor, ar(two.action))).outcome).toBe('succeeded'); expect(g.mutationCalls).toBe(1);
  if (field === 'attachment') expect(Buffer.from([...g.sent.values()][0]!, 'base64url').toString()).toContain('ZXhhY3QgcmVwb3J0');
});

test('attachment substitution after approval is fenced before send; host paths and model approval fields are refused', async () => {
  const g = setup(), actor = g.f.admit().actor!, p = mail(); p.attachments = [{ id: 'file', revision: 1 }];
  const file = { id: 'file', revision: 1, name: 'safe.txt', mediaType: 'text/plain', dataBase64: Buffer.from('before').toString('base64') }; g.attachments.set('file', file);
  const prepared = g.prepare(actor, 'mail', p); g.f.approve(ar(prepared.action)); g.attachments.set('file', { ...file, dataBase64: Buffer.from('after').toString('base64') });
  expect(await g.f.service.work.dispatch(actor, ar(prepared.action))).toMatchObject({ outcome: 'not_dispatched', code: 'attachment_changed' }); expect(g.mutationCalls).toBe(0);
  expect(() => g.prepare(actor, 'mail', { ...mail(), approved: true }, 'other')).toThrow('invalid_shape'); expect(() => g.prepare(actor, 'mail', { ...mail(), attachments: [{ path: '/host/secret' }] }, 'third')).toThrow('invalid_shape');
});

test('a bounded explicit communication rule allows only its installed class; personal GitHub is not general email authority', async () => {
  const g = setup(), ordinary = g.f.input.rules[0]!;
  g.f.input.rules.push({ ...structuredClone(ordinary), id: 'bounded_email', mode: 'communication', adapters: ['gmail_send'], operations: ['send'], classes: ['communication'], recipients: [ref('payee')] }); g.f.install();
  const actor = g.f.admit().actor!, allowed = g.prepare(actor, 'mail', mail()); expect(allowed.decision.state).toBe('allow'); await g.f.service.work.dispatch(actor, ar(allowed.action));
  const otherActor = g.f.admit().actor!, outside = g.prepare(otherActor, 'mail', { ...mail(), to: ['other@example.test'] }); expect(outside.decision.state).toBe('hold');
  g.f.input.rules = [ordinary, { ...structuredClone(ordinary), id: 'personal_github', mode: 'personal_github_publish', adapters: ['gmail_send'], github: { repository: ref('repo'), target: 'main' } }]; g.f.install();
  expect(g.prepare(g.f.admit().actor!, 'mail', mail()).decision.state).toBe('hold');
});

test.each(['mail', 'calendar'] as const)('%s lost provider response survives policy restart and reconciles without a second mutation', async kind => {
  const g = setup(), actor = g.f.admit().actor!, prepared = g.prepare(actor, kind, kind === 'mail' ? mail() : calendar()); if (kind === 'mail') g.f.approve(ar(prepared.action));
  g.loseNextResponse = true; expect((await g.f.service.work.dispatch(actor, ar(prepared.action))).outcome).toBe('unknown'); expect(g.mutationCalls).toBe(1);
  g.f.reopen(); const owner = g.f.service.owner.authenticate('fixture_owner_session');
  expect((await g.f.service.owner.reconcile(owner, ar(prepared.action), 'reconcile_one')).outcome).toBe('succeeded'); expect(g.mutationCalls).toBe(1);
  await expect(g.f.service.work.dispatch(g.f.service.control.bindWork(g.f.service.owner.inspect(owner, ar(prepared.action)).action.workId), ar(prepared.action))).rejects.toThrow('already_claimed');
});

test('provider sent-copy substitution is unknown and never sends again', async () => {
  const g = setup(), actor = g.f.admit().actor!, prepared = g.prepare(actor, 'mail', mail()); g.f.approve(ar(prepared.action)); g.corruptRead = true;
  expect((await g.f.service.work.dispatch(actor, ar(prepared.action))).outcome).toBe('unknown'); expect(g.mutationCalls).toBe(1);
});

test.each(['revoke', 'expiry', 'account'] as const)('final %s while credentials are acquired fences the actual Google transport', async mode => {
  const g = setup(), actor = g.f.admit().actor!, prepared = g.prepare(actor, 'mail', mail()); g.f.approve(ar(prepared.action));
  g.onToken = async () => { if (mode === 'revoke') g.f.service.owner.revoke(g.f.owner, 'revoke_work', { kind: 'work', id: prepared.action.workId }); else if (mode === 'expiry') g.f.now = prepared.action.expiresAt; else g.accountLive = false; };
  expect((await g.f.service.work.dispatch(actor, ar(prepared.action))).outcome).toBe('not_dispatched'); expect(g.calls).toBe(0);
});

test('sending to self is still an external email; authenticated owner reports use CHAT ordinary output', () => {
  const g = setup(), actor = g.f.admit({ recipients: [ref('self')] }).actor!, prepared = g.prepare(actor, 'mail', { ...mail(), to: ['owner@example.test'] });
  expect(prepared.decision.state).toBe('hold'); expect(canonical(prepared.action.payload)).not.toContain('Authorization');
});

test('a newly bound private recipient adds a disclosure gate even when a communication rule exists', () => {
  const g = setup(), actor = g.f.admit({ recipients: [ref('payee')] }).actor!, prepared = g.prepare(actor, 'mail', { ...mail(), to: ['other@example.test'] });
  expect(prepared.decision.state).toBe('hold'); expect(prepared.action.classes).toEqual(['communication', 'disclosure']); expect(g.mutationCalls).toBe(0);
});

test('a recurring calendar series is a multi-occurrence impact, independent of the size of its text', () => {
  const g = setup(), actor = g.f.admit().actor!, p = calendar(); p.event.recurrence = ['RRULE:FREQ=DAILY'];
  const prepared = g.prepare(actor, 'calendar', p); expect(prepared.decision.state).toBe('hold'); expect(prepared.action.classes).toContain('major_change');
});

test('Gmail reconciliation charges both physical reads in its explicit recovery profile', async () => {
  const g = setup(), actor = g.f.admit().actor!, prepared = g.prepare(actor, 'mail', mail()); g.f.approve(ar(prepared.action)); g.loseNextResponse = true; await g.f.service.work.dispatch(actor, ar(prepared.action));
  const before = g.f.service.control.usage().charged; await g.f.service.owner.reconcile(g.f.owner, ar(prepared.action), 'readback_budget');
  expect(g.f.service.control.usage().charged.calls - before.calls).toBe(2); expect(g.f.service.control.usage().charged.reads - before.reads).toBe(2); expect(g.mutationCalls).toBe(1);
});

test('reconciliation rechecks owner/privacy after credential waits without another Google read', async () => {
  const g = setup(), actor = g.f.admit().actor!, prepared = g.prepare(actor, 'mail', mail()); g.f.approve(ar(prepared.action)); g.loseNextResponse = true; await g.f.service.work.dispatch(actor, ar(prepared.action));
  const calls = g.calls; g.onToken = async () => { g.f.allow = false; };
  expect((await g.f.service.owner.reconcile(g.f.owner, ar(prepared.action), 'blocked_readback')).outcome).toBe('unknown'); expect(g.calls).toBe(calls); expect(g.mutationCalls).toBe(1);
});

test('verified event identity, actual content and fresh-version undo survive policy process restart', async () => {
  const g = setup(), actor = g.f.admit().actor!, p = calendar(), a = g.prepare(actor, 'calendar', p).action;
  await g.f.service.work.dispatch(actor, ar(a)); const before = g.registration.evidence(actor, ar(a));
  g.f.reopen(); const owner = g.f.service.owner.authenticate('fixture_owner_session');
  expect(g.f.service.owner.inspect(owner, ar(a)).observation!.evidence).toEqual(JSON.parse(canonical(before))); expect(g.mutationCalls).toBe(1);
});
