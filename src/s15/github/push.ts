import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { CodingGitMirror } from "../../s14/coding-git-mirror";
import { LinuxGitProcessLimits, type GitProcessLimits } from "../../s14/coding-git-limits";
import type { AdapterResult, Ref } from "../policy";
import type { GithubEffect, GithubEffectResult, GithubRepository } from "./types";
import type { GithubProtectedPush } from "./github-api";
import { canonical, digest, fail, oid } from "./validation";

/**
 * Actual protected Git push: fresh bounded bare mirror, verified object bytes/fsck/ancestry/diff,
 * no imported hooks/config, exact force-with-lease. The credential exists only in the protected Git
 * child's environment. Command preparation precedes POLICY's final synchronous spawn fence.
 */
export class ProtectedGithubPush implements GithubProtectedPush {
  constructor(private readonly options: { bundle(ref: Ref): Uint8Array; limits?: GitProcessLimits; fetch?: typeof fetch; timeoutMs?: number }) {}
  async push(effect: GithubEffect, credential: string, dispatch: (send: () => Promise<GithubEffectResult>) => Promise<AdapterResult>): Promise<AdapterResult> {
    if (effect.operation.kind !== "push" || effect.operation.branch !== effect.branch || effect.branch === effect.target) fail("github_ref_denied");
    const limits = this.options.limits ?? new LinuxGitProcessLimits(), mirror = new CodingGitMirror(limits);
    const outcome = (state: GithubEffectResult["outcome"]): GithubEffectResult => ({ key: effect.key, effectHash: digest(canonical(effect)), outcome: state, receipt: state === "succeeded" ? `github:ref:${effect.branch}:${effect.head}` : null });
    try {
      const bundle = this.options.bundle(effect.bundle); if (!bundle.length || bundle.length > 16 * 1024 * 1024) fail("github_bundle_too_large");
      const file = join(mirror.directory, "approved.bundle"); writeFileSync(file, bundle, { mode: 0o600 });
      const git = async (args: string[]) => { const r = await mirror.git(args); if (r.code !== 0) fail("github_objects_unverified"); return r.stdout; };
      await git(["init", "--bare", `--template=${join(mirror.directory, "empty-template")}`, mirror.path]);
      await git(["-C", mirror.path, "bundle", "verify", file]);
      if ((await git(["-C", mirror.path, "bundle", "list-heads", file])).trim() !== `${effect.head} HEAD`) fail("github_bundle_head_changed");
      await git(["-c", "protocol.file.allow=always", "-C", mirror.path, "fetch", "--no-tags", "--no-write-fetch-head", "--", file, `${effect.head}:refs/approved/head`]);
      await mirror.verifyObjectBytes(); await git(["-C", mirror.path, "fsck", "--strict", "--no-reflogs"]);
      await git(["-C", mirror.path, "merge-base", "--is-ancestor", effect.base, effect.head]);
      const diff = await git(["-C", mirror.path, "diff", "--no-ext-diff", "--no-textconv", "--binary", effect.base, effect.head, "--"]);
      if (createHash("sha256").update(diff).digest("hex") !== effect.diffHash) fail("github_diff_changed");
      const ref = `refs/heads/${effect.branch}`;
      const argv = await limits.command(mirror.directory, ["git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "http.followRedirects=false", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-C", mirror.path, "push", "--porcelain", "--atomic", "--no-verify", `--force-with-lease=${ref}:${effect.operation.previous ?? ""}`, "--", `https://github.com/${effect.repository}.git`, `${effect.head}:${ref}`]);
      const askpass = join(mirror.directory, "askpass.sh"); writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token;; *) printf "%s\\n" "$JIT_GITHUB_SECRET";; esac\n', { mode: 0o700 });
      return await dispatch(() => {
        // No await between the final POLICY guard and the actual protected process spawn.
        const process = Bun.spawn(argv, { cwd: mirror.directory, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: mirror.directory, TMPDIR: mirror.directory, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: askpass, JIT_GITHUB_SECRET: credential }, stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true });
        return (async () => {
          let timedOut = false, bytes = 0, stdout = "";
          const kill = () => { timedOut = true; try { globalThis.process.kill(-process.pid, "SIGKILL"); } catch { process.kill("SIGKILL"); } };
          const timer = setTimeout(kill, this.options.timeoutMs ?? 60000);
          try { for await (const c of process.stdout) { bytes += c.length; if (bytes > 65536) { kill(); break; } stdout += new TextDecoder().decode(c); } }
          finally { await process.exited; clearTimeout(timer); }
          if (timedOut) return outcome("unknown");
          return outcome(process.exitCode === 0 ? "succeeded" : stdout.split("\n").some(line => line.startsWith("!\t") && /\[rejected\]|\[remote rejected\]/.test(line)) ? "rejected" : "unknown");
        })();
      });
    } finally { mirror.close(); }
  }
  /** Exact fixed-origin ref read; 404 does not make a prior unknown push retryable. */
  async readHead(repo: GithubRepository, branch: string, credential: string): Promise<string | null> {
    const r = await (this.options.fetch ?? fetch)(`https://api.github.com/repos/${repo.name}/git/ref/heads/${encodeURIComponent(branch)}`, { redirect: "error", signal: AbortSignal.timeout(30000), headers: { Authorization: `Bearer ${credential}`, Accept: "application/vnd.github+json" } });
    if (r.status === 404) return null; if (r.status !== 200) fail("github_read_unavailable");
    const value = await r.json() as { object?: { sha?: string } }; oid(value.object?.sha); return value.object.sha;
  }
}
