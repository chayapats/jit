import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPolicyService, type ActionAdapter, type ActionDraft, type ActionRef, type AdapterResult, type BudgetVector, type CatalogKind, type Fence, type OwnerActor, type PolicyInput, type Ref, type ReadHandler, type Rule, type Selection, type S15PolicyService, type WorkActor, type WorkRequest } from '../../src/s15/policy';
import { unknownUsage, zero } from '../../src/s15/policy/validation';

export const ref = (id: string): Ref => ({ id, revision: 1, generation: 1 });
export const selection: Selection = { route: ref('route'), model: ref('model'), effort: 'high' };
export const bound = (): BudgetVector => ({ ...zero(), calls: 1, spendMinor: '3' });
export const actionRef = (a: ActionRef): ActionRef => ({ id: a.id, revision: a.revision, actionHash: a.actionHash });
export const rule = (id = 'ordinary'): Rule => ({ id, mode: 'ordinary', purposes: [ref('purpose')], bots: [ref('bot')], resources: [ref('account'), ref('repo')], recipients: [ref('payee'), ref('other')], selections: [selection], adapters: ['fixture', 'fixture_payment'], operations: ['edit', 'send', 'publish', 'merge', 'pay', 'local_admin', 'system_admin', 'egress', 'production', 'major'], classes: ['ordinary_edit', 'guest_local_admin', 'guest_system_admin', 'new_egress', 'communication', 'github_publish', 'github_merge', 'financial', 'production', 'disclosure', 'major_change'], expiresAt: 100000, recurrence: null });
export const draft = (): ActionDraft => ({ operation: 'edit', classes: ['ordinary_edit'], resources: [ref('account')], recipients: [], payload: { content: 'exact\ntext  ', attachments: [] }, fences: [], upperBound: bound(), expiresAt: 90000, transaction: null, github: null, impact: 'reversible' });
export function fixture(extra: { adapters?: ActionAdapter[]; reads?: ReadHandler[]; create?: boolean; path?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'jit-s15-policy-'));
  const path = extra.path ?? join(dir, 'policy.sqlite');
  let clock = 1000, ownerGeneration = 1, live = true, allow = true;
  const catalog = new Map<string, { ref: Ref; active: boolean }>();
  const add = (kind: CatalogKind, r: Ref) => catalog.set(kind + ':' + r.id, { ref: structuredClone(r), active: true });
  for (const [kind, names] of Object.entries({ purpose: ['purpose'], bot: ['bot'], resource: ['account', 'repo', 'snapshot'], recipient: ['payee', 'other'], route: ['route'], model: ['model'], vm: ['vm'], input: ['input'], lineage: ['source', 'snapshot'] })) for (const name of names) add(kind as CatalogKind, ref(name));
  let currentDraft = draft(), calls = 0, wire: unknown = null, before: (() => Promise<void>) | null = null, outcome: AdapterResult = { outcome: 'succeeded', actual: unknownUsage(), transportSettled: true }, captured: (() => Promise<AdapterResult>) | null = null;
  const adapter: ActionAdapter = {
    id: 'fixture', version: 1,
    prepare() { return structuredClone(currentDraft); },
    async perform(a, context) { await before?.(); captured = () => context.commit(a.payload, async () => { calls++; return structuredClone(outcome); }); return context.commit((wire ?? a.payload) as typeof a.payload, async () => { calls++; return structuredClone(outcome); }); },
    async reconcile() { return structuredClone(outcome); },
  };
  let service: S15PolicyService;
  const open = (create: boolean) => openPolicyService({ runtime: 's15', path, create, installationId: 'test_installation', now: () => clock, ownerGeneration: () => ownerGeneration, verifyOwner: proof => proof === 'fixture_owner_session' && live ? { id: 'owner', generation: ownerGeneration, expiresAt: 1000000 } : null, catalogs: { current: (kind, id) => catalog.get(kind + ':' + id) ?? null, allows: () => allow }, adapters: [adapter, ...(extra.adapters ?? [])], reads: extra.reads ?? [] });
  service = open(extra.create ?? true);
  const owner = service.owner.authenticate('fixture_owner_session');
  const input: PolicyInput = { purposes: [ref('purpose')], bots: [ref('bot')], resources: [ref('account'), ref('repo')], recipients: [ref('payee'), ref('other')], selections: [selection], budget: { currency: 'USD', startsAt: 0, expiresAt: 100000, ceiling: { attempts: 20, steps: 20, calls: 20, reads: 20, outputBytes: 10000, activeMs: 100000, spendMinor: '100' }, concurrency: 5 }, rules: [rule()], expiresAt: 100000 };
  let serial = 0;
  const install = (policy = input) => { const old = service.owner.current(owner); return service.owner.install(owner, 'install_' + serial++, old?.revision ?? 0, policy); };
  const request = (overrides: Partial<WorkRequest> = {}): WorkRequest => ({ requestId: 'work_' + serial++, intent: 'execute', purpose: ref('purpose'), bot: ref('bot'), resources: [ref('account'), ref('repo')], recipients: [ref('payee'), ref('other')], selection: structuredClone(selection), selectionPin: null, expiresAt: 90000, ...overrides });
  const admit = (overrides: Partial<WorkRequest> = {}) => { const receipt = service.owner.admit(owner, request(overrides)); return { receipt, actor: receipt.work ? service.control.bindWork(receipt.work.id) : null }; };
  const prepare = (actor: WorkActor, slot = 'effect') => service.work.prepare(actor, { slot, adapter: 'fixture', proposal: {} });
  const approve = (a: ActionRef, decision: 'approve' | 'deny' = 'approve') => service.owner.decide(owner, { requestId: 'approve_' + serial++, action: actionRef(a), decision, expiresAt: 80000 });
  return { dir, path, input, owner, get service() { return service; }, install, request, admit, prepare, approve, get draft() { return currentDraft; }, set draft(d: ActionDraft) { currentDraft = d; }, get calls() { return calls; }, set wire(p: unknown) { wire = p; }, set before(fn: (() => Promise<void>) | null) { before = fn; }, set outcome(o: AdapterResult) { outcome = o; }, get captured() { return captured; }, catalog, add, get now() { return clock; }, set now(t: number) { clock = t; }, set ownerGeneration(g: number) { ownerGeneration = g; }, set live(value: boolean) { live = value; }, set allow(value: boolean) { allow = value; }, reopen() { service.control.close(); service = open(false); return service; }, cleanup() { service.control.close(); rmSync(dir, { recursive: true, force: true }); } };
}
export type Fixture = ReturnType<typeof fixture>;
export const held = (f: Fixture, operation: string, classes: ActionDraft['classes']) => { f.draft = { ...draft(), operation, classes, recipients: [ref('payee')] }; };
export const spoofOwner = {} as OwnerActor;
export const fence = (kind: Fence['kind'], id: string): Fence => ({ kind, ref: ref(id) });
