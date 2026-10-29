import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildPackage } from "../bun-build";
import { spawnRunner, type CommandRunner } from "../../../src/ops/supervisor";

/**
 * Builds release assets only, without publishing or downloading dependencies. The tarball has install.sh and
 * an unmodified service artifact; host-specific dependency sealing happens during install. Publish all three
 * output files together over HTTPS. A GitHub release checksum authenticates the same trusted release source.
 */
export async function buildInstallerRelease(source: string, output: string, releaseTag: string, run: CommandRunner = spawnRunner): Promise<{ archive: string; checksum: string; bootstrap: string }> {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(releaseTag)) throw new Error("invalid-release-tag");
  const out = resolve(output), stage = mkdtempSync(join(tmpdir(), "jit-install-release-"));
  mkdirSync(out, { recursive: true });
  const archive = join(out, "jit-install.tar.gz"), checksum = `${archive}.sha256`, bootstrap = join(out, "install.sh");
  if ([archive, checksum, bootstrap].some(path => existsSync(path))) { rmSync(stage, { recursive: true, force: true }); throw new Error("release-output-exists"); }
  try {
    buildPackage({ srcDir: resolve(source), outDir: join(stage, "artifact"), engineContract: "jit.schway.bridge/v1", engineRevision: null });
    const script = readFileSync(join(resolve(source), "install.sh"), "utf8").replace("release_url=https://github.com/chayapats/jit/releases/latest/download", `release_url=https://github.com/chayapats/jit/releases/download/${releaseTag}`);
    writeFileSync(join(stage, "install.sh"), script, { mode: 0o755 });
    const result = await run(["tar", "-czf", archive, "-C", stage, "."], { timeoutMs: 120_000 });
    if (result.exitCode !== 0) throw new Error("release-archive-failed");
    writeFileSync(checksum, `${createHash("sha256").update(readFileSync(archive)).digest("hex")}  jit-install.tar.gz\n`, { mode: 0o644 });
    copyFileSync(join(stage, "install.sh"), bootstrap); chmodSync(bootstrap, 0o755);
    return { archive, checksum, bootstrap };
  } finally { rmSync(stage, { recursive: true, force: true }); }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 5) throw new Error("invalid-release-arguments");
    console.log(JSON.stringify(await buildInstallerRelease(process.argv[2]!, process.argv[3]!, process.argv[4]!)));
  } catch { console.error("Release build failed. Use bun ops/package/installer/release.ts <source> <fresh-output-directory> <release-tag>."); process.exitCode = 1; }
}
