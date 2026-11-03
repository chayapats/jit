import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openPolicyService, type ActionAdapter, type ActionDraft, type CatalogKind, type PolicyInput, type Ref, type SubscriptionModels, type WorkRequest } from '../src/s15/policy';
import { s15DefaultPolicy, s15MeteredBudget, s15SamePolicyScope } from '../src/s15/policy/defaults';
import { unknownUsage, zero } from '../src/s15/policy/validation';

const ref = (id: string): Ref => ({ id, revision: 1, generation: 1 });
const selection = { route: ref('route'), model: ref('model'), effort: 'high' };
const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

/** POLICY over an exact catalog, a zero-spend fixture adapter and an optional subscription registry. */
function open(registry: Partial<SubscriptionModels> | null, subscription = true) {
  const dir = mkdtempSync(join(tmpdir(), 'jit-s15-subscription-')); dirs.push(dir);
  let now = 1000, draft: ActionDraft = { operation: 'vm_shell', classes: ['guest_local_admin'], resources: [ref('computer')], recipients: [], payload: { command: 'true' }, fences: [], upperBound: { ...zero(), calls: 1, activeMs: 1000 }, expiresAt: 900000, transaction: null, github: null, impact: 'reversible' };
  const catalog = new Map<string, { ref: Ref; active: boolean }>();
  for (const [kind, ids] of Object.entries({ purpose: ['owner_requested_work', 'conversation_interpretation'], bot: ['jit'], resource: ['computer', 'repo'], recipient: ['provider'], route: ['route'], model: ['model'] })) for (const id of ids) catalog.set(`${kind}:${id}`, { ref: ref(id), active: true });
  const adapter: ActionAdapter = { id: 'working_vm', version: 1, prepare: () => structuredClone(draft), async perform(a, context) { return context.commit(a.payload, async () => ({ outcome: 'succeeded', actual: unknownUsage(), transportSettled: true })); } };
  const service = openPolicyService({ runtime: 's15', path: join(dir, 'policy.sqlite'), create: true, installationId: 'subscription_fixture', now: () => now, ownerGeneration: () => 1,
    verifyOwner: proof => proof === 'owner_session' ? { id: 'owner', generation: 1, expiresAt: 10_000_000 } : null,
    catalogs: { current: (kind: CatalogKind, id) => catalog.get(`${kind}:${id}`) ?? null, allows: () => true }, adapters: [adapter],
    ...(registry ? { subscriptionModels: { current: () => subscription, concurrency: 4, perWork: { calls: 8, steps: 8, activeMs: 100000 }, ...registry } as SubscriptionModels } : {}) });
  const owner = service.owner.authenticate('owner_session');
  const resources = [{ ref: ref('computer'), kind: 'computer' as const, label: 'working', adapters: [{ id: 'working_vm', operations: ['vm_shell'] }] }];
  const policy = (extra: typeof resources = []) => s15DefaultPolicy({ now: 0, bot: ref('jit'), resources: [...resources, ...extra], selections: [{ selection, recipient: ref('provider'), charge: 'subscription', label: 'codex' }], budget: null, lifetimeMs: 800000 })!;
  let serial = 0;
  const admit = (overrides: Partial<WorkRequest> = {}) => { const receipt = service.owner.admit(owner, { requestId: `work_${serial++}`, intent: 'execute', access: 'reversible_write', purpose: ref('owner_requested_work'), bot: ref('jit'), resources: [ref('computer')], recipients: [ref('provider')], selection, selectionPin: selection, expiresAt: 700000, ...overrides }); return service.control.bindWork(receipt.work!.id); };
  return { service, owner, policy, admit, set draft(value: ActionDraft) { draft = value; }, set now(value: number) { now = value; } };
}
const tools = { attempts: 4, steps: 4, calls: 2, reads: 3, outputBytes: 100000, activeMs: 10000 };

test('POLICY15-02: no budget is installable only for current subscription routes with finite tool bounds', () => {
  const ok = open({ tools }), proposal = ok.service.owner.proposePolicy(ok.owner, ok.policy());
  expect(proposal.installable).toBe(true);
  expect(proposal.fields.find(f => f.path === 'subscription.tools.calls')).toMatchObject({ value: 2, status: 'provided' });
  // Every enforced tool bound is part of the exact review and its hash.
  for (const [key, value] of Object.entries(tools)) expect(proposal.fields.find(f => f.path === `subscription.tools.${key}`)).toMatchObject({ value, status: 'provided' });
  expect(ok.service.owner.installProposal(ok.owner, 'install', proposal.proposalHash).budget).toBeNull();
  // A route the registry does not admit (metered, signed out) never installs without the owner's budget.
  const metered = open({ tools }, false); expect(metered.service.owner.proposePolicy(metered.owner, metered.policy()).installable).toBe(false);
  expect(() => metered.service.owner.installProposal(metered.owner, 'install', metered.service.owner.proposePolicy(metered.owner, metered.policy()).proposalHash)).toThrow('proposal_incomplete');
  // Without tool bounds the registry admits inference only, so a no-budget policy could not do any tool work.
  const inferenceOnly = open({}); expect(inferenceOnly.service.owner.proposePolicy(inferenceOnly.owner, inferenceOnly.policy()).installable).toBe(false);
  const none = open(null); expect(none.service.owner.proposePolicy(none.owner, none.policy()).installable).toBe(false);
  // With a finite budget a metered selection installs.
  const budget = s15MeteredBudget({ now: 0, policyExpiresAt: 800000, currency: 'USD', spendMinor: '500', periodId: 'days_30', concurrency: 2 })!;
  expect(metered.service.owner.proposePolicy(metered.owner, { ...metered.policy(), budget }).installable).toBe(true);
});

test('POLICY15-02: zero-spend tool charges use per-work bounds; spend is never admitted without a budget', async () => {
  const f = open({ tools }); f.service.owner.installProposal(f.owner, 'install', f.service.owner.proposePolicy(f.owner, f.policy()).proposalHash);
  const first = f.admit();
  expect(f.service.work.guard(first).readLimit).toBe(3);
  const a = f.service.work.prepare(first, { slot: 'one', adapter: 'working_vm', proposal: {} });
  expect(a.decision).toMatchObject({ state: 'allow' });
  expect((await f.service.work.dispatch(first, { id: a.action.id, revision: a.action.revision, actionHash: a.action.actionHash })).outcome).toBe('succeeded');
  const b = f.service.work.prepare(first, { slot: 'two', adapter: 'working_vm', proposal: {} });
  await f.service.work.dispatch(first, { id: b.action.id, revision: b.action.revision, actionHash: b.action.actionHash });
  // The third call exceeds this work's tool bound; another work has its own.
  expect(f.service.work.prepare(first, { slot: 'three', adapter: 'working_vm', proposal: {} }).decision).toMatchObject({ state: 'deny', code: 'budget_exhausted' });
  expect(f.service.work.prepare(f.admit(), { slot: 'one', adapter: 'working_vm', proposal: {} }).decision).toMatchObject({ state: 'allow' });
  f.draft = { operation: 'vm_shell', classes: ['guest_local_admin'], resources: [ref('computer')], recipients: [], payload: { command: 'paid' }, fences: [], upperBound: { ...zero(), calls: 1, spendMinor: '1' }, expiresAt: 900000, transaction: null, github: null, impact: 'reversible' };
  expect(f.service.work.prepare(f.admit(), { slot: 'paid', adapter: 'working_vm', proposal: {} }).decision).toMatchObject({ state: 'hold', code: 'cost_unknown' });
});

test('POLICY15-02: without tool bounds a no-budget policy keeps holding tool work for a finite budget', () => {
  const f = open({}); f.service.owner.install(f.owner, 'install', 0, f.policy());
  expect(f.service.work.prepare(f.admit(), { slot: 'one', adapter: 'working_vm', proposal: {} }).decision).toMatchObject({ state: 'hold', code: 'finite_budget_required' });
});

test('POLICY15-02: the proposal hash binds every row and a changed resource set is a new proposal, not a renewal', () => {
  const f = open({ tools });
  const one = f.service.owner.proposePolicy(f.owner, f.policy()), again = f.service.owner.proposePolicy(f.owner, f.policy());
  expect(again.proposalHash).toBe(one.proposalHash);
  const more = f.policy([{ ref: ref('repo'), kind: 'computer', label: 'repo', adapters: [{ id: 's15_github', operations: ['push'] }] }]);
  expect(f.service.owner.proposePolicy(f.owner, more).proposalHash).not.toBe(one.proposalHash);
  expect(s15SamePolicyScope(f.policy() as PolicyInput, more)).toBe(false);
  const installed = f.service.owner.installProposal(f.owner, 'install', one.proposalHash);
  expect(s15SamePolicyScope(installed, { ...f.policy(), expiresAt: installed.expiresAt + 5 })).toBe(true);
  expect(f.policy().rules.some(r => r.mode.startsWith('personal_github'))).toBe(false);
});
