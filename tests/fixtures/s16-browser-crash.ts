import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { registerProtectedBrowser, type BrowserOperation } from '../../src/s15/browser';
import type { ActionRef } from '../../src/s15/policy';
import { unknownUsage } from '../../src/s15/policy/validation';
import { browserSitePolicy, loopbackFixtureEgress } from './s15-browser';
import { fixture, ref } from './s15-policy';

// Real disposable Chromium/controller process. The parent owns the service effect and kills this process
// after its request was actually received, while the response is withheld outside this process.
if (process.env.JIT_BROWSER_LIVE !== '1') throw Error('explicit_browser_evidence_required');
const input = JSON.parse(await Bun.stdin.text()) as { phase: 'dispatch' | 'recover'; directory: string; origin: string; readback: string };
const fresh = input.phase === 'dispatch', site = browserSitePolicy(input.origin);
const gateway = await registerProtectedBrowser({ runtime: 's15', mode: 'general', resource: ref('account'), fences: [],
  continuity: { path: join(input.directory, 'continuity.sqlite'), create: fresh }, profilePath: join(input.directory, 'profile'),
  executablePath: process.env.JIT_BROWSER_EXECUTABLE ?? '/usr/bin/chromium', site, egress: loopbackFixtureEgress, now: () => 1000,
  upperBound: { attempts: 0, steps: 1, calls: 0, reads: 1, outputBytes: 2097152, activeMs: 30000, spendMinor: '0' } });
const f = fixture({ create: fresh, path: join(input.directory, 'policy.sqlite'), adapters: [gateway.adapter], reads: [gateway.readHandler] });
gateway.attach(f.service);
const metadataPath = join(input.directory, 'action.json');
type Metadata = { action: ActionRef; workId: string; generation: number; temporaryDirectory: string };
const ensure = (condition: unknown, code: string) => { if (!condition) throw Error(code); };
try {
  if (fresh) {
    f.input.budget!.ceiling = { attempts: 1000, steps: 1000, calls: 1000, reads: 1000, outputBytes: 2_000_000_000, activeMs: 30_000_000, spendMinor: '100' };
    f.input.rules[0]!.adapters.push('protected_browser'); f.input.rules[0]!.operations.push('browser_request'); f.install();
    const admission = f.admit({ access: 'effect', readLimit: 1000 }), work = gateway.open(admission.actor!);
    ensure((await work.execute({ kind: 'navigate', url: input.origin + '/clean-task', generation: work.state().generation })).state === 'ok', 'navigation_failed');
    const page = await work.execute({ kind: 'read', generation: work.state().generation });
    if (page.state !== 'observed') throw Error('observation_failed');
    const target = page.observation.elements.find(e => e.name === 'confirm'); ensure(target, 'target_missing');
    const held = await work.execute({ kind: 'click', target: target!.id, generation: work.state().generation });
    if (held.state !== 'held') throw Error('effect_not_held');
    f.service.owner.decide(f.owner, { requestId: 'crash_exact_approval', action: held.action, decision: 'approve', expiresAt: 20000 });
    writeFileSync(metadataPath, JSON.stringify({ action: held.action, workId: admission.receipt.work!.id, generation: work.state().generation, temporaryDirectory: f.dir } satisfies Metadata), { mode: 0o600 });
    // The parent kills us here; a returned response would invalidate the dispatch-crash experiment.
    await work.resume(held.action); throw Error('response_was_not_withheld');
  }
  const saved = JSON.parse(readFileSync(metadataPath, 'utf8')) as Metadata, work = gateway.open(f.service.control.bindWork(saved.workId));
  const before = work.state(); ensure(JSON.stringify(before.reconciliation) === JSON.stringify(saved.action), 'lost_continuity');
  const resumeBefore = await work.resume(saved.action);
  const navigateBefore = await work.execute({ kind: 'navigate', url: input.origin + '/clean-task', generation: work.state().generation });
  const missing = await gateway.owner.reconcile(f.owner, saved.action, 'crash_missing_verifier');
  f.service.owner.recordStatement(f.owner, saved.action, 'crash_owner_statement', 'occurred');
  const statementUncleared = work.state().reconciliation !== null;
  site.reconcileEffect = async (request, context) => {
    ensure(request.url === input.origin + '/message' && request.method === 'POST', 'wrong_retained_request');
    const sha256 = createHash('sha256').update(Buffer.from(request.bodyBase64, 'base64')).digest('hex');
    context.beforeRead();
    const response = await fetch(input.readback + '/receipt?sha256=' + sha256, { redirect: 'error', signal: AbortSignal.timeout(5000) });
    const receipt = await response.json() as { sha256?: string; count?: number };
    return { outcome: response.ok && receipt.sha256 === sha256 && receipt.count === 1 ? 'succeeded' : 'unknown', actual: unknownUsage(), transportSettled: true };
  };
  const verified = await gateway.owner.reconcile(f.owner, saved.action, 'crash_service_readback'), after = work.state();
  const resumeAfter = await work.resume(saved.action);
  const freshNavigation = await work.execute({ kind: 'navigate', url: input.origin + '/clean-task', generation: work.state().generation } satisfies BrowserOperation);
  console.log(JSON.stringify({ recovered: before.reconciliation !== null, generationAdvanced: before.generation > saved.generation,
    resumeBefore: resumeBefore.state, navigateBefore: navigateBefore.state, missing: missing.outcome, statementUncleared,
    verified: verified.outcome, cleared: after.reconciliation === null, resumeAfter: resumeAfter.state, freshNavigation: freshNavigation.state }));
} finally { await gateway.close(); f.cleanup(); }
