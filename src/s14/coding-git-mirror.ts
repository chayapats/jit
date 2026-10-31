import { chmodSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "../errors";
import { artifactHash } from "./artifacts";
import { LinuxGitProcessLimits, type GitProcessLimits } from "./coding-git-limits";
import type { GitAction } from "./coding-git-types";

/** Runs data-only Git only after kernel memory/disk enforcement, with an empty environment and fixed config. */
export async function brokerGit(directory: string, args: string[], secret?: string,
  options: { input?: Uint8Array; signal?: AbortSignal; inspect?: (chunk: Uint8Array) => void; limits?: GitProcessLimits } = {}): Promise<{ code: number; stdout: string }> {
  const argv = await (options.limits ?? new LinuxGitProcessLimits()).command(directory, ["git", "-c", "pack.threads=1", "-c", "pack.windowMemory=16m", "-c", "pack.deltaCacheSize=16m", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "credential.helper=", "-c", "http.followRedirects=false", "-c", "protocol.allow=never", "-c", "transfer.fsckObjects=true", ...args]);
  const askpass = join(directory, "askpass.sh");
  if (secret !== undefined) writeFileSync(askpass, '#!/bin/sh\ncase "$1" in *Username*) printf "%s\\n" x-access-token;; *) printf "%s\\n" "$JIT_GIT_EFFECT_TOKEN";; esac\n', { mode: 0o700 });
  const proc = Bun.spawn(argv, {
    cwd: directory, env: { PATH: "/usr/local/bin:/usr/bin:/bin", HOME: directory, TMPDIR: directory, LANG: "C.UTF-8", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_SYSTEM: "/dev/null", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0",
      ...(secret === undefined ? {} : { GIT_ASKPASS: askpass, JIT_GIT_EFFECT_TOKEN: secret }) }, stdin: options.input ?? "ignore", stdout: "pipe", stderr: "ignore", detached: true,
  });
  const kill = () => { try { process.kill(-proc.pid, "SIGKILL"); } catch { try { proc.kill("SIGKILL"); } catch { /* Already settled. */ } } };
  const timer = setTimeout(kill, 60000);
  options.signal?.addEventListener("abort", kill, { once: true });
  if (options.signal?.aborted) kill();
  let stdout = "", overflow = false;
  let code: number;
  try {
    for await (const chunk of proc.stdout) {
      if (options.inspect) { options.inspect(chunk); continue; }
      if (Buffer.byteLength(stdout) + chunk.length > 65536) { overflow = true; kill(); break; }
      stdout += new TextDecoder().decode(chunk);
    }
  } catch (error) { kill(); throw error; }
  finally {
    code = await proc.exited;
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", kill);
  }
  if (overflow) throw new AppError("git_broker_output_bound", 409);
  return { code, stdout };
}

/** Fresh broker-owned bare mirror imports only verified objects and never workspace config, hooks or credentials. */
export class CodingGitMirror {
  readonly directory: string;
  readonly path: string;
  #verified = false;
  constructor(readonly limits: GitProcessLimits = new LinuxGitProcessLimits()) {
    this.directory = limits.createDirectory();
    chmodSync(this.directory, 0o700);
    this.path = join(this.directory, "mirror.git");
    mkdirSync(join(this.directory, "empty-template"), { mode: 0o700 });
  }

  /** All object-reading commands, including import, run under the same enforced resource boundary. */
  git(args: string[], options: Parameters<typeof brokerGit>[3] = {}) {
    return brokerGit(this.directory, args, undefined, { ...options, limits: this.limits });
  }

  /** Refuses oversized decoded object inventories before fsck/diff or credential release, without requesting object bodies. */
  async verifyObjectBytes(): Promise<void> {
    let total = 0, pending = "", count = 0;
    const countLine = () => {
      if (!/^(0|[1-9][0-9]*)$/.test(pending)) throw new AppError("git_objects_unverified", 409);
      const size = Number(pending);
      if (!Number.isSafeInteger(size) || size > 32 * 1024 * 1024 - total) throw new AppError("git_decoded_objects_bound", 409);
      total += size;
      count++;
      pending = "";
    };
    const result = await this.git(["-C", this.path, "cat-file", "--batch-all-objects", "--batch-check=%(objectsize)"], {
      inspect(chunk) {
        for (const byte of chunk) {
          if (byte === 10) countLine();
          else {
            if (byte < 48 || byte > 57 || pending.length >= 16) throw new AppError("git_objects_unverified", 409);
            pending += String.fromCharCode(byte);
          }
        }
      },
    });
    if (result.code !== 0) throw new AppError("git_objects_unverified", 409);
    if (pending) countLine();
    if (!count) throw new AppError("git_objects_unverified", 409);
  }

  /** Verifies the bundle, full commit identity, reachable objects and exact reviewed diff before credential release. */
  async import(bundle: Uint8Array, action: GitAction): Promise<void> {
    if (!bundle.length || bundle.length > 16777216) throw new AppError("git_bundle_bound", 409);
    const file = join(this.directory, "objects.bundle");
    writeFileSync(file, bundle, { mode: 0o600 });
    const git = async (args: string[]) => {
      const result = await this.git(args);
      if (result.code !== 0) throw new AppError("git_objects_unverified", 409);
      return result.stdout;
    };
    await git(["init", "--bare", `--template=${join(this.directory, "empty-template")}`, this.path]);
    await git(["-C", this.path, "bundle", "verify", file]);
    const heads = await git(["-C", this.path, "bundle", "list-heads", file]);
    if (heads.trim() !== `${action.headCommit} HEAD`) throw new AppError("git_bundle_head_mismatch", 409);
    await git(["-c", "protocol.file.allow=always", "-C", this.path, "fetch", "--no-tags", "--no-write-fetch-head", "--", file, `${action.headCommit}:refs/approved/head`]);
    await this.verifyObjectBytes();
    await git(["-C", this.path, "fsck", "--strict", "--no-reflogs"]);
    const head = await git(["-C", this.path, "rev-parse", "--verify", `${action.headCommit}^{commit}`]);
    if (head.trim() !== action.headCommit) throw new AppError("git_bundle_head_mismatch", 409);
    const diff = await git(["-C", this.path, "diff", "--no-ext-diff", "--no-textconv", "--binary", action.repository.baseCommit, action.headCommit, "--"]);
    if (artifactHash(new TextEncoder().encode(diff || "(empty diff)\n")) !== action.diffHash) throw new AppError("git_approved_diff_changed", 409);
    this.#verified = true;
  }

  /** Exposes only a verified service-owned mirror to the trusted remote transport, never the box's repository. */
  verifiedPath(): string {
    if (!this.#verified) throw new AppError("git_objects_unverified", 409);
    return this.path;
  }

  /** Removes ephemeral object copies and askpass code after settlement without touching the Bot workspace or vault. */
  close(): void { rmSync(this.directory, { recursive: true, force: true }); }
}
