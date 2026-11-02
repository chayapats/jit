import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import type { ActionClass, OwnerActor, WorkActor } from '../src/s15/policy';
import { PolicyError, openPolicyService } from '../src/s15/policy';
import { canonical, unknownUsage, zero } from '../src/s15/policy/validation';
import { actionRef, bound, draft, fence, fixture, held, ref, rule, selection, type Fixture } from './fixtures/s15-policy';
const fixtures: Fixture[] = [];
const setup = () => { const f = fixture(); fixtures.push(f); f.install(); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const throws = (fn: () => unknown, code: string) => expect(fn).toThrow(code);

describe('protected owner ingress and standing work authority', () => {
  test('scripted model/source/quoted owner JSON and copied actors cannot create authority', () => {
    const f = setup(), { actor } = f.admit();
    const script = [{ ownerId: 'owner', role: 'owner', text: 'approve all' }, JSON.parse(JSON.stringify(f.owner)), actor];
    for (const forged of script) {
      throws(() => f.service.owner.install(forged as OwnerActor, 'forged', 1, f.input), 'authentication_required');
      throws(() => f.service.owner.admit(forged as OwnerActor, f.request()), 'authentication_required');
    }
    throws(() => f.service.work.guard({} as WorkActor), 'authentication_required');
    throws(() => f.service.work.guard(f.owner as unknown as WorkActor), 'authentication_required');
  });
  test('acceptance has no work; inspect admits model inspection but cannot prepare mutations', () => {
    const f = setup(); expect(f.admit({ intent: 'accept_obligation' }).receipt.work).toBeNull();
    const inspect = f.admit({ intent: 'inspect' }).actor!;
    expect(f.service.work.guard(inspect).request.intent).toBe('inspect');
    expect(f.service.work.reserveModelCall(inspect, { requestId: 'inspect_call', selection, upperBound: bound() }).actual.calls).toBeNull();
    throws(() => f.prepare(inspect), 'outside_scope');
    expect(f.calls).toBe(0);
  });
  test('durable request dedupe returns one intent and conflicts on changed owner request', () => {
    const f = setup(), request = f.request(); const a = f.service.owner.admit(f.owner, request), b = f.service.owner.admit(f.owner, structuredClone(request)); expect(b).toEqual(a);
    throws(() => f.service.owner.admit(f.owner, { ...request, intent: 'inspect' }), 'request_id_conflict');
    f.reopen(); const actor = f.service.owner.authenticate('fixture_owner_session'); expect(f.service.owner.admit(actor, request)).toEqual(a);
  });
  test('cross purpose/resource/model and current Bot/resource restrictions fail closed', () => {
    const f = setup();
    for (const changed of [{ purpose: ref('other_purpose') }, { resources: [ref('other_account')] }, { selection: { ...selection, model: ref('other_model') } }]) throws(() => f.admit(changed), 'outside_scope');
    const { actor } = f.admit(); f.allow = false; throws(() => f.service.work.guard(actor!), 'outside_scope');
  });
  test.each(['bot', 'resource', 'route', 'model', 'vm', 'input', 'lineage'] as const)('current %s generation checked on durable work guard', kind => {
    const f = setup(); const id = kind === 'resource' ? 'account' : kind === 'route' ? 'route' : kind === 'model' ? 'model' : kind === 'lineage' ? 'source' : kind;
    const { actor } = f.admit({ fences: [fence(kind, id)] }); f.catalog.get(kind + ':' + id)!.ref.generation++;
    throws(() => f.service.work.guard(actor!), 'stale_authority');
  });
  test('logout does not revoke durable work/approval; owner generation and policy changes do', () => {
    const f = setup(), { actor } = f.admit(); held(f, 'send', ['communication']); const a = f.prepare(actor!).action; f.approve(a); f.live = false;
    expect(f.service.work.evaluate(actor!, actionRef(a)).state).toBe('allow'); throws(() => f.service.owner.current(f.owner), 'authentication_required');
    f.ownerGeneration = 2; throws(() => f.service.work.guard(actor!), 'authority_revoked');
  });
  test('new owner policy invalidates all old work without resetting consumed budget', () => {
    const f = setup(), { actor } = f.admit(); f.service.work.reserveModelCall(actor!, { requestId: 'call', selection, upperBound: bound() }); f.install();
    throws(() => f.service.work.guard(actor!), 'stale_authority'); expect(f.service.control.usage().charged.spendMinor).toBe('3');
  });
});

describe('exact preparation, approval and action classes', () => {
  test('ordinary edit and guest-local admin execute under an ordinary rule', async () => {
    const f = setup(), { actor } = f.admit();
    for (const [operation, cls] of [['edit', 'ordinary_edit'], ['local_admin', 'guest_local_admin']] as const) { f.draft = { ...draft(), operation, classes: [cls] }; const p = f.prepare(actor!, operation); expect(p.decision.state).toBe('allow'); expect((await f.service.work.dispatch(actor!, actionRef(p.action))).outcome).toBe('succeeded'); }
    expect(f.calls).toBe(2);
  });
  test('system guest admin requires a current protected snapshot bound to its action', () => {
    const f = setup(), { actor } = f.admit(); held(f, 'system_admin', ['guest_system_admin']); let p = f.prepare(actor!); expect(p.decision).toEqual({ state: 'hold', code: 'snapshot_required' }); throws(() => f.approve(p.action), 'snapshot_required');
    f.draft = { ...f.draft, snapshot: fence('lineage', 'snapshot'), fences: [fence('lineage', 'snapshot')] }; p = f.prepare(actor!); expect(p.decision.state).toBe('allow'); f.catalog.get('lineage:snapshot')!.active = false; expect(f.service.work.evaluate(actor!, actionRef(p.action))).toEqual({ state: 'deny', code: 'authority_revoked' });
  });
  test.each([['send', 'communication', 'approval_required'], ['publish', 'github_publish', 'approval_required'], ['production', 'production', 'production_approval_required'], ['egress', 'new_egress', 'egress_approval_required'], ['major', 'major_change', 'approval_required']] as const)('%s is held by default', (operation, cls, code) => {
    const f = setup(), { actor } = f.admit(); held(f, operation, [cls as ActionClass]);
    if (cls === 'github_publish') f.draft = { ...f.draft, resources: [ref('repo')], github: { repository: ref('repo'), issue: 320, target: 'main', head: 'a'.repeat(40), evidenceHash: 'b'.repeat(64), checksPassed: true, reviewsPassed: true, acceptancePassed: true, production: 'none', deploymentFence: null } };
    const p = f.prepare(actor!); expect(p.decision).toEqual({ state: 'hold', code }); expect(f.calls).toBe(0);
  });
  test('unknown adapter/action classification refuses before any claim', () => {
    const f = setup(), { actor } = f.admit(); throws(() => f.service.work.prepare(actor!, { slot: 'unknown', adapter: 'shell_network', proposal: {} }), 'adapter_unproven');
    f.draft = { ...draft(), classes: ['alien'] as unknown as ActionClass[] }; throws(() => f.prepare(actor!), 'adapter_unproven'); expect(f.service.control.usage().charged.calls).toBe(0);
  });
  test.each(['payload', 'recipients', 'attachments', 'fences', 'expiry'] as const)('changed %s supersedes revision and old approval', field => {
    const f = setup(), { actor } = f.admit(); held(f, 'send', ['communication']); const a = f.prepare(actor!).action, original = structuredClone(a); f.approve(a); expect(f.service.owner.inspect(f.owner, actionRef(a)).action).toEqual(original);
    if (field === 'payload') f.draft.payload = { content: 'changed' };
    if (field === 'recipients') f.draft.recipients = [ref('other')];
    if (field === 'attachments') f.draft.payload = { content: 'exact\ntext  ', attachments: ['attachment_changed'] };
    if (field === 'fences') f.draft.fences = [fence('vm', 'vm')];
    if (field === 'expiry') f.draft.expiresAt--;
    const next = f.prepare(actor!).action; expect(next.revision).toBe(a.revision + 1); expect(next.actionHash).not.toBe(a.actionHash); throws(() => f.service.work.evaluate(actor!, actionRef(a)), 'stale_action'); expect(f.service.work.evaluate(actor!, actionRef(next)).state).toBe('hold');
  });
  test('exact owner approval is single-use and immutable, and a denial vetoes a standing rule', async () => {
    const f = setup(), { actor } = f.admit(); held(f, 'send', ['communication']); const p = f.prepare(actor!); f.approve(p.action); const before = structuredClone(p.action);
    expect((await f.service.work.dispatch(actor!, actionRef(p.action))).outcome).toBe('succeeded'); expect(f.service.owner.inspect(f.owner, actionRef(p.action)).action).toEqual(before);
    await expect(f.service.work.dispatch(actor!, actionRef(p.action))).rejects.toThrow('already_claimed'); throws(() => f.approve(p.action), 'already_claimed'); expect(f.calls).toBe(1);
    const g = setup(); const exception = rule('communications'); exception.mode = 'communication'; g.input.rules.push(exception); g.install(); const w = g.admit().actor!; held(g, 'send', ['communication']); const a = g.prepare(w).action; expect(g.service.work.evaluate(w, actionRef(a)).state).toBe('allow'); g.approve(a, 'deny'); expect(g.service.work.evaluate(w, actionRef(a))).toEqual({ state: 'deny', code: 'action_denied' });
  });
  test('overlapping standing exceptions hold rather than selecting a permissive first match', () => {
    const f = setup(); const a = rule('one'), b = rule('two'); a.mode = b.mode = 'communication'; f.input.rules.push(a, b); f.install(); const w = f.admit().actor!; held(f, 'send', ['communication']); expect(f.prepare(w).decision).toEqual({ state: 'hold', code: 'ambiguous_rule' });
  });
});

describe('finite model/effect reservations and exact final dispatch', () => {
  test('unspecified operating budget and unknown costs are held, never free', () => {
    const f = setup(); f.input.budget = null; f.install(); const w = f.admit().actor!; expect(f.prepare(w).decision).toEqual({ state: 'hold', code: 'finite_budget_required' }); throws(() => f.service.work.reserveModelCall(w, { requestId: 'call', selection, upperBound: bound() }), 'finite_budget_required');
    const g = setup(), a = g.admit().actor!; g.draft.upperBound = null; expect(g.prepare(a).decision).toEqual({ state: 'hold', code: 'cost_unknown' });
  });
  test('finite reservations consume once, duplicates cannot cause another model call, unknown usage retains capacity', () => {
    const f = setup(); f.input.budget!.ceiling.spendMinor = '3'; f.input.budget!.concurrency = 1; f.install(); const w = f.admit().actor!;
    const r = f.service.work.reserveModelCall(w, { requestId: 'call', selection, upperBound: bound() }); expect(r.actual).toEqual(unknownUsage());
    throws(() => f.service.work.reserveModelCall(w, { requestId: 'call', selection, upperBound: bound() }), 'reservation_already_claimed'); throws(() => f.service.work.reserveModelCall(w, { requestId: 'call', selection, upperBound: { ...bound(), calls: 2 } }), 'request_id_conflict');
    f.service.control.settleReservation(r.id, unknownUsage(), false); expect(f.service.control.usage().unsettled).toBe(1); throws(() => f.service.work.reserveModelCall(w, { requestId: 'next', selection, upperBound: bound() }), 'budget_exhausted');
    f.service.control.settleReservation(r.id, unknownUsage(), true); expect(f.service.control.usage().charged.spendMinor).toBe('3');
  });
  test('model selection pin and current route/model are checked at reservation', () => {
    const f = setup(), w = f.admit({ selectionPin: selection }).actor!; throws(() => f.service.work.reserveModelCall(w, { requestId: 'call', selection: { ...selection, effort: 'low' }, upperBound: bound() }), 'selection_pinned'); f.catalog.get('route:route')!.active = false; throws(() => f.service.work.reserveModelCall(w, { requestId: 'call', selection, upperBound: bound() }), 'authority_revoked');
  });
  test('the original claim can spend its final allowance without charging twice', async () => {
    const f = setup(); f.input.budget!.ceiling.spendMinor = '3'; f.install(); const w = f.admit().actor!, a = f.prepare(w).action; expect((await f.service.work.dispatch(w, actionRef(a))).outcome).toBe('succeeded'); expect(f.service.control.usage()).toEqual({ charged: bound(), unsettled: 0 }); expect(f.service.control.publishable(w, actionRef(a)).outcome).toBe('succeeded');
  });
  test.each(['work', 'policy', 'owner', 'expiry', 'source', 'vm', 'input'] as const)('%s change after claim fences I/O and retains claim/charge', async which => {
    const f = setup(), w = f.admit().actor!; f.draft.fences = [fence('lineage', 'source'), fence('vm', 'vm'), fence('input', 'input')]; const a = f.prepare(w).action;
    f.before = async () => { if (which === 'work' || which === 'policy') f.service.owner.revoke(f.owner, 'revoke', which === 'work' ? { kind: 'work', id: a.workId } : { kind: 'policy' }); else if (which === 'owner') f.ownerGeneration = 2; else if (which === 'expiry') f.now = 90000; else f.catalog.get((which === 'source' ? 'lineage:source' : which + ':' + which))!.ref.generation++; };
    const result = await f.service.work.dispatch(w, actionRef(a)); expect(result.outcome).toBe('not_dispatched'); expect(f.calls).toBe(0); expect(f.service.control.usage().charged.spendMinor).toBe('3');
    if (which === 'source') expect(() => f.service.owner.inspect(f.owner, actionRef(a))).toThrow('lineage_withdrawn'); else expect(f.service.owner.inspect(which === 'owner' ? f.service.owner.authenticate('fixture_owner_session') : f.owner, actionRef(a)).observation?.outcome).toBe('not_dispatched');
  });
  test('changed wire bytes are refused after durable claim, and live context cannot send twice', async () => {
    const f = setup(), w = f.admit().actor!, a = f.prepare(w).action; f.wire = { content: 'substituted' }; const observed = await f.service.work.dispatch(w, actionRef(a)); expect(observed.code).toBe('hash_mismatch'); expect(f.calls).toBe(0); throws(() => f.captured!(), 'already_claimed');
  });
  test('unknown effects survive restart, owner statements and policy changes without retry', async () => {
    const f = setup(), w = f.admit().actor!, a = f.prepare(w).action; f.outcome = { outcome: 'unknown', actual: unknownUsage(), transportSettled: false }; await f.service.work.dispatch(w, actionRef(a)); f.reopen();
    throws(() => f.service.work.guard(w), 'authentication_required'); const owner = f.service.owner.authenticate('fixture_owner_session'), recovered = f.service.control.bindWork(a.workId); expect(f.service.owner.inspect(owner, actionRef(a)).observation?.outcome).toBe('unknown'); await expect(f.service.work.dispatch(recovered, actionRef(a))).rejects.toThrow('already_claimed');
    f.service.owner.recordStatement(owner, actionRef(a), 'statement', 'did_not_occur'); expect(f.service.owner.inspect(owner, actionRef(a)).observation?.basis).toBe('uncertain'); expect(f.service.control.usage().unsettled).toBe(1); expect(f.calls).toBe(1);
  });
  test('missing or foreign continuity refuses before touching existing bytes', () => {
    const f = setup(); const bytes = readFileSync(f.path); f.service.control.close(); writeFileSync(f.path, 'foreign'); const foreign = readFileSync(f.path); expect(() => openPolicyService({ runtime: 's15', path: f.path, create: false, installationId: 'test_installation', ownerGeneration: () => 1, verifyOwner: () => null, catalogs: { current: () => null, allows: () => false }, adapters: [] })).toThrow('continuity_unavailable'); expect(readFileSync(f.path)).toEqual(foreign); writeFileSync(f.path, bytes);
  });
  test('closed shapes, accessors, sparse arrays and invalid numbers fail before mutation', () => {
    const f = setup(); const request = f.request(); throws(() => f.service.owner.admit(f.owner, { ...request, ownerId: 'owner' } as typeof request), 'invalid_shape');
    const obj = Object.defineProperty({}, 'hidden', { get() { throw new Error('getter_called'); }, enumerable: true }); throws(() => canonical(obj), 'invalid_shape'); throws(() => canonical(new Array(2)), 'invalid_shape'); throws(() => canonical(-0), 'invalid_number'); throws(() => canonical(Number.POSITIVE_INFINITY), 'invalid_number'); expect(f.service.control.usage().charged).toEqual(zero());
  });
});

describe('GitHub default, opt-in personal publication and production gates', () => {
  function github(f: Fixture, operation: 'publish' | 'merge' = 'publish') {
    f.draft = { ...draft(), operation, classes: operation === 'publish' ? ['github_publish', 'communication'] : ['github_merge'], resources: [ref('repo')], recipients: [], github: { repository: ref('repo'), issue: 320, target: 'main', head: 'a'.repeat(40), evidenceHash: 'b'.repeat(64), checksPassed: true, reviewsPassed: true, acceptancePassed: true, production: 'none', deploymentFence: null } };
  }
  test('personal publication must be explicitly installed, target-bound and selected-and-started', () => {
    const f = setup(); github(f); let w = f.admit({ subject: { resource: ref('repo'), issue: 320 } }).actor!; expect(f.prepare(w).decision.state).toBe('hold');
    const personal = rule('personal_publish'); personal.mode = 'personal_github_publish'; personal.github = { repository: ref('repo'), target: 'main' }; f.input.rules.push(personal); f.install(); w = f.admit({ subject: { resource: ref('repo'), issue: 320 } }).actor!; expect(f.prepare(w).decision.state).toBe('allow');
    const noSelection = f.admit().actor!; expect(f.prepare(noSelection).decision.state).toBe('hold');
    f.draft.github!.target = 'production'; expect(f.prepare(w).decision.state).toBe('hold');
    f.draft.github!.target = 'main'; f.draft.github!.checksPassed = false; expect(f.prepare(w).decision.state).toBe('hold');
  });
  test('publication authority cannot merge; separate merge rule still holds a production-triggering merge', () => {
    const f = setup(), personal = rule('publish'); personal.mode = 'personal_github_publish'; personal.github = { repository: ref('repo'), target: 'main' }; f.input.rules.push(personal); f.install(); github(f, 'merge'); let w = f.admit({ subject: { resource: ref('repo'), issue: 320 } }).actor!; expect(f.prepare(w).decision).toEqual({ state: 'hold', code: 'merge_authority_required' });
    const merge = rule('merge'); merge.mode = 'personal_github_merge'; merge.github = { repository: ref('repo'), target: 'main' }; f.input.rules.push(merge); f.install(); w = f.admit({ subject: { resource: ref('repo'), issue: 320 } }).actor!; expect(f.prepare(w).decision.state).toBe('allow');
    f.draft.github!.production = 'would_deploy'; const held = f.prepare(w); expect(held.decision).toEqual({ state: 'hold', code: 'production_approval_required' }); f.approve(held.action); expect(f.service.work.evaluate(w, actionRef(held.action)).state).toBe('allow');
  });
  test('a protected deployment gate must be current and bound to final action fences', () => {
    const f = setup(), merge = rule('merge'); merge.mode = 'personal_github_merge'; merge.github = { repository: ref('repo'), target: 'main' }; f.input.rules.push(merge); f.install(); github(f, 'merge'); f.draft.github!.production = 'protected_gate'; const w = f.admit({ subject: { resource: ref('repo'), issue: 320 } }).actor!; expect(f.prepare(w).decision.state).toBe('hold');
    const gate = fence('resource', 'snapshot'); f.draft.github!.deploymentFence = gate; f.draft.fences = [gate]; const a = f.prepare(w); expect(a.decision.state).toBe('allow'); f.catalog.get('resource:snapshot')!.active = false; expect(f.service.work.evaluate(w, actionRef(a.action)).state).toBe('deny');
  });
});

test('a new eligible egress recipient is held until one exact owner release', async () => {
  const f = setup(); f.add('recipient', ref('new_destination')); const w = f.admit().actor!; held(f, 'egress', ['new_egress']); f.draft.recipients = [ref('new_destination')]; const a = f.prepare(w); expect(a.decision).toEqual({ state: 'hold', code: 'egress_approval_required' }); f.approve(a.action); expect((await f.service.work.dispatch(w, actionRef(a.action))).outcome).toBe('succeeded');
});
test('approval expiry is rechecked after claim, and an expired approval cannot dispatch', async () => {
  const f = setup(), w = f.admit().actor!; held(f, 'send', ['communication']); const a = f.prepare(w).action; f.approve(a); f.before = async () => { f.now = 80000; }; expect((await f.service.work.dispatch(w, actionRef(a))).outcome).toBe('not_dispatched'); expect(f.calls).toBe(0);
});
test('registered or credential-shaped payloads refuse before persistence/hash binding', async () => {
  const { registerSecretFingerprint } = await import('../src/security/secret-fingerprints'); const synthetic = 'synthetic-policy-secret-do-not-use'; registerSecretFingerprint(synthetic);
  const f = setup(), w = f.admit().actor!; f.draft.payload = { content: synthetic }; expect(() => f.prepare(w)).toThrow('credential_content_refused'); expect(f.calls).toBe(0);
});
test('array accessors and extra sparse properties never execute during validation', () => {
  let called = false; const a = Object.defineProperty([], '0', { enumerable: true, get() { called = true; return 'value'; } }); expect(() => canonical(a)).toThrow('invalid_shape'); expect(called).toBe(false); const b = new Array(2); b[0] = 'one'; Object.assign(b, { other: 'extra' }); expect(() => canonical(b)).toThrow('invalid_shape');
});

test('reserved alternative model is fenced at the final model-call boundary', () => {
  const f = setup(), alternate = { route: ref('alternate_route'), model: ref('alternate_model'), effort: 'high' }; f.add('route', alternate.route); f.add('model', alternate.model); f.input.selections.push(alternate); f.install(); const w = f.admit().actor!, r = f.service.work.reserveModelCall(w, { requestId: 'alternate_call', selection: alternate, upperBound: bound() }); expect(r.selection).toEqual(alternate); f.catalog.get('model:alternate_model')!.ref.generation++; expect(() => f.service.work.guardReservation(w, r.id)).toThrow('stale_authority');
});
test('disabling and re-enabling a budget cannot reinterpret charged currency', () => {
  const f = setup(), w = f.admit().actor!; f.service.work.reserveModelCall(w, { requestId: 'call', selection, upperBound: bound() }); const budget = f.input.budget!; f.input.budget = null; f.install(); f.input.budget = { ...budget, currency: 'EUR' }; expect(() => f.install()).toThrow('budget_currency_changed');
});
test('measured budget overrun fences subsequent admissions without refunding the original charge', () => {
  const f = setup(), w = f.admit().actor!, r = f.service.work.reserveModelCall(w, { requestId: 'call', selection, upperBound: bound() }); f.service.control.settleReservation(r.id, { ...unknownUsage(), spendMinor: '4' }, true); expect(() => f.service.work.reserveModelCall(w, { requestId: 'call_two', selection, upperBound: bound() })).toThrow('budget_exhausted'); expect(f.service.control.usage().charged.spendMinor).toBe('3');
});

test('a relative or SQLite in-memory alias cannot bypass durable protected ledger creation', () => {
  expect(() => openPolicyService({ runtime: 's15', path: ':memory:', create: true, installationId: 'test', ownerGeneration: () => 1, verifyOwner: () => null, catalogs: { current: () => null, allows: () => false }, adapters: [] })).toThrow('protected_ledger_path_required');
});

test('frozen read/reversible-write access cannot be widened by a standing communication exception', () => {
  const f = setup(), communication = rule('communication'); communication.mode = 'communication'; f.input.rules.push(communication); f.install(); const read = f.admit({ access: 'read' }).actor!; expect(() => f.prepare(read)).toThrow('outside_scope'); const reversible = f.admit({ access: 'reversible_write' }).actor!; expect(f.prepare(reversible).decision.state).toBe('allow'); held(f, 'send', ['communication']); expect(() => f.prepare(reversible, 'send')).toThrow('outside_scope'); expect(f.calls).toBe(0);
});

test('manual approval cannot repair unknown production consequences or missing merge evidence', () => {
  const f = setup(), w = f.admit({ subject: { resource: ref('repo'), issue: 320 } }).actor!; f.draft = { ...draft(), operation: 'merge', classes: ['github_merge'], resources: [ref('repo')], github: { repository: ref('repo'), issue: 320, target: 'main', head: 'a'.repeat(40), evidenceHash: 'b'.repeat(64), checksPassed: true, reviewsPassed: true, acceptancePassed: true, production: 'unknown', deploymentFence: null } }; let p = f.prepare(w); expect(p.decision).toEqual({ state: 'hold', code: 'production_impact_required' }); expect(() => f.approve(p.action)).toThrow('production_impact_required'); f.draft.github!.production = 'none'; f.draft.github!.reviewsPassed = false; p = f.prepare(w); expect(p.decision).toEqual({ state: 'hold', code: 'github_evidence_required' }); expect(() => f.approve(p.action)).toThrow('github_evidence_required');
});
