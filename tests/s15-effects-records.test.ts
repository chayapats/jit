import { afterEach, describe, expect, test } from 'bun:test';
import { recordFixture, documentRecord, taskRecord, businessRecord } from './fixtures/s15-effect-browser';
import { ref } from './fixtures/s15-policy';
import type { BrowserOperation } from '../src/s15/browser';
import type { FixtureRecordEdit } from '../src/s15/effects';
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });
async function setup(mode: 'static' | 'general' = 'static', record = documentRecord()) { const f = await recordFixture(mode, record); cleanup.push(() => f.cleanup()); return f; }

describe.each(['static', 'general'] as const)('controlled records through protected browser %s', mode => {
  test.each(['document', 'task'] as const)('%s reversible edit executes without another approval and publishes actual observed content', async kind => {
    const f = await setup(mode, kind === 'task' ? taskRecord() : documentRecord()), changes = kind === 'task' ? { completed: true } : { body: 'Updated owner-requested document' };
    const result = await f.execute(f.server.request(f.record.id, f.edit(changes))); expect(result.state).toBe('ok'); expect(f.server.mutationCount).toBe(1);
    expect(f.server.record(f.record.id)).toMatchObject({ version: 2, fields: changes });
    const observed = await f.work.execute({ kind: 'read', generation: f.work.state().generation }); expect(observed.state).toBe('observed');
    if (observed.state === 'observed') expect(observed.observation.text).toContain(kind === 'task' ? 'true' : 'Updated owner-requested document');
    expect(f.server.record(f.record.id, 1).fields).toEqual(f.record.fields);
  });
  test.each(['notify', 'share', 'delete'] as const)('%s reaches the actual communication/disclosure/major gate before the fixture commit', async kind => {
    const f = await setup(mode), p = f.edit({ body: 'Changed' }, kind === 'notify' ? { notify: ['team'] } : kind === 'share' ? { share: ['new_recipient'] } : { delete: true });
    const held = await f.execute(f.server.request(f.record.id, p)); expect(held.state).toBe('held'); expect(f.server.mutationCount).toBe(0); if (held.state !== 'held') throw Error('expected_hold');
    const action = f.service.owner.inspect(f.owner, held.action).action; expect(action.classes).toContain(kind === 'notify' ? 'communication' : kind === 'share' ? 'disclosure' : 'major_change');
    f.approve(held.action); expect((await f.work.resume(held.action)).state).toBe('ok'); expect(f.server.mutationCount).toBe(1);
  });
  test('evidenced factual business edits follow current policy, including long notes without line-count heuristics', async () => {
    const f = await setup(mode, businessRecord()), note = 'Observed customer fact\n'.repeat(100);
    f.server.putEvidence({ id: 'source', revision: 1, recordId: 'business', field: 'note', value: note, status: 'fact', active: true });
    const p = f.edit({ note }, { evidence: [{ id: 'source', revision: 1 }] }); expect((await f.execute(f.server.request('business', p))).state).toBe('ok');
    expect(f.server.record('business').fields).toMatchObject({ note }); expect(f.server.mutationCount).toBe(1);
  });
  test.each(['priceMinor', 'discountBps', 'terms', 'policy', 'commitment', 'inference'] as const)('%s produces a DecisionCard with evidence/options/recommendation', async field => {
    const f = await setup(mode, businessRecord());
    if (field === 'inference') f.server.putEvidence({ id: 'inferred', revision: 1, recordId: 'business', field: 'note', value: 'Probably', status: 'inference', active: true });
    const changes = field === 'priceMinor' ? { priceMinor: '1' } : field === 'discountBps' ? { discountBps: 1 } : field === 'inference' ? { note: 'Probably' } : { [field]: 'New direction' };
    const p = f.edit(changes, field === 'inference' ? { evidence: [{ id: 'inferred', revision: 1 }] } : {}), held = await f.execute(f.server.request('business', p));
    expect(held.state).toBe('held'); expect(f.server.mutationCount).toBe(0); if (held.state !== 'held') throw Error('expected_hold');
    const card = f.server.decisionCard(f.owner, f.service, held.action)!; expect(card.contract).toBe('s15-effect-decision/v1'); expect(card.options.map(o => o.id)).toEqual(['apply_exact', 'investigate', 'keep']); expect(card.recommendation.authority).toBe('none');
    expect(card.impacts).toContain(field === 'inference' ? 'unverified_fact' : field === 'priceMinor' ? 'new_price' : field === 'discountBps' ? 'new_discount' : field === 'terms' ? 'new_terms' : field === 'policy' ? 'business_policy_change' : 'new_business_obligation');
    if (field === 'inference') expect(card.evidence[0]!.status).toBe('inference');
  });
});

test.each(['version', 'rule', 'evidence'] as const)('remote %s race after classification refuses CAS rather than silently overwriting', async race => {
  const f = await setup('static', businessRecord()), p = f.edit({ note: 'Evidenced note' }, { evidence: [{ id: 'source', revision: 1 }] });
  f.server.putEvidence({ id: 'source', revision: 1, recordId: 'business', field: 'note', value: 'Evidenced note', status: 'fact', active: true });
  f.server.beforeCommit = () => { if (race === 'version') f.server.change('business', { fields: { ...businessRecord().fields, note: 'Concurrent edit' } }); else if (race === 'rule') f.rule = { ...ref('business_rule'), revision: 2 }; else f.server.putEvidence({ id: 'source', revision: 2, recordId: 'business', field: 'note', value: 'Different fact', status: 'fact', active: false }); };
  const result = await f.execute(f.server.request('business', p)); expect(result.state).not.toBe('ok'); expect(f.server.mutationCount).toBe(0);
});

test('stale versions/rules, unknown fields and new unbound recipients fail before any remote mutation', async () => {
  const f = await setup(), p = f.edit({ body: 'Stale' }), request = f.server.request('document', p); f.server.change('document', { fields: { title: 'Plan', body: 'Concurrent' } });
  expect((await f.execute(request)).state).toBe('unsupported'); expect(f.server.mutationCount).toBe(0);
  await f.navigate(); const invalid = f.edit({ body: 'Anything', authority: 'model-approved' }, { version: 2 }); expect((await f.execute(f.server.request('document', invalid))).state).toBe('unsupported');
  const unbound = f.edit({ body: 'Anything' }, { version: 2, share: ['unknown_endpoint'] }); expect((await f.execute(f.server.request('document', unbound))).state).toBe('unsupported');
});

test.each(['notify', 'fulfillment', 'payment'] as const)('service-side hidden %s consequence cannot be disguised as a factual record edit', async trigger => {
  const r = businessRecord(); r.triggers = { notify: trigger === 'notify' ? ['team'] : [], fulfillment: trigger === 'fulfillment', payment: trigger === 'payment' };
  const f = await setup('general', r); f.server.putEvidence({ id: 'source', revision: 1, recordId: r.id, field: 'classification', value: 'customer', status: 'fact', active: true });
  const result = await f.execute(f.server.request(r.id, f.edit({ classification: 'customer' }, { evidence: [{ id: 'source', revision: 1 }] })));
  expect(result.state).toBe(trigger === 'payment' ? 'unsupported' : 'held'); expect(f.server.mutationCount).toBe(0);
});

test('lost save response reconciles from the operation journal without another POST', async () => {
  const f = await setup(), request = f.server.request('document', f.edit({ body: 'Saved once' })); f.server.loseNextResponse = true;
  expect((await f.execute(request)).state).toBe('unknown'); expect(f.server.mutationCount).toBe(1); const action = f.work.state().reconciliation!; expect(action).not.toBeNull();
  expect((await f.gateway.owner.reconcile(f.owner, action, 'reconcile_save')).outcome).toBe('succeeded'); expect(f.work.state().reconciliation).toBeNull();
  await f.navigate(); expect((await f.execute(request)).state).toBe('unsupported'); expect(f.server.mutationCount).toBe(1);
});

test('revoked browser work cannot use a held notification, shell, JS or MCP fallback to commit it', async () => {
  const f = await setup(), held = await f.execute(f.server.request('document', f.edit({ body: 'Changed' }, { notify: ['team'] }))); if (held.state !== 'held') throw Error('expected_hold');
  f.approve(held.action); f.service.owner.revoke(f.owner, 'stop', { kind: 'work', id: f.service.owner.inspect(f.owner, held.action).action.workId });
  await expect(f.work.resume(held.action)).rejects.toThrow('authority_revoked'); expect(f.server.mutationCount).toBe(0);
  for (const kind of ['shell', 'evaluate', 'mcp']) expect((await f.work.execute({ kind, command: 'send', generation: 1 } as unknown as BrowserOperation)).state).toBe('denied');
});

test('new-price direction is approved once for the same exact action; later changes require their own decision', async () => {
  const f = await setup('static', businessRecord()), held = await f.execute(f.server.request('business', f.edit({ priceMinor: '6000' }))); if (held.state !== 'held') throw Error('expected_hold');
  f.approve(held.action); expect((await f.work.resume(held.action)).state).toBe('ok'); expect(f.service.owner.actionSlip(f.owner, held.action).state).toBe('succeeded');
  await f.navigate(); const changed = await f.execute(f.server.request('business', f.edit({ priceMinor: '7000' }, { version: 2 }))); expect(changed.state).toBe('held'); expect(f.server.mutationCount).toBe(1);
});
