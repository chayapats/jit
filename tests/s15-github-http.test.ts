import { afterEach, expect, test } from "bun:test";
import { createGithubHandler } from "../src/s15/github";
import { AppError } from "../src/errors";
import { githubFixture, type GithubFixture } from "./fixtures/s15-github";
const fixtures: GithubFixture[] = [];
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));
function fixture() {
  const f = githubFixture(); fixtures.push(f);
  const handler = createGithubHandler(f.service, { origin: "http://jit.invalid", cookieName: "owner", authentication: { authenticate(token) { if (token !== "session") throw new AppError("authentication_required", 401); return { actor: f.f.owner, csrf: "csrf" }; }, verifyCsrf(expected, actual) { if (expected !== actual) throw new AppError("csrf_rejected", 403); } }, resolveWork(owner, workId) { f.f.service.owner.current(owner); return f.f.service.control.bindWork(workId); } });
  const request = (endpoint: string, body: string, headers: Record<string, string> = {}) => handler(new Request(`http://jit.invalid/s15/github/work/${f.inspect.receipt.work!.id}/${endpoint}`, { method: "POST", headers: { cookie: "owner=session", origin: "http://jit.invalid", "x-csrf-token": "csrf", "content-type": "application/json", ...headers }, body }));
  return { f, handler, request };
}
test("authenticated JSON readiness never starts implementation", async () => {
  const { f, request } = fixture(), response = await request("discover", '{"repositoryId":"repo"}'); expect(response.status).toBe(200); expect((await response.json()).waitingForSelection).toBe(true); expect(f.counts.implementations).toBe(0); expect(response.headers.get("cache-control")).toBe("private, no-store");
});
test.each(["origin", "csrf", "cookie", "duplicates"])("JSON API rejects %s before any GitHub I/O", async kind => {
  const { f, request } = fixture();
  const headers = kind === "origin" ? { origin: "http://evil.invalid" } : kind === "csrf" ? { "x-csrf-token": "bad" } : kind === "cookie" ? { cookie: "owner=bad" } : {};
  const response = await request("discover", kind === "duplicates" ? '{"repositoryId":"repo","repositoryId":"other"}' : '{"repositoryId":"repo"}', headers);
  expect(response.status).toBeGreaterThanOrEqual(400); expect(f.protocol.reads).toBe(0);
});
test("personal profile is off until explicit owner capture/install, with live strict requirements", async () => {
  const { f } = fixture(), capture = await f.service.personalCapture(f.f.owner, f.inspect.actor!); expect(capture.publication).toBe("off"); expect(capture.repositories[0]!.autoMergeAvailable).toBe(true);
  const result = await f.service.installPersonal(f.f.owner, f.inspect.actor!, { requestId: "opt_in", captureId: capture.captureId, repositoryIds: ["repo"], publication: true, merge: true });
  const policy = f.f.service.owner.current(f.f.owner)!; expect(result.ruleIds).toHaveLength(2); expect(policy.rules.find(r => r.mode === "personal_github_merge")!.github).toMatchObject({ target: "main", requiredChecks: ["ci"], requiredApprovals: 1, requireCodeOwners: false });
});
test("missing/weaker protection leaves auto-merge unavailable and cannot be installed as if protected", async () => {
  const { f } = fixture(); f.protocol.value.protection.strict = false;
  const capture = await f.service.personalCapture(f.f.owner, f.inspect.actor!); expect(capture.repositories[0]!.reason).toBe("github_protection_required");
  await expect(f.service.installPersonal(f.f.owner, f.inspect.actor!, { requestId: "opt_in", captureId: capture.captureId, repositoryIds: ["repo"], publication: true, merge: true })).rejects.toThrow("github_protection_required");
});
