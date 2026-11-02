import { GoogleFailure, GooglePersonal, googleObject } from '../../s14/personal-protocol';
import { containsCredential } from '../../security/credentials';
import { personalEventBody, validatePersonalDraft } from '../../s14/personal-effect-validation';
import type { PersonalEventDraft, PersonalEventFields } from '../../s14/personal-effect-types';
import type { ActionAdapter, ActionRef, AdapterResult, JsonValue, PreparedAction, ReadHandler, S15PolicyService, WorkActor, WorkAuthority } from '../policy';
import { canonical, contains, digest, equal, exact, fail, id, nat, ref, string, unknownUsage, vector } from '../policy/validation';
import type { ConversationPolicyWork, ConversationToolPort } from '../conversation';
import { attachmentDigest, finalMailRaw, MAIL_ENCODED_PAYLOAD_LIMIT, validateMailAttachment, validateMailProposal } from './mail';
import { communicationClasses, type CalendarProposal, type EffectBounds, type EffectEvidence, type GoogleEffectAccount, type MailAttachment, type MailProposal, type CommunicationRecipient } from './types';
import { calendarProposalSchema, mailProposalSchema } from './schemas';

/** Host-only configuration. Token custody/refresh remains outside the working VM and every tool closure. */
export interface GoogleEffectsOptions {
  runtime: 's15'; google: GooglePersonal; mailAccount: () => GoogleEffectAccount | null; calendarAccount: () => GoogleEffectAccount | null;
  token(account: GoogleEffectAccount, scope: 'gmail.readonly' | 'gmail.send' | 'calendar.readonly' | 'calendar.events'): Promise<string>;
  recipients: () => readonly CommunicationRecipient[]; attachment(id: string, revision: number): MailAttachment | null;
  bounds: EffectBounds; now: () => number;
  /** Protected DATA15 composition. Bind Google and every actual person recipient before POLICY
   * registration; read guards run before credentials and final GET, and source stamping precedes output. */
  disclosure?: {
    protectAdapter(adapter: ActionAdapter): ActionAdapter;
    beforeRead(work: WorkAuthority, payload: JsonValue): void;
    recordRead(actor: WorkActor, observation: { account: GoogleEffectAccount; eventId: string; version: string }): void;
  };
}
interface EventSnapshot { id: string; version: string; timezone: string; event: PersonalEventFields; organizer: string | null; series: boolean }
interface Wire { url: string; method: 'POST' | 'PATCH'; headers: Record<string, string>; body: string }
interface Payload { contract: 's15-google-effect/v1'; kind: 'mail' | 'calendar'; account: GoogleEffectAccount; wire: Wire; message: MailProposal | null; attachments: MailAttachment[]; calendar: CalendarProposal | null; before: EventSnapshot | null; providerId: string }
const json = (v: unknown): JsonValue => JSON.parse(canonical(v)) as JsonValue;
const actionRef = (a: ActionRef): ActionRef => ({ id: a.id, revision: a.revision, actionHash: a.actionHash });
const result = (outcome: AdapterResult['outcome'], settled = true): AdapterResult => ({ outcome, transportSettled: settled, actual: unknownUsage() });
const endpoint = (a: GoogleEffectAccount) => `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(a.calendarId!)}/events`;
const readPayload = (a: GoogleEffectAccount, eventId: string): JsonValue => json({ contract: 's15-google-read/v1', account: a, wire: { url: endpoint(a) + '/' + encodeURIComponent(eventId), method: 'GET' } });
function eventSnapshot(data: unknown): EventSnapshot {
  const d = googleObject(data), start = googleObject(d.start), end = googleObject(d.end);
  if (d.attendees !== undefined && !Array.isArray(d.attendees) || d.eventType !== undefined && d.eventType !== 'default' || d.status === 'cancelled') fail('calendar_observation_unsupported');
  if (typeof d.id !== 'string' || !/^[a-zA-Z0-9_-]{1,256}$/.test(d.id) || containsCredential(d.id) || typeof d.etag !== 'string' || !/^"[^"\u0000-\u0020]{1,200}"$/.test(d.etag) || containsCredential(d.etag) || typeof start.timeZone !== 'string' || start.timeZone !== end.timeZone) fail('calendar_observation_unsupported');
  const event: PersonalEventFields = { summary: d.summary as string, description: (d.description ?? '') as string, location: (d.location ?? '') as string, start: start.dateTime as string, end: end.dateTime as string, recurrence: (d.recurrence ?? []) as string[], attendees: Array.isArray(d.attendees) ? d.attendees.map(a => googleObject(a).email as string) : [] };
  validatePersonalDraft({ kind: 'event', operation: 'update', eventId: d.id, etag: d.etag, timezone: start.timeZone, sendUpdates: 'none', event });
  const organizer = d.organizer ? googleObject(d.organizer).email : null; if (organizer !== null && (typeof organizer !== 'string' || organizer.length > 254 || !/^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/.test(organizer) || containsCredential(organizer))) fail('calendar_observation_unsupported');
  return { id: d.id, version: d.etag, timezone: start.timeZone, event, organizer, series: event.recurrence.length > 0 || d.recurringEventId !== undefined };
}
function calendarProposal(p: unknown): asserts p is CalendarProposal {
  canonical(p); exact(p, ['operation', 'eventId', 'version', 'timezone', 'sendUpdates', 'event']);
  if (!['create', 'update'].includes(p.operation as string)) fail('calendar_operation_unsupported');
  validatePersonalDraft({ kind: 'event', operation: p.operation, eventId: p.eventId, etag: p.version, timezone: p.timezone, sendUpdates: p.sendUpdates, event: p.event });
  if (p.operation === 'create' && (p.eventId !== null || p.version !== null) || p.operation === 'update' && p.version === null) fail('calendar_version_required');
}
function matchingMail(raw: unknown, expected: string): boolean {
  if (typeof raw !== 'string' || raw.length > 131072 || !/^[A-Za-z0-9_=-]+$/.test(raw)) return false;
  const parse = (s: string) => {
    const decoded = Buffer.from(s, 'base64url').toString('utf8'), at = decoded.indexOf('\r\n\r\n'); if (at < 0) return null;
    const headers = new Map<string, string>();
    for (const line of decoded.slice(0, at).replace(/\r\n[ \t]+/g, ' ').split('\r\n')) { const colon = line.indexOf(':'); if (colon < 1) return null; const key = line.slice(0, colon).toLowerCase(); if (headers.has(key)) return null; headers.set(key, line.slice(colon + 1).trim()); }
    return { headers, body: decoded.slice(at + 4) };
  };
  const a = parse(raw), b = parse(expected); return !!a && !!b && a.body === b.body && [...b.headers].every(([k, v]) => a.headers.get(k) === v);
}

/**
 * Real fixed Google endpoints over S14's no-retry protocol. Registration is opt-in and must be composed
 * only in the protected service. No OAuth scopes, accounts or grants are installed by this function.
 */
export function registerGoogleEffects(options: GoogleEffectsOptions) {
  if (options.runtime !== 's15') fail('runtime_opt_in_required');
  vector(options.bounds.read); vector(options.bounds.mutation); vector(options.bounds.reconciliation); nat(options.bounds.expiresInMs, true);
  if (options.bounds.read.reads < 1 || options.bounds.read.calls < 1 || options.bounds.mutation.calls < 3 || options.bounds.mutation.reads < 2 || options.bounds.reconciliation.calls < 2 || options.bounds.reconciliation.reads < 2) fail('effect_bound_required');
  const bounds = structuredClone(options.bounds), observations = new Map<string, EventSnapshot>();
  let policy: S15PolicyService | null = null;
  const host = () => policy ?? fail('policy_not_attached');
  function account(kind: 'mail' | 'calendar', scope: GoogleEffectAccount['scopes'][number]): GoogleEffectAccount {
    const a = kind === 'mail' ? options.mailAccount() : options.calendarAccount();
    if (!a || !a.scopes.includes(scope)) fail('personal_consent_required');
    ref(a.resource); string(a.account, 254); if (!a.account || /[\r\n]/.test(a.account) || kind === 'calendar' && !a.calendarId) fail('personal_account_required');
    return JSON.parse(canonical(a)) as GoogleEffectAccount;
  }
  function recipients(addresses: readonly string[]) {
    const refs = addresses.map(address => { const matches = options.recipients().filter(r => r.address.toLowerCase() === address.toLowerCase()); if (matches.length !== 1) fail('recipient_binding_required'); ref(matches[0]!.ref); return matches[0]!.ref; });
    return refs.filter((r, i) => refs.findIndex(other => equal(r, other)) === i);
  }
  function attachments(p: MailProposal): MailAttachment[] { return p.attachments.map(r => { const a = options.attachment(r.id, r.revision); if (!a || a.id !== r.id || a.revision !== r.revision) fail('attachment_changed'); validateMailAttachment(a); return structuredClone(a); }); }
  function payload(kind: 'mail' | 'calendar', proposal: unknown, work: WorkAuthority): Payload {
    const a = account(kind, kind === 'mail' ? 'gmail.send' : 'calendar.events');
    if (!contains(work.request.resources, a.resource)) fail('outside_scope');
    if (kind === 'mail') {
      validateMailProposal(proposal); const p = structuredClone(proposal), files = attachments(p), key = digest('s15.mail.identity.v1', { work: work.id });
      const raw = finalMailRaw(a.account, key, p, files);
      const prepared: Payload = { contract: 's15-google-effect/v1', kind, account: a, wire: { url: 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send', method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ raw }) }, message: p, attachments: files, calendar: null, before: null, providerId: key };
      // All fields were validated above. Key sorting changes no JSON byte length; check both encoded
      // copies before canonical() and leave headroom for the protected action/ledger envelope.
      if (Buffer.byteLength(JSON.stringify(prepared)) > MAIL_ENCODED_PAYLOAD_LIMIT) fail('mail_encoded_size_limit');
      return prepared;
    }
    calendarProposal(proposal); const p = structuredClone(proposal);
    const before = p.operation === 'update' ? observations.get(`${work.id}:${p.eventId}`) ?? fail('calendar_read_required') : null;
    if (before && before.version !== p.version) fail('stale_record');
    const providerId = p.eventId ?? digest('s15.calendar.identity.v1', { work: work.id });
    const c: PersonalEventDraft = { kind: 'event', operation: p.operation, eventId: providerId, etag: p.version, timezone: p.timezone, sendUpdates: p.sendUpdates, event: p.event };
    return { contract: 's15-google-effect/v1', kind, account: a, wire: { url: endpoint(a) + (p.operation === 'update' ? '/' + encodeURIComponent(providerId) : '') + '?sendUpdates=' + p.sendUpdates, method: p.operation === 'create' ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json', ...(p.version ? { 'If-Match': p.version } : {}) }, body: canonical(personalEventBody(c)) }, message: null, attachments: [], calendar: p, before: before ? structuredClone(before) : null, providerId };
  }
  function pinned(a: PreparedAction): Payload {
    const p = JSON.parse(canonical(a.payload)) as Payload;
    if (p.contract !== 's15-google-effect/v1' || !['mail', 'calendar'].includes(p.kind)) fail('invalid_effect');
    if (!equal(account(p.kind, p.kind === 'mail' ? 'gmail.send' : 'calendar.events'), p.account)) fail('personal_account_changed');
    if (p.message && !equal(attachments(p.message), p.attachments)) fail('attachment_changed');
    return p;
  }
  async function readBack(a: PreparedAction, p: Payload, token: string, guard: () => void): Promise<AdapterResult> {
    try {
      let observed: unknown, providerId = p.providerId, version: string | null = null;
      if (p.kind === 'mail') {
        if (!p.account.scopes.includes('gmail.readonly')) return result('unknown');
        const query = new URLSearchParams({ q: `rfc822msgid:${p.providerId}@jit.invalid`, labelIds: 'SENT', maxResults: '2' });
        const list = googleObject(await options.google.request('https://gmail.googleapis.com/gmail/v1/users/me/messages?' + query, { headers: { Authorization: `Bearer ${token}` } }, guard));
        if (!Array.isArray(list.messages) || list.messages.length !== 1 || list.nextPageToken) return result('unknown');
        const found = googleObject(list.messages[0]).id; if (typeof found !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/.test(found) || containsCredential(found)) return result('unknown'); providerId = found;
        const sent = googleObject(await options.google.request(`https://gmail.googleapis.com/gmail/v1/users/me/messages/${encodeURIComponent(found)}?format=raw`, { headers: { Authorization: `Bearer ${token}` } }, guard));
        if (sent.id !== found || !Array.isArray(sent.labelIds) || !sent.labelIds.includes('SENT') || !matchingMail(sent.raw, JSON.parse(p.wire.body).raw)) return result('unknown');
        observed = { from: p.account.account, ...p.message, attachments: p.attachments.map(file => ({ id: file.id, revision: file.revision, name: file.name, mediaType: file.mediaType, bytes: Buffer.from(file.dataBase64, 'base64').length, sha256: attachmentDigest(file) })) };
      } else {
        if (!p.account.scopes.includes('calendar.readonly')) return result('unknown');
        const e = eventSnapshot(await options.google.request(endpoint(p.account) + '/' + encodeURIComponent(providerId), { headers: { Authorization: `Bearer ${token}` } }, guard));
        if (e.id !== providerId || e.timezone !== p.calendar!.timezone || !equal(e.event, p.calendar!.event)) return result('unknown');
        observed = e; version = e.version;
      }
      const evidence: EffectEvidence = { contract: 's15-effect-evidence/v1', action: actionRef(a), providerId, version, observed, undo: p.before ? { operation: 'update', eventId: providerId, version, timezone: p.before.timezone, sendUpdates: 'none', event: p.before.event } : null };
      return { ...result('succeeded'), evidence: json(evidence) };
    } catch { return result('unknown', false); }
  }
  function adapter(kind: 'mail' | 'calendar'): ActionAdapter {
    return { id: kind === 'mail' ? 'gmail_send' : 'google_calendar', version: 1,
      prepare(proposal, context) {
        const p = payload(kind, proposal, context.work);
        const people = p.message ? [...p.message.to, ...p.message.cc, ...p.message.bcc] : [...new Set([...p.calendar!.event.attendees, ...(p.before?.event.attendees ?? []), ...(p.before?.organizer && p.before.organizer.toLowerCase() !== p.account.account.toLowerCase() ? [p.before.organizer] : [])])];
        const communication = kind === 'mail' || people.length > 0 || p.calendar!.sendUpdates !== 'none', actualRecipients = recipients(people);
        const classes = kind === 'calendar' ? ['ordinary_edit' as const, ...(communication ? communicationClasses() : [])] : communicationClasses();
        if (actualRecipients.some(r => !contains(context.work.request.recipients, r))) classes.push('disclosure');
        const series = kind === 'calendar' && (p.calendar!.event.recurrence.length > 0 || p.before?.series);
        if (series) classes.push('major_change');
        return { operation: kind === 'mail' ? 'send' : p.calendar!.operation, classes, resources: [p.account.resource], recipients: actualRecipients, payload: json(p), fences: [], upperBound: bounds.mutation, expiresAt: Math.min(context.work.expiresAt, context.now + bounds.expiresInMs), transaction: null, github: null, impact: series ? 'major' : 'reversible' };
      },
      async perform(a, context) {
        const p = pinned(a), token = await options.token(p.account, kind === 'mail' ? 'gmail.send' : 'calendar.events');
        pinned(a);
        return context.commit(json(p), async () => {
          try {
            await options.google.request(p.wire.url, { method: p.wire.method, headers: { ...p.wire.headers, Authorization: `Bearer ${token}` }, body: p.wire.body }, () => {});
          } catch (e) { if (e instanceof GoogleFailure && [400, 401, 403, 404, 412, 422].includes(e.providerStatus)) return result('failed'); return result('unknown', false); }
          return readBack(a, p, token, () => { pinned(a); host().work.guard(host().control.bindWork(a.workId)); });
        });
      },
      reconcileUpperBound: bounds.reconciliation,
      async reconcile(a, context) { const p = pinned(a), scope = p.kind === 'mail' ? 'gmail.readonly' : 'calendar.readonly'; account(p.kind, scope); const token = await options.token(p.account, scope); pinned(a); return readBack(a, p, token, context.beforeRead); },
    };
  }
  const readHandler: ReadHandler = { operation: 'read', validate(value, context) {
    exact(value, ['contract', 'eventId']); if (value.contract !== 's15-calendar-read/v1') fail('read_operation_unavailable');
    string(value.eventId, 256); if (!/^[A-Za-z0-9_-]{1,256}$/.test(value.eventId)) fail('invalid_event');
    const a = account('calendar', 'calendar.readonly'); if (!equal(context.resource, a.resource)) fail('outside_scope');
    options.disclosure?.beforeRead(context.work, readPayload(a, value.eventId));
  } };
  /** A bounded actually-observed event snapshot; a caller-provided etag never populates this cache. */
  async function readEvent(actor: WorkActor, eventId: string, requestId: string, signal?: AbortSignal): Promise<EventSnapshot> {
    id(requestId); const a = account('calendar', 'calendar.readonly'), p = json({ contract: 's15-calendar-read/v1', eventId });
    const admitted = host().work.reserveRead(actor, { requestId, resource: a.resource, operation: 'read', exactPayload: p, upperBound: bounds.read, fences: [] });
    if (admitted.state !== 'allow') fail(admitted.code);
    let sent = false, returned = false, settled = false;
    try {
      const token = await options.token(a, 'calendar.readonly'); if (!equal(a, account('calendar', 'calendar.readonly'))) fail('personal_account_changed');
      const data = await options.google.request(endpoint(a) + '/' + encodeURIComponent(eventId), { headers: { Authorization: `Bearer ${token}` } }, () => { options.disclosure?.beforeRead(host().work.guard(actor), readPayload(a, eventId)); host().work.guardRead(actor, admitted.claim.id); sent = true; }, signal);
      returned = true; const observed = eventSnapshot(data); if (observed.id !== eventId) fail('invalid_event');
      const bytes = Buffer.byteLength(canonical(observed)); if (bytes > bounds.read.outputBytes) fail('output_limit');
      host().control.settleRead(admitted.claim.id, { outcome: 'succeeded', basis: 'remote_verified', code: null, actual: { ...unknownUsage(), outputBytes: bytes }, transportSettled: true }, digest('s15.event.observation.v1', observed)); settled = true;
      options.disclosure?.recordRead(actor, { account: a, eventId, version: observed.version });
      host().control.publishRead(actor, admitted.claim.id); const work = host().work.guard(actor); observations.set(`${work.id}:${eventId}`, observed); return structuredClone(observed);
    } catch (e) { if (!settled) host().control.settleRead(admitted.claim.id, { outcome: sent ? 'unknown' : 'not_dispatched', basis: sent ? 'uncertain' : 'local_guard', code: 'calendar_read_failed', actual: unknownUsage(), transportSettled: returned || !sent }, null); throw e; }
  }
  /** CHAT factory with host-owned slots: repeat proposals revise one unclaimed message/target; claims cannot be retried. */
  const tools: ConversationToolPort<ConversationPolicyWork> = { async open(work, input) {
    input.guard(); let sequence = 0;
    const actionTool = (kind: 'mail' | 'calendar') => ({ access: (kind === 'mail' ? 'effect' : 'reversible_write') as 'effect' | 'reversible_write', definition: {
      name: kind === 'mail' ? 'gmail_prepare_send' : 'calendar_edit', description: kind === 'mail' ? 'Prepare final email recipients/content/attachments for exact approval; a send request is not approval.' : 'Create a solo block or update an actually-read version. Attendees/notifications use the communication gate.', inputSchema: structuredClone(kind === 'mail' ? mailProposalSchema : calendarProposalSchema), execution: 'exclusive' as const, effect: 'mutating' as const,
      async execute(proposal: unknown) {
        input.guard(); if (!input.onAction) fail('adapter_unproven');
        if (kind === 'mail') validateMailProposal(proposal); else calendarProposal(proposal);
        const slot = kind === 'mail' ? 'final_message' : 'calendar_' + digest('s15.calendar.slot.v1', (proposal as CalendarProposal).eventId ?? 'create');
        const prepared = host().work.prepare(work.actor, { slot, adapter: kind === 'mail' ? 'gmail_send' : 'google_calendar', proposal }); const a = actionRef(prepared.action); input.onAction(a);
        if (prepared.decision.state !== 'allow') return { content: canonical({ state: prepared.decision.state, code: prepared.decision.code, action: a }), isError: true };
        input.guard(); const observed = await host().work.dispatch(work.actor, a); input.guard(); const published = host().control.publishable(work.actor, a);
        return { content: canonical({ state: observed.outcome, action: a, evidence: published.evidence ?? null }), isError: observed.outcome !== 'succeeded' };
      },
    } });
    return { tools: [{ access: 'read' as const, definition: { name: 'calendar_read', description: 'Read one approved calendar event and bind its actual version to this work.', inputSchema: { type: 'object', properties: { eventId: { type: 'string' } }, required: ['eventId'], additionalProperties: false }, execution: 'exclusive' as const, effect: 'read-only' as const, async execute(value: unknown) { exact(value, ['eventId']); string(value.eventId); input.guard(); const observed = await readEvent(work.actor, value.eventId, 'event_' + digest('s15.event.read.slot.v1', { work: work.authority.id, sequence: ++sequence }), input.signal); input.guard(); return { content: canonical(observed) }; } } }, ...(input.mode === 'execute' ? [actionTool('mail'), actionTool('calendar')] : [])], async cancel() {}, async close() {} };
  } };
  return { adapters: [adapter('mail'), adapter('calendar')].map(a => options.disclosure?.protectAdapter(a) ?? a), readHandler, tools, readEvent,
    attach(service: S15PolicyService) { if (policy) fail('policy_already_attached'); policy = service; },
    /** Current guarded work evidence, with no implicit read, retry or owner authority. */
    evidence(actor: WorkActor, a: ActionRef): EffectEvidence | null { const observed = host().control.publishable(actor, a); return observed.evidence ? structuredClone(observed.evidence) as unknown as EffectEvidence : null; },
  };
}
