import { afterEach, describe, expect, test } from 'bun:test';
import type { ActionClass, GithubConditions, Rule } from '../src/s15/policy';
import { actionRef, draft, fixture, ref, rule, type Fixture } from './fixtures/s15-policy';

// AUTH16-01 (ADR 0084, standing-policy contract revision 3): classification table for the product-default rules.
const fixtures: Fixture[] = [];
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });
const named = (): Rule => ({ ...rule('owner_named_sends'), mode: 'owner_named_send', recipients: [], classes: ['ordinary_edit', 'communication'] });
const github = (): Rule => ({ ...rule('github_after_checks'), mode: 'github_default', resources: [ref('repo')], recipients: [], adapters: ['fixture'], operations: ['merge', 'publish'], classes: ['communication', 'github_merge', 'github_publish'] });
function setup(rules: Rule[] = [rule(), named(), github()]) {
  const f = fixture(); fixtures.push(f);
  f.catalog.set('recipient:alice', { ref: ref('alice'), active: true });
  f.catalog.set('recipient:mallory', { ref: ref('mallory'), active: true });
  f.install({ ...f.input, rules });
  return f;
}
const send = (f: Fixture, recipients: string[]) => { f.draft = { ...draft(), operation: 'send', classes: ['communication'], recipients: recipients.map(ref) }; };
const conditions = (over: Partial<GithubConditions> = {}): GithubConditions => ({ repository: ref('repo'), issue: 442, target: 'main', head: 'a'.repeat(40), evidenceHash: 'b'.repeat(64), checksPassed: true, reviewsPassed: true, acceptancePassed: true, production: 'none', deploymentFence: null, ...over });
const gh = (f: Fixture, operation: 'publish' | 'merge', over: Partial<GithubConditions> = {}, extra: ActionClass[] = []) => {
  f.draft = { ...draft(), operation, classes: [...(operation === 'merge' ? ['github_merge' as const] : ['github_publish' as const, 'communication' as const]), ...extra], resources: [ref('repo')], recipients: [], github: conditions(over) };
};

describe('owner-named sends (S16-D07 b)', () => {
  test('a send to exactly the recipients the owner named runs without approval, once', async () => {
    const f = setup(), { actor } = f.admit({ recipients: [ref('payee'), ref('other'), ref('alice')], named: [ref('alice')] });
    send(f, ['alice']); const p = f.prepare(actor!);
    expect(p.decision).toEqual({ state: 'allow', rules: ['owner_named_sends'], approval: null });
    expect((await f.service.work.dispatch(actor!, actionRef(p.action))).outcome).toBe('succeeded');
    await expect(f.service.work.dispatch(actor!, actionRef(p.action))).rejects.toThrow('already_claimed');
    expect(f.calls).toBe(1);
  });
  test('an extra recipient, an unnamed recipient or a work without an owner message (routine/steer) waits', () => {
    const f = setup();
    const owner = f.admit({ recipients: [ref('payee'), ref('other'), ref('alice')], named: [ref('alice')] }).actor!;
    send(f, ['alice', 'other']); expect(f.prepare(owner, 'extra').decision).toEqual({ state: 'hold', code: 'approval_required' });
    send(f, ['other']); expect(f.prepare(owner, 'unnamed').decision).toEqual({ state: 'hold', code: 'approval_required' });
    const routine = f.admit().actor!;
    send(f, ['other']); expect(f.prepare(routine, 'routine').decision).toEqual({ state: 'hold', code: 'approval_required' });
    expect(f.calls).toBe(0);
  });
  test('a held send still dispatches after one exact approval; changed content needs a new decision', async () => {
    const f = setup(), { actor } = f.admit();
    send(f, ['other']); const first = f.prepare(actor!); expect(first.decision.state).toBe('hold');
    f.approve(first.action); f.draft = { ...f.draft, payload: { content: 'changed', attachments: [] } };
    const changed = f.prepare(actor!); expect(changed.action.revision).toBe(2); expect(changed.decision).toEqual({ state: 'hold', code: 'approval_required' });
    f.approve(changed.action); expect((await f.service.work.dispatch(actor!, actionRef(changed.action))).outcome).toBe('succeeded'); expect(f.calls).toBe(1);
  });
  test('named recipients must be in the request and current; an older policy without the rule cannot widen scope', () => {
    const f = setup();
    expect(() => f.admit({ named: [ref('alice')] })).toThrow('invalid_shape');
    f.catalog.get('recipient:alice')!.active = false;
    expect(() => f.admit({ recipients: [ref('alice')], named: [ref('alice')] })).toThrow();
    const old = setup([rule()]);
    expect(() => old.admit({ recipients: [ref('alice')], named: [ref('alice')] })).toThrow('outside_scope');
    // Installed meaning is unchanged: the same named send under the older policy is held for approval.
    const { actor } = old.admit({ named: [ref('other')] }); send(old, ['other']);
    expect(old.prepare(actor!).decision).toEqual({ state: 'hold', code: 'approval_required' });
  });
});

describe('GitHub product default (S16-D07 d)', () => {
  test('push/PR/review reply and a merge after required checks and reviews run without approval', async () => {
    const f = setup(), { actor } = f.admit();
    gh(f, 'publish', { checksPassed: false, acceptancePassed: false }); const publish = f.prepare(actor!, 'publish');
    expect(publish.decision).toEqual({ state: 'allow', rules: ['github_after_checks'], approval: null });
    gh(f, 'merge'); const merge = f.prepare(actor!, 'merge');
    expect(merge.decision).toEqual({ state: 'allow', rules: ['github_after_checks'], approval: null });
    expect((await f.service.work.dispatch(actor!, actionRef(merge.action))).outcome).toBe('succeeded');
  });
  test('a merge without passed required checks or reviews is not mergeable, even with approval', () => {
    const f = setup(), { actor } = f.admit();
    gh(f, 'merge', { reviewsPassed: false }); expect(f.prepare(actor!, 'reviews').decision).toEqual({ state: 'hold', code: 'github_evidence_required' });
    gh(f, 'merge', { checksPassed: false }); const p = f.prepare(actor!, 'checks'); expect(p.decision).toEqual({ state: 'hold', code: 'github_evidence_required' });
    expect(() => f.approve(p.action)).toThrow();
  });
  test('a production deploy waits for the owner', () => {
    const f = setup(), { actor } = f.admit();
    gh(f, 'merge', { production: 'would_deploy' }, ['production']); const p = f.prepare(actor!, 'deploy');
    expect(p.decision.state).toBe('hold'); expect(['merge_authority_required', 'production_approval_required']).toContain((p.decision as { code: string }).code);
    gh(f, 'publish', { production: 'would_deploy' }); expect(f.prepare(actor!, 'deploy_push').decision).toEqual({ state: 'hold', code: 'production_approval_required' });
  });
  test('another repository is outside the default rule and waits', () => {
    const f = setup([rule(), named(), { ...github(), resources: [ref('account')] }]), { actor } = f.admit();
    gh(f, 'publish'); expect(f.prepare(actor!).decision).toEqual({ state: 'hold', code: 'approval_required' });
  });
});

describe('the rest of the human-required list stays held under the default', () => {
  test.each([['pay', 'financial'], ['major', 'major_change'], ['egress', 'new_egress'], ['send', 'disclosure']] as const)('%s (%s) waits', (operation, cls) => {
    const f = setup(), { actor } = f.admit({ recipients: [ref('payee'), ref('other'), ref('alice')], named: [ref('alice')] });
    f.draft = { ...draft(), operation, classes: cls === 'disclosure' ? ['communication', 'disclosure'] : [cls], recipients: cls === 'disclosure' ? [ref('alice')] : cls === 'financial' ? [ref('payee')] : [], impact: cls === 'major_change' ? 'major' : 'reversible',
      transaction: cls === 'financial' ? { payee: ref('payee'), account: ref('account'), currency: 'USD', minorUnit: 2, amountMinor: '100', quoteId: 'q', quoteVersion: '1', quoteExpiresAt: 90000 } : null };
    const p = f.prepare(actor!); expect(p.decision.state).toBe('hold'); expect(f.calls).toBe(0);
  });
});
