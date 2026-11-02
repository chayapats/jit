import type { AdapterResult } from "../policy";
import { registerSecretFingerprint } from "../../security/secret-fingerprints";
import type { GithubEffect, GithubEffectResult, GithubIssue, GithubProduction, GithubProtection, GithubRepository, GithubSnapshot, ProtectedGithubGateway } from "./types";
import { canonical, content, digest, fail, integer, oid, repository } from "./validation";
import { githubProtectionMatches } from "./readiness";

type Json = Record<string, any>;
/** Verified object transport owns bounded bundle import/fsck/diff and exact force-with-lease, never the working checkout. */
export interface GithubProtectedPush {
  push(effect: GithubEffect, credential: string, dispatch: (send: () => Promise<GithubEffectResult>) => Promise<AdapterResult>): Promise<AdapterResult>;
  readHead(repository: GithubRepository, branch: string, credential: string): Promise<string | null>;
}

/**
 * Actual fixed-origin GitHub REST adapter. GitHub atomically enforces exact merge sha plus strict
 * required checks/reviews; Jit's fence only serializes its own attempts. Protection weaker than the
 * owner-captured rule refuses auto-merge. Neither this class nor read-then-write claims atomicity over
 * arbitrary external metadata or production policy; production generations also remain POLICY fences.
 */
export class GithubApiGateway implements ProtectedGithubGateway {
  private readonly repos: readonly GithubRepository[];
  private readonly busy = new Set<string>();
  constructor(private readonly options: {
    repositories: readonly GithubRepository[]; credential(repository: GithubRepository): string;
    production(repository: GithubRepository): GithubProduction; push: GithubProtectedPush;
    /** Owning prerequisite resolver must prove the merged supported contract, not just a closed issue. */
    prerequisite?: (repository: GithubRepository, issue: number) => Promise<GithubIssue["blockers"][number]>;
    fetch?: typeof fetch; now?: () => number; maxItems?: number;
  }) { this.repos = structuredClone(options.repositories); this.repos.forEach(repository); }
  private repo(name: string, target: string): GithubRepository { const r = this.repos.find(r => r.name === name && r.target === target); if (!r) fail("github_repository_denied"); return r; }
  private async request(repo: GithubRepository, path: string, method = "GET", payload?: unknown): Promise<{ status: number; value: any; headers: Headers }> {
    if (!path.startsWith(`/repos/${repo.name}/`) && path !== "/graphql") fail("github_endpoint_denied");
    const secret = this.options.credential(repo); if (!secret || /[\r\n]/.test(secret)) fail("github_credential_unavailable"); registerSecretFingerprint(secret);
    let response: Response;
    try { response = await (this.options.fetch ?? fetch)(`https://api.github.com${path}`, { method, redirect: "error", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${secret}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28", "Content-Type": "application/json", "User-Agent": "jit-s15" }, ...(payload === undefined ? {} : { body: canonical(payload) }) }); }
    catch { fail("github_transport_uncertain"); }
    const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let n = 0;
    if (reader) try { for (;;) { const c = await reader.read(); if (c.done) break; n += c.value.length; if (n > 1024 * 1024) { await reader.cancel(); fail("github_response_too_large"); } chunks.push(c.value); } } finally { reader.releaseLock(); }
    let value: unknown = null; try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); } catch { /* Malformed mutations are unknown, never successful. */ }
    return { status: response.status, value, headers: response.headers };
  }
  private async list(repo: GithubRepository, path: string): Promise<any[]> {
    const r = await this.request(repo, `${path}${path.includes("?") ? "&" : "?"}per_page=100`);
    if (r.status !== 200 || !Array.isArray(r.value) || r.value.length >= (this.options.maxItems ?? 100) || r.headers.has("link")) fail("github_read_incomplete"); return r.value;
  }
  private source(path: string) { return { ref: `github:${path}`, observedAt: (this.options.now ?? Date.now)() }; }
  private async protection(repo: GithubRepository): Promise<GithubProtection> {
    const path = `/repos/${repo.name}/branches/${encodeURIComponent(repo.target)}/protection`, r = await this.request(repo, path), p = r.value as Json | null;
    if (r.status !== 200 || !p) return { version: `protection_${r.status}`, known: r.status === 404, strict: false, enforcesReviews: false, requiredChecks: [], requiredApprovals: 0, requireCodeOwners: false, source: this.source(path) };
    const checks = p.required_status_checks, reviews = p.required_pull_request_reviews;
    const names = [...new Set<string>([...(checks?.contexts ?? []), ...(checks?.checks ?? []).map((c: Json) => c.context)])].sort(); names.forEach(n => content(n, 256));
    return { version: digest(canonical(p)), known: true, strict: checks?.strict === true && p.enforce_admins?.enabled === true,
      enforcesReviews: !!reviews && p.enforce_admins?.enabled === true && reviews.dismiss_stale_reviews === true && p.required_conversation_resolution?.enabled === true,
      requiredChecks: names, requiredApprovals: reviews?.required_approving_review_count ?? 0, requireCodeOwners: reviews?.require_code_owner_reviews === true, source: this.source(path) };
  }
  /** Full bounded issue/PR/protection protocol capture; comments are retained only as untrusted evidence. */
  async snapshot(configured: GithubRepository, pullNumber: number | null): Promise<GithubSnapshot> {
    const repo = this.repo(configured.name, configured.target), root = `/repos/${repo.name}`;
    const branch = await this.request(repo, `${root}/git/ref/heads/${encodeURIComponent(repo.target)}`); if (branch.status !== 200) fail("github_base_unavailable"); oid(branch.value?.object?.sha);
    const base = branch.value.object.sha as string, protection = await this.protection(repo);
    const [rawIssues, branches, pulls] = await Promise.all([this.list(repo, `${root}/issues?state=open`), this.list(repo, `${root}/branches`), this.list(repo, `${root}/pulls?state=open`)]);
    const issues: GithubIssue[] = [];
    for (const raw of rawIssues.filter(i => !i.pull_request)) {
      integer(raw.number, 1); const body = raw.body ?? "", comments = await this.list(repo, `${root}/issues/${raw.number}/comments`);
      const section = (heading: string) => new RegExp(`^## (?:${heading})\\s*\\n([\\s\\S]*?)(?=^## |$(?![\\s\\S]))`, "mi").exec(body)?.[1]?.trim() ?? "";
      const scope = section("Scope|Deliverable"), acceptance = section("Acceptance criteria");
      const criteria = [...acceptance.matchAll(/^\s*-\s*\[[ xX]\]\s*(.+)$/gm)].map((m, index) => ({ id: `AC${String(index + 1).padStart(2, "0")}`, text: m[1]! }));
      const blockers = [...new Set([...section("Blocked by").matchAll(new RegExp(`https://github\\.com/${repo.name.replaceAll(".", "\\.")}/issues/(\\d+)`, "g"))].map(m => Number(m[1])))];
      const related = pulls.filter(p => new RegExp(`(?:#|/issues/)${raw.number}(?!\\d)`).test(`${p.title}\n${p.body ?? ""}`));
      const ownedBranches = branches.filter(b => new RegExp(`(?:^|/)(?:issue-?)?${raw.number}(?:-|/|$)`).test(b.name)).map(b => b.name as string);
      issues.push({ number: raw.number, title: raw.title, body, comments: comments.map(c => c.body), version: digest(canonical({ issue: raw, comments })), state: "open", scope: scope || null, criteria,
        blockers: await Promise.all(blockers.map(n => this.options.prerequisite ? this.options.prerequisite(repo, n) : { issue: n, satisfied: false, contract: null, evidence: [this.source(`${root}/issues/${n}`)] })),
        assignees: (raw.assignees ?? []).map((a: Json) => a.login), branches: [...new Set([...ownedBranches, ...related.map(p => p.head.ref)])], pulls: related.map(p => p.number), source: this.source(`${root}/issues/${raw.number}`) });
    }
    let pull: GithubSnapshot["pull"] = null;
    if (pullNumber !== null) {
      const p = await this.request(repo, `${root}/pulls/${pullNumber}`); if (p.status !== 200 || p.value.base?.repo?.full_name !== repo.name || p.value.head?.repo?.full_name !== repo.name || p.value.base?.ref !== repo.target) fail("github_pull_changed");
      const data = p.value; oid(data.head.sha); oid(data.base.sha);
      const checksRead = await this.request(repo, `${root}/commits/${data.head.sha}/check-runs?filter=latest&per_page=100`);
      if (checksRead.status !== 200 || !Array.isArray(checksRead.value?.check_runs) || checksRead.value.total_count >= 100 || checksRead.headers.has("link")) fail("github_read_incomplete");
      const statuses = await this.list(repo, `${root}/commits/${data.head.sha}/statuses`), reviews = await this.list(repo, `${root}/pulls/${pullNumber}/reviews`);
      const latestStatuses = new Map<string, Json>(); for (const s of statuses) if (!latestStatuses.has(s.context)) latestStatuses.set(s.context, s);
      const [owner, name] = repo.name.split("/");
      const threads = await this.request(repo, "/graphql", "POST", { query: "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){pageInfo{hasNextPage} nodes{id isResolved comments(first:1){nodes{databaseId body author{login} commit{oid}}}}}}}}", variables: { owner, name, number: pullNumber } });
      const threadData = threads.value?.data?.repository?.pullRequest?.reviewThreads;
      if (threads.status !== 200 || threads.value.errors || !threadData || threadData.pageInfo.hasNextPage) fail("github_review_incomplete");
      const latestReviews = new Map<string, Json>(); for (const r of reviews) if (r.state !== "PENDING") latestReviews.set(r.user.login, r);
      pull = { number: pullNumber, issue: issues.find(i => i.pulls.includes(pullNumber))?.number ?? 0, branch: data.head.ref, head: data.head.sha, base: data.base.sha, state: data.merged ? "merged" : data.state, draft: data.draft, mergeable: data.mergeable === true && data.mergeable_state === "clean",
        checks: [...checksRead.value.check_runs.map((c: Json) => ({ name: c.name, head: c.head_sha, base, state: c.status !== "completed" ? "pending" : c.conclusion === "success" ? "success" : "failure", source: this.source(`check:${c.id}`) })), ...[...latestStatuses.values()].map(c => ({ name: c.context, head: data.head.sha, base, state: c.state === "success" ? "success" : c.state === "pending" ? "pending" : "failure", source: this.source(`status:${c.id}`) }))],
        reviews: [...[...latestReviews.values()].map(r => ({ id: `review_${r.id}`, author: r.user.login, head: r.commit_id, base, state: r.state === "APPROVED" ? "approved" : r.state === "CHANGES_REQUESTED" ? "changes_requested" : "commented", resolved: r.state !== "CHANGES_REQUESTED", codeOwner: false, body: r.body ?? "", source: this.source(`review:${r.id}`) })), ...threadData.nodes.filter((t: Json) => !t.isResolved).map((t: Json) => { const c = t.comments.nodes[0]; return { id: `comment_${c.databaseId}`, author: c.author.login, head: c.commit.oid, base, state: "changes_requested", resolved: false, codeOwner: false, body: c.body, source: this.source(`thread:${t.id}`) }; })] };
    }
    const production = structuredClone(this.options.production(repo));
    const value: GithubSnapshot = { repository: repo.name, target: repo.target, base, version: "pending", issues, protection, production, pull, source: this.source(root) };
    // Observation times are not versions: identical facts reread later retain their logical precondition.
    value.version = digest(JSON.stringify(value, (key, v) => key === "observedAt" ? 0 : v)); return value;
  }
  private outcome(effect: GithubEffect, outcome: GithubEffectResult["outcome"], receipt: string | null = null): GithubEffectResult { return { key: effect.key, effectHash: digest(canonical(effect)), outcome, receipt }; }
  /** One Jit attempt per PR. Preflight is advisory; merge sha + strict GitHub enforcement supplies the server boundary. */
  async mutate(effect: GithubEffect, dispatch: (send: () => Promise<GithubEffectResult>) => Promise<AdapterResult>): Promise<AdapterResult> {
    const repo = this.repo(effect.repository, effect.target), key = `${repo.name}:${"pull" in effect.operation ? effect.operation.pull : effect.branch}`;
    if (this.busy.has(key)) fail("github_publication_busy"); this.busy.add(key);
    try {
      const op = effect.operation, current = await this.snapshot(repo, "pull" in op ? op.pull : null);
      if (current.version !== effect.snapshotVersion || current.base !== effect.base) fail("github_remote_changed");
      if (op.kind === "push") return await this.options.push.push(effect, this.options.credential(repo), dispatch);
      if (op.kind === "merge") {
        const protection = await this.protection(repo);
        if (!githubProtectionMatches(protection, effect.mergeRequirements)) fail("github_protection_required");
      }
      const root = `/repos/${repo.name}/pulls`, method = op.kind === "merge" ? "PUT" : op.kind === "pr_update" ? "PATCH" : "POST";
      const path = op.kind === "pr_create" ? root : op.kind === "review_reply" ? `${root}/${op.pull}/comments/${op.thread.replace(/^comment_/, "")}/replies` : `${root}/${op.pull}${op.kind === "merge" ? "/merge" : ""}`;
      if (op.kind === "review_reply" && !/^comment_[1-9][0-9]*$/.test(op.thread)) fail("github_review_thread_unsupported");
      const payload = op.kind === "merge" ? { sha: effect.head, merge_method: "merge" } : op.kind === "pr_create" ? { title: op.title, body: op.body, head: effect.branch, base: effect.target, draft: false } : op.kind === "pr_update" ? { title: op.title, body: op.body } : { body: op.body };
      return await dispatch(async () => {
        const r = await this.request(repo, path, method, payload);
        if (op.kind === "merge" && r.status === 200 && r.value?.merged === true && /^[a-f0-9]{40}$/.test(r.value.sha)) return this.outcome(effect, "succeeded", `github:merge:${r.value.sha}`);
        if (op.kind !== "merge" && [200, 201].includes(r.status) && r.value && (op.kind === "review_reply" ? Number.isSafeInteger(r.value.id) && r.value.body === op.body : r.value.title === op.title && r.value.body === op.body && r.value.head?.sha === effect.head)) return this.outcome(effect, "succeeded", `github:${op.kind}:${r.value.id ?? r.value.number}`);
        return this.outcome(effect, [400, 401, 403, 404, 405, 409, 422].includes(r.status) ? "rejected" : "unknown");
      });
    } finally { this.busy.delete(key); }
  }
  /** Read-back only. Ambiguous PR/reply outcomes stay unknown rather than posting a marker or retry. */
  async reconcile(effect: GithubEffect): Promise<GithubEffectResult> {
    const repo = this.repo(effect.repository, effect.target), op = effect.operation;
    if (op.kind === "push") return this.outcome(effect, await this.options.push.readHead(repo, op.branch, this.options.credential(repo)) === effect.head ? "succeeded" : "unknown", `github:ref:${op.branch}:${effect.head}`);
    if (op.kind === "merge") { const p = await this.request(repo, `/repos/${repo.name}/pulls/${op.pull}`); if (p.status === 200 && p.value?.merged === true && p.value.head?.sha === effect.head && p.value.base?.ref === effect.target) return this.outcome(effect, "succeeded", `github:merge:${p.value.merge_commit_sha}`); }
    return this.outcome(effect, "unknown");
  }
}
