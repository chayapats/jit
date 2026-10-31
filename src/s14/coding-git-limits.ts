import { lstatSync, mkdtempSync, realpathSync, statfsSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "../errors";

/** Trusted service-only resource boundary; fixtures replace enforcement explicitly, never through HTTP/model data. */
export interface GitProcessLimits {
  createDirectory(): string;
  command(directory: string, argv: string[]): Promise<string[]>;
}

/** Kernel observation/probe seam for deterministic non-Linux tests; production always uses local system calls. */
export interface GitLimitKernel {
  platform: string;
  uid(): number;
  realpath(path: string): string;
  metadata(path: string): { directory: boolean; uid: number; mode: number };
  filesystem(path: string): { type: number; bytes: number };
  probe(argv: string[]): Promise<number>;
}
const kernel: GitLimitKernel = {
  platform: process.platform,
  uid: () => process.getuid!(),
  realpath: realpathSync,
  metadata(path) { const stat = lstatSync(path); return { directory: stat.isDirectory(), uid: stat.uid, mode: stat.mode }; },
  filesystem(path) { const fs = statfsSync(path); return { type: fs.type, bytes: fs.blocks * fs.bsize }; },
  async probe(argv) { return Bun.spawn(argv, { env: {}, stdin: "ignore", stdout: "ignore", stderr: "ignore" }).exited; },
};

const memoryBytes = 256 * 1024 * 1024, diskBytes = 128 * 1024 * 1024;
const refuse = (): never => { throw new AppError("git_resource_limits_required", 503); };

/** Linux RLIMIT_AS/FSIZE/CORE precede exec; every writable Git path lives on a private kernel-bounded tmpfs. */
export class LinuxGitProcessLimits implements GitProcessLimits {
  constructor(readonly root = process.env.JIT_S14_GIT_SCRATCH, readonly system: GitLimitKernel = kernel) {}

  private verify(): string {
    try {
      if (this.system.platform !== "linux" || !this.root || !this.root.startsWith("/") || this.system.realpath(this.root) !== this.root) return refuse();
      const stat = this.system.metadata(this.root), fs = this.system.filesystem(this.root);
      // Total filesystem capacity, not a per-file ceiling or post-inflation accounting.
      if (!stat.directory || stat.uid !== this.system.uid() || (stat.mode & 0o077) !== 0 ||
          fs.type !== 0x01021994 || !Number.isSafeInteger(fs.bytes) || fs.bytes <= 0 || fs.bytes > diskBytes) return refuse();
      return this.root;
    } catch { return refuse(); }
  }

  createDirectory(): string { return mkdtempSync(join(this.verify(), "jit-s14-git-")); }

  async command(directory: string, argv: string[]): Promise<string[]> {
    const root = this.verify();
    if (!directory.startsWith(`${root}/jit-s14-git-`) || this.system.realpath(directory) !== directory) return refuse();
    // Prove util-linux prlimit can establish the same hard/soft limits before any object reader is spawned.
    const prefix = ["/usr/bin/prlimit", `--as=${memoryBytes}:${memoryBytes}`, `--fsize=${diskBytes}:${diskBytes}`, "--core=0:0", "--"];
    try {
      if (await this.system.probe([...prefix, "/bin/true"]) !== 0) return refuse();
    } catch { return refuse(); }
    return [...prefix, ...argv];
  }
}
