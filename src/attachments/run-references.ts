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
