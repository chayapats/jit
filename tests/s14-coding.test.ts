import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S14Application } from "../src/s14/application";
import { S14Store } from "../src/s14/store";
import type { CodingCheck, CodingCommand } from "../src/s14/coding-types";
import { createS14Handler } from "../src/s14/web";
import { CodingRuntimeFixture, codingScript } from "./fixtures/s14-coding";
import { barrier } from "./fixtures/s14-computer";

const rid = () => crypto.randomUUID().replaceAll("-", "");
const roots: string[] = [], stores: S14Store[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(root => rmSync(root, { force: true, recursive: true })); });
const check: CodingCheck = { argv: ["sh", "-c", 'test "$(cat answer.txt)" = fixed && printf "actual-test-output"'], timeoutMs: 1000, network: "none", coverage: "answer fixture assertion" };
async function fixture(edit = true) {
  const root = mkdtempSync(join(tmpdir(), "s14-coding-")); roots.push(root);
  const runtime = new CodingRuntimeFixture(); roots.push(runtime.root);
  const baseCommit = await runtime.seed();
  const store = new S14Store(join(root, "app.sqlite")); stores.push(store);
  let path = "";
  const clock = { now: 1800000000000 };
  const policy = { routes: [{ id: "selected", provider: "codex" as const, model: "scripted" }], tools: ["computer", "coding", "effect_push"], resources: ["repo"] };
  const options = { policy, chat: { async reply() { return { text: "No grant" }; } }, now: () => clock.now, computers: { runtime }, coding: { model: codingScript(() => path, edit) } };
  const app = new S14Application(store, options);
  await app.provisionOwner("coding-fixture-owner-password");
  const token = await app.login("coding-fixture-owner-password"), auth = app.authenticate(token);
  const setup = app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: 0,
    payload: { ownerName: "Owner", language: "th", routeId: "selected", capabilities: { tools: policy.tools, resources: ["repo"] } } });
  const grant: CodingCommand = { kind: "coding.repository.grant", requestId: rid(), expectedRevision: 0,
    payload: { id: "repo", botId: "jit", url: "https://github.com/fixture/repo.git", baseCommit } };
  app.execute(auth.actor, grant);
  function start(tests = [check], install: CodingCheck | null = null) {
    const command: CodingCommand = { kind: "coding.start", requestId: rid(), expectedRevision: app.conversation(auth.actor, setup.conversation!.id).conversation.revision,
      payload: { repository: { id: "repo", revision: 1 }, tests, install, work: { conversationId: setup.conversation!.id, task: null,
        title: "Repair fixture", purpose: "Repair generated repository", completionRule: "Owner review of actual diff and tests", bots: [{ id: "jit", revision: 1 }],
        tools: ["computer", "coding"], scopes: [{ kind: "resource", id: "repo", revision: 1 }],
        limits: { attempts: 2, steps: 2, calls: 256, outputBytes: 65536, wallMs: 3600000, concurrency: 1, reads: 1 }, expiresAt: clock.now + 3600000 } } };
    const receipt = app.execute(auth.actor, command);
    path = `/workspace/coding/${receipt.work!.id}`;
    const attempt = app.authority.admit(receipt.work!.id, rid(), { botId: "jit", tools: ["computer", "coding"], scopes: [{ kind: "resource", id: "repo", revision: 1 }], input: "Repair answer", calls: 256, outputBytes: 65536 });
    return { command, receipt, attempt };
  }
  return { root, runtime, store, app, auth, token, clock, options, grant, start };
}

test("typed repository resource and scripted edit produce actual immutable diff/check artifacts with no effects", async () => {
  const f = await fixture(), { attempt, command, receipt } = f.start();
  expect(f.app.execute(f.auth.actor, command)).toEqual(receipt);
  const output = await f.app.coding.run(join(f.root, "native"), attempt, new AbortController().signal);
  f.app.authority.commit(attempt.id, output);
  const view = f.app.coding.view(f.auth.actor, attempt.workId), run = view.runs[0]!;
  expect(run.state).toBe("reviewable");
  expect(run.headCommit).toMatch(/^[a-f0-9]{40}$/);
  expect(run.baseCommit).not.toBe(run.headCommit);
  const report = f.app.reports.view(f.auth.actor, run.reportId!);
  if (report.state !== "available") throw new Error("Report unavailable");
  expect(report.report.state).toBe("ready_for_review");
  const artifacts = report.artifacts.map(a => new TextDecoder().decode(f.app.artifacts.download(f.auth.actor, a.id).bytes));
  expect(artifacts.some(content => content.includes("-broken") && content.includes("+fixed"))).toBe(true);
  expect(artifacts.some(content => content.includes("actual-test-output") && content.includes('"state":"passed"'))).toBe(true);
  expect(f.app.authority.view(f.auth.actor, attempt.workId).effects).toEqual([]);
  expect(existsSync(join(f.runtime.root, "hook-ran"))).toBe(false);
  expect(JSON.stringify(f.runtime.requests)).not.toMatch(/coding-fixture-owner-password|github_pat_|vault|JIT_/);
  await expect(f.app.coding.run(join(f.root, "native"), attempt, new AbortController().signal)).rejects.toThrow("coding_never_replay");
});

test.each(["failed", "skipped", "registry"])("model done cannot hide %s verification", async mode => {
  const f = await fixture(false);
  const { attempt } = mode === "skipped" ? f.start([]) : mode === "registry" ? f.start([check], { ...check, network: "registry" }) : f.start();
  const output = await f.app.coding.run(join(f.root, "native"), attempt, new AbortController().signal);
  f.app.authority.commit(attempt.id, output);
  const view = f.app.coding.view(f.auth.actor, attempt.workId);
  expect(view.runs[0]!.state).toBe("partial");
  expect(view.runs[0]!.reason).toBe(mode === "skipped" ? "coding_tests_not_run" : mode === "registry" ? "coding_egress_scope_unavailable" : "coding_check_failed");
  if (mode === "registry") expect(f.runtime.requests.filter((r: any) => r.op === "spawn" && r.command.includes("actual-test-output"))).toHaveLength(0);
});

test("path aliases and symlink repository roots are refused before code execution", async () => {
  const f = await fixture(), { attempt } = f.start();
  f.runtime.escape = "/workspace/repositories/repo";
  await expect(f.app.coding.run(join(f.root, "native"), attempt, new AbortController().signal)).rejects.toThrow("coding_path_refused");
  expect(f.runtime.requests.some((r: any) => r.op === "spawn")).toBe(false);
});

test("test modifications stay partial and bound to the tested commit", async () => {
  const f = await fixture(), { attempt } = f.start([{ ...check, argv: ["sh", "-c", "printf mutation > answer.txt"] }]);
  f.app.authority.commit(attempt.id, await f.app.coding.run(join(f.root, "native"), attempt, new AbortController().signal));
  expect(f.app.coding.view(f.auth.actor, attempt.workId).runs[0]).toMatchObject({ state: "partial", reason: "coding_changed_during_tests" });
});

test("stop at runtime barrier fences late evidence and boot never replays coding", async () => {
  const f = await fixture(), { attempt } = f.start(), gate = barrier();
  f.runtime.beforeExec = gate;
  const running = f.app.coding.run(join(f.root, "native"), attempt, new AbortController().signal);
  await gate.reached;
  const work = f.app.authority.view(f.auth.actor, attempt.workId).work;
  f.app.execute(f.auth.actor, { kind: "work.stop", requestId: rid(), expectedRevision: work.revision, payload: { workId: work.id } });
  gate.release();
  await expect(running).rejects.toThrow();
  expect(f.app.reports.list(f.auth.actor, work.id)).toHaveLength(0);
  expect(f.app.coding.view(f.auth.actor, work.id).runs[0]!.state).toBe("interrupted");
  const count = f.runtime.requests.length;
  new S14Application(f.store, f.options);
  expect(f.runtime.requests).toHaveLength(count);
});

test("owner authentication, resource revocation, exact retry and HTTP query share existing authority", async () => {
  const f = await fixture(), { attempt, command } = f.start();
  expect(() => f.app.execute({ ownerId: "owner" }, command)).toThrow("authentication_required");
  expect(() => f.app.execute(f.auth.actor, { ...command, expectedRevision: 20 })).toThrow("request_id_conflict");
  const handler = createS14Handler(f.app, "http://localhost:3001");
  const response = await handler(new Request(`http://localhost:3001/api/s14/work/${attempt.workId}/coding`, { headers: { cookie: `jit_s14=${f.token}` } }));
  expect(response.status).toBe(200);
  expect((await response.json()).job.repository.id).toBe("repo");
  f.app.execute(f.auth.actor, { kind: "coding.repository.revoke", requestId: rid(), expectedRevision: 1, payload: { repositoryId: "repo" } });
  await expect(f.app.coding.run(join(f.root, "native"), attempt, new AbortController().signal)).rejects.toThrow("scope_revoked_or_stale");
});
