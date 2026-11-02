import { afterEach, expect, test } from "bun:test";
import { GithubApiGateway, githubProtectionMatches, type GithubEffect, type GithubEffectResult } from "../src/s15/github";
import type { AdapterResult } from "../src/s15/policy";
import { base, head, nextHead, repo } from "./fixtures/s15-github";
import { digest, canonical } from "../src/s15/github/validation";
import { ref } from "./fixtures/s15-policy";
const servers: ReturnType<typeof Bun.serve>[] = [];
afterEach(() => { servers.splice(0).forEach(s => s.stop(true)); });
function fixture() {
  const state = { head, base, checks: true, reviews: true, strict: true, merged: false, writes: [] as { path: string; body: any }[], beforeMerge: null as (() => void) | null };
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const u = new URL(request.url), path = u.pathname;
    if (path.endsWith("/git/ref/heads/main")) return Response.json({ object: { sha: state.base } });
    if (path.endsWith("/protection")) return Response.json({ required_status_checks: { strict: state.strict, contexts: ["ci"] }, enforce_admins: { enabled: true }, required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: true, require_code_owner_reviews: false }, required_conversation_resolution: { enabled: true } });
    if (path.endsWith("/issues")) return Response.json([{ number: 42, title: "Bounded fix", body: "## Deliverable\nFix the selected behavior.\n## Acceptance criteria\n- [ ] Behavior passes\n", assignees: [] }]);
    if (path.endsWith("/issues/42/comments")) return Response.json([]);
    if (path.endsWith("/branches")) return Response.json([{ name: "main" }, { name: "jit/issue-42" }]);
    const pull = () => ({ number: 1, title: "Fix #42", body: "Closes #42", state: "open", merged: state.merged, draft: false, mergeable: true, mergeable_state: "clean", head: { sha: state.head, ref: "jit/issue-42", repo: { full_name: repo.name } }, base: { sha: state.base, ref: "main", repo: { full_name: repo.name } } });
    if (path.endsWith("/pulls")) return Response.json([pull()]);
    if (path.endsWith("/pulls/1")) return Response.json(pull());
    if (path.endsWith("/check-runs")) return Response.json({ total_count: 1, check_runs: [{ id: 1, name: "ci", head_sha: state.head, status: "completed", conclusion: state.checks ? "success" : "failure" }] });
    if (path.endsWith("/statuses")) return Response.json([]);
    if (path.endsWith("/reviews")) return Response.json(state.reviews ? [{ id: 1, user: { login: "reviewer" }, state: "APPROVED", commit_id: state.head, body: "Approved" }] : []);
    if (path === "/graphql") return Response.json({ data: { repository: { pullRequest: { reviewThreads: { pageInfo: { hasNextPage: false }, nodes: [] } } } } });
    if (path.endsWith("/merge") && request.method === "PUT") {
      const body = await request.json(); state.writes.push({ path, body }); state.beforeMerge?.();
      if (body.sha !== state.head) return Response.json({ message: "Head changed" }, { status: 409 });
      if (!state.strict || !state.checks || !state.reviews || state.base !== base) return Response.json({ message: "Required server conditions failed" }, { status: 405 });
      state.merged = true; return Response.json({ merged: true, sha: nextHead });
    }
    return new Response(null, { status: 404 });
  } }); servers.push(server);
  const gateway = new GithubApiGateway({ repositories: [repo], credential: () => "api_fixture_identity", production: () => ({ consequence: "none", fence: null, evidence: [{ ref: "protected:production", observedAt: 1000 }] }), push: { async push() { throw new Error("not a push fixture"); }, async readHead() { return null; } }, now: () => 1000,
    fetch: ((url, init) => fetch(`http://127.0.0.1:${server.port}${new URL(String(url)).pathname}${new URL(String(url)).search}`, init)) as typeof fetch });
  const effect = async (): Promise<GithubEffect> => { const snapshot = await gateway.snapshot(repo, 1); return { contract: "s15-github-effect/v1", key: "merge_42", repository: repo.name, target: "main", issue: 42, head, base, branch: "jit/issue-42", evidenceHash: digest("evidence"), snapshotVersion: snapshot.version, operation: { kind: "merge", pull: 1 }, bundle: ref("bundle"), diffHash: digest("diff"), mergeRequirements: { requiredChecks: ["ci"], requiredApprovals: 1, requireCodeOwners: false } }; };
  return { state, gateway, effect };
}
const dispatch = async (send: () => Promise<GithubEffectResult>): Promise<AdapterResult> => { const r = await send(); return { outcome: r.outcome === "rejected" ? "failed" : r.outcome, actual: { attempts: null, steps: null, calls: null, reads: null, outputBytes: null, activeMs: null, spendMinor: null }, transportSettled: true }; };
test("actual GitHub REST protocol reads protection and sends merge with exact sha", async () => {
  const f = fixture(), snapshot = await f.gateway.snapshot(repo, 1); expect(snapshot.issues[0]!.criteria).toHaveLength(1); expect(snapshot.protection.strict).toBe(true); expect(githubProtectionMatches(snapshot.protection, snapshot.protection)).toBe(true);
  const effect = await f.effect(); expect((await f.gateway.mutate(effect, dispatch)).outcome).toBe("succeeded"); expect(f.state.writes[0]!.body).toEqual({ sha: head, merge_method: "merge" });
});
for (const race of ["head", "base", "checks", "reviews"] as const) test(`GitHub server refuses concurrent ${race} change at merge atomically`, async () => {
  const f = fixture(), effect = await f.effect(); f.state.beforeMerge = () => { if (race === "head") f.state.head = nextHead; if (race === "base") f.state.base = nextHead; if (race === "checks") f.state.checks = false; if (race === "reviews") f.state.reviews = false; };
  expect((await f.gateway.mutate(effect, dispatch)).outcome).toBe("failed"); expect(f.state.merged).toBe(false);
});
test("missing strict protection refuses before any merge send", async () => {
  const f = fixture(), effect = await f.effect(); f.state.strict = false;
  await expect(f.gateway.mutate(effect, dispatch)).rejects.toThrow(); expect(f.state.writes).toHaveLength(0);
});
