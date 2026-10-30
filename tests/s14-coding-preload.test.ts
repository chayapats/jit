import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { repositoryBundle } from "../src/s14/coding-preload";
import { codingRegistry } from "../src/s14/coding-protocol";
import type { CodingRepository, CodingRepositoryFetch } from "../src/s14/coding-types";
import { CodingRuntimeFixture } from "./fixtures/s14-coding";

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
    const bundle = await repositoryBundle(repo(commit), undefined, new AbortController().signal, () => {}, runtime.repositoryFetch);
    expect(Buffer.from(bundle).subarray(0, 20).toString()).toStartWith("# v2 git bundle");
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(join(runtime.root, "hook-ran"))).toBe(false);
    expect(readFileSync(join(source, "answer.txt"), "utf8")).toBe("broken\n");
    await expect(repositoryBundle(repo(), undefined, new AbortController().signal, () => {}, runtime.repositoryFetch)).rejects.toThrow("coding_preload_objects_refused");
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
  const bundle = await repositoryBundle(repo(commit), undefined, new AbortController().signal, () => {}, fetcher);
  expect(bundle.length).toBeGreaterThan(0);
});
