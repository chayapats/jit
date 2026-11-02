import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDisclosureService, type DataClass, type DisclosureRoute, type DisclosureSource, type RecipientApproval } from '../../src/s15/disclosure';
import { unknownUsage } from '../../src/s15/policy/validation';
import type { ActionAdapter, JsonValue, Ref } from '../../src/s15/policy';
import { fixture, ref, bound } from './s15-policy';

/** Deterministic protected owning-service fakes; no serialized grants/world catalog or live account. */
export function disclosureFixture(extra: { route?: DisclosureRoute; adapter?: (d: ReturnType<typeof openDisclosureService>) => ActionAdapter } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jit-disclosure-')), path = join(dir, 'lineage.sqlite');
  const sources = new Map<string, DisclosureSource>();
  for (const classification of ['public', 'private', 'personal', 'business'] as const) sources.set(classification, { ref: ref(classification), resource: ref('account'), classification, active: true, ownerReleasable: true });
  const recipients = new Map(['payee', 'other', 'new_service'].map(name => [name, { ref: ref(name), active: true }]));
  const approvals: RecipientApproval[] = [];
  let now = 1000;
  const sent: JsonValue[] = [];
  const resolve: DisclosureRoute['resolve'] = (_work, payload) => {
    const request = payload as { url?: string; to?: string; request?: { url?: string } };
    const url = request.url ?? request.request?.url;
    if (url) { const u = new URL(url); if (u.username || u.password || !['http:', 'https:'].includes(u.protocol)) return null; return u.hostname === 'existing.test' ? [ref('payee')] : u.hostname === 'new.test' ? [ref('new_service')] : null; }
    return request.to === 'new_service' ? [ref('new_service')] : request.to === 'payee' ? [ref('payee')] : null;
  };
  const send: NonNullable<DisclosureRoute['send']> = async payload => { sent.push(structuredClone(payload)); return { outcome: 'succeeded', actual: unknownUsage(), transportSettled: true }; };
  const classify: NonNullable<DisclosureRoute['classify']> = () => ({ classes: ['ordinary_edit'], transaction: null, github: null, impact: 'reversible' });
  const routes: DisclosureRoute[] = [
    { id: 'browser', kind: 'browser', resolve, send, classify }, { id: 'artifact', kind: 'artifact', resolve, send, classify },
    { id: 'adapter', kind: 'adapter', resolve, send, classify }, { id: 'model', kind: 'model', resolve: (_w, p) => [(p as unknown as { recipient: Ref }).recipient] },
  ];
  if (extra.route) routes.push(extra.route);
  const options = { runtime: 's15' as const, path, create: true, installationId: 'disclosure_fixture', routes, now: () => now,
    catalogs: { source: (r: Ref) => sources.get(r.id) ?? null, recipient: (r: Ref) => recipients.get(r.id) ?? null, approvals: () => approvals },
    browserSource: (_work: unknown, url: string) => ref(new URL(url).pathname.includes('private') ? 'private' : 'public'), registryRecipient: (host: string) => host === 'existing.test' ? ref('payee') : host === 'new.test' ? ref('new_service') : null };
  const disclosure = openDisclosureService(options);
  const f = fixture({ adapters: [disclosure.adapter, ...(extra.adapter ? [extra.adapter(disclosure)] : [])], catalogs: base => disclosure.catalogs(base) });
  disclosure.attach(f.service);
  for (const s of sources.values()) f.add('lineage', s.ref);
  f.add('recipient', ref('new_service'));
  f.input.rules[0]!.adapters.push('private_disclosure', 'protected_browser', 'mail');
  f.input.rules[0]!.operations.push('disclose', 'browser_request');
  f.install(); const actor = f.admit({ access: 'effect' }).actor!;
  const grant = (recipient = 'payee', dataClasses: DataClass[] = ['private', 'personal', 'business']) => approvals.push({ recipient: ref(recipient), purpose: ref('purpose'), resources: [ref('account')], dataClasses, sources: null, expiresAt: 90000 });
  const prepare = (payload: JsonValue = { to: 'new_service', text: 'Quarterly margin is 12%' }, slot = 'disclosure', route = 'adapter') => disclosure.prepare(actor, { slot, route, payload, upperBound: bound(), expiresAt: 70000 });
  let approvalId = 0;
  const approve = (action: import('../../src/s15/policy').ActionRef) => f.service.owner.decide(f.owner, { requestId: 'disclosure_approval_' + approvalId++, action: { id: action.id, revision: action.revision, actionHash: action.actionHash }, decision: 'approve', expiresAt: 60000 });
  return { f, dir, path, disclosure, options, actor, sources, recipients, approvals, sent, prepare, grant, approve,
    advance(ms: number) { now += ms; f.now = now; },
    cleanup() { disclosure.close(); f.cleanup(); rmSync(dir, { recursive: true, force: true }); } };
}
