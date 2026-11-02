import { afterEach, expect, test } from "bun:test";
import type { ResponsibilityProjection } from "../src/s15/work/index";
import { base, coding, githubFixture, head, nextHead, type GithubFixture } from "./fixtures/s15-github";

const fixtures: GithubFixture[] = [];
const setup = () => { const f = githubFixture("personal"); fixtures.push(f); return f; };
afterEach(() => fixtures.splice(0).forEach(f => f.cleanup()));
const follow = (f: GithubFixture, selectionId: string) => f.service.babysit(f.f.owner, f.work.actor!, { requestId: "follow", sourceRequestId: "chat_root", selectionId, pull: 1, reserveCalls: 2 });

test("real WORK: assign -> CI/review waits -> settled remediation -> restart wait -> verified merge", async () => {
  const f = setup(), selected = await f.publish(), row = await follow(f, selected.id);
  const work = () => f.responsibilities.project(f.f.owner, row.responsibilityId);
  expect(work()).toMatchObject({ sourceRequestId: "chat_root", workId: selected.workId, state: "ready", attempts: [] });
  expect((await f.service.tick(row.id)).state).toBe("waiting_ci");
  expect(work()).toMatchObject({ state: "waiting", wait: { kind: "ci" }, stopImpact: { heldAttempts: [] } });
  f.protocol.green(); f.protocol.value.pull!.reviews = []; f.advance(11);
  expect((await f.service.tick(row.id)).state).toBe("waiting_review"); expect(work().wait?.kind).toBe("review");
  f.protocol.value.pull!.reviews = [{ id: "finding_1", author: "reviewer", head, base, state: "changes_requested", resolved: false, codeOwner: false, body: "Repair the selected behavior while preserving its checks.", source: { ref: "github:review_finding", observedAt: 1000 } }];
  f.protocol.bump(); f.evidence = coding(nextHead); f.advance(11);
  expect((await f.service.tick(row.id)).state).toBe("active");
  expect(work()).toMatchObject({ state: "waiting", wait: { kind: "ci" }, attempts: [{ state: "settled", capacityHeld: false, transportSettled: true, executionSettled: true, effects: "known" }] });
  expect(f.counts.implementations).toBe(2); expect(f.counts.liveVm).toBe(0);
  f.reopen(); expect(work().resumedAfterRestart).toBe(true);
  f.protocol.green(); f.advance(11); expect((await f.service.tick(row.id)).state).toBe("merged");
  expect(work()).toMatchObject({ state: "completed", workId: selected.workId, stopImpact: { heldAttempts: [] } });
  expect(work().attempts).toHaveLength(2); expect(work().attempts.every(a => a.state === "settled")).toBe(true);
  const view = await f.service.project(f.f.owner, f.work.actor!, row.id) as { responsibility: ResponsibilityProjection; evidence: { id: string; value: unknown }[] };
  expect(view.evidence.length).toBeGreaterThan(0); expect(view.evidence.every(e => e.value !== null)).toBe(true);
  expect(view.responsibility.attempts.flatMap(a => a.evidenceRefs).every(ref => /^[A-Za-z0-9_-]+$/.test(ref))).toBe(true);
});

test("real WORK: external verified historical merge completes without issuing a merge or warming a VM", async () => {
  const f = setup(), selected = await f.publish(), row = await follow(f, selected.id);
  await f.service.tick(row.id); f.reopen();
  f.protocol.value.pull!.state = "merged"; f.protocol.value.base = "d".repeat(40); f.protocol.bump(); f.advance(11);
  expect((await f.service.tick(row.id)).state).toBe("merged");
  expect(f.responsibilities.project(f.f.owner, row.responsibilityId)).toMatchObject({ state: "completed", attempts: [{ state: "settled", capacityHeld: false, effects: "known" }] });
  expect(f.settlements.at(-1)).toMatchObject({ basis: "remote_verified", complete: true });
  expect(await f.service.project(f.f.owner, f.work.actor!, row.id)).toMatchObject({ base, targetHead: "d".repeat(40) });
  expect(f.protocol.calls.filter(c => c.operation.kind === "merge")).toHaveLength(0); expect(f.counts.implementations).toBe(1); expect(f.counts.liveVm).toBe(0);
});

test("real WORK: unknown merge reconciles to completed while the old publication fence remains", async () => {
  const f = setup(), selected = await f.publish(); f.protocol.green(); const row = await follow(f, selected.id);
  f.protocol.failAfterSend = true; expect((await f.service.tick(row.id)).state).toBe("reconcile_only");
  const sends = f.protocol.calls.length; f.reopen();
  expect((await f.service.reconcile(f.f.owner, f.work.actor!, row.id, "verified_readback")).state).toBe("merged");
  expect(f.responsibilities.project(f.f.owner, row.responsibilityId)).toMatchObject({ state: "completed", attempts: [{ state: "settled", publicationFenced: true, reconciliation: { basis: "remote_verified", complete: true } }] });
  expect(f.protocol.calls).toHaveLength(sends);
});

test("real WORK: no-progress pause cannot resume from the original owner instruction", async () => {
  const f = setup(), selected = await f.publish(); f.protocol.green(); f.protocol.value.pull!.checks[0]!.state = "failure";
  const row = await follow(f, selected.id); await f.service.tick(row.id); f.advance(11); await f.service.tick(row.id);
  expect(f.responsibilities.project(f.f.owner, row.responsibilityId)).toMatchObject({ state: "paused", report: { code: "no_progress" } });
  expect(() => f.responsibilities.resume(f.f.owner, row.responsibilityId, "chat_root")).toThrow("fresh_instruction_required");
  const attempts = f.counts.attempts; f.protocol.green(); f.advance(11); expect((await f.service.tick(row.id)).state).toBe("stalled");
  expect(f.counts.attempts).toBe(attempts);
});
