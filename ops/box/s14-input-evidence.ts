import { join } from "node:path";
import { AppError } from "../../src/errors";
import { BotPodmanRuntime } from "../../src/s14/computer-podman";
import { S14Store } from "../../src/s14/store";
import { acquireS14RuntimeLock } from "../../src/s14/runtime-lock";
import { podmanStreamRunner } from "../../src/exec/podman-runtime";
import { inputEvidenceCommandRunner } from "./input-evidence-commands";
import { cleanupInputEvidence, inputEvidenceApplication, runInputEvidenceCases, type InputEvidenceResults } from "./input-evidence-cases";
import { InputEvidenceProcesses, requireInputEvidenceInstallation, requireUnusedInputEvidencePool } from "./input-evidence-host";
import { prepareInputEvidenceState, writeInputEvidencePrivate } from "./input-evidence-state";
import { InputEvidenceTransport } from "./input-evidence-transport";

const check = (ok: unknown, reason: string) => { if (!ok) throw new AppError(reason); };
const rid = () => crypto.randomUUID().replaceAll("-", "");
const forbidden = (): never => { throw new AppError("input_evidence_forbidden_native_port"); };

// Operator entrypoint only. Importing this file never probes a host or starts a runtime.
async function evidenceMain(totalDeadline: number): Promise<void> {
  check(process.argv.slice(2).length === 0 || process.argv.slice(2).join() === "--cleanup-only", "input_evidence_arguments_refused");
  const cleanupOnly = process.argv[2] === "--cleanup-only";
  const { config, database, build } = await requireInputEvidenceInstallation(cleanupOnly);
  const release = acquireS14RuntimeLock(database);
  let store: S14Store | undefined;
  const transport = new InputEvidenceTransport(); // Real wall clock only; no live fake-clock configuration.
  const actualCommands = inputEvidenceCommandRunner();
  const results: InputEvidenceResults = { transportKernelFacts: [], controlledAssertions: [], unrun: ["model_driven_product_journey", "website_integration_visible_scrolling", "owner_UI_acceptance", "live_effect", "reboot", "five_minute_idle_measurement"] };
  let interrupted = false;
  const cancel = () => { interrupted = true; transport.abort(); };
  // Admission stops at 180 s; the final 60 s is cleanup only. A stuck kernel/pipe never earns a pass.
  const deadline = setTimeout(cancel, 180000);
  process.on("SIGTERM", cancel); process.on("SIGINT", cancel);
  try {
    requireUnusedInputEvidencePool(database);
    // A fresh installation must have no orphan computer/registry container, even without DB claims.
    const inventory = await actualCommands(["ps", "--all", "--filter", "name=jit-s14-", "--format", "{{.Names}}"], { timeoutMs: 5000 });
    check(inventory.exitCode === 0 && inventory.stdout.length <= 4096, "input_evidence_container_inventory_unavailable");
    if (!cleanupOnly) check(new TextDecoder().decode(inventory.stdout).trim() === "", "input_evidence_orphan_runtime_cleanup_required");
    const privateState = prepareInputEvidenceState(join(config.stateDirectory, "input-evidence"), cleanupOnly);
    store = new S14Store(privateState.storePath);
    const runtime = new BotPodmanRuntime({ dataRoot: config.s14!.computerRoot,
      protectedPaths: [config.stateDirectory, config.backupDirectory, config.s14!.vaultDirectory, config.s14!.gitScratch],
      workspaceImage: config.s14!.images!.base, browserImage: config.s14!.images!.browser,
      run: transport.commands(actualCommands), streams: transport.streams(podmanStreamRunner()) });
    const app = inputEvidenceApplication(store, runtime);
    const processes = new InputEvidenceProcesses(actualCommands);
    let actor: ReturnType<typeof app.authenticate>["actor"] | undefined;
    let success = false, cleanup = false, reason: string | null = null;
    try {
      if (!cleanupOnly) await app.provisionOwner(privateState.state.password!);
      actor = app.authenticate(await app.login(privateState.state.password!)).actor;
      if (cleanupOnly) {
        const known = app.computers.view(actor, "jit").computer;
        const names = new TextDecoder().decode(inventory.stdout).trim().split("\n").filter(Boolean);
        check(names.every(name => known && ["workspace", "browser", "registry", "registry-proxy"].some(role => name === `jit-s14-${known.id}-${role}`)), "input_evidence_foreign_orphan_runtime_refused");
        if (known) await processes.remember(known.id, false);
      }
      // Cleanup-only uses exclusive-boot reconciliation and exact commands; it never resumes an input case.
      await app.recovery.boot({ open: forbidden }); await app.computers.drain();
      if (!cleanupOnly) {
        const setup = app.execute(actor, { kind: "setup", requestId: rid(), expectedRevision: 0,
          payload: { ownerName: "Synthetic input evidence", language: "th", routeId: "evidence", capabilities: { tools: ["computer", "effect_publish"], resources: [] } } });
        await runInputEvidenceCases(app, actor, setup.conversation!.id, transport, processes, results);
        check(!interrupted, "input_evidence_interrupted"); success = true;
      }
    } catch (error) { reason = error instanceof AppError ? error.code : "input_evidence_failed"; }
    finally {
      transport.close();
      await transport.join();
      try {
        check(actor, "input_evidence_cleanup_authentication_required");
        await cleanupInputEvidence(app, actor!, config.s14!.computerRoot, id => processes.absent(id)); cleanup = true;
      }
      catch { reason ??= "input_evidence_cleanup_unconfirmed"; }
      await transport.join();
      if (performance.now() >= totalDeadline) reason ??= "input_evidence_total_deadline";
      const passed = success && cleanup && !interrupted && !transport.failure && !reason;
      const cleaned = cleanupOnly && cleanup && !reason && !interrupted && !transport.failure;
      privateState.state.phase = cleaned ? "cleaned" : passed ? "passed" : "failed";
      // Failures retain the private recovery password even when supported cleanup succeeded.
      if (passed || cleaned) privateState.state.password = null;
      const record = { contract: "ops.s14-input-evidence/v1", label: "installed-kernel integration with synthetic authority and controlled transport latches",
        architecture: process.arch, build, outcome: cleanupOnly ? cleaned ? "cleanup_confirmed" : "cleanup_unconfirmed" : passed ? "integration_cases_completed" : "failed",
        cleanupConfirmed: cleanup, reason, ...results, trace: transport.trace };
      writeInputEvidencePrivate(privateState.resultPath, record); writeInputEvidencePrivate(privateState.statePath, privateState.state);
      // No password, raw errors, bodies, screenshot, profile or installation address is printed.
      console.log(JSON.stringify({ contract: record.contract, label: record.label, outcome: record.outcome, cleanupConfirmed: cleanup, reason }));
      if (!(passed || cleaned)) process.exitCode = 1;
    }
  } finally {
    transport.close(); await transport.join(); store?.close(); release();
    clearTimeout(deadline);
    process.off("SIGTERM", cancel); process.off("SIGINT", cancel);
  }
}

async function main(): Promise<void> {
  // Covers preflight too. Unconfirmed cleanup leaves the durable private marker for cleanup-only inspection.
  const hardDeadline = setTimeout(() => { process.exit(1); }, 240000);
  try { await evidenceMain(performance.now() + 240000); } finally { clearTimeout(hardDeadline); }
}

if (import.meta.main) main().catch(error => {
  console.error(JSON.stringify({ contract: "ops.s14-input-evidence/v1", outcome: "refused", reason: error instanceof AppError ? error.code : "input_evidence_preflight_refused" })); process.exitCode = 1;
});
