import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BoxExecRequest, BoxExecResult } from "../../src/exec/box-runtime";
import type { FakeBoxExec } from "../../src/exec/fake-box-runtime";

/** The runner script shipped in the `base` image. */
export const runnerScript = join(import.meta.dir, "../../ops/box/runner");

/** Directories standing in for the box layout on the host: `/workspace`, `/tmp` and `/run/jit-runner`. */
export interface LocalBox { root: string; tmp: string; state: string; opSeconds?: number; pathPrefix?: string }

/** A fresh local stand-in; `tmp` is the real temporary directory so spill paths normalize like SCH01's golden. */
export function localBox(prefix = "jit-box-"): LocalBox {
  const base = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  const root = join(base, "workspace"), state = join(base, "state");
  Bun.spawnSync(["mkdir", "-p", root, state]);
  return { root, tmp: realpathSync(tmpdir()), state };
}

/** Runs `ops/box/runner` once on the host with a minimal environment, as `podman exec -i` runs it in a box. */
export async function runLocal(box: LocalBox, request: BoxExecRequest | { input: Uint8Array; signal?: AbortSignal }): Promise<BoxExecResult> {
  const proc = Bun.spawn(["sh", runnerScript, "--root", box.root, "--tmp", box.tmp, "--state", box.state, ...(box.opSeconds ? ["--op-seconds", String(box.opSeconds)] : [])], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { PATH: `${box.pathPrefix ? `${box.pathPrefix}:` : ""}${process.env.PATH ?? "/usr/bin:/bin"}`, LANG: "C.UTF-8" },
  });
  const kill = () => { try { proc.kill("SIGKILL"); } catch { /* Exited. */ } };
  request.signal?.addEventListener("abort", kill, { once: true });
  proc.stdin.write(request.input); await proc.stdin.end();
  const [stdout, stderr, exitCode] = await Promise.all([new Response(proc.stdout).bytes(), new Response(proc.stderr).bytes(), proc.exited]);
  request.signal?.removeEventListener("abort", kill);
  return { exitCode, stdout, stderr };
}

/** A `FakeBoxRuntime` exec handler that runs the real runner against `box`. */
export const localExec = (box: LocalBox): FakeBoxExec => (_handle, request) => runLocal(box, request);

/** Sends one JSON request to the runner and parses its single JSON response. */
export async function runnerCall(box: LocalBox, request: Record<string, unknown>): Promise<{ ok: boolean; result?: any; error?: { code: string } }> {
  const out = await runLocal(box, { input: new TextEncoder().encode(JSON.stringify({ v: 1, ...request })) });
  return JSON.parse(new TextDecoder().decode(out.stdout));
}
