import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { TransactionStore, schemaVersion } from "../store";
import type { AppConfig } from "../config";
import { botCredentialConfigured } from "../telegram/secrets";
import { SCHWAY_RELEASE_CONTRACT, schwayHostDirs } from "../team/schway-port";
import { hostCapabilities } from "schway/host";
import { redactModel, redactRouteId, safeEvidenceId, safeNote, safeOpsAlias } from "./contracts";
import { activeUpgrade, upgradeDirFor, type UpgradeState } from "./upgrade";
import { readUpgradeFence } from "./upgrade-fence";

/** Fixed route lifecycle states visible to diagnostics; never a readiness promise. */
export const diagnosticRouteStates = ["queued", "admitted", "waiting", "succeeded", "blocked", "failed"] as const;
export type DiagnosticRouteState = typeof diagnosticRouteStates[number];

/**
 * Fixed safe next actions for an inspected installation, in priority order.
 * None of them is authorized by diagnostics: each names the owner runbook
 * step (docs/runbooks/ops-load-drill.md) that the owner may choose to take.
 */
export const diagnosticActions = ["none", "finish-or-rollback-upgrade", "resolve-restore-quarantine", "run-owner-upgrade",
  "use-compatible-app-artifact", "relieve-disk-pressure", "restore-engine", "inspect-sanitized-diagnostics",
  "configure-provider-route", "reconnect-provider-login", "reauthorize-owner-work", "wait-for-quota-then-resume",
  "resolve-unknown-delivery", "resolve-blocked-work", "drain-queue", "configure-telegram", "bind-telegram"] as const;
export type DiagnosticAction = typeof diagnosticActions[number];

/** Upgrade journal states diagnostics may report; anything else is rejected. */
const upgradeStates: readonly UpgradeState[] = ["preparing", "prepared", "staged", "ready", "activating", "activated",
  "complete", "blocked", "failed", "rolled_back"];

/** Read-only inputs gathered by the caller. No tokens, paths or raw diagnostics admitted. */
export interface DiagnosticsInput {
  now: number;
  queue: { available: boolean; queued: number; admitted: number; waiting: number };
  /** Raw route aliases are validated, then redacted in the output. */
  routes: { route: string; model: string | null; state: DiagnosticRouteState; attempts: number }[];
  budgets: { exhausted: number; deadlineFailed: number };
  /** Jobs held on their exact route by an external condition, or fenced by an authority change. */
  waits: { quota: number; needsLogin: number; routeUnavailable: number; authorizationChanged: number };
  disk: { stateBytes: number; watermarkBytes: number };
  telegram: { configured: boolean; binding: "unbound" | "pending" | "bound"; pendingIntents: number; unknownDeliveries: number };
  /** Run-port mode and whether its declared engine identity is usable. Never a live probe. */
  engine: { mode: "scripted" | "schway"; available: boolean };
  /**
   * Distinct configured provider routes, and routes with live observed-ready
   * evidence. Observation comes only from explicit host evidence; diagnose
   * itself never probes, so its gather always supplies 0.
   */
  providers: { configuredRoutes: number; observedRoutes: number };
  /** Live database `user_version` against the schema this build supports. */
  schema: { current: number; supported: number };
  /** Durable admission fence and the active upgrade journal state, if any. */
  upgrade: { fence: "none" | "upgrade" | "restore" | "unreadable"; activeState: UpgradeState | null };
  /** Non-terminal restore quarantines (OPS02), and how many of them are blocked. */
  restore: { open: number; blocked: number };
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
  waits: { quota: number; needsLogin: number; routeUnavailable: number; authorizationChanged: number };
  disk: { stateBytes: number; watermarkBytes: number; pressure: boolean };
  connections: { telegram: "configured" | "unconfigured"; binding: "unbound" | "pending" | "bound"; pendingIntents: number; unknownDeliveries: number };
  /** `scripted` has no engine; `declared` means the pinned release contract matches, not that a run was observed. */
  engine: { mode: "scripted" | "schway"; state: "scripted" | "declared" | "unavailable"; observed: "not-observed" };
  /** Readiness uses the host-evidence vocabulary: configured routes stay `configured-unverified` without live evidence. */
  providers: { configuredRoutes: number; observedRoutes: number; readiness: "not-configured" | "configured-unverified" | "observed-ready" };
  schemaVersion: { current: number; supported: number; state: "current" | "upgrade-required" | "newer-unsupported" };
  upgrade: { fence: "none" | "upgrade" | "restore" | "unreadable"; activeState: UpgradeState | null };
  restore: { open: number; blocked: number; state: "none" | "quarantine-open" | "quarantine-blocked" };
  artifacts: { count: number; references: string[] };
  /** Highest-priority applicable action; `nextActions` lists every applicable one in priority order. */
  nextAction: DiagnosticAction;
  nextActions: DiagnosticAction[];
}

const count = (v: unknown, max: number): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > max) throw new Error("invalid_diagnostics");
  return v as number;
};

const inputKeys = ["now", "queue", "routes", "budgets", "waits", "disk", "telegram", "engine", "providers", "schema", "upgrade", "restore", "artifacts"];

/**
 * Projects a redacted diagnostics snapshot. Pure and read-only: it performs no I/O,
 * enables no telemetry, and replaces route/model identifiers with ordinal references.
 * Every input field is required and bounded; unknown keys fail closed.
 */
export function inspectDiagnostics(input: DiagnosticsInput): Diagnostics {
  const fail = (): never => { throw new Error("invalid_diagnostics"); };
  const object = (v: unknown): void => { if (!v || typeof v !== "object" || Array.isArray(v)) fail(); };
  object(input);
  const keys = Object.keys(input);
  if (keys.length !== inputKeys.length || keys.some(k => !inputKeys.includes(k))) fail();
  if (!Number.isSafeInteger(input.now) || input.now < 0) fail();
  const q = input.queue;
  object(q);
  if (typeof q.available !== "boolean") fail();
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
  object(b);
  const budgets = { exhausted: count(b.exhausted, 10000), deadlineFailed: count(b.deadlineFailed, 10000) };
  const w = input.waits;
  object(w);
  const waits = { quota: count(w.quota, 10000), needsLogin: count(w.needsLogin, 10000),
    routeUnavailable: count(w.routeUnavailable, 10000), authorizationChanged: count(w.authorizationChanged, 10000) };
  const d = input.disk;
  object(d);
  const disk = { stateBytes: count(d.stateBytes, 1099511627776), watermarkBytes: count(d.watermarkBytes, 1099511627776), pressure: false };
  disk.pressure = disk.stateBytes > disk.watermarkBytes;
  const t = input.telegram;
  object(t);
  if (typeof t.configured !== "boolean" || !["unbound", "pending", "bound"].includes(t.binding)) fail();
  const connections = { telegram: (t.configured ? "configured" : "unconfigured") as "configured" | "unconfigured",
    binding: t.binding, pendingIntents: count(t.pendingIntents, 10000), unknownDeliveries: count(t.unknownDeliveries, 10000) };
  const e = input.engine;
  object(e);
  if ((e.mode !== "scripted" && e.mode !== "schway") || typeof e.available !== "boolean") fail();
  const engine = { mode: e.mode, state: (e.mode === "scripted" ? "scripted" : e.available ? "declared" : "unavailable") as Diagnostics["engine"]["state"],
    observed: "not-observed" as const };
  const p = input.providers;
  object(p);
  const configuredRoutes = count(p.configuredRoutes, 64), observedRoutes = count(p.observedRoutes, 64);
  if (observedRoutes > configuredRoutes) fail();
  const providers = { configuredRoutes, observedRoutes,
    readiness: (configuredRoutes === 0 ? "not-configured" : observedRoutes > 0 ? "observed-ready" : "configured-unverified") as Diagnostics["providers"]["readiness"] };
  const s = input.schema;
  object(s);
  const schema = { current: count(s.current, 100000), supported: count(s.supported, 100000), state: "current" as Diagnostics["schemaVersion"]["state"] };
  if (schema.supported < 1) fail();
  schema.state = schema.current === schema.supported ? "current" : schema.current < schema.supported ? "upgrade-required" : "newer-unsupported";
  const u = input.upgrade;
  object(u);
  if (!["none", "upgrade", "restore", "unreadable"].includes(u.fence) || (u.activeState !== null && !upgradeStates.includes(u.activeState))) fail();
  const upgrade = { fence: u.fence, activeState: u.activeState };
  const r = input.restore;
  object(r);
  const restore = { open: count(r.open, 100), blocked: count(r.blocked, 100), state: "none" as Diagnostics["restore"]["state"] };
  if (restore.blocked > restore.open) fail();
  restore.state = restore.blocked > 0 ? "quarantine-blocked" : restore.open > 0 ? "quarantine-open" : "none";
  if (!Array.isArray(input.artifacts) || input.artifacts.length > 32) fail();
  const artifacts = { count: input.artifacts.length, references: input.artifacts.map(a => safeEvidenceId(a)) };
  const applicable: [boolean, DiagnosticAction][] = [
    // An active journal is fenced or activated-awaiting-reconcile; either way the owner finishes or rolls it back.
    [upgrade.fence === "upgrade" || upgrade.fence === "unreadable" ||
      (upgrade.activeState !== null && !["complete", "failed", "rolled_back"].includes(upgrade.activeState)), "finish-or-rollback-upgrade"],
    [upgrade.fence === "restore" || restore.open > 0, "resolve-restore-quarantine"],
    [schema.state === "upgrade-required", "run-owner-upgrade"],
    [schema.state === "newer-unsupported", "use-compatible-app-artifact"],
    [disk.pressure, "relieve-disk-pressure"],
    [engine.state === "unavailable", "restore-engine"],
    [!queue.available, "inspect-sanitized-diagnostics"],
    [engine.mode === "schway" && providers.configuredRoutes === 0, "configure-provider-route"],
    [waits.needsLogin > 0, "reconnect-provider-login"],
    [waits.authorizationChanged > 0, "reauthorize-owner-work"],
    [waits.quota > 0 || waits.routeUnavailable > 0, "wait-for-quota-then-resume"],
    [connections.unknownDeliveries > 0, "resolve-unknown-delivery"],
    [budgets.exhausted + budgets.deadlineFailed > 0 || queue.waiting > waits.quota + waits.needsLogin + waits.routeUnavailable, "resolve-blocked-work"],
    [queue.queued + queue.admitted > 0, "drain-queue"],
    [!t.configured, "configure-telegram"],
    [t.configured && t.binding !== "bound", "bind-telegram"],
  ];
  const nextActions = applicable.filter(([applies]) => applies).map(([, action]) => action);
  const nextAction: DiagnosticAction = nextActions[0] ?? "none";
  // Actions are fixed vocabulary; nothing caller-supplied reaches the snapshot beyond validated counts and enums.
  for (const action of nextActions) safeNote(action);
  return { schema: "jit.ops.diagnostics/v1", observedAt: new Date(input.now).toISOString(),
    queue, routes, budgets, waits, disk, connections, engine, providers, schemaVersion: schema, upgrade, restore, artifacts,
    nextAction, nextActions };
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
 * Declared engine usability without side effects. Scripted mode has no engine.
 * Schway mode needs the pinned release contract, and any existing host
 * directory must be a private real directory (the start gate creates missing
 * ones, so absence is not a failure). Never opens a host or runs a probe.
 */
function engineAvailable(config: AppConfig): boolean {
  if (config.runPort !== "schway") return true;
  try { if (hostCapabilities().releaseContract !== SCHWAY_RELEASE_CONTRACT) return false; } catch { return false; }
  const dirs = schwayHostDirs(config.databasePath);
  for (const path of [dirs.base, dirs.workspaceRoot, dirs.homeDirectory, dirs.sessionDirectory]) {
    let stats;
    try { stats = lstatSync(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; return false; }
    if (!stats.isDirectory() || stats.isSymbolicLink() || (stats.mode & 0o077) !== 0) return false;
  }
  return true;
}

/** Distinct configured provider routes across owner, project and role configuration (bounded, identifiers discarded). */
function configuredRouteCount(store: TransactionStore): number {
  return store.read(tx => {
    const routes = new Set<string>();
    const add = (json: string | null | undefined): void => {
      if (!json || routes.size >= 64) return;
      try {
        const route = JSON.parse(json) as { provider?: unknown; model?: unknown; authRoute?: unknown } | null;
        if (route && typeof route.provider === "string") routes.add(JSON.stringify([route.provider, route.model ?? null, route.authRoute ?? null]));
      } catch { /* Malformed configuration is not a configured route. */ }
    };
    try { add(tx.get<{ route_json: string | null }>("SELECT route_json FROM team_state WHERE id = 1")?.route_json); } catch { /* Pre-team schema. */ }
    try { for (const row of tx.all<{ route_json: string | null }>("SELECT route_json FROM project_team WHERE route_json IS NOT NULL LIMIT 1000")) add(row.route_json); } catch { /* Pre-team schema. */ }
    try {
      for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM roles LIMIT 100")) {
        try {
          const role = JSON.parse(row.record_json) as { enabled?: unknown; route?: unknown };
          if (role.enabled !== false && role.route) add(JSON.stringify(role.route));
        } catch { /* Skip malformed role rows. */ }
      }
    } catch { /* Pre-team schema. */ }
    return routes.size;
  });
}

/** Non-terminal restore quarantines from the current OPS02 store table; absent table reads as none. */
function restoreQuarantines(store: TransactionStore): { open: number; blocked: number } {
  return store.read(tx => {
    try {
      const rows = tx.all<{ state: string }>("SELECT state FROM restore_quarantines WHERE state NOT IN ('complete', 'discarded', 'failed') LIMIT 100");
      return { open: rows.length, blocked: rows.filter(r => r.state === "blocked").length };
    } catch { return { open: 0, blocked: 0 }; }
  });
}

/**
 * Gathers read-only diagnostics inputs from an installation. Opens the store for
 * reads only: no scheduler claim, no queue pump, no timers, no network, no engine
 * probe, no secret output. Route readiness stays `observedRoutes: 0` because this
 * path never collects live evidence. Callers must not run background work around
 * this call.
 */
export function gatherDiagnostics(root: string, config: AppConfig, now: number = Date.now()): DiagnosticsInput {
  const store = new TransactionStore(config.databasePath, { migrateExisting: false });
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
    const waitingFor = (reason: string): number => decoded.filter(j => j?.state === "waiting" && j.reason === reason).length;
    const authorizationChanged = decoded.filter(j => j?.state === "blocked" && j.reason === "authorization_changed").length;
    const delivery = store.read(tx => {
      try {
        const pending = tx.get<{ count: number }>("SELECT count(*) AS count FROM delivery_intents WHERE status IN ('pending', 'claimed', 'waiting')")!.count;
        const unknownCount = tx.get<{ count: number }>("SELECT count(*) AS count FROM delivery_attempts WHERE record_json LIKE '%\"outcome\":\"unknown\"%'")!.count;
        return { pendingIntents: Math.min(pending, 10000), unknownDeliveries: Math.min(unknownCount, 10000) };
      } catch { return { pendingIntents: 0, unknownDeliveries: 0 }; }
    });
    const binding = store.read(tx => {
      try {
        const state = tx.get<{ state: string }>("SELECT state FROM telegram_binding WHERE id = 1")?.state;
        return state === "bound" || state === "pending" ? state : "unbound";
      } catch { return "unbound" as const; }
    });
    const current = store.read(tx => tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version);
    const fence = readUpgradeFence(config.databasePath);
    let activeState: UpgradeState | null = null;
    try { activeState = activeUpgrade(upgradeDirFor(config.databasePath))?.state ?? null; } catch { activeState = "blocked"; }
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
      waits: { quota: waitingFor("quota"), needsLogin: waitingFor("needs_login"), routeUnavailable: waitingFor("route_unavailable"),
        authorizationChanged: Math.min(authorizationChanged, 10000) },
      disk: { stateBytes: managedStateBytes(join(root, ".local")), watermarkBytes: config.ops.diskWatermarkBytes },
      telegram: { configured: botCredentialConfigured(config.telegram.botTokenPath), binding,
        pendingIntents: delivery.pendingIntents, unknownDeliveries: delivery.unknownDeliveries },
      engine: { mode: config.runPort, available: engineAvailable(config) },
      providers: { configuredRoutes: configuredRouteCount(store), observedRoutes: 0 },
      schema: { current, supported: schemaVersion },
      upgrade: { fence: fence === null ? "none" : fence.upgradeId === "unknown" ? "unreadable"
        : (fence as { holder?: unknown }).holder === "restore" ? "restore" : "upgrade", activeState },
      restore: restoreQuarantines(store),
      artifacts };
  } finally { store.close(); }
}
