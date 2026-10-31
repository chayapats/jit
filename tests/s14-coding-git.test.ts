import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { S14Application } from "../src/s14/application";
import { Database } from "bun:sqlite";
import { S14Maintenance } from "../src/s14/ops";
import { schwayOpsNative } from "../src/s14/ops-native";
import { schwayRecovery } from "../src/s14/native-recovery";
import { credentialFreeImage } from "../src/s14/ops-image";
import { opsRoot } from "../src/s14/ops-state";
import type { OpsCommand } from "../src/s14/ops-types";
import { S14Store } from "../src/s14/store";
import { ConnectionVault } from "../src/exec/connections";
import { canonical, digest } from "../src/s14/validation";
import { replayPolicy } from "../src/s14/replay-policy";
import type { Attempt, Effect } from "../src/s14/authority-types";
import type { GitAction, GitCommand, GitOptions, GitRemotePort, GitRemoteProof } from "../src/s14/coding-git-types";
import { CodingGitMirror } from "../src/s14/coding-git-mirror";
import { GitHubCodingRemote, gitPullUrl } from "../src/s14/coding-git-remote";
import { createS14Handler } from "../src/s14/web";
import { CodingRuntimeFixture, FixtureGitProcessLimits, codingScript } from "./fixtures/s14-coding";

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
    if (this.prOutcome !== "failed") this.prs.push({ number: 17, url: "https://github.com/fixture/repo/pull/17", headCommit: action.headCommit, baseCommit: action.pr!.baseCommit,
      head: action.update.ref.slice(11), base: action.pr!.base, title: action.pr!.title, body: action.pr!.body, draft: action.pr!.draft });
    return { outcome: this.prOutcome, number: this.prOutcome === "succeeded" ? 17 : null, url: "https://github.com/fixture/repo/pull/17" };
  }
  async readBack(_action: GitAction, token: string, allowed: () => void) {
    expect(token).toBe(secret);
    allowed();
    this.reads++;
    return { headCommit: this.head, baseCommit: this.base, prs: structuredClone(this.prs), complete: !this.incomplete };
  }
}
async function fixture(afterStage?: GitOptions["afterStage"], scheduled = false, separateBot = false, sourced = false) {
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
    coding: { gitLimits: runtime.gitLimits, repositoryFetch: runtime.repositoryFetch, model: codingScript(() => path) }, git: { vault, remote, ...(afterStage ? { afterStage } : {}) } };
  const app = new S14Application(store, options);
  await app.provisionOwner("git-fixture-owner-password");
  const token = await app.login("git-fixture-owner-password"), auth = app.authenticate(token);
  const setup = app.execute(auth.actor, { kind: "setup", requestId: rid(), expectedRevision: 0,
    payload: { ownerName: "Owner", language: "th", routeId: "route", capabilities: { tools: policy.tools, resources: policy.resources } } });
  let botId = "jit";
  if (separateBot) {
    app.options.chat = { async reply() { return { text: "Suggested coder", proposal: { name: "Coder", responsibility: "Repair scoped repositories", routeId: "route" } }; } };
    app.execute(auth.actor, { kind: "message.post", requestId: rid(), expectedRevision: 1,
      payload: { conversationId: setup.conversation!.id, text: "Suggest a coder" } });
    await app.drainReplies();
    const proposal = app.home(auth.actor).proposals[0]!;
    botId = app.execute(auth.actor, { kind: "bot.proposal.accept", requestId: rid(), expectedRevision: proposal.revision,
      payload: { proposalId: proposal.id, capabilities: { tools: policy.tools, resources: policy.resources } } }).bot!.id;
  }
  app.execute(auth.actor, { kind: "coding.repository.grant", requestId: rid(), expectedRevision: 0,
    payload: { id: "repo", botId, url: "https://github.com/fixture/repo.git", baseCommit: base } });
  const claim = sourced ? app.execute(auth.actor, { kind: "memory.remember", requestId: rid(),
    expectedRevision: app.conversation(auth.actor, setup.conversation!.id).conversation.revision,
    payload: { conversationId: setup.conversation!.id, text: "Owner coding evidence that may later be withdrawn" } }).claim! : null;
  const work = app.execute(auth.actor, { kind: "coding.start", requestId: rid(), expectedRevision: app.conversation(auth.actor, setup.conversation!.id).conversation.revision,
    payload: { repository: { id: "repo", revision: 1 }, install: null,
      tests: [{ argv: ["sh", "-c", 'test "$(cat answer.txt)" = fixed'], network: "none", timeoutMs: 1000, coverage: "fixture assertion" }],
      work: { conversationId: setup.conversation!.id, task: null, title: "Code", purpose: "Repair fixture", completionRule: "Owner review",
        bots: [{ id: botId, revision: 1 }], tools: ["computer", "coding", "effect_push"], scopes: [{ kind: "resource", id: "repo", revision: 1 }],
        limits: { attempts: 2, steps: 2, calls: 256, outputBytes: 65536, wallMs: 3600000, concurrency: 1, reads: 1 }, expiresAt: clock.now + 3600000 } } }).work!;
  path = `/workspace/coding/${work.id}`;
  let attempt: Attempt;
  if (scheduled) {
    app.authority.options.executor = { run: (selected, signal) => app.coding.run(join(root, "native"), selected, signal) };
    await app.authority.drain();
    attempt = app.authority.view(auth.actor, work.id).attempts[0]!;
  } else {
    attempt = app.authority.admit(work.id, rid(), { botId, tools: ["computer", "coding", "effect_push"], scopes: [{ kind: "resource", id: "repo", revision: 1 }], input: "Repair answer", calls: 256, outputBytes: 65536 });
    app.authority.commit(attempt.id, await app.coding.run(join(root, "native"), attempt, new AbortController().signal));
  }
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
  return { root, runtime, remote, store, app, options, auth, token, clock, base, vault, path, work, attempt, botId, stored, secretCommand, propose, approve, claim };
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
  expect(f.app.git.view(f.auth.actor, effect.id).progress).toMatchObject({ stage: "complete", verification: "remote_readback", pullNumber: 17, pullUrl: "https://github.com/fixture/repo/pull/17" });
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
  mkdirSync(join(f.runtime.local(f.path), ".git", "hooks"));
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
  const mirror = new CodingGitMirror(new FixtureGitProcessLimits());
  try {
    await expect(mirror.import(new TextEncoder().encode("malicious bundle fixture"), { headCommit: "a".repeat(40) } as GitAction)).rejects.toThrow("git_objects_unverified");
    expect(() => mirror.verifiedPath()).toThrow("git_objects_unverified");
  } finally { mirror.close(); }
});

test.each([false, true])("legacy draft-tree evidence cannot authorize a push (already approved=%s)", async approved => {
  const f = await fixture();
  const effect = approved ? f.propose(false).effect : null;
  if (effect) f.approve(effect);
  f.store.transaction(tx => tx.run("UPDATE coding_runs SET record_json=json_remove(record_json,'$.evidenceCheckout') WHERE attempt_id=?", f.attempt.id));
  expect(f.app.coding.view(f.auth.actor, f.work.id).runs[0]).toMatchObject({ state: "partial", reason: "coding_recorded_checkout_required" });
  if (!effect) expect(() => f.propose(false)).toThrow("coding_evidence_required");
  else {
    expect((await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).state).toBe("failed");
    expect(f.app.git.view(f.auth.actor, effect.id).progress.reason).toBe("coding_evidence_required");
  }
  expect(f.remote.pushes).toHaveLength(0);
  expect(f.store.read(tx => tx.all("SELECT * FROM git_connection_releases"))).toHaveLength(0);
});

test.each(["--skip-worktree", "--assume-unchanged", "filter"].flatMap(attack => ["verifying", "push_dispatching"].map(stage => ({ attack, stage }))))("hidden file changes refuse at $stage ($attack)", async ({ attack, stage }) => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(async current => {
    if (current !== stage) return;
    const path = f.runtime.local(f.path);
    if (attack === "filter") {
      writeFileSync(join(path, ".git", "info", "attributes"), "answer.txt filter=evil\n");
      await f.runtime.git("-C", path, "config", "filter.evil.clean", "printf 'fixed\\n'");
    } else await f.runtime.git("-C", path, "update-index", attack, "answer.txt");
    writeFileSync(join(path, "answer.txt"), "untested mutation\n");
  });
  const { effect } = f.propose(false); f.approve(effect);
  expect((await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).state).toBe("failed");
  expect(f.app.git.view(f.auth.actor, effect.id).progress.reason).toBe("git_approved_diff_changed");
  expect(f.remote.pushes).toHaveLength(0);
});

test("GitHub protocol fixes method/endpoint/body, refuses redirects and treats 5xx as unknown", async () => {
  const f = await fixture(), { effect } = f.propose(), action = JSON.parse(effect.action.content) as GitAction;
  const calls: { url: string; init: RequestInit }[] = [];
  const remote = new GitHubCodingRemote((async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init! });
    return new Response(JSON.stringify({ number: 9, html_url: "https://github.com/fixture/repo/pull/9" }), { status: calls.length === 1 ? 201 : 502 });
  }) as typeof fetch);
  expect(await remote.createPr(action, secret, () => {})).toEqual({ outcome: "succeeded", number: 9, url: "https://github.com/fixture/repo/pull/9" });
  expect(calls[0]!.url).toBe("https://api.github.com/repos/fixture/repo/pulls");
  expect(calls[0]!.init.redirect).toBe("error");
  expect(JSON.parse(calls[0]!.init.body as string)).toEqual({ title: "Exact reviewed change", head: "review", base: "main", body: "Exact PR body", draft: true });
  expect((await remote.createPr(action, secret, () => {})).outcome).toBe("unknown");
});

test.each(["http://github.com/fixture/repo/pull/9", "https://github.com.evil.example/fixture/repo/pull/9", "https://github.com@evil.example/fixture/repo/pull/9", "https://github.com/other/repo/pull/9", "https://github.com/fixture/repo/pull/10", "javascript:alert(1)", "https://github.com/fixture/repo/pull/9?token=secret"])("provider PR URL %j cannot become a trusted link", url => {
  expect(gitPullUrl(url, "https://github.com/fixture/repo.git", 9)).toBeNull();
});

test("approved diff and full head are independently verified against exported objects", async () => {
  const f = await fixture(), { effect } = f.propose(), action = JSON.parse(effect.action.content) as GitAction;
  const bundle = join(f.runtime.local(f.path), "fixture.bundle");
  const proc = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-C", f.runtime.local(f.path), "bundle", "create", bundle, "HEAD"], { stdout: "ignore", stderr: "ignore" });
  expect(await proc.exited).toBe(0);
  for (const changed of [{ ...action, headCommit: "b".repeat(40) }, { ...action, diffHash: "0".repeat(64) }]) {
    const mirror = new CodingGitMirror(new FixtureGitProcessLimits());
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


test("graph-scheduled coding retains report/review/download ingress and exact Git approval after actual settlement", async () => {
  const f = await fixture(undefined, true);
  expect(f.app.graph.view(f.auth.actor, f.work.id).steps[0]).toMatchObject({ state: "blocked", reason: "handler_waiting", attemptId: f.attempt.id });
  expect(f.store.read(tx => tx.get<{ active: number }>("SELECT active FROM attempt_transports WHERE attempt_id=?", f.attempt.id))!.active).toBe(0);
  const handler = createS14Handler(f.app, "http://localhost:3001");
  const get = (path: string) => handler(new Request(`http://localhost:3001${path}`, { headers: { cookie: `jit_s14=${f.token}` } }));
  const run = f.app.coding.view(f.auth.actor, f.work.id).runs[0]!;
  expect(run.state).toBe("reviewable");
  expect(typeof run.reportId).toBe("string");
  for (const path of ["/api/s14/coding/repositories", "/api/s14/git/connections", `/api/s14/work/${f.work.id}/coding`, `/api/s14/work/${f.work.id}/report-review`, `/api/s14/reports/${run.reportId}`]) expect([path, (await get(path)).status]).toEqual([path, 200]);
  const report = f.app.reports.view(f.auth.actor, run.reportId!);
  if (report.state !== "available") throw new Error("missing committed report");
  for (const artifact of report.artifacts) expect(f.app.artifacts.download(f.auth.actor, artifact.id).bytes.length).toBe(artifact.size);
  const review = f.app.reports.review(f.auth.actor, f.work.id);
  f.app.execute(f.auth.actor, { kind: "report.review.accept", requestId: rid(), expectedRevision: review.revision,
    payload: { reportId: report.report.id, reportRevision: report.report.revision } });
  const { effect } = f.propose();
  expect((await get(`/api/s14/git/effects/${effect.id}`)).status).toBe(200);
  expect(f.remote.pushes).toHaveLength(0);
  f.approve(effect);
  await f.app.git.drain();
  expect(f.app.git.view(f.auth.actor, effect.id).effect.state).toBe("succeeded");
  expect(f.remote.pushes).toHaveLength(1);
  expect(f.remote.creates).toHaveLength(1);
});


test.each(["retire", "capabilities"])("%s fences an approved graph coding effect at its last dispatch barrier while retaining committed evidence", async change => {
  let f: Awaited<ReturnType<typeof fixture>>;
  f = await fixture(stage => {
    if (stage !== "push_dispatching") return;
    if (change === "retire") {
      const preview = f.app.botLifecycle.preview(f.auth.actor, f.botId, "retire");
      f.app.execute(f.auth.actor, { kind: "bot.retire", requestId: rid(), expectedRevision: preview.bot.revision,
        payload: { botId: f.botId, previewHash: preview.hash, retain: { history: true, evidence: true } } });
    } else {
      const bot = f.app.botLifecycle.view(f.auth.actor, f.botId).bot;
      const proposal = f.app.execute(f.auth.actor, { kind: "bot.capabilities.propose", requestId: rid(), expectedRevision: bot.revision,
        payload: { botId: bot.id, capabilities: { tools: ["computer"], resources: ["repo"] } } }).proposal!;
      f.app.execute(f.auth.actor, { kind: "bot.capabilities.accept", requestId: rid(), expectedRevision: proposal.revision,
        payload: { proposalId: proposal.id, proposalHash: proposal.hash } });
    }
  }, true, true);
  const run = f.app.coding.view(f.auth.actor, f.work.id).runs[0]!;
  const report = f.app.reports.view(f.auth.actor, run.reportId!);
  if (report.state !== "available") throw new Error("missing coding report");
  const { effect } = f.propose(); f.approve(effect);
  expect((await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).state).not.toBe("succeeded");
  expect(f.remote.pushes).toHaveLength(0); expect(f.remote.creates).toHaveLength(0);
  expect(f.app.botLifecycle.view(f.auth.actor, f.botId).bot.generation).toBe(2);
  expect(() => f.propose()).toThrow();
  expect(() => f.app.computers.open(f.attempt.id)).toThrow();
  expect(f.app.reports.view(f.auth.actor, run.reportId!).state).toBe("available");
  for (const artifact of report.artifacts) expect(f.app.artifacts.download(f.auth.actor, artifact.id).bytes.length).toBe(artifact.size);
});

test("graph coding effect checkpoints stay reconcile-only and owner retry/summarize cannot replay shell or erase evidence", async () => {
  const f = await fixture(undefined, true);
  expect(replayPolicy(f.attempt).replay).toBe("reconcile_only");
  const checkpoint = f.app.recovery.view(f.auth.actor).checkpoints.find(c => c.id === f.attempt.id)!;
  expect(checkpoint.replay).toBe("reconcile_only");
  expect(checkpoint.state).toBe("committed");
  const before = f.app.authority.view(f.auth.actor, f.work.id), requests = f.runtime.requests.length;
  for (const kind of ["work.retry", "work.summarize"] as const) {
    expect(() => f.app.execute(f.auth.actor, { kind, requestId: rid(), expectedRevision: before.work.revision, payload: { workId: f.work.id } })).toThrow("coding_never_replay");
    expect(f.app.authority.view(f.auth.actor, f.work.id)).toEqual(before);
  }
  await f.app.authority.drain(); await f.app.git.drain();
  expect(f.runtime.requests).toHaveLength(requests);
  expect(f.remote.pushes).toHaveLength(0);
  expect(f.app.reports.list(f.auth.actor, f.work.id)[0]!.state).toBe("available");
});

test("graph lane stop fences the retained coding approval seam without erasing committed files", async () => {
  const f = await fixture(undefined, true), { effect } = f.propose(); f.approve(effect);
  const step = f.app.graph.view(f.auth.actor, f.work.id).steps[0]!;
  f.app.execute(f.auth.actor, { kind: "work.step.stop", requestId: rid(), expectedRevision: step.revision,
    payload: { workId: f.work.id, stepId: step.id } });
  await expect(f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).rejects.toThrow("step_fenced");
  expect(f.remote.pushes).toHaveLength(0);
  expect(f.app.reports.list(f.auth.actor, f.work.id)[0]!.state).toBe("available");
});

test("boot fences coding before workers and never replays an unknown graph Git effect", async () => {
  const f = await fixture(undefined, true), { effect } = f.propose(false); f.approve(effect);
  f.remote.pushOutcome = "unknown";
  expect((await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).state).toBe("unknown");
  const run = f.app.coding.view(f.auth.actor, f.work.id).runs[0]!;
  const reopened = new S14Application(f.store, f.options), actor = reopened.authenticate(f.token).actor;
  let runs = 0;
  reopened.authority.options.executor = { async run() { runs++; return { state: "ready", text: "must not replay" }; } };
  const gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>();
  const boot = reopened.recovery.boot({ async open(intent) {
    entered.resolve(); await gate.promise;
    return {
      async listSessions() { return { sessions: intent.reference ? [{ reference: intent.reference, state: "retired" as const }] : [] }; },
      async retireSession() {},
      async deleteSession(reference) { return { status: "deleted" as const, session: reference, removed: ["conversation" as const], nextAction: "none" as const }; },
      async close() {},
    };
  } });
  await entered.promise;
  expect(reopened.recovery.booting).toBe(true);
  await reopened.authority.drain(); await reopened.drainReplies(); await reopened.git.drain();
  expect(runs).toBe(0); expect(f.remote.pushes).toHaveLength(1);
  gate.resolve(); await boot;
  await reopened.authority.drain(); await reopened.git.drain();
  expect(runs).toBe(0); expect(f.remote.pushes).toHaveLength(1); expect(f.remote.creates).toHaveLength(0);
  expect(reopened.authority.effect(actor, effect.id).effect.state).toBe("unknown");
  const checkpoint = reopened.recovery.view(actor).checkpoints.find(c => c.id === f.attempt.id)!;
  expect(checkpoint.replay).toBe("reconcile_only"); expect(checkpoint.state).not.toBe("queued");
  expect(reopened.reports.view(actor, run.reportId!).state).toBe("available");
});

test("freshly re-enabled capability generation cannot release credentials for an old unknown Git read-back", async () => {
  const f = await fixture(undefined, true), { effect } = f.propose(false); f.approve(effect);
  f.remote.pushOutcome = "unknown";
  expect((await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).state).toBe("unknown");
  const bot = f.app.botLifecycle.view(f.auth.actor, f.botId).bot;
  const proposal = f.app.execute(f.auth.actor, { kind: "bot.capabilities.propose", requestId: rid(), expectedRevision: bot.revision,
    payload: { botId: bot.id, capabilities: { tools: bot.capabilities.tools, resources: ["repo"] } } }).proposal!;
  f.app.execute(f.auth.actor, { kind: "bot.capabilities.accept", requestId: rid(), expectedRevision: proposal.revision,
    payload: { proposalId: proposal.id, proposalHash: proposal.hash } });
  await f.app.botLifecycle.drain({ async open(intent) { return {
    async listSessions() { return { sessions: intent.reference ? [{ reference: intent.reference, state: "retired" as const }] : [] }; },
    async retireSession() {},
    async deleteSession(reference) { return { status: "deleted" as const, session: reference, removed: ["conversation" as const], nextAction: "none" as const }; },
    async close() {},
  }; } });
  expect(f.app.botLifecycle.view(f.auth.actor, f.botId).bot.enabled).toBe(true);
  expect(f.app.botLifecycle.view(f.auth.actor, f.botId).bot.generation).toBe(2);
  const current = f.app.authority.effect(f.auth.actor, effect.id).effect, reads = f.remote.reads;
  const releases = f.store.read(tx => tx.all("SELECT * FROM git_connection_releases"));
  expect(() => f.app.execute(f.auth.actor, { kind: "git.reconcile", requestId: rid(), expectedRevision: current.revision,
    payload: { effectId: current.id, actionHash: current.actionHash } })).toThrow("git_authority_changed");
  await f.app.git.drain();
  expect(f.remote.reads).toBe(reads); expect(f.remote.pushes).toHaveLength(1);
  expect(f.store.read(tx => tx.all("SELECT * FROM git_connection_releases"))).toEqual(releases);
});

function maintenanceCommand(m: S14Maintenance, kind: OpsCommand["kind"], payload: object = {}): OpsCommand {
  return { kind, requestId: rid(), expectedRevision: m.control.revision, payload } as OpsCommand;
}
async function stopForBackup(f: Awaited<ReturnType<typeof fixture>>) {
  const computer = f.app.computers.view(f.auth.actor, f.botId).computer!;
  f.app.execute(f.auth.actor, { kind: "computer.stop", requestId: rid(), expectedRevision: computer.revision, payload: { botId: f.botId, computerId: computer.id, generation: computer.generation } });
  await f.app.computers.drain();
  f.store.close();
}

test.each(["pending", "approved", "push_dispatching", "pr_dispatching", "complete"] as const)("managed coding/Git restore excludes credential sentinels, requires reconnect and never replays %s", async state => {
  const f = await fixture(), { effect } = f.propose();
  if (state !== "pending") f.approve(effect);
  if (state === "complete") expect((await f.app.authority.runEffect(effect.id, effect.revision, effect.actionHash)).state).toBe("succeeded");
  const reportId = f.app.coding.view(f.auth.actor, f.work.id).runs[0]!.reportId!;
  const report = f.app.reports.view(f.auth.actor, reportId);
  if (report.state !== "available") throw Error("Missing coding evidence");
  const hashes = report.artifacts.map(file => ({ id: file.id, bytes: Buffer.from(f.app.artifacts.download(f.auth.actor, file.id).bytes) }));
  const vaultId = f.store.read(tx => tx.get<{ vault_id: string }>("SELECT vault_id FROM git_connections WHERE id=?", f.stored.id)!.vault_id);
  await stopForBackup(f);
  const m = new S14Maintenance(f.store.path, f.options, schwayOpsNative(join(f.root, "native")));
  try {
    const actor = m.app.authenticate(f.token).actor;
    const backup = await m.execute(actor, maintenanceCommand(m, "backup.create"));
    expect(backup.state).toBe("complete");
    const directory = join(opsRoot(f.store.path), "backups", backup.backupId!);
    for (const name of readdirSync(directory)) {
      const bytes = readFileSync(join(directory, name));
      expect(bytes.includes(Buffer.from(secret))).toBe(false);
      expect(bytes.includes(Buffer.from(vaultId))).toBe(false);
    }
    const image = Database.deserialize(readFileSync(join(directory, "application.sqlite")));
    try {
      const connection = image.query("SELECT record_json,vault_id FROM git_connections").get() as { record_json: string; vault_id: null };
      expect(connection.vault_id).toBeNull(); expect(JSON.parse(connection.record_json).secret).toBe("empty");
      expect(image.query("SELECT count(*) n FROM git_reconciliations").get()).toEqual({ n: 0 });
    } finally { image.close(); }
    // Even accidental secrets in retained coding metadata must refuse capture.
    m.store.transaction(tx => tx.run("UPDATE coding_repositories SET record_json=json_set(record_json,'$.accidentalToken',?)", secret));
    expect(() => credentialFreeImage(m.store)).toThrow("s14_ops_credential_excluded");
    m.store.transaction(tx => tx.run("UPDATE coding_repositories SET record_json=json_remove(record_json,'$.accidentalToken')"));
    if (state === "push_dispatching" || state === "pr_dispatching") m.store.transaction(tx => {
      tx.run("INSERT INTO lifecycle.withdrawals VALUES ('effect_claim',?,'revision_1')", effect.id);
      tx.run("UPDATE git_effects SET record_json=json_set(record_json,'$.stage',?) WHERE effect_id=?", state, effect.id);
    });
    const before = { pushes: f.remote.pushes.length, creates: f.remote.creates.length, reads: f.remote.reads };
    const staged = await m.execute(actor, maintenanceCommand(m, "restore.prepare", { backupId: backup.backupId }));
    expect(staged.state).toBe("validated");
    expect((await m.execute(actor, maintenanceCommand(m, "restore.activate", { stageId: staged.stage!.id, actionHash: staged.stage!.actionHash }))).state).toBe("complete");
    const owner = m.app.authenticate(await m.app.login("git-fixture-owner-password")).actor;
    expect(f.vault.read(vaultId)).toBe(secret); // A surviving local vault cannot reconnect an archive.
    expect(m.app.git.connections(owner)[0]).toMatchObject({ id: f.stored.id, secret: "empty" });
    expect(m.app.git.connections(owner)[0]!.revision).toBeGreaterThan(f.stored.revision);
    expect(m.store.read(tx => tx.get("SELECT 1 FROM git_connections WHERE vault_id IS NOT NULL"))).toBeNull();
    const restored = m.app.authority.effect(owner, effect.id).effect;
    expect(restored.state).toBe(state === "complete" ? "succeeded" : state.endsWith("dispatching") ? "unknown" : "expired");
    expect(m.app.authority.view(owner, f.work.id).authority?.revoked).toBe(true);
    for (const file of hashes) expect(Buffer.from(m.app.artifacts.download(owner, file.id).bytes)).toEqual(file.bytes);
    await m.app.recovery.boot(schwayRecovery(join(f.root, "native")));
    await m.app.authority.drain(); await m.app.git.drain();
    expect({ pushes: f.remote.pushes.length, creates: f.remote.creates.length, reads: f.remote.reads }).toEqual(before);
  } finally { m.close(); }
}, 30000);

test.each(["memory.forget", "memory.delete"] as const)("managed coding evidence and bundle authority honour later %s", async kind => {
  const f = await fixture(undefined, false, false, true), { effect } = f.propose();
  const run = f.app.coding.view(f.auth.actor, f.work.id).runs[0]!;
  const report = f.app.reports.view(f.auth.actor, run.reportId!);
  if (report.state !== "available") throw Error("Missing coding evidence");
  await stopForBackup(f);
  const m = new S14Maintenance(f.store.path, f.options, schwayOpsNative(join(f.root, "native")));
  try {
    const actor = m.app.authenticate(f.token).actor;
    const backup = await m.execute(actor, maintenanceCommand(m, "backup.create"));
    m.app.execute(actor, { kind, requestId: rid(), expectedRevision: f.claim!.revision, payload: { claim: f.claim! } });
    const staged = await m.execute(actor, maintenanceCommand(m, "restore.prepare", { backupId: backup.backupId }));
    expect(staged.state).toBe("validated");
    await m.execute(actor, maintenanceCommand(m, "restore.activate", { stageId: staged.stage!.id, actionHash: staged.stage!.actionHash }));
    const owner = m.app.authenticate(await m.app.login("git-fixture-owner-password")).actor;
    expect(m.app.reports.view(owner, run.reportId!).state).toBe("unavailable");
    expect(m.app.coding.view(owner, f.work.id)).toMatchObject({ available: false, job: null, checks: [] });
    expect(m.store.read(tx => tx.get("SELECT 1 FROM coding_checks WHERE attempt_id=?", f.attempt.id))).toBeNull();
    for (const file of report.artifacts) expect(() => m.app.artifacts.download(owner, file.id)).toThrow("artifact_unavailable");
    expect(() => m.app.execute(owner, { kind: "approval.decide", requestId: rid(), expectedRevision: effect.revision,
      payload: { effectId: effect.id, actionHash: effect.actionHash, decision: "approve" } })).toThrow();
    await m.app.git.drain();
    expect(f.remote.pushes).toHaveLength(0); expect(f.remote.creates).toHaveLength(0);
    expect(f.runtime.requests.some(request => { const command = (request as { command?: string }).command; return command?.includes("bundle create") && command?.includes(".jit-"); })).toBe(false);
  } finally { m.close(); }
}, 30000);

test("managed coding image cannot resurrect deleted Bot evidence, plans or bundle authority", async () => {
  const f = await fixture(undefined, false, true), { effect } = f.propose();
  const run = f.app.coding.view(f.auth.actor, f.work.id).runs[0]!;
  const report = f.app.reports.view(f.auth.actor, run.reportId!);
  if (report.state !== "available") throw Error("Missing coding evidence");
  await stopForBackup(f);
  const native = schwayOpsNative(join(f.root, "native"));
  const m = new S14Maintenance(f.store.path, f.options, native);
  try {
    const actor = m.app.authenticate(f.token).actor;
    const backup = await m.execute(actor, maintenanceCommand(m, "backup.create"));
    const preview = m.app.botLifecycle.preview(actor, f.botId, "delete");
    m.app.execute(actor, { kind: "bot.delete", requestId: rid(), expectedRevision: preview.bot.revision,
      payload: { botId: f.botId, previewHash: preview.hash } });
    await m.app.botLifecycle.drain(schwayRecovery(join(f.root, "native")));
    expect(m.app.botLifecycle.view(actor, f.botId).lifecycle.state).toBe("deleted");
    const stage = await m.execute(actor, maintenanceCommand(m, "restore.prepare", { backupId: backup.backupId }));
    expect(stage.state).toBe("validated");
    await m.execute(actor, maintenanceCommand(m, "restore.activate", { stageId: stage.stage!.id, actionHash: stage.stage!.actionHash }));
    const owner = m.app.authenticate(await m.app.login("git-fixture-owner-password")).actor;
    expect(m.app.botLifecycle.view(owner, f.botId).lifecycle.state).toBe("deleted");
    expect(m.app.reports.view(owner, run.reportId!).state).toBe("unavailable");
    expect(m.store.read(tx => tx.get("SELECT 1 FROM coding_checks WHERE attempt_id=?", f.attempt.id))).toBeNull();
    expect(m.store.read(tx => tx.get("SELECT 1 FROM coding_jobs WHERE work_id=?", f.work.id))).toBeNull();
    expect(m.app.authority.effect(owner, effect.id).effect.payloadState).toBe("deleted");
    for (const file of report.artifacts) expect(() => m.app.artifacts.download(owner, file.id)).toThrow("artifact_unavailable");
    await m.app.git.drain();
    expect(f.remote.pushes).toHaveLength(0); expect(f.remote.creates).toHaveLength(0);
  } finally { m.close(); }
}, 30000);
