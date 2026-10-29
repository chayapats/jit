import { AppError } from "../errors";
import type { SourceReference } from "../sources";
import type { AppTransaction } from "../store";

/** Most producer runs (replies, specialists, previews, syntheses, discussions) one lineage walk may visit before it fails closed. */
export const forgetLineageLimit = 20_000;

const pendingStates = new Set(["queued", "admitted", "waiting"]);
const key = (ref: SourceReference) => `${ref.sourceId}:${ref.revision}:${ref.generation}`;

/** One recorded run that was given some sources: its committed output source, or its job while that job is pending. */
interface Producer { id: string; projectId: string; output: string | null; jobId: string | null; jobState: string | null }

type ManifestRecord = { kind?: string; request?: { manifest?: { sources?: unknown }; attachments?: { attachmentId: string; revision: number; generation: number }[] }; manifest?: { sources?: unknown }; source?: { sourceId?: unknown } | null };

function manifestSources(value: unknown): SourceReference[] | null {
  if (!Array.isArray(value)) return null;
  const refs: SourceReference[] = [];
  for (const entry of value as { reference?: SourceReference }[]) {
    const ref = entry?.reference;
    if (ref && typeof ref.sourceId === "string" && Number.isSafeInteger(ref.revision) && Number.isSafeInteger(ref.generation)) refs.push(ref);
  }
  return refs;
}

/**
 * Producers indexed by the exact source revisions their manifests cite. Team runs (specialist results, role previews
 * and discussions) keep the manifest in their record; coordinator syntheses keep it in theirs and commit their output
 * as a decision proposal source. Jit replies are walked once, through {@link replyProducers}. Built once per walk; an unreadable record cites nothing here, and its
 * pending job still loses authority through the stale-context fence.
 */
function producerIndex(tx: AppTransaction): Map<string, Producer[]> {
  const index = new Map<string, Producer[]>();
  const add = (refs: SourceReference[], producer: Producer) => {
    for (const ref of refs) {
      const list = index.get(key(ref));
      if (list) list.push(producer); else index.set(key(ref), [producer]);
    }
  };
  for (const row of tx.all<{ id: string; projectId: string; jobId: string; jobState: string | null; json: string }>(
    `SELECT r.id, r.project_id AS projectId, r.job_id AS jobId, j.state AS jobState, r.record_json AS json
     FROM team_runs r LEFT JOIN jobs j ON j.id = r.job_id
     WHERE NOT EXISTS (SELECT 1 FROM jit_replies jr WHERE jr.run_id = r.id)`)) {
    let record: ManifestRecord;
    try { record = JSON.parse(row.json) as ManifestRecord; } catch { continue; }
    const discussion = record?.kind === "discussion";
    const refs = manifestSources(discussion ? record.manifest?.sources : record?.request?.manifest?.sources);
    if (!refs) continue;
    refs.push(...(record.request?.attachments ?? []).map(ref => ({ sourceId: ref.attachmentId, revision: ref.revision, generation: ref.generation })));
    refs.push(...tx.all<SourceReference>("SELECT source_id AS sourceId, revision, generation FROM web_run_sources WHERE job_id = ?", row.jobId));
    const output = !discussion && typeof record.source?.sourceId === "string" ? record.source.sourceId : null;
    add(refs, { id: `run:${row.id}`, projectId: row.projectId, output, jobId: row.jobId, jobState: row.jobState });
  }
  for (const row of tx.all<{ id: string; projectId: string; jobId: string; jobState: string | null; output: string | null; json: string }>(
    `SELECT s.id, s.project_id AS projectId, s.job_id AS jobId, j.state AS jobState, s.record_json AS json,
       (SELECT p.source_id FROM decision_proposals p WHERE p.synthesis_id = s.id LIMIT 1) AS output
     FROM coordinator_syntheses s LEFT JOIN jobs j ON j.id = s.job_id`)) {
    let record: ManifestRecord;
    try { record = JSON.parse(row.json) as ManifestRecord; } catch { continue; }
    const refs = manifestSources(record?.request?.manifest?.sources);
    if (refs) add(refs, { id: `synthesis:${row.id}`, projectId: row.projectId, output: row.output, jobId: row.jobId, jobState: row.jobState });
  }
  return index;
}

/** Jit replies that cite `ref`, through the indexed `jit_reply_sources` lineage (app.jit_reply/v1). */
function replyProducers(tx: AppTransaction, ref: SourceReference): Producer[] {
  return tx.all<{ id: string; projectId: string; output: string | null; jobId: string | null; jobState: string | null }>(
    `SELECT r.id, r.project_id AS projectId, r.reply_source_id AS output, t.job_id AS jobId, j.state AS jobState
     FROM jit_reply_sources s JOIN jit_replies r ON r.id = s.reply_id LEFT JOIN team_runs t ON t.id = r.run_id LEFT JOIN jobs j ON j.id = t.job_id
     WHERE s.source_id = ? AND s.revision = ? AND s.generation = ?`, ref.sourceId, ref.revision, ref.generation)
    .map(row => ({ ...row, id: `reply:${row.id}` }));
}

/**
 * app.memory_suppression/v1 derived lineage. Starting from the forgotten sources, this walks forward through every
 * recorded run that was given one of them, directly or through an earlier run's output: Jit replies, specialist
 * results, role previews, coordinator syntheses and discussions. It returns the committed outputs that may copy the
 * forgotten text and the jobs of runs still pending. A forget binds the outputs as suppressed lineage and fences the
 * pending jobs, so automatic memory can never extract or replay forgotten material through any producer's output.
 * A walk beyond {@link forgetLineageLimit} producers fails closed (`memory_forget_too_broad`).
 */
export function forgetLineage(tx: AppTransaction, seeds: readonly SourceReference[]): {
  outputs: { projectId: string; source: SourceReference }[]; pendingJobs: { id: string; projectId: string }[];
} {
  const index = producerIndex(tx);
  const queue = [...seeds], seen = new Set(seeds.map(key)), visited = new Set<string>();
  const outputs: { projectId: string; source: SourceReference }[] = [], pendingJobs: { id: string; projectId: string }[] = [];
  while (queue.length) {
    const ref = queue.shift()!;
    for (const producer of [...replyProducers(tx, ref), ...(index.get(key(ref)) ?? [])]) {
      if (visited.has(producer.id)) continue;
      visited.add(producer.id);
      if (visited.size > forgetLineageLimit) throw new AppError("memory_forget_too_broad", 409);
      if (producer.output) {
        const current = tx.get<{ revision: number; generation: number }>("SELECT current_revision AS revision, generation FROM sources WHERE id = ?", producer.output);
        if (!current) continue;
        const output = { sourceId: producer.output, revision: current.revision, generation: current.generation };
        if (seen.has(key(output))) continue;
        seen.add(key(output)); queue.push(output);
        outputs.push({ projectId: producer.projectId, source: output });
      } else if (producer.jobId && producer.jobState && pendingStates.has(producer.jobState)) {
        pendingJobs.push({ id: producer.jobId, projectId: producer.projectId });
      }
    }
  }
  return { outputs, pendingJobs };
}
