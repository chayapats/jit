import { readinessCommands } from "../exec/readiness-cache";
import { createHash } from "node:crypto";
import { podmanClient, podmanReadiness, type PodmanReadiness } from "../exec/podman-client";
import { pinnedImagePattern } from "../exec/box-runtime";
import type { CommandRequest, CommandResult, CommandRunner } from "../exec/podman-runtime";
import type { AttachmentLimits } from "./limits";
import { receiveSanitizerOutput, sanitizerOutputBudget, sanitizerStreamLimit } from "./sanitizer-output";

/** Closed sanitizer input formats; paths are generated per-job directories, never owner-supplied names. */
export interface SanitizeJob { input: string; output: string; kind: "png" | "jpeg" | "webp" | "pdf"; pixels: number }
/** A disposable, networkless parser. Cleanup uncertainty must reject with sanitizer_cleanup_failed and retain work. */
export interface AttachmentSanitizerRuntime {
  status?(): Promise<PodmanReadiness>;
  available(): Promise<boolean>;
  reset(): Promise<void>;
  run(job: SanitizeJob, signal?: AbortSignal): Promise<void>;
}
/** Closed reason identifiers accepted from the parser; neither diagnostics nor content enter audit rows. */
export const sanitizerReasons = new Set(["sanitize_timeout", "sanitize_out_of_memory", "image_too_many_pixels", "image_decode_failed",
  "pdf_extract_failed", "sanitize_output_invalid", "sanitizer_unavailable"]);

/** Sanitizer-only stdout allowance; ordinary control commands retain their 64 KiB diagnostic cap. */
export type SanitizerCommandRunner = ((argv: readonly string[], request: CommandRequest & { stdoutBytes?: number }) => Promise<CommandResult>) & Pick<CommandRunner, "client">;

/** Rootless CLI with a fixed environment, bounded diagnostics and abortable pipes; never forwards service secrets. */
export function sanitizerCommandRunner(binary = "podman", serviceEnv: Record<string, string | undefined> = process.env): SanitizerCommandRunner {
  const client = podmanClient(serviceEnv);
  const run: SanitizerCommandRunner = async (argv, request) => {
    const proc = Bun.spawn([binary, ...client.argv, ...argv], { env: client.env, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
    const reader = proc.stdout.getReader();
    const kill = () => {
      try { proc.kill("SIGKILL"); } catch { /* Already exited. */ }
      void reader.cancel().catch(() => undefined);
    };
    const timer = setTimeout(kill, request.timeoutMs); request.signal?.addEventListener("abort", kill, { once: true });
    if (request.signal?.aborted) kill();
    try {
      const chunks: Uint8Array[] = []; let bytes = 0;
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        bytes += value.length;
        if (bytes > (request.stdoutBytes ?? 65536)) { kill(); throw new Error(request.stdoutBytes ? "sanitize_output_invalid" : "sanitizer_unavailable"); }
        chunks.push(value);
      }
      return { exitCode: await proc.exited, stdout: Buffer.concat(chunks), stderr: new Uint8Array() };
    } finally { clearTimeout(timer); request.signal?.removeEventListener("abort", kill); kill(); reader.releaseLock(); await proc.exited; }
  };
  return Object.assign(run, { client });
}

/**
 * Runs only the digest-pinned base image with private read-only input and capped output tmpfs, without network.
 * Output returns through a bounded stream and reaches host disk only after cleanup. A stable installation name
 * fences an orphan from a prior process before any new parser starts. Service queue ownership fences callers.
 */
export class PodmanAttachmentSanitizer implements AttachmentSanitizerRuntime {
  readonly name: string;
  readonly command: SanitizerCommandRunner;
  constructor(readonly image: string, installation: string, readonly limits: AttachmentLimits,
    readonly probeCommand: SanitizerCommandRunner = sanitizerCommandRunner(),
    readonly timer: (callback: () => void, ms: number) => () => void = (callback, ms) => { const t = setTimeout(callback, ms); return () => clearTimeout(t); }) {
    if (!pinnedImagePattern.test(image)) throw new Error("sanitizer_unavailable");
    this.command = readinessCommands(this, probeCommand);
    this.name = `jit-sanitize-${createHash("sha256").update(installation).digest("hex").slice(0, 32)}`;
  }
  async available(): Promise<boolean> {
    return (await this.status()).state === "ready";
  }
  /** Reports a missing executable, stopped API, host isolation failure or missing sanitizer image independently. */
  async status(): Promise<PodmanReadiness> {
    const readiness = await podmanReadiness(this.probeCommand);
    if (readiness.state !== "ready") return readiness;
    try {
      const image = await this.probeCommand(["image", "inspect", "--format", "json", this.image], { timeoutMs: 5000 });
      return image.exitCode === 0 && JSON.parse(new TextDecoder().decode(image.stdout))[0]?.Config?.Labels?.["jit.sanitize.version"] === "2"
        ? readiness : { state: "unavailable", reason: "runtime" };
    } catch { return { state: "unavailable", reason: "runtime" }; }
  }
  async reset(): Promise<void> {
    // `--ignore` succeeds for an absent container; other failures must block work-directory cleanup/publication.
    try {
      const result = await this.command(["rm", "--force", "--ignore", this.name], { timeoutMs: 5000 });
      if (result.exitCode !== 0) throw new Error("sanitizer_cleanup_failed");
    } catch { throw new Error("sanitizer_cleanup_failed"); }
  }
  async run(job: SanitizeJob, signal?: AbortSignal): Promise<void> {
    for (const path of [job.input, job.output]) if (!path.startsWith("/") || /[,\n\r]/.test(path)) throw new Error("sanitize_output_invalid");
    const jobId = crypto.randomUUID();
    const outputBytes = sanitizerOutputBudget(job.kind);
    // tmpfs is charged to the container cgroup. Add its full cap to the configured parser memory budget.
    const memoryBytes = this.limits.sanitizerMemoryMB * 1024 * 1024 + outputBytes;
    const args = ["run", "--label", `jit.sanitize.job=${jobId}`, "--rm", "--name", this.name, "--pull=never", "--network", "none", "--cap-drop=ALL",
      "--security-opt=no-new-privileges", "--read-only", "--http-proxy=false", "--tmpfs", "/tmp:rw,nosuid,nodev,noexec,size=32m,mode=1777",
      "--tmpfs", "/run:rw,nosuid,nodev,noexec,size=1m,mode=1777",
      // Podman 4.9 rejects tmpfs nr_inodes=/uid=/gid=. The size cap stays; the file count is bounded by the stdout
      // record protocol (at most three or four named records) and the container memory cgroup that charges tmpfs.
      "--mount", `type=tmpfs,destination=/out,tmpfs-size=${outputBytes},tmpfs-mode=0700,U=true,noexec,nosuid,nodev`,
      `--memory=${memoryBytes}`, `--memory-swap=${memoryBytes}`, "--pids-limit=64", "--cpus=1", "--userns=keep-id:uid=1000,gid=1000",
      "--user", "1000:1000", "--log-driver=none", "--workdir", "/", "--env", "HOME=/tmp", "--env", "LANG=C.UTF-8",
      "--mount", `type=bind,source=${job.input},destination=/in,ro=true`,
      this.image, "/opt/jit/sanitize", job.kind, String(job.pixels), String(this.limits.sanitizerSeconds), "--stream"];
    const abort = new AbortController(); let timedOut = false;
    let interrupt!: () => void;
    const interrupted = new Promise<never>((_, reject) => { interrupt = () => reject(new Error("sanitize_timeout")); });
    const cancel = this.timer(() => { timedOut = true; interrupt(); }, this.limits.sanitizerSeconds * 1000);
    const stop = () => { timedOut = true; interrupt(); };
    signal?.addEventListener("abort", stop, { once: true });
    let execution: Promise<CommandResult> | undefined;
    let output: Uint8Array | undefined;
    try {
      if (signal?.aborted) { timedOut = true; throw new Error("sanitize_timeout"); }
      execution = this.command(args, { timeoutMs: (this.limits.sanitizerSeconds + 5) * 1000, signal: abort.signal, stdoutBytes: sanitizerStreamLimit(job.kind) });
      const result = await Promise.race([execution, interrupted]);
      if (result.exitCode !== 0) throw new Error(result.exitCode === 137 ? "sanitize_out_of_memory" : result.exitCode === 142 ? "sanitize_timeout" : result.exitCode === 65 ? "sanitize_output_invalid" : "sanitizer_unavailable");
      output = result.stdout;
    } finally {
      cancel(); signal?.removeEventListener("abort", stop);
      // Stop the launcher first so it cannot create a late container after cleanup. Killing the CLI alone does
      // not stop a running container: explicitly kill, then remove it before releasing any work directory.
      if (timedOut) { abort.abort(); await execution?.catch(() => undefined); }
      try {
        // A new service may already have removed our orphan and reused the installation name. Select only this
        // attempt's immutable container ID: late cleanup must never kill the successor that owns that name now.
        const listed = await this.command(["ps", "--all", "--no-trunc", "--filter", `label=jit.sanitize.job=${jobId}`, "--format", "{{.ID}}"], { timeoutMs: 5000 });
        const id = new TextDecoder().decode(listed.stdout).trim();
        if (listed.exitCode !== 0 || (id && !/^[a-f0-9]{64}$/.test(id))) throw new Error("sanitizer_cleanup_failed");
        if (id) {
          if (timedOut) await this.command(["kill", id], { timeoutMs: 5000 }).catch(() => undefined);
          const removed = await this.command(["rm", "--force", "--ignore", id], { timeoutMs: 5000 });
          if (removed.exitCode !== 0) throw new Error("sanitizer_cleanup_failed");
        }
      } catch { throw new Error("sanitizer_cleanup_failed"); }
      finally { abort.abort(); }
    }
    receiveSanitizerOutput(output!, job.output, job.kind);
  }
}
