import { randomBytes } from 'node:crypto';
import { registerSecretFingerprint } from '../../src/security/secret-fingerprints';
import { GooglePersonal } from '../../src/s14/personal-protocol';
import { registerGoogleEffects, type CalendarProposal, type GoogleEffectAccount, type GoogleEffectsOptions, type MailAttachment, type MailProposal } from '../../src/s15/effects';
import type { CatalogPort } from '../../src/s15/policy';
import { fixture, ref } from './s15-policy';
import { zero } from '../../src/s15/policy/validation';

export const mail = (): MailProposal => ({ to: ['recipient@example.test'], cc: [], bcc: [], subject: 'Exact subject', body: 'Final body\nwith spacing  ', attachments: [] });
export const calendar = (): CalendarProposal => ({ operation: 'create', eventId: null, version: null, timezone: 'Asia/Bangkok', sendUpdates: 'none', event: { summary: 'Focus block', description: 'Owner-requested work', location: '', start: '2026-11-03T10:00:00+07:00', end: '2026-11-03T11:00:00+07:00', recurrence: [], attendees: [] } });
/** Fake Google API implements provider CAS, sent-copy reads and lost-response behavior, never live I/O. */
export function googleFixture(composition: { disclosure?: GoogleEffectsOptions['disclosure']; catalogs?: (base: CatalogPort) => CatalogPort } = {}) {
  const token = randomBytes(32).toString('hex'); registerSecretFingerprint(token);
  const events = new Map<string, Record<string, unknown>>(), sent = new Map<string, string>(), attachments = new Map<string, MailAttachment>();
  let calls = 0, mutationCalls = 0, loses = false, corruptRead = false, accountLive = true, onToken: (() => Promise<void>) | null = null;
  const wire: { method: string; url: string; body: string; ifMatch: string | null }[] = [];
  const accounts: { mail: GoogleEffectAccount; calendar: GoogleEffectAccount } = { mail: { resource: ref('account'), account: 'owner@example.test', calendarId: null, scopes: ['gmail.readonly', 'gmail.send'] }, calendar: { resource: ref('repo'), account: 'owner@example.test', calendarId: 'test-calendar', scopes: ['calendar.readonly', 'calendar.events'] } };
  const response = (data: unknown, status = 200) => Response.json(data, { status });
  const google = new GooglePersonal(async (url, init) => {
    calls++; const headers = new Headers(init.headers), method = init.method ?? 'GET', body = typeof init.body === 'string' ? init.body : '';
    if (headers.get('authorization') !== `Bearer ${token}` || init.redirect !== 'error') throw Error('fixture_authentication_failed');
    wire.push({ method, url, body, ifMatch: headers.get('if-match') });
    const u = new URL(url);
    if (u.pathname === '/gmail/v1/users/me/messages/send' && method === 'POST') { mutationCalls++; const raw = JSON.parse(body).raw as string; sent.set('sent_' + mutationCalls, raw); if (loses) { loses = false; throw Error('fixture_response_lost'); } return response({ id: 'sent_' + mutationCalls }); }
    if (u.pathname === '/gmail/v1/users/me/messages') {
      const query = u.searchParams.get('q') ?? ''; const matches = [...sent].filter(([, raw]) => Buffer.from(raw, 'base64url').toString().includes(query.replace('rfc822msgid:', ''))); return response({ messages: matches.map(([id]) => ({ id })) });
    }
    if (u.pathname.startsWith('/gmail/v1/users/me/messages/')) { const key = u.pathname.split('/').at(-1)!; return sent.has(key) ? response({ id: key, labelIds: ['SENT'], raw: corruptRead ? Buffer.from('substituted').toString('base64url') : sent.get(key) }) : response({}, 404); }
    const match = /^\/calendar\/v3\/calendars\/test-calendar\/events(?:\/([A-Za-z0-9_-]+))?$/.exec(u.pathname);
    if (!match) throw Error('fixture_endpoint_refused'); const eventId = match[1];
    if (method === 'GET') return eventId && events.has(eventId) ? response(events.get(eventId)) : response({}, 404);
    const data = JSON.parse(body) as Record<string, unknown>, key = eventId ?? data.id as string;
    if (method === 'POST' && events.has(key)) return response({}, 409);
    if (method === 'PATCH' && (!events.has(key) || events.get(key)!.etag !== headers.get('if-match'))) return response({}, 412);
    mutationCalls++; const next = { ...data, id: key, etag: `"v${mutationCalls}"` }; events.set(key, next); if (loses) { loses = false; throw Error('fixture_response_lost'); } return response(next);
  });
  let f!: ReturnType<typeof fixture>;
  const options: GoogleEffectsOptions = { runtime: 's15', google, mailAccount: () => accountLive ? accounts.mail : null, calendarAccount: () => accountLive ? accounts.calendar : null, async token() { await onToken?.(); return token; }, recipients: () => [{ ref: ref('payee'), address: 'recipient@example.test' }, { ref: ref('other'), address: 'other@example.test' }, { ref: ref('self'), address: 'owner@example.test' }], attachment: (id, revision) => { const a = attachments.get(id); return a?.revision === revision ? a : null; }, bounds: { read: { ...zero(), calls: 1, reads: 1, outputBytes: 32768 }, mutation: { ...zero(), calls: 3, reads: 2, outputBytes: 65536 }, reconciliation: { ...zero(), calls: 2, reads: 2, outputBytes: 65536 }, expiresInMs: 89000 }, now: () => f.now, ...(composition.disclosure ? { disclosure: composition.disclosure } : {}) };
  const registration = registerGoogleEffects(options);
  f = fixture({ adapters: registration.adapters, reads: [registration.readHandler], ...(composition.catalogs ? { catalogs: composition.catalogs } : {}) });
  f.add('recipient', ref('self')); f.input.recipients.push(ref('self')); f.input.rules[0]!.recipients.push(ref('self'));
  f.input.budget!.ceiling.calls = 200; f.input.budget!.ceiling.reads = 200; f.input.budget!.ceiling.outputBytes = 20_000_000;
  f.input.rules[0]!.adapters.push('gmail_send', 'google_calendar'); f.input.rules[0]!.operations.push('create', 'update'); f.install(); registration.attach(f.service);
  const prepare = (actor: import('../../src/s15/policy').WorkActor, kind: 'mail' | 'calendar', proposal: unknown, slot = kind === 'mail' ? 'final_message' : 'calendar') => f.service.work.prepare(actor, { adapter: kind === 'mail' ? 'gmail_send' : 'google_calendar', slot, proposal });
  return { f, registration, options, accounts, events, sent, attachments, wire, prepare, get token() { return token; }, get calls() { return calls; }, get mutationCalls() { return mutationCalls; }, set loseNextResponse(v: boolean) { loses = v; }, set corruptRead(v: boolean) { corruptRead = v; }, set onToken(v: (() => Promise<void>) | null) { onToken = v; }, set accountLive(v: boolean) { accountLive = v; } };
}
