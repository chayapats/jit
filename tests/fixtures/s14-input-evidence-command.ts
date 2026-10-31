import { AppError } from "../../src/errors";
import { inputEvidenceCommandRunner } from "../../ops/box/input-evidence-commands";

// Isolated deterministic fixture: no process is spawned by the command runner.
const originalSpawn = Bun.spawn, originalNow = performance.now;
let now = 0;
performance.now = () => now;
Bun.spawn = (() => ({
  stdout: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
  stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }),
  stdin: null,
  // Microtask settlement runs before the real timeout callback, even when monotonic time has expired.
  exited: Promise.resolve().then(() => { now = Number(process.argv[2]); return 0; }),
  kill() {},
})) as unknown as typeof Bun.spawn;
try {
  await inputEvidenceCommandRunner()(["info"], { timeoutMs: 1 });
  console.log(JSON.stringify({ code: "success" }));
} catch (error) {
  if (!(error instanceof AppError)) throw error;
  console.log(JSON.stringify({ code: error.code }));
} finally { Bun.spawn = originalSpawn; performance.now = originalNow; }
