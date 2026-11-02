import type { GithubProtection, GithubReadiness, GithubSnapshot } from "./types";

/** Owner-captured requirements must be enforced by GitHub, including strict base freshness and review enforcement. */
export function githubProtectionMatches(protection: GithubProtection, required: { requiredChecks?: string[]; requiredApprovals?: number; requireCodeOwners?: boolean } | null): boolean {
  return !!required && !!required.requiredChecks?.length && required.requiredApprovals !== undefined && required.requireCodeOwners !== undefined && protection.known && protection.strict && protection.enforcesReviews && required.requiredChecks.every(name => protection.requiredChecks.includes(name)) && protection.requiredApprovals >= required.requiredApprovals && (!required.requireCodeOwners || protection.requireCodeOwners);
}

/** Pure checked report. A closed blocker without actual contract evidence remains blocked. Discovery starts nothing. */
export function githubReadiness(snapshot: GithubSnapshot): GithubReadiness[] {
  return snapshot.issues.map((issue): GithubReadiness => {
    const source = [issue.source], reasons: GithubReadiness["reasons"] = [
      { code: "issue_open", passed: issue.state === "open", evidence: source },
      { code: "scope_defined", passed: !!issue.scope, evidence: source },
      { code: "acceptance_defined", passed: issue.criteria.length > 0, evidence: source },
      { code: "ownership_clear", passed: issue.assignees.length === 0, evidence: source },
      { code: "branch_clear", passed: issue.branches.length === 0, evidence: source },
      { code: "pull_clear", passed: issue.pulls.length === 0, evidence: source },
      ...issue.blockers.map(b => ({ code: `prerequisite_${b.issue}`, passed: b.satisfied && !!b.contract && b.evidence.length > 0, evidence: b.evidence.length ? b.evidence : source })),
    ];
    return { issue: issue.number, title: issue.title, state: issue.pulls.length ? "has_pr" : issue.assignees.length || issue.branches.length ? "owned" : reasons.every(r => r.passed) ? "ready" : "blocked", reasons, issueVersion: issue.version, base: snapshot.base, source: issue.source };
  }).sort((a, b) => a.issue - b.issue);
}

/** Exact-head eligibility from actual branch protection, checks, reviews, mergeability and captured coding evidence. */
export function githubEligibility(snapshot: GithubSnapshot, input: { head: string; acceptance: boolean; evidence: boolean }): {
  eligible: boolean; checksPassed: boolean; reviewsPassed: boolean; reasons: string[];
  rows: { code: string; passed: boolean; evidence: string[] }[];
} {
  const p = snapshot.pull, protection = snapshot.protection;
  const current = !!p && p.head === input.head && p.base === snapshot.base;
  const checks = p?.checks ?? [], reviews = p?.reviews ?? [];
  // Without a named list require every reported check, and at least one check. Unknown protection holds.
  const required = protection.requiredChecks.length ? protection.requiredChecks : checks.map(c => c.name);
  const checksPassed = protection.known && required.length > 0 && new Set(checks.map(c => c.name)).size === checks.length && required.every(name => checks.some(c => c.name === name && c.head === input.head && c.base === snapshot.base && c.state === "success")) && checks.every(c => c.head === input.head && c.base === snapshot.base && c.state === "success");
  const latest = new Map<string, typeof reviews[number]>(); for (const r of reviews) latest.set(r.author, r);
  const approvals = [...latest.values()].filter(r => r.state === "approved" && r.head === input.head && r.base === snapshot.base);
  const reviewsPassed = protection.known && [...latest.values()].every(r => r.resolved || r.state !== "changes_requested") && approvals.length >= protection.requiredApprovals && (!protection.requireCodeOwners || approvals.some(r => r.codeOwner));
  const production = snapshot.production.consequence === "none" || snapshot.production.consequence === "protected_gate" && !!snapshot.production.fence;
  const rows = [
    { code: "github_head_current", passed: current, evidence: [snapshot.source.ref] },
    { code: "github_mergeable", passed: !!p && p.state === "open" && !p.draft && p.mergeable, evidence: [snapshot.source.ref] },
    { code: "github_acceptance", passed: input.acceptance && input.evidence, evidence: [] as string[] },
    { code: "github_required_checks", passed: checksPassed, evidence: checks.map(c => c.source.ref) },
    { code: "github_required_reviews", passed: reviewsPassed, evidence: reviews.map(r => r.source.ref) },
    { code: "github_production", passed: production, evidence: snapshot.production.evidence.map(s => s.ref) },
  ];
  return { eligible: rows.every(r => r.passed), checksPassed, reviewsPassed, reasons: rows.filter(r => !r.passed).map(r => r.code), rows };
}
