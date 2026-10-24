import type { AppConfig } from "../config";
import { inspectStoreSchema, schemaVersion } from "../store";
import { serviceAppConfig, serveFullApp, startFullApp, stopDrain, type LedgerGate } from "./lifecycle";
import type { ChannelTransportFactory } from "./service-channels";
import { readServiceConfigFile } from "./service-package";

/** Test-harness seams; production `serve` passes none (default ledger gate, no Telegram transport). */
export interface ServeOptions { ledgerGate?: LedgerGate; transports?: ChannelTransportFactory }

/**
 * `serve [--service-config <path>]`: the one start path shared with the
 * packaged systemd unit (ExecStart passes the installed configuration).
 * `startFullApp` runs preflight, the quarantine/ledger and upgrade gates,
 * the concrete engine gate, pre-listen preparation, the managed composition
 * and boot reconciliation, then opt-in channels; only then does
 * `serveFullApp` listen. Without `--service-config` the development profile
 * runs the same path without installation-only gates. `options` exist for
 * deterministic test harnesses only; `src/main.ts` never passes them.
 */
export async function serveCommand(config: AppConfig, args: string[], options: ServeOptions = {}): Promise<void> {
  let service = null;
  if (args.length === 2 && args[0] === "--service-config") {
    try { service = readServiceConfigFile(args[1]!); }
    catch { console.error("Service configuration rejected: check the installed file, its mode and fields (see docs/runbooks/ops-service.md)."); process.exitCode = 1; return; }
  } else if (args.length !== 0) throw new Error("Use serve [--service-config <path>]");
  const started = await startFullApp({ config, service, ...(options.ledgerGate ? { ledgerGate: options.ledgerGate } : {}),
    ...(options.transports ? { transports: options.transports } : {}) });
  if (!started.ok) {
    for (const gate of started.gates.filter(g => g.state === "blocked")) {
      if (gate.gate === "schema" && gate.nextAction === "run-owner-upgrade") {
        const installed = inspectStoreSchema(serviceAppConfig(config, service).databasePath);
        console.error(`Upgrade required: installation schema ${installed}, this build supports ${schemaVersion}. Run \`bun src/main.ts upgrade\` (owner password) before serving.`);
      } else if (gate.gate === "engine" && gate.detail.startsWith("schway bridge unavailable: ")) {
        console.error(`Schway bridge unavailable: ${gate.detail.slice("schway bridge unavailable: ".length)} (next: ${gate.nextAction})`);
      } else {
        console.error(`Service blocked at ${gate.gate}: ${gate.detail} (next: ${gate.nextAction})`);
      }
    }
    process.exitCode = 1;
    return;
  }
  const { handle } = started;
  if (handle.config.runPort === "schway") console.log("Schway bridge ready: pinned bridge verified before admission.");
  if (!handle.boot.reconciled) console.log("Upgrade in progress: job admission stays fenced until the owner activates or rolls back.");
  if (handle.boot.upgrade) console.log(`Upgrade ${handle.boot.upgrade.id} reconciled after activation: ${handle.boot.upgrade.state}.`);
  let running: ReturnType<typeof serveFullApp>;
  try { running = serveFullApp(handle); }
  catch (error) { await stopDrain(handle, { timeoutMs: 0 }).catch(() => {}); handle.service.close(); handle.store.close(); throw error; }
  console.log(handle.channels
    ? "Jit workspace started. Telegram channel active; owner commands still require owner authentication."
    : "Jit workspace started. No external services connected.");
  const stop = async () => {
    const drained = await running.stop();
    // Interrupted/unknown work is recorded for the next start's reconciliation; never reported as sent or completed.
    console.log(JSON.stringify({ stopped: drained.outcome, fencedJobs: drained.fencedJobs, unknownDeliveries: drained.unknownDeliveries, nextAction: drained.nextAction }));
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

