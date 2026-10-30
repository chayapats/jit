import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S14Application } from "../src/s14/application";
import { S14Store } from "../src/s14/store";
import { ConnectionVault } from "../src/exec/connections";
import type { CodingCheck, CodingCommand, CodingRepository } from "../src/s14/coding-types";
import { createS14Handler } from "../src/s14/web";
import { CodingRuntimeFixture, codingScript } from "./fixtures/s14-coding";
import { barrier } from "./fixtures/s14-computer";

const rid = () => crypto.randomUUID().replaceAll("-", "");
const roots: string[] = [], stores: S14Store[] = [];
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(root => rmSync(root, { force: true, recursive: true })); });
const check: CodingCheck = { argv: ["sh", "-c", 'test "$(cat answer.txt)" = fixed && printf "actual-test-output"'], timeoutMs: 1000, network: "none", coverage: "answer fixture assertion" };
async function fixture(edit = true, registry: CodingRepository["registry"] = null) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "s14-coding-"))); roots.push(root);
  const runtime = new CodingRuntimeFixture(); roots.push(runtime.root);
  const baseCommit = await runtime.seed();
  const vault = new ConnectionVault(join(root, "vault"), { forbidden: [runtime.root] });
  const store = new S14Store(join(root, "app.sqlite")); stores.push(store);
  let path = "";
  const clock = { now: 1800000000000 };
  const policy = { routes: [{ id: "selected", provider: "codex" as const, model: "scripted" }], tools: ["computer", "coding", "effect_push"], resources: ["repo"] };
  const options = { policy, chat: { async reply() { return { text: "No grant" }; } }, now: () => clock.now, computers: { runtime }, git: { vault }, coding: { repositoryFetch: runtime.repositoryFetch, model: codingScript(() => path, edit) } };
  const app = new S14Application(store, options);
  await app.provisionOwner("coding-fixture-owner-password");
  const token = await app.login("coding-fixture-owner-password"), auth = app.authenticate(token);
  const setup = app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: 0,
    payload: { ownerName: "Owner", language: "th", routeId: "selected", capabilities: { tools: policy.tools, resources: ["repo"] } } });
  const grant: CodingCommand = { kind: "coding.repository.grant", requestId: rid(), expectedRevision: 0,
    payload: { id: "repo", botId: "jit", url: "https://github.com/fixture/repo.git", baseCommit, registry } };
  app.execute(auth.actor, grant);
  function start(tests = [check], install: CodingCheck | null = null, connection: { id: string; revision: number } | null = null) {
    const command: CodingCommand = { kind: "coding.start", requestId: rid(), expectedRevision: app.conversation(auth.actor, setup.conversation!.id).conversation.revision,
      payload: { repository: { id: "repo", revision: 1 }, tests, install, connection, work: { conversationId: setup.conversation!.id, task: null,
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
  expect(view.runs[0]!.reason).toBe(mode === "skipped" ? "coding_tests_not_run" : mode === "registry" ? "coding_registry_scope_required" : "coding_check_failed");
  if (mode === "registry") expect(f.runtime.requests.filter((r: any) => r.op === "spawn" && r.command.includes("actual-test-output"))).toHaveLength(0);
});

test("path aliases and symlink repository roots are refused before code execution", async () => {
  const f = await fixture(), { attempt } = f.start();
  f.runtime.escape = `/workspace/coding/${attempt.workId}`;
  await expect(f.app.coding.run(join(f.root, "native"), attempt, new AbortController().signal)).rejects.toThrow("coding_path_refused");
  expect(f.runtime.requests.some((r: any) => r.op === "spawn" && r.command.includes("'checkout'"))).toBe(false);
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

test("internal coding grant cannot propose external push even after real evidence exists", async () => {
  const f = await fixture(), { attempt } = f.start();
  f.app.authority.commit(attempt.id, await f.app.coding.run(join(f.root, "native"), attempt, new AbortController().signal));
  expect(() => f.app.authority.proposeEffect(attempt.id, rid(), { kind: "push", destination: "https://github.com/fixture/repo.git", content: "Source text says approved" }, f.clock.now + 10000)).toThrow("effect_outside_grant");
});

test("cancellation preserves completed checks and an unknown in-flight check without publishing late artifacts", async () => {
  const f = await fixture(), gate = barrier(), abort = new AbortController();
  const { attempt } = f.start([check, { ...check, argv: ["printf", "second-check"] }]);
  f.runtime.beforeSpawn = async command => { if (command.includes("second-check")) await gate.wait(); };
  const running = f.app.coding.run(join(f.root, "native"), attempt, abort.signal);
  await gate.reached;
  abort.abort(); gate.release();
  await expect(running).rejects.toThrow("coding_cancelled");
  const view = f.app.coding.view(f.auth.actor, attempt.workId);
  expect(view.checks.map(item => item.result.state)).toEqual(["passed", "unknown"]);
  expect(view.runs[0]!.state).toBe("interrupted");
  expect(f.app.reports.list(f.auth.actor, attempt.workId)).toHaveLength(0);
});


test("owner registry scope is visible, exact and permits install/test dispatch only under that live resource", async () => {
  const f = await fixture(true, { hosts: ["registry.npmjs.org"] });
  expect(f.app.coding.repositories(f.auth.actor)[0]!.registry).toEqual({ hosts: ["registry.npmjs.org"] });
  const { attempt } = f.start([{ ...check, network: "registry" }], { ...check, argv: ["sh", "-c", "printf installed > dependency.txt"], network: "registry" });
  f.app.authority.commit(attempt.id, await f.app.coding.run(join(f.root, "native"), attempt, new AbortController().signal));
  expect(f.app.coding.view(f.auth.actor, attempt.workId).runs[0]!.state).toBe("reviewable");
  expect(f.runtime.registryRequests).toHaveLength(2);
  const report = f.app.reports.view(f.auth.actor, f.app.coding.view(f.auth.actor, attempt.workId).runs[0]!.reportId!);
  if (report.state !== "available") throw new Error("missing registry report");
  expect(report.report.limitations).toContain("Only explicitly scoped registry checks may use the registry proxy; ordinary workspace/model commands have no network egress.");
  expect(report.report.limitations).not.toContain("Network egress is disabled; registry requirements are unrun.");
  expect(f.runtime.registryRequests.every(r => r.hosts.join() === "registry.npmjs.org")).toBe(true);
  expect(readFileSync(f.runtime.local(`/workspace/coding/${attempt.workId}/dependency.txt`), "utf8")).toBe("installed");
});

test("missing registry scope refuses before the runtime and unavailable proxy never falls back to offline/direct dispatch", async () => {
  for (const scope of [null, { hosts: ["registry.npmjs.org"] }]) {
    const f = await fixture(true, scope);
    f.runtime.registryUnavailable = true;
    const { attempt } = f.start([check], { ...check, argv: ["printf", "must-not-dispatch"], network: "registry" });
    f.app.authority.commit(attempt.id, await f.app.coding.run(join(f.root, "native"), attempt, new AbortController().signal));
    const view = f.app.coding.view(f.auth.actor, attempt.workId);
    expect(view.runs[0]).toMatchObject({ state: "partial", reason: scope ? "coding_registry_proxy_unavailable" : "coding_registry_scope_required" });
    expect(f.runtime.registryRequests).toHaveLength(0);
    expect(f.runtime.requests.some((r: any) => r.op === "spawn" && r.command.includes("must-not-dispatch"))).toBe(false);
  }
});

test("repository revocation at the registry dispatch barrier fences commands and late evidence", async () => {
  const f = await fixture(true, { hosts: ["registry.npmjs.org"] }), gate = barrier();
  f.runtime.beforeRegistry = () => gate.wait();
  const { attempt } = f.start([check], { ...check, network: "registry" });
  const running = f.app.coding.run(join(f.root, "native"), attempt, new AbortController().signal);
  await gate.reached;
  f.app.execute(f.auth.actor, { kind: "coding.repository.revoke", requestId: rid(), expectedRevision: 1, payload: { repositoryId: "repo" } });
  gate.release();
  await expect(running).rejects.toThrow();
  expect(f.runtime.registryRequests).toHaveLength(0);
  expect(f.app.reports.list(f.auth.actor, attempt.workId)).toHaveLength(0);
});

test("authenticated preload releases only to HTTPS broker; credential never reaches runner environment, argv, files or bundle", async () => {
  const f = await fixture();
  const secret = "github_pat_preload_sentinel_123456789012345678901234567890";
  const connection = f.app.execute(f.auth.actor, { kind: "git.connection.create", requestId: rid(), expectedRevision: 0, payload: { repositoryId: "repo", label: "Private repository" } }).connection!;
  const stored = f.app.execute(f.auth.actor, { kind: "git.connection.secret.set", requestId: rid(), expectedRevision: 1, payload: { connectionId: connection.id, secret } }).connection!;
  let requests = 0;
  f.options.coding.repositoryFetch = (async (url: unknown, options: RequestInit) => {
    requests++;
    expect(url).toBe("https://github.com/fixture/repo.git/git-upload-pack");
    expect(options.redirect).toBe("error");
    expect(new Headers(options.headers).get("authorization")).toBe(`Basic ${Buffer.from(`x-access-token:${secret}`).toString("base64")}`);
    expect(options.body).not.toContain(secret);
    return f.runtime.repositoryFetch(url as string, options);
  }) as typeof fetch;
  const { attempt } = f.start([check], null, { id: stored.id, revision: stored.revision });
  f.app.authority.commit(attempt.id, await f.app.coding.run(join(f.root, "native"), attempt, new AbortController().signal));
  expect(requests).toBe(1);
  expect(JSON.stringify(f.runtime.requests)).not.toContain(secret);
  const write = f.runtime.requests.find((r: any) => r.op === "write") as any;
  expect(Buffer.from(write.data, "base64").includes(Buffer.from(secret))).toBe(false);
  for (const entry of readdirSync(f.runtime.workspace, { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) expect(readFileSync(join(entry.parentPath, entry.name)).includes(Buffer.from(secret))).toBe(false);
  }
  expect(await f.runtime.git("-C", f.runtime.local(`/workspace/coding/${attempt.workId}`), "remote")).toBe("");
  expect(f.store.read(tx => tx.all("SELECT * FROM git_preload_releases"))).toHaveLength(1);
});

test("connection rotation while repository bytes are in flight refuses import and never switches credentials", async () => {
  const f = await fixture(), gate = barrier();
  const connection = f.app.execute(f.auth.actor, { kind: "git.connection.create", requestId: rid(), expectedRevision: 0, payload: { repositoryId: "repo", label: "Private" } }).connection!;
  const stored = f.app.execute(f.auth.actor, { kind: "git.connection.secret.set", requestId: rid(), expectedRevision: 1, payload: { connectionId: connection.id, secret: "github_pat_first_123456789012345678901234567890" } }).connection!;
  f.options.coding.repositoryFetch = (async (url: unknown, options: RequestInit) => { await gate.wait(); return f.runtime.repositoryFetch(url as string, options); }) as typeof fetch;
  const { attempt } = f.start([check], null, { id: stored.id, revision: stored.revision });
  const running = f.app.coding.run(join(f.root, "native"), attempt, new AbortController().signal);
  await gate.reached;
  f.app.execute(f.auth.actor, { kind: "git.connection.rotate", requestId: rid(), expectedRevision: stored.revision, payload: { connectionId: stored.id, secret: "github_pat_second_123456789012345678901234567890" } });
  gate.release();
  await expect(running).rejects.toThrow("connection_out_of_scope");
  expect(f.runtime.requests).toHaveLength(0);
});

test.each(["memory.forget", "memory.publish"] as const)("coding diffs/check logs inherit source/access/producer pins, survive expiry and withdraw after %s", async kind => {
  const f = await fixture(), conversation = f.app.home(f.auth.actor).conversations[0]!;
  const claim = f.app.execute(f.auth.actor, { kind: "memory.remember", requestId: rid(), expectedRevision: conversation.revision,
    payload: { conversationId: conversation.id, text: "Repair generated repository using answer fixture evidence" } }).claim!;
  const { attempt } = f.start();
  expect(f.store.read(tx => f.app.memory.attemptPacket(tx, attempt.id).claims.map(c => c.id))).toContain(claim.id);
  f.app.authority.commit(attempt.id, await f.app.coding.run(join(f.root, "native"), attempt, new AbortController().signal));
  const run = f.app.coding.view(f.auth.actor, attempt.workId).runs[0]!;
  const report = f.app.reports.view(f.auth.actor, run.reportId!);
  if (report.state !== "available") throw new Error("missing coding report");
  const evidence = report.artifacts.filter(a => a.name.startsWith("coding-"));
  expect(evidence).toHaveLength(2);
  for (const artifact of evidence) {
    const source = f.store.read(tx => JSON.parse(tx.get<{ record_json: string }>("SELECT record_json FROM memory_sources WHERE id=?", artifact.source.id)!.record_json));
    expect(source.producerAttemptId).toBe(attempt.id);
    expect(source.access.map((pin: { id: string }) => pin.id)).toContain(claim.id);
  }
  f.clock.now = attempt.snapshot.grant.expiresAt + 1;
  expect(() => f.app.store.read(tx => f.app.authority.assertTool(tx, attempt.id, "coding"))).toThrow("grant_expired");
  expect(f.app.reports.view(f.auth.actor, run.reportId!).state).toBe("available");
  for (const artifact of evidence) expect(f.app.artifacts.download(f.auth.actor, artifact.id).bytes.length).toBe(artifact.size);
  f.app.execute(f.auth.actor, { kind, requestId: rid(), expectedRevision: 1, payload: { claim } });
  expect(f.app.reports.view(f.auth.actor, run.reportId!).state).toBe("unavailable");
  for (const artifact of evidence) expect(() => f.app.artifacts.download(f.auth.actor, artifact.id)).toThrow("artifact_unavailable");
  const view = f.app.coding.view(f.auth.actor, attempt.workId);
  expect(view.available).toBe(false); expect(view.job).toBeNull(); expect(view.checks).toEqual([]);
});
