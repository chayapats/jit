import { join } from "node:path";
import { GithubService, GithubStore, HttpProtectedGithubGateway, createGithubActionAdapter, githubReadHandler, type GithubCodingEvidence, type GithubEffect, type GithubEffectResult, type GithubLimits, type GithubRepository, type GithubResponsibilities, type GithubSnapshot } from "../../src/s15/github";
import type { OwnerActor } from "../../src/s15/policy";
import { canonical, digest } from "../../src/s15/github/validation";
import { fixture, ref, selection } from "./s15-policy";

export const base = "a".repeat(40), head = "b".repeat(40), nextHead = "c".repeat(40);
export const repo: GithubRepository = { resource: ref("repo"), name: "fixture/sandbox", target: "main" };
const source = (ref = "github:source") => ({ ref, observedAt: 1000 });
export const githubSnapshot = (): GithubSnapshot => ({ repository: repo.name, target: "main", base, version: "v1", source: source(),
  protection: { version: "protection_1", known: true, strict: true, enforcesReviews: true, requiredChecks: ["ci"], requiredApprovals: 1, requireCodeOwners: false, source: source("github:protection") },
  production: { consequence: "none", fence: null, evidence: [source("protected:production")] },
  issues: [{ number: 42, title: "Implement the selected change", body: "A bounded code change.", comments: [], version: "issue_1", state: "open", scope: "Add the requested behavior", criteria: [{ id: "AC01", text: "The deterministic behavior passes" }], blockers: [], assignees: [], branches: [], pulls: [], source: source("github:issue_42") }], pull: null });
export const coding = (commit = head): GithubCodingEvidence => ({ head: commit, base, diffHash: digest(`diff:${commit}`), bundle: ref("bundle"), tests: [{ command: "bun test", exitCode: 0, outputHash: digest("actual passing output") }], criteria: [{ id: "AC01", passed: true, evidence: [source("vm:test_1")] }], source: source("vm:actual_run"), settlement: { transportSettled: true, executionSettled: true } });

/** Stateful HTTP fake of the protected GitHub protocol: CAS is checked at mutation, not preflight. */
export class GithubProtocolFixture {
  value = githubSnapshot(); calls: GithubEffect[] = []; reads = 0; serial = 1; failAfterSend = false; reject = false;
  beforeSnapshot: (() => void) | null = null; beforeMutation: (() => void) | null = null;
  readonly results = new Map<string, GithubEffectResult>(); readonly branches = new Map<string, string>();
  readonly server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async request => {
    if (request.headers.get("authorization") !== "Bearer fixture_gateway_identity") return new Response(null, { status: 401 });
    const path = new URL(request.url).pathname, payload = await request.json();
    if (path === "/v1/github/snapshot") { this.reads++; this.beforeSnapshot?.(); return Response.json(structuredClone(this.value)); }
    const effect = payload as GithubEffect;
    if (path === "/v1/github/reconcile") return Response.json(this.results.get(effect.key) ?? { key: effect.key, effectHash: digest(canonical(effect)), outcome: "unknown", receipt: null });
    if (path !== "/v1/github/mutate") return new Response(null, { status: 404 });
    this.calls.push(structuredClone(effect)); this.beforeMutation?.();
    const hash = digest(canonical(effect)), outcome = (kind: GithubEffectResult["outcome"]): GithubEffectResult => ({ key: effect.key, effectHash: hash, outcome: kind, receipt: kind === "succeeded" ? `github:receipt_${this.calls.length}` : null });
    if (this.results.has(effect.key)) return Response.json(outcome("rejected"));
    if (this.reject || effect.snapshotVersion !== this.value.version || effect.base !== this.value.base || effect.repository !== this.value.repository || effect.target !== this.value.target) return Response.json(outcome("rejected"));
    const op = effect.operation;
    if (op.kind === "push") {
      if ((this.branches.get(op.branch) ?? null) !== op.previous || op.branch === this.value.target) return Response.json(outcome("rejected"));
      this.branches.set(op.branch, effect.head); if (this.value.pull?.branch === op.branch) { this.value.pull.head = effect.head; this.value.pull.checks = []; this.value.pull.reviews = []; }
    } else if (op.kind === "pr_create") {
      if (this.value.pull) return Response.json(outcome("rejected"));
      const branch = [...this.branches].find(([, oid]) => oid === effect.head)?.[0]; if (!branch) return Response.json(outcome("rejected"));
      this.value.pull = { number: 1, issue: effect.issue, branch, head: effect.head, base: effect.base, state: "open", draft: false, mergeable: true, checks: [], reviews: [] };
      this.value.issues[0]!.pulls = [1];
    } else {
      if (!this.value.pull || this.value.pull.head !== effect.head || this.value.pull.base !== effect.base || this.value.pull.number !== op.pull) return Response.json(outcome("rejected"));
      if (op.kind === "merge") this.value.pull.state = "merged";
    }
    const result = outcome("succeeded"); this.results.set(effect.key, result); this.bump();
    if (this.failAfterSend) return new Response("unconfirmed", { status: 503 });
    return Response.json(result);
  } });
  readonly gateway = new HttpProtectedGithubGateway({ origin: `http://127.0.0.1:${this.server.port}`, credential: () => "fixture_gateway_identity", timeoutMs: 2000, maxResponseBytes: 1024 * 1024, allowLoopbackFixture: true });
  bump() { this.value.version = `v${++this.serial}`; }
  green() {
    const p = this.value.pull!; p.checks = [{ name: "ci", head: p.head, base: p.base, state: "success", source: source("github:check_ci") }];
    p.reviews = [{ id: "review_1", author: "reviewer", head: p.head, base: p.base, state: "approved", resolved: true, codeOwner: false, body: "Reviewed", source: source("github:review_1") }]; this.bump();
  }
  close() { this.server.stop(true); }
}

export function githubFixture(profile: "default" | "publish" | "personal" = "default") {
  const protocol = new GithubProtocolFixture(); let store: GithubStore, now = 1000;
  const limits: GithubLimits = { snapshotMaxAgeMs: 20000, waitMs: 10, stallMs: 10000, maxNoProgress: 2, maxAttempts: 4, readUpperBound: { attempts: 0, steps: 0, calls: 1, reads: 1, outputBytes: 0, activeMs: 0, spendMinor: "0" }, actionUpperBound: { attempts: 0, steps: 0, calls: 1, reads: 0, outputBytes: 0, activeMs: 0, spendMinor: "0" } };
  const adapter = createGithubActionAdapter({ get store() { return store; }, gateway: protocol.gateway, limits, now: () => now, policy: () => f.service });
  const f = fixture({ adapters: [adapter], reads: [githubReadHandler([repo])] });
  store = new GithubStore(join(f.dir, "github.sqlite"), "github_test", true);
  f.add("lineage", ref("bundle")); f.add("resource", ref("deployment_gate"));
  f.input.budget!.ceiling = { attempts: 200, steps: 200, calls: 500, reads: 500, outputBytes: 100000, activeMs: 100000, spendMinor: "1000" }; f.input.budget!.concurrency = 50;
  const ordinary = f.input.rules[0]!; ordinary.adapters.push("s15_github"); ordinary.operations.push("push", "pr_create", "pr_update", "review_reply");
  f.install();
  if (profile !== "default") {
    f.input.rules.push({ ...structuredClone(ordinary), id: "publish", mode: "personal_github_publish", classes: ["github_publish", "communication"], github: { repository: ref("repo"), target: "main" } });
    if (profile === "personal") f.input.rules.push({ ...structuredClone(ordinary), id: "merge", mode: "personal_github_merge", classes: ["github_merge"], github: { repository: ref("repo"), target: "main", requiredChecks: ["ci"], requiredApprovals: 1, requireCodeOwners: false } });
    f.install();
  }
  let implementations = 0, liveVm = 0, next = coding(), assignments = 0, waits = 0, attempts = 0;
  const responsibility: { id: string; state: string; readyEventId: string | null; workId: string | null } = { id: "responsibility_42", state: "ready", readyEventId: "assigned_42", workId: null };
  const handles = new WeakSet<object>();
  const responsibilities: GithubResponsibilities = {
    assign(_owner, input) { assignments++; responsibility.workId = work.receipt.work!.id; return { ...responsibility }; },
    beginAttempt(_id, input) { if (liveVm) throw new Error("busy"); attempts++; const handle = {}; handles.add(handle); responsibility.state = "working"; return handle; },
    wait() { if (liveVm) throw new Error("VM retained during wait"); waits++; responsibility.state = "waiting"; return { ...responsibility }; },
    observeEvent(_id, event) { responsibility.state = "ready"; responsibility.readyEventId = event.eventId; return { ...responsibility }; },
    settle(handle, observation) { if (!handles.has(handle)) throw new Error("copied handle"); handles.delete(handle); responsibility.state = observation.effects === "unknown" ? "reconcile_only" : observation.complete ? "completed" : "ready"; return { state: responsibility.state }; },
    reconcile() { return {}; }, stop() { responsibility.state = "stopped"; }, project() { return { ...responsibility, attempts, waits }; },
    guard(handle) { if (!handles.has(handle)) throw new Error("copied handle"); }, signal() { return new AbortController().signal; }, publish(_handle, consume) { consume({}); }, resume() {},
  };
  const inspect = f.admit({ intent: "inspect", access: "read", resources: [ref("repo")], recipients: [], readLimit: 200 });
  const work = f.admit({ intent: "execute", access: "effect", resources: [ref("repo")], recipients: [], readLimit: 200, subject: { resource: ref("repo"), issue: 42 } });
  const workspace = { async implement(input: Parameters<import("../../src/s15/github").GithubWorkspace["implement"]>[0]) { implementations++; liveVm++; try { input.guard(); return structuredClone(next); } finally { liveVm--; } } };
  const serviceOptions = { runtime: "s15" as const, store, policy: f.service, repositories: [repo], gateway: protocol.gateway, workspace, responsibilities, limits, now: () => now };
  let service = new GithubService(serviceOptions);
  const selected = async () => { const report = await service.discover(inspect.actor!, "repo"); return service.select(work.actor!, { requestId: "owner_select", reportId: report.id, issue: 42, base, issueVersion: "issue_1" }); };
  const publish = async () => {
    const s = await selected(); await service.implement(work.actor!, s.id);
    const push = await service.prepare(work.actor!, s.id, { kind: "push", branch: s.branch, previous: null });
    await service.dispatch(work.actor!, push.action);
    const pr = await service.prepare(work.actor!, s.id, { kind: "pr_create", title: "Selected issue fix", body: "Implements #42 with actual deterministic evidence." }); await service.dispatch(work.actor!, pr.action);
    return s;
  };
  return { f, protocol, limits, inspect, work, get store() { return store; }, get service() { return service; }, responsibilities, selected, publish,
    get counts() { return { implementations, liveVm, assignments, waits, attempts }; }, set evidence(value: GithubCodingEvidence) { next = value; },
    advance(ms: number) { now += ms; f.now = now; },
    reopen() { store.close(); store = new GithubStore(join(f.dir, "github.sqlite"), "github_test", false); service = new GithubService({ ...serviceOptions, store, policy: f.service }); return service; },
    cleanup() { store.close(); protocol.close(); f.cleanup(); },
  };
}
export type GithubFixture = ReturnType<typeof githubFixture>;
