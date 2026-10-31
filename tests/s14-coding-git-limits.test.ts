import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateSync } from "node:zlib";
import { AppError } from "../src/errors";
import { LinuxGitProcessLimits, type GitLimitKernel } from "../src/s14/coding-git-limits";
import { brokerGit, CodingGitMirror } from "../src/s14/coding-git-mirror";
import type { GitAction } from "../src/s14/coding-git-types";
import { repositoryBundle } from "../src/s14/coding-preload";
import { FixtureGitProcessLimits } from "./fixtures/s14-coding";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "s14-git-limits-"))); roots.push(root);
  const probes: string[][] = [];
  const kernel: GitLimitKernel = { platform: "linux", uid: () => 1000, realpath: path => path,
    metadata: () => ({ directory: true, uid: 1000, mode: 0o700 }), filesystem: () => ({ type: 0x01021994, bytes: 128 * 1024 * 1024 }),
    async probe(argv) { probes.push(argv); return 0; } };
  return { root, kernel, probes, limits: new LinuxGitProcessLimits(root, kernel) };
}

test("kernel limits wrap every Git reader before exec, with bounded aggregate scratch rather than per-file accounting", async () => {
  const f = fixture(), directory = f.limits.createDirectory();
  for (const reader of ["index-pack", "fsck", "cat-file", "fetch", "bundle", "diff", "push"]) {
    const command = await f.limits.command(directory, ["git", reader]);
    expect(command).toEqual(["/usr/bin/prlimit", "--as=268435456:268435456", "--fsize=134217728:134217728", "--core=0:0", "--", "git", reader]);
    expect(f.probes.at(-1)).toEqual([...command.slice(0, 5), "/bin/true"]);
  }
});

test.each(["platform", "filesystem", "oversize", "owner", "permissions", "alias", "prlimit"])("unestablished %s limit refuses before returning an object-reader command", async missing => {
  const f = fixture(), directory = f.limits.createDirectory();
  if (missing === "platform") f.kernel.platform = "darwin";
  if (missing === "filesystem") f.kernel.filesystem = () => ({ type: 0xef53, bytes: 128 * 1024 * 1024 });
  if (missing === "oversize") f.kernel.filesystem = () => ({ type: 0x01021994, bytes: 129 * 1024 * 1024 });
  if (missing === "owner") f.kernel.uid = () => 2000;
  if (missing === "permissions") f.kernel.metadata = () => ({ directory: true, uid: 1000, mode: 0o777 });
  if (missing === "alias") f.kernel.realpath = () => "/other";
  if (missing === "prlimit") f.kernel.probe = async () => 1;
  await expect(f.limits.command(directory, ["git", "index-pack", "--stdin"])).rejects.toThrow("git_resource_limits_required");
});

// A complete single-blob pack, >32 MiB inflated but <16 MiB on the wire; never inflate it with an uncapped Git fixture.
function packBomb() {
  const blob = Buffer.alloc(40 * 1024 * 1024);
  const oid = createHash("sha1").update(`blob ${blob.length}\0`).update(blob).digest("hex");
  let size = blob.length, first = 0x30 | (size & 15); size = Math.floor(size / 16);
  const header: number[] = [];
  header.push(first | (size ? 128 : 0));
  while (size) { const byte = size & 127; size = Math.floor(size / 128); header.push(byte | (size ? 128 : 0)); }
  const pack = Buffer.concat([Buffer.from("5041434b0000000200000001", "hex"), Buffer.from(header), deflateSync(blob)]);
  return { oid, pack: Buffer.concat([pack, createHash("sha1").update(pack).digest()]) };
}

test.each(["preload", "push import"])("pack bomb meets the resource gate before inflation on %s", async path => {
  const bomb = packBomb(), limits = new FixtureGitProcessLimits();
  expect(bomb.pack.length).toBeLessThan(16 * 1024 * 1024);
  let gated = false;
  limits.beforeCommand = argv => {
    if (argv.includes("index-pack") || argv.includes("bundle")) {
      gated = true;
      // Fake a missing Linux enforcement boundary. No Git parser gets these bytes and no unlimited fallback runs.
      throw new AppError("git_resource_limits_required", 503);
    }
  };
  if (path === "preload") {
    const fetcher = async () => new Response(Buffer.concat([Buffer.from("0008NAK\n"), bomb.pack]), { headers: { "content-type": "application/x-git-upload-pack-result" } });
    await expect(repositoryBundle({ id: "repo", revision: 1, botId: "jit", active: true, registry: null, url: "https://github.com/fixture/repo.git", baseCommit: bomb.oid },
      undefined, new AbortController().signal, () => {}, fetcher, undefined, limits)).rejects.toThrow("git_resource_limits_required");
  } else {
    const mirror = new CodingGitMirror(limits);
    try {
      await expect(mirror.import(Buffer.concat([Buffer.from(`# v2 git bundle\n${bomb.oid} HEAD\n\n`), bomb.pack]), { headCommit: bomb.oid } as GitAction)).rejects.toThrow("git_resource_limits_required");
      expect(() => mirror.verifiedPath()).toThrow("git_objects_unverified");
    } finally { mirror.close(); }
  }
  expect(gated).toBe(true);
  expect(limits.commands).toHaveLength(2); // init and the gated reader; no inspection or fallback after failure.
});

test("a valid compressed commit with an oversized blob cannot become a verified push mirror", async () => {
  const limits = new FixtureGitProcessLimits(), directory = limits.createDirectory(); roots.push(directory);
  const git = async (args: string[]) => {
    const result = await brokerGit(directory, args, undefined, { limits });
    expect(result.code).toBe(0); return result.stdout.trim();
  };
  await git(["init", directory]);
  writeFileSync(join(directory, "blob"), Buffer.alloc(33 * 1024 * 1024));
  await git(["add", "blob"]);
  await git(["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "-m", "Oversized decoded control"]);
  const head = await git(["rev-parse", "HEAD"]);
  await git(["bundle", "create", join(directory, "valid.bundle"), "HEAD"]);
  const bundle = readFileSync(join(directory, "valid.bundle"));
  expect(bundle.length).toBeLessThan(16 * 1024 * 1024);
  const mirror = new CodingGitMirror(limits);
  try {
    await expect(mirror.import(bundle, { headCommit: head } as GitAction)).rejects.toThrow("git_decoded_objects_bound");
    expect(() => mirror.verifiedPath()).toThrow("git_objects_unverified");
    const commands = limits.commands.map(argv => argv.join(" "));
    expect(commands.some(command => command.includes("--batch-check=%(objectsize)"))).toBe(true);
    expect(commands.some(command => command.includes(" fsck ") || command.includes(" diff ") || command.includes(" push "))).toBe(false);
  } finally { mirror.close(); }
});
