import { afterEach, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openModelService } from '../src/s15/model';
import { openWorkService } from '../src/s15/work';
import { modelWorkFixture, observed } from './fixtures/s15-model-work';

const cleanups: (() => void)[] = []; afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
async function killed(mode: 'active' | 'wait' | 'model') {
  const root = mkdtempSync(join(tmpdir(), 'jit-s15-kill-')); cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const child = Bun.spawn([process.execPath, join(import.meta.dir, 'fixtures/s15-model-work-worker.ts'), mode, root], { stdout: 'pipe', stderr: 'pipe' });
  try {
    const reader = child.stdout.getReader(), first = await reader.read();
    if (first.done) throw Error('fixture_did_not_reach_claim: ' + await new Response(child.stderr).text());
    const data = JSON.parse(new TextDecoder().decode(first.value).trim()) as { responsibilityId: string; workId: string }; reader.releaseLock();
    child.kill('SIGKILL'); await child.exited;
    const f = modelWorkFixture({ root, create: false }); cleanups.push(() => f.cleanup(false));
    return { f, ...data };
  } finally { if (child.exitCode === null) { child.kill('SIGKILL'); await child.exited; } }
}

test('SIGKILL during a claimed model call preserves charge and unknown transport without inference replay', async () => {
  const { f, workId } = await killed('model'); let calls = 0;
  const service = openModelService({ ...f.modelOptions(), scripted: route => ({ provider: 'codex-subscription', id: route.modelId, async *stream() { calls++; yield { type: 'message_complete', message: { type: 'assistant', id: 'forbidden', content: [] } }; } }) }); cleanups.push(() => service.close());
  const view = service.project(f.owner, workId); expect(view.selections[0]!).toMatchObject({ state: 'reconcile_only', code: 'context_lost' });
  expect(view.unsettled).toBe(1); expect(view.ceilings.find(row => row.dimension === 'spendMinor')).toMatchObject({ measured: null, unknown: true });
  await expect(service.runStep(f.policy.control.bindWork(workId), { stepId: 'step', difficulty: 'ordinary', text: 'Selected issue only.', ownerDecisions: [], sources: [] })).rejects.toThrow('reconciliation_required');
  await expect(service.runStep(f.policy.control.bindWork(workId), { stepId: 'replacement', difficulty: 'ordinary', text: 'Selected issue only.', ownerDecisions: [], sources: [] })).rejects.toThrow('reconciliation_required');
  expect(service.reconcile(f.owner, view.selections[0]!.id).state).toBe('reconcile_only');
  expect(calls).toBe(0); expect(f.policy.control.usage().charged.calls).toBe(1);
});

test('SIGKILL during work retains responsibility/capacity and permits only read-only exact-attempt reconciliation', async () => {
  const { f, responsibilityId } = await killed('active'); const service = openWorkService(f.workOptions()); cleanups.push(() => service.close());
  const view = service.project(f.owner, responsibilityId); expect(view).toMatchObject({ state: 'reconcile_only', resumedAfterRestart: true }); expect(view.stopImpact.heldAttempts).toHaveLength(1);
  expect(() => service.beginAttempt(responsibilityId, { eventId: 'source', approach: 'retry' })).toThrow('attempt_not_ready');
  expect(service.reconcile(responsibilityId, view.attempts[0]!.id, observed({ progress: 'made' })).state).toBe('ready');
  expect(service.project(f.owner, responsibilityId).attempts).toHaveLength(1);
});

test('SIGKILL while waiting for CI preserves wait with no active session and one deduplicated wake', async () => {
  const { f, responsibilityId } = await killed('wait'); const service = openWorkService(f.workOptions()); cleanups.push(() => service.close());
  expect(service.project(f.owner, responsibilityId)).toMatchObject({ state: 'waiting', wait: { key: 'head_1' }, stopImpact: { heldAttempts: [] } });
  const event = { eventId: 'ci_finished', kind: 'ci' as const, key: 'head_1', purposeId: 'purpose', resourceIds: ['repo'], subject: 'issue:42', evidenceRefs: ['check_evidence'] };
  service.observeEvent(responsibilityId, event); service.observeEvent(responsibilityId, event);
  service.beginAttempt(responsibilityId, { eventId: 'ci_finished', approach: 'Check completion evidence' });
  expect(service.project(f.owner, responsibilityId).attempts).toHaveLength(2); expect(f.policy.control.usage().charged.calls).toBe(0);
});

test('exclusive process lease prevents a second runtime from declaring live attempts lost', () => {
  const f = modelWorkFixture(); cleanups.push(() => f.cleanup()); const service = openWorkService(f.workOptions()); cleanups.push(() => service.close());
  expect(() => openWorkService({ ...f.workOptions(), create: false })).toThrow('runtime_already_open');
});
