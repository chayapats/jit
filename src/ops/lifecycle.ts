import { chmodSync, copyFileSync, existsSync, mkdirSync, openSync, closeSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { Application } from "../application";
import type { AppConfig } from "../config";
import type { JobQueue } from "../jobs/queue";
import { composeJobQueue } from "../composition";
import type { ApplicationRunPort } from "../team/run-port";
import { TransactionStore, schemaVersion } from "../store";
import { backupNativePortFor } from "./schway-backup";
import { validateArtifact, type BuildManifest } from "../../ops/package/bun-build";
import { parseServiceConfig, type ServiceConfig } from "../../ops/package/service-config";

/** Fixed preflight gates. A blocked gate never implies its remedy is authorized. */
export const preflightGates = ["config", "schema", "engine", "quarantine", "scheduler", "deliveries", "secrets", "artifact"] as const;
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

export interface PreflightInput {
  store: TransactionStore;
  config: AppConfig;
  service: ServiceConfig;
  requiredEngine: string;
  artifact?: BuildManifest;
  now?: () => number;
}

function alive(pid: unknown): boolean {
  if (!Number.isSafeInteger(pid) || (pid as number) < 1) return false;
  try { process.kill(pid as number, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
}

function ledgerOk(ledgerPath: string): boolean {
  try {
    const raw = JSON.parse(readFileSync(ledgerPath, "utf8")) as { ledger?: unknown; revision?: unknown };
    return raw.ledger === "jit.deletion.ledger/v1" && Number.isSafeInteger(raw.revision) && (raw.revision as number) >= 1;
  } catch { return false; }
}

/** Reads quarantine state without starting anything: a missing ledger keeps the install quarantined. */
export function readQuarantine(service: ServiceConfig): { quarantined: boolean; reason: string } {
  if (!ledgerOk(service.ledgerPath)) return { quarantined: true, reason: "missing deletion ledger; restore stays quarantined" };
  return { quarantined: false, reason: "ledger present" };
}

/**
 * Preflight gates full-app activation. Read-only except for opening the store,
 * which migrates exactly as serve would. Jobs, memory assembly and deliveries
 * stay disabled until every gate is ready; callers keep a read-only status path.
 */
export function preflightService(input: PreflightInput): PreflightResult {
  const gates: PreflightGate[] = [];
  let service: ServiceConfig;
  try { service = parseServiceConfig(input.service); }
  catch { return { ok: false, gates: [{ gate: "config", state: "blocked", nextAction: "fix-service-configuration", detail: "service configuration rejected" }] }; }
  const dirReady = (path: string): boolean => {
    try { return statSync(path).isDirectory(); } catch { return false; }
  };
  gates.push(dirReady(service.stateDirectory) && dirReady(service.backupDirectory) && dirReady(service.workingDirectory)
    ? { gate: "config", state: "ready", nextAction: "none", detail: "service directories present" }
    : { gate: "config", state: "blocked", nextAction: "prepare-service-directories", detail: "service directory missing" });
  let userVersion: number | null = null;
  try { userVersion = input.store.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!).user_version; } catch { /* Stay blocked below. */ }
  gates.push(userVersion !== null && userVersion <= schemaVersion
    ? { gate: "schema", state: "ready", nextAction: "none", detail: `state schema ${userVersion} within app schema ${schemaVersion}` }
    : { gate: "schema", state: "blocked", nextAction: "use-compatible-app-artifact", detail: "state schema unreadable or newer than app" });
  gates.push(input.requiredEngine === "jit.schway.bridge/v1"
    ? { gate: "engine", state: "ready", nextAction: "none", detail: "declared bridge contract only; live capability proven separately" }
    : { gate: "engine", state: "blocked", nextAction: "use-supported-engine-contract", detail: "engine contract not supported" });
  const quarantine = readQuarantine(service);
  gates.push(!quarantine.quarantined
    ? { gate: "quarantine", state: "ready", nextAction: "none", detail: quarantine.reason }
    : { gate: "quarantine", state: "blocked", nextAction: "inspect-quarantine-and-ledger", detail: quarantine.reason });
  const schedulerPid = input.store.read(tx => {
    try { return tx.get<{ pid: number }>("SELECT pid FROM job_scheduler WHERE id = 1")?.pid ?? null; } catch { return null; }
  });
  gates.push(schedulerPid === null || !alive(schedulerPid)
    ? { gate: "scheduler", state: "ready", nextAction: "none", detail: schedulerPid === null ? "admission free" : "stale owner; takeover permitted" }
    : { gate: "scheduler", state: "blocked", nextAction: "stop-other-instance", detail: "another scheduler owns admission" });
  const workerPid = input.store.read(tx => {
    try { return tx.get<{ pid: number }>("SELECT pid FROM delivery_worker WHERE id = 1")?.pid ?? null; } catch { return null; }
  });
  gates.push(workerPid === null || !alive(workerPid)
    ? { gate: "deliveries", state: "ready", nextAction: "none", detail: "delivery worker free" }
    : { gate: "deliveries", state: "blocked", nextAction: "stop-other-delivery-worker", detail: "another delivery worker owns sending" });
  const secretProblems: string[] = [];
  for (const ref of service.secretRefs) {
    if (ref.store === "credential-file") {
      try {
        const mode = statSync(ref.key).mode & 0o777;
        if ((mode & 0o077) !== 0 || !statSync(ref.key).isFile()) secretProblems.push(ref.name);
      } catch { secretProblems.push(ref.name); }
    } else {
      secretProblems.push(ref.name);
    }
  }
  gates.push(secretProblems.length === 0
    ? { gate: "secrets", state: "ready", nextAction: "none", detail: "credential files present with safe modes" }
    : { gate: "secrets", state: "blocked", nextAction: "verify-secret-store", detail: "secret store access unverified" });
  if (input.artifact) {
    gates.push(input.artifact.schemaVersion <= schemaVersion && input.artifact.engineContract === input.requiredEngine
      ? { gate: "artifact", state: "ready", nextAction: "none", detail: "pinned artifact compatible" }
      : { gate: "artifact", state: "blocked", nextAction: "use-compatible-app-artifact", detail: "artifact incompatible" });
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

export interface FullAppHandle {
  store: TransactionStore;
  queue: JobQueue;
  /** Team port the composed queue reconciles native runs against. */
  teamPort: ApplicationRunPort;
  app: Application;
}

export interface StartInput {
  config: AppConfig;
  service: ServiceConfig;
  storePath?: string;
  store?: TransactionStore;
  requiredEngine?: string;
  now?: () => number;
}

/**
 * Starts the composed full application after preflight. A blocked preflight
 * returns its gates instead of enabling jobs, memory assembly or deliveries.
 */
export function startFullApp(input: StartInput): { ok: true; handle: FullAppHandle } | { ok: false; gates: PreflightGate[] } {
  const service = parseServiceConfig(input.service);
  const quarantine = readQuarantine(service);
  if (quarantine.quarantined) {
    return { ok: false, gates: [{ gate: "quarantine", state: "blocked", nextAction: "inspect-quarantine-and-ledger", detail: quarantine.reason }] };
  }
  const now = input.now ?? Date.now;
  const store = input.store ?? new TransactionStore(resolve(input.storePath ?? join(service.stateDirectory, "app.sqlite")));
  let queue: JobQueue | undefined;
  try {
    const preflight = preflightService({ store, config: input.config, service, requiredEngine: input.requiredEngine ?? "jit.schway.bridge/v1" });
    if (!preflight.ok) {
      if (!input.store) store.close();
      return { ok: false, gates: preflight.gates };
    }
    const composed = composeJobQueue(store, input.config, { now });
    queue = composed.queue;
    // Same selection as serve (backupNativePortFor); managed backups land in
    // the validated service backup directory, never beside the database.
    const nativeSnapshot = backupNativePortFor(input.config, store);
    const app = new Application(store, input.config, {
      jobs: queue, now, backupDir: service.backupDirectory,
      ...(nativeSnapshot ? { nativeSnapshot } : {}),
    });
    return { ok: true, handle: { store, queue, teamPort: composed.teamPort, app } };
  } catch (error) {
    try { queue?.close(); } catch { /* Teardown only. */ }
    if (!input.store) { try { store.close(); } catch { /* Teardown only. */ } }
    throw error;
  }
}

export interface DrainResult {
  outcome: "stopped" | "interrupted" | "unknown";
  fencedJobs: number;
  unknownDeliveries: number;
  nextAction: string;
}

/**
 * Drains the full app with bounded cooperative cancellation. The queue fences
 * admission and in-flight work first; the caller waits at most `timeoutMs` for
 * settlement. On timeout the supervisor must terminate, and remote
 * work/delivery is reported as interrupted or unknown, never as stopped or sent.
 */
export async function stopDrain(handle: Pick<FullAppHandle, "queue" | "store">, options: { timeoutMs: number }): Promise<DrainResult> {
  if (!options || !Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 0 || options.timeoutMs > 300000) {
    throw new Error("invalid_drain_options");
  }
  handle.queue.close();
  const deadline = Date.now() + options.timeoutMs;
  for (;;) {
    const unsettled = handle.store.read(tx => {
      try { return tx.get<{ count: number }>("SELECT count(*) AS count FROM jobs WHERE occupies = 1 OR state = 'admitted'")!.count; }
      catch { return 1; }
    });
    if (unsettled === 0) break;
    if (Date.now() >= deadline) {
      return { outcome: "unknown", fencedJobs: unsettled, unknownDeliveries: countUnknownDeliveries(handle.store),
        nextAction: "terminate-supervised-process-and-reconcile" };
    }
    await Bun.sleep(5);
  }
  try { await handle.queue.idle(); } catch { /* Settlement already fenced; report honestly below. */ }
  const fenced = handle.store.read(tx => {
    try {
      return tx.all<{ record_json: string }>("SELECT record_json FROM jobs WHERE state IN ('waiting', 'blocked', 'failed')").length;
    } catch { return 0; }
  });
  return fenced === 0
    ? { outcome: "stopped", fencedJobs: 0, unknownDeliveries: countUnknownDeliveries(handle.store), nextAction: "none" }
    : { outcome: "interrupted", fencedJobs: fenced, unknownDeliveries: countUnknownDeliveries(handle.store),
      nextAction: "reconcile-interrupted-work-before-restart" };
}

function countUnknownDeliveries(store: TransactionStore): number {
  try {
    return store.read(tx => tx.get<{ count: number }>(
      "SELECT count(*) AS count FROM delivery_attempts WHERE record_json LIKE '%\"outcome\":\"unknown\"%'")!.count);
  } catch { return 0; }
}

export interface UpgradeInput {
  store: TransactionStore;
  /** Active installation directory holding app.sqlite and artifact.json. */
  activeDir: string;
  /** Staged artifact directory produced by the package build. */
  artifactDir: string;
  backupRoot: string;
  ledgerPath: string;
  requiredEngine: string;
  health: () => boolean | Promise<boolean>;
}

export interface UpgradeResult {
  outcome: "upgraded" | "rolled-back" | "blocked";
  backupId: string | null;
  detail: string;
}

function fsyncFile(path: string): void {
  const fd = openSync(path, "r");
  try { (Bun as unknown as { fsyncSync(fd: number): void }).fsyncSync?.(fd); } finally { closeSync(fd); }
}

/**
 * Stages an upgrade through a validated pinned artifact with a recovery backup
 * before touching active state. Migration semantics belong to the open OPS06
 * (#32) path; this step records the backup pair and rolls back on failed
 * health, preserving the ledger byte-for-byte. Rollback restores only the
 * recorded compatible pair, never a rewritten ledger.
 */
export async function upgradeStaged(input: UpgradeInput): Promise<UpgradeResult> {
  const activeDir = resolve(input.activeDir), artifactDir = resolve(input.artifactDir), backupRoot = resolve(input.backupRoot);
  let manifest: BuildManifest | null = null;
  try {
    if (!validateArtifact(artifactDir).ok) return { outcome: "blocked", backupId: null, detail: "staged artifact failed validation" };
    manifest = JSON.parse(readFileSync(join(artifactDir, "manifest.json"), "utf8")) as BuildManifest;
  } catch { return { outcome: "blocked", backupId: null, detail: "staged artifact failed validation" }; }
  if (!manifest || manifest.schemaVersion > schemaVersion || manifest.engineContract !== input.requiredEngine) {
    return { outcome: "blocked", backupId: null, detail: "staged artifact incompatible with app and engine pins" };
  }
  const activeDb = join(activeDir, "app.sqlite"), activeMarker = join(activeDir, "artifact.json");
  if (!existsSync(activeDb)) return { outcome: "blocked", backupId: null, detail: "active state missing" };
  const backupId = randomUUID(), backupDir = join(backupRoot, backupId);
  mkdirSync(backupDir, { recursive: true, mode: 0o700 });
  const backupDb = join(backupDir, "app.sqlite"), backupMarker = join(backupDir, "artifact.json");
  copyFileSync(activeDb, backupDb);
  chmodSync(backupDb, 0o600);
  fsyncFile(backupDb);
  if (existsSync(activeMarker)) copyFileSync(activeMarker, backupMarker);
  writeFileSync(join(backupDir, "manifest.json"), JSON.stringify({ artifactId: manifest.artifactId, schemaVersion: manifest.schemaVersion }) + "\n", { mode: 0o600 });
  const previousMarker = existsSync(activeMarker) ? readFileSync(activeMarker) : null;
  writeFileSync(activeMarker, JSON.stringify({ artifactId: manifest.artifactId, stagedAt: new Date().toISOString() }) + "\n", { mode: 0o600 });
  let healthy = false;
  try { healthy = await input.health(); } catch { healthy = false; }
  if (healthy) return { outcome: "upgraded", backupId, detail: `active state now pinned to ${manifest.artifactId}` };
  copyFileSync(backupDb, activeDb);
  chmodSync(activeDb, 0o600);
  if (previousMarker) writeFileSync(activeMarker, previousMarker, { mode: 0o600 });
  return { outcome: "rolled-back", backupId, detail: "health check failed; backup pair restored, ledger untouched" };
}
