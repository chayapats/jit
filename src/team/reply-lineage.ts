import { AppError } from "../errors";
import type { SourceReference } from "../sources";
import type { AppTransaction } from "../store";

/** Most reply nodes one lineage walk may visit before it fails closed. */
export const replyLineageLimit = 20_000;

/**
 * app.jit_reply/v1 lineage for app.memory_suppression/v1. A Jit reply's manifest cites the topic messages it was
 * given (`jit_reply_sources`), and its committed text is an output source (`jit_replies.reply_source_id`) that later
 * replies may cite in turn. Starting from the given sources, this walks forward through every reply that depends on
 * them, directly or through earlier replies, and returns the reply outputs that may copy them and the replies still
 * pending. A forget binds those outputs as suppressed lineage and fences the pending jobs, so automatic history can
 * never reuse forgotten material through Jit's own answers. A walk beyond {@link replyLineageLimit} fails closed.
 */
export function replyLineage(tx: AppTransaction, seeds: readonly SourceReference[]): {
  outputs: { projectId: string; source: SourceReference }[]; pendingJobs: { id: string; projectId: string }[];
} {
  const key = (ref: SourceReference) => `${ref.sourceId}:${ref.revision}:${ref.generation}`;
  const queue = [...seeds], seen = new Set(seeds.map(key)), replies = new Set<string>();
  const outputs: { projectId: string; source: SourceReference }[] = [], pendingJobs: { id: string; projectId: string }[] = [];
  while (queue.length) {
    const ref = queue.shift()!;
    for (const row of tx.all<{ id: string; projectId: string; replySourceId: string | null; jobId: string | null; jobState: string | null }>(
      `SELECT r.id, r.project_id AS projectId, r.reply_source_id AS replySourceId, t.job_id AS jobId, j.state AS jobState
       FROM jit_reply_sources s JOIN jit_replies r ON r.id = s.reply_id LEFT JOIN team_runs t ON t.id = r.run_id LEFT JOIN jobs j ON j.id = t.job_id
       WHERE s.source_id = ? AND s.revision = ? AND s.generation = ?`, ref.sourceId, ref.revision, ref.generation)) {
      if (replies.has(row.id)) continue;
      replies.add(row.id);
      if (replies.size > replyLineageLimit) throw new AppError("memory_forget_too_broad", 409);
      if (row.replySourceId) {
        const current = tx.get<{ revision: number; generation: number }>("SELECT current_revision AS revision, generation FROM sources WHERE id = ?", row.replySourceId);
        if (!current) continue;
        const output = { sourceId: row.replySourceId, revision: current.revision, generation: current.generation };
        if (seen.has(key(output))) continue;
        seen.add(key(output)); queue.push(output);
        outputs.push({ projectId: row.projectId, source: output });
      } else if (row.jobId && row.jobState && ["queued", "admitted", "waiting"].includes(row.jobState)) {
        pendingJobs.push({ id: row.jobId, projectId: row.projectId });
      }
    }
  }
  return { outputs, pendingJobs };
}
