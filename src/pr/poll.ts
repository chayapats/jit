import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import { readMonitor } from "./authority";
import type { TrustedGitHubConnector } from "./github";
import { ensurePrSchema } from "./schema";
import type { CandidateStatus, PollCheckpoint, PrMonitor, ReviewCandidate } from "./types";
import { fencePrCandidateWork } from "./fence";

const SHA = /^[a-f0-9]{40}$/;

function dedupeKey(monitor: PrMonitor, pullNumber: number, baseSha: string, headSha: string): string {
  return [monitor.repository.host, monitor.repository.owner, monitor.repository.name,
    String(pullNumber), baseSha, headSha, String(monitor.policy.version)].join("|");
}

function loadCheckpoint(tx: AppTransaction, monitorId: string): PollCheckpoint {
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM pr_poll_checkpoints WHERE monitor_id = ?", monitorId);
  if (!row) throw new AppError("pr_checkpoint_missing", 500);
  return JSON.parse(row.record_json) as PollCheckpoint;
}

function saveCheckpoint(tx: AppTransaction, checkpoint: PollCheckpoint): void {
  tx.run("UPDATE pr_poll_checkpoints SET record_json = ? WHERE monitor_id = ?", JSON.stringify(checkpoint), checkpoint.monitorId);
}

function saveCandidate(tx: AppTransaction, candidate: ReviewCandidate): void {
  tx.run(
    `INSERT INTO pr_candidates(id, project_id, monitor_id, dedupe_key, generation, status, record_json)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(project_id, dedupe_key) DO UPDATE SET
       generation = excluded.generation, status = excluded.status, record_json = excluded.record_json`,
    candidate.id, candidate.projectId, candidate.monitorId, candidate.dedupeKey,
    candidate.generation, candidate.status, JSON.stringify(candidate),
  );
}

/** Reads candidates for a monitor newest-generation first. */
export function readCandidates(tx: AppTransaction, projectId: string, monitorId: string): ReviewCandidate[] {
  ensurePrSchema(tx);
  return tx.all<{ record_json: string }>(
    "SELECT record_json FROM pr_candidates WHERE project_id = ? AND monitor_id = ? ORDER BY generation DESC, id",
    projectId, monitorId,
  ).map(row => JSON.parse(row.record_json) as ReviewCandidate);
}

export function readCandidate(tx: AppTransaction, projectId: string, candidateId: string): ReviewCandidate {
  ensurePrSchema(tx);
  const row = tx.get<{ record_json: string }>(
    "SELECT record_json FROM pr_candidates WHERE project_id = ? AND id = ?", projectId, candidateId);
  if (!row) throw new AppError("pr_candidate_not_found", 404);
  return JSON.parse(row.record_json) as ReviewCandidate;
}

function nextGeneration(tx: AppTransaction, monitorId: string, pullNumber: number): number {
  const rows = tx.all<{ record_json: string }>(
    "SELECT record_json FROM pr_candidates WHERE monitor_id = ?", monitorId);
  let max = 0;
  for (const row of rows) {
    const candidate = JSON.parse(row.record_json) as ReviewCandidate;
    if (candidate.pullNumber === pullNumber) max = Math.max(max, candidate.generation);
  }
  return max + 1;
}

function supersedePrior(
  tx: AppTransaction,
  monitor: PrMonitor,
  pullNumber: number,
  keepDedupe: string,
  now: number,
  onSupersede?: (candidate: ReviewCandidate) => void,
): void {
  for (const row of tx.all<{ id: string; record_json: string }>(
    "SELECT id, record_json FROM pr_candidates WHERE monitor_id = ?", monitor.id,
  )) {
    const candidate = JSON.parse(row.record_json) as ReviewCandidate;
    if (candidate.pullNumber !== pullNumber) continue;
    if (candidate.dedupeKey === keepDedupe) continue;
    if (["superseded", "cancelled"].includes(candidate.status)) continue;
    candidate.status = "superseded";
    candidate.updatedAt = now;
    saveCandidate(tx, candidate);
    // Same transaction: older revisions' snapshot/review work cannot publish.
    fencePrCandidateWork(tx, monitor.projectId, candidate.id, "superseded", now);
    onSupersede?.(candidate);
  }
}

function statusFor(monitor: PrMonitor, draft: boolean, state: "open" | "closed"): CandidateStatus {
  if (state === "closed") return "closed";
  if (draft && monitor.policy.skipDraftUntilReady) return "draft";
  return "ready";
}

/**
 * Advances one poll page for an active monitor.
 * Failed/partial pagination does not mark catch-up complete or skip unrecorded work.
 * Duplicate deliveries reuse the exact repository/PR/base/head/policy candidate.
 */
export function pollMonitorPage(
  tx: AppTransaction,
  projectId: string,
  monitorId: string,
  connector: TrustedGitHubConnector,
  now: number,
  hooks?: {
    onSupersede?: (candidate: ReviewCandidate) => void;
    onCancel?: (candidate: ReviewCandidate) => void;
  },
): { checkpoint: PollCheckpoint; created: ReviewCandidate[]; reused: ReviewCandidate[] } {
  ensurePrSchema(tx);
  const monitor = readMonitor(tx, projectId, monitorId);
  if (monitor.state !== "active") throw new AppError("pr_monitor_not_active", 409);

  const checkpoint = loadCheckpoint(tx, monitorId);
  const page = checkpoint.nextPage;
  if (page > monitor.limits.maxPages) {
    checkpoint.complete = false;
    checkpoint.reason = "max_pages";
    checkpoint.updatedAt = now;
    saveCheckpoint(tx, checkpoint);
    return { checkpoint, created: [], reused: [] };
  }

  const listed = connector.listPulls(page);
  const created: ReviewCandidate[] = [];
  const reused: ReviewCandidate[] = [];

  if (listed.reason === "rate_limited" || listed.reason === "pagination_failed") {
    checkpoint.complete = false;
    checkpoint.reason = listed.reason;
    checkpoint.updatedAt = now;
    // Do not advance nextPage past unrecorded work.
    saveCheckpoint(tx, checkpoint);
    return { checkpoint, created, reused };
  }

  for (const pull of listed.items) {
    if (!SHA.test(pull.base.sha) || !SHA.test(pull.head.sha)) continue;
    const key = dedupeKey(monitor, pull.number, pull.base.sha, pull.head.sha);
    const existing = tx.get<{ record_json: string }>(
      "SELECT record_json FROM pr_candidates WHERE project_id = ? AND dedupe_key = ?",
      projectId, key,
    );
    if (existing) {
      const candidate = JSON.parse(existing.record_json) as ReviewCandidate;
      // Duplicate page/event delivery reuses the durable candidate.
      if (pull.state === "closed" && candidate.status !== "closed" && monitor.policy.closeCancelsPending) {
        candidate.status = "closed";
        candidate.state = "closed";
        candidate.updatedAt = now;
        saveCandidate(tx, candidate);
        hooks?.onCancel?.(candidate);
      } else if (pull.state === "open" && candidate.state === "closed" && monitor.policy.reopenReevaluates) {
        // Reopen with same SHAs reevaluates; keep identity, refresh status.
        candidate.state = "open";
        candidate.draft = pull.draft;
        candidate.status = statusFor(monitor, pull.draft, "open");
        candidate.updatedAt = now;
        saveCandidate(tx, candidate);
      }
      reused.push(candidate);
      continue;
    }

    if (monitor.policy.reconsiderChangedBaseOrHead) {
      supersedePrior(tx, monitor, pull.number, key, now, hooks?.onSupersede);
    }

    let status = statusFor(monitor, pull.draft, pull.state);
    if (pull.state === "closed" && monitor.policy.closeCancelsPending) status = "closed";

    const candidate: ReviewCandidate = {
      id: crypto.randomUUID(),
      projectId,
      monitorId: monitor.id,
      repository: { ...monitor.repository },
      pullNumber: pull.number,
      title: pull.title.slice(0, 500),
      draft: pull.draft,
      state: pull.state,
      baseSha: pull.base.sha,
      headSha: pull.head.sha,
      policyVersion: monitor.policy.version,
      dedupeKey: key,
      generation: nextGeneration(tx, monitor.id, pull.number),
      status,
      jobId: null,
      snapshotId: null,
      createdAt: now,
      updatedAt: now,
    };
    saveCandidate(tx, candidate);
    if (status === "closed") hooks?.onCancel?.(candidate);
    created.push(candidate);
  }

  checkpoint.etag = listed.etag;
  checkpoint.updatedAt = now;
  checkpoint.reason = listed.incomplete ? listed.reason : null;
  if (listed.incomplete) {
    checkpoint.complete = false;
    checkpoint.nextPage = page + 1;
  } else {
    checkpoint.complete = true;
    checkpoint.nextPage = 1;
    checkpoint.reason = null;
  }
  if (listed.items.length) {
    checkpoint.lastSeenUpdatedAt = listed.items.map(p => p.updatedAt).sort().at(-1) ?? checkpoint.lastSeenUpdatedAt;
  }
  saveCheckpoint(tx, checkpoint);
  return { checkpoint, created, reused };
}

/** Runs bounded poll pages until complete, failed, or the page ceiling. */
export function pollMonitorCatchUp(
  tx: AppTransaction,
  projectId: string,
  monitorId: string,
  connector: TrustedGitHubConnector,
  now: number,
  hooks?: Parameters<typeof pollMonitorPage>[5],
): { checkpoint: PollCheckpoint; created: ReviewCandidate[]; reused: ReviewCandidate[] } {
  const created: ReviewCandidate[] = [];
  const reused: ReviewCandidate[] = [];
  let checkpoint = loadCheckpoint(tx, monitorId);
  const monitor = readMonitor(tx, projectId, monitorId);
  for (let i = 0; i < monitor.limits.maxPages; i++) {
    const result = pollMonitorPage(tx, projectId, monitorId, connector, now, hooks);
    created.push(...result.created);
    reused.push(...result.reused);
    checkpoint = result.checkpoint;
    if (checkpoint.complete || checkpoint.reason === "rate_limited" || checkpoint.reason === "pagination_failed"
        || checkpoint.reason === "max_pages") break;
  }
  return { checkpoint, created, reused };
}
