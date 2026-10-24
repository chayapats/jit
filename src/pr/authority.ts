import { createHash } from "node:crypto";
import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import { retirePrAlerts } from "./alert-links";
import { ensurePrSchema } from "./schema";
import {
  DEFAULT_PR_LIMITS,
  DEFAULT_TRIGGER_POLICY,
  TRIGGER_POLICY_VERSION,
  type MonitorReceipt,
  type PrMonitor,
  type PrMonitorCommand,
  type PrReadLimits,
  type RepositoryIdentity,
  type ReviewCandidate,
} from "./types";

const exact = (value: unknown, keys: string[]) =>
  !!value && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  && Object.keys(value).every(key => keys.includes(key))
  && keys.every(key => Object.hasOwn(value as object, key));

const positive = (value: unknown, max: number): value is number =>
  Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= max;

const repoId = (value: unknown): value is RepositoryIdentity =>
  exact(value, ["host", "owner", "name"])
  && typeof (value as RepositoryIdentity).host === "string"
  && /^[a-z0-9.-]{1,253}$/i.test((value as RepositoryIdentity).host)
  && typeof (value as RepositoryIdentity).owner === "string"
  && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test((value as RepositoryIdentity).owner)
  && typeof (value as RepositoryIdentity).name === "string"
  && /^[a-zA-Z0-9._-]{1,100}$/.test((value as RepositoryIdentity).name);

const apiBaseOk = (value: unknown): value is string => {
  if (typeof value !== "string" || value.length > 200) return false;
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password
      && !url.search && !url.hash;
  } catch { return false; }
};

function limitsFrom(partial: Partial<PrReadLimits> | undefined): PrReadLimits {
  const merged = { ...DEFAULT_PR_LIMITS, ...(partial ?? {}) };
  const keys = Object.keys(DEFAULT_PR_LIMITS) as (keyof PrReadLimits)[];
  if (!exact(merged, keys) || keys.some(key => !positive(merged[key], key === "pollIntervalMs" ? 3_600_000
    : key.includes("Bytes") ? 8_388_608 : key === "maxFiles" ? 2_000 : 1_000))) {
    throw new AppError("invalid_pr_limits");
  }
  return merged;
}

/** Canonical receipt identity for PR monitor commands under app.project_commands/v1. */
export function prMonitorIdentity(command: PrMonitorCommand): string {
  if (!exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"])
      || typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId)
      || !/^[a-f0-9-]{36}$/.test(command.projectId)
      || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
    throw new AppError("invalid_pr_monitor_command");
  }
  if (command.kind === "pr.monitor.enable") {
    const p = command.payload;
    if (!exact(p, ["repository", "apiBase", "allowed", "acceptPolicyVersion"])
        && !exact(p, ["repository", "apiBase", "allowed", "limits", "acceptPolicyVersion"])) {
      throw new AppError("invalid_pr_monitor_command");
    }
    // exact() requires every listed key; optional limits uses the five-key form.
    if (!repoId(p.repository) || !apiBaseOk(p.apiBase) || !exact(p.allowed, ["issues", "specs", "ci"])
        || typeof p.allowed.issues !== "boolean" || typeof p.allowed.specs !== "boolean"
        || typeof p.allowed.ci !== "boolean"
        || p.acceptPolicyVersion !== TRIGGER_POLICY_VERSION) {
      throw new AppError("invalid_pr_monitor_command");
    }
    limitsFrom(p.limits);
    return createHash("sha256").update(JSON.stringify([
      command.kind, command.projectId, command.expectedRevision, p.repository, p.apiBase, p.allowed,
      limitsFrom(p.limits), p.acceptPolicyVersion, DEFAULT_TRIGGER_POLICY,
    ])).digest("hex");
  }
  if (!["pr.monitor.pause", "pr.monitor.resume", "pr.monitor.revoke"].includes(command.kind)
      || !exact(command.payload, ["monitorId"])
      || !/^[a-f0-9-]{36}$/.test(command.payload.monitorId)) {
    throw new AppError("invalid_pr_monitor_command");
  }
  return createHash("sha256").update(JSON.stringify([
    command.kind, command.projectId, command.expectedRevision, command.payload.monitorId,
  ])).digest("hex");
}

function requireProject(tx: AppTransaction, projectId: string, expected: number): number {
  const row = tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", projectId);
  if (!row) throw new AppError("project_not_found", 404);
  if (row.revision !== expected) throw new AppError("stale_revision", 409);
  return row.revision;
}

function bumpProject(tx: AppTransaction, projectId: string): number {
  tx.run("UPDATE projects SET revision = revision + 1 WHERE id = ?", projectId);
  return tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", projectId)!.revision;
}

function saveMonitor(tx: AppTransaction, monitor: PrMonitor): void {
  tx.run(
    `INSERT INTO pr_monitors(id, project_id, revision, state, record_json) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, state = excluded.state, record_json = excluded.record_json`,
    monitor.id, monitor.projectId, monitor.revision, monitor.state, JSON.stringify(monitor),
  );
}

/** Reads one project-scoped monitor; identity never broadens authorization. */
export function readMonitor(tx: AppTransaction, projectId: string, monitorId: string): PrMonitor {
  ensurePrSchema(tx);
  const row = tx.get<{ record_json: string }>(
    "SELECT record_json FROM pr_monitors WHERE project_id = ? AND id = ?", projectId, monitorId);
  if (!row) throw new AppError("pr_monitor_not_found", 404);
  return JSON.parse(row.record_json) as PrMonitor;
}

/** Lists monitors for a project in stable insertion order. */
export function readMonitors(tx: AppTransaction, projectId: string): PrMonitor[] {
  ensurePrSchema(tx);
  return tx.all<{ record_json: string }>(
    "SELECT record_json FROM pr_monitors WHERE project_id = ? ORDER BY id", projectId,
  ).map(row => JSON.parse(row.record_json) as PrMonitor);
}

/**
 * Mutates standing PR monitoring authority inside an application transaction.
 * Enabling records explicit acceptance of the displayed trigger policy/version.
 * Optional `onRevoke` fences affected jobs in the same transaction before transport cancel.
 */
export function mutateMonitor(
  tx: AppTransaction,
  command: PrMonitorCommand,
  now: number,
  onRevoke?: (monitor: PrMonitor) => void,
): MonitorReceipt {
  ensurePrSchema(tx);
  prMonitorIdentity(command);
  requireProject(tx, command.projectId, command.expectedRevision);

  if (command.kind === "pr.monitor.enable") {
    const limits = limitsFrom(command.payload.limits);
    const existing = tx.all<{ record_json: string }>(
      "SELECT record_json FROM pr_monitors WHERE project_id = ?", command.projectId,
    ).map(row => JSON.parse(row.record_json) as PrMonitor)
      .find(m => m.state !== "revoked"
        && m.repository.host === command.payload.repository.host
        && m.repository.owner === command.payload.repository.owner
        && m.repository.name === command.payload.repository.name);
    if (existing) throw new AppError("pr_monitor_already_enabled", 409);

    const canonicalBase = new URL(command.payload.apiBase);
    canonicalBase.pathname = canonicalBase.pathname.replace(/\/+$/, "") || "";
    const monitor: PrMonitor = {
      id: crypto.randomUUID(),
      projectId: command.projectId,
      revision: 1,
      state: "active",
      repository: { ...command.payload.repository },
      apiBase: canonicalBase.origin + canonicalBase.pathname,
      allowed: { ...command.payload.allowed },
      policy: { ...DEFAULT_TRIGGER_POLICY },
      limits,
      acceptedPolicyVersion: TRIGGER_POLICY_VERSION,
      createdAt: now,
      updatedAt: now,
    };
    saveMonitor(tx, monitor);
    tx.run(
      "INSERT INTO pr_poll_checkpoints(monitor_id, record_json) VALUES (?, ?)",
      monitor.id,
      JSON.stringify({
        monitorId: monitor.id, updatedAt: now, complete: false, nextPage: 1,
        etag: null, lastSeenUpdatedAt: null, reason: null,
      }),
    );
    return { monitor, projectRevision: bumpProject(tx, command.projectId), displayedPolicy: { ...DEFAULT_TRIGGER_POLICY } };
  }

  const monitor = readMonitor(tx, command.projectId, command.payload.monitorId);
  if (monitor.state === "revoked") throw new AppError("pr_monitor_revoked", 409);

  if (command.kind === "pr.monitor.pause") {
    if (monitor.state !== "active") throw new AppError("pr_monitor_not_active", 409);
    monitor.state = "paused";
  } else if (command.kind === "pr.monitor.resume") {
    if (monitor.state !== "paused") throw new AppError("pr_monitor_not_paused", 409);
    monitor.state = "active";
  } else {
    monitor.state = "revoked";
    for (const row of tx.all<{ id: string; record_json: string }>(
      "SELECT id, record_json FROM pr_candidates WHERE monitor_id = ? AND status NOT IN ('superseded', 'cancelled', 'closed')",
      monitor.id,
    )) {
      const candidate = JSON.parse(row.record_json) as ReviewCandidate;
      candidate.status = "cancelled";
      candidate.updatedAt = now;
      tx.run("UPDATE pr_candidates SET status = ?, record_json = ? WHERE id = ?",
        "cancelled", JSON.stringify(candidate), row.id);
    }
    // PR03: revoked monitoring retires pending alerts and marks settled ones visibly stale.
    retirePrAlerts(tx, { projectId: command.projectId, monitorId: monitor.id }, "monitoring_revoked", now, { markSettledStale: true });
    onRevoke?.(monitor);
  }
  monitor.revision += 1;
  monitor.updatedAt = now;
  saveMonitor(tx, monitor);
  return { monitor, projectRevision: bumpProject(tx, command.projectId), displayedPolicy: { ...DEFAULT_TRIGGER_POLICY } };
}
