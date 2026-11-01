import { join } from "node:path";
import { CdpClient } from "../../src/exec/cdp-stream";
import { AppError } from "../../src/errors";
import { InputEvidenceTransport } from "../../ops/box/input-evidence-transport";
import { writeInputEvidenceOutcome } from "../../ops/box/s14-input-evidence";
import { inputEvidencePipe } from "./s14-input-evidence";

// Isolated output fixture: scripted pipes only; no host preflight, commands, credentials or live runtime.
const [kind, directory] = process.argv.slice(2);
if (!["timeout", "pipe", "success"].includes(kind!) || !directory) throw new Error("invalid outcome fixture");
let expire: (() => void) | undefined;
const transport = new InputEvidenceTransport(callback => { expire = callback; return () => {}; });
const pipe = inputEvidencePipe(kind === "success");
const stream = transport.streams(() => pipe.stream)(["exec", "-i", `jit-s14-${"a".repeat(32)}-browser`, "/opt/jit/cdp-relay"], {});
const client = new CdpClient(stream);
let reason: string | null = null;
try {
  const gate = kind === "success" ? undefined : transport.arm("Target.attachToTarget");
  const reply = client.send("Target.getTargets", { private: "fixture-private-protocol-body" }).catch(error => error);
  if (kind === "timeout") expire!();
  if (kind === "pipe") stream.close();
  if (gate) {
    try { await gate.reached; } catch (error) { if (!(error instanceof AppError)) throw error; reason = error.code; }
  }
  await reply;
} finally { transport.close(); await transport.join(); }
writeInputEvidenceOutcome({ resultPath: join(directory, "result.json"), statePath: join(directory, "private.json"),
  state: { contract: "ops.s14-input-evidence-state/v1", runId: "a".repeat(32), phase: kind === "success" ? "passed" : "failed",
    password: kind === "success" ? null : "b".repeat(64) } }, {
  architecture: "x64", build: { artifactId: "fixture-artifact", contentHash: "c".repeat(64), schema: 17, bun: Bun.version,
    images: { base: `localhost/fixture-base@sha256:${"d".repeat(64)}`, browser: `localhost/fixture-browser@sha256:${"e".repeat(64)}`, buildInputsHash: "f".repeat(64) } },
  outcome: kind === "success" ? "integration_cases_completed" : "failed", cleanupConfirmed: true, reason,
  transportKernelFacts: [], controlledAssertions: [], unrun: ["physical_transport"] }, transport);
