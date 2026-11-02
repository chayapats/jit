import { join } from "node:path";
import { GithubService, GithubStore, HttpProtectedGithubGateway, createGithubActionAdapter, githubReadHandler, type GithubCodingEvidence, type GithubEffect, type GithubEffectResult, type GithubLimits, type GithubRepository, type GithubSnapshot } from "../../src/s15/github";
import { openWorkService, type AttemptSettlement, type ResponsibilityPort, type WorkOptions } from "../../src/s15/work/index";
import type { ConversationRequest } from "../../src/s15/conversation";
import type { ActionAdapter, CatalogPort, Ref } from "../../src/s15/policy";
import { canonical, digest } from "../../src/s15/github/validation";
import { fixture, ref } from "./s15-policy";

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

export function githubFixture(profile: "default" | "publish" | "personal" = "default", composition: { adapter?: (adapter: ActionAdapter) => ActionAdapter; catalogs?: (base: CatalogPort) => CatalogPort; recipients?: Ref[] } = {}) {
  const protocol = new GithubProtocolFixture(); let store: GithubStore, now = 1000;
  const limits: GithubLimits = { snapshotMaxAgeMs: 20000, waitMs: 10, stallMs: 10000, maxNoProgress: 2, maxAttempts: 4, readUpperBound: { attempts: 0, steps: 0, calls: 1, reads: 1, outputBytes: 0, activeMs: 0, spendMinor: "0" }, actionUpperBound: { attempts: 0, steps: 0, calls: 1, reads: 0, outputBytes: 0, activeMs: 0, spendMinor: "0" } };
  const adapter = createGithubActionAdapter({ get store() { return store; }, gateway: protocol.gateway, limits, now: () => now, policy: () => f.service });
  const f = fixture({ adapters: [composition.adapter?.(adapter) ?? adapter], reads: [githubReadHandler([repo])], ...(composition.catalogs ? { catalogs: composition.catalogs } : {}) });
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
  const inspect = f.admit({ intent: "inspect", access: "read", resources: [ref("repo")], recipients: [], readLimit: 200 });
  const work = f.admit({ intent: "execute", access: "effect", resources: [ref("repo")], recipients: composition.recipients ?? [], readLimit: 200, subject: { resource: ref("repo"), issue: 42 } });
  const command = { contract: "s15-conversation/v1" as const, requestId: "chat_root", conversationId: "conversation", text: "Implement issue #42 and follow its PR until safely settled.", continuation: null };
  // Controlled completed CHAT source over a real POLICY admission. WORK itself is the production service.
  const chatSource: ConversationRequest = { receipt: { contract: "s15-conversation-receipt/v1", requestId: "chat_root", rootRequestId: "chat_root", conversationId: "conversation", receivedAt: now }, command, interpretationRequest: command, owner: { id: "owner", generation: 1 }, revision: 1,
    intent: { kind: "execute", subject: "issue:42", instruction: command.text, scope: { purposeId: "purpose", resourceIds: ["repo"], access: "effect" } }, state: "completed", code: null,
    authority: { id: work.receipt.work!.id, purposeId: "purpose", policyRevision: work.receipt.work!.policyRevision, resources: ["repo"], route: { provider: "codex", model: "scripted" }, limits: { modelCalls: 20, toolCalls: 200, outputBytes: 10000, activeMs: 60000 } },
    phase: "work", interpretation: null, interpretationCalls: 0, modelCalls: 0, toolCalls: 0, result: "Local implementation evidence committed.", usage: null, actions: [], decision: null };
  const workOptions = (create: boolean): WorkOptions => ({ runtime: "s15", path: join(f.dir, "work.sqlite"), installationId: "github_test", create, policy: f.service, now: () => now,
    remainingCalls: () => f.input.budget!.ceiling.calls - f.service.control.usage().charged.calls,
    conversation: { view(owner, requestId) { f.service.owner.current(owner); if (requestId !== "chat_root") throw new Error("unknown source"); return structuredClone(chatSource); } } });
  let workService = openWorkService(workOptions(true));
  const settlements: AttemptSettlement[] = [];
  const responsibilities: ResponsibilityPort = {
    assign(owner, input) { const r = workService.assign(owner, input); assignments++; return r; },
    beginAttempt(id, input) { const handle = workService.beginAttempt(id, input); attempts++; return handle; },
    wait(id, input) { if (liveVm) throw new Error("VM retained during wait"); const r = workService.wait(id, input); waits++; return r; },
    observeEvent: (id, input) => workService.observeEvent(id, input),
    settle(handle, input) { const r = workService.settle(handle, input); settlements.push(structuredClone(input)); return r; },
    reconcile: (id, attempt, input) => workService.reconcile(id, attempt, input),
    stop: (owner, id, requestId) => workService.stop(owner, id, requestId),
    project: (owner, id) => workService.project(owner, id),
    guard: handle => workService.guard(handle), signal: handle => workService.signal(handle),
    publish: (handle, consume) => workService.publish(handle, consume), resume: (owner, id, source) => workService.resume(owner, id, source),
  };
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
  return { f, protocol, limits, inspect, work, get store() { return store; }, get service() { return service; }, responsibilities, settlements, chatSource, selected, publish,
    get counts() { return { implementations, liveVm, assignments, waits, attempts }; }, set evidence(value: GithubCodingEvidence) { next = value; },
    advance(ms: number) { now += ms; f.now = now; },
    reopen() { workService.close(); workService = openWorkService(workOptions(false)); store.close(); store = new GithubStore(join(f.dir, "github.sqlite"), "github_test", false); service = new GithubService({ ...serviceOptions, store, policy: f.service }); return service; },
    cleanup() { workService.close(); store.close(); protocol.close(); f.cleanup(); },
  };
}
export type GithubFixture = ReturnType<typeof githubFixture>;
