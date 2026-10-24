import { realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Application } from "../application";
import { prepareServiceState } from "../bootstrap";
import type { AppConfig } from "../config";
import type { JobQueue } from "../jobs/queue";
import { tickSchedules } from "../jobs/schedules";
import { composeJobQueue } from "../composition";
import type { ApplicationRunPort } from "../team/run-port";
import { verifySchwayBridge } from "../team/schway-port";
import { TransactionStore, schemaVersion } from "../store";
import { createWebHandler } from "../web";
import { backupDirectoryProblem } from "./backup";
import { backupNativePortFor } from "./schway-backup";
import { ServiceChannels, channelReadiness, type ChannelTransportFactory } from "./service-channels";
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

/** Next action while the installation ledger writer is not integrated. */
export const ledgerWriterPendingAction = "integrate-ops02-ledger-checkpoint";

/**
 * Default ledger gate. An installed profile (configured `ledgerPath`) is
 * BLOCKED: this build has no trusted writer for the installation
 * deletion/suppression ledger checkpoint, and an installer placeholder or a
 * file that merely exists proves nothing about current deletion state, so the
 * service stays quarantined (`integrate-ops02-ledger-checkpoint`). The
 * development profile (no installation ledger configured) is trusted.
 * Deterministic tests inject fixture gates; production never does.
 *
 * TODO(#33): OPS02 ships the writer (`src/ops/lifecycle-ledger.ts`,
 * `syncLedgerCheckpoint`). When it lands, replace this default with a gate
 * that returns `trusted` only for `syncLedgerCheckpoint(store, ledgerPath ??
 * ledgerCheckpointPathFor(store.path), now, { write: mode === "boot" })
 * .state === "trusted"` (inspect mode only reads, so the read-only store
 * adapter suffices), so a missing, diverged or unverifiable checkpoint keeps
 * the installation quarantined. Callers already pass the store, path, clock
 * and mode; nothing else in the lifecycle changes.
 */
export const defaultLedgerGate: LedgerGate = ({ ledgerPath }) => {
  if (ledgerPath === null) return { trusted: true, detail: "development profile: no installation ledger configured" };
  return { trusted: false, reason: "installation ledger checkpoint writer not integrated (OPS02 #33); activation stays quarantined",
    nextAction: ledgerWriterPendingAction };
};

/** Reads quarantine state through a ledger gate (inspect mode) without starting anything. */
export function readQuarantine(service: ServiceConfig, store: ReadableStore | null = null, gate: LedgerGate = defaultLedgerGate): { quarantined: boolean; reason: string } {
  try {
    const verdict = gate({ store: store ?? { path: serviceDatabasePath(service), read: () => { throw new Error("store_unavailable"); } }, ledgerPath: service.ledgerPath, now: Date.now(), mode: "inspect" });
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
export function serviceAppConfig(config: AppConfig, service: ServiceConfig | null): AppConfig {
  if (!service) return config;
  const parsed = parseServiceConfig(service);
  return { ...config, databasePath: serviceDatabasePath(parsed), hostname: parsed.network.bindHost, port: parsed.network.port,
    origin: serviceOrigin(parsed), runPort: parsed.runPort ?? config.runPort,
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
    const stateProblem = (() => {
      try {
        const stats = statSync(service.stateDirectory);
        if ((stats.mode & 0o022) !== 0) return "state_directory_writable_by_others";
        if (typeof process.getuid === "function" && stats.uid !== process.getuid()) return "state_directory_foreign_owner";
        return null;
      } catch { return "state_directory_missing"; }
    })();
    // The backup destination holds managed snapshots: it must be a real, service-owned 0700-class directory, never trusted merely for existing.
    const backupProblem = backupDirectoryProblem(service.backupDirectory);
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
  /** Boot reconciliation outcome; `reconciled: false` while an upgrade/restore fence holds. */
  boot: { reconciled: boolean; detail: string; upgrade: { id: string; state: string } | null };
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
    const compose = { now, prCacheRoot: input.prCacheRoot ?? (service ? resolve(service.stateDirectory, "pr-cache") : ".local/pr-cache") };
    managed = ManagedService.forConfig(store, config, compose);
    const composed = composeJobQueue(store, config, compose);
    managed.adopt(composed);
    // Same selection as serve (backupNativePortFor); managed backups land in
    // the validated service backup directory, never beside the database.
    const nativeSnapshot = backupNativePortFor(config, store);
    // Constructing the Application first resolves durable upgrade intent left by a crash.
    const app = new Application(store, config, {
      service: managed, now, ...(service ? { backupDir: service.backupDirectory } : {}),
      ...(nativeSnapshot ? { nativeSnapshot } : {}),
    });
    const ledger = ledgerGate({ store, ledgerPath: service?.ledgerPath ?? null, now: now(), mode: "boot" });
    if (!ledger.trusted) return refuse([{ gate: "quarantine", state: "blocked", nextAction: ledger.nextAction, detail: ledger.reason }]);
    // Reconcile sessions and pending deletions through the composed team port before exposing the app
    // (skipped while an upgrade fence holds admission; activation/rollback reconciles), and complete
    // an activated upgrade once that reconciliation succeeded (ops.schema_migrations/v1).
    const booted = await app.boot();
    if (service && telegramEnabled(service)) {
      // Preflight proved the token reference and transport; a failure here still fails closed.
      channels = ServiceChannels.start(store, config, input.transports!, now);
    }
    const handle: FullAppHandle = {
      store, app, service: managed, channels, config, serviceConfig: service,
      boot: { reconciled: booted.reconciled, detail: booted.detail, upgrade: booted.upgrade ? { id: booted.upgrade.id, state: booted.upgrade.state } : null },
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
  const server = Bun.serve({ hostname: config.hostname, port: config.port, maxRequestBodySize: config.bodyBytes,
    idleTimeout: 15, fetch: createWebHandler(handle.app), error: () => new Response("Request failed", { status: 503 }) });
  const timer = setInterval(() => {
    const queue = handle.service.queue;
    if (queue) {
      try { queue.pump(); tickSchedules(handle.store, queue, config, Date.now()); } catch { /* Queue refuses acknowledgments after a storage/ownership failure or under an upgrade fence. */ }
    }
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
      let result: DrainResult;
      try { result = await stopDrain(handle, { timeoutMs: drainTimeoutMs }); }
      finally { handle.service.close(); try { handle.store.close(); } catch { /* Already closed. */ } }
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
export async function stopDrain(handle: Pick<FullAppHandle, "queue" | "store"> & { channels?: ServiceChannels | null }, options: { timeoutMs: number }): Promise<DrainResult> {
  if (!options || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 300000) {
    throw new Error("invalid_drain_options");
  }
  try { await handle.channels?.close(); } catch { /* Ownership already released or store gone; reconciliation handles it. */ }
  // Only attempts this drain interrupted count; historical waiting/blocked/failed jobs are not new interruptions.
  const { interrupted } = handle.queue.close();
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
