import { Application } from "./application";
import { readConfig } from "./config";
import { TransactionStore } from "./store";
import { gatherDiagnostics, inspectDiagnostics } from "./ops/diagnostics";
import { preflightService, serviceAppConfig } from "./ops/lifecycle";
import { serveCommand } from "./ops/serve";
import { readLocalDrillConfig } from "./ops/records";
import { readServiceConfigFile } from "./ops/service-package";
import { openReadOnlyStore } from "./ops/readonly-store";
import { gatherServiceStatus } from "./ops/status";
import { parseServiceConfig } from "../ops/package/service-config";
import { readHiddenPassword } from "./terminal-password";
import { AppError } from "./errors";
import { backupNativePortFor } from "./ops/schway-backup";
import { upgradeEvidence, type UpgradeJournal } from "./ops/upgrade";

async function secret(args: string[]): Promise<string> {
  if (!process.stdin.isTTY) {
    if (!args.includes("--password-stdin")) throw new Error("Use an interactive terminal or --password-stdin");
    const input = await Bun.stdin.text();
    if (input.length > 258) throw new Error("Password input is too long");
    return input.replace(/\r?\n$/, "");
  }
  return readHiddenPassword();
}

/** Runs the explicitly selected legacy CLI after bootstrap selection; args exclude runtime selectors. */
export async function runLegacy(args: string[]): Promise<void> {
  const command = args[0];
  // app.local_api/v1 CLI. `status RECEIPT` reads a reply; `status [--service-config <path>]` stays the operator status.
  const rest = args.slice(1);
  if (command === "ask" || command === "pending" || (command === "status" && rest.length > 0 && !rest[0]!.startsWith("--"))) {
    process.exitCode = await localApiCommand(command, rest);
    return;
  }
  const config = readConfig();
  if (command === "probe") {
    const { runProbeCommand } = await import("./probe-cli");
    const result = await runProbeCommand(args.slice(1), process.cwd());
    console.log(JSON.stringify(result.output));
    process.exitCode = result.exitCode === 0 ? 0 : 1;
    return;
  }
  if (!["serve", "setup", "reset-owner", "probe", "diagnose", "preflight", "status", "upgrade"].includes(command ?? "")) {
    throw new Error("Use serve, setup, reset-owner, probe, diagnose, preflight, status, upgrade, ask or pending");
  }
  if (command === "upgrade") {
    await upgradeCommand(config, args.slice(1));
    return;
  }
  if (command === "serve") {
    await serveCommand(config, args.slice(1));
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
    const extra = args.slice(1);
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
    // Read-only gate over a read-only connection: an older installation is reported, never migrated,
    // and a missing database is reported, never created.
    const effective = serviceAppConfig(config, service);
    console.log(JSON.stringify(preflightService({ store: openReadOnlyStore(effective.databasePath), config: effective, service, requiredEngine })));
    return;
  }
  // setup / reset-owner: trusted local owner provisioning. An existing installation is never migrated in place.
  const store = new TransactionStore(config.databasePath, { migrateExisting: false });
  try {
    const nativeSnapshot = backupNativePortFor(config, store);
    const app = new Application(store, config, nativeSnapshot ? { nativeSnapshot } : {});
    await app.setupOwner(await secret(args), command === "reset-owner");
    console.log("Owner credentials saved; existing browser sessions revoked.");
  } finally { store.close(); }
}

/**
 * `ask`, `status RECEIPT` and `pending` (app.local_api/v1): talk to the running service over its loopback API.
 * The installation is the development database (`JIT_DATABASE`) or `--service-config <path>`; the CLI only reads
 * the listener files next to that database and never opens SQLite.
 */
async function localApiCommand(command: "ask" | "status" | "pending", args: string[]): Promise<number> {
  const { cliExit, cliLocale, runLocalApiCli } = await import("./local-api/cli");
  const { localApiDirectory } = await import("./local-api/server");
  const separator = args.indexOf("--");
  const index = (separator < 0 ? args : args.slice(0, separator)).indexOf("--service-config");
  let databasePath: string;
  try {
    const config = readConfig();
    if (index >= 0) {
      const path = args[index + 1];
      if (!path) return cliExit.usage;
      databasePath = serviceAppConfig(config, readServiceConfigFile(path)).databasePath;
      args = [...args.slice(0, index), ...args.slice(index + 2)];
    } else databasePath = config.databasePath;
  } catch { return cliExit.unavailable; }
  return runLocalApiCli(command, args, {
    directory: localApiDirectory(databasePath), locale: cliLocale(process.env),
    out: text => console.log(text), err: text => console.error(text),
    stdin: async () => process.stdin.isTTY ? null : await Bun.stdin.text(),
  });
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
    const token = await app.login(await secret(args));
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
