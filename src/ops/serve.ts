import { logLine } from "../security/log";
import type { AppConfig } from "../config";
import { LocalApiListener, localApiDirectory } from "../local-api/server";
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
    catch { logLine("Service configuration rejected: check the installed file, its mode and fields (see docs/runbooks/ops-service.md)."); process.exitCode = 1; return; }
  } else if (args.length !== 0) throw new Error("Use serve [--service-config <path>]");
  const started = await startFullApp({ config, service, ...(options.ledgerGate ? { ledgerGate: options.ledgerGate } : {}),
    ...(options.transports ? { transports: options.transports } : {}) });
  if (!started.ok) {
    for (const gate of started.gates.filter(g => g.state === "blocked")) {
      if (gate.gate === "schema" && gate.nextAction === "run-owner-upgrade") {
        const installed = inspectStoreSchema(serviceAppConfig(config, service).databasePath);
        logLine(`Upgrade required: installation schema ${installed}, this build supports ${schemaVersion}. Run \`bun src/main.ts upgrade\` (owner password) before serving.`);
      } else if (gate.gate === "engine" && gate.detail.startsWith("schway bridge unavailable: ")) {
        logLine(`Schway bridge unavailable: ${gate.detail.slice("schway bridge unavailable: ".length)} (next: ${gate.nextAction})`);
      } else {
        logLine(`Service blocked at ${gate.gate}: ${gate.detail} (next: ${gate.nextAction})`);
      }
    }
    process.exitCode = 1;
    return;
  }
  const { handle } = started;
  if (handle.config.runPort === "schway") logLine("Schway bridge ready: pinned bridge verified before admission.", "stdout");
  if (!handle.boot.reconciled) logLine("Upgrade in progress: job admission stays fenced until the owner activates or rolls back.", "stdout");
  if (handle.boot.upgrade) logLine(`Upgrade ${handle.boot.upgrade.id} reconciled after activation: ${handle.boot.upgrade.state}.`, "stdout");
  if (handle.boot.restore && handle.boot.restore.state !== "complete") {
    logLine(`Restore ${handle.boot.restore.id} is not complete (${handle.boot.restore.reason ?? handle.boot.restore.state}): only restore status and remediation (/restores) are served.`, "stdout");
  }
  let running: ReturnType<typeof serveFullApp>;
  try { running = serveFullApp(handle); }
  catch (error) { await stopDrain(handle, { timeoutMs: 0 }).catch(() => {}); handle.service.close(); handle.store.close(); throw error; }
  // app.local_api/v1: off by default; follows the owner setting and binds 127.0.0.1 only while it is on.
  const localApi = new LocalApiListener({ app: handle.app, directory: localApiDirectory(handle.config.databasePath) });
  try { localApi.start(); } catch { logLine("Local API could not start: check the local-api folder next to the database. The workspace keeps running."); }
  logLine(handle.channels
    ? "Jit workspace started. Telegram channel active; owner commands still require owner authentication."
    : "Jit workspace started. No external services connected.", "stdout");
  const stop = async () => {
    // The listener and its token files go first, so no script request lands during the drain.
    await localApi.stop().catch(() => {});
    const drained = await running.stop();
    // Interrupted/unknown work is recorded for the next start's reconciliation; never reported as sent or completed.
    logLine(JSON.stringify({ stopped: drained.outcome, fencedJobs: drained.fencedJobs, unknownDeliveries: drained.unknownDeliveries, nextAction: drained.nextAction }), "stdout");
    process.exit(0);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

