import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, watch, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { brokerGit } from "../src/s14/coding-git-mirror";
import { codingQuote } from "../src/s14/coding-protocol";
import { join } from "node:path";
import { repositoryBundle } from "../src/s14/coding-preload";
import { codingRegistry } from "../src/s14/coding-protocol";
import type { CodingRepository, CodingRepositoryFetch } from "../src/s14/coding-types";
import { CodingRuntimeFixture, FixtureGitProcessLimits } from "./fixtures/s14-coding";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const repo = (baseCommit = "a".repeat(40)): CodingRepository => ({ id: "repo", revision: 1, botId: "jit", active: true, registry: null, url: "https://github.com/fixture/repo.git", baseCommit });
const mime = { "content-type": "application/x-git-upload-pack-result" };
const transport = (response: () => Response | Promise<Response>) => (async () => response()) as CodingRepositoryFetch;
const deadlines = { schedule: (_expire: () => void, _timeoutMs: number) => () => {} };
const run = (fetcher: CodingRepositoryFetch, limits = { packBytes: 16 * 1024 * 1024, timeoutMs: 60000, ...deadlines }) =>
  repositoryBundle(repo(), undefined, new AbortController().signal, () => {}, fetcher, limits);

test.each([[], ["example.com"], ["127.0.0.1"], ["registry.npmjs.org:443"], ["https://registry.npmjs.org"], ["*.npmjs.org"], ["registry.npmjs.org", "registry.npmjs.org"]].map(hosts => [hosts]))("registry scope rejects a widened or ambiguous host list: %j", hosts => {
  expect(() => codingRegistry({ hosts })).toThrow("coding_registry_scope_invalid");
});

test.each([
  () => new Response("redirect", { status: 302, headers: { ...mime, location: "https://example.com" } }),
  () => new Response("pack", { headers: { "content-type": "text/html" } }),
  () => new Response("0008NAK\nPACKcorrupt", { headers: mime }),
  () => new Response("0008ERR\nPACK", { headers: mime }),
])("unexpected repository protocol or corrupt objects never become a bundle", async response => {
  await expect(run(transport(response))).rejects.toThrow();
});

test("declared and streamed size limits refuse before import", async () => {
  await expect(run(transport(() => new Response("x", { headers: { ...mime, "content-length": "100" } })), { packBytes: 32, timeoutMs: 60000, schedule: () => () => {} })).rejects.toThrow("coding_preload_size_limit");
  let cancelled = false;
  await expect(run(transport(() => new Response(new ReadableStream({ start(c) { c.enqueue(new Uint8Array(41)); }, cancel() { cancelled = true; } }), { headers: mime })), { packBytes: 32, timeoutMs: 60000, schedule: () => () => {} })).rejects.toThrow("coding_preload_size_limit");
  expect(cancelled).toBe(true);
});

test("one fake-clock deadline bounds a stalled HTTP response and body even when a fixture ignores abort", async () => {
  for (const stall of ["response", "body"]) {
    let expire!: () => void, cleared = false;
    const limits = { packBytes: 1024, timeoutMs: 60000, schedule(callback: () => void, timeoutMs: number) {
      expect(timeoutMs).toBe(60000); expire = callback; return () => { cleared = true; };
    } };
    const fetcher = transport(() => {
      if (stall === "response") { queueMicrotask(() => expire()); return new Promise<Response>(() => {}); }
      return new Response(new ReadableStream({ pull() { queueMicrotask(() => expire()); } }), { headers: mime });
    });
    await expect(run(fetcher, limits)).rejects.toThrow("coding_preload_timeout");
    expect(cleared).toBe(true);
  }
});

test("the host never runs repository/ambient hooks, filters or submodule commands and a different pinned commit refuses", async () => {
  const runtime = new CodingRuntimeFixture(); roots.push(runtime.root);
  const base = await runtime.seed(), source = join(runtime.workspace, "repositories", "repo");
  const marker = join(runtime.root, "host-code-ran");
  writeFileSync(join(source, ".gitattributes"), "answer.txt filter=evil diff=evil\n");
  writeFileSync(join(source, ".gitmodules"), '[submodule "evil"]\npath = evil\nurl = ext::touch ignored\n');
  await runtime.git("add", ".");
  await runtime.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "malicious metadata");
  const commit = await runtime.git("rev-parse", "HEAD");
  const evil = join(runtime.root, "evil-config");
  writeFileSync(evil, `[filter "evil"]\nclean = touch ${marker}\nsmudge = touch ${marker}\nrequired = true\n[core]\nhooksPath = ${join(source, ".git", "hooks")}\n[diff "evil"]\ncommand = touch ${marker}\n`);
  const old = process.env.GIT_CONFIG_GLOBAL;
  process.env.GIT_CONFIG_GLOBAL = evil;
  try {
    const bundle = await repositoryBundle(repo(commit), undefined, new AbortController().signal, () => {}, runtime.repositoryFetch, undefined, runtime.gitLimits);
    expect(Buffer.from(bundle).subarray(0, 20).toString()).toStartWith("# v2 git bundle");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(runtime.root, "hook-ran"))).toBe(false);
    expect(readFileSync(join(source, "answer.txt"), "utf8")).toBe("broken\n");
    await expect(repositoryBundle(repo(), undefined, new AbortController().signal, () => {}, runtime.repositoryFetch, undefined, runtime.gitLimits)).rejects.toThrow("coding_preload_objects_refused");
    expect(base).not.toBe(commit);
  } finally { if (old === undefined) delete process.env.GIT_CONFIG_GLOBAL; else process.env.GIT_CONFIG_GLOBAL = old; }
});

test("pinned smart-HTTP request interoperates with Git stateless upload-pack without ref discovery", async () => {
  const runtime = new CodingRuntimeFixture(); roots.push(runtime.root);
  const commit = await runtime.seed();
  const fetcher: CodingRepositoryFetch = async (_url, options) => {
    const proc = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "upload-pack", "--stateless-rpc", join(runtime.workspace, "repositories", "repo")], {
      env: { PATH: process.env.PATH!, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" },
      stdin: Buffer.from(String(options.body)), stdout: "pipe", stderr: "ignore",
    });
    const bytes = await new Response(proc.stdout).bytes();
    expect(await proc.exited).toBe(0);
    return new Response(bytes, { headers: mime });
  };
  const bundle = await repositoryBundle(repo(commit), undefined, new AbortController().signal, () => {}, fetcher, undefined, runtime.gitLimits);
  expect(bundle.length).toBeGreaterThan(0);
});


test("broker cancellation terminates the whole trusted Git process group, including pack helpers", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "jit-git-cancel-"))); roots.push(root);
  const controller = new AbortController(), marker = join(root, "child.pid");
  let ready!: () => void;
  const reached = new Promise<void>(resolve => { ready = resolve; });
  const watcher = watch(root, (_event, name) => { if (name === "child.pid") ready(); });
  // Fixed test-only alias models a Git helper; no repository/config-sourced code is executed.
  const alias = `!sleep 60 & child=$!; printf '%s' "$child" > ${codingQuote(`${marker}.tmp`)}; mv ${codingQuote(`${marker}.tmp`)} ${codingQuote(marker)}; wait`;
  const running = brokerGit(root, ["-c", `alias.block=${alias}`, "block"], undefined, { signal: controller.signal, limits: new FixtureGitProcessLimits() });
  try {
    await reached;
    const child = Number(readFileSync(marker, "utf8"));
    expect(child).toBeGreaterThan(0);
    controller.abort();
    expect((await running).code).not.toBe(0);
    const ps = Bun.spawn(["ps", "-p", String(child), "-o", "stat="], { stdout: "pipe", stderr: "ignore" });
    const state = (await new Response(ps.stdout).text()).trim();
    await ps.exited;
    expect(state === "" || state.startsWith("Z")).toBe(true);
  } finally { controller.abort(); watcher.close(); await running.catch(() => {}); }
});

test.each([false, true])("reflected credential in a compressed Git object refuses before bundle creation (encoded=%s)", async encoded => {
  const runtime = new CodingRuntimeFixture(); roots.push(runtime.root);
  await runtime.seed();
  const secret = "github_pat_reflected_sentinel_123456789012345678901234567890";
  writeFileSync(join(runtime.workspace, "repositories", "repo", "reflected.txt"), encoded ? Buffer.from(`x-access-token:${secret}`).toString("base64") : secret);
  await runtime.git("add", ".");
  await runtime.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "reflected credential fixture");
  const commit = await runtime.git("rev-parse", "HEAD");
  await expect(repositoryBundle(repo(commit), secret, new AbortController().signal, () => {}, runtime.repositoryFetch, undefined, runtime.gitLimits)).rejects.toThrow("coding_preload_credential_refused");
});

test("small compressed packs cannot bypass the decoded object-stream size ceiling", async () => {
  const runtime = new CodingRuntimeFixture(); roots.push(runtime.root);
  await runtime.seed();
  writeFileSync(join(runtime.workspace, "repositories", "repo", "large.bin"), Buffer.alloc(33 * 1024 * 1024));
  await runtime.git("add", ".");
  await runtime.git("-c", "core.hooksPath=/dev/null", "commit", "-qm", "compressed size fixture");
  const commit = await runtime.git("rev-parse", "HEAD");
  await expect(repositoryBundle(repo(commit), undefined, new AbortController().signal, () => {}, runtime.repositoryFetch, undefined, runtime.gitLimits)).rejects.toThrow("coding_preload_size_limit");
});
