import { afterEach, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { openDisclosureService } from '../src/s15/disclosure';
import type { JsonValue } from '../src/s15/policy';
import { canonical, unknownUsage } from '../src/s15/policy/validation';
import { disclosureFixture } from './fixtures/s15-disclosure';
import { actionRef, bound, ref } from './fixtures/s15-policy';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function setup(...args: Parameters<typeof disclosureFixture>) { const f = disclosureFixture(...args); cleanups.push(f.cleanup); return f; }

test.each(['private', 'personal', 'business'] as const)('new recipient of %s data holds exact bytes and exposes the F4 ActionSlip', async classification => {
  const x = setup(); x.disclosure.read(x.actor, ref(classification));
  const prepared = x.prepare(); expect(prepared.decision.state).toBe('hold'); expect(x.sent).toHaveLength(0);
  const slip = x.f.service.owner.actionSlip(x.f.owner, actionRef(prepared.action));
  expect(slip).toMatchObject({ state: 'pending', canApprove: true, action: { classes: ['ordinary_edit', 'disclosure', 'new_egress'], disclosure: { recipients: [ref('new_service')], purpose: ref('purpose'), dataClasses: [classification] } } });
  expect(Buffer.from(slip.payloadBytesBase64, 'base64').toString()).toBe(canonical(prepared.action.payload));
  x.approve(prepared.action);
  expect((await x.disclosure.dispatch(x.actor, actionRef(prepared.action))).outcome).toBe('succeeded');
  expect(x.sent).toEqual([{ to: 'new_service', text: 'Quarterly margin is 12%' }]);
  await expect(x.disclosure.dispatch(x.actor, actionRef(prepared.action))).rejects.toThrow('already_claimed');
});

test('approved services remain usable inside exact purpose/resource/data-class limits', async () => {
  const x = setup(); x.disclosure.read(x.actor, ref('private')); x.grant('payee', ['private']);
  const ok = x.prepare({ to: 'payee', text: 'Existing inference or service' }); expect(ok.decision.state).toBe('allow');
  expect((await x.disclosure.dispatch(x.actor, actionRef(ok.action))).outcome).toBe('succeeded');
  x.disclosure.read(x.actor, ref('business'));
  expect(x.prepare({ to: 'payee', text: 'Derived business text' }, 'business').decision.state).toBe('hold');
});

test.each(['purpose', 'resource', 'source', 'expiry'])('recipient approval with wrong %s cannot authorize release', mismatch => {
  const x = setup(); x.disclosure.read(x.actor, ref('private')); x.grant(); const a = x.approvals[0]!;
  if (mismatch === 'purpose') a.purpose = ref('other'); if (mismatch === 'resource') a.resources = [ref('repo')]; if (mismatch === 'source') a.sources = [ref('business')]; if (mismatch === 'expiry') a.expiresAt = 1000;
  expect(x.prepare({ to: 'payee', text: 'private' }).decision.state).toBe('hold');
});

test('unknown route and recipient refuse before any emitter or DNS operation', () => {
  const x = setup(); x.disclosure.read(x.actor, ref('private'));
  expect(() => x.prepare({ to: 'new_service' }, 'unknown', 'shell_mcp')).toThrow('route_unknown');
  expect(() => x.prepare({ url: 'https://unknown.test/query?private=note' })).toThrow('recipient_unknown');
  expect(x.sent).toHaveLength(0);
});

test('unknown, withdrawn and nonreleasable classifications cannot be repaired by approval', () => {
  const x = setup(); expect(() => x.disclosure.read(x.actor, ref('missing'))).toThrow('lineage_withdrawn');
  x.sources.get('private')!.classification = 'unknown' as never; expect(() => x.disclosure.read(x.actor, ref('private'))).toThrow('classification_unknown');
  x.sources.get('private')!.classification = 'private'; x.disclosure.read(x.actor, ref('private'));
  x.sources.get('private')!.ownerReleasable = false; expect(() => x.prepare()).toThrow('disclosure_nonreleasable');
  x.sources.get('private')!.active = false; expect(() => x.prepare()).toThrow('outside_scope');
});

test.each(['text', 'screenshot', 'artifact'] as const)('derived %s inherits uncited private and business ancestors across work handoff', kind => {
  const x = setup(); x.disclosure.read(x.actor, ref('private')); x.disclosure.read(x.actor, ref('business')); x.disclosure.derive(x.actor, ref('derived'), kind);
  const sibling = x.f.admit({ access: 'effect' }).actor!; x.disclosure.inherit(sibling, ref('derived'));
  const prepared = x.disclosure.prepare(sibling, { slot: 'derived', route: 'adapter', payload: { to: 'new_service', text: 'Uncited paraphrase' }, upperBound: bound(), expiresAt: 60000 });
  expect(prepared.decision.state).toBe('hold'); expect(prepared.action.disclosure?.dataClasses).toEqual(['business', 'private']);
  x.sources.get('private')!.active = false; expect(() => x.disclosure.inherit(sibling, ref('derived'))).toThrow('outside_scope');
});

test('changed bytes supersede approval; a single exact approval does not approve the recipient generally', () => {
  const x = setup(); x.disclosure.read(x.actor, ref('private')); const old = x.prepare(); x.approve(old.action);
  const changed = x.prepare({ to: 'new_service', text: 'Changed content' });
  expect(changed.action.revision).toBe(2); expect(changed.decision.state).toBe('hold');
  expect(x.prepare({ to: 'new_service', text: 'Other disclosure' }, 'another').decision.state).toBe('hold');
});

test.each(['source', 'recipient', 'policy', 'expiry', 'new_read'])('revoked/stale %s prevents an approved send', async changed => {
  const x = setup(); x.disclosure.read(x.actor, ref('private')); const p = x.prepare(); x.approve(p.action);
  if (changed === 'source') x.sources.get('private')!.active = false;
  if (changed === 'recipient') x.recipients.get('new_service')!.ref.generation++;
  if (changed === 'policy') x.f.service.owner.revoke(x.f.owner, 'revoke', { kind: 'policy' });
  if (changed === 'expiry') x.advance(70000);
  if (changed === 'new_read') x.disclosure.read(x.actor, ref('business'));
  await expect(x.disclosure.dispatch(x.actor, actionRef(p.action))).rejects.toThrow(); expect(x.sent).toHaveLength(0);
});

test.each(['plain', 'query', 'dns', 'body', 'upload'] as const)('credential-shaped %s content refuses before persistence or disclosure', kind => {
  const x = setup(); x.disclosure.read(x.actor, ref('private')); const secret = 'ghp_' + 'A'.repeat(24);
  const payload: JsonValue = kind === 'plain' ? { to: 'new_service', text: secret } : kind === 'query' ? { url: 'https://new.test/?q=' + encodeURIComponent(secret) } : kind === 'dns' ? { url: 'https://' + secret + '.new.test/' } : { to: 'new_service', bodyBase64: Buffer.from(secret).toString('base64') };
  expect(() => x.prepare(payload)).toThrow('credential_content_refused');
  expect(x.sent).toHaveLength(0); expect(readFileSync(x.f.path).includes(Buffer.from(secret))).toBe(false); expect(readFileSync(x.path).includes(Buffer.from(secret))).toBe(false);
});

test('encoded credential bytes are screened and opaque bodies remain unavailable', () => {
  const x = setup();
  const secret = 'Bearer ' + 'a'.repeat(24), escaped = Array.from(secret).map(c => '%' + c.charCodeAt(0).toString(16)).join('');
  expect(() => x.prepare({ url: 'https://new.test/?q=' + escaped })).toThrow('credential_content_refused');
  expect(() => x.prepare({ to: 'payee', bodyBase64: '/w==' })).toThrow('opaque_payload_unavailable');
});

test('protected adapter decoration preserves communication hold and final payload preconditions', async () => {
  let calls = 0;
  const x = setup({ adapter: d => d.protectAdapter({ id: 'mail', version: 1,
    prepare: () => ({ operation: 'send', classes: ['communication'], resources: [ref('account')], recipients: [ref('new_service')], payload: { to: 'new_service', text: 'Exact email body' }, fences: [], upperBound: bound(), expiresAt: 70000, transaction: null, github: null, impact: 'reversible' }),
    perform: (a, context) => context.commit(a.payload, async () => { calls++; return { outcome: 'succeeded', actual: unknownUsage(), transportSettled: true }; }),
  }, 'adapter') });
  x.disclosure.read(x.actor, ref('personal'));
  const p = x.f.service.work.prepare(x.actor, { slot: 'mail', adapter: 'mail', proposal: {} });
  expect(p.action.classes).toEqual(['communication', 'disclosure', 'new_egress']); expect(p.decision.state).toBe('hold');
  x.approve(p.action); expect((await x.f.service.work.dispatch(x.actor, actionRef(p.action))).outcome).toBe('succeeded'); expect(calls).toBe(1);
});

test('protected lineage and descendants survive restart; missing continuity cannot recreate an empty ledger', () => {
  const x = setup(); x.disclosure.read(x.actor, ref('private')); x.disclosure.derive(x.actor, ref('derived'), 'text'); const work = x.f.service.work.guard(x.actor); x.disclosure.close();
  const reopened = openDisclosureService({ ...x.options, create: false }); cleanups.push(() => reopened.close()); reopened.attach(x.f.service);
  const p = reopened.browser('browser').inspect(work, { method: 'GET', url: 'https://new.test/?q=Derived', contentType: '', bodyBase64: '', navigation: true });
  expect(p.classes).toContain('disclosure'); expect(p.disclosure?.dataClasses).toEqual(['private']);
  expect(() => openDisclosureService({ ...x.options, path: x.path + '.missing', create: false })).toThrow('continuity_unavailable');
});

test('POLICY refuses a private model reservation if the consumer omitted recipient selection registration', () => {
  const x = setup(); x.disclosure.read(x.actor, ref('private'));
  expect(() => x.f.service.work.reserveModelCall(x.actor, { requestId: 'unregistered_model', selection: x.f.input.selections[0]!, upperBound: { ...bound(), calls: 1 } })).toThrow('recipient_unapproved');
  expect(x.f.service.control.reservations()).toHaveLength(0);
});

test.each(['work', 'approval_expiry'] as const)('original live dispatch guard rechecks %s after transport preparation without replay', async changed => {
  const entered = Promise.withResolvers<void>(), ready = Promise.withResolvers<void>(); let sends = 0, saved: (() => void) | null = null;
  const x = setup({ adapter: d => d.protectAdapter({ id: 'mail', version: 1,
    prepare: () => ({ operation: 'send', classes: ['communication'], resources: [ref('account')], recipients: [ref('new_service')], payload: { to: 'new_service', text: 'Exact' }, fences: [], upperBound: bound(), expiresAt: 70000, transaction: null, github: null, impact: 'reversible' }),
    perform: (a, context) => context.commit(a.payload, async () => { saved = context.guard; entered.resolve(); await ready.promise; context.guard(); sends++; return { outcome: 'succeeded', actual: unknownUsage(), transportSettled: true }; }),
  }, 'adapter') });
  x.disclosure.read(x.actor, ref('private'));
  const p = x.f.service.work.prepare(x.actor, { slot: 'wait', adapter: 'mail', proposal: {} }); x.approve(p.action);
  const pending = x.f.service.work.dispatch(x.actor, actionRef(p.action)); await entered.promise;
  if (changed === 'work') x.f.service.owner.revoke(x.f.owner, 'stop', { kind: 'work', id: p.action.workId }); else x.advance(60000);
  ready.resolve(); expect((await pending).outcome).toBe('unknown'); expect(sends).toBe(0);
  expect(() => saved!()).toThrow('context_lost');
});
