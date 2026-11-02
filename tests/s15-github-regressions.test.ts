import { afterEach, expect, test } from "bun:test";
import { createGithubHandler } from "../src/s15/github";
import type { PreparedAction } from "../src/s15/policy";
import { codingEvidence, snapshot } from "../src/s15/github/validation";
import { base, coding, githubFixture, githubSnapshot, head, nextHead, repo, type GithubFixture } from "./fixtures/s15-github";
import { actionRef } from "./fixtures/s15-policy";

const fixtures: GithubFixture[] = [];
const setup = (profile: Parameters<typeof githubFixture>[0] = "personal") => { const f = githubFixture(profile); fixtures.push(f); return f; };
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));
const approve = (f: GithubFixture, action: PreparedAction) => f.f.service.owner.decide(f.f.owner, { requestId: `approved_${action.id}_${action.revision}`, action: actionRef(action), decision: "approve", expiresAt: action.expiresAt });
const follow = (f: GithubFixture, selectionId: string) => f.service.babysit(f.f.owner, f.work.actor!, { requestId: "follow", sourceRequestId: "chat_root", selectionId, pull: 1, reserveCalls: 2 });

test("current millisecond timestamps validate in snapshots and actual criterion evidence", () => {
  const now = Date.now(); expect(now).toBeGreaterThan(1_000_000_000);
  const stamp = <T>(value: T): T => JSON.parse(JSON.stringify(value, (key, v) => key === "observedAt" ? now : v)) as T;
  expect(() => snapshot(stamp(githubSnapshot()), repo, now, 1000)).not.toThrow();
  expect(() => codingEvidence(stamp(coding()), ["AC01"], base)).not.toThrow();
  for (const invalid of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = stamp(githubSnapshot()); bad.source.observedAt = invalid;
    expect(() => snapshot(bad, repo, now, 1000)).toThrow("invalid_number");
  }
});

test("owner approval dispatches the same merge revision after clock advancement", async () => {
  const f = setup("publish"), selected = await f.publish(); f.protocol.green();
  const row = await follow(f, selected.id), held = await f.service.tick(row.id);
  expect(held.state).toBe("waiting_owner");
  const original = f.f.service.owner.inspect(f.f.owner, held.action!).action;
  f.advance(11); approve(f, original); f.advance(11);
  const completed = await f.service.tick(row.id);
  expect(completed.state).toBe("merged"); expect(completed.action).toEqual(held.action);
  expect(f.f.service.owner.inspect(f.f.owner, held.action!).action.expiresAt).toBe(original.expiresAt);
  expect(f.protocol.calls.filter(c => c.operation.kind === "merge")).toHaveLength(1);
});

test("changed captured review facts replace a merge card instead of reusing its approval", async () => {
  const f = setup("publish"), selected = await f.publish(); f.protocol.green();
  const row = await follow(f, selected.id), held = await f.service.tick(row.id);
  approve(f, f.f.service.owner.inspect(f.f.owner, held.action!).action);
  f.protocol.value.pull!.reviews[0]!.body = "Updated review evidence"; f.protocol.bump(); f.advance(11);
  const refreshed = await f.service.tick(row.id);
  expect(refreshed.state).toBe("waiting_owner"); expect(refreshed.action).not.toEqual(held.action);
  expect(f.protocol.calls.filter(c => c.operation.kind === "merge")).toHaveLength(0);
});

test("a remediation push approved and dispatched through JSON advances to merge readiness", async () => {
  const f = setup("default"), selected = await f.selected(); await f.service.implement(f.work.actor!, selected.id);
  for (const op of [{ kind: "push", branch: selected.branch, previous: null }, { kind: "pr_create", title: "Selected issue", body: "Closes #42" }] as const) {
    const prepared = await f.service.prepare(f.work.actor!, selected.id, op); approve(f, prepared.action); await f.service.dispatch(f.work.actor!, prepared.action);
  }
  f.protocol.green(); f.protocol.value.pull!.checks[0]!.state = "failure"; f.evidence = coding(nextHead);
  const row = await follow(f, selected.id), held = await f.service.tick(row.id);
  expect(held.state).toBe("waiting_owner"); const push = f.f.service.owner.inspect(f.f.owner, held.action!).action;
  expect(push.operation).toBe("push"); approve(f, push);
  const handler = createGithubHandler(f.service, { origin: "http://jit.invalid", cookieName: "owner", authentication: {
    authenticate() { return { actor: f.f.owner, csrf: "csrf" }; }, verifyCsrf(expected, supplied) { expect(supplied).toBe(expected); },
  }, resolveWork(owner, workId) { f.f.service.owner.current(owner); return f.f.service.control.bindWork(workId); } });
  const response = await handler(new Request(`http://jit.invalid/s15/github/work/${f.work.receipt.work!.id}/dispatch`, { method: "POST", headers: { cookie: "owner=session", origin: "http://jit.invalid", "x-csrf-token": "csrf", "content-type": "application/json" }, body: JSON.stringify({ action: held.action }) }));
  expect(response.status).toBe(200); expect((await response.json()).outcome).toBe("succeeded");
  f.protocol.green(); f.advance(11); const ready = await f.service.tick(row.id);
  expect(ready.state).toBe("waiting_owner"); expect(ready.action).not.toEqual(held.action);
  expect(f.f.service.owner.inspect(f.f.owner, ready.action!).action.operation).toBe("merge");
  expect(f.counts.implementations).toBe(2); expect(f.counts.liveVm).toBe(0);
  approve(f, f.f.service.owner.inspect(f.f.owner, ready.action!).action); f.advance(11);
  expect((await f.service.tick(row.id)).state).toBe("merged");
});

for (const state of ["closed", "merged"] as const) test(`historical ${state} PR keeps its recorded base after the target advances`, async () => {
  const f = setup(), selected = await f.publish(); f.protocol.green(); const row = await follow(f, selected.id);
  f.protocol.value.pull!.state = state; f.protocol.value.base = "d".repeat(40); f.protocol.bump();
  expect(() => snapshot(f.protocol.value, repo, f.f.now, f.limits.snapshotMaxAgeMs)).not.toThrow();
  expect(f.protocol.value.pull!.base).toBe(base);
  expect(await f.service.project(f.f.owner, f.work.actor!, row.id)).toMatchObject({ head });
  expect((await f.service.tick(row.id)).state).toBe(state === "merged" ? "merged" : "stopped");
  f.protocol.value.pull!.state = "open";
  expect(() => snapshot(f.protocol.value, repo, f.f.now, f.limits.snapshotMaxAgeMs)).toThrow("github_protocol_invalid");
});

test("verified external merge completes WORK before making the GitHub row terminal", async () => {
  const f = setup(), selected = await f.publish(); f.protocol.green(); f.protocol.value.pull!.reviews = [];
  const row = await follow(f, selected.id); expect((await f.service.tick(row.id)).state).toBe("waiting_review");
  f.reopen(); f.protocol.value.pull!.state = "merged"; f.protocol.bump(); f.advance(11);
  expect((await f.service.tick(row.id)).state).toBe("merged");
  expect(f.responsibilities.project(f.f.owner, row.responsibilityId)).toMatchObject({ state: "completed" });
  expect(f.settlements.at(-1)).toMatchObject({ basis: "remote_verified", transportSettled: true, executionSettled: true, effects: "known", complete: true });
  const attempts = f.counts.attempts; await f.service.tick(row.id); expect(f.counts.attempts).toBe(attempts);
  expect(f.protocol.calls.filter(c => c.operation.kind === "merge")).toHaveLength(0); expect(f.counts.implementations).toBe(1);
});
