import { expect, test } from "bun:test";
import { importGithubSkill, githubSkillSource } from "../src/s16/skills/github";
import { githubSkillFixture as fixture, commit } from "./fixtures/s16-skills";

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
