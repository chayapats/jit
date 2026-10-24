import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config";
import { botCredentialConfigured } from "../telegram/secrets";
import { preflightService, serviceAppConfig, type LedgerGate, type ReadableStore } from "./lifecycle";
import { openReadOnlyStore } from "./readonly-store";
import type { ChannelTransportFactory } from "./service-channels";
import { telegramEnabled, type ServiceConfig } from "../../ops/package/service-config";

/** Service lifecycle states. `observed-ready` requires explicit live evidence, never inference. */
export const serviceStates = ["running", "blocked", "observed-ready"] as const;
export type ServiceState = typeof serviceStates[number];

/**
 * Delivery worker ownership. `service` means the worker belongs to the same
 * live process as the scheduler (the running service with Telegram enabled);
 * `owned` means a different live process sends, which blocks activation.
 */
export type WorkerOwnership = "free" | "service" | "owned" | "stale";

export interface ServiceStatusInput {
  now: number;
  scheduler: "free" | "owned" | "stale";
  worker: WorkerOwnership;
  quarantined: boolean;
  /** Explicit live readiness evidence supplied by the caller. Never inferred. */
  evidenceReady: boolean;
  blockedGates: string[];
  /** Non-secret route configuration counts (configured is not verified access). */
  routes?: { total: number; configured: number };
  /** Opt-in channel state; `blocked` means enabled but secret/transport access failed. */
  channels?: "disabled" | "ready" | "blocked";
}

/** Redacted service status. Reads no secrets: only booleans, counts and fixed states. */
export interface ServiceStatus {
  schema: "jit.ops.status/v1";
  observedAt: string;
  service: ServiceState;
  scheduler: "free" | "owned" | "stale";
  worker: WorkerOwnership;
  quarantined: boolean;
  telegram: "configured" | "unconfigured";
  channels: "disabled" | "ready" | "blocked";
  routes: { total: number; configured: number; verified: 0 };
  blockedGates: string[];
  nextAction: string;
}

/**
 * Pure status projection. `observed-ready` is only reachable with explicit
 * evidence; every other honest state stays `running` or `blocked`. Configured
 * routes never count as verified: `routes.verified` stays 0 until live
 * evidence exists outside this projection.
 */
export function serviceStatus(input: ServiceStatusInput): ServiceStatus {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_service_status");
  if (Object.keys(input).some(k => !["now", "scheduler", "worker", "quarantined", "evidenceReady", "blockedGates", "routes", "channels"].includes(k))) {
    throw new Error("invalid_service_status");
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error("invalid_service_status");
  if (!["free", "owned", "stale"].includes(input.scheduler) || !["free", "service", "owned", "stale"].includes(input.worker)) throw new Error("invalid_service_status");
  if (typeof input.quarantined !== "boolean" || typeof input.evidenceReady !== "boolean" ||
      !Array.isArray(input.blockedGates) || input.blockedGates.length > 16 ||
      input.blockedGates.some(g => typeof g !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(g))) {
    throw new Error("invalid_service_status");
  }
  const routes = input.routes ?? { total: 0, configured: 0 };
  if (!Number.isSafeInteger(routes.total) || !Number.isSafeInteger(routes.configured) || routes.configured < 0 || routes.configured > routes.total || routes.total > 8) {
    throw new Error("invalid_service_status");
  }
  const channels = input.channels ?? "disabled";
  if (!["disabled", "ready", "blocked"].includes(channels)) throw new Error("invalid_service_status");
  const blocked = input.quarantined || input.scheduler !== "owned" || input.worker === "owned" || input.blockedGates.length > 0;
  const service: ServiceState = blocked ? "blocked" : input.evidenceReady ? "observed-ready" : "running";
  const nextAction = input.quarantined ? "inspect-quarantine-and-ledger"
    : input.scheduler !== "owned" ? "start-service-under-supervisor"
    : input.worker === "owned" ? "stop-other-delivery-worker"
    : input.blockedGates.length > 0 ? "resolve-blocked-gates" : "none";
  return { schema: "jit.ops.status/v1", observedAt: new Date(input.now).toISOString(), service,
    scheduler: input.scheduler, worker: input.worker, quarantined: input.quarantined,
    telegram: "unconfigured", channels, routes: { total: routes.total, configured: routes.configured, verified: 0 },
    blockedGates: [...input.blockedGates], nextAction };
}

function ownerPid(store: ReadableStore | null, table: "job_scheduler" | "delivery_worker"): { state: "free" | "owned" | "stale"; pid: number | null } {
  if (!store) return { state: "free", pid: null };
  try {
    const row = store.read(tx => tx.get<{ pid: number }>(`SELECT pid FROM ${table} WHERE id = 1`));
    if (!row) return { state: "free", pid: null };
    if (!Number.isSafeInteger(row.pid) || row.pid < 1) return { state: "stale", pid: null };
    try { process.kill(row.pid, 0); return { state: "owned", pid: row.pid }; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? { state: "stale", pid: row.pid } : { state: "owned", pid: row.pid }; }
  } catch { return { state: "free", pid: null }; }
}

/**
 * Gathers service status with read-only checks. Opens a read-only SQLite
 * connection (a missing database is reported as blocked, never created),
 * runs the preflight gates in inspect mode and stats (never reads) the
 * credential file. Scheduler and delivery ownership are reported as fields,
 * not as blocked gates, because the running service owns them. Live
 * readiness stays false here; only explicit OPS05 evidence may set it
 * through `serviceStatus` directly.
 */
export function gatherServiceStatus(config: AppConfig, service: ServiceConfig, options: { ledgerGate?: LedgerGate; transports?: ChannelTransportFactory; requiredEngine?: string } = {}): ServiceStatus {
  const effective = serviceAppConfig(config, service);
  // Read-only connection: status never creates, migrates, journals or chmods the installation.
  const store = openReadOnlyStore(effective.databasePath);
  {
    const scheduler = ownerPid(store, "job_scheduler"), worker = ownerPid(store, "delivery_worker");
    const preflight = preflightService({ store, config: effective, service, requiredEngine: options.requiredEngine ?? "jit.schway.bridge/v1",
      ...(options.ledgerGate ? { ledgerGate: options.ledgerGate } : {}), ...(options.transports ? { transports: options.transports } : {}) });
    const blockedGates = preflight.gates.filter(g => g.state === "blocked" && g.gate !== "scheduler" && g.gate !== "deliveries").map(g => g.gate);
    const channelGate = preflight.gates.find(g => g.gate === "channels");
    const status = serviceStatus({ now: Date.now(), scheduler: scheduler.state,
      worker: worker.state === "owned" && scheduler.state === "owned" && worker.pid === scheduler.pid ? "service" : worker.state,
      quarantined: blockedGates.includes("quarantine"),
      evidenceReady: false, blockedGates,
      routes: { total: service.routes.length, configured: service.routes.filter(r => r.configured).length },
      channels: !telegramEnabled(service) ? "disabled" : channelGate?.state === "blocked" ? "blocked" : "ready" });
    let telegram: "configured" | "unconfigured" = "unconfigured";
    try { telegram = botCredentialConfigured(effective.telegram.botTokenPath) ? "configured" : "unconfigured"; } catch { /* File check only. */ }
    return { ...status, telegram };
  }
}

export function listOpsArtifacts(root: string): string[] {
  try {
    return readdirSync(join(root, ".local", "ops-evidence"))
      .filter(name => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/.test(name))
      .map(name => name.slice(0, -5)).slice(0, 32);
  } catch { return []; }
}
