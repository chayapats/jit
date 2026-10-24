import { Application } from "./application";
import { readConfig } from "./config";
import { TransactionStore, schemaVersion } from "./store";
import { createWebHandler } from "./web";
import { gatherDiagnostics, inspectDiagnostics } from "./ops/diagnostics";
import { preflightService } from "./ops/lifecycle";
import { readLocalDrillConfig } from "./ops/records";
import { gatherServiceStatus } from "./ops/status";
import { parseServiceConfig } from "../ops/package/service-config";
import { readHiddenPassword } from "./terminal-password";
import { AppError } from "./errors";
import { verifySchwayBridge } from "./team/schway-port";
import { tickSchedules } from "./jobs/schedules";
import { backupNativePortFor } from "./ops/schway-backup";
import { ManagedService } from "./ops/upgrade-service";
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
  if (!["serve", "setup", "reset-owner", "probe", "diagnose", "preflight", "status", "upgrade"].includes(command ?? "")) {
    throw new Error("Use serve, setup, reset-owner, probe, diagnose, preflight, status or upgrade");
  }
  if (command === "upgrade") {
    await upgradeCommand(config, process.argv.slice(3));
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
    if (extra.length === 2 && extra[0] === "--contract") requiredEngine = extra[1]!;
    else if (extra.length !== 0) throw new Error("Use preflight [--contract <engine-contract>] or status");
    let service;
    try { service = parseServiceConfig(await readLocalDrillConfig(process.cwd(), ".local/service-config.json")); }
    catch { throw new Error("Service is not configured. Create .local/service-config.json (see docs/runbooks/ops-service.md)."); }
    if (command === "status") {
      console.log(JSON.stringify(gatherServiceStatus(config, service)));
      return;
    }
    // Read-only gate: an older installation is reported, never migrated in place.
    const store = new TransactionStore(config.databasePath, { migrateExisting: false });
    try {
      const result = preflightService({ store, config, service, requiredEngine });
      console.log(JSON.stringify(result));
    } finally { store.close(); }
    return;
  }
  // ops.schema_migrations/v1: an existing installation is never migrated in place at boot.
  // Only the owner-authorized staged upgrade (`upgrade`) migrates, on a staged copy.
  const store = new TransactionStore(config.databasePath, { migrateExisting: false });
  let service: ManagedService | undefined;
  let app: Application;
  try {
    const installed = store.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version);
    if (command === "serve" && installed < schemaVersion) {
      console.error(`Upgrade required: installation schema ${installed}, this build supports ${schemaVersion}. Run \`bun src/main.ts upgrade\` (owner password) before serving.`);
      process.exitCode = 1;
      store.close();
      return;
    }
    if (command === "serve" && config.runPort === "schway") {
      const gate = await verifySchwayBridge(store);
      if (!gate.ok) {
        console.error(`Schway bridge unavailable: ${gate.detail} (next: ${gate.nextAction})`);
        process.exitCode = 1;
        store.close();
        return;
      }
      console.log(`Schway bridge ready: ${gate.detail}`);
    }
    // Backups ride the concrete native bridge only under explicit schway mode;
    // scripted default stays fail-closed (no native port), exactly like runPort.
    const nativeSnapshot = backupNativePortFor(config, store);
    // One shared composition with startFullApp: same workers, same port/route policy,
    // owned by the service lifecycle so an upgrade can quiesce, rebuild and reconcile it.
    if (command === "serve") service = ManagedService.forConfig(store, config);
    app = new Application(store, config, {
      ...(service ? { service } : {}),
      ...(nativeSnapshot ? { nativeSnapshot } : {}),
    });
    if (service) {
      const booted = await app.boot();
      if (!booted.reconciled) console.log("Upgrade in progress: job admission stays fenced until the owner activates or rolls back.");
      if (booted.upgrade) console.log(`Upgrade ${booted.upgrade.id} reconciled after activation: ${booted.upgrade.state}.`);
    }
  } catch (error) { service?.close(); store.close(); throw error; }
  if (command !== "serve") {
    try { await app.setupOwner(await secret(), command === "reset-owner"); console.log("Owner credentials saved; existing browser sessions revoked."); }
    finally { store.close(); }
    return;
  }
  let server: ReturnType<typeof Bun.serve>;
  try { server = Bun.serve({ hostname: config.hostname, port: config.port, maxRequestBodySize: config.bodyBytes,
    idleTimeout: 15, fetch: createWebHandler(app), error: () => new Response("Request failed", { status: 503 }) }); }
  catch (error) { service?.close(); store.close(); throw error; }
  const timer = setInterval(() => {
    const queue = service!.queue;
    if (!queue) return;
    try { queue.pump(); tickSchedules(store, queue, config, Date.now()); } catch { /* Queue refuses acknowledgments after a storage/ownership failure or under an upgrade fence. */ }
  }, 100);
  timer.unref();
  console.log("Jit workspace started. No external services connected.");
  const stop = async () => { clearInterval(timer); service?.close(); await server.stop(); store.close(); process.exit(0); };
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
async function upgradeCommand(config: ReturnType<typeof readConfig>, args: string[]): Promise<void> {
  let target: number | null = null;
  const rest = args.filter(arg => arg !== "--password-stdin");
  if (rest.length === 2 && rest[0] === "--target" && /^\d{1,6}$/.test(rest[1]!)) target = Number(rest[1]);
  else if (rest.length !== 0) throw new Error("Use upgrade [--target <schema>] [--password-stdin]");
  const store = new TransactionStore(config.databasePath, { migrateExisting: false });
  let last: UpgradeJournal | null = null;
  try {
    const nativeSnapshot = backupNativePortFor(config, store);
    const app = new Application(store, config, nativeSnapshot ? { nativeSnapshot } : {});
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
