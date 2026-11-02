import type { ActionAdapter, AdapterResult, BudgetVector, GithubConditions, JsonValue, PreparedAction, S15PolicyService, WorkAuthority } from "../policy";
import type { GithubCodingEvidence, GithubEffect, GithubEffectResult, GithubLimits, GithubSelection, GithubSnapshot, ProtectedGithubGateway } from "./types";
import { GithubStore } from "./store";
import { canonical, digest, exact, fail, identity, snapshot } from "./validation";
import { githubEligibility, githubProtectionMatches } from "./readiness";

/** Protected immutable preparation, addressed by an opaque service-owned ID rather than a model payload. */
export interface GithubActionRecord { id: string; selection: GithubSelection; snapshot: GithubSnapshot; evidence: GithubCodingEvidence; effect: GithubEffect }
const unknownUsage = { attempts: null, steps: null, calls: null, reads: null, outputBytes: null, activeMs: null, spendMinor: null };
function result(value: GithubEffectResult, effect: GithubEffect): AdapterResult {
  const valid = value?.key === effect.key && value.effectHash === digest(canonical(effect)) && ["succeeded", "rejected", "unknown"].includes(value.outcome) && (value.outcome !== "succeeded" || typeof value.receipt === "string" && !!value.receipt);
  return { outcome: !valid || value.outcome === "unknown" ? "unknown" : value.outcome === "succeeded" ? "succeeded" : "failed", actual: { ...unknownUsage }, transportSettled: valid };
}
function bound(record: GithubActionRecord, work: WorkAuthority): void {
  const s = record.selection;
  if (work.request.intent !== "execute" || work.request.access !== "effect" || work.id !== s.workId || work.request.subject?.issue !== s.issue || canonical(work.request.subject.resource) !== canonical(s.repository.resource)) fail("github_selection_required");
  if (!s.evidence || canonical(s.evidence) !== canonical(record.evidence)) fail("github_evidence_changed");
}
/**
 * Trusted POLICY adapter. Only service-owned immutable evidence enters preparation. Original POLICY
 * dispatch claims/charges before one conditional gateway mutation; no shell, hooks, guest Git config,
 * account token or generic API capability enters the working VM. Unknown sends only reconcile.
 */
export function createGithubActionAdapter(input: {
  store: GithubStore; gateway: ProtectedGithubGateway; limits: GithubLimits; now(): number; policy(): S15PolicyService;
}): ActionAdapter {
  const load = (payload: JsonValue): GithubActionRecord => {
    const effect = payload as unknown as GithubEffect;
    const r = input.store.get<GithubActionRecord>("action", effect.key);
    if (!r || canonical(r.effect) !== canonical(payload)) fail("github_action_changed"); return r;
  };
  return {
    id: "s15_github", version: 1,
    prepare(proposal, { work, now }) {
      exact(proposal, ["id"]); identity(proposal.id);
      const r = input.store.get<GithubActionRecord>("action", proposal.id); if (!r) fail("github_action_not_found");
      bound(r, work); snapshot(r.snapshot, r.selection.repository, now, input.limits.snapshotMaxAgeMs);
      const merge = r.effect.operation.kind === "merge", eligible = githubEligibility(r.snapshot, { head: r.evidence.head, acceptance: r.evidence.criteria.every(c => c.passed), evidence: r.evidence.tests.every(t => t.exitCode === 0) });
      const rules = input.policy().control.policyForWork(work.id).rules.filter(rule => rule.mode === "personal_github_merge" && rule.github?.target === r.effect.target && canonical(rule.github.repository) === canonical(r.selection.repository.resource));
      const protectedMerge = githubProtectionMatches(r.snapshot.protection, rules.length === 1 ? rules[0]!.github! : rules.length === 0 ? r.snapshot.protection : null);
      const production = r.snapshot.production;
      const github: GithubConditions = { repository: r.selection.repository.resource, issue: r.selection.issue, target: r.selection.repository.target, head: r.evidence.head, evidenceHash: r.effect.evidenceHash,
        checksPassed: merge ? eligible.checksPassed && protectedMerge : r.evidence.tests.every(t => t.exitCode === 0), reviewsPassed: merge ? eligible.reviewsPassed : true,
        acceptancePassed: r.evidence.criteria.every(c => c.passed), production: production.consequence, deploymentFence: production.fence };
      // Mergeability/head are hard adapter constraints; approval cannot turn an ineligible head into a merge.
      if (merge && (!r.snapshot.pull || r.snapshot.pull.head !== r.evidence.head || r.snapshot.pull.base !== r.evidence.base || r.snapshot.pull.state !== "open" || r.snapshot.pull.draft || !r.snapshot.pull.mergeable)) fail("github_head_changed");
      return { operation: r.effect.operation.kind, classes: merge ? ["github_merge", ...(production.consequence === "would_deploy" ? ["production" as const] : [])] : ["github_publish", "communication"],
        resources: [r.selection.repository.resource], recipients: [], payload: JSON.parse(canonical(r.effect)) as JsonValue,
        fences: [{ kind: "lineage", ref: r.evidence.bundle }, ...(production.fence ? [production.fence] : [])],
        upperBound: structuredClone(input.limits.actionUpperBound) as BudgetVector, expiresAt: Math.min(work.expiresAt, now + input.limits.snapshotMaxAgeMs), transaction: null, github, impact: "reversible" };
    },
    async perform(action: PreparedAction, context) {
      const r = load(action.payload), latest = await input.gateway.snapshot(r.selection.repository, "pull" in r.effect.operation ? r.effect.operation.pull : null, r.effect.issue);
      snapshot(latest, r.selection.repository, input.now(), input.limits.snapshotMaxAgeMs);
      if (latest.version !== r.effect.snapshotVersion || latest.base !== r.effect.base) fail("github_remote_changed");
      // commit rechecks current owner/rule/lineage/gate generations synchronously immediately before send.
      return input.gateway.mutate(structuredClone(r.effect), send => {
        input.store.dispatchGuards.get(r.effect.key)?.();
        return context.commit(action.payload, async () => {
        const observed = await send();
        const actual = result(observed, r.effect);
        input.store.tx(() => input.store.put("remote_result", r.id, { outcome: actual.outcome, receipt: actual.outcome === "succeeded" ? observed.receipt : null }));
        return actual;
        });
      });
    },
    async reconcile(action) { const r = load(action.payload); return result(await input.gateway.reconcile(structuredClone(r.effect)), r.effect); },
  };
}
