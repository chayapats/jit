import { lstatSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { schemaVersion, type AppTransaction } from "../store";
import { openReadOnlyStore } from "./readonly-store";
import type { AppConfig } from "../config";
import { botCredentialConfigured } from "../telegram/secrets";
import { SCHWAY_RELEASE_CONTRACT, schwayHostDirs } from "../team/schway-port";
import { hostCapabilities } from "schway/host";
import { redactModel, redactRouteId, safeEvidenceId, safeNote, safeOpsAlias } from "./contracts";
import { activeUpgrade, upgradeDirFor, type UpgradeState } from "./upgrade";
import { readUpgradeFence } from "./upgrade-fence";
import { listRestores, readRestoreGate, restoreDirFor, terminalRestoreStates } from "./restore";

/** Fixed route lifecycle states visible to diagnostics; never a readiness promise. */
export const diagnosticRouteStates = ["queued", "admitted", "waiting", "succeeded", "blocked", "failed"] as const;
export type DiagnosticRouteState = typeof diagnosticRouteStates[number];

/**
 * Fixed safe next actions for an inspected installation, in priority order.
 * None of them is authorized by diagnostics: each names the owner runbook
 * step (docs/runbooks/ops-load-drill.md) that the owner may choose to take.
 */
export const diagnosticActions = ["none", "run-owner-setup", "inspect-store-access", "complete-restore-activation", "finish-or-rollback-upgrade", "resolve-restore-quarantine", "run-owner-upgrade",
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
  /**
   * How the installation database was read: `missing` (no database file),
   * `unreadable` (read-only open failed, e.g. incomplete WAL sidecars), or
   * `readable`. `queried` is false when no schema-specific query ran (missing,
   * unreadable or newer schema); every count is then 0.
   */
  store: { state: "readable" | "missing" | "unreadable"; queried: boolean };
  queue: { available: boolean; queued: number; admitted: number; waiting: number };
  /**
   * Up to 8 active (queued/admitted/waiting) route groups, oldest active work
   * first. Raw route aliases are validated, then redacted in the output.
   */
  routes: { route: string; model: string | null; state: DiagnosticRouteState; attempts: number }[];
  /** How much active work the route sample leaves out; counts are whole-table SQL aggregates, never row-bounded. */
  coverage: { activeJobs: number; omittedRouteGroups: number; omittedActiveJobs: number; countsCapped: boolean };
  budgets: { exhausted: number; deadlineFailed: number };
  /** Jobs held on their exact route by an external condition, or fenced by an authority change. */
  waits: { quota: number; needsLogin: number; routeUnavailable: number; authorizationChanged: number };
  disk: { stateBytes: number; watermarkBytes: number };
  telegram: { configured: boolean; binding: "unbound" | "pending" | "bound"; pendingIntents: number; unknownDeliveries: number };
  /** Run-port mode and whether its declared engine identity is usable. Never a live probe. */
  engine: { mode: "scripted" | "schway"; available: boolean };
  /**
   * Distinct configured provider routes. Diagnostics never claim observed
   * readiness: that requires validated live RouteEvidence (host evidence, S01),
   * which this projection does not accept.
   */
  providers: { configuredRoutes: number };
  /** Live database `user_version` (null when the store could not be read) against the schema this build supports. */
  schema: { current: number | null; supported: number };
  /** Durable admission fence and the active upgrade journal state, if any. */
  upgrade: { fence: "none" | "upgrade" | "restore" | "unreadable"; activeState: UpgradeState | null };
  /**
   * Non-terminal OPS02 restore journals, how many are blocked, and the durable
   * read gate (`<db>.restore-pending`: an activation that has not completed).
   */
  restore: { open: number; blocked: number; gate: "none" | "pending" | "unreadable" };
  /** Sanitized ops-evidence record IDs present in local storage. */
  artifacts: string[];
}

/** Redacted, read-only installation snapshot. Safe to print; never mutates state or calls home. */
export interface Diagnostics {
  schema: "jit.ops.diagnostics/v1";
  observedAt: string;
  store: { state: "readable" | "missing" | "unreadable"; queried: boolean };
  queue: { available: boolean; queued: number; admitted: number; waiting: number };
  routes: { reference: string; model: "redacted" | "unselected"; state: DiagnosticRouteState; attempts: number }[];
  coverage: { activeJobs: number; omittedRouteGroups: number; omittedActiveJobs: number; countsCapped: boolean };
  budgets: { exhausted: number; deadlineFailed: number };
  waits: { quota: number; needsLogin: number; routeUnavailable: number; authorizationChanged: number };
  disk: { stateBytes: number; watermarkBytes: number; pressure: boolean };
  connections: { telegram: "configured" | "unconfigured"; binding: "unbound" | "pending" | "bound"; pendingIntents: number; unknownDeliveries: number };
  /** `scripted` has no engine; `declared` means the pinned release contract matches, not that a run was observed. */
  engine: { mode: "scripted" | "schway"; state: "scripted" | "declared" | "unavailable"; observed: "not-observed" };
  /** Host-evidence vocabulary; `observed-ready` is never produced here, only by live RouteEvidence records. */
  providers: { configuredRoutes: number; readiness: "not-configured" | "configured-unverified"; observed: "not-observed" };
  schemaVersion: { current: number | null; supported: number; state: "current" | "upgrade-required" | "newer-unsupported" | "unavailable" };
  upgrade: { fence: "none" | "upgrade" | "restore" | "unreadable"; activeState: UpgradeState | null };
  restore: { open: number; blocked: number; gate: "none" | "pending" | "unreadable";
    state: "none" | "quarantine-open" | "quarantine-blocked" | "activation-pending" };
  artifacts: { count: number; references: string[] };
  /** Highest-priority applicable action; `nextActions` lists every applicable one in priority order. */
  nextAction: DiagnosticAction;
  nextActions: DiagnosticAction[];
}

/** Every count is clamped to this cap by the gather (`coverage.countsCapped`) and rejected above it here. */
export const countCap = 1_000_000;

const count = (v: unknown, max: number): number => {
  if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > max) throw new Error("invalid_diagnostics");
  return v as number;
};

const inputKeys = ["now", "store", "queue", "routes", "coverage", "budgets", "waits", "disk", "telegram", "engine", "providers", "schema", "upgrade", "restore", "artifacts"];

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
  const st = input.store;
  object(st);
  if (!["readable", "missing", "unreadable"].includes(st.state) || typeof st.queried !== "boolean" || (st.queried && st.state !== "readable")) fail();
  const store = { state: st.state, queried: st.queried };
  const q = input.queue;
  object(q);
  if (typeof q.available !== "boolean") fail();
  const queue = { available: q.available, queued: count(q.queued, countCap), admitted: count(q.admitted, countCap), waiting: count(q.waiting, countCap) };
  if (!Array.isArray(input.routes) || input.routes.length > 8) fail();
  const routes = input.routes.map((r, index) => {
    if (!r || typeof r !== "object" || safeOpsAlias((r as { route: unknown }).route) !== (r as { route: string }).route ||
        ((r as { model: unknown }).model !== null && safeOpsAlias((r as { model: unknown }).model) !== (r as { model: string }).model) ||
        !diagnosticRouteStates.includes((r as { state: DiagnosticRouteState }).state)) fail();
    const row = r as { route: string; model: string | null; state: DiagnosticRouteState; attempts: number };
    return { reference: redactRouteId(index), model: redactModel(row.model), state: row.state, attempts: count(row.attempts, 1000000) };
  });
  const cv = input.coverage;
  object(cv);
  if (typeof cv.countsCapped !== "boolean") fail();
  const coverage = { activeJobs: count(cv.activeJobs, countCap), omittedRouteGroups: count(cv.omittedRouteGroups, countCap),
    omittedActiveJobs: count(cv.omittedActiveJobs, countCap), countsCapped: cv.countsCapped };
  if (coverage.activeJobs !== queue.queued + queue.admitted + queue.waiting || coverage.omittedActiveJobs > coverage.activeJobs) fail();
  const b = input.budgets;
  object(b);
  const budgets = { exhausted: count(b.exhausted, countCap), deadlineFailed: count(b.deadlineFailed, countCap) };
  const w = input.waits;
  object(w);
  const waits = { quota: count(w.quota, countCap), needsLogin: count(w.needsLogin, countCap),
    routeUnavailable: count(w.routeUnavailable, countCap), authorizationChanged: count(w.authorizationChanged, countCap) };
  const d = input.disk;
  object(d);
  const disk = { stateBytes: count(d.stateBytes, 1099511627776), watermarkBytes: count(d.watermarkBytes, 1099511627776), pressure: false };
  disk.pressure = disk.stateBytes > disk.watermarkBytes;
  const t = input.telegram;
  object(t);
  if (typeof t.configured !== "boolean" || !["unbound", "pending", "bound"].includes(t.binding)) fail();
  const connections = { telegram: (t.configured ? "configured" : "unconfigured") as "configured" | "unconfigured",
    binding: t.binding, pendingIntents: count(t.pendingIntents, countCap), unknownDeliveries: count(t.unknownDeliveries, countCap) };
  const e = input.engine;
  object(e);
  if ((e.mode !== "scripted" && e.mode !== "schway") || typeof e.available !== "boolean") fail();
  const engine = { mode: e.mode, state: (e.mode === "scripted" ? "scripted" : e.available ? "declared" : "unavailable") as Diagnostics["engine"]["state"],
    observed: "not-observed" as const };
  const p = input.providers;
  object(p);
  if (Object.keys(p).join(",") !== "configuredRoutes") fail();
  const configuredRoutes = count(p.configuredRoutes, 64);
  const providers = { configuredRoutes, readiness: (configuredRoutes === 0 ? "not-configured" : "configured-unverified") as Diagnostics["providers"]["readiness"],
    observed: "not-observed" as const };
  const s = input.schema;
  object(s);
  const schema = { current: s.current === null ? null : count(s.current, 100000), supported: count(s.supported, 100000),
    state: "current" as Diagnostics["schemaVersion"]["state"] };
  if (schema.supported < 1 || (schema.current === null) !== (store.state !== "readable")) fail();
  schema.state = schema.current === null ? "unavailable" : schema.current === schema.supported ? "current"
    : schema.current < schema.supported ? "upgrade-required" : "newer-unsupported";
  // A store that was not queried cannot carry counts.
  if (!store.queried && (q.queued + q.admitted + q.waiting > 0 || q.available || input.routes.length > 0)) fail();
  const u = input.upgrade;
  object(u);
  if (!["none", "upgrade", "restore", "unreadable"].includes(u.fence) || (u.activeState !== null && !upgradeStates.includes(u.activeState))) fail();
  const upgrade = { fence: u.fence, activeState: u.activeState };
  const r = input.restore;
  object(r);
  if (!["none", "pending", "unreadable"].includes(r.gate)) fail();
  const restore = { open: count(r.open, 100), blocked: count(r.blocked, 100), gate: r.gate, state: "none" as Diagnostics["restore"]["state"] };
  if (restore.blocked > restore.open) fail();
  restore.state = restore.gate !== "none" ? "activation-pending" : restore.blocked > 0 ? "quarantine-blocked" : restore.open > 0 ? "quarantine-open" : "none";
  if (!Array.isArray(input.artifacts) || input.artifacts.length > 32) fail();
  const artifacts = { count: input.artifacts.length, references: input.artifacts.map(a => safeEvidenceId(a)) };
  const applicable: [boolean, DiagnosticAction][] = [
    [store.state === "missing", "run-owner-setup"],
    [store.state === "unreadable", "inspect-store-access"],
    // While the read gate exists the application serves only restore status and remediation.
    [restore.gate !== "none", "complete-restore-activation"],
    // An active journal is fenced or activated-awaiting-reconcile; either way the owner finishes or rolls it back.
    [upgrade.fence === "upgrade" || upgrade.fence === "unreadable" ||
      (upgrade.activeState !== null && !["complete", "failed", "rolled_back"].includes(upgrade.activeState)), "finish-or-rollback-upgrade"],
    [upgrade.fence === "restore" || restore.open > 0, "resolve-restore-quarantine"],
    [schema.state === "upgrade-required", "run-owner-upgrade"],
    [schema.state === "newer-unsupported", "use-compatible-app-artifact"],
    [disk.pressure, "relieve-disk-pressure"],
    [engine.state === "unavailable", "restore-engine"],
    [store.queried && !queue.available, "inspect-sanitized-diagnostics"],
    [store.queried && engine.mode === "schway" && providers.configuredRoutes === 0, "configure-provider-route"],
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
  return { schema: "jit.ops.diagnostics/v1", observedAt: new Date(input.now).toISOString(), store,
    queue, routes, coverage, budgets, waits, disk, connections, engine, providers, schemaVersion: schema, upgrade, restore, artifacts,
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
function configuredRouteCount(tx: AppTransaction): number {
  {
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
  }
}

/**
 * OPS02 restore state from its control plane: bounded journal files under
 * `<db>.restores` (unreadable journals count as blocked placeholders) and the
 * `<db>.restore-pending` read gate. File reads only; nothing is reconciled.
 */
function restoreState(databasePath: string): { open: number; blocked: number; gate: "none" | "pending" | "unreadable" } {
  let open = 0, blocked = 0;
  try {
    const journals = listRestores(restoreDirFor(databasePath), 100).filter(j => !terminalRestoreStates.includes(j.state));
    open = journals.length;
    blocked = journals.filter(j => j.state === "blocked").length;
  } catch { open = 1; blocked = 1; }
  const holder = readRestoreGate(databasePath);
  return { open, blocked, gate: holder === null ? "none" : holder === "unknown" ? "unreadable" : "pending" };
}

/** Every schema-specific read gathered from one read-only connection; all zero when the store is not queried. */
interface StoreReads {
  tally: { state: string; reason: string | null; n: number }[];
  available: boolean;
  groups: { provider: unknown; model: unknown; state: string; n: number }[];
  delivery: { pendingIntents: number; unknownDeliveries: number };
  binding: "unbound" | "pending" | "bound";
  configuredRoutes: number;
}

const emptyReads: StoreReads = { tally: [], available: false, groups: [], delivery: { pendingIntents: 0, unknownDeliveries: 0 },
  binding: "unbound", configuredRoutes: 0 };

/** Schema-specific queries; each one fails soft so an older schema still yields a bounded snapshot. */
function readStore(tx: AppTransaction): StoreReads {
  const tally = (() => {
    try {
      return tx.all<{ state: string; reason: string | null; n: number }>(
        "SELECT state, json_extract(record_json, '$.reason') AS reason, count(*) AS n FROM jobs GROUP BY state, reason");
    } catch { return []; }
  })();
  let available = false;
  try { available = tx.get<{ token: string }>("SELECT token FROM job_scheduler WHERE id = 1") === null; } catch { available = false; }
  // Active route sample: distinct (provider, model, state) groups over all active jobs, oldest active work first.
  const groups = (() => {
    try {
      return tx.all<{ provider: unknown; model: unknown; state: string; n: number }>(
        `SELECT json_extract(record_json, '$.route.provider') AS provider, json_extract(record_json, '$.route.model') AS model, state, count(*) AS n
         FROM jobs WHERE state IN ('queued', 'admitted', 'waiting') GROUP BY provider, model, state ORDER BY min(queue_order) LIMIT 4096`);
    } catch { return []; }
  })();
  let delivery = { pendingIntents: 0, unknownDeliveries: 0 };
  try {
    delivery = {
      pendingIntents: tx.get<{ count: number }>("SELECT count(*) AS count FROM delivery_intents WHERE json_extract(record_json, '$.status') IN ('waiting', 'queued', 'claimed')")!.count,
      unknownDeliveries: tx.get<{ count: number }>("SELECT count(*) AS count FROM delivery_attempts WHERE record_json LIKE '%\"outcome\":\"unknown\"%'")!.count,
    };
  } catch { /* Pre-outbox schema. */ }
  let binding: StoreReads["binding"] = "unbound";
  try {
    const state = tx.get<{ state: string }>("SELECT state FROM telegram_binding WHERE id = 1")?.state;
    binding = state === "bound" || state === "pending" ? state : "unbound";
  } catch { /* Pre-Telegram schema. */ }
  return { tally, available, groups, delivery, binding, configuredRoutes: configuredRouteCount(tx) };
}

/**
 * Gathers read-only diagnostics inputs from an installation through the
 * read-only store adapter (ops.service_package/v1): it never creates,
 * migrates, journals, checkpoints or chmods the database. `user_version` is
 * read first; a missing database is the fixed `missing` state, an unreadable
 * one `unreadable`, and a newer schema yields a bounded snapshot without any
 * schema-specific query (`use-compatible-app-artifact`). No scheduler claim,
 * no queue pump, no timers, no network, no engine probe, no secret output.
 */
export function gatherDiagnostics(root: string, config: AppConfig, now: number = Date.now()): DiagnosticsInput {
  const opened = openReadOnlyStore(config.databasePath);
  let storeState: DiagnosticsInput["store"]["state"] = opened ? "readable" : "missing";
  let current: number | null = null;
  let reads = emptyReads;
  if (opened) {
    try {
      // One connection (one snapshot) for every read: version first, schema-specific queries only when supported.
      const result = opened.read(tx => {
        const version = tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
        return { version, reads: Number.isSafeInteger(version) && version >= 0 && version <= schemaVersion ? readStore(tx) : null };
      });
      current = result.version;
      reads = result.reads ?? emptyReads;
    } catch { storeState = "unreadable"; }
  }
  const queried = reads !== emptyReads;
  let capped = false;
  const cap = (n: number): number => { if (n > countCap) { capped = true; return countCap; } return n; };
  const total = (state: string, reason?: string): number =>
    cap(reads.tally.filter(t => t.state === state && (reason === undefined || t.reason === reason)).reduce((sum, t) => sum + t.n, 0));
  const queued = total("queued"), admitted = total("admitted"), waiting = total("waiting");
  const routes: DiagnosticsInput["routes"] = [];
  let omittedGroups = 0, omittedJobs = 0;
  for (const group of reads.groups) {
    let usable = routes.length < 8 && typeof group.provider === "string" && (group.model === null || typeof group.model === "string");
    if (usable) {
      try { safeOpsAlias(group.provider); if (group.model !== null) safeOpsAlias(group.model); } catch { usable = false; }
    }
    if (!usable) { omittedGroups++; omittedJobs += group.n; continue; }
    routes.push({ route: group.provider as string, model: group.model as string | null, state: group.state as DiagnosticRouteState, attempts: cap(group.n) });
  }
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
    store: { state: storeState, queried },
    queue: { available: reads.available, queued, admitted, waiting },
    routes,
    coverage: { activeJobs: queued + admitted + waiting, omittedRouteGroups: cap(omittedGroups),
      omittedActiveJobs: Math.min(cap(omittedJobs), queued + admitted + waiting), countsCapped: capped },
    budgets: { exhausted: total("blocked", "budget_exhausted"), deadlineFailed: total("failed", "deadline") },
    waits: { quota: total("waiting", "quota"), needsLogin: total("waiting", "needs_login"), routeUnavailable: total("waiting", "route_unavailable"),
      authorizationChanged: total("blocked", "authorization_changed") },
    disk: { stateBytes: managedStateBytes(join(root, ".local")), watermarkBytes: config.ops.diskWatermarkBytes },
    telegram: { configured: botCredentialConfigured(config.telegram.botTokenPath), binding: reads.binding,
      pendingIntents: cap(reads.delivery.pendingIntents), unknownDeliveries: cap(reads.delivery.unknownDeliveries) },
    engine: { mode: config.runPort, available: engineAvailable(config) },
    providers: { configuredRoutes: Math.min(reads.configuredRoutes, 64) },
    schema: { current: current === null ? null : Math.min(Math.max(current, 0), 100000), supported: schemaVersion },
    upgrade: { fence: fence === null ? "none" : fence.upgradeId === "unknown" ? "unreadable"
      : (fence as { holder?: unknown }).holder === "restore" ? "restore" : "upgrade", activeState },
    restore: restoreState(config.databasePath),
    artifacts };
}
