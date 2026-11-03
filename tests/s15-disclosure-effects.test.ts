import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDisclosureService, type RecipientApproval } from '../src/s15/disclosure';
import { openFixtureRecordService, type FixtureRecord } from '../src/s15/effects';
import { registerProtectedBrowser, type BrowserRequest } from '../src/s15/browser';
import { canonical } from '../src/s15/policy/validation';
import { fixture, actionRef, ref } from './fixtures/s15-policy';
import { googleFixture, mail, calendar } from './fixtures/s15-effects';
import { recordEngine, documentRecord, taskRecord, businessRecord } from './fixtures/s15-effect-browser';
import { loopbackFixtureEgress } from './fixtures/s15-browser';

const cleanups: (() => unknown | Promise<unknown>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const provider = ref('service_provider');
function setupGoogle(decorate = true) {
  const dir = mkdtempSync(join(tmpdir(), 'jit-private-effects-'));
  const source = { ref: ref('private_source'), resource: ref('account'), classification: 'private' as const, active: true, ownerReleasable: true };
  const calendarSource = { ...source, ref: ref('calendar_source'), resource: ref('repo') };
  const addresses = new Map([['recipient@example.test', ref('payee')], ['other@example.test', ref('other')], ['owner@example.test', ref('self')]]);
  const grants: RecipientApproval[] = [provider, ref('payee')].map(recipient => ({ recipient, purpose: ref('purpose'), resources: [ref('account')], dataClasses: ['private'], sources: [source.ref], expiresAt: 90000 }));
  grants[0]!.resources.push(ref('repo')); grants[0]!.sources!.push(calendarSource.ref);
  const disclosure = openDisclosureService({ runtime: 's15', path: join(dir, 'lineage.sqlite'), create: true, installationId: 'private_effects', now: () => 1000,
    catalogs: { source: r => r.id === source.ref.id ? source : r.id === calendarSource.ref.id ? calendarSource : null, recipient: r => [provider, ...addresses.values()].some(p => canonical(p) === canonical(r)) ? { ref: r, active: true } : null, approvals: () => grants },
    routes: [{ id: 'google', kind: 'adapter', resolve(_work, payload) {
      const p = payload as { contract: string; wire: { url: string }; message: { to: string[]; cc: string[]; bcc: string[] } | null; calendar: { event: { attendees: string[] } } | null; before: { event: { attendees: string[] }; organizer: string | null } | null; account: { account: string } };
      if (!['gmail.googleapis.com', 'www.googleapis.com'].includes(new URL(p.wire.url).hostname)) return null;
      if (p.contract === 's15-google-read/v1') return [provider];
      if (p.contract !== 's15-google-effect/v1') return null;
      const people = p.message ? [...p.message.to, ...p.message.cc, ...p.message.bcc] : [...(p.calendar?.event.attendees ?? []), ...(p.before?.event.attendees ?? []), ...(p.before?.organizer && p.before.organizer !== p.account.account ? [p.before.organizer] : [])];
      const refs = people.map(address => addresses.get(address)); if (refs.some(r => !r)) return null;
      return [...new Map([provider, ...refs.map(r => r!)].map(r => [r.id, r])).values()];
    } }],
  });
  const g = googleFixture({ catalogs: base => disclosure.catalogs(base), ...(decorate ? { disclosure: {
    protectAdapter: adapter => disclosure.protectAdapter(adapter, 'google'),
    beforeRead: (work, payload) => disclosure.guardRead(work, 'google', payload),
    recordRead: (actor, observation) => { if (observation.eventId !== 'observed' || observation.version !== '"v1"') throw Error('unknown_source_revision'); disclosure.read(actor, calendarSource.ref); },
  } } : {}) });
  cleanups.push(() => { g.f.cleanup(); disclosure.close(); rmSync(dir, { recursive: true, force: true }); });
  disclosure.attach(g.f.service); g.f.add('lineage', source.ref); g.f.add('lineage', calendarSource.ref); g.f.add('recipient', provider);
  g.f.input.recipients.push(provider); g.f.input.rules[0]!.recipients.push(provider);
  // A standing send rule alone must not authorize a new recipient of private data.
  g.f.input.rules.push({ ...structuredClone(g.f.input.rules[0]!), id: 'standing_send', mode: 'communication' });
  g.f.install(); const actor = g.f.admit({ access: 'effect', recipients: [...g.f.input.recipients] }).actor!;
  disclosure.read(actor, source.ref);
  return { g, disclosure, source, calendarSource, grants, actor };
}

test.each(['to', 'cc', 'bcc'] as const)('Gmail %s receives a disclosure hold despite a standing communication rule', async field => {
  const { g, actor } = setupGoogle(), proposal = mail(); proposal[field] = ['other@example.test'];
  const prepared = g.prepare(actor, 'mail', proposal); expect(prepared.decision.state).toBe('hold'); expect(g.mutationCalls).toBe(0);
  const slip = g.f.service.owner.actionSlip(g.f.owner, actionRef(prepared.action));
  expect(slip.action.classes).toEqual(expect.arrayContaining(['communication', 'disclosure', 'new_egress']));
  expect(slip.action.disclosure?.recipients).toEqual(expect.arrayContaining([provider, ref('other')]));
  g.f.approve(actionRef(prepared.action));
  expect((await g.f.service.work.dispatch(actor, actionRef(prepared.action))).outcome).toBe('succeeded'); expect(g.mutationCalls).toBe(1);
});

test('an approved Gmail recipient remains usable and private evidence stays in guarded projections', async () => {
  const { g, actor, source } = setupGoogle(), prepared = g.prepare(actor, 'mail', mail());
  expect(prepared.decision.state).toBe('allow');
  const result = await g.f.service.work.dispatch(actor, actionRef(prepared.action)); expect(result.outcome).toBe('succeeded'); expect(result).not.toHaveProperty('evidence');
  expect(g.registration.evidence(actor, actionRef(prepared.action))?.observed).toMatchObject({ body: mail().body });
  source.active = false;
  const reconciled = await g.f.service.owner.reconcile(g.f.owner, actionRef(prepared.action), 'terminal_control_only');
  expect(reconciled.outcome).toBe('succeeded'); expect(reconciled).not.toHaveProperty('evidence');
  expect(() => g.registration.evidence(actor, actionRef(prepared.action))).toThrow(); expect(g.mutationCalls).toBe(1);
});

test('solo Calendar edits hold a new Google data recipient and refuse omitted disclosure composition', async () => {
  const { g, actor, grants } = setupGoogle(); expect(g.prepare(actor, 'calendar', calendar()).decision.state).toBe('allow'); grants.splice(0, 1);
  const prepared = g.prepare(actor, 'calendar', calendar()); expect(prepared.decision.state).toBe('hold');
  expect(prepared.action.disclosure?.recipients).toEqual([provider]); expect(g.events.size).toBe(0);
  g.f.approve(actionRef(prepared.action)); expect((await g.f.service.work.dispatch(actor, actionRef(prepared.action))).outcome).toBe('succeeded');
  expect(g.events.size).toBe(1);
  const missing = setupGoogle(false);
  expect(() => missing.g.prepare(missing.actor, 'calendar', calendar())).toThrow('outside_scope'); expect(missing.g.mutationCalls).toBe(0);
});

test('Calendar attendee recipients encounter disclosure independently of standing notifications', async () => {
  const { g, actor } = setupGoogle(), proposal = calendar(); proposal.event.attendees = ['other@example.test']; proposal.sendUpdates = 'all';
  const prepared = g.prepare(actor, 'calendar', proposal); expect(prepared.decision.state).toBe('hold');
  expect(prepared.action.classes).toEqual(expect.arrayContaining(['ordinary_edit', 'communication', 'disclosure', 'new_egress'])); expect(g.mutationCalls).toBe(0);
  g.f.approve(actionRef(prepared.action)); expect((await g.f.service.work.dispatch(actor, actionRef(prepared.action))).outcome).toBe('succeeded'); expect(g.mutationCalls).toBe(1);
});

test('Calendar read refuses a new private recipient before requesting a token or sending a query', async () => {
  const { g, actor, grants } = setupGoogle(); grants.splice(0, 1); let tokens = 0;
  g.onToken = async () => { tokens++; };
  await expect(g.registration.readEvent(actor, 'observed', 'unapproved_read')).rejects.toThrow('recipient_unapproved');
  expect(tokens).toBe(0); expect(g.calls).toBe(0);
});

test('Calendar read rechecks private recipient approval after awaiting a token', async () => {
  const { g, actor, grants } = setupGoogle(); g.onToken = async () => { grants.splice(0, 1); };
  await expect(g.registration.readEvent(actor, 'observed', 'revoked_read')).rejects.toThrow('google_transport_uncertain');
  expect(g.calls).toBe(0);
});

test('Calendar output records private source lineage before a later email can use the observed data', async () => {
  const { g, actor, calendarSource } = setupGoogle(), event = calendar().event;
  g.events.set('observed', { id: 'observed', etag: '"v1"', summary: 'Private calendar fact', description: event.description, location: event.location,
    start: { dateTime: event.start, timeZone: 'Asia/Bangkok' }, end: { dateTime: event.end, timeZone: 'Asia/Bangkok' }, recurrence: [], attendees: [] });
  const observed = await g.registration.readEvent(actor, 'observed', 'approved_read'); expect(g.calls).toBe(1);
  const proposal = mail(); proposal.body = observed.event.summary;
  const prepared = g.prepare(actor, 'mail', proposal); expect(prepared.decision.state).toBe('hold'); expect(g.mutationCalls).toBe(0);
  expect(prepared.action.disclosure?.sources).toContainEqual({ ref: calendarSource.ref, resource: calendarSource.resource, classification: 'private' });
});

test('privacy withdrawal during token acquisition prevents the actual Google mutation', async () => {
  const { g, actor, source } = setupGoogle(), prepared = g.prepare(actor, 'mail', mail());
  g.onToken = async () => { source.active = false; };
  expect((await g.f.service.work.dispatch(actor, actionRef(prepared.action))).outcome).toBe('not_dispatched'); expect(g.calls).toBe(0); expect(g.mutationCalls).toBe(0);
});

test('Google recovery preserves beforeRead privacy guards and never exposes private evidence in status', async () => {
  const { g, actor, source } = setupGoogle(), prepared = g.prepare(actor, 'mail', mail()); g.loseNextResponse = true;
  expect((await g.f.service.work.dispatch(actor, actionRef(prepared.action))).outcome).toBe('unknown'); const calls = g.calls;
  g.onToken = async () => { source.active = false; };
  const result = await g.f.service.owner.reconcile(g.f.owner, actionRef(prepared.action), 'privacy_recovery');
  expect(result.outcome).toBe('unknown'); expect(result).not.toHaveProperty('evidence'); expect(g.calls).toBe(calls); expect(g.mutationCalls).toBe(1);
});

async function setupRecord(record: FixtureRecord) {
  const dir = mkdtempSync(join(tmpdir(), 'jit-private-record-')), rule = ref('business_rule');
  const server = openFixtureRecordService({ runtime: 's15', path: join(dir, 'records.sqlite'), create: true, resource: ref('account'), rule: () => rule, recipients: () => [{ id: 'team', ref: ref('payee') }] });
  server.seed({ ...record, triggers: { ...record.triggers, notify: ['team'] } });
  const source = { ref: ref('record_source'), resource: ref('account'), classification: 'private' as const, active: true, ownerReleasable: true };
  const disclosure = openDisclosureService({ runtime: 's15', path: join(dir, 'lineage.sqlite'), create: true, installationId: 'private_records', now: () => 1000,
    catalogs: { source: r => r.id === source.ref.id ? source : null, recipient: r => [provider, ref('payee')].some(p => canonical(p) === canonical(r)) ? { ref: r, active: true } : null,
      approvals: () => [{ recipient: provider, purpose: ref('purpose'), resources: [ref('account')], dataClasses: ['private'], sources: [source.ref], expiresAt: 90000 }] },
    browserSource: () => source.ref,
    routes: [{ id: 'records', kind: 'browser', resolve(_work, payload) {
      const request = payload as unknown as BrowserRequest; if (new URL(request.url).origin !== server.origin) return null;
      const meaning = server.site.classify(request, 'general'); if (!meaning || !['read', 'effect'].includes(meaning.kind)) return null;
      return meaning.kind === 'effect' ? [provider, ...meaning.recipients] : [provider];
    } }],
  });
  const engine = recordEngine(), browser = await registerProtectedBrowser({ runtime: 's15', mode: 'general', resource: ref('account'), fences: [], continuity: { path: join(dir, 'browser.sqlite'), create: true }, profilePath: join(dir, 'profile'), executablePath: '/unused', site: server.site,
    upperBound: { attempts: 0, steps: 1, calls: 1, reads: 1, outputBytes: 10000, activeMs: 100, spendMinor: '0' }, now: () => 1000, disclosure: disclosure.browser('records'), egress: loopbackFixtureEgress }, engine.factory);
  const f = fixture({ adapters: [browser.adapter], reads: [browser.readHandler], catalogs: base => disclosure.catalogs(base) });
  cleanups.push(async () => { await browser.close(); f.cleanup(); disclosure.close(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  f.add('lineage', source.ref); f.add('recipient', provider); f.input.recipients.push(provider); f.input.rules[0]!.recipients.push(provider);
  f.input.rules[0]!.adapters.push('protected_browser'); f.input.rules[0]!.operations.push('browser_request'); f.input.rules.push({ ...structuredClone(f.input.rules[0]!), id: 'standing_notify', mode: 'communication' });
  f.input.budget!.ceiling.outputBytes = 1000000; f.install(); browser.attach(f.service); disclosure.attach(f.service);
  const actor = f.admit({ access: 'effect', recipients: [...f.input.recipients] }).actor!, work = browser.open(actor);
  expect((await work.execute({ kind: 'navigate', url: `${server.origin}/records/${record.id}`, generation: work.state().generation })).state).toBe('ok');
  return { f, server, engine, work, rule };
}

test.each(['document', 'task', 'business'] as const)('real %s edits hold hidden notification recipients of private record data', async kind => {
  const record = kind === 'document' ? documentRecord() : kind === 'task' ? taskRecord() : businessRecord(), x = await setupRecord(record);
  const changes = kind === 'document' ? { body: 'Exact private document' } : kind === 'task' ? { completed: true } : { note: 'Observed private business fact' };
  if (kind === 'business') x.server.putEvidence({ id: 'fact', revision: 1, recordId: record.id, field: 'note', value: 'Observed private business fact', status: 'fact', active: true });
  x.engine.next = x.server.request(record.id, { version: 1, rule: x.rule, changes, evidence: kind === 'business' ? [{ id: 'fact', revision: 1 }] : [], notify: [], share: [], delete: false });
  const held = await x.work.execute({ kind: 'submit', target: 'e1_1', generation: x.work.state().generation }); expect(held.state).toBe('held'); expect(x.server.mutationCount).toBe(0);
  if (held.state !== 'held') throw Error('expected_disclosure_hold');
  const slip = x.f.service.owner.actionSlip(x.f.owner, held.action);
  expect(slip.action.classes).toEqual(expect.arrayContaining(['ordinary_edit', 'communication', 'disclosure', 'new_egress']));
  expect(slip.action.disclosure?.recipients).toEqual(expect.arrayContaining([provider, ref('payee')]));
  x.f.service.owner.decide(x.f.owner, { requestId: 'approve_record', action: held.action, decision: 'approve', expiresAt: 20000 });
  expect((await x.work.resume(held.action)).state).toBe('ok'); expect(x.server.mutationCount).toBe(1); expect(x.server.record(record.id).fields).toMatchObject(changes);
});
