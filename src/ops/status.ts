import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config";
import { preflightService, serviceAppConfig, type LedgerGate, type ReadableStore } from "./lifecycle";
import { openReadOnlyStore } from "./readonly-store";
import type { ServiceConfig } from "../../ops/package/service-config";

/** Service lifecycle states. `observed-ready` requires explicit live evidence, never inference. */
export const serviceStates = ["running", "blocked", "observed-ready"] as const;
export type ServiceState = typeof serviceStates[number];

export interface ServiceStatusInput {
  now: number;
  scheduler: "free" | "owned" | "stale";
  quarantined: boolean;
  /** Explicit live readiness evidence supplied by the caller. Never inferred. */
  evidenceReady: boolean;
  blockedGates: string[];
  /** Non-secret route configuration counts (configured is not verified access). */
  routes?: { total: number; configured: number };
}

/** Redacted service status. Reads no secrets: only booleans, counts and fixed states. */
export interface ServiceStatus {
  schema: "jit.ops.status/v1";
  observedAt: string;
  service: ServiceState;
  scheduler: "free" | "owned" | "stale";
  quarantined: boolean;
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
  if (Object.keys(input).some(k => !["now", "scheduler", "quarantined", "evidenceReady", "blockedGates", "routes"].includes(k))) {
    throw new Error("invalid_service_status");
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error("invalid_service_status");
  if (!["free", "owned", "stale"].includes(input.scheduler)) throw new Error("invalid_service_status");
  if (typeof input.quarantined !== "boolean" || typeof input.evidenceReady !== "boolean" ||
      !Array.isArray(input.blockedGates) || input.blockedGates.length > 16 ||
      input.blockedGates.some(g => typeof g !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(g))) {
    throw new Error("invalid_service_status");
  }
  const routes = input.routes ?? { total: 0, configured: 0 };
  if (!Number.isSafeInteger(routes.total) || !Number.isSafeInteger(routes.configured) || routes.configured < 0 || routes.configured > routes.total || routes.total > 8) {
    throw new Error("invalid_service_status");
  }
  const blocked = input.quarantined || input.scheduler !== "owned" || input.blockedGates.length > 0;
  const service: ServiceState = blocked ? "blocked" : input.evidenceReady ? "observed-ready" : "running";
  const nextAction = input.quarantined ? "inspect-quarantine-and-ledger"
    : input.scheduler !== "owned" ? "start-service-under-supervisor"
    : input.blockedGates.length > 0 ? "resolve-blocked-gates" : "none";
  return { schema: "jit.ops.status/v1", observedAt: new Date(input.now).toISOString(), service,
    scheduler: input.scheduler, quarantined: input.quarantined, routes: { total: routes.total, configured: routes.configured, verified: 0 },
    blockedGates: [...input.blockedGates], nextAction };
}

function schedulerOwner(store: ReadableStore | null): { state: "free" | "owned" | "stale"; pid: number | null } {
  if (!store) return { state: "free", pid: null };
  try {
    const row = store.read(tx => tx.get<{ pid: number }>("SELECT pid FROM job_scheduler WHERE id = 1"));
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
 * credential file. Scheduler ownership is reported as a field, not as a
 * blocked gate, because the running service owns it. Live
 * readiness stays false here; only explicit OPS05 evidence may set it
 * through `serviceStatus` directly.
 */
export function gatherServiceStatus(config: AppConfig, service: ServiceConfig, options: { ledgerGate?: LedgerGate; requiredEngine?: string; stateOwnerUid?: number } = {}): ServiceStatus {
  const effective = serviceAppConfig(config, service);
  // Read-only connection: status never creates, migrates, journals or chmods the installation.
  const store = openReadOnlyStore(effective.databasePath);
  {
    const scheduler = schedulerOwner(store);
    const preflight = preflightService({ store, config: effective, service, requiredEngine: options.requiredEngine ?? "jit.schway.bridge/v1",
      ...(options.ledgerGate ? { ledgerGate: options.ledgerGate } : {}),
      ...(options.stateOwnerUid !== undefined ? { stateOwnerUid: options.stateOwnerUid } : {}) });
    const blockedGates = preflight.gates.filter(g => g.state === "blocked" && g.gate !== "scheduler").map(g => g.gate);
    return serviceStatus({ now: Date.now(), scheduler: scheduler.state,
      quarantined: blockedGates.includes("quarantine"),
      evidenceReady: false, blockedGates,
      routes: { total: service.routes.length, configured: service.routes.filter(r => r.configured).length } });
  }
}

export function listOpsArtifacts(root: string): string[] {
  try {
    return readdirSync(join(root, ".local", "ops-evidence"))
      .filter(name => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/.test(name))
      .map(name => name.slice(0, -5)).slice(0, 32);
  } catch { return []; }
}
