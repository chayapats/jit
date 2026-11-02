import type { ActionRef, AdapterResult, BudgetVector, Fence, Ref, WorkAuthority } from "../policy";

/** Protected configured repository identity. Neither owner text nor a checkout chooses a credential or endpoint. */
export interface GithubRepository { resource: Ref; name: string; target: string }
/** An actual read with immutable source identity and observation time, not a model citation. */
export interface GithubSource { ref: string; observedAt: number }
/** Owning GitHub reader captures all fields, including comments and actual prerequisite contract evidence. */
export interface GithubIssue {
  number: number; title: string; body: string; comments: string[]; version: string; state: "open" | "closed";
  scope: string | null; criteria: { id: string; text: string }[];
  blockers: { issue: number; satisfied: boolean; contract: string | null; evidence: GithubSource[] }[];
  assignees: string[]; branches: string[]; pulls: number[]; source: GithubSource;
}
/** Readiness includes every checked reason; no preference/ranking or implementation side effect exists. */
export interface GithubReadiness {
  issue: number; title: string; state: "ready" | "blocked" | "owned" | "has_pr";
  reasons: { code: string; passed: boolean; evidence: GithubSource[] }[];
  issueVersion: string; base: string; source: GithubSource;
}
/** Complete branch-protection read. Unknown/incomplete protection never supplies automatic merge authority. */
export interface GithubProtection { version: string; known: boolean; strict: boolean; enforcesReviews: boolean; requiredChecks: string[]; requiredApprovals: number; requireCodeOwners: boolean; source: GithubSource }
/** Protected adapter binds production consequences and deployment enforcement, independent of repository text. */
export interface GithubProduction { consequence: "none" | "protected_gate" | "would_deploy" | "unknown"; fence: Fence | null; evidence: GithubSource[] }
/** Exact current check result. Duplicate, flaky, missing or stale checks cannot pass. */
export interface GithubCheck { name: string; head: string; base: string; state: "pending" | "success" | "failure" | "flaky"; source: GithubSource }
/** Required review facts come from the protected reader; review text remains untrusted remediation input. */
export interface GithubReview { id: string; author: string; head: string; base: string; state: "approved" | "changes_requested" | "commented"; resolved: boolean; codeOwner: boolean; body: string; source: GithubSource }
/** A full bounded read; version identifies captured facts, not a claim that GitHub offers a full-vector CAS. */
export interface GithubSnapshot {
  repository: string; target: string; base: string; version: string; issues: GithubIssue[];
  protection: GithubProtection; production: GithubProduction; source: GithubSource;
  pull: null | { number: number; issue: number; branch: string; head: string; base: string; state: "open" | "merged" | "closed"; draft: boolean; mergeable: boolean; checks: GithubCheck[]; reviews: GithubReview[]; codeOwnerReviewSatisfied?: boolean };
}
/** Immutable VM workspace result captured by trusted host code after actual commands, never from model done text. */
export interface GithubCodingEvidence {
  head: string; base: string; diffHash: string; bundle: Ref;
  tests: { command: string; exitCode: number; outputHash: string }[];
  criteria: { id: string; passed: boolean; evidence: GithubSource[] }[];
  source: GithubSource;
  settlement: { transportSettled: boolean; executionSettled: boolean };
}
/** One owner-selected issue and one deduplicated local work intent. Changing the issue/base requires a new selection. */
export interface GithubSelection {
  id: string; requestId: string; workId: string; repository: GithubRepository; issue: number; issueVersion: string;
  base: string; branch: string; createdAt: number; state: "selected" | "implementing" | "reviewable" | "reconcile_only";
  evidence: GithubCodingEvidence | null;
}
/** Closed technical operations; each push/PR/reply/merge is an independently claimed exact action. */
export type GithubOperation =
  | { kind: "push"; branch: string; previous: string | null }
  | { kind: "pr_create"; title: string; body: string }
  | { kind: "pr_update"; pull: number; title: string; body: string }
  | { kind: "review_reply"; pull: number; thread: string; body: string }
  | { kind: "merge"; pull: number };
/** Final credential-free wire request binds captured facts and exact content; actual server preconditions are operation-specific. */
export interface GithubEffect {
  contract: "s15-github-effect/v1"; key: string; repository: string; target: string; issue: number;
  head: string; base: string; branch: string; evidenceHash: string; snapshotVersion: string; operation: GithubOperation;
  bundle: Ref; diffHash: string;
  mergeRequirements: null | { requiredChecks: string[]; requiredApprovals: number; requireCodeOwners: boolean };
}
/** Remote truth is independently read back; unknown is reconcile-only and never retryable. */
export interface GithubEffectResult { key: string; effectHash: string; outcome: "succeeded" | "rejected" | "unknown"; receipt: string | null }
/**
 * Protected gateway only: keeps repository credentials outside VM/model/native state. mutate must
 * serialize Jit's own operations per PR/repository, revalidate the captured snapshot, and for merge
 * reread strict server-enforced checks/reviews and send exact sha to GitHub's merge endpoint. GitHub
 * owns atomic head/freshness/check/review enforcement; this is not an invented full-vector API CAS.
 */
export interface ProtectedGithubGateway {
  snapshot(repository: GithubRepository, pull: number | null, selectedIssue?: number): Promise<GithubSnapshot>;
  mutate(effect: GithubEffect, dispatch: (send: () => Promise<GithubEffectResult>) => Promise<AdapterResult>): Promise<AdapterResult>;
  reconcile(effect: GithubEffect): Promise<GithubEffectResult>;
}
/** One isolated VM attempt; closing is mandatory before CI/review wait. No protected-host execution fallback. */
export interface GithubWorkspace {
  implement(input: { selection: GithubSelection; issue: GithubIssue; authority: WorkAuthority; findings: readonly GithubReview[]; signal?: AbortSignal; guard(): void }): Promise<GithubCodingEvidence>;
}
/** Durable PR responsibility is independent of transient VM/native sessions. */
export interface GithubBabysitting {
  id: string; responsibilityId: string; selectionId: string; pull: number; state: "active" | "waiting_ci" | "waiting_review" | "waiting_owner" | "remediating" | "stalled" | "reconcile_only" | "merged" | "stopped";
  cursor: string | null; nextAt: number; lastProgressAt: number; attempts: number; noProgress: number;
  lastEvidenceHash: string | null; action: ActionRef | null; reasons: string[];
  report: null | { attempts: number; evidenceRefs: string[]; recommendation: string };
  attemptEventId: string | null;
}
/** Host-selected finite limits/costs, never inferred from a missing budget. */
export interface GithubLimits { snapshotMaxAgeMs: number; waitMs: number; stallMs: number; maxNoProgress: number; maxAttempts: number; readUpperBound: BudgetVector; actionUpperBound: BudgetVector }
/** Owner-facing JSON capture; installation remains an explicit POLICY owner command. */
export interface GithubPersonalCapture {
  contract: "s15-github-personal-capture/v1"; captureId: string; expectedPolicyRevision: number; repositories: { repository: GithubRepository; protection: GithubProtection; production: GithubProduction; autoMergeAvailable: boolean; reason: string | null }[];
  selectedIssueRequired: true; publication: "off" | "personal"; merge: "off" | "personal";
  ruleIds: string[]; revoke: { expectedPolicyRevision: number; ruleIds: string[] };
}
