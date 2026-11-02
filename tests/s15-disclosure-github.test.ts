import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDisclosureService } from '../src/s15/disclosure';
import { githubFixture, head, repo } from './fixtures/s15-github';
import { actionRef, ref } from './fixtures/s15-policy';

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
function setup(decorate = true) {
  const dir = mkdtempSync(join(tmpdir(), 'jit-private-github-'));
  const source = { ref: ref('private_source'), resource: repo.resource, classification: 'business' as const, active: true, ownerReleasable: true };
  // GitHub's protected provider and the repository audience are separate recipient scopes.
  const provider = ref('payee'), audience = ref('other');
  const disclosure = openDisclosureService({ runtime: 's15', path: join(dir, 'lineage.sqlite'), create: true, installationId: 'private_github', now: () => 1000,
    catalogs: { source: r => r.id === source.ref.id ? source : null, recipient: r => [provider, audience].some(p => p.id === r.id) ? { ref: r, active: true } : null,
      approvals: () => [{ recipient: provider, purpose: ref('purpose'), resources: [repo.resource], dataClasses: ['business'], sources: [source.ref], expiresAt: 90000 }] },
    routes: [{ id: 'github', kind: 'adapter', resolve(_work, payload) {
      const p = payload as { contract: string; repository: string; target: string };
      return p.contract === 's15-github-effect/v1' && p.repository === repo.name && p.target === repo.target ? [provider, audience] : null;
    } }],
  });
  const g = githubFixture('personal', { catalogs: base => disclosure.catalogs(base), recipients: [provider, audience], ...(decorate ? { adapter: adapter => disclosure.protectAdapter(adapter, 'github') } : {}) });
  cleanups.push(() => { g.cleanup(); disclosure.close(); rmSync(dir, { recursive: true, force: true }); });
  disclosure.attach(g.f.service); g.f.add('lineage', source.ref);
  return { g, disclosure, source, audience };
}

test('personal GitHub publication still holds a new recipient of private business lineage', async () => {
  const { g, disclosure, source, audience } = setup(), actor = g.work.actor!;
  const selected = await g.selected(); await g.service.implement(actor, selected.id); disclosure.read(actor, source.ref);
  const prepared = await g.service.prepare(actor, selected.id, { kind: 'push', branch: selected.branch, previous: null });
  expect(prepared.decision.state).toBe('hold'); expect(g.protocol.calls).toHaveLength(0);
  const slip = g.f.service.owner.actionSlip(g.f.owner, actionRef(prepared.action));
  expect(slip.action.classes).toEqual(expect.arrayContaining(['github_publish', 'communication', 'disclosure', 'new_egress']));
  expect(slip.action.disclosure?.recipients).toContainEqual(audience); expect(slip.action.github?.head).toBe(head);
  g.f.service.owner.decide(g.f.owner, { requestId: 'approve_private_push', action: actionRef(prepared.action), decision: 'approve', expiresAt: prepared.action.expiresAt });
  expect((await g.service.dispatch(actor, actionRef(prepared.action))).outcome).toBe('succeeded');
  expect(g.protocol.calls).toHaveLength(1); expect(g.protocol.branches.get(selected.branch)).toBe(prepared.action.github?.head);
});

test('private GitHub publication refuses omitted disclosure composition despite an empty recipient list', async () => {
  const { g, disclosure, source } = setup(false), actor = g.work.actor!;
  const selected = await g.selected(); await g.service.implement(actor, selected.id); disclosure.read(actor, source.ref);
  await expect(g.service.prepare(actor, selected.id, { kind: 'push', branch: selected.branch, previous: null })).rejects.toThrow('outside_scope');
  expect(g.protocol.calls).toHaveLength(0);
});
