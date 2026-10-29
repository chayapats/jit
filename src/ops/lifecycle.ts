import { WebTools, assertWebToolsCapability } from "../web-tools";
import { PodmanAttachmentSanitizer } from "../attachments/sanitizer-runtime";
import { attachmentRequestBytes, attachmentLimitsForDirectories } from "../attachments/limits";
import { realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Application } from "../application";
import { prepareServiceState } from "../bootstrap";
import type { AppConfig } from "../config";
import type { JobQueue } from "../jobs/queue";
import { tickSchedules } from "../jobs/schedules";
import { FakeGitHubFixture } from "../pr/github";
import { tickPrPolls } from "../pr/poll-due";
import { webhookLimits } from "../pr/webhooks";
import type { BoxManager } from "../exec/box-manager";
import { createServiceBoxes } from "../exec/box-service";
import { ConnectionVault } from "../exec/connections";
import { EffectExecutor } from "../exec/effect-executor";
import { boxStreamsOf } from "../exec/box-runtime";
import { McpGateway } from "../exec/mcp-gateway";
import { BrowserService } from "../exec/browser";
import { ComputerService } from "../exec/computer";
import { composeJobQueue } from "../composition";
import type { ApplicationRunPort } from "../team/run-port";
import type { RouteModels } from "../team/route-options";
import { verifySchwayBridge } from "../team/schway-port";
import { TransactionStore, schemaVersion } from "../store";
import { createWebHandler } from "../web";
import { backupDirectoryProblem } from "./backup";
import { backupNativePortFor } from "./schway-backup";
import { ledgerCheckpointPathFor, syncLedgerCheckpoint } from "./lifecycle-ledger";
import { openReadOnlyStore, unavailableReadOnlyStore } from "./readonly-store";
import { ServiceChannels, channelReadiness, type ChannelTransportFactory } from "./service-channels";
import { tickWorkGroups } from "../team/work-group";
import { ManagedService } from "./upgrade-service";
import { upgradeFenced } from "./upgrade-fence";
import { validateArtifact, type BuildManifest } from "../../ops/package/bun-build";
import {
  parseServiceConfig, serviceDatabasePath, serviceDrainTimeoutMs, serviceOrigin, telegramEnabled, telegramTokenPath, type ServiceConfig,
} from "../../ops/package/service-config";

/** Fixed preflight gates. A blocked gate never implies its remedy is authorized. */
export const preflightGates = ["config", "schema", "engine", "quarantine", "scheduler", "deliveries", "channels", "secrets", "artifact"] as const;
export type PreflightGateName = typeof preflightGates[number];

export interface PreflightGate {
  gate: PreflightGateName;
  state: "ready" | "blocked";
  nextAction: string;
  detail: string;
}

export interface PreflightResult {
  ok: boolean;
  gates: PreflightGate[];
}

// ---------------------------------------------------------------------------
// Deletion/suppression ledger seam (ops.quarantined_restore/v1, #33)
// ---------------------------------------------------------------------------

/** Verdict of the installation ledger check that gates activation. */
export type LedgerVerdict = { trusted: true; detail: string } | { trusted: false; reason: string; nextAction: string };

/** The read surface preflight and ledger inspection use; status supplies a read-only SQLite adapter. */
export type ReadableStore = Pick<TransactionStore, "read" | "path">;

export interface LedgerGateInput {
  store: ReadableStore;
  /** Configured checkpoint path (`ServiceConfig.ledgerPath`), or null for the development profile. */
  ledgerPath: string | null;
  now: number;
  /** `inspect` must not write (preflight/status); `boot` may establish or extend the checkpoint. */
  mode: "inspect" | "boot";
}

/**
 * Narrow seam through which the service consumes the installation-scoped
 * deletion/suppression ledger. Activation (jobs, memory assembly,
 * extraction, monitoring, deliveries) proceeds only on `trusted`.
 */
export type LedgerGate = (input: LedgerGateInput) => LedgerVerdict;

/**
 * Default ledger gate: the OPS02 installation lifecycle ledger checkpoint
 * (app.deletion_ledger/v1, `syncLedgerCheckpoint`). The installed profile
 * checks the configured `ledgerPath`; the development profile checks the
 * default `<db>.lifecycle-ledger.json`. `inspect` never writes (read-only
 * stores suffice); `boot` may establish the checkpoint from a fresh
 * installation or the install seed `{ledger, revision}` (accepted once), or
 * extend a lagging one. Untrusted — missing after establishment, diverged,
 * stale, unverifiable, incompatible, or relocated without a verified copy
 * of the previously established checkpoint — keeps activation quarantined.
 */
export const defaultLedgerGate: LedgerGate = ({ store, ledgerPath, now, mode }) => {
  const path = ledgerPath ?? ledgerCheckpointPathFor(store.path);
  // With `write: false` the checkpoint resolution only reads, so the read-only adapter is sufficient.
  const verdict = syncLedgerCheckpoint(store as TransactionStore, path, now, { write: mode === "boot" });
  return verdict.state === "trusted"
    ? { trusted: true, detail: `lifecycle ledger trusted (head ${verdict.head}, ${verdict.count} entries${verdict.established ? ", established" : ""})` }
    : { trusted: false, reason: `lifecycle ledger ${verdict.reason}`, nextAction: verdict.nextAction };
};

/** Reads quarantine state through a ledger gate (inspect mode) without starting anything. */
export function readQuarantine(service: ServiceConfig, store: ReadableStore | null = null, gate: LedgerGate = defaultLedgerGate): { quarantined: boolean; reason: string } {
  try {
    const readable = store ?? openReadOnlyStore(serviceDatabasePath(service)) ?? unavailableReadOnlyStore(serviceDatabasePath(service));
    const verdict = gate({ store: readable, ledgerPath: service.ledgerPath, now: Date.now(), mode: "inspect" });
    return verdict.trusted ? { quarantined: false, reason: verdict.detail } : { quarantined: true, reason: verdict.reason };
  } catch { return { quarantined: true, reason: "ledger check failed" }; }
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface PreflightInput {
  /** Read surface only; `null` when the installation database does not exist (reported blocked, never created). */
  store: ReadableStore | null;
  config: AppConfig;
  /** Trusted installation configuration; null runs the development profile (service-only gates omitted). */
  service: ServiceConfig | null;
  requiredEngine: string;
  /** Explicit artifact manifest to check (otherwise the running release is checked when packaged). */
  artifact?: BuildManifest;
  now?: () => number;
  ledgerGate?: LedgerGate;
  /** Telegram transport factory; absent means no supported transport is installed. */
  transports?: ChannelTransportFactory;
  /**
   * Expected owner of the state and backup directories. Defaults to the
   * running uid (`serve` runs as the service identity); an operator status
   * run as root passes the configured identity's resolved uid instead.
   */
  stateOwnerUid?: number;
}

function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) return false;
  try { process.kill(pid as number, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

/** Root of the build executing this code (the release directory under the packaged unit). */
export const runningAppRoot = resolve(import.meta.dir, "../..");

function realpathOrNull(path: string): string | null {
  try { return realpathSync(path); } catch { return null; }
}

/**
 * Application configuration as the installation defines it: the database,
 * bind, origin, run port and bot-token reference come from the trusted
 * service configuration, so the unit's environment and the service file
 * cannot disagree about which state is served.
 */
/** Models the operator configured per provider; route forms recommend them (#167). Unknown route names are ignored. */
export function serviceRouteModels(service: ServiceConfig): RouteModels {
  const model = (provider: string) => service.routes.find(r => r.route === provider && r.configured)?.model ?? null;
  return { codex: model("codex"), grok: model("grok") };
}

export function serviceAppConfig(config: AppConfig, service: ServiceConfig | null): AppConfig {
  if (!service) return config;
  const parsed = parseServiceConfig(service);
  return { ...config, databasePath: serviceDatabasePath(parsed), hostname: parsed.network.bindHost, port: parsed.network.port,
    attachments: attachmentLimitsForDirectories(config.attachments, parsed.stateDirectory, parsed.backupDirectory),
    origin: serviceOrigin(parsed), runPort: parsed.runPort ?? config.runPort, routeModels: serviceRouteModels(parsed),
    telegram: { ...config.telegram, botTokenPath: telegramTokenPath(parsed) ?? config.telegram.botTokenPath } };
}

/**
 * Preflight gates full-app activation. Read-only: callers open the store with
 * `migrateExisting: false`, so an installation at an older schema is reported
 * (`run-owner-upgrade`, ops.schema_migrations/v1) instead of being migrated in
 * place. Jobs, memory assembly and deliveries stay disabled until every gate
 * is ready; callers keep a read-only status path.
 */
export function preflightService(input: PreflightInput): PreflightResult {
  const gates: PreflightGate[] = [];
  let service: ServiceConfig | null = null;
  if (input.service !== null) {
    try { service = parseServiceConfig(input.service); }
    catch { return { ok: false, gates: [{ gate: "config", state: "blocked", nextAction: "fix-service-configuration", detail: "service configuration rejected" }] }; }
  }
  const now = input.now ?? Date.now;
  if (service) {
    const dirReady = (path: string): boolean => {
      try { return statSync(path).isDirectory(); } catch { return false; }
    };
    const owner = input.stateOwnerUid ?? (typeof process.getuid === "function" ? process.getuid() : undefined);
    const stateProblem = (() => {
      try {
        const stats = statSync(service.stateDirectory);
        if ((stats.mode & 0o022) !== 0) return "state_directory_writable_by_others";
        if (owner !== undefined && stats.uid !== owner) return "state_directory_foreign_owner";
        return null;
      } catch { return "state_directory_missing"; }
    })();
    // The backup destination holds managed snapshots: it must be a real, service-owned 0700-class directory, never trusted merely for existing.
    const backupProblem = backupDirectoryProblem(service.backupDirectory, owner);
    gates.push(!dirReady(service.stateDirectory) || !dirReady(service.workingDirectory) || backupProblem === "backup_directory_missing"
      ? { gate: "config", state: "blocked", nextAction: "prepare-service-directories", detail: "service directory missing" }
      : stateProblem !== null
        ? { gate: "config", state: "blocked", nextAction: "restrict-state-directory", detail: `state directory untrusted: ${stateProblem}` }
        : backupProblem !== null
          ? { gate: "config", state: "blocked", nextAction: "restrict-backup-directory", detail: `backup directory untrusted: ${backupProblem}` }
          : { gate: "config", state: "ready", nextAction: "none", detail: "service directories present; state and backup directories restricted" });
  }
  const store: ReadableStore = input.store ?? { path: serviceAppConfig(input.config, service).databasePath, read: () => { throw new Error("store_missing"); } };
  let userVersion: number | null = null;
  try { userVersion = store.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!).user_version; } catch { /* Stay blocked below. */ }
  gates.push(userVersion === schemaVersion
    ? { gate: "schema", state: "ready", nextAction: "none", detail: `state schema ${userVersion} matches app schema ${schemaVersion}` }
    : userVersion !== null && userVersion < schemaVersion
      ? { gate: "schema", state: "blocked", nextAction: "run-owner-upgrade", detail: `state schema ${userVersion} older than app schema ${schemaVersion}; staged upgrade required` }
      : input.store === null
        ? { gate: "schema", state: "blocked", nextAction: "start-service-to-initialize-installation", detail: "installation database missing" }
        : { gate: "schema", state: "blocked", nextAction: "use-compatible-app-artifact", detail: "state schema unreadable or newer than app" });
  gates.push(input.requiredEngine === "jit.schway.bridge/v1"
    ? { gate: "engine", state: "ready", nextAction: "none", detail: "declared bridge contract only; live capability proven separately" }
    : { gate: "engine", state: "blocked", nextAction: "use-supported-engine-contract", detail: "engine contract not supported" });
  if (input.config.runPort === "schway") {
    try { assertWebToolsCapability(); } catch { gates.push({ gate: "engine", state: "blocked", nextAction: "install-supported-schway-web-tools", detail: "Schway web-tools/v1 is required" }); }
  }
  let ledger: LedgerVerdict;
  try { ledger = (input.ledgerGate ?? defaultLedgerGate)({ store, ledgerPath: service?.ledgerPath ?? null, now: now(), mode: "inspect" }); }
  catch { ledger = { trusted: false, reason: "ledger check failed", nextAction: "inspect-quarantine-and-ledger" }; }
  gates.push(ledger.trusted
    ? { gate: "quarantine", state: "ready", nextAction: "none", detail: ledger.detail }
    : { gate: "quarantine", state: "blocked", nextAction: ledger.nextAction, detail: ledger.reason });
  const ownerPid = (table: "job_scheduler" | "delivery_worker"): number | null => {
    try { return store.read(tx => tx.get<{ pid: number }>(`SELECT pid FROM ${table} WHERE id = 1`)?.pid ?? null); } catch { return null; }
  };
  const schedulerPid = ownerPid("job_scheduler");
  gates.push(schedulerPid === null || !alive(schedulerPid)
    ? { gate: "scheduler", state: "ready", nextAction: "none", detail: schedulerPid === null ? "admission free" : "stale owner; takeover permitted" }
    : { gate: "scheduler", state: "blocked", nextAction: "stop-other-instance", detail: "another scheduler owns admission" });
  const workerPid = ownerPid("delivery_worker");
  gates.push(workerPid === null || !alive(workerPid)
    ? { gate: "deliveries", state: "ready", nextAction: "none", detail: "delivery worker free" }
    : { gate: "deliveries", state: "blocked", nextAction: "stop-other-delivery-worker", detail: "another delivery worker owns sending" });
  const channels = channelReadiness({ enabled: service ? telegramEnabled(service) : false,
    botTokenPath: serviceAppConfig(input.config, service).telegram.botTokenPath, transports: input.transports });
  gates.push(channels.state === "blocked"
    ? { gate: "channels", state: "blocked", nextAction: channels.nextAction, detail: channels.detail }
    : { gate: "channels", state: "ready", nextAction: "none", detail: channels.detail });
  if (service) {
    const secretProblems: string[] = [];
    for (const ref of service.secretRefs) {
      if (ref.store === "credential-file") {
        try {
          const stats = statSync(ref.key);
          if ((stats.mode & 0o077) !== 0 || !stats.isFile()) secretProblems.push(ref.name);
        } catch { secretProblems.push(ref.name); }
      } else {
        // Keyring and environment-file stores cannot be verified from here; never assume access.
        secretProblems.push(ref.name);
      }
    }
    gates.push(secretProblems.length === 0
      ? { gate: "secrets", state: "ready", nextAction: "none", detail: "credential files present with safe modes" }
      : { gate: "secrets", state: "blocked", nextAction: "verify-secret-store", detail: "secret store access unverified" });
  }
  if (input.artifact) {
    gates.push(input.artifact.schemaVersion === schemaVersion && input.artifact.engineContract === input.requiredEngine
      ? { gate: "artifact", state: "ready", nextAction: "none", detail: "pinned artifact compatible" }
      : { gate: "artifact", state: "blocked", nextAction: "use-compatible-app-artifact", detail: "artifact incompatible" });
  } else if (service) {
    const release = realpathOrNull(service.executablePath);
    if (release !== null && release === realpathOrNull(runningAppRoot)) {
      // Running from the configured release: it must be the unmodified, pinned, dependency-installed artifact.
      const checked = validateArtifact(release, { runtime: true });
      const engineOk = checked.manifest?.engineContract === input.requiredEngine;
      gates.push(checked.ok && engineOk
        ? { gate: "artifact", state: "ready", nextAction: "none", detail: `release ${checked.manifest!.artifactId} verified` }
        : { gate: "artifact", state: "blocked", nextAction: "reinstall-validated-artifact",
          detail: `release failed validation: ${checked.checks.filter(c => !c.ok).map(c => c.check).join(",") || "engine-contract"}` });
    } else {
      gates.push({ gate: "artifact", state: "ready", nextAction: "none", detail: "unpackaged checkout: not running from the configured release" });
    }
  }
  return { ok: gates.every(g => g.state === "ready"), gates };
}

/**
 * Builds the full-application job queue through the shared `composeJobQueue`
 * (src/composition.ts), so serve and the service lifecycle register exactly the
 * same workers with the same port/route policy. There is no probe runner here:
 * S01 probe startup is a separate human-involved command, never part of service boot.
 */
export function createFullAppQueue(store: TransactionStore, config: AppConfig, now: () => number = Date.now): JobQueue {
  return composeJobQueue(store, config, { now }).queue;
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

export interface FullAppHandle {
  store: TransactionStore;
  /** Current scheduler (rebuilt by the managed service after an upgrade activates or rolls back). */
  readonly queue: JobQueue;
  /** Team port the composed queue reconciles native runs against. */
  readonly teamPort: ApplicationRunPort;
  app: Application;
  /** Service lifecycle owner shared with the upgrade (ops.schema_migrations/v1). */
  service: ManagedService;
  /** Delivery worker and Telegram poller, or null when the channel is not enabled. */
  channels: ServiceChannels | null;
  /** Effective application configuration (service-defined database, bind and origin). */
  config: AppConfig;
  /** Trusted installation configuration, or null under the development profile. */
  serviceConfig: ServiceConfig | null;
  /** exec.box_runtime/v1 project boxes, or null when the operator has not configured execution. */
  web?: WebTools;
  boxes: BoxManager | null;
  /** app.approval_cards/v1 effect executor, or null without boxes (credential effects also need the vault); the drain waits for it. */
  effects: EffectExecutor | null;
  /** exec.browser/v1 browser sessions (idle-swept on the tick), or null without boxes. */
  browser?: BrowserService | null;
  /** app.mcp_servers/v1 gateway, or null without boxes; the drain stops its installs. */
  mcp?: McpGateway | null;
  /** Boot reconciliation outcome; `reconciled: false` while an upgrade/restore fence holds. */
  boot: { reconciled: boolean; detail: string; upgrade: { id: string; state: string } | null;
    restore: { id: string; state: string; reason: string | null } | null };
}

export interface StartInput {
  config: AppConfig;
  /** Trusted installation configuration, or null for the development profile (`serve` without `--service-config`). */
  service: ServiceConfig | null;
  storePath?: string;
  store?: TransactionStore;
  requiredEngine?: string;
  now?: () => number;
  ledgerGate?: LedgerGate;
  /** Telegram transport factory. Production builds register none, so an enabled channel fails closed. */
  transports?: ChannelTransportFactory;
  /** Process-owned PR snapshot cache (default `<state>/pr-cache` for a service, `.local/pr-cache` otherwise). */
  prCacheRoot?: string;
}

/**
 * The one service start path, used by `bun src/main.ts serve` (with or
 * without `--service-config`) and therefore by the packaged systemd unit:
 *
 * 1. Preflight (read-only): configuration, schema/upgrade, engine,
 *    quarantine ledger, single scheduler and delivery owner, channels,
 *    secrets and the running release artifact. Blocked gates are returned;
 *    nothing is enabled.
 * 2. Concrete engine gate (`JIT_RUN_PORT=schway`): the pinned bridge must
 *    verify before any admission.
 * 3. Pre-listen state preparation (legacy alert quarantine) unless an
 *    upgrade/restore fence holds.
 * 4. One managed composition (same workers as Web, Telegram, PR, schedule
 *    and recovery paths) and the Application.
 * 5. Ledger gate in `boot` mode, then session/deletion reconciliation
 *    (jobs.session_reconcile/v1, app.data_lifecycle/v1) and completion of an
 *    activated upgrade, before anything is served or pumped.
 * 6. Opt-in channels (delivery worker + Telegram poller) last, so no send
 *    can precede reconciliation.
 */
export async function startFullApp(input: StartInput): Promise<{ ok: true; handle: FullAppHandle } | { ok: false; gates: PreflightGate[] }> {
  const service = input.service === null ? null : parseServiceConfig(input.service);
  const config = serviceAppConfig(input.config, service);
  const now = input.now ?? Date.now;
  const ledgerGate = input.ledgerGate ?? defaultLedgerGate;
  const requiredEngine = input.requiredEngine ?? "jit.schway.bridge/v1";
  // Never migrate an existing installation at boot; preflight blocks older schemas (run-owner-upgrade).
  const store = input.store ?? new TransactionStore(resolve(input.storePath ?? config.databasePath), { migrateExisting: false });
  const owned = !input.store;
  let managed: ManagedService | undefined;
  let channels: ServiceChannels | null = null;
  const refuse = (gates: PreflightGate[]) => {
    try { managed?.close(); } catch { /* Teardown only. */ }
    if (owned) store.close();
    return { ok: false as const, gates };
  };
  try {
    const preflight = preflightService({ store, config, service, requiredEngine, now, ledgerGate,
      ...(input.transports ? { transports: input.transports } : {}) });
    if (!preflight.ok) return refuse(preflight.gates);
    if (config.runPort === "schway") {
      const bridge = await verifySchwayBridge(store);
      if (!bridge.ok) return refuse([{ gate: "engine", state: "blocked", nextAction: bridge.nextAction, detail: `schway bridge unavailable: ${bridge.detail}` }]);
    }
    const fenced = upgradeFenced(store.path);
    // Pre-listen state preparation runs before the job queue, delivery work or HTTP server exist.
    // Under a fence nothing sends and live state must stay the validated epoch, so it waits for the next boot.
    if (!fenced) prepareServiceState(store, now());
    // exec.box_runtime/v1: a box stop pumps the queue so work waiting as box_capacity is admitted.
    const boxes = createServiceBoxes(store, config, { onCapacity: () => { try { managed?.queue?.pump(); } catch { /* The next tick retries. */ } } });
    // app.connections/v1: values live in the secrets directory, never beside the state, backups or boxes.
    const connections = config.execution.secretsDirectory ? new ConnectionVault(config.execution.secretsDirectory, {
      forbidden: [dirname(resolve(config.databasePath)), service?.stateDirectory, service?.backupDirectory, service?.ledgerPath, config.execution.directory] }) : null;
    // app.approval_cards/v1: approved effects run once, outside every box, only where boxes exist.
    // app.mcp_servers/v1: MCP servers run only in project boxes and their sidecars, so the gateway needs boxes.
    const streams = boxes ? boxStreamsOf(boxes.runtime) : null;
    const mcp = boxes && streams ? new McpGateway(store, { boxes, runtime: streams, vault: connections, sidecarImage: config.execution.images?.base ?? null,
      executionDirectory: config.execution.directory, now }) : null;
    // exec.browser/v1: browser sessions run in project boxes (the browser image when one is pinned) and end with the box.
    const browser = boxes && streams ? new BrowserService(store, { boxes, runtime: streams, now, ...(config.execution.confirmWords ? { confirmWords: config.execution.confirmWords } : {}) }) : null;
    if (boxes && browser) boxes.onStopped(projectId => browser.close(projectId));
    // exec.computer/v1: xdotool on the same virtual display, at `full` only.
    const computer = browser ? new ComputerService(store, browser, { now }) : null;
    // The executor exists wherever boxes do: in-box cards (MCP, browser, computer) need no vault, and without one the
    // credential effects fail `connection_vault_not_configured` cleanly instead of every card being undecidable.
    const web = new WebTools(store, { searxngEnabled: config.searxngEnabled, ...(connections ? { vault: connections } : {}), now, outputBytes: config.jobs.outputBytes });
    const effects = new EffectExecutor(store, { vault: connections, boxes, mirrorRoot: config.execution.directory, now,
      performers: { outbound_release: web.perform, ...(mcp ? { mcp_tool: mcp.perform } : {}), ...(browser ? { browser_confirm: browser.perform } : {}),
        ...(computer ? { computer_confirm: computer.perform } : {}) } });
    const compose = { now, web, prCacheRoot: input.prCacheRoot ?? (service ? resolve(service.stateDirectory, "pr-cache") : ".local/pr-cache"), ...(boxes ? { boxes } : {}),
      ...(effects ? { effects } : {}), ...(mcp ? { mcp } : {}), ...(browser ? { browser } : {}), ...(computer ? { computer } : {}) };
    managed = ManagedService.forConfig(store, config, compose);
    const composed = composeJobQueue(store, config, compose);
    managed.adopt(composed);
    // Same selection as serve (backupNativePortFor); managed backups land in
    // the validated service backup directory, never beside the database.
    const nativeSnapshot = backupNativePortFor(config, store);
    // Constructing the Application first resolves durable upgrade intent left by a crash.
    const app = new Application(store, config, {
      attachmentSanitizer: config.execution.images ? new PodmanAttachmentSanitizer(config.execution.images.base, store.path, config.attachments) : null,
      service: managed, now, ...(service ? { backupDir: service.backupDirectory, ledgerPath: service.ledgerPath } : {}),
      ...(nativeSnapshot ? { nativeSnapshot } : {}), ...(boxes ? { boxes } : {}), ...(connections ? { connections } : {}), ...(effects ? { effects } : {}),
      web, ...(mcp ? { mcp } : {}), ...(browser ? { browser } : {}),
    });
    const ledger = ledgerGate({ store, ledgerPath: service?.ledgerPath ?? null, now: now(), mode: "boot" });
    if (!ledger.trusted) return refuse([{ gate: "quarantine", state: "blocked", nextAction: ledger.nextAction, detail: ledger.reason }]);
    // Reconcile sessions and pending deletions through the composed team port before exposing the app
    // (skipped while an upgrade fence holds admission; activation/rollback reconciles), and complete
    // an activated upgrade once that reconciliation succeeded (ops.schema_migrations/v1).
    const booted = await app.boot();
    // Boxes left running by a previous process count for capacity and the idle sweep.
    await boxes?.reconcile().catch(() => { /* Podman unavailable: boxes are re-ensured (and re-verified) on open. */ });
    // app.mcp_servers/v1: sidecars of the previous process held released values; none may outlive it.
    await mcp?.pruneSidecars().catch(() => { /* Podman unavailable: the next boot prunes again. */ });
    if (service && telegramEnabled(service)) {
      // Preflight proved the token reference and transport; a failure here still fails closed.
      channels = ServiceChannels.start(store, config, input.transports!, now);
    }
    const handle: FullAppHandle = {
      store, app, service: managed, channels, config, serviceConfig: service, boxes, effects, browser, mcp, web,
      boot: { reconciled: booted.reconciled, detail: booted.detail, upgrade: booted.upgrade ? { id: booted.upgrade.id, state: booted.upgrade.state } : null,
        restore: booted.restore ? { id: booted.restore.id, state: booted.restore.state, reason: booted.restore.reason ?? null } : null },
      get queue() { return managed!.queue ?? composed.queue; },
      get teamPort() { return managed!.composed?.teamPort ?? composed.teamPort; },
    };
    return { ok: true, handle };
  } catch (error) {
    try { await channels?.close(); } catch { /* Teardown only. */ }
    try { managed?.close(); } catch { /* Teardown only. */ }
    if (owned) { try { store.close(); } catch { /* Teardown only. */ } }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Serve and stop
// ---------------------------------------------------------------------------

export interface RunningService {
  server: ReturnType<typeof Bun.serve>;
  /** Drains (bounded), stops listening and closes the store. Idempotent. */
  stop(): Promise<DrainResult>;
}

/**
 * Listens on the configured private bind and pumps the managed queue,
 * schedules and opt-in channels. Owner authentication stays enforced by the
 * Web handler; neither the bind address nor a request to `/login` grants
 * owner authority.
 */
export function serveFullApp(handle: FullAppHandle, options: { drainTimeoutMs?: number; intervalMs?: number } = {}): RunningService {
  const config = handle.config;
  // app.webhook_triggers/v1 bodies may reach 32 KiB; owner forms stay capped at config.bodyBytes by the Web handler.
  const server = Bun.serve({ hostname: config.hostname, port: config.port, maxRequestBodySize: Math.max(config.bodyBytes, webhookLimits.bodyBytes * 2, config.attachments.enabled ? attachmentRequestBytes(config.attachments) : 0),
    idleTimeout: 15, fetch: createWebHandler(handle.app), error: () => new Response("Request failed", { status: 503 }) });
  let lastPrTick = 0;
  let lastAttachmentSweep = Date.now();
  const attachments = () => { try { handle.app.sweepAttachments(); } catch { /* Fenced or storage unavailable: retry on the next sweep. */ } };
  attachments();
  let sanitizing = false;
  const sanitize = () => {
    if (sanitizing) return; sanitizing = true;
    void handle.app.processAttachments().catch(() => undefined).finally(() => { sanitizing = false; });
  };
  sanitize();
  let sweeping = false;
  // delivery.attention_levels/v1: recompute open work groups from committed state once at start (restart safety)
  // and on every tick (route waits, deadlines and interrupted work happen inside the queue alone).
  const groups = () => { try { tickWorkGroups(handle.store, config.team, Date.now()); } catch { /* Storage failure: the next tick retries. */ } };
  groups();
  const timer = setInterval(() => {
    if (Date.now() - lastAttachmentSweep >= 60_000) { lastAttachmentSweep = Date.now(); attachments(); }
    sanitize();
    const queue = handle.service.queue;
    if (queue) {
      try { queue.pump(); tickSchedules(handle.store, queue, config, Date.now()); } catch { /* Queue refuses acknowledgments after a storage/ownership failure or under an upgrade fence. */ }
      // app.webhook_triggers/v1 wake mechanism: poll every active PR monitor whose due instant has come (a webhook
      // may only have moved it earlier). Checked once a second; the read port is the same process-owned wiring as pr.snapshot.
      const at = Date.now();
      if (at - lastPrTick >= 1000) {
        lastPrTick = at;
        try { tickPrPolls(handle.store, { now: at, portFor: () => new FakeGitHubFixture(), cacheRoot: ".local/pr-cache", assertOwner: tx => queue.assertOwner(tx) }); }
        catch { /* Ownership lost, storage unavailable or fenced: the next tick decides again. */ }
      }
    }
    // exec.box_runtime/v1 idle stop on the same tick; one sweep at a time.
    // exec.browser/v1: a CDP stream idle for 5 minutes closes.
    handle.browser?.sweep(Date.now());
    if (handle.boxes && !sweeping) {
      sweeping = true;
      void handle.boxes.sweep(Date.now()).catch(() => undefined).finally(() => { sweeping = false; });
    }
    groups();
    handle.channels?.tick();
  }, options.intervalMs ?? 100);
  timer.unref();
  let stopping: Promise<DrainResult> | null = null;
  const drainTimeoutMs = options.drainTimeoutMs ?? (handle.serviceConfig ? serviceDrainTimeoutMs(handle.serviceConfig) : 5000);
  return {
    server,
    stop: () => stopping ??= (async () => {
      clearInterval(timer);
      // Stop accepting requests first so no new owner command lands during the drain; in-flight
      // requests get a short grace period, then idle keep-alive connections are closed.
      await Promise.race([server.stop(), Bun.sleep(2000)]);
      await server.stop(true);
      await handle.app.closeDeviceSignIns();
      await handle.app.closeAttachmentSanitizer();
      let result: DrainResult;
      try { result = await stopDrain(handle, { timeoutMs: drainTimeoutMs }); }
      finally { await handle.web?.searxng.close().catch(() => {}); handle.service.close(); try { handle.store.close(); } catch { /* Already closed. */ } }
      return result;
    })(),
  };
}

export interface DrainResult {
  outcome: "stopped" | "interrupted" | "unknown";
  fencedJobs: number;
  unknownDeliveries: number;
  nextAction: string;
}

/**
 * Drains the full app with bounded cooperative cancellation. Channels stop
 * sending and polling first, then the queue fences admission and in-flight
 * work; the caller waits at most `timeoutMs` for settlement. On timeout the
 * supervisor must terminate, and remote work/delivery is reported as
 * interrupted or unknown, never as stopped or sent. The next start's
 * delivery worker and queue reconciliation consume the recovery metadata.
 */
export async function stopDrain(handle: Pick<FullAppHandle, "queue" | "store"> & { channels?: ServiceChannels | null; effects?: EffectExecutor | null; mcp?: McpGateway | null },
  options: { timeoutMs: number }): Promise<DrainResult> {
  if (!options || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 300000) {
    throw new Error("invalid_drain_options");
  }
  try { await handle.channels?.close(); } catch { /* Ownership already released or store gone; reconciliation handles it. */ }
  // Only attempts this drain interrupted count; historical waiting/blocked/failed jobs are not new interruptions.
  const { interrupted } = handle.queue.close();
  // app.approval_cards/v1: no new effect is claimed and in-flight ones are aborted; they must settle (as `unknown`)
  // before the store closes, or the drain reports `unknown` and the next boot reconciles them.
  handle.effects?.close();
  // app.mcp_servers/v1: installs run outside the queue; none starts now, and running ones get the drain deadline.
  handle.mcp?.close();
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const unsettled = handle.store.read(tx => {
      try { return tx.get<{ count: number }>("SELECT count(*) AS count FROM jobs WHERE occupies = 1 OR state = 'admitted'")!.count; }
      catch { return 1; }
    });
    if (unsettled === 0) break;
    if (Date.now() >= deadline) {
      return { outcome: "unknown", fencedJobs: Math.max(unsettled, interrupted.length), unknownDeliveries: countUnknownDeliveries(handle.store),
        nextAction: "terminate-supervised-process-and-reconcile" };
    }
    await Bun.sleep(5);
  }
  try { await handle.queue.idle(); } catch { /* Settlement already fenced; report honestly below. */ }
  const settledBy = (work: Promise<unknown>, until: number) => Promise.race([work.then(() => true), Bun.sleep(Math.max(0, until - Date.now())).then(() => false)]);
  if (handle.effects && !await settledBy(handle.effects.idle(), deadline)) {
    return { outcome: "unknown", fencedJobs: interrupted.length, unknownDeliveries: countUnknownDeliveries(handle.store), nextAction: "terminate-supervised-process-and-reconcile" };
  }
  // Installs first get the rest of the deadline; whatever still runs is then aborted (`interrupted`) and must settle
  // within a short grace, or the drain reports `unknown` and the next boot reconciles it.
  if (handle.mcp && !await settledBy(handle.mcp.idle(), deadline)) {
    handle.mcp.close({ abort: true });
    if (!await settledBy(handle.mcp.idle(), Date.now() + 2_000)) {
      return { outcome: "unknown", fencedJobs: interrupted.length, unknownDeliveries: countUnknownDeliveries(handle.store), nextAction: "terminate-supervised-process-and-reconcile" };
    }
  }
  return interrupted.length === 0
    ? { outcome: "stopped", fencedJobs: 0, unknownDeliveries: countUnknownDeliveries(handle.store), nextAction: "none" }
    : { outcome: "interrupted", fencedJobs: interrupted.length, unknownDeliveries: countUnknownDeliveries(handle.store),
      nextAction: "reconcile-interrupted-work-before-restart" };
}

function countUnknownDeliveries(store: TransactionStore): number {
  try {
    return store.read(tx => tx.get<{ count: number }>(
      "SELECT count(*) AS count FROM delivery_attempts WHERE record_json LIKE '%\"outcome\":\"unknown\"%'")!.count);
  } catch { return 0; }
}
