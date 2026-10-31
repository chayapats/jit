import { AppError } from "../../src/errors";
import { podmanClient } from "../../src/exec/podman-client";
import type { CommandRunner } from "../../src/exec/podman-runtime";

/** Actual same-host Podman commands with bounded pipe collection, original client allowlist and joined process settlement. */
export function inputEvidenceCommandRunner(): CommandRunner {
  const client = podmanClient(process.env);
  const run: CommandRunner = async (argv, request) => {
    if (!Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || (request.stdin?.length ?? 0) > 8192) throw new AppError("input_evidence_command_bound");
    const deadline = performance.now() + Math.min(request.timeoutMs, 30000);
    const proc = Bun.spawn(["podman", ...client.argv, ...argv], { env: client.env, stdin: request.stdin ? "pipe" : "ignore", stdout: "pipe", stderr: "pipe" });
    let reason: string | null = null;
    const kill = () => { try { proc.kill("SIGKILL"); } catch { /* Exited already. */ } };
    const cancel = () => { reason ??= "input_evidence_command_cancelled"; kill(); };
    const timer = setTimeout(() => { reason ??= "input_evidence_command_timeout"; kill(); }, Math.max(0, deadline - performance.now()));
    request.signal?.addEventListener("abort", cancel, { once: true });
    if (request.signal?.aborted) cancel();
    let bytes = 0;
    const collect = async (stream: ReadableStream<Uint8Array>) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        bytes += chunk.length;
        if (bytes > 1048576) { reason ??= "input_evidence_command_output_bound"; kill(); continue; }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    };
    const stdout = collect(proc.stdout), stderr = collect(proc.stderr);
    const input = (async () => { if (request.stdin && proc.stdin) { proc.stdin.write(request.stdin); await proc.stdin.end(); } })();
    try {
      const outcomes = await Promise.allSettled([stdout, stderr, proc.exited, input]);
      // Settlement microtasks may run before an overdue timer when the event loop was blocked.
      if (performance.now() >= deadline) reason ??= "input_evidence_command_timeout";
      if (reason) throw new AppError(reason);
      if (outcomes.some(outcome => outcome.status === "rejected")) throw new AppError("input_evidence_command_failed");
      return { stdout: (outcomes[0] as PromiseFulfilledResult<Buffer>).value, stderr: (outcomes[1] as PromiseFulfilledResult<Buffer>).value, exitCode: (outcomes[2] as PromiseFulfilledResult<number>).value };
    } finally { clearTimeout(timer); request.signal?.removeEventListener("abort", cancel); }
  };
  return Object.assign(run, { client });
}
