import type { AppTransaction } from "../store";
import type { JobQueue } from "../jobs/queue";
import type { WorkDefinition } from "../jobs/types";
import { retirePrAlerts } from "./alert-links";
import { readMonitor } from "./authority";
import { TrustedGitHubConnector, type FakeGitHubFixture } from "./github";
import { readCandidate } from "./poll";
import { collectSnapshotMaterials, persistSnapshot } from "./snapshot";
import type { PrMonitor, ReviewCandidate } from "./types";

/** Job input identifying one durable review candidate for immutable capture. */
export interface PrSnapshotInput {
  monitorId: string;
  candidateId: string;
}

function isInput(value: unknown): value is PrSnapshotInput {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === 2
    && typeof (value as PrSnapshotInput).monitorId === "string"
    && /^[a-f0-9-]{36}$/.test((value as PrSnapshotInput).monitorId)
    && typeof (value as PrSnapshotInput).candidateId === "string"
    && /^[a-f0-9-]{36}$/.test((value as PrSnapshotInput).candidateId);
}

/**
 * Registers read-only PR snapshot capture as fenced job work.
 * `fixtureFor` is process-owned wiring; models cannot register connectors.
 */
export function prSnapshotWork(options: {
  store: { read: <T>(query: (tx: AppTransaction) => T) => T };
  fixtureFor: (monitor: PrMonitor) => FakeGitHubFixture;
  cacheRoot: string;
}): WorkDefinition {
  return {
    replay: "read",
    id: "pr.snapshot",
    title: "จับภาพ PR แบบ immutable",
    revision: 1,
    route: { provider: "jit-service", model: null, authRoute: "internal" },
    cost: { roles: 1, calls: 1, rounds: 1, hops: 1 },
    validate: (input) => isInput(input),
    isCurrent: (tx, job) => {
      if (!isInput(job.input)) return false;
      try {
        const monitor = readMonitor(tx, job.projectId, job.input.monitorId);
        if (monitor.state !== "active") return false;
        const candidate = readCandidate(tx, job.projectId, job.input.candidateId);
        return !["superseded", "cancelled", "stale", "closed"].includes(candidate.status);
      } catch { return false; }
    },
    run: ({ job, signal, commit }) => {
      if (signal.aborted || !isInput(job.input)) return { state: "failed", reason: "worker_failed" };
      const input = job.input;
      const prepared = options.store.read(tx => {
        const monitor = readMonitor(tx, job.projectId, input.monitorId);
        const candidate = readCandidate(tx, job.projectId, input.candidateId);
        return { monitor, candidate };
      });
      if (prepared.monitor.state !== "active") return { state: "failed", reason: "worker_failed" };
      const connector = new TrustedGitHubConnector(
        options.fixtureFor(prepared.monitor), prepared.monitor, options.cacheRoot,
      );
      let materials;
      try {
        materials = collectSnapshotMaterials(prepared.candidate, prepared.monitor.limits, connector);
      } catch {
        return { state: "failed", reason: "worker_failed" };
      }
      if (materials.markStale) {
        const outcome = { state: "failed" as const, reason: "worker_failed" as const, evidence: "stale_refs" };
        commit(outcome, (tx) => {
          const candidate = readCandidate(tx, job.projectId, input.candidateId);
          candidate.status = "stale";
          candidate.updatedAt = job.updatedAt;
          tx.run("UPDATE pr_candidates SET status = ?, record_json = ? WHERE id = ?",
            "stale", JSON.stringify(candidate), candidate.id);
          retirePrAlerts(tx, { projectId: job.projectId, candidateId: candidate.id }, "candidate_stale", job.updatedAt, { markSettledStale: true });
        });
        return outcome;
      }
      const evidence = `snapshot:${materials.candidateId};coverage:${materials.snapshot.coverage.overall};enum:${materials.snapshot.coverage.enumerationComplete}`;
      const outcome = { state: "succeeded" as const, evidence };
      const ok = commit(outcome, (tx) => {
        const snapshot = persistSnapshot(tx, job.projectId, materials, connector, job.updatedAt);
        if (!snapshot) throw new Error("stale");
        const live = readCandidate(tx, job.projectId, input.candidateId);
        live.jobId = job.id;
        tx.run("UPDATE pr_candidates SET record_json = ? WHERE id = ?", JSON.stringify(live), live.id);
      });
      return ok ? outcome : { state: "failed", reason: "worker_failed" };
    },
  };
}

/**
 * Invalidates fenced PR snapshot jobs for a revoked/superseded candidate inside the same tx.
 * Callers must invoke `queue.cancelFenced()` after the transaction commits.
 */
export function fencePrCandidateJobs(
  tx: AppTransaction,
  queue: JobQueue,
  projectId: string,
  candidate: Pick<ReviewCandidate, "jobId">,
  reason: "revoked" | "superseded",
): void {
  if (candidate.jobId) queue.invalidate(tx, projectId, candidate.jobId, reason);
}
