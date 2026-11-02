import type { ActionRef, OwnerActor, PreparedResult, ReadHandler, Rule, S15PolicyService, WorkActor, WorkAuthority } from "../policy";
import { PolicyError } from "../policy";
import { AppError } from "../../errors";
import { GithubStore } from "./store";
import type { GithubActionRecord } from "./adapter";
import type { GithubBabysitting, GithubCodingEvidence, GithubEffect, GithubLimits, GithubOperation, GithubPersonalCapture, GithubReadiness, GithubRepository, GithubResponsibilities, GithubSelection, GithubSnapshot, GithubWorkspace, ProtectedGithubGateway } from "./types";
import { branch, canonical, codingEvidence, content, digest, exact, fail, identity, integer, operation, repository, snapshot } from "./validation";
import { githubEligibility, githubProtectionMatches, githubReadiness } from "./readiness";

const unknownUsage = () => ({ attempts: null, steps: null, calls: null, reads: null, outputBytes: null, activeMs: null, spendMinor: null });
const safeCode = (e: unknown): string => e instanceof AppError || e instanceof PolicyError ? e.code : "github_operation_uncertain";
const actionRef = (p: PreparedResult): ActionRef => ({ id: p.action.id, revision: p.action.revision, actionHash: p.action.actionHash });
type Report = { id: string; repository: GithubRepository; snapshot: GithubSnapshot; rows: GithubReadiness[] };
type ActionFamily = { id: string; selectionId: string; key: string; slot: string; attempt: number; action: ActionRef };

/** Register with POLICY at protected composition. Only the fixed configured repository read is supported. */
export function githubReadHandler(repositories: readonly GithubRepository[]): ReadHandler {
  const allowed = structuredClone(repositories);
  return { operation: "read", validate(payload, context) {
    exact(payload, ["kind", "repository", "pull", "selectedIssue"]);
    if (payload.kind !== "github_snapshot" || typeof payload.repository !== "string" || !allowed.some(r => r.name === payload.repository && canonical(r.resource) === canonical(context.resource))) fail("github_repository_denied");
    if (payload.pull !== null) integer(payload.pull, 1);
    if (payload.selectedIssue !== null) integer(payload.selectedIssue, 1);
  } };
}

/**
 * Opt-in GitHub host service. All callable actors stay in protected composition. Discovery commits
 * JSON rows only; selection consumes CHAT's exact execute/subject authority. No S14 command/default,
 * credential setup, branch protection or production environment is changed by construction.
 */
export class GithubService<Attempt = object> {
  private readonly repos: readonly GithubRepository[];
  private readonly now: () => number;
  private readonly active = new Set<string>();
  constructor(private readonly options: {
    runtime: "s15"; store: GithubStore; policy: S15PolicyService; repositories: readonly GithubRepository[];
    gateway: ProtectedGithubGateway; workspace: GithubWorkspace; responsibilities: GithubResponsibilities<Attempt>;
    limits: GithubLimits; now?: () => number;
  }) {
    if (options.runtime !== "s15") fail("s15_opt_in_required");
    this.repos = structuredClone(options.repositories); this.repos.forEach(repository); this.now = options.now ?? Date.now;
    for (const [key, value] of Object.entries(options.limits)) if (key !== "readUpperBound" && key !== "actionUpperBound") integer(value, 1);
    if (options.limits.maxNoProgress < 2 || options.limits.maxNoProgress > options.limits.maxAttempts || options.limits.maxAttempts > 64) fail("github_limits_invalid");
  }
  private repo(id: string): GithubRepository { const r = this.repos.find(r => r.resource.id === id); if (!r) fail("github_repository_denied"); return structuredClone(r); }
  private guard(actor: WorkActor, repo: GithubRepository, execute = false): WorkAuthority {
    const w = this.options.policy.work.guard(actor);
    if (!w.request.resources.some(r => canonical(r) === canonical(repo.resource))) fail("outside_scope");
    if (execute && (w.request.intent !== "execute" || !["reversible_write", "effect"].includes(w.request.access ?? ""))) fail("github_selection_required"); return w;
  }
  private selected(actor: WorkActor, id: string): GithubSelection {
    identity(id); const s = this.options.store.get<GithubSelection>("selection", id); if (!s) fail("github_selection_required");
    const w = this.guard(actor, s.repository, true);
    if (w.id !== s.workId || w.request.subject?.issue !== s.issue || canonical(w.request.subject.resource) !== canonical(s.repository.resource)) fail("github_selection_required"); return s;
  }
  private recordedAction(ref: ActionRef): GithubActionRecord | null {
    const family = this.options.store.all<ActionFamily>("action_family").find(f => canonical(f.action) === canonical(ref));
    return family ? this.options.store.get<GithubActionRecord>("action", family.key) : null;
  }
  private reusableMerge(actor: WorkActor, row: GithubBabysitting, selection: GithubSelection, remote: GithubSnapshot): PreparedResult | null {
    if (!row.action || !selection.evidence) return null;
    const record = this.recordedAction(row.action), effect = record?.effect;
    if (!record || !effect || effect.operation.kind !== "merge" || effect.operation.pull !== row.pull || effect.head !== selection.evidence.head || effect.base !== selection.evidence.base || effect.evidenceHash !== digest(canonical(selection.evidence)) || effect.snapshotVersion !== remote.version) return null;
    // Fresh observation times do not change the captured action, but actual check/review/target facts do.
    const facts = (value: GithubSnapshot) => canonical(JSON.parse(JSON.stringify(value, (key, v) => key === "observedAt" ? 0 : v)));
    if (facts(record.snapshot) !== facts(remote)) return null;
    const decision = this.options.policy.work.evaluate(actor, row.action); if (decision.state !== "allow") return null;
    return { action: this.options.policy.work.guardBeforeDispatch(actor, row.action), decision };
  }
  private settleObserved(row: GithubBabysitting, work: WorkAuthority, remote: GithubSnapshot, complete: boolean): GithubBabysitting["state"] {
    const kind = row.state === "waiting_review" ? "review" : row.state === "waiting_ci" ? "ci" : row.state === "waiting_owner" ? "owner" : "schedule";
    const eventId = `verified_${digest(canonical({ id: row.id, action: row.action, version: remote.version, complete }))}`;
    const ready = this.options.responsibilities.observeEvent(row.responsibilityId, { eventId, kind, key: `pr_${digest(`${remote.repository}#${row.pull}`)}`, purposeId: work.request.purpose.id, resourceIds: work.request.resources.map(r => r.id), subject: `issue:${remote.pull!.issue}`, evidenceRefs: [remote.source.ref] });
    if (ready.state !== "ready" || !ready.readyEventId) fail("github_responsibility_not_ready");
    const handle = this.options.responsibilities.beginAttempt(row.responsibilityId, { eventId: ready.readyEventId, approach: complete ? "github_observed_merge" : "github_observed_publication" });
    row.attemptEventId = ready.readyEventId; this.options.store.tx(() => this.options.store.put("babysit", row.id, row));
    const settled = this.options.responsibilities.settle(handle, { basis: "remote_verified", transportSettled: true, executionSettled: true, effects: "known", progress: "made", evidenceRefs: [remote.source.ref], recommendation: complete ? "The selected PR is verified merged; no further execution is needed." : "Continue from the verified published head and current checks/reviews.", usage: unknownUsage(), complete });
    if (complete && settled.state !== "completed") fail("github_completion_unsettled");
    this.options.responsibilities.publish(handle, () => {
      row.state = complete ? "merged" : settled.state === "paused" ? "stalled" : "active";
      row.action = null; row.reasons = complete ? ["github_remote_merge_verified"] : [];
      this.options.store.tx(() => this.options.store.put("babysit", row.id, row));
    });
    return row.state;
  }
  private async read(actor: WorkActor, repo: GithubRepository, pull: number | null, selectedIssue?: number): Promise<GithubSnapshot> {
    this.guard(actor, repo);
    const p = this.options.policy, admitted = p.work.reserveRead(actor, { requestId: `gr_${crypto.randomUUID().replaceAll("-", "")}`, resource: repo.resource, operation: "read", exactPayload: { kind: "github_snapshot", repository: repo.name, pull, selectedIssue: selectedIssue ?? null }, upperBound: this.options.limits.readUpperBound, fences: [] });
    if (admitted.state !== "allow") fail(admitted.code);
    let returned = false;
    try {
      p.work.guardRead(actor, admitted.claim.id);
      const value = await this.options.gateway.snapshot(repo, pull, selectedIssue); returned = true;
      snapshot(value, repo, this.now(), this.options.limits.snapshotMaxAgeMs);
      if (pull !== null && value.pull?.number !== pull) fail("github_pull_changed");
      this.guard(actor, repo);
      p.control.settleRead(admitted.claim.id, { outcome: "succeeded", basis: "remote_verified", code: null, actual: unknownUsage(), transportSettled: true }, digest(canonical(value)));
      p.control.publishRead(actor, admitted.claim.id); return structuredClone(value);
    } catch (e) {
      p.control.settleRead(admitted.claim.id, { outcome: returned ? "failed" : "unknown", basis: returned ? "remote_verified" : "uncertain", code: "github_read_unavailable", actual: unknownUsage(), transportSettled: returned }, null); throw e;
    }
  }
  /** Inspect-only readiness. No selection, claim, implementation, assignment or GitHub mutation occurs. */
  async discover(actor: WorkActor, repositoryId: string): Promise<{ id: string; rows: GithubReadiness[]; waitingForSelection: true }> {
    const repo = this.repo(repositoryId), s = await this.read(actor, repo, null), id = `report_${digest(canonical(s))}`;
    const report: Report = { id, repository: repo, snapshot: s, rows: githubReadiness(s) };
    this.options.store.tx(() => this.options.store.put("report", id, report)); return { id, rows: report.rows, waitingForSelection: true };
  }
  /** One authenticated CHAT select-and-start authority; dedupe survives restart and a changed choice conflicts. */
  async select(actor: WorkActor, input: { requestId: string; reportId: string; issue: number; base: string; issueVersion: string }): Promise<GithubSelection> {
    exact(input, ["requestId", "reportId", "issue", "base", "issueVersion"]); identity(input.requestId); identity(input.reportId); integer(input.issue, 1);
    const report = this.options.store.get<Report>("report", input.reportId); if (!report) fail("github_readiness_required");
    const w = this.guard(actor, report.repository, true), hash = digest(canonical({ input, workId: w.id })), key = `select_${input.requestId}`;
    if (w.request.subject?.issue !== input.issue || canonical(w.request.subject.resource) !== canonical(report.repository.resource)) fail("github_selection_required");
    const old = this.options.store.receipt<GithubSelection>(key, hash); if (old) return this.selected(actor, old.id);
    const latest = await this.read(actor, report.repository, null), row = githubReadiness(latest).find(r => r.issue === input.issue), before = report.rows.find(r => r.issue === input.issue);
    if (!row || !before || row.state !== "ready" || before.state !== "ready") fail("github_issue_not_ready");
    if (latest.base !== input.base || report.snapshot.base !== input.base || row.issueVersion !== input.issueVersion || before.issueVersion !== input.issueVersion) fail("github_selection_changed");
    return this.options.store.tx(() => {
      this.guard(actor, report.repository, true); const previous = this.options.store.receipt<GithubSelection>(key, hash); if (previous) return this.selected(actor, previous.id);
      const existing = this.options.store.all<GithubSelection>("selection").find(s => s.repository.name === report.repository.name && s.issue === input.issue);
      if (existing) { if (existing.workId !== w.id) fail("github_issue_already_selected"); this.options.store.commitReceipt(key, hash, existing); return existing; }
      const id = `selected_${digest(canonical({ workId: w.id, issue: input.issue }))}`, selected: GithubSelection = { id, requestId: input.requestId, workId: w.id, repository: report.repository, issue: input.issue, issueVersion: input.issueVersion, base: input.base, branch: `jit/issue-${input.issue}-${id.slice(-12)}`, createdAt: this.now(), state: "selected", evidence: null };
      this.options.store.put("selection", id, selected); this.options.store.put("issue", id, latest.issues.find(i => i.number === input.issue)); this.options.store.commitReceipt(key, hash, selected); return selected;
    });
  }
  /** One actual isolated workspace run, with immutable observed diff/tests. Interrupted claims never rerun automatically. */
  async implement(actor: WorkActor, selectionId: string, findings: readonly import("./types").GithubReview[] = [], attempt?: Attempt): Promise<GithubSelection> {
    let s = this.selected(actor, selectionId); if (s.state === "reviewable" && !findings.length) return s;
    if (!["selected", "reviewable"].includes(s.state) || this.active.has(selectionId)) fail("github_reconciliation_required");
    this.active.add(selectionId);
    try {
      const current = await this.read(actor, s.repository, null), issue = current.issues.find(i => i.number === s.issue);
      if (current.base !== s.base || issue?.version !== s.issueVersion) fail("github_selection_changed");
      s.state = "implementing"; this.options.store.tx(() => this.options.store.put("selection", s.id, s));
      const evidence = await this.options.workspace.implement({ selection: structuredClone(s), issue: structuredClone(issue), authority: this.guard(actor, s.repository, true), findings: structuredClone(findings), ...(attempt === undefined ? {} : { signal: this.options.responsibilities.signal(attempt) }), guard: () => { this.guard(actor, s.repository, true); if (attempt !== undefined) this.options.responsibilities.guard(attempt); } });
      this.guard(actor, s.repository, true); codingEvidence(evidence, issue.criteria.map(c => c.id), s.base);
      s = { ...s, state: "reviewable", evidence: structuredClone(evidence) }; this.options.store.tx(() => this.options.store.put("selection", s.id, s)); return structuredClone(s);
    } catch (e) { if (s.state === "implementing") { s.state = "reconcile_only"; this.options.store.tx(() => this.options.store.put("selection", s.id, s)); } throw e; }
    finally { this.active.delete(selectionId); }
  }
  /** Prepare exactly one logical technical effect; caller's retry IDs never create a second effect slot. */
  async prepare(actor: WorkActor, selectionId: string, op: GithubOperation): Promise<PreparedResult> {
    operation(op); const s = this.selected(actor, selectionId), e = s.evidence; if (s.state !== "reviewable" || !e) fail("github_evidence_required");
    if (this.guard(actor, s.repository, true).request.access !== "effect") fail("github_publication_scope_required");
    const remote = await this.read(actor, s.repository, "pull" in op ? op.pull : null, s.issue), issue = remote.issues.find(i => i.number === s.issue);
    if (remote.base !== e.base || issue?.version !== s.issueVersion) fail("github_selection_changed");
    if ("pull" in op && (remote.pull?.issue !== s.issue || remote.pull.branch !== s.branch || remote.pull.head !== e.head)) fail("github_pull_changed");
    if (op.kind === "push" && (op.branch !== s.branch || op.branch === s.repository.target)) fail("github_ref_denied");
    if (op.kind === "pr_create" && (remote.pull || issue.pulls.length)) fail("github_pull_already_exists");
    if (op.kind === "review_reply" && !remote.pull?.reviews.some(r => r.id === op.thread)) fail("github_review_thread_changed");
    const familyId = `effect_${digest(canonical({ selection: s.id, head: e.head, kind: op.kind, target: "pull" in op ? op.pull : op.kind === "push" ? op.branch : "new_pr", thread: op.kind === "review_reply" ? op.thread : null }))}`;
    const previous = this.options.store.get<ActionFamily>("action_family", familyId);
    let attempt = previous?.attempt ?? 0;
    for (const family of this.options.store.all<ActionFamily>("action_family").filter(f => f.selectionId === s.id)) {
      let outcome: string | null = null;
      try { outcome = this.options.policy.control.publishable(actor, family.action).outcome; } catch (error) { if (safeCode(error) !== "observation_required") throw error; }
      if (outcome === "unknown") fail("github_reconciliation_required");
      if (family.id === familyId && outcome) {
        if (outcome === "succeeded") fail("already_claimed");
        const old = this.options.store.get<GithubActionRecord>("action", family.key)!;
        if (old.effect.snapshotVersion === remote.version) fail("github_remote_reevaluation_required");
        attempt++;
      }
    }
    const slot = `${familyId}_${attempt}`, key = `action_${digest(canonical({ familyId, attempt, snapshot: remote.version }))}`;
    const mergeRules = this.options.policy.control.policyForWork(s.workId).rules.filter(r => r.mode === "personal_github_merge" && r.github?.target === s.repository.target && canonical(r.github.repository) === canonical(s.repository.resource));
    const requirement = mergeRules.length === 1 ? mergeRules[0]!.github! : remote.protection;
    const effect: GithubEffect = { contract: "s15-github-effect/v1", key, repository: s.repository.name, target: s.repository.target, issue: s.issue, head: e.head, base: e.base, branch: s.branch, evidenceHash: digest(canonical(e)), snapshotVersion: remote.version, operation: structuredClone(op), bundle: e.bundle, diffHash: e.diffHash,
      mergeRequirements: op.kind === "merge" && requirement.requiredChecks && requirement.requiredApprovals !== undefined && requirement.requireCodeOwners !== undefined ? { requiredChecks: requirement.requiredChecks, requiredApprovals: requirement.requiredApprovals, requireCodeOwners: requirement.requireCodeOwners } : null };
    const old = this.options.store.get<GithubActionRecord>("action", key);
    if (old && canonical(old.effect) !== canonical(effect)) fail("github_action_changed");
    if (!old) this.options.store.tx(() => this.options.store.put("action", key, { id: key, selection: s, snapshot: remote, evidence: e, effect } satisfies GithubActionRecord));
    const prepared = this.options.policy.work.prepare(actor, { slot, adapter: "s15_github", proposal: { id: key } });
    this.options.store.tx(() => this.options.store.put("action_family", familyId, { id: familyId, selectionId: s.id, key, slot, attempt, action: actionRef(prepared) } satisfies ActionFamily));
    return prepared;
  }
  /** Exact policy dispatch. The owner decision and original claim are enforced by POLICY, not this service. */
  async dispatch(actor: WorkActor, action: ActionRef, attempt?: Attempt) {
    const ref = { id: action.id, revision: action.revision, actionHash: action.actionHash };
    const prepared = this.options.policy.work.guardBeforeDispatch(actor, ref), key = (prepared.payload as unknown as GithubEffect).key;
    if (attempt !== undefined) { this.options.responsibilities.guard(attempt); this.options.store.dispatchGuards.set(key, () => this.options.responsibilities.guard(attempt)); }
    try { return await this.options.policy.work.dispatch(actor, ref); } finally { if (attempt !== undefined) this.options.store.dispatchGuards.delete(key); }
  }
  /** Owner JSON capture reads protection/production from the protected gateway; no personal rule is installed implicitly. */
  async personalCapture(owner: OwnerActor, actor: WorkActor): Promise<GithubPersonalCapture> {
    const p = this.options.policy.owner.current(owner); if (!p) fail("policy_match_required");
    const entries: GithubPersonalCapture["repositories"] = [];
    for (const repo of this.repos) { const s = await this.read(actor, repo, null), available = githubProtectionMatches(s.protection, s.protection); entries.push({ repository: repo, protection: s.protection, production: s.production, autoMergeAvailable: available, reason: available ? null : "github_protection_required" }); }
    const rules = p.rules.filter(r => r.mode === "personal_github_publish" || r.mode === "personal_github_merge");
    const capture: GithubPersonalCapture = { contract: "s15-github-personal-capture/v1", captureId: `capture_${digest(canonical({ entries, policy: p.revision }))}`, expectedPolicyRevision: p.revision, repositories: entries, selectedIssueRequired: true, publication: rules.some(r => r.mode === "personal_github_publish") ? "personal" : "off", merge: rules.some(r => r.mode === "personal_github_merge") ? "personal" : "off", ruleIds: rules.map(r => r.id), revoke: { expectedPolicyRevision: p.revision, ruleIds: rules.map(r => r.id) } };
    this.options.policy.owner.current(owner); this.options.store.tx(() => this.options.store.put("capture", capture.captureId, capture)); return capture;
  }
  /** Explicit owner opt-in installs only captured repositories/targets/checks/reviews. Initial/default setup never calls this. */
  async installPersonal(owner: OwnerActor, actor: WorkActor, input: { requestId: string; captureId: string; repositoryIds: string[]; publication: boolean; merge: boolean }): Promise<{ revision: number; ruleIds: string[] }> {
    exact(input, ["requestId", "captureId", "repositoryIds", "publication", "merge"]); identity(input.requestId); identity(input.captureId);
    if (typeof input.publication !== "boolean" || typeof input.merge !== "boolean" || !input.repositoryIds.length || new Set(input.repositoryIds).size !== input.repositoryIds.length || !input.publication && !input.merge) fail("github_profile_invalid");
    const captured = this.options.store.get<GithubPersonalCapture>("capture", input.captureId); if (!captured) fail("github_capture_required");
    const p = this.options.policy.owner.current(owner); if (!p || p.revision !== captured.expectedPolicyRevision) fail("github_rule_changed");
    const added: Rule[] = [];
    for (const id of input.repositoryIds) {
      const entry = captured.repositories.find(e => e.repository.resource.id === id); if (!entry || !p.resources.some(r => canonical(r) === canonical(entry.repository.resource))) fail("outside_scope");
      const current = await this.read(actor, entry.repository, null);
      if (current.protection.version !== entry.protection.version) fail("github_protection_changed");
      if (input.merge && !githubProtectionMatches(current.protection, entry.protection)) fail("github_protection_required");
      for (const mode of ["personal_github_publish", "personal_github_merge"] as const) {
        if (mode === "personal_github_publish" ? !input.publication : !input.merge) continue;
        const merge = mode === "personal_github_merge";
        added.push({ id: `github_${merge ? "merge" : "publish"}_${digest(entry.repository.name).slice(0, 16)}`, mode, purposes: p.purposes, bots: p.bots, resources: [entry.repository.resource], recipients: [], selections: p.selections, adapters: ["s15_github"], operations: merge ? ["merge"] : ["push", "pr_create", "pr_update", "review_reply"], classes: merge ? ["github_merge"] : ["github_publish", "communication"], expiresAt: p.expiresAt, recurrence: null,
          github: { repository: entry.repository.resource, target: entry.repository.target, ...(merge ? { requiredChecks: entry.protection.requiredChecks, requiredApprovals: entry.protection.requiredApprovals, requireCodeOwners: entry.protection.requireCodeOwners } : {}) } });
      }
    }
    const { contract: _c, revision: _r, ownerGeneration: _g, ...policy } = p;
    const installed = this.options.policy.owner.install(owner, input.requestId, p.revision, { ...policy, rules: [...p.rules.filter(r => !added.some(a => a.id === r.id)), ...added] });
    return { revision: installed.revision, ruleIds: added.map(r => r.id) };
  }
  /** Authenticated revocation changes POLICY immediately; it cannot undo previously completed publications. */
  revokePersonal(owner: OwnerActor, input: { requestId: string; expectedPolicyRevision: number; ruleIds: string[] }): void {
    const p = this.options.policy.owner.current(owner); if (!p) fail("policy_match_required");
    if (input.ruleIds.some(id => !p.rules.some(r => r.id === id && r.mode.startsWith("personal_github")))) fail("github_rule_changed");
    const { contract: _contract, revision: _revision, ownerGeneration: _generation, ...policy } = p;
    this.options.policy.owner.install(owner, input.requestId, input.expectedPolicyRevision, { ...policy, rules: policy.rules.filter(r => !input.ruleIds.includes(r.id)) });
  }
  /** Selected PR only, explicitly assigned from the original authenticated CHAT request via WORK15. */
  async babysit(owner: OwnerActor, actor: WorkActor, input: { requestId: string; sourceRequestId: string; selectionId: string; pull: number; reserveCalls: number }): Promise<GithubBabysitting> {
    identity(input.requestId); integer(input.pull, 1); integer(input.reserveCalls, 1);
    const s = this.selected(actor, input.selectionId), remote = await this.read(actor, s.repository, input.pull, s.issue);
    if (remote.pull?.issue !== s.issue || remote.pull.branch !== s.branch) fail("github_pull_changed");
    let assigned: ReturnType<GithubResponsibilities<Attempt>["assign"]>;
    try { assigned = this.options.responsibilities.assign(owner, { requestId: input.requestId, sourceRequestId: input.sourceRequestId, completion: `Review and safely settle ${s.repository.name}#${input.pull} for issue #${s.issue}`, triggers: ["ci", "review", "schedule", "owner"], stallPolicy: { noProgressApproaches: this.options.limits.maxNoProgress, reserveCalls: input.reserveCalls, maxAttempts: this.options.limits.maxAttempts } }); }
    catch (error) { if (error instanceof Error && "code" in error && error.code === "source_reconciliation_required") fail("source_reconciliation_required"); throw error; }
    if (assigned.workId !== s.workId) fail("github_responsibility_changed");
    const id = `babysit_${digest(canonical({ selectionId: s.id, pull: input.pull }))}`;
    const old = this.options.store.get<GithubBabysitting>("babysit", id); if (old) return old;
    const row: GithubBabysitting = { id, responsibilityId: assigned.id, selectionId: s.id, pull: input.pull, state: "active", cursor: null, nextAt: this.now(), lastProgressAt: this.now(), attempts: 0, noProgress: 0, lastEvidenceHash: null, action: null, reasons: [], report: null, attemptEventId: null };
    this.options.store.tx(() => this.options.store.put("babysit", id, row)); return row;
  }
  /** One durable wake, no polling loop. Pending CI/review closes all VM work before recording the WORK wait. */
  async tick(id: string): Promise<GithubBabysitting> {
    identity(id); const row = this.options.store.get<GithubBabysitting>("babysit", id); if (!row) fail("not_found");
    if (["stalled", "reconcile_only", "merged", "stopped"].includes(row.state) || row.nextAt > this.now()) return row;
    if (this.active.has(id)) fail("github_tick_busy"); this.active.add(id);
    const save = () => { this.options.store.tx(() => this.options.store.put("babysit", row.id, row)); return structuredClone(row); };
    try {
      const selection = this.options.store.get<GithubSelection>("selection", row.selectionId)!;
      const actor = this.options.policy.control.bindWork(selection.workId), s = this.selected(actor, selection.id), e = s.evidence; if (!e) fail("github_evidence_required");
      const remote = await this.read(actor, s.repository, row.pull, s.issue), p = remote.pull!;
      if (p.issue !== s.issue || p.branch !== s.branch) fail("github_pull_changed");
      if (p.state === "merged") {
        if (p.head !== e.head) fail("github_head_changed");
        this.settleObserved(row, this.guard(actor, s.repository, true), remote, true); return save();
      }
      if (p.state !== "open") { row.state = "stopped"; row.reasons = ["github_pull_closed"]; return save(); }
      if (row.state === "waiting_owner" && row.action) {
        const pending = this.recordedAction(row.action);
        if (pending?.effect.operation.kind === "push") {
          let outcome: ReturnType<S15PolicyService["control"]["publishable"]> | null = null;
          try { outcome = this.options.policy.control.publishable(actor, row.action); } catch (error) { if (safeCode(error) !== "observation_required") throw error; }
          if (outcome?.outcome === "unknown") { row.state = "reconcile_only"; row.reasons = ["github_publication_uncertain"]; return save(); }
          if (outcome?.outcome === "succeeded" && outcome.basis === "remote_verified" && outcome.transportSettled) {
            if (this.settleObserved(row, this.guard(actor, s.repository, true), remote, false) === "stalled") return save();
          }
        }
      }
      if (p.head !== e.head || remote.issues.find(i => i.number === s.issue)?.version !== s.issueVersion) {
        row.state = "waiting_owner"; row.reasons = ["github_head_or_scope_changed"]; row.nextAt = this.now() + this.options.limits.waitMs;
        this.options.responsibilities.wait(row.responsibilityId, { requestId: `scope_${digest(remote.version)}`, kind: "owner", key: `pr_${digest(`${s.repository.name}#${row.pull}`)}`, evidenceRefs: [remote.source.ref] }); return save();
      }
      if (row.state === "waiting_owner" && (!row.action || this.options.policy.work.evaluate(actor, row.action).state !== "allow")) { row.nextAt = this.now() + this.options.limits.waitMs; return save(); }
      const scheduled = row.cursor === remote.version;
      const kind = row.state === "waiting_review" ? "review" : row.state === "waiting_ci" ? "ci" : row.state === "waiting_owner" ? "owner" : scheduled ? "schedule" : "ci";
      const eventId = `ge_${digest(canonical({ id, kind, version: remote.version, approach: scheduled ? row.attempts : null }))}`, w = this.guard(actor, s.repository, true);
      const observed = this.options.responsibilities.observeEvent(row.responsibilityId, { eventId, kind, key: `pr_${digest(`${s.repository.name}#${row.pull}`)}`, purposeId: w.request.purpose.id, resourceIds: w.request.resources.map(r => r.id), subject: `issue:${s.issue}`, evidenceRefs: [remote.source.ref] });
      row.cursor = remote.version;
      if (["paused", "stopping", "stopped", "reconcile_only"].includes(observed.state)) { row.state = observed.state === "reconcile_only" ? "reconcile_only" : "stalled"; row.reasons = ["github_responsibility_paused"]; return save(); }
      const mergeRule = this.options.policy.control.policyForWork(s.workId).rules.find(r => r.mode === "personal_github_merge" && r.github?.target === s.repository.target && canonical(r.github.repository) === canonical(s.repository.resource));
      const eligibility = githubEligibility(remote, { head: e.head, acceptance: e.criteria.every(c => c.passed), evidence: e.tests.every(t => t.exitCode === 0), ...(mergeRule?.github ? { requirements: mergeRule.github } : {}) });
      row.reasons = eligibility.reasons;
      const failed = p.checks.some(c => c.head === e.head && c.base === e.base && ["failure", "flaky"].includes(c.state));
      const findings = p.reviews.filter(r => r.head === e.head && r.base === e.base && r.state === "changes_requested" && !r.resolved);
      const baseAdvanced = p.base !== e.base;
      if (failed || findings.length || baseAdvanced) {
        if (row.attempts >= this.options.limits.maxAttempts || row.noProgress >= this.options.limits.maxNoProgress || this.now() - row.lastProgressAt >= this.options.limits.stallMs) {
          row.state = "stalled"; row.reasons = ["github_no_progress", ...eligibility.reasons]; row.report = { attempts: row.attempts, evidenceRefs: [remote.source.ref, e.source.ref], recommendation: "Inspect the retained failed approaches and select a revised scoped approach before resuming this responsibility." };
          this.options.responsibilities.wait(row.responsibilityId, { requestId: `stall_${row.attempts}`, kind: "owner", key: `pr_${digest(`${s.repository.name}#${row.pull}`)}`, evidenceRefs: row.report.evidenceRefs }); return save();
        }
        if (!observed.readyEventId) { row.state = "waiting_ci"; row.nextAt = this.now() + this.options.limits.waitMs; return save(); }
        const handle = this.options.responsibilities.beginAttempt(row.responsibilityId, { eventId: observed.readyEventId, approach: `github_remediation_${row.attempts + 1}` });
        row.attemptEventId = observed.readyEventId; row.action = null; row.state = "remediating"; row.attempts++; save();
        let captured: GithubCodingEvidence | null = null, uncertainEffect = false, attemptSettled = false;
        try {
          if (baseAdvanced) { this.options.responsibilities.guard(handle); s.base = remote.base; this.options.store.tx(() => this.options.store.put("selection", s.id, s)); }
          const technicalFindings = [...findings, ...(baseAdvanced || !findings.length ? [{ id: baseAdvanced ? "base_advanced" : "ci_failure", author: "github", head: e.head, base: remote.base, state: "changes_requested" as const, resolved: false, codeOwner: false, body: baseAdvanced ? "The approved target advanced. Rebase the selected issue changes onto the current target, preserve scope/checks, and rerun the configured evidence commands." : "Investigate the observed failing checks within the selected issue; preserve acceptance and required checks.", source: remote.source }] : [])];
          const fixed = await this.implement(actor, s.id, technicalFindings, handle);
          const hash = digest(canonical(fixed.evidence)), progress = fixed.evidence!.head !== e.head;
          captured = fixed.evidence;
          row.noProgress = progress ? 0 : row.noProgress + 1; if (progress) row.lastProgressAt = this.now(); row.lastEvidenceHash = hash;
          row.state = "active";
          // A separate exact push action is prepared. Default holds it; personal publication can dispatch.
          if (progress) {
            const prepared = await this.prepare(actor, s.id, { kind: "push", branch: s.branch, previous: e.head }); row.action = actionRef(prepared); save();
            if (prepared.decision.state !== "allow") { row.state = "waiting_owner"; row.reasons = [prepared.decision.code]; }
            else { uncertainEffect = true; const result = await this.dispatch(actor, row.action, handle); uncertainEffect = result.outcome === "unknown"; if (result.outcome !== "succeeded") { row.state = uncertainEffect ? "reconcile_only" : "waiting_owner"; row.reasons = [uncertainEffect ? "github_publication_uncertain" : "github_publication_refused"]; } }
          }
          const settled = this.options.responsibilities.settle(handle, { transportSettled: fixed.evidence!.settlement.transportSettled, executionSettled: fixed.evidence!.settlement.executionSettled, effects: row.state === "reconcile_only" ? "unknown" : "known", progress: progress ? "made" : "none", evidenceRefs: [fixed.evidence!.source.ref], recommendation: progress ? "Wait for the verified current-head checks and reviews." : "Inspect the retained failing evidence and choose another scoped technical approach.", usage: unknownUsage() });
          attemptSettled = true;
          if (settled.state === "paused") row.state = "stalled";
          if (row.state !== "reconcile_only") this.options.responsibilities.publish(handle, () => {});
          if (row.state === "active" || row.state === "waiting_owner") this.options.responsibilities.wait(row.responsibilityId, { requestId: `fix_wait_${row.attempts}`, kind: row.state === "waiting_owner" ? "owner" : progress ? "ci" : "schedule", key: `pr_${digest(`${s.repository.name}#${row.pull}`)}`, evidenceRefs: [fixed.evidence!.source.ref] });
        } catch (error) {
          if (!attemptSettled) this.options.responsibilities.settle(handle, { transportSettled: captured?.settlement.transportSettled === true && !uncertainEffect, executionSettled: captured?.settlement.executionSettled === true, effects: uncertainEffect || !captured ? "unknown" : "known", progress: "none", evidenceRefs: [remote.source.ref, ...(captured ? [captured.source.ref] : [])], recommendation: "Reconcile the original VM/effect attempt before retrying.", usage: unknownUsage() });
          row.state = "reconcile_only"; row.reasons = [safeCode(error)];
        }
        row.nextAt = this.now() + this.options.limits.waitMs; return save();
      }
      if (eligibility.rows.filter(r => r.code !== "github_production").every(r => r.passed)) {
        const prepared = this.reusableMerge(actor, row, s, remote) ?? await this.prepare(actor, s.id, { kind: "merge", pull: row.pull }); row.action = actionRef(prepared);
        if (prepared.decision.state === "allow") {
          if (!observed.readyEventId) fail("github_responsibility_not_ready");
          const handle = this.options.responsibilities.beginAttempt(row.responsibilityId, { eventId: observed.readyEventId, approach: "github_exact_head_merge" });
          row.attemptEventId = observed.readyEventId; row.state = "remediating"; save();
          let settled = false;
          try {
            const result = await this.dispatch(actor, row.action, handle);
            row.state = result.outcome === "succeeded" ? "merged" : result.outcome === "failed" || result.outcome === "not_dispatched" ? "waiting_ci" : "reconcile_only";
            row.reasons = result.outcome === "succeeded" ? [] : [row.state === "waiting_ci" ? "github_merge_refused_recheck" : "github_merge_uncertain"];
            this.options.responsibilities.settle(handle, { transportSettled: result.transportSettled, executionSettled: true, effects: result.outcome === "unknown" ? "unknown" : "known", progress: result.outcome === "succeeded" ? "made" : "none", evidenceRefs: [remote.source.ref], recommendation: row.state === "waiting_ci" ? "Re-evaluate GitHub's current protected branch requirements." : "Reconcile any uncertain merge before another attempt.", usage: result.actual, complete: result.outcome === "succeeded" }); settled = true;
            if (result.outcome !== "unknown") this.options.responsibilities.publish(handle, () => {});
          } finally { if (!settled) this.options.responsibilities.settle(handle, { transportSettled: false, executionSettled: true, effects: "unknown", progress: "none", evidenceRefs: [remote.source.ref], recommendation: "Reconcile the exact original merge.", usage: unknownUsage() }); }
        } else { row.state = "waiting_owner"; row.reasons = [prepared.decision.code]; }
      } else row.state = eligibility.reasons.includes("github_branch_protection") ? "waiting_owner" : !eligibility.checksPassed ? "waiting_ci" : "waiting_review";
      row.cursor = remote.version; row.nextAt = this.now() + this.options.limits.waitMs;
      if (row.state.startsWith("waiting_")) this.options.responsibilities.wait(row.responsibilityId, { requestId: `gw_${digest(canonical({ id, version: remote.version, state: row.state }))}`, kind: row.state === "waiting_owner" ? "owner" : row.state === "waiting_ci" ? "ci" : "review", key: `pr_${digest(`${s.repository.name}#${row.pull}`)}`, evidenceRefs: [remote.source.ref] });
      return save();
    } catch (e) {
      const paused = e instanceof Error && "code" in e && ["work_paused", "attempt_not_ready"].includes(String(e.code));
      row.state = paused ? "stalled" : "reconcile_only"; row.reasons = [paused ? "github_responsibility_paused" : safeCode(e)];
      if (paused) row.report = { attempts: row.attempts, evidenceRefs: [], recommendation: "Review the WORK stall report and remaining call headroom before resuming the original responsibility." }; return save();
    }
    finally { this.active.delete(id); }
  }
  /** Read-only exact unknown-action recovery. Lost VM execution still requires its owning VM proof; nothing is resent. */
  async reconcile(owner: OwnerActor, actor: WorkActor, id: string, requestId: string): Promise<GithubBabysitting> {
    identity(id); identity(requestId); const row = this.options.store.get<GithubBabysitting>("babysit", id); if (!row) fail("not_found");
    const s = this.selected(actor, row.selectionId);
    if (row.state !== "reconcile_only" || !row.action || !row.attemptEventId) fail("github_vm_reconciliation_required");
    const observed = await this.options.policy.owner.reconcile(owner, row.action, requestId);
    if (observed.outcome === "unknown" || observed.basis !== "remote_verified") return row;
    const projection = this.options.responsibilities.project(owner, row.responsibilityId) as { attempts?: { id: string; eventId: string }[] };
    const attempt = projection.attempts?.find(a => a.eventId === row.attemptEventId); if (!attempt) fail("github_attempt_reconciliation_required");
    const action = this.options.policy.owner.inspect(owner, row.action).action, merge = (action.payload as unknown as GithubEffect).operation.kind === "merge";
    const executionSettled = merge || s.evidence?.settlement.executionSettled === true;
    const fullySettled = executionSettled && observed.transportSettled;
    this.options.responsibilities.reconcile(row.responsibilityId, attempt.id, { transportSettled: observed.transportSettled, executionSettled, effects: "known", progress: observed.outcome === "succeeded" ? "made" : "none", evidenceRefs: [s.evidence?.source.ref ?? `github:${requestId}`], recommendation: fullySettled ? "Continue only from the reconciled current GitHub state." : "Obtain owning VM execution and transport settlement before continuing.", usage: observed.actual, complete: fullySettled && merge && observed.outcome === "succeeded", basis: observed.basis });
    row.state = !fullySettled ? "reconcile_only" : merge && observed.outcome === "succeeded" ? "merged" : "active"; row.nextAt = this.now(); row.reasons = fullySettled ? [] : ["github_vm_reconciliation_required"];
    this.options.store.tx(() => this.options.store.put("babysit", row.id, row)); return row;
  }
  /** Authenticated read-only JSON, including actual eligibility rows, personal-rule state and WORK projection. */
  async project(owner: OwnerActor, actor: WorkActor, id: string): Promise<unknown> {
    this.options.policy.owner.current(owner); const row = this.options.store.get<GithubBabysitting>("babysit", id); if (!row) fail("not_found");
    const s = this.selected(actor, row.selectionId), remote = await this.read(actor, s.repository, row.pull, s.issue);
    return { ...row, repository: s.repository, issue: s.issue, head: s.evidence?.head ?? null, eligibility: githubEligibility(remote, { head: s.evidence?.head ?? "", acceptance: s.evidence?.criteria.every(c => c.passed) ?? false, evidence: s.evidence?.tests.every(t => t.exitCode === 0) ?? false }), responsibility: this.options.responsibilities.project(owner, row.responsibilityId) };
  }
  /** Scoped authenticated stop delegates current authority fencing to WORK and preserves uncertain attempts. */
  stop(owner: OwnerActor, id: string, requestId: string): void {
    const row = this.options.store.get<GithubBabysitting>("babysit", id); if (!row) fail("not_found");
    this.options.responsibilities.stop(owner, row.responsibilityId, requestId); row.state = "stopped"; this.options.store.tx(() => this.options.store.put("babysit", id, row));
  }
}
