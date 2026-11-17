import { createHash } from "node:crypto";
import type { SourceNetwork } from "../../src/s16/connections/net";

export const commit = "a".repeat(40), treeId = "b".repeat(40);
export function githubSkillFixture() {
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
  let privateRepo = false, truncated = false, special = false, corrupt = false, failBlobs = false, branch = commit;
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
        if (failBlobs) { status = 503; data = {}; } else if (text === undefined) { status = 404; data = {}; } else data = { sha: hash(text), size: Buffer.byteLength(text), encoding: "base64", content: Buffer.from(corrupt ? "changed" : text).toString("base64") + "\n" };
      } else { status = 404; data = {}; }
      return { status, headers: new Headers(), text: JSON.stringify(data) };
    },
  };
  return { network, hits, headers, set private(value: boolean) { privateRepo = value; }, set truncated(value: boolean) { truncated = value; }, set special(value: boolean) { special = value; }, set corrupt(value: boolean) { corrupt = value; }, set failBlobs(value: boolean) { failBlobs = value; } };
}

