import { afterEach, expect, test } from "bun:test";
import type { GithubOperation } from "../src/s15/github";
import { githubEligibility, githubReadiness } from "../src/s15/github";
import { base, coding, githubFixture, githubSnapshot, head, nextHead, type GithubFixture } from "./fixtures/s15-github";
import { actionRef, ref } from "./fixtures/s15-policy";
const approve = (f: GithubFixture, a: import("../src/s15/policy").PreparedAction) => f.f.service.owner.decide(f.f.owner, { requestId: `approve_${a.id}`, action: actionRef(a), decision: "approve", expiresAt: a.expiresAt });
const fixtures: GithubFixture[] = [];
const setup = (profile: Parameters<typeof githubFixture>[0] = "default") => { const f = githubFixture(profile); fixtures.push(f); return f; };
afterEach(() => { for (const f of fixtures.splice(0)) f.cleanup(); });

test("readiness checks actual scope/criteria/prerequisite/ownership/branch/PR evidence and waits", async () => {
  const f = setup(), issue = f.protocol.value.issues[0]!;
  f.protocol.value.issues.push({ ...structuredClone(issue), number: 43, blockers: [{ issue: 30, satisfied: true, contract: null, evidence: [] }] }, { ...structuredClone(issue), number: 44, assignees: ["someone"] }, { ...structuredClone(issue), number: 45, branches: ["someone/fix"] }, { ...structuredClone(issue), number: 46, pulls: [9] });
  const r = await f.service.discover(f.inspect.actor!, "repo");
  expect(r.waitingForSelection).toBe(true); expect(r.rows.map(x => x.state)).toEqual(["ready", "blocked", "owned", "owned", "has_pr"]);
  expect(r.rows[1]!.reasons.find(x => x.code === "prerequisite_30")).toMatchObject({ passed: false });
  expect(r.rows[0]!.reasons.every(x => x.evidence[0]?.observedAt === 1000)).toBe(true);
  expect(f.counts.implementations).toBe(0); expect(f.protocol.calls).toHaveLength(0); expect(f.counts.assignments).toBe(0);
});
test.each(["scope", "criteria", "closed"])("readiness refuses missing %s", kind => {
  const s = githubSnapshot(); if (kind === "scope") s.issues[0]!.scope = null; if (kind === "criteria") s.issues[0]!.criteria = []; if (kind === "closed") s.issues[0]!.state = "closed";
  expect(githubReadiness(s)[0]!.state).toBe("blocked");
});
test("inspect and copied model actors cannot select/start; one clear selection is durable and deduplicated", async () => {
  const f = setup(), r = await f.service.discover(f.inspect.actor!, "repo"), input = { requestId: "owner_select", reportId: r.id, issue: 42, base, issueVersion: "issue_1" };
  await expect(f.service.select(f.inspect.actor!, input)).rejects.toThrow("github_selection_required");
  await expect(f.service.select({} as typeof f.work.actor & object, input)).rejects.toThrow("authentication_required");
  const s = await f.service.select(f.work.actor!, input); expect(await f.service.select(f.work.actor!, input)).toEqual(s);
  f.reopen(); expect((await f.service.select(f.work.actor!, input)).id).toBe(s.id);
  await expect(f.service.select(f.work.actor!, { ...input, issue: 43 })).rejects.toThrow("github_selection_required");
  await f.service.implement(f.work.actor!, s.id); await f.service.implement(f.work.actor!, s.id); expect(f.counts.implementations).toBe(1);
});
test.each(["base", "version", "owner", "branch", "pull"])("changed %s between report and selection holds", async kind => {
  const f = setup(), r = await f.service.discover(f.inspect.actor!, "repo"), s = f.protocol.value;
  if (kind === "base") s.base = "d".repeat(40); if (kind === "version") s.issues[0]!.version = "issue_2";
  if (kind === "owner") s.issues[0]!.assignees = ["other"]; if (kind === "branch") s.issues[0]!.branches = ["already/owned"]; if (kind === "pull") s.issues[0]!.pulls = [10];
  await expect(f.service.select(f.work.actor!, { requestId: "choice", reportId: r.id, issue: 42, base, issueVersion: "issue_1" })).rejects.toThrow(); expect(f.counts.implementations).toBe(0);
});
test("actual immutable command evidence is required and a crashed coding claim is reconcile-only", async () => {
  const f = setup(), s = await f.selected(); f.evidence = { ...coding(), tests: [] };
  await expect(f.service.implement(f.work.actor!, s.id)).rejects.toThrow("github_evidence_required");
  f.reopen(); await expect(f.service.implement(f.work.actor!, s.id)).rejects.toThrow("github_reconciliation_required"); expect(f.counts.implementations).toBe(1);
});
test("default exact push approval dispatches once and does not approve the PR", async () => {
  const f = setup(), s = await f.selected(); await f.service.implement(f.work.actor!, s.id);
  const p = await f.service.prepare(f.work.actor!, s.id, { kind: "push", branch: s.branch, previous: null }); expect(p.decision).toEqual({ state: "hold", code: "approval_required" });
  approve(f, p.action); expect((await f.service.dispatch(f.work.actor!, p.action)).outcome).toBe("succeeded");
  await expect(f.service.dispatch(f.work.actor!, p.action)).rejects.toThrow("already_claimed");
  const pr = await f.service.prepare(f.work.actor!, s.id, { kind: "pr_create", title: "Exact title", body: "Exact body" }); expect(pr.decision.state).toBe("hold"); expect(f.protocol.calls).toHaveLength(1);
});
test.each(["pr_update", "review_reply"] as const)("default %s and merge require their own exact approval", async kind => {
  const f = setup("publish"), s = await f.publish(); f.protocol.green();
  // A fresh default policy invalidates old work; use a separate default fixture with a populated PR.
  const g = setup(), selected = await g.selected(); await g.service.implement(g.work.actor!, selected.id);
  g.protocol.value.pull = { ...structuredClone(f.protocol.value.pull!), branch: selected.branch };
  g.protocol.value.issues[0]!.pulls = [1];
  const op: GithubOperation = kind === "pr_update" ? { kind, pull: 1, title: "Title", body: "Body" } : { kind, pull: 1, thread: "review_1", body: "Technical reply" };
  expect((await g.service.prepare(g.work.actor!, selected.id, op)).decision.state).toBe("hold");
  expect((await g.service.prepare(g.work.actor!, selected.id, { kind: "merge", pull: 1 })).decision).toEqual({ state: "hold", code: "merge_authority_required" }); expect(g.protocol.calls).toHaveLength(0);
});
test("personal publication permits selected push/PR/update/review reply but never implies merge", async () => {
  const f = setup("publish"), s = await f.publish(); f.protocol.green();
  for (const op of [{ kind: "pr_update", pull: 1, title: "Updated title", body: "Exact technical evidence" }, { kind: "review_reply", pull: 1, thread: "review_1", body: "Fixed the selected issue within scope." }] as const) {
    const p = await f.service.prepare(f.work.actor!, s.id, op); expect(p.decision.state).toBe("allow"); expect((await f.service.dispatch(f.work.actor!, p.action)).outcome).toBe("succeeded");
  }
  expect((await f.service.prepare(f.work.actor!, s.id, { kind: "merge", pull: 1 })).decision).toEqual({ state: "hold", code: "merge_authority_required" });
});
test.each(["repository", "target", "unselected"])("personal authority stays bound to exact %s", async kind => {
  const f = setup("personal"); if (kind !== "unselected") { const rule = f.f.input.rules.find(r => r.id === "publish")!; if (kind === "repository") rule.github!.repository = ref("account"); else rule.github!.target = "other"; f.f.install(); }
  if (kind === "unselected") { await expect(f.service.prepare(f.work.actor!, "unknown", { kind: "merge", pull: 1 })).rejects.toThrow("github_selection_required"); }
  else await expect(f.selected()).rejects.toThrow("stale_authority");
  expect(f.protocol.calls).toHaveLength(0);
});
test("immutable diff/ref/reply changes cannot consume an earlier exact approval", async () => {
  const f = setup(), s = await f.selected(); await f.service.implement(f.work.actor!, s.id);
  const p = await f.service.prepare(f.work.actor!, s.id, { kind: "push", branch: s.branch, previous: null }); approve(f, p.action);
  await expect(f.service.prepare(f.work.actor!, s.id, { kind: "push", branch: "other", previous: null })).rejects.toThrow("github_ref_denied");
  await expect(f.service.prepare(f.work.actor!, s.id, { kind: "push", branch: s.branch, previous: head })).rejects.toThrow("github_action_changed");
  expect(f.protocol.calls).toHaveLength(0);
});
test.each(["push", "pr_create", "review_reply", "merge"] as const)("lost %s response reconciles without duplicate mutation", async kind => {
  const f = setup("personal"); let s;
  if (kind === "push" || kind === "pr_create") { s = await f.selected(); await f.service.implement(f.work.actor!, s.id); if (kind === "pr_create") { const p = await f.service.prepare(f.work.actor!, s.id, { kind: "push", branch: s.branch, previous: null }); await f.service.dispatch(f.work.actor!, p.action); } }
  else { s = await f.publish(); f.protocol.green(); }
  const op: GithubOperation = kind === "push" ? { kind, branch: s.branch, previous: null } : kind === "pr_create" ? { kind, title: "Title", body: "Body" } : kind === "review_reply" ? { kind, pull: 1, thread: "review_1", body: "Exact reply" } : { kind, pull: 1 };
  const p = await f.service.prepare(f.work.actor!, s.id, op), count = f.protocol.calls.length; f.protocol.failAfterSend = true;
  expect((await f.service.dispatch(f.work.actor!, p.action)).outcome).toBe("unknown");
  await expect(f.service.dispatch(f.work.actor!, p.action)).rejects.toThrow("already_claimed");
  expect((await f.f.service.owner.reconcile(f.f.owner, actionRef(p.action), `readback_${kind}`)).outcome).toBe("succeeded"); expect(f.protocol.calls).toHaveLength(count + 1);
});
test.each(["head", "base", "checks", "review", "production"])("protected protocol fixture refuses a concurrent %s race", async kind => {
  const f = setup("personal"), s = await f.publish(); f.protocol.green(); const p = await f.service.prepare(f.work.actor!, s.id, { kind: "merge", pull: 1 });
  f.protocol.beforeMutation = () => { const v = f.protocol.value; if (kind === "head") v.pull!.head = nextHead; if (kind === "base") { v.base = nextHead; v.pull!.base = nextHead; } if (kind === "checks") v.pull!.checks[0]!.state = "failure"; if (kind === "review") v.pull!.reviews[0]!.state = "changes_requested"; if (kind === "production") v.production.consequence = "would_deploy"; f.protocol.bump(); };
  expect((await f.service.dispatch(f.work.actor!, p.action)).outcome).toBe("failed"); expect(f.protocol.value.pull!.state).toBe("open");
});
test("rule revoke during final read prevents send, including an earlier exact approval", async () => {
  const f = setup("personal"), s = await f.publish(); f.protocol.green(); const p = await f.service.prepare(f.work.actor!, s.id, { kind: "merge", pull: 1 }), count = f.protocol.calls.length;
  f.protocol.beforeSnapshot = () => { f.protocol.beforeSnapshot = null; f.f.service.owner.revoke(f.f.owner, "revoke_before_send", { kind: "policy" }); };
  expect((await f.service.dispatch(f.work.actor!, p.action)).outcome).not.toBe("succeeded"); expect(f.protocol.calls).toHaveLength(count);
});
test.each(["failure", "flaky", "pending", "stale", "missing", "unresolved"])("%s checks/reviews prevent merge", async kind => {
  const f = setup("personal"), s = await f.publish(); f.protocol.green(); const p = f.protocol.value.pull!;
  if (kind === "stale") p.checks[0]!.head = nextHead; else if (kind === "missing") p.checks = []; else if (kind === "unresolved") { p.reviews[0]!.state = "changes_requested"; p.reviews[0]!.resolved = false; } else p.checks[0]!.state = kind as "failure" | "flaky" | "pending";
  const action = await f.service.prepare(f.work.actor!, s.id, { kind: "merge", pull: 1 }); expect(action.decision).toEqual({ state: "hold", code: "github_evidence_required" });
});
test.each(["would_deploy", "unknown", "protected_gate"] as const)("production %s is handled before merge", async consequence => {
  const f = setup("personal"), s = await f.publish(); f.protocol.green(); f.protocol.value.production = { consequence, fence: consequence === "protected_gate" ? { kind: "resource", ref: ref("deployment_gate") } : null, evidence: [{ ref: "protected:gate", observedAt: 1000 }] };
  const action = await f.service.prepare(f.work.actor!, s.id, { kind: "merge", pull: 1 });
  expect(action.decision.state).toBe(consequence === "protected_gate" ? "allow" : "hold");
  if (consequence === "would_deploy") { approve(f, action.action); expect((await f.service.dispatch(f.work.actor!, action.action)).outcome).toBe("succeeded"); }
  if (consequence === "unknown") expect(() => approve(f, action.action)).toThrow("production_impact_required");
});
test("durable CI/review wait survives reopen without holding or reopening a VM", async () => {
  const f = setup("personal"), s = await f.publish(); const row = await f.service.babysit(f.f.owner, f.work.actor!, { requestId: "follow", sourceRequestId: "chat_root", selectionId: s.id, pull: 1, reserveCalls: 2 });
  const waiting = await f.service.tick(row.id); expect(waiting.state).toBe("waiting_ci"); expect(f.counts.liveVm).toBe(0); expect(f.counts.waits).toBe(1);
  f.reopen(); expect((await f.service.tick(row.id)).state).toBe("waiting_ci"); expect(f.counts.implementations).toBe(1);
  f.advance(11); f.protocol.green(); f.protocol.value.pull!.reviews = []; const review = await f.service.tick(row.id); expect(review.state).toBe("waiting_review"); expect(f.counts.liveVm).toBe(0);
});
test("selected personal PR automatically merges only its current eligible head", async () => {
  const f = setup("personal"), s = await f.publish(); f.protocol.green(); const row = await f.service.babysit(f.f.owner, f.work.actor!, { requestId: "follow", sourceRequestId: "chat_root", selectionId: s.id, pull: 1, reserveCalls: 2 });
  expect((await f.service.tick(row.id)).state).toBe("merged"); expect(f.protocol.calls.at(-1)!.operation.kind).toBe("merge"); expect(f.protocol.calls.at(-1)!.head).toBe(head);
});
test("publication-only profile reports merge readiness and waits for exact owner authority", async () => {
  const f = setup("publish"), s = await f.publish(); f.protocol.green(); const row = await f.service.babysit(f.f.owner, f.work.actor!, { requestId: "follow", sourceRequestId: "chat_root", selectionId: s.id, pull: 1, reserveCalls: 2 });
  const result = await f.service.tick(row.id); expect(result.state).toBe("waiting_owner"); expect(result.reasons).toEqual(["merge_authority_required"]); expect(f.counts.liveVm).toBe(0);
});
test("failed CI remediates within the same responsibility and republishes a separately verified head", async () => {
  const f = setup("personal"), s = await f.publish(); f.protocol.green(); f.protocol.value.pull!.checks[0]!.state = "failure"; f.evidence = coding(nextHead);
  const row = await f.service.babysit(f.f.owner, f.work.actor!, { requestId: "follow", sourceRequestId: "chat_root", selectionId: s.id, pull: 1, reserveCalls: 2 });
  const result = await f.service.tick(row.id); expect(result.state).toBe("active"); expect(f.protocol.value.pull!.head).toBe(nextHead); expect(f.counts.assignments).toBe(1); expect(f.counts.attempts).toBe(1); expect(f.counts.liveVm).toBe(0);
});
test("repeated no-progress approaches stall with evidence and never select replacement work", async () => {
  const f = setup("personal"), s = await f.publish(); f.protocol.green(); f.protocol.value.pull!.checks[0]!.state = "failure";
  const row = await f.service.babysit(f.f.owner, f.work.actor!, { requestId: "follow", sourceRequestId: "chat_root", selectionId: s.id, pull: 1, reserveCalls: 2 });
  await f.service.tick(row.id); f.advance(11); await f.service.tick(row.id); f.advance(11); const result = await f.service.tick(row.id);
  expect(result.state).toBe("stalled"); expect(result.reasons).toContain("github_no_progress"); expect(f.counts.assignments).toBe(1); expect(f.counts.liveVm).toBe(0);
});
test("personal capture exposes repository/protection/target/rules and revocation invalidates current work", async () => {
  const f = setup("personal"), capture = await f.service.personalCapture(f.f.owner, f.inspect.actor!);
  expect(capture.repositories[0]!.protection.requiredChecks).toEqual(["ci"]); expect(capture.repositories[0]!.repository.target).toBe("main"); expect(capture.publication).toBe("personal"); expect(capture.merge).toBe("personal");
  f.service.revokePersonal(f.f.owner, { requestId: "revoke_personal", expectedPolicyRevision: capture.revoke.expectedPolicyRevision, ruleIds: capture.ruleIds });
  expect(f.f.service.owner.current(f.f.owner)!.rules.some(r => r.mode.startsWith("personal_github"))).toBe(false);
  await expect(f.service.discover(f.work.actor!, "repo")).rejects.toThrow("stale_authority");
});
test("unknown protection, duplicate checks and stale approvals hold eligibility", async () => {
  const f = setup("personal"); await f.publish(); f.protocol.green(); const s = f.protocol.value;
  s.protection.known = false; expect(githubEligibility(s, { head, acceptance: true, evidence: true }).eligible).toBe(false);
  s.protection.known = true; s.pull!.checks.push(s.pull!.checks[0]!); expect(githubEligibility(s, { head, acceptance: true, evidence: true }).checksPassed).toBe(false);
  s.pull!.checks.pop(); s.pull!.reviews[0]!.head = nextHead; expect(githubEligibility(s, { head, acceptance: true, evidence: true }).reviewsPassed).toBe(false);
});
test("conclusive GitHub refusal permits a fresh protected re-evaluation, unknown does not", async () => {
  const f = setup("personal"), s = await f.publish(); f.protocol.green();
  const first = await f.service.prepare(f.work.actor!, s.id, { kind: "merge", pull: 1 }); f.protocol.reject = true;
  expect((await f.service.dispatch(f.work.actor!, first.action)).outcome).toBe("failed");
  f.protocol.reject = false; f.protocol.bump(); const next = await f.service.prepare(f.work.actor!, s.id, { kind: "merge", pull: 1 });
  expect(next.action.id).not.toBe(first.action.id); expect((await f.service.dispatch(f.work.actor!, next.action)).outcome).toBe("succeeded");
  const g = setup("personal"), selected = await g.publish(); g.protocol.green();
  const reply = await g.service.prepare(g.work.actor!, selected.id, { kind: "review_reply", pull: 1, thread: "review_1", body: "Exact reply" }); g.protocol.failAfterSend = true;
  expect((await g.service.dispatch(g.work.actor!, reply.action)).outcome).toBe("unknown"); g.protocol.bump();
  await expect(g.service.prepare(g.work.actor!, selected.id, { kind: "merge", pull: 1 })).rejects.toThrow("github_reconciliation_required");
});
