import { expect, test } from "bun:test";
import { repositoryCommit } from "../src/s14/coding-resolve";
import type { CodingRepositoryFetch } from "../src/s14/coding-types";

const origin = "https://github.com/fixture/repo.git", sha = "a".repeat(40);
const body = { ref: "refs/heads/feature/fix", object: { type: "commit", sha } };
const limits = { bytes: 65536, timeoutMs: 15000, schedule: (_expire: () => void, _ms: number) => () => {} };

test("branch resolution fixes its anonymous HTTPS endpoint and never invokes Git or repository code", async () => {
  let guards = 0;
  const fetcher: CodingRepositoryFetch = async (url, options) => {
    expect(url).toBe("https://api.github.com/repos/fixture/repo/git/ref/heads/feature/fix");
    expect(options.method).toBe("GET"); expect(options.redirect).toBe("error");
    expect(new Headers(options.headers).has("authorization")).toBe(false);
    expect(options.body).toBeUndefined();
    return Response.json(body);
  };
  expect(await repositoryCommit(origin, "feature/fix", () => { guards++; }, fetcher, limits)).toBe(sha);
  expect(guards).toBeGreaterThan(2);
});

test.each(["", "../main", "refs/tags/v1", "main~1", "-main", "main@{1}", "main.lock", "main\n", "main*", "a//b", "a/../b"])("invalid branch %j refuses without dispatch", async branch => {
  await expect(repositoryCommit(origin, branch, () => {}, async () => { throw new Error("must not dispatch"); }, limits)).rejects.toThrow("coding_branch_invalid");
});

test.each([
  () => Response.json(body, { status: 404 }),
  () => Response.json(body, { status: 302, headers: { location: "https://evil.example" } }),
  () => Response.json({ ...body, ref: "refs/heads/other" }),
  () => Response.json({ ...body, object: { type: "tag", sha } }),
  () => Response.json({ ...body, object: { type: "commit", sha: "0".repeat(40) } }),
  () => new Response("not json"),
])("missing, redirected, ambiguous or noncommit results never grant a commit", async response => {
  await expect(repositoryCommit(origin, "feature/fix", () => {}, async () => response(), limits)).rejects.toThrow();
});

test("declared and streamed response bounds cancel without exposing remote data", async () => {
  await expect(repositoryCommit(origin, "main", () => {}, async () => Response.json(body, { headers: { "content-length": "65537" } }), limits)).rejects.toThrow("coding_resolve_size_limit");
  let cancelled = false;
  await expect(repositoryCommit(origin, "main", () => {}, async () => new Response(new ReadableStream({
    start(c) { c.enqueue(new Uint8Array(65537)); }, cancel() { cancelled = true; },
  }), { headers: { "content-type": "application/json" } }), limits)).rejects.toThrow("coding_resolve_size_limit");
  expect(cancelled).toBe(true);
});

test.each(["response", "body"])("one fake deadline bounds a stalled %s even when transport ignores abort", async stall => {
  let expire!: () => void, cleared = false;
  const fetcher: CodingRepositoryFetch = async () => {
    if (stall === "response") { queueMicrotask(() => expire()); return new Promise<Response>(() => {}); }
    return new Response(new ReadableStream({ pull() { queueMicrotask(() => expire()); } }), { headers: { "content-type": "application/json" } });
  };
  await expect(repositoryCommit(origin, "main", () => {}, fetcher, { ...limits, schedule(callback, ms) {
    expect(ms).toBe(15000); expire = callback; return () => { cleared = true; };
  } })).rejects.toThrow("coding_resolve_timeout");
  expect(cleared).toBe(true);
});
