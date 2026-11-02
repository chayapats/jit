import { AppError } from "../../errors";
import { canonical, digest, exact, identity, integer } from "../../s14/validation";
import { content } from "../conversation/validation";
import type { GithubCodingEvidence, GithubOperation, GithubRepository, GithubSnapshot } from "./types";

export { canonical, digest, exact, identity, integer, content };
export function fail(code: string): never { throw new AppError(code, 409); }
/** Unix millisecond observations are nonnegative safe integers, independent of finite counter ceilings. */
export function timestamp(value: unknown): asserts value is number { integer(value, 0, Number.MAX_SAFE_INTEGER); }
/** Strict full SHA-1 commit identity; expressions, options and abbreviated OIDs refuse. */
export function oid(value: unknown): asserts value is string { if (typeof value !== "string" || !/^[a-f0-9]{40}$/.test(value)) fail("github_commit_invalid"); }
/** Exact safe branch, never a ref expression or shell fragment. */
export function branch(value: unknown): asserts value is string {
  if (typeof value !== "string" || value.length > 120 || !/^[A-Za-z0-9][A-Za-z0-9_./-]*$/.test(value) || value.includes("..") || value.includes("//") || value.endsWith("/") || value.split("/").some(x => x.startsWith(".") || x.endsWith(".") || x.endsWith(".lock"))) fail("github_ref_invalid");
}
/** Configured canonical repository/target; no URLs, credentials, alternate hosts or remote names. */
export function repository(value: GithubRepository): void {
  exact(value, ["resource", "name", "target"]); exact(value.resource, ["id", "revision", "generation"]);
  identity(value.resource.id); integer(value.resource.revision, 1); integer(value.resource.generation, 1); branch(value.target);
  if (!/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/.test(value.name) || value.name.endsWith(".git")) fail("github_repository_invalid");
}
/** Reject malformed/incomplete gateway data before deriving readiness or merge evidence. */
export function snapshot(value: GithubSnapshot, repo: GithubRepository, now: number, maxAge: number): void {
  canonical(value); repository(repo);
  if (value.repository !== repo.name || value.target !== repo.target) fail("github_destination_changed");
  oid(value.base); content(value.version, 256);
  const source = (s: { ref: string; observedAt: number }) => { content(s.ref, 2048); timestamp(s.observedAt); if (s.observedAt > now || now - s.observedAt > maxAge) fail("github_snapshot_stale"); };
  source(value.source); source(value.protection.source); content(value.protection.version, 256);
  integer(value.protection.requiredApprovals, 0);
  if ([value.protection.known, value.protection.strict, value.protection.enforcesReviews, value.protection.requireCodeOwners].some(x => typeof x !== "boolean")) fail("github_protocol_invalid");
  const names = value.protection.requiredChecks; if (new Set(names).size !== names.length) fail("github_protocol_invalid"); for (const name of names) content(name, 256);
  if (!["none", "protected_gate", "would_deploy", "unknown"].includes(value.production.consequence)) fail("github_protocol_invalid");
  if (value.production.consequence === "protected_gate" && (!value.production.fence || value.production.fence.kind !== "resource" || !value.production.evidence.length)) fail("github_deployment_gate_unproven");
  for (const s of value.production.evidence) source(s);
  const issues = new Set<number>();
  for (const issue of value.issues) {
    integer(issue.number, 1); if (issues.has(issue.number)) fail("github_protocol_invalid"); issues.add(issue.number);
    content(issue.title, 512); if (issue.body) content(issue.body, 32000); issue.comments.forEach(x => content(x, 16000)); content(issue.version, 256); source(issue.source);
    if (!["open", "closed"].includes(issue.state)) fail("github_protocol_invalid");
    if (issue.scope !== null) content(issue.scope, 8000);
    if (new Set(issue.criteria.map(x => x.id)).size !== issue.criteria.length) fail("github_protocol_invalid");
    issue.criteria.forEach(x => { identity(x.id); content(x.text, 4000); });
    issue.blockers.forEach(x => { integer(x.issue, 1); if (typeof x.satisfied !== "boolean") fail("github_protocol_invalid"); x.evidence.forEach(source); });
    issue.assignees.forEach(x => content(x, 256)); issue.branches.forEach(branch); issue.pulls.forEach(x => integer(x, 1));
  }
  const p = value.pull;
  if (p) { integer(p.number, 1); integer(p.issue, 1); branch(p.branch); oid(p.head); oid(p.base); if (p.state === "open" && p.base !== value.base || !["open", "merged", "closed"].includes(p.state) || typeof p.mergeable !== "boolean" || typeof p.draft !== "boolean") fail("github_protocol_invalid");
    for (const c of p.checks) { content(c.name, 256); oid(c.head); oid(c.base); source(c.source); if (!["pending", "success", "failure", "flaky"].includes(c.state)) fail("github_protocol_invalid"); }
    for (const r of p.reviews) { identity(r.id); content(r.author, 256); oid(r.head); oid(r.base); source(r.source); if (r.body) content(r.body, 16000); if (!["approved", "changes_requested", "commented"].includes(r.state) || typeof r.resolved !== "boolean" || typeof r.codeOwner !== "boolean") fail("github_protocol_invalid"); }
  }
}
/** Actual command results and complete criterion evidence are required for an immutable export. */
export function codingEvidence(value: GithubCodingEvidence, criteria: string[], base: string): void {
  canonical(value); exact(value, ["head", "base", "diffHash", "bundle", "tests", "criteria", "source", "settlement"]); oid(value.head); oid(value.base);
  if (!value.settlement.transportSettled || !value.settlement.executionSettled) fail("github_execution_unsettled");
  if (value.base !== base || !/^[a-f0-9]{64}$/.test(value.diffHash)) fail("github_evidence_changed");
  exact(value.bundle, ["id", "revision", "generation"]); identity(value.bundle.id); integer(value.bundle.revision, 1); integer(value.bundle.generation, 1);
  if (!value.tests.length || new Set(value.criteria.map(x => x.id)).size !== value.criteria.length || canonical([...criteria].sort()) !== canonical(value.criteria.map(x => x.id).sort())) fail("github_evidence_required");
  content(value.source.ref, 2048); timestamp(value.source.observedAt);
  for (const t of value.tests) { content(t.command, 4096); integer(t.exitCode, 0); if (!/^[a-f0-9]{64}$/.test(t.outputHash)) fail("github_evidence_required"); }
  for (const c of value.criteria) { if (typeof c.passed !== "boolean" || !c.evidence.length) fail("github_evidence_required"); c.evidence.forEach(s => { content(s.ref, 2048); timestamp(s.observedAt); }); }
}
/** Closed operation validation refuses arbitrary API, metadata fields and hidden delivery destinations. */
export function operation(value: GithubOperation): void {
  if (value.kind === "push") { exact(value, ["kind", "branch", "previous"]); branch(value.branch); if (value.previous !== null) oid(value.previous); }
  else if (value.kind === "pr_create" || value.kind === "pr_update") { exact(value, value.kind === "pr_create" ? ["kind", "title", "body"] : ["kind", "pull", "title", "body"]); content(value.title, 200); content(value.body, 12000); if (value.kind === "pr_update") integer(value.pull, 1); }
  else if (value.kind === "review_reply") { exact(value, ["kind", "pull", "thread", "body"]); integer(value.pull, 1); identity(value.thread); content(value.body, 12000); }
  else if (value.kind === "merge") { exact(value, ["kind", "pull"]); integer(value.pull, 1); }
  else fail("github_operation_unsupported");
}
