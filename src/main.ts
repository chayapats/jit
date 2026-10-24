import { Application } from "./application";
import { readConfig } from "./config";
import { TransactionStore } from "./store";
import { createWebHandler } from "./web";
import { gatherDiagnostics, inspectDiagnostics } from "./ops/diagnostics";
import { preflightService } from "./ops/lifecycle";
import { readLocalDrillConfig } from "./ops/records";
import { gatherServiceStatus } from "./ops/status";
import { parseServiceConfig } from "../ops/package/service-config";
import { readHiddenPassword } from "./terminal-password";
import { AppError } from "./errors";
import { verifySchwayBridge } from "./team/schway-port";
import { composeJobQueue } from "./composition";
import type { JobQueue } from "./jobs/queue";
import { tickSchedules } from "./jobs/schedules";
import { backupNativePortFor } from "./ops/schway-backup";

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
  if (!["serve", "setup", "reset-owner", "probe", "diagnose", "preflight", "status"].includes(command ?? "")) {
    throw new Error("Use serve, setup, reset-owner, probe, diagnose, preflight or status");
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
    const store = new TransactionStore(config.databasePath);
    try {
      const result = preflightService({ store, config, service, requiredEngine });
      console.log(JSON.stringify(result));
    } finally { store.close(); }
    return;
  }
  const store = new TransactionStore(config.databasePath);
  let queue: JobQueue | undefined;
  try { if (command === "serve") {
    if (config.runPort === "schway") {
      const gate = await verifySchwayBridge(store);
      if (!gate.ok) {
        console.error(`Schway bridge unavailable: ${gate.detail} (next: ${gate.nextAction})`);
        process.exitCode = 1;
        return;
      }
      console.log(`Schway bridge ready: ${gate.detail}`);
    }
    // One shared composition with startFullApp: same workers, same port/route policy.
    const composed = composeJobQueue(store, config);
    queue = composed.queue;
    const teamPort = composed.teamPort;
    await queue.reconcile(teamPort);
  } }
  catch (error) { queue?.close(); store.close(); throw error; }
  // Backups ride the concrete native bridge only under explicit schway mode;
  // scripted default stays fail-closed (no native port), exactly like runPort.
  const nativeSnapshot = backupNativePortFor(config, store);
  const app = new Application(store, config, {
    ...(queue ? { jobs: queue } : {}),
    ...(nativeSnapshot ? { nativeSnapshot } : {}),
  });
  if (command !== "serve") {
    try { await app.setupOwner(await secret(), command === "reset-owner"); console.log("Owner credentials saved; existing browser sessions revoked."); }
    finally { store.close(); }
    return;
  }
  let server: ReturnType<typeof Bun.serve>;
  try { server = Bun.serve({ hostname: config.hostname, port: config.port, maxRequestBodySize: config.bodyBytes,
    idleTimeout: 15, fetch: createWebHandler(app), error: () => new Response("Request failed", { status: 503 }) }); }
  catch (error) { queue?.close(); store.close(); throw error; }
  const timer = setInterval(() => { try { queue!.pump(); tickSchedules(store, queue!, config, Date.now()); } catch { /* Queue refuses acknowledgments after a storage/ownership failure. */ } }, 100);
  timer.unref();
  console.log("Jit workspace started. No external services connected.");
  const stop = async () => { clearInterval(timer); queue?.close(); await server.stop(); store.close(); process.exit(0); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch(error => {
  console.error(error instanceof AppError && error.code === "scheduler_unavailable"
    ? "Jit job admission is unavailable. Stop the other Jit instance or verify stale scheduler ownership before retrying."
    : "Jit could not complete the operation. Check local configuration, owner setup and storage.");
  process.exitCode = 1;
});
