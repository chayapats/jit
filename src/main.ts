import { Application } from "./application";
import { readConfig } from "./config";
import { TransactionStore, inspectStoreSchema, schemaVersion } from "./store";
import { gatherDiagnostics, inspectDiagnostics } from "./ops/diagnostics";
import { preflightService, serviceAppConfig, serveFullApp, startFullApp, stopDrain } from "./ops/lifecycle";
import { readLocalDrillConfig } from "./ops/records";
import { readServiceConfigFile } from "./ops/service-package";
import { gatherServiceStatus } from "./ops/status";
import { parseServiceConfig } from "../ops/package/service-config";
import { readHiddenPassword } from "./terminal-password";
import { AppError } from "./errors";
import { backupNativePortFor } from "./ops/schway-backup";
import { upgradeEvidence, type UpgradeJournal } from "./ops/upgrade";

async function secret(): Promise<string> {
  if (!process.stdin.isTTY) {
    if (!process.argv.includes("--password-stdin")) throw new Error("Use an interactive terminal or --password-stdin");
    const input = await Bun.stdin.text();
    if (input.length > 258) throw new Error("Password input is too long");
    return input.replace(/\r?\n$/, "");
  }
  return readHiddenPassword();
}

async function main(): Promise<void> {
  const config = readConfig();
  const command = process.argv[2];
  if (command === "probe") {
    const { runProbeCommand } = await import("./probe-cli");
    const result = await runProbeCommand(process.argv.slice(3), process.cwd());
    console.log(JSON.stringify(result.output));
    process.exitCode = result.exitCode === 0 ? 0 : 1;
    return;
  }
  if (!["serve", "setup", "reset-owner", "probe", "diagnose", "preflight", "status", "upgrade", "service"].includes(command ?? "")) {
    throw new Error("Use serve, setup, reset-owner, probe, diagnose, preflight, status, upgrade or service");
  }
  if (command === "service") {
    // Operator package commands (ops.service_package/v1): plan, install, start, stop, status, upgrade, disable, uninstall.
    const { runServiceCommand } = await import("./ops/service-cli");
    const result = await runServiceCommand(process.argv.slice(3), { cwd: process.cwd(), readPassword: secret });
    console.log(JSON.stringify(result.output));
    process.exitCode = result.exitCode;
    return;
  }
  if (command === "upgrade") {
    await upgradeCommand(config, process.argv.slice(3));
    return;
  }
  if (command === "serve") {
    await serveCommand(config, process.argv.slice(3));
    return;
  }
  if (command === "diagnose") {
    // Read-only operator inspection: no scheduler claim, no queue pump, no timers, no server.
    console.log(JSON.stringify(inspectDiagnostics(gatherDiagnostics(process.cwd(), config))));
    return;
  }
  if (command === "preflight" || command === "status") {
    // Operator lifecycle commands. Preflight gates activation; status stays
    // read-only. Neither starts background work or claims the scheduler.
    const extra = process.argv.slice(3);
    let requiredEngine = "jit.schway.bridge/v1";
    let configPath: string | null = null;
    for (let i = 0; i < extra.length; i += 2) {
      if (extra[i] === "--contract" && extra[i + 1] && command === "preflight") requiredEngine = extra[i + 1]!;
      else if (extra[i] === "--service-config" && extra[i + 1]) configPath = extra[i + 1]!;
      else throw new Error("Use preflight [--contract <engine-contract>] [--service-config <path>] or status [--service-config <path>]");
    }
    let service;
    try {
      service = configPath ? readServiceConfigFile(configPath)
        : parseServiceConfig(await readLocalDrillConfig(process.cwd(), ".local/service-config.json"));
    } catch { throw new Error("Service is not configured. Create .local/service-config.json or pass --service-config (see docs/runbooks/ops-service.md)."); }
    if (command === "status") {
      console.log(JSON.stringify(gatherServiceStatus(config, service)));
      return;
    }
    // Read-only gate: an older installation is reported, never migrated in place.
    const effective = serviceAppConfig(config, service);
    const store = new TransactionStore(effective.databasePath, { migrateExisting: false });
    try {
      const result = preflightService({ store, config: effective, service, requiredEngine });
      console.log(JSON.stringify(result));
    } finally { store.close(); }
    return;
  }
  // setup / reset-owner: trusted local owner provisioning. An existing installation is never migrated in place.
  const store = new TransactionStore(config.databasePath, { migrateExisting: false });
  try {
    const nativeSnapshot = backupNativePortFor(config, store);
    const app = new Application(store, config, nativeSnapshot ? { nativeSnapshot } : {});
    await app.setupOwner(await secret(), command === "reset-owner");
    console.log("Owner credentials saved; existing browser sessions revoked.");
  } finally { store.close(); }
}

/**
 * `serve [--service-config <path>]`: the one start path shared with the
 * packaged systemd unit (ExecStart passes the installed configuration).
 * `startFullApp` runs preflight, the quarantine/ledger and upgrade gates,
 * the concrete engine gate, pre-listen preparation, the managed composition
 * and boot reconciliation, then opt-in channels; only then does
 * `serveFullApp` listen. Without `--service-config` the development profile
 * runs the same path without installation-only gates.
 */
async function serveCommand(config: ReturnType<typeof readConfig>, args: string[]): Promise<void> {
  let service = null;
  if (args.length === 2 && args[0] === "--service-config") {
    try { service = readServiceConfigFile(args[1]!); }
    catch { console.error("Service configuration rejected: check the installed file, its mode and fields (see docs/runbooks/ops-service.md)."); process.exitCode = 1; return; }
  } else if (args.length !== 0) throw new Error("Use serve [--service-config <path>]");
  const started = await startFullApp({ config, service });
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

/**
 * Offline owner upgrade (ops.schema_migrations/v1) for an installation that
 * `serve` refuses because its schema is older than this build. Requires the
 * owner password and no other running instance; runs prepare → migrate →
 * validate → activate through the same Application commands as the Web, then
 * prints sanitized evidence. Reconciliation of jobs/sessions happens at the
 * next `serve` boot before any admission (journal `activated` → `complete`).
 */
async function upgradeCommand(baseConfig: ReturnType<typeof readConfig>, args: string[]): Promise<void> {
  let target: number | null = null;
  let service = null;
  const rest = args.filter(arg => arg !== "--password-stdin");
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] === "--target" && /^\d{1,6}$/.test(rest[i + 1] ?? "")) target = Number(rest[i + 1]);
    else if (rest[i] === "--service-config" && rest[i + 1]) service = readServiceConfigFile(rest[i + 1]!);
    else throw new Error("Use upgrade [--target <schema>] [--service-config <path>] [--password-stdin]");
  }
  // Under the package, the installation's database, run port and backup directory come from the installed configuration.
  const config = serviceAppConfig(baseConfig, service);
  const store = new TransactionStore(config.databasePath, { migrateExisting: false });
  let last: UpgradeJournal | null = null;
  try {
    const nativeSnapshot = backupNativePortFor(config, store);
    const app = new Application(store, config, { ...(nativeSnapshot ? { nativeSnapshot } : {}), ...(service ? { backupDir: service.backupDirectory } : {}) });
    const token = await app.login(await secret());
    const { actor } = app.authenticate(token);
    const status = app.upgradeStatus(actor);
    const requestId = () => crypto.randomUUID().replaceAll("-", "");
    try {
      let receipt = await app.execute(actor, { kind: "upgrade.prepare", requestId: requestId(), projectId: null,
        expectedRevision: status.revision, payload: { targetSchema: target ?? status.target, note: "offline owner upgrade" } });
      last = receipt.journal;
      for (const kind of ["upgrade.migrate", "upgrade.validate", "upgrade.activate"] as const) {
        receipt = await app.execute(actor, { kind, requestId: requestId(), projectId: null,
          expectedRevision: app.upgradeStatus(actor).revision, payload: { upgradeId: receipt.journal.id } });
        last = receipt.journal;
      }
      console.log(JSON.stringify(upgradeEvidence(receipt.journal)));
    } catch (error) {
      const latest = app.upgrades(actor).journals.at(-1) ?? last;
      console.log(JSON.stringify({ error: error instanceof AppError ? error.code : "upgrade_failed", upgrade: latest ? upgradeEvidence(latest) : null }));
      process.exitCode = 1;
    } finally {
      try { app.logout(actor); } catch { /* Session cleanup is best effort. */ }
    }
  } finally { store.close(); }
}

main().catch(error => {
  console.error(error instanceof AppError && error.code === "scheduler_unavailable"
    ? "Jit job admission is unavailable. Stop the other Jit instance or verify stale scheduler ownership before retrying."
    : "Jit could not complete the operation. Check local configuration, owner setup and storage.");
  process.exitCode = 1;
});
