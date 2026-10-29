import { actionDigest, canonicalJson, type OutboundReleaseAction } from "../exec/approval-cards";
import type { SourceReference } from "../sources";
import type { AppTransaction } from "../store";

/** Purges web audit subjects and held-call copies reached by a source deletion, including restore ledger replay. Identity rows survive. */
export function purgeWebReadPayloads(tx: AppTransaction, source: SourceReference, contextIds: readonly string[] = []): void {
  const runs = new Set(tx.all<{ id: string }>("SELECT run_id AS id FROM web_run_sources WHERE source_id = ?", source.sourceId).map(row => row.id));
  // Successful reads are not required: a retry can hold private text before it creates any web source.
  const jobs = new Set(tx.all<{ id: string }>(`SELECT job_id AS id FROM web_run_sources WHERE source_id = ?
    UNION SELECT r.job_id FROM team_runs r, json_each(r.record_json, '$.request.manifest.sources') s
      WHERE json_extract(s.value, '$.reference.sourceId') = ?
    UNION SELECT a.job_id FROM job_attempts a, json_each(a.record_json, '$.data.manifest.sources') s
      WHERE json_extract(s.value, '$.reference.sourceId') = ?`, source.sourceId, source.sourceId, source.sourceId).map(row => row.id));
  for (const job of jobs) {
    for (const row of tx.all<{ id: string | null }>(`SELECT id FROM team_runs WHERE job_id = ?
      UNION SELECT json_extract(record_json, '$.request.runId') FROM team_runs WHERE job_id = ?
      UNION SELECT json_extract(record_json, '$.data.runId') FROM job_attempts WHERE job_id = ?`, job, job, job)) if (row.id) runs.add(row.id);
  }
  tx.run("UPDATE source_versions SET descriptor_json = json_set(descriptor_json, '$.resourceId', '[deleted]') WHERE source_id = ? AND json_extract(descriptor_json, '$.system') = 'web'", source.sourceId);
  for (const row of tx.all<{ id: string; runId: string; jobId: string; json: string }>("SELECT id, run_id AS runId, job_id AS jobId, action_json AS json FROM approval_cards WHERE kind = 'outbound_release'")) {
    const action = JSON.parse(row.json) as OutboundReleaseAction;
    if (!runs.has(row.runId) && !jobs.has(row.jobId) && !contextIds.includes(action.contextId)) continue;
    runs.add(row.runId);
    const redacted = { ...action, subject: "[deleted]", matchedSpan: "[deleted]" }, digest = actionDigest(redacted);
    tx.run("UPDATE approval_cards SET action_json = ?, digest = ?, receipt_json = NULL, state = CASE WHEN state IN ('pending', 'approved') THEN 'denied' ELSE state END, revision = revision + 1 WHERE id = ?", canonicalJson(redacted), digest, row.id);
    for (const receipt of tx.all<{ requestId: string; json: string }>("SELECT request_id AS requestId, result_json AS json FROM command_receipts WHERE json_extract(result_json, '$.card.id') = ?", row.id)) {
      const value = JSON.parse(receipt.json) as { card: Record<string, unknown> };
      value.card = { ...value.card, action: redacted, digest, receipt: null };
      tx.run("UPDATE command_receipts SET result_json = ? WHERE request_id = ?", JSON.stringify(value), receipt.requestId);
    }
  }
  for (const run of runs) tx.run("UPDATE web_tool_calls SET subject = '[deleted]' WHERE run_id = ?", run);
  for (const job of jobs) tx.run("UPDATE web_tool_calls SET subject = '[deleted]' WHERE job_id = ?", job);
}
