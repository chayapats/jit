import { AppError } from "../errors";
import { readRestoreGate } from "../ops/restore";
import { upgradeFenced } from "../ops/upgrade-fence";
import type { AppTransaction, TransactionStore } from "../store";
import { readMonitor } from "./authority";
import { TrustedGitHubConnector } from "./github";
import { pollMonitorCatchUp } from "./poll";
import type { GitHubReadPort, PollCheckpoint, PrMonitor } from "./types";

/**
 * Service-owned PR poll schedule (`app.webhook_triggers/v1` wake mechanism, REL07).
 *
 * Each active monitor has a "poll due at" instant (schema 32 `pr_poll_due`). The service loop
 * ({@link tickPrPolls}) runs `pollMonitorCatchUp` for every active monitor whose instant has come, then sets the
 * next instant one `pollIntervalMs` later. A signed webhook only calls {@link wakeMonitorPoll}, which can move the
 * instant earlier and never later. The poll result stays the source of truth: a wake carries no PR data.
 */
export interface PollDue {
  monitorId: string;
  projectId: string;
  /** When the service loop next polls this monitor. */
  dueAt: number;
  lastPolledAt: number | null;
  /** When a webhook last moved `dueAt` earlier. */
  wokenAt: number | null;
  /**
   * The last poll that threw, as a bounded reason code (an `AppError` code, else `poll_failed`) and its time.
   * Cleared by the next successful poll. Never holds error text, payload or credential material.
   */
  failure: { reason: string; at: number } | null;
}

/** Safe, bounded reason code for a poll that threw: only an `AppError` code is kept, never a message. */
export function pollFailureReason(error: unknown): string {
  return error instanceof AppError && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : "poll_failed";
}

/**
 * Reads the due instant of one monitor. Without a stored row it derives one from the poll checkpoint: an
 * incomplete catch-up (including a monitor that never polled) is due at once; a complete one is due one
 * interval after the checkpoint was written.
 */
export function readPollDue(tx: AppTransaction, monitor: PrMonitor): PollDue {
  const row = tx.get<{ due_at: number; last_polled_at: number | null; woken_at: number | null; last_failure: string | null; last_failed_at: number | null }>(
    "SELECT due_at, last_polled_at, woken_at, last_failure, last_failed_at FROM pr_poll_due WHERE monitor_id = ?", monitor.id);
  if (row) return { monitorId: monitor.id, projectId: monitor.projectId, dueAt: row.due_at, lastPolledAt: row.last_polled_at, wokenAt: row.woken_at,
    failure: row.last_failure !== null && row.last_failed_at !== null ? { reason: row.last_failure, at: row.last_failed_at } : null };
  const checkpoint = tx.get<{ record_json: string }>("SELECT record_json FROM pr_poll_checkpoints WHERE monitor_id = ?", monitor.id);
  const parsed = checkpoint ? JSON.parse(checkpoint.record_json) as PollCheckpoint : null;
  const dueAt = !parsed ? monitor.createdAt : parsed.complete ? parsed.updatedAt + monitor.limits.pollIntervalMs : parsed.updatedAt;
  return { monitorId: monitor.id, projectId: monitor.projectId, dueAt, lastPolledAt: null, wokenAt: null, failure: null };
}

function writePollDue(tx: AppTransaction, due: PollDue): void {
  tx.run(`INSERT INTO pr_poll_due (monitor_id, project_id, due_at, last_polled_at, woken_at, last_failure, last_failed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(monitor_id) DO UPDATE SET due_at = excluded.due_at, last_polled_at = excluded.last_polled_at, woken_at = excluded.woken_at,
      last_failure = excluded.last_failure, last_failed_at = excluded.last_failed_at`,
  due.monitorId, due.projectId, due.dueAt, due.lastPolledAt, due.wokenAt, due.failure?.reason ?? null, due.failure?.at ?? null);
}

/**
 * Moves one active monitor's next poll to `now` at the latest. It never delays a poll, never polls itself and
 * never wakes a paused or revoked monitor (`pr_monitor_not_active`, `pr_monitor_revoked`).
 */
export function wakeMonitorPoll(tx: AppTransaction, projectId: string, monitorId: string, now: number): { before: number; after: number } {
  const monitor = readMonitor(tx, projectId, monitorId);
  if (monitor.state === "revoked") throw new AppError("pr_monitor_revoked", 409);
  if (monitor.state !== "active") throw new AppError("pr_monitor_not_active", 409);
  const due = readPollDue(tx, monitor);
  const after = Math.min(due.dueAt, now);
  writePollDue(tx, { ...due, dueAt: after, wokenAt: now });
  return { before: due.dueAt, after };
}

/** What one service-loop step did for one due monitor. */
export interface PollTickResult {
  monitorId: string;
  outcome: "polled" | "failed";
  /** Checkpoint reason after a poll (`rate_limited`, `pagination_failed`, `max_pages`), the failure code, or null. */
  reason: string | null;
  created: number;
  nextDueAt: number;
}

export interface PollTickOptions {
  now: number;
  /** Process-owned read port per monitor (the same wiring as `pr.snapshot`); models never supply it. */
  portFor: (monitor: PrMonitor) => GitHubReadPort;
  cacheRoot: string;
  /** Scheduler ownership check, so only the process that owns the queue polls. */
  assertOwner?: (tx: AppTransaction) => void;
}

/**
 * One service-loop step: polls every active monitor whose due instant has come, each in its own transaction,
 * and schedules its next poll one interval later. A poll that throws rolls back, records a bounded failure code the
 * owner sees on the PR page, and is retried one interval later; the next successful poll clears it.
 * Nothing runs under an upgrade fence or an incomplete restore, or before the PR tables exist.
 */
export function tickPrPolls(store: TransactionStore, options: PollTickOptions): PollTickResult[] {
  if (upgradeFenced(store.path) || readRestoreGate(store.path)) return [];
  const { now } = options;
  const due = store.read(tx => {
    options.assertOwner?.(tx);
    if (!tx.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'pr_monitors'")) return [];
    return tx.all<{ id: string; project_id: string; record_json: string }>("SELECT id, project_id, record_json FROM pr_monitors WHERE state = 'active' ORDER BY id")
      .map(row => JSON.parse(row.record_json) as PrMonitor)
      .filter(monitor => readPollDue(tx, monitor).dueAt <= now);
  });
  const results: PollTickResult[] = [];
  for (const candidate of due) {
    try {
      const polled = store.transaction((tx): PollTickResult | null => {
        options.assertOwner?.(tx);
        const monitor = readMonitor(tx, candidate.projectId, candidate.id);
        const current = readPollDue(tx, monitor);
        if (monitor.state !== "active" || current.dueAt > now) return null;
        const connector = new TrustedGitHubConnector(options.portFor(monitor), monitor, options.cacheRoot);
        const result = pollMonitorCatchUp(tx, monitor.projectId, monitor.id, connector, now);
        const nextDueAt = now + monitor.limits.pollIntervalMs;
        writePollDue(tx, { ...current, dueAt: nextDueAt, lastPolledAt: now, failure: null });
        return { monitorId: monitor.id, outcome: "polled", reason: result.checkpoint.reason, created: result.created.length, nextDueAt };
      });
      if (polled) results.push(polled);
    } catch (error) {
      // The poll rolled back; record why (a code only) and back off one interval so a failing monitor cannot spin the loop.
      const reason = pollFailureReason(error);
      try {
        const nextDueAt = now + candidate.limits.pollIntervalMs;
        store.transaction(tx => {
          options.assertOwner?.(tx);
          const monitor = readMonitor(tx, candidate.projectId, candidate.id);
          if (monitor.state === "active") writePollDue(tx, { ...readPollDue(tx, monitor), dueAt: nextDueAt, failure: { reason, at: now } });
        });
        results.push({ monitorId: candidate.id, outcome: "failed", reason, created: 0, nextDueAt });
      } catch { /* Ownership lost or storage unavailable: the next tick decides again. */ }
    }
  }
  return results;
}
