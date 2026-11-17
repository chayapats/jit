import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { importGithubSkill, githubSkillSource } from "../src/s16/skills/github";
import type { SourceNetwork } from "../src/s16/connections/net";

const commit = "a".repeat(40), treeId = "b".repeat(40);
function fixture() {
  const hits: string[] = [], headers: Record<string, string>[] = [];
  const sourceFiles = new Map([
    ["example/plugin.json", '{"name":"notes","version":"1.0.0","license":"MIT"}'],
    ["example/skills/notes/SKILL.md", "---\nname: notes\ndescription: Read the selected documentation.\n---\nUse the already reviewed docs connection.\n"],
    ["example/mcp.json", '{"mcpServers":{"docs":{"type":"streamable-http","url":"https://docs.example.com/mcp"}}}'],
    ["example/skills/notes/scripts/count.py", "print(3 + 4)\n"],
    ["LICENSE", "MIT License\nSelf-authored fixture.\n"],
    ["unrelated/SKILL.md", "Never load this unrelated playbook."],
  ]);
  const hash = (text: string) => createHash("sha1").update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest("hex");
  let privateRepo = false, truncated = false, special = false, corrupt = false, branch = commit;
  const network: SourceNetwork = {
    validate: url => url, async open() { throw Error("unused fixture open"); }, close() {},
    async request(url, input) {
      hits.push(url); headers.push(input.headers); const path = new URL(url).pathname;
      let status = 200, data: unknown;
      if (path === "/repos/owner/repo") data = { private: privateRepo, default_branch: "main" };
      else if (path.endsWith("/git/ref/heads/main")) { data = { object: { type: "commit", sha: branch } }; branch = "c".repeat(40); }
      else if (path.endsWith(`/git/commits/${commit}`)) data = { sha: commit, tree: { sha: treeId } };
      else if (path.endsWith(`/git/trees/${treeId}`)) data = { sha: treeId, truncated, tree: [...sourceFiles].map(([path, text]) => ({ path, mode: special && path.endsWith("count.py") ? "120000" : "100644", type: "blob", sha: hash(text), size: Buffer.byteLength(text) })) };
      else if (path.includes("/git/blobs/")) {
        const text = [...sourceFiles.values()].find(text => path.endsWith(hash(text)));
        if (text === undefined) { status = 404; data = {}; } else data = { sha: hash(text), size: Buffer.byteLength(text), encoding: "base64", content: Buffer.from(corrupt ? "changed" : text).toString("base64") + "\n" };
      } else { status = 404; data = {}; }
      return { status, headers: new Headers(), text: JSON.stringify(data) };
    },
  };
  return { network, hits, headers, set private(value: boolean) { privateRepo = value; }, set truncated(value: boolean) { truncated = value; }, set special(value: boolean) { special = value; }, set corrupt(value: boolean) { corrupt = value; } };
}

test("public folder preview resolves once, verifies commit/tree/blob bytes and retains the repository license without connecting its MCP server", async () => {
  const f = fixture(); let guards = 0;
  const result = await importGithubSkill("https://github.com/owner/repo/tree/main/example", { network: f.network, guard() { guards++; } });
  expect(result.origin).toEqual({ kind: "github", repository: "owner/repo", commit, folder: "example" });
  expect(result.units.map(unit => unit.name)).toEqual(["notes"]); expect(result.scripts).toEqual([{ path: "skills/notes/scripts/count.py", runtime: "python3" }]);
  expect(result.licenseFiles).toEqual(["repository-licenses/LICENSE"]);
  expect(result.files.some(file => file.path.includes("unrelated"))).toBe(false);
  expect(result.dependencies).toEqual([{ key: "docs", transport: "streamable-http", endpoint: "https://docs.example.com/mcp" }]);
  expect(f.hits.every(url => url.startsWith("https://api.github.com/repos/owner/repo"))).toBe(true);
  expect(f.hits.filter(url => url.includes("/git/ref/heads/"))).toHaveLength(1); expect(f.headers.every(header => !Object.keys(header).some(key => /authorization|cookie/i.test(key)))).toBe(true);
  expect(guards).toBe(f.hits.length * 2 + 1);
});

for (const scenario of ["private", "truncated", "special", "corrupt"] as const) test(`GitHub ${scenario} source refuses a complete candidate`, async () => {
  const f = fixture(); f[scenario] = true;
  await expect(importGithubSkill("https://github.com/owner/repo/tree/main/example", { network: f.network, guard() {} })).rejects.toThrow(scenario === "private" ? "skill_public_repository_required" : scenario === "truncated" ? "skill_tree_incomplete" : scenario === "special" ? "skill_special_file_refused" : "skill_blob_invalid");
  if (scenario !== "corrupt") expect(f.hits.some(url => url.includes("/git/blobs/"))).toBe(false);
});

for (const url of ["file:///protected/state", "https://github.com.evil.test/owner/repo", "https://github.com@127.0.0.1/owner/repo", "https://github.com/owner/repo/tree/main/a/../secret", "https://github.com/owner/repo/tree/main/%2e%2e/secret", "https://github.com/owner/repo/tree/main/a%2fb", "https://github.com/owner/repo?token=secret"]) test(`GitHub source URL never widens the import boundary: ${url}`, () => {
  expect(() => githubSkillSource(url)).toThrow("skill_origin_invalid");
});

test("a pinned commit skips branch lookup and cannot be replaced by a moving preview ref", async () => {
  const f = fixture(), result = await importGithubSkill(`https://github.com/owner/repo/tree/${commit}/example`, { network: f.network, guard() {} });
  expect(result.origin).toMatchObject({ commit }); expect(f.hits.some(url => url.includes("/git/ref/"))).toBe(false);
});

test("owner withdrawal after an awaited read and the shared import deadline stop further requests", async () => {
  const f = fixture(); let guards = 0;
  await expect(importGithubSkill("https://github.com/owner/repo", { network: f.network, guard() { if (++guards === 2) throw Error("owner_changed"); } })).rejects.toThrow("owner_changed");
  expect(f.hits).toHaveLength(1);
  const timed = fixture(); let now = 0;
  await expect(importGithubSkill("https://github.com/owner/repo", { network: timed.network, now: () => now, guard() { if (timed.hits.length) now = 60001; } })).rejects.toThrow("skill_import_timeout");
  expect(timed.hits).toHaveLength(1);
});
