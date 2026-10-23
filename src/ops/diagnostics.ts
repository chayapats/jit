import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TransactionStore } from "../store";
import type { AppConfig } from "../config";
import { botCredentialConfigured } from "../telegram/secrets";
import { redactModel, redactRouteId, safeEvidenceId, safeNote, safeOpsAlias } from "./contracts";

/** Fixed route lifecycle states visible to diagnostics; never a readiness promise. */
export const diagnosticRouteStates = ["queued", "admitted", "waiting", "succeeded", "blocked", "failed"] as const;
export type DiagnosticRouteState = typeof diagnosticRouteStates[number];

/** Fixed safe next actions for an inspected installation. */
export const diagnosticActions = ["none", "drain-queue", "resolve-blocked-work", "relieve-disk-pressure",
  "configure-telegram", "inspect-sanitized-diagnostics"] as const;
export type DiagnosticAction = typeof diagnosticActions[number];

/** Read-only inputs gathered by the caller. No tokens, paths or raw diagnostics admitted. */
export interface DiagnosticsInput {
  now: number;
  queue: { available: boolean; queued: number; admitted: number; waiting: number };
  /** Raw route aliases are validated, then redacted in the output. */
  routes: { route: string; model: string | null; state: DiagnosticRouteState; attempts: number }[];
  budgets: { exhausted: number; deadlineFailed: number };
  disk: { stateBytes: number; watermarkBytes: number };
  telegram: { configured: boolean; pendingIntents: number; unknownDeliveries: number };
  /** Sanitized ops-evidence record IDs present in local storage. */
  artifacts: string[];
}

/** Redacted, read-only installation snapshot. Safe to print; never mutates state or calls home. */
export interface Diagnostics {
  schema: "jit.ops.diagnostics/v1";
  observedAt: string;
  queue: { available: boolean; queued: number; admitted: number; waiting: number };
  routes: { reference: string; model: "redacted" | "unselected"; state: DiagnosticRouteState; attempts: number }[];
  budgets: { exhausted: number; deadlineFailed: number };
  disk: { stateBytes: number; watermarkBytes: number; pressure: boolean };
  connections: { telegram: "configured" | "unconfigured"; pendingIntents: number; unknownDeliveries: number };
  artifacts: { count: number; references: string[] };
  nextAction: DiagnosticAction;
}

const count = (v: unknown, max: number): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > max) throw new Error("invalid_diagnostics");
  return v as number;
};

/**
 * Projects a redacted diagnostics snapshot. Pure and read-only: it performs no I/O,
 * enables no telemetry, and replaces route/model identifiers with ordinal references.
 */
export function inspectDiagnostics(input: DiagnosticsInput): Diagnostics {
  const fail = (): never => { throw new Error("invalid_diagnostics"); };
  if (!input || typeof input !== "object" || Array.isArray(input)) fail();
  const keys = Object.keys(input);
  if (keys.some(k => !["now", "queue", "routes", "budgets", "disk", "telegram", "artifacts"].includes(k))) fail();
  if (!Number.isSafeInteger(input.now) || input.now < 0) fail();
  const q = input.queue;
  if (!q || typeof q !== "object" || typeof q.available !== "boolean") fail();
  const queue = { available: q.available, queued: count(q.queued, 10000), admitted: count(q.admitted, 32), waiting: count(q.waiting, 10000) };
  if (!Array.isArray(input.routes) || input.routes.length > 8) fail();
  const routes = input.routes.map((r, index) => {
    if (!r || typeof r !== "object" || safeOpsAlias((r as { route: unknown }).route) !== (r as { route: string }).route ||
        ((r as { model: unknown }).model !== null && safeOpsAlias((r as { model: unknown }).model) !== (r as { model: string }).model) ||
        !diagnosticRouteStates.includes((r as { state: DiagnosticRouteState }).state)) fail();
    const row = r as { route: string; model: string | null; state: DiagnosticRouteState; attempts: number };
    return { reference: redactRouteId(index), model: redactModel(row.model), state: row.state, attempts: count(row.attempts, 1000000) };
  });
  const b = input.budgets;
  if (!b || typeof b !== "object") fail();
  const budgets = { exhausted: count(b.exhausted, 10000), deadlineFailed: count(b.deadlineFailed, 10000) };
  const d = input.disk;
  if (!d || typeof d !== "object") fail();
  const disk = { stateBytes: count(d.stateBytes, 1099511627776), watermarkBytes: count(d.watermarkBytes, 1099511627776), pressure: false };
  disk.pressure = disk.stateBytes > disk.watermarkBytes;
  const t = input.telegram;
  if (!t || typeof t !== "object" || typeof t.configured !== "boolean") fail();
  const connections = { telegram: (t.configured ? "configured" : "unconfigured") as "configured" | "unconfigured",
    pendingIntents: count(t.pendingIntents, 10000), unknownDeliveries: count(t.unknownDeliveries, 10000) };
  if (!Array.isArray(input.artifacts) || input.artifacts.length > 32) fail();
  const artifacts = { count: input.artifacts.length, references: input.artifacts.map(a => safeEvidenceId(a)) };
  const nextAction: DiagnosticAction =
    disk.pressure ? "relieve-disk-pressure"
    : !queue.available ? "inspect-sanitized-diagnostics"
    : budgets.exhausted + budgets.deadlineFailed > 0 || queue.waiting > 0 ? "resolve-blocked-work"
    : queue.queued + queue.admitted > 0 ? "drain-queue"
    : !t.configured ? "configure-telegram"
    : "none";
  // Notes are fixed vocabulary; nothing caller-supplied reaches the snapshot beyond validated counts.
  safeNote(nextAction);
  return { schema: "jit.ops.diagnostics/v1", observedAt: new Date(input.now).toISOString(),
    queue, routes, budgets, disk, connections, artifacts, nextAction };
}

/** Sums managed-state bytes without following symlinks or reading file contents. */
function managedStateBytes(path: string): number {
  let total = 0, entries = 0;
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (++entries > 100000) throw new Error("diagnostics_state_too_large");
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile()) total += statSync(full).size;
    }
  };
  try { walk(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return total;
}

interface StoredJob {
  state: string;
  reason: string;
  route: { provider: unknown; model: unknown };
}

/** Best-effort decode of one stored job row; malformed rows count as blocked without details. */
function decodeJob(recordJson: string): StoredJob | null {
  try {
    const job = JSON.parse(recordJson) as { state?: unknown; reason?: unknown; route?: { provider?: unknown; model?: unknown } };
    if (typeof job.state !== "string" || typeof job.reason !== "string" || !job.route || typeof job.route !== "object") return null;
    return { state: job.state, reason: job.reason, route: { provider: job.route.provider, model: job.route.model } };
  } catch { return null; }
}

/**
 * Gathers read-only diagnostics inputs from an installation. Opens the store for
 * reads only: no scheduler claim, no queue pump, no timers, no network, no secret
 * output. Callers must not run background work around this call.
 */
export function gatherDiagnostics(root: string, config: AppConfig, now: number = Date.now()): DiagnosticsInput {
  const store = new TransactionStore(config.databasePath);
  try {
    const jobs = store.read(tx => {
      try {
        return tx.all<{ record_json: string }>("SELECT record_json FROM jobs LIMIT 10001").map(r => r.record_json);
      } catch { return []; }
    });
    const decoded = jobs.map(decodeJob);
    const queued = decoded.filter(j => j?.state === "queued").length;
    const admitted = decoded.filter(j => j?.state === "admitted").length;
    const waiting = decoded.filter(j => j?.state === "waiting").length;
    const available = store.read(tx => {
      try { return tx.get<{ token: string }>("SELECT token FROM job_scheduler WHERE id = 1") === null; }
      catch { return false; }
    });
    const seen = new Map<string, { route: string; model: string | null; state: DiagnosticRouteState; attempts: number }>();
    for (const job of decoded) {
      if (!job || typeof job.route.provider !== "string" || (job.route.model !== null && typeof job.route.model !== "string")) continue;
      if (!diagnosticRouteStates.includes(job.state as DiagnosticRouteState)) continue;
      const key = `${job.route.provider} ${job.route.model ?? ""} ${job.state}`;
      const row = seen.get(key) ?? { route: job.route.provider, model: job.route.model, state: job.state as DiagnosticRouteState, attempts: 0 };
      row.attempts++;
      seen.set(key, row);
      if (seen.size >= 8) break;
    }
    const exhausted = decoded.filter(j => j?.state === "blocked" && j.reason === "budget_exhausted").length;
    const deadlineFailed = decoded.filter(j => j?.state === "failed" && j.reason === "deadline").length;
    const delivery = store.read(tx => {
      try {
        const pending = tx.get<{ count: number }>("SELECT count(*) AS count FROM delivery_intents WHERE status IN ('pending', 'claimed', 'waiting')")!.count;
        const unknownCount = tx.get<{ count: number }>("SELECT count(*) AS count FROM delivery_attempts WHERE record_json LIKE '%\"outcome\":\"unknown\"%'")!.count;
        return { pendingIntents: pending, unknownDeliveries: unknownCount };
      } catch { return { pendingIntents: 0, unknownDeliveries: 0 }; }
    });
    let artifacts: string[] = [];
    try {
      artifacts = readdirSync(join(root, ".local", "ops-evidence"))
        .filter(name => /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}\.json$/.test(name))
        .map(name => name.slice(0, -5)).slice(0, 32);
    } catch { /* Missing evidence storage is reported as zero artifacts, not a failure. */ }
    return { now,
      queue: { available, queued, admitted, waiting },
      routes: [...seen.values()],
      budgets: { exhausted, deadlineFailed },
      disk: { stateBytes: managedStateBytes(join(root, ".local")), watermarkBytes: config.ops.diskWatermarkBytes },
      telegram: { configured: botCredentialConfigured(config.telegram.botTokenPath),
        pendingIntents: delivery.pendingIntents, unknownDeliveries: delivery.unknownDeliveries },
      artifacts };
  } finally { store.close(); }
}
