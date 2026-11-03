import { expect, test } from 'bun:test';
import { s15GoogleConnection } from '../src/s15/credentials';
import { runtimeDisclosure } from '../src/s15/disclosure/runtime';
import { googleEffectPeople } from '../src/s15/effects';
import type { JsonValue, Ref, WorkAuthority } from '../src/s15/policy';

const ref = (id: string, revision = 1): Ref => ({ id, revision, generation: 1 });

test('Google token resolves the configured connection, not the first connection with the same account and revision', () => {
  // Gmail and Calendar consent for one account commonly share a revision.
  const connections = new Map([
    ['mail_connection', { id: 'mail_connection', account: 'owner@example.com', revision: 3, scopes: ['gmail.readonly', 'gmail.send'] }],
    ['calendar_connection', { id: 'calendar_connection', account: 'owner@example.com', revision: 3, scopes: ['calendar.readonly', 'calendar.events'] }],
  ]);
  const read = (id: string) => connections.get(id) ?? (() => { throw new Error('missing'); })();
  const bindings = [{ connectionId: 'mail_connection', resource: ref('mail') }, { connectionId: 'calendar_connection', resource: ref('calendar') }];
  const calendar = { resource: ref('calendar', 3), account: 'owner@example.com' }, mail = { resource: ref('mail', 3), account: 'owner@example.com' };
  expect(s15GoogleConnection(bindings, calendar, 'calendar.events', read).id).toBe('calendar_connection');
  expect(s15GoogleConnection(bindings, mail, 'gmail.send', read).id).toBe('mail_connection');
  expect(() => s15GoogleConnection(bindings, calendar, 'gmail.send', read)).toThrow('personal_consent_required');
  expect(() => s15GoogleConnection(bindings, { ...calendar, resource: ref('calendar', 2) }, 'calendar.events', read)).toThrow('personal_account_changed');
  expect(() => s15GoogleConnection(bindings, { ...calendar, account: 'other@example.com' }, 'calendar.events', read)).toThrow('personal_account_changed');
  expect(() => s15GoogleConnection(bindings, { resource: ref('unbound', 3), account: 'owner@example.com' }, 'calendar.events', read)).toThrow('personal_connection_unavailable');
});

test('DATA15 Google route resolves the same recipients as the Google adapter, case-insensitively', () => {
  const people = [{ ref: ref('alice'), address: 'alice@example.com' }, { ref: ref('bob'), address: 'Bob@Example.com' }, { ref: ref('organizer'), address: 'organizer@example.com' }];
  const disclosure = runtimeDisclosure({ sources: [], approvals: [], githubRecipient: null, googleRecipient: ref('google_service'), browser: [], acquisitions: [], registries: [] }, [], { current: () => null, allows: () => true }, people);
  const route = disclosure.routes.find(r => r.id === 'google')!, work = {} as WorkAuthority;
  const account = { resource: ref('account'), account: 'owner@example.com', calendarId: 'primary', scopes: ['calendar.events'] };
  // An update that removes Bob and keeps a non-owner organizer reaches Alice, Bob and the organizer.
  const update = { contract: 's15-google-effect/v1', kind: 'calendar', account, message: null, calendar: { event: { attendees: ['ALICE@example.com'] } }, before: { event: { attendees: ['bob@example.com'] }, organizer: 'organizer@example.com' } };
  expect(googleEffectPeople(update)).toEqual(['ALICE@example.com', 'bob@example.com', 'organizer@example.com']);
  expect(route.resolve(work, update as unknown as JsonValue)).toEqual([ref('google_service'), ref('alice'), ref('bob'), ref('organizer')]);
  // The owner's own organizer address is not a recipient.
  expect(route.resolve(work, { ...update, before: { ...update.before, organizer: 'Owner@Example.com' } } as unknown as JsonValue)).toEqual([ref('google_service'), ref('alice'), ref('bob')]);
  const mail = { contract: 's15-google-effect/v1', kind: 'mail', account, message: { to: ['BOB@example.com'], cc: [], bcc: ['alice@EXAMPLE.com'] }, calendar: null, before: null };
  expect(route.resolve(work, mail as unknown as JsonValue)).toEqual([ref('google_service'), ref('bob'), ref('alice')]);
  // An unbound person keeps the route unknown instead of dropping them.
  expect(route.resolve(work, { ...mail, message: { to: ['stranger@example.com'], cc: [], bcc: [] } } as unknown as JsonValue)).toBeNull();
});
