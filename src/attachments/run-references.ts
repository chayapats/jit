import { suppressedSource, deletedSource } from "../memory/read";
import { lookupSource } from "../sources";
import type { AppTransaction } from "../store";

/** Identity-only app.attachments/v1 reference; revision/generation name the source, never the mutable attachment row. */
export interface RunAttachmentRef {
  attachmentId: string; revision: number; generation: number; kind: "image" | "pdf" | "text"; inline: boolean;
}

/**
 * CTX01/ATT04 seam: rechecks a bounded run reference against its bound project/topic row, source and lifecycle ledger.
 * It reads no file content. ATT04 must call this before materializing a frame, and retain the reference for fencing.
 */
export function runAttachmentCurrent(tx: AppTransaction, scope: { projectId: string; topicId: string }, ref: RunAttachmentRef): boolean {
  const source = { sourceId: ref.attachmentId, revision: ref.revision, generation: ref.generation };
  if (deletedSource(tx, source) || suppressedSource(tx, source)) return false;
  const row = tx.get<{ kind: string }>(`SELECT kind FROM attachments WHERE id = ? AND project_id = ? AND topic_id = ?
    AND message_id IS NOT NULL AND state != 'deleted'`, ref.attachmentId, scope.projectId, scope.topicId);
  if (!row || row.kind !== ref.kind) return false;
  const found = lookupSource(tx, scope.projectId, source);
  return found.state === "available" && found.descriptor.kind === "attachment" && found.current.revision === ref.revision;
}

/** Collects at most 20 live bound references from selected message sources, newest first; only the newest owner's files inline. */
export function collectRunAttachments(tx: AppTransaction, scope: { projectId: string; topicId: string }, sources: readonly { reference: { sourceId: string } }[]): RunAttachmentRef[] {
  const result: RunAttachmentRef[] = [];
  let newestOwner: string | null = null;
  const messages = sources.map(source => tx.get<{ id: string; attribution: string; sequence: number }>("SELECT id, attribution_json AS attribution, sequence FROM messages WHERE project_id = ? AND topic_id = ? AND source_id = ?", scope.projectId, scope.topicId, source.reference.sourceId)).filter(message => message !== null).sort((a, b) => b.sequence - a.sequence);
  for (const message of messages) {
    if (!message || JSON.parse(message.attribution).kind !== "owner") continue;
    newestOwner ??= message.id;
    const rows = tx.all<{ attachmentId: string; revision: number; generation: number; kind: RunAttachmentRef["kind"] }>(`SELECT a.id AS attachmentId, s.current_revision AS revision, s.generation, a.kind
      FROM attachments a JOIN sources s ON s.id = a.id AND s.project_id = a.project_id
      WHERE a.project_id = ? AND a.topic_id = ? AND a.message_id = ? AND a.state != 'deleted' ORDER BY a.created_at, a.id`, scope.projectId, scope.topicId, message.id);
    for (const row of rows) {
      const ref = { ...row, inline: message.id === newestOwner };
      if (result.length < 20 && !result.some(item => item.attachmentId === ref.attachmentId) && runAttachmentCurrent(tx, scope, ref)) result.push(ref);
    }
  }
  return result;
}

/** Admission gate for carried inline files only; rejected and removed files never keep a reply waiting. */
export function attachmentsPending(tx: AppTransaction, scope: { projectId: string; topicId: string }, refs: readonly RunAttachmentRef[] = []): boolean {
  return refs.some(ref => ref.inline && runAttachmentCurrent(tx, scope, ref) && tx.get<{ state: string }>("SELECT state FROM attachments WHERE id = ?", ref.attachmentId)?.state === "pending");
}
