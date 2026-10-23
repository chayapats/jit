import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { AppConfig } from "../config";
import { botCredentialConfigured } from "../telegram/secrets";
import { TransactionStore } from "../store";
import { readQuarantine } from "./lifecycle";
import type { ServiceConfig } from "../../ops/package/service-config";

/** Service lifecycle states. `observed-ready` requires explicit live evidence, never inference. */
export const serviceStates = ["running", "blocked", "observed-ready"] as const;
export type ServiceState = typeof serviceStates[number];

export interface ServiceStatusInput {
  now: number;
  scheduler: "free" | "owned" | "stale";
  worker: "free" | "owned" | "stale";
  quarantined: boolean;
  /** Explicit live readiness evidence supplied by the caller. Never inferred. */
  evidenceReady: boolean;
  blockedGates: string[];
}

/** Redacted service status. Reads no secrets: only booleans, counts and fixed states. */
export interface ServiceStatus {
  schema: "jit.ops.status/v1";
  observedAt: string;
  service: ServiceState;
  scheduler: "free" | "owned" | "stale";
  worker: "free" | "owned" | "stale";
  quarantined: boolean;
  telegram: "configured" | "unconfigured";
  blockedGates: string[];
  nextAction: string;
}

/**
 * Pure status projection. `observed-ready` is only reachable with explicit
 * evidence; every other honest state stays `running` or `blocked`.
 */
export function serviceStatus(input: ServiceStatusInput): ServiceStatus {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("invalid_service_status");
  if (Object.keys(input).some(k => !["now", "scheduler", "worker", "quarantined", "evidenceReady", "blockedGates"].includes(k))) {
    throw new Error("invalid_service_status");
  }
  if (!Number.isSafeInteger(input.now) || input.now < 0) throw new Error("invalid_service_status");
  for (const role of [input.scheduler, input.worker]) {
    if (!["free", "owned", "stale"].includes(role)) throw new Error("invalid_service_status");
  }
  if (typeof input.quarantined !== "boolean" || typeof input.evidenceReady !== "boolean" ||
      !Array.isArray(input.blockedGates) || input.blockedGates.length > 16 ||
      input.blockedGates.some(g => typeof g !== "string" || !/^[a-z][a-z0-9_-]{0,63}$/.test(g))) {
    throw new Error("invalid_service_status");
  }
  const blocked = input.quarantined || input.scheduler !== "owned" || input.worker === "owned" || input.blockedGates.length > 0;
  const service: ServiceState = blocked ? "blocked" : input.evidenceReady ? "observed-ready" : "running";
  const nextAction = input.quarantined ? "inspect-quarantine-and-ledger"
    : input.scheduler !== "owned" ? "start-service-under-supervisor"
    : input.worker === "owned" ? "stop-other-delivery-worker"
    : input.blockedGates.length > 0 ? "resolve-blocked-gates" : "none";
  return { schema: "jit.ops.status/v1", observedAt: new Date(input.now).toISOString(), service,
    scheduler: input.scheduler, worker: input.worker, quarantined: input.quarantined,
    telegram: "unconfigured", blockedGates: [...input.blockedGates], nextAction };
}

function ownership(store: TransactionStore, table: "job_scheduler" | "delivery_worker"): "free" | "owned" | "stale" {
  try {
    const row = store.read(tx => tx.get<{ pid: number }>(`SELECT pid FROM ${table} WHERE id = 1`));
    if (!row) return "free";
    if (!Number.isSafeInteger(row.pid) || row.pid < 1) return "stale";
    try { process.kill(row.pid, 0); return "owned"; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "stale" : "owned"; }
  } catch { return "free"; }
}

/**
 * Gathers service status with read-only checks. Opens the store for reads only
 * and stats (never reads) the credential file. Live readiness stays false here;
 * only explicit OPS05 evidence may set it through `serviceStatus` directly.
 */
export function gatherServiceStatus(config: AppConfig, service: ServiceConfig): ServiceStatus {
  const store = new TransactionStore(config.databasePath);
  try {
    const status = serviceStatus({ now: Date.now(), scheduler: ownership(store, "job_scheduler"),
      worker: ownership(store, "delivery_worker"), quarantined: readQuarantine(service).quarantined,
      evidenceReady: false, blockedGates: [] });
    let telegram: "configured" | "unconfigured" = "unconfigured";
    try { telegram = botCredentialConfigured(config.telegram.botTokenPath) ? "configured" : "unconfigured"; } catch { /* File check only. */ }
    return { ...status, telegram };
  } finally { store.close(); }
}

export function listOpsArtifacts(root: string): string[] {
  try {
    return readdirSync(join(root, ".local", "ops-evidence"))
      .filter(name => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/.test(name))
      .map(name => name.slice(0, -5)).slice(0, 32);
  } catch { return []; }
}
