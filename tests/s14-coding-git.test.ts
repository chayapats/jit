import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S14Application } from "../src/s14/application";
import { S14Store } from "../src/s14/store";
import { ConnectionVault } from "../src/exec/connections";
import { canonical, digest } from "../src/s14/validation";
import type { Effect } from "../src/s14/authority-types";
import type { GitAction, GitCommand, GitOptions, GitRemotePort, GitRemoteProof } from "../src/s14/coding-git-types";
import { CodingGitMirror } from "../src/s14/coding-git-mirror";
import { GitHubCodingRemote } from "../src/s14/coding-git-remote";
import { createS14Handler } from "../src/s14/web";
import { CodingRuntimeFixture, codingScript } from "./fixtures/s14-coding";

const roots: string[] = [], stores: S14Store[] = [];
const rid = () => crypto.randomUUID().replaceAll("-", "");
const secret = "fixture-git-token-for-trusted-broker-only";
afterEach(() => { stores.splice(0).forEach(s => s.close()); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });
class RemoteFixture implements GitRemotePort {
  head: string | null = null;
  base = "";
  prs: GitRemoteProof["prs"] = [];
  pushes: GitAction[] = [];
  creates: GitAction[] = [];
  reads = 0;
  pushOutcome: "succeeded" | "failed" | "unknown" = "succeeded";
  prOutcome: "succeeded" | "failed" | "unknown" = "succeeded";
  incomplete = false;
  mutateAction = false;
  async push(mirror: string, action: GitAction, token: string, allowed: () => void) {
    expect(token).toBe(secret);
    expect(mirror).not.toContain("workspace");
    expect(readFileSync(join(mirror, "config"), "utf8")).not.toMatch(/credential|hooksPath|include|evil/);
    expect(existsSync(join(mirror, "hooks", "pre-push"))).toBe(false);
    if (this.mutateAction) action.update.ref = "refs/heads/changed";
    allowed();
    this.pushes.push(structuredClone(action));
    if (this.pushOutcome !== "failed") this.head = action.headCommit;
    return this.pushOutcome;
  }
  async createPr(action: GitAction, token: string, allowed: () => void) {
    expect(token).toBe(secret);
    allowed();
    this.creates.push(structuredClone(action));
    if (this.prOutcome !== "failed") this.prs.push({ number: 17, headCommit: action.headCommit, baseCommit: action.pr!.baseCommit,
      head: action.update.ref.slice(11), base: action.pr!.base, title: action.pr!.title, body: action.pr!.body, draft: action.pr!.draft });
    return { outcome: this.prOutcome, number: this.prOutcome === "succeeded" ? 17 : null };
  }
  async readBack(_action: GitAction, token: string, allowed: () => void) {
    expect(token).toBe(secret);
    allowed();
    this.reads++;
    return { headCommit: this.head, baseCommit: this.base, prs: structuredClone(this.prs), complete: !this.incomplete };
  }
}
async function fixture(afterStage?: GitOptions["afterStage"]) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "s14-git-"))); roots.push(root);
  const runtime = new CodingRuntimeFixture(); roots.push(runtime.root);
  const base = await runtime.seed();
  const remote = new RemoteFixture(); remote.base = base;
  const store = new S14Store(join(root, "state", "app.sqlite")); stores.push(store);
  const vault = new ConnectionVault(join(root, "vault"), { forbidden: [join(root, "state"), runtime.root] });
  let path = "";
  const clock = { now: 1800000000000 };
  const policy = { routes: [{ id: "route", provider: "codex" as const, model: "scripted" }], tools: ["computer", "coding", "effect_push"], resources: ["repo", "other"] };
  const options = { policy, now: () => clock.now, chat: { async reply() { return { text: "No authority" }; } }, computers: { runtime },
    coding: { model: codingScript(() => path) }, git: { vault, remote, ...(afterStage ? { afterStage } : {}) } };
  const app = new S14Application(store, options);
  await app.provisionOwner("git-fixture-owner-password");
  const token = await app.login("git-fixture-owner-password"), auth = app.authenticate(token);
  const setup = app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: 0,
    payload: { ownerName: "Owner", language: "th", routeId: "route", capabilities: { tools: policy.tools, resources: policy.resources } } });
  app.execute(auth.actor, { kind: "coding.repository.grant", requestId: rid(), expectedRevision: 0,
    payload: { id: "repo", botId: "jit", url: "https://github.com/fixture/repo.git", baseCommit: base } });
  const work = app.execute(auth.actor, { kind: "coding.start", requestId: rid(), expectedRevision: 1,
    payload: { repository: { id: "repo", revision: 1 }, install: null,
      tests: [{ argv: ["sh", "-c", 'test "$(cat answer.txt)" = fixed'], network: "none", timeoutMs: 1000, coverage: "fixture assertion" }],
      work: { conversationId: setup.conversation!.id, task: null, title: "Code", purpose: "Repair fixture", completionRule: "Owner review",
        bots: [{ id: "jit", revision: 1 }], tools: ["computer", "coding", "effect_push"], scopes: [{ kind: "resource", id: "repo", revision: 1 }],
        limits: { attempts: 2, steps: 2, calls: 256, outputBytes: 65536, wallMs: 3600000, concurrency: 1, reads: 1 }, expiresAt: clock.now + 3600000 } } }).work!;
  path = `/workspace/coding/${work.id}`;
  const attempt = app.authority.admit(work.id, rid(), { botId: "jit", tools: ["computer", "coding", "effect_push"], scopes: [{ kind: "resource", id: "repo", revision: 1 }], input: "Repair answer", calls: 256, outputBytes: 65536 });
  app.authority.commit(attempt.id, await app.coding.run(join(root, "native"), attempt, new AbortController().signal));
  const connection = app.execute(auth.actor, { kind: "git.connection.create", requestId: rid(), expectedRevision: 0, payload: { repositoryId: "repo", label: "GitHub fixture" } }).connection!;
  const secretCommand: GitCommand = { kind: "git.connection.secret.set", requestId: rid(), expectedRevision: connection.revision, payload: { connectionId: connection.id, secret } };
  const stored = app.execute(auth.actor, secretCommand).connection!;
  function propose(withPr = true) {
    const run = app.coding.view(auth.actor, work.id).runs[0]!;
    const command: GitCommand = { kind: "git.propose", requestId: rid(), expectedRevision: 0,
      payload: { attemptId: attempt.id, connection: { id: stored.id, revision: stored.revision }, update: { ref: "refs/heads/review", oldCommit: null, newCommit: run.headCommit! },
        pr: withPr ? { base: "main", baseCommit: base, title: "Exact reviewed change", body: "Exact PR body", draft: true } : null, expiresAt: clock.now + 1800000 } };
    const effect = app.execute(auth.actor, command).effect!;
    return { effect, command };
  }
  function approve(effect: Effect) {
    return app.execute(auth.actor, { kind: "approval.decide", requestId: rid(), expectedRevision: effect.revision,
      payload: { effectId: effect.id, actionHash: effect.actionHash, decision: "approve" } });
  }
  return { root, runtime, remote, store, app, options, auth, token, clock, base, vault, path, work, attempt, stored, secretCommand, propose, approve };
}

test("one exact approval verifies broker-owned objects, pushes once and creates only the exact PR", async () => {
  const f = await fixture(), { effect, command } = f.propose();
  expect(f.app.execute(f.auth.actor, command).effect).toEqual(effect);
  f.approve(effect);
  const result = await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash);
  expect(result.state).toBe("succeeded");
  expect(f.remote.pushes).toHaveLength(1);
  expect(f.remote.creates).toHaveLength(1);
  expect(f.remote.creates[0]!.pr).toMatchObject({ title: "Exact reviewed change", body: "Exact PR body", draft: true });
  expect(f.app.git.view(f.auth.actor, effect.id).progress).toMatchObject({ stage: "complete", verification: "remote_readback", pullNumber: 17 });
  await expect(f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).rejects.toThrow("stale_approval");
  expect(f.remote.pushes).toHaveLength(1);
  expect(JSON.stringify(f.runtime.requests)).not.toContain(secret);
  expect(readFileSync(f.store.path).includes(Buffer.from(secret))).toBe(false);
  expect(readFileSync(`${f.store.path}.lifecycle.sqlite`).includes(Buffer.from(secret))).toBe(false);
});

test("changed diff after approval refuses before credential release or remote dispatch", async () => {
  const f = await fixture(), { effect } = f.propose(); f.approve(effect);
  writeFileSync(join(f.runtime.local(f.path), "answer.txt"), "changed after review");
  expect((await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).state).toBe("failed");
  expect(f.app.git.view(f.auth.actor, effect.id).progress.reason).toBe("git_approved_diff_changed");
  expect(f.remote.pushes).toHaveLength(0);
  expect(f.store.read(tx => tx.all("SELECT * FROM git_connection_releases"))).toHaveLength(0);
});

test("late workspace changes after verification still refuse the approved push", async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(stage => { if (stage === "push_dispatching") writeFileSync(join(f.runtime.local(f.path), "answer.txt"), "late mutation"); });
  const { effect } = f.propose(); f.approve(effect);
  expect((await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).state).toBe("failed");
  expect(f.remote.pushes).toHaveLength(0);
});

test("box hook/config injection never reaches the authenticated mirror or process", async () => {
  const f = await fixture(), { effect } = f.propose();
  writeFileSync(join(f.runtime.local(f.path), ".git", "hooks", "pre-push"), `#!/bin/sh\ntouch '${f.runtime.root}/push-hook-ran'\n`, { mode: 0o755 });
  const config = join(f.runtime.local(f.path), ".git", "config");
  writeFileSync(config, readFileSync(config, "utf8") + '\n[credential]\n\thelper = !touch /tmp/evil-s14-hook\n');
  f.approve(effect);
  expect((await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).state).toBe("succeeded");
  expect(existsSync(join(f.runtime.root, "push-hook-ran"))).toBe(false);
});

test.each(["push", "pr"])("unknown %s is reconcile-only and read-back never repeats either mutation", async phase => {
  const f = await fixture();
  if (phase === "push") f.remote.pushOutcome = "unknown";
  else f.remote.prOutcome = "unknown";
  const { effect } = f.propose(phase !== "push"); f.approve(effect);
  expect((await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).state).toBe("unknown");
  await f.app.git.drain();
  expect(f.remote.pushes).toHaveLength(1);
  const current = f.app.authority.effect(f.auth.actor, effect.id).effect;
  const command: GitCommand = { kind: "git.reconcile", requestId: rid(), expectedRevision: current.revision, payload: { effectId: effect.id, actionHash: effect.actionHash } };
  f.app.execute(f.auth.actor, command);
  f.app.execute(f.auth.actor, command);
  await f.app.git.drain();
  expect(f.app.git.view(f.auth.actor, effect.id).effect.state).toBe("succeeded");
  expect(f.app.git.view(f.auth.actor, effect.id).progress.verification).toBe("remote_readback");
  expect(f.remote.pushes).toHaveLength(1);
  expect(f.remote.creates).toHaveLength(phase === "push" ? 0 : 1);
});

test("ambiguous or incomplete remote read-back keeps unknown and makes no mutation", async () => {
  const f = await fixture(); f.remote.prOutcome = "unknown";
  const { effect } = f.propose(); f.approve(effect);
  await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash);
  f.remote.prs.push({ ...f.remote.prs[0]!, number: 18 });
  f.app.execute(f.auth.actor, { kind: "git.reconcile", requestId: rid(), expectedRevision: 1, payload: { effectId: effect.id, actionHash: effect.actionHash } });
  await f.app.git.drain();
  expect(f.app.git.view(f.auth.actor, effect.id).effect.state).toBe("unknown");
  expect(f.remote.pushes).toHaveLength(1);
  expect(f.remote.creates).toHaveLength(1);
});

test("connection rotation and destination/approval substitution are refused", async () => {
  const f = await fixture(), { effect } = f.propose();
  expect(() => f.app.execute(f.auth.actor, { kind: "approval.decide", requestId: rid(), expectedRevision: 1,
    payload: { effectId: effect.id, actionHash: "0".repeat(64), decision: "approve" } })).toThrow("stale_approval");
  f.approve(effect);
  f.app.execute(f.auth.actor, { kind: "git.connection.rotate", requestId: rid(), expectedRevision: f.stored.revision,
    payload: { connectionId: f.stored.id, secret: "replacement-fixture-secret-value" } });
  expect((await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).state).toBe("failed");
  expect(f.remote.pushes).toHaveLength(0);
});

test("immutable proposal hash refuses a revised generic card even if another approval was obtained", async () => {
  const f = await fixture(), { effect } = f.propose();
  const action = JSON.parse(effect.action.content) as GitAction;
  action.update.ref = "refs/heads/other";
  const revised = f.app.authority.reviseEffect(f.attempt.id, effect.id, 1, { ...effect.action, content: canonical(action) }, effect.expiresAt);
  f.approve(revised);
  expect((await f.app.authority.runEffect(revised.id, revised.revision, revised.actionHash)).state).toBe("unknown");
  expect(f.remote.pushes).toHaveLength(0);
});

test("mutated transport arguments cannot cross the final authority guard", async () => {
  const f = await fixture(), { effect } = f.propose(); f.approve(effect);
  f.remote.mutateAction = true;
  expect((await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).state).toBe("unknown");
  expect(f.remote.pushes).toHaveLength(0);
});

test.each(["prepared", "push_dispatching", "pr_dispatching"])("restart at %s never dispatches an old claim", async stage => {
  const f = await fixture(), { effect } = f.propose(); f.approve(effect);
  f.store.transaction(tx => {
    const value = { ...effect, state: "executing" };
    tx.run("UPDATE effects SET record_json=? WHERE id=?", canonical(value), effect.id);
    tx.run("INSERT INTO lifecycle.withdrawals VALUES ('effect_claim',?,'revision_1')", effect.id);
    tx.run("UPDATE git_effects SET record_json=json_set(record_json,'$.stage',?) WHERE effect_id=?", stage, effect.id);
  });
  const reopened = new S14Application(f.store, f.options), actor = reopened.authenticate(f.token).actor;
  expect(reopened.authority.effect(actor, effect.id).effect.state).toBe("unknown");
  await reopened.git.drain();
  expect(f.remote.pushes).toHaveLength(0);
  expect(f.remote.creates).toHaveLength(0);
});

test("write-only secret retries, scoped metadata and HTTP commands never echo or hash a secret", async () => {
  const f = await fixture();
  const first = f.app.execute(f.auth.actor, f.secretCommand);
  expect(f.app.execute(f.auth.actor, { ...f.secretCommand, payload: { ...f.secretCommand.payload, secret: "different-fixture-value" } } as GitCommand)).toEqual(first);
  const receipt = f.store.read(tx => tx.get<{ result_json: string; payload_hash: string }>("SELECT result_json,payload_hash FROM command_receipts WHERE request_id=?", f.secretCommand.requestId))!;
  expect(JSON.stringify(receipt)).not.toContain(secret);
  expect(receipt.payload_hash).not.toBe(digest(canonical(f.secretCommand)));
  const handler = createS14Handler(f.app, "http://localhost:3001");
  const response = await handler(new Request("http://localhost:3001/api/s14/git/connections", { headers: { cookie: `jit_s14=${f.token}` } }));
  expect(response.status).toBe(200);
  expect(JSON.stringify(await response.json())).not.toContain(secret);
  const forbidden = await handler(new Request("http://localhost:3001/api/s14/commands", { method: "POST", headers: { cookie: `jit_s14=${f.token}`, origin: "http://localhost:3001", "content-type": "application/json" }, body: JSON.stringify(f.secretCommand) }));
  expect(forbidden.status).toBe(403);
});

test("object verification refuses invalid bundle data before any credential or transport", async () => {
  const mirror = new CodingGitMirror();
  try {
    await expect(mirror.import(new TextEncoder().encode("malicious bundle fixture"), { headCommit: "a".repeat(40) } as GitAction)).rejects.toThrow("git_objects_unverified");
    expect(() => mirror.verifiedPath()).toThrow("git_objects_unverified");
  } finally { mirror.close(); }
});

test("GitHub protocol fixes method/endpoint/body, refuses redirects and treats 5xx as unknown", async () => {
  const f = await fixture(), { effect } = f.propose(), action = JSON.parse(effect.action.content) as GitAction;
  const calls: { url: string; init: RequestInit }[] = [];
  const remote = new GitHubCodingRemote((async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ number: 9 }), { status: calls.length === 1 ? 201 : 502 });
  }) as typeof fetch);
  expect(await remote.createPr(action, secret, () => {})).toEqual({ outcome: "succeeded", number: 9 });
  expect(calls[0]!.url).toBe("https://api.github.com/repos/fixture/repo/pulls");
  expect(calls[0]!.init.redirect).toBe("error");
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ title: "Exact reviewed change", head: "review", base: "main", body: "Exact PR body", draft: true });
  expect((await remote.createPr(action, secret, () => {})).outcome).toBe("unknown");
});

test("approved diff and full head are independently verified against exported objects", async () => {
  const f = await fixture(), { effect } = f.propose(), action = JSON.parse(effect.action.content) as GitAction;
  const bundle = join(f.runtime.local(f.path), "fixture.bundle");
  const proc = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-C", f.runtime.local(f.path), "bundle", "create", bundle, "HEAD"], { stdout: "ignore", stderr: "ignore" });
  expect(await proc.exited).toBe(0);
  for (const changed of [{ ...action, headCommit: "b".repeat(40) }, { ...action, diffHash: "0".repeat(64) }]) {
    const mirror = new CodingGitMirror();
    try {
      await expect(mirror.import(readFileSync(bundle), changed)).rejects.toThrow(changed.headCommit !== action.headCommit ? "git_bundle_head_mismatch" : "git_approved_diff_changed");
    } finally { mirror.close(); }
  }
});

test("SQL protects committed coding identities and check outcomes consumed by approvals", async () => {
  const f = await fixture();
  expect(() => f.store.transaction(tx => tx.run("UPDATE coding_runs SET record_json=json_set(record_json,'$.headCommit',?) WHERE attempt_id=?", "f".repeat(40), f.attempt.id))).toThrow("immutable_coding_run");
  expect(() => f.store.transaction(tx => tx.run("UPDATE coding_checks SET record_json=json_set(record_json,'$.state','passed') WHERE attempt_id=?", f.attempt.id))).toThrow("immutable_coding_check");
});

test("a stale application image cannot repeat a claim or erase verified remote proof", async () => {
  const f = await fixture(), { effect } = f.propose(false); f.approve(effect);
  const old = f.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM effects WHERE id=?", effect.id))!.record_json;
  await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash);
  f.store.transaction(tx => tx.run("UPDATE effects SET record_json=? WHERE id=?", old, effect.id));
  const reopened = new S14Application(f.store, f.options), actor = reopened.authenticate(f.token).actor;
  expect(reopened.authority.effect(actor, effect.id).effect).toMatchObject({ state: "succeeded", reason: "verified_remote_readback" });
  await reopened.git.drain();
  expect(f.remote.pushes).toHaveLength(1);
});

test("resource and connection mismatch refuse before creating an approval", async () => {
  const f = await fixture();
  f.app.execute(f.auth.actor, { kind: "coding.repository.grant", requestId: rid(), expectedRevision: 0,
    payload: { id: "other", botId: "jit", url: "https://github.com/fixture/other.git", baseCommit: f.base } });
  const connection = f.app.execute(f.auth.actor, { kind: "git.connection.create", requestId: rid(), expectedRevision: 0, payload: { repositoryId: "other", label: "Other repository" } }).connection!;
  const scoped = f.app.execute(f.auth.actor, { kind: "git.connection.secret.set", requestId: rid(), expectedRevision: connection.revision, payload: { connectionId: connection.id, secret } }).connection!;
  const run = f.app.coding.view(f.auth.actor, f.work.id).runs[0]!;
  expect(() => f.app.execute(f.auth.actor, { kind: "git.propose", requestId: rid(), expectedRevision: 0,
    payload: { attemptId: f.attempt.id, connection: { id: scoped.id, revision: scoped.revision }, update: { ref: "refs/heads/review", oldCommit: null, newCommit: run.headCommit! }, pr: null, expiresAt: f.clock.now + 10000 } })).toThrow("connection_out_of_scope");
});

test("known PR rejection preserves the already pushed stage without retrying", async () => {
  const f = await fixture(); f.remote.prOutcome = "failed";
  const { effect } = f.propose(); f.approve(effect);
  expect((await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).state).toBe("failed");
  expect(f.app.git.view(f.auth.actor, effect.id).progress.reason).toBe("git_pr_rejected_after_push");
  expect(f.remote.head).not.toBe(null);
  await f.app.git.drain();
  expect(f.remote.pushes).toHaveLength(1);
  expect(f.remote.creates).toHaveLength(1);
});

test("stop after bundle verification fences the final broker dispatch", async () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(stage => {
    if (stage !== "push_dispatching") return;
    const work = f.app.authority.view(f.auth.actor, f.work.id).work;
    f.app.execute(f.auth.actor, { kind: "work.stop", requestId: rid(), expectedRevision: work.revision, payload: { workId: work.id } });
  });
  const { effect } = f.propose(); f.approve(effect);
  expect((await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).state).toBe("unknown");
  expect(f.remote.pushes).toHaveLength(0);
  expect(f.remote.creates).toHaveLength(0);
});
