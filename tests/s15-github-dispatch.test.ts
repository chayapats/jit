import { afterEach, expect, test } from 'bun:test';
import type { ExecutionBackend } from 'schway/host';
import { createGithubVmWorkspace } from '../src/s15/github';
import { modelBound, modelWorkFixture } from './fixtures/s15-model-work';
import { ROUTE_MODEL, routeTransport } from './fixtures/s15-route-transport';

// MODEL15-02 (#372, B5): the GitHub VM coding runner authorizes and charges every physical send of its route
// model through Schway's `authorizeDispatch`. The fake VM stops the run right after the model finishes.
const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });

function workspace(transport: ReturnType<typeof routeTransport>, guardModel?: () => void) {
  const f = modelWorkFixture(); cleanups.push(() => f.cleanup());
  const source = f.source('source');
  const stopped = async (): Promise<never> => { throw new Error('fixture_after_model'); };
  const backend = { workspaceRoot: '/workspace', temporaryDirectory: '/tmp', realpath: stopped, stat: stopped, async *readFile() { throw new Error('fixture_after_model'); }, observeFile: stopped,
    writeFileAtomically: stopped, writePrivateFile: stopped, list: stopped, async *glob() { throw new Error('fixture_after_model'); }, search: stopped, spawn: stopped } as unknown as ExecutionBackend;
  const ws = createGithubVmWorkspace({ vm: { async openAttempt() { return { backend, definitions: [], evidence: () => [], async cancel() {}, async close() {} }; } }, vmId: 'vm', policy: f.policy,
    nativeDirectory: `${f.root}/native-github`, route: { provider: 'grok', model: ROUTE_MODEL.grok }, routeAuth: { store: transport.store, fetch: transport.fetch },
    modelCallUpperBound: modelBound(), maxTurns: 2, activeMs: 10000, maxBundleBytes: 1000, tests: [{ command: 'true', timeoutMs: 1000 }],
    async preload() { return '/workspace/coding/selection'; }, capture() { throw new Error('fixture_no_capture'); }, verifyCriteria() { return []; }, ...(guardModel ? { guardModel } : {}) });
  const run = () => ws.implement({ selection: { id: 'selection', repository: { name: 'repo' }, branch: 'jit/42', base: 'a'.repeat(40) } as never, issue: { number: 42, criteria: [] } as never,
    authority: source.authority!, findings: [], guard() { f.policy.work.guard(f.policy.control.bindWork(source.authority!.id)); } });
  return { f, source, run };
}

test('GitHub VM coding: the initial send and the Grok 401 auth-retry resend each take their own reservation', async () => {
  const t = routeTransport('grok', { responses: [401, 'ok'] }), w = workspace(t);
  await expect(w.run()).rejects.toThrow('fixture_after_model');
  expect(t.bodies).toHaveLength(2); expect(t.renewals).toHaveLength(1);
  expect(w.f.policy.control.reservations(w.source.authority!.id).map(r => r.transportSettled)).toEqual([true, true]);
});

test('GitHub VM coding: a refused auth-retry resend never leaves the process and is not retried', async () => {
  let checks = 0;
  // 1: stream pre-check, 2: initial send, 3: the auth-retry resend (refused).
  const t = routeTransport('grok', { responses: [401, 'ok', 'ok'] }), w = workspace(t, () => { if (++checks === 3) throw new Error('fixture_disclosure_refused'); });
  await expect(w.run()).rejects.toThrow('github_implementation_incomplete');
  expect(t.bodies).toHaveLength(1); expect(checks).toBe(3);
  expect(w.f.policy.control.reservations(w.source.authority!.id)).toHaveLength(1);
});
