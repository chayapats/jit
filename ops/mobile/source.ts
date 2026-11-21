import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, join } from "node:path";

/** Private build snapshot plus public provenance facts. The directory/archive themselves never ship. */
export interface MobileBuildSource { directory: string; archiveSha256: string; files: number; bytes: number }
const limits = Object.freeze({ files: 4096, bytes: 128 * 1048576, fileBytes: 64 * 1048576, treeBytes: 2 * 1048576 });
const fail = (code: string): never => { throw Error(code); };

/**
 * Materializes only committed ordinary files in a new private source tree. Ignored native projects,
 * node_modules, local edits, symlinks, submodules and archive-attribute substitutions cannot become
 * release source. Every extracted byte/mode is checked against the selected immutable Git tree before
 * any package manager, Expo plugin or native compiler runs. Existing local native projects are untouched.
 */
export function prepareMobileBuildSource(source: string, privateRoot: string, commit: string): MobileBuildSource {
  if (!/^[a-f0-9]{40}$/.test(commit) || ![source, privateRoot].every(path => isAbsolute(path) && realpathSync(path) === path)) return fail("mobile_build_source_invalid");
  const root = lstatSync(privateRoot), directory = join(privateRoot, "source"), archive = join(privateRoot, "reviewed-source.tar");
  if (!root.isDirectory() || root.isSymbolicLink() || root.mode & 0o077 || existsSync(directory) || existsSync(archive)) return fail("mobile_build_source_destination_invalid");
  const git = (args: string[], maximum = limits.treeBytes) => {
    const result = Bun.spawnSync(["git", "-C", source, ...args], { stdout: "pipe", stderr: "ignore", timeout: 30000, maxBuffer: maximum });
    if (result.exitCode !== 0 || result.stdout.length > maximum) return fail("mobile_build_source_unavailable");
    return result.stdout;
  };
  if (git(["status", "--porcelain"]).length) return fail("mobile_source_dirty");
  if (git(["rev-parse", "HEAD"]).toString().trim() !== commit) return fail("mobile_build_source_changed");
  const raw = new TextDecoder("utf-8", { fatal: true }).decode(git(["ls-tree", "-rz", "-l", "--full-tree", commit]));
  const expected = new Map<string, { sha1: string; bytes: number; executable: boolean }>(); let total = 0;
  for (const entry of raw.split("\0").filter(Boolean)) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\s+([0-9]+)\t(.+)$/u.exec(entry);
    if (!match) return fail("mobile_build_source_mode_invalid");
    const [, mode, sha1, size, path] = match, bytes = Number(size), parts = path!.split("/");
    if (parts.some(part => !part || part === "." || part === ".." || part === ".git" || part === "node_modules") || /[\u0000-\u001f\u007f\\]/u.test(path!) || /^clients\/mobile\/(?:ios|android)(?:\/|$)/.test(path!)) return fail("mobile_build_source_path_invalid");
    total += bytes;
    if (!Number.isSafeInteger(bytes) || bytes > limits.fileBytes || total > limits.bytes || expected.size >= limits.files || expected.has(path!)) return fail("mobile_build_source_limit");
    expected.set(path!, { sha1: sha1!, bytes, executable: mode === "100755" });
  }
  if (!expected.size) return fail("mobile_build_source_invalid");
  git(["-c", "core.attributesFile=/dev/null", "-c", "tar.umask=0022", "archive", "--format=tar", `--output=${archive}`, commit]);
  const archiveInfo = lstatSync(archive);
  if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.nlink !== 1 || archiveInfo.size > limits.bytes + limits.files * 4096) return fail("mobile_build_source_limit");
  chmodSync(archive, 0o600); mkdirSync(directory, { mode: 0o700 });
  const extracted = Bun.spawnSync(["/usr/bin/tar", "--no-same-owner", "-xpf", archive, "-C", directory], { stdout: "ignore", stderr: "ignore", timeout: 30000 });
  if (extracted.exitCode !== 0) return fail("mobile_build_source_unavailable");
  const seen = new Set<string>();
  const inspect = (relative: string, depth: number): void => {
    if (depth > 32) fail("mobile_build_source_limit");
    for (const name of readdirSync(join(directory, relative))) {
      const path = relative ? `${relative}/${name}` : name, full = join(directory, path), info = lstatSync(full);
      if (info.isSymbolicLink()) fail("mobile_build_source_mode_invalid");
      if (info.isDirectory()) { inspect(path, depth + 1); continue; }
      const selected = expected.get(path);
      if (!selected || !info.isFile() || info.nlink !== 1 || info.size !== selected.bytes || (info.mode & 0o777) !== (selected.executable ? 0o755 : 0o644) || seen.size >= limits.files) fail("mobile_build_source_mismatch");
      const bytes = readFileSync(full), digest = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
      if (digest !== selected!.sha1) fail("mobile_build_source_mismatch");
      seen.add(path);
    }
  };
  inspect("", 0);
  if (seen.size !== expected.size) return fail("mobile_build_source_mismatch");
  return { directory, archiveSha256: createHash("sha256").update(readFileSync(archive)).digest("hex"), files: seen.size, bytes: total };
}
