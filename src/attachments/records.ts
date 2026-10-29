import { AppError } from "../errors";
import { requireId } from "../sources";
import type { AppTransaction } from "../store";

/** Owner-facing metadata only; the source ref uses the immutable source revision, not the processing revision. */
export interface AttachmentView {
  id: string; projectId: string; topicId: string; messageId: string | null; revision: number;
  state: "pending" | "ready" | "rejected" | "deleted"; kind: "image" | "pdf" | "text"; mediaType: string;
  name: string | null; bytes: number; createdAt: number; sanitizedBy: "container" | "service" | "fallback" | null;
  preview: boolean; textTruncated: boolean; reason: string | null; ref: string | null;
}
/** Reads an attachment only inside an already authorized project/topic; a cross-scope id is indistinguishable from absence. */
export function readAttachment(tx: AppTransaction, projectId: string, topicId: string, id: string): AttachmentView {
  for (const value of [projectId, topicId, id]) requireId(value);
  const row = tx.get<Omit<AttachmentView, "preview" | "textTruncated" | "ref"> & { textTruncated: number; sourceRevision: number | null }>(`
    SELECT a.id, a.project_id AS projectId, a.topic_id AS topicId, a.message_id AS messageId, a.revision, a.state, a.kind,
      a.media_type AS mediaType, a.display_name AS name, a.bytes, a.created_at AS createdAt, a.sanitized_by AS sanitizedBy,
      a.text_truncated AS textTruncated, a.reason, s.current_revision AS sourceRevision
    FROM attachments a LEFT JOIN sources s ON s.id = a.id AND s.project_id = a.project_id
    WHERE a.id = ? AND a.project_id = ? AND a.topic_id = ?`, id, projectId, topicId);
  if (!row) throw new AppError("attachment_not_found", 404);
  const { sourceRevision, ...view } = row;
  return { ...view, textTruncated: row.textTruncated === 1,
    preview: row.kind === "image" && row.state === "ready" && row.sanitizedBy === "container",
    ref: row.messageId && sourceRevision ? `attachment:${id}@${sourceRevision}` : null };
}
/** Identity-only audit metadata accepted by the shared writer; names, hashes and file text have no field. */
export interface AttachmentEvent {
  projectId: string; attachmentId?: string | null;
  kind: "upload" | "reject" | "sanitize" | "bind" | "download" | "send_model" | "read" | "outbound_block" | "box_copy" | "box_remove" | "delete";
  status: "ok" | "refused" | "failed"; reason?: string | null; runId?: string | null; jobId?: string | null; route?: string | null;
  bytes?: number | null; detail?: Record<string, string | number | boolean | null>; createdAt: number;
}
const detailKeys = new Set(["limit", "kind", "sanitizedBy", "durationMs", "truncated", "part", "offset", "bytes", "channel", "cardId", "level", "count"]);
/** Writes one bounded, content-free event and retains the newest 5000 events in that project in the same transaction. */
export function writeAttachmentEvent(tx: AppTransaction, event: AttachmentEvent): void {
  requireId(event.projectId);
  for (const id of [event.attachmentId, event.runId, event.jobId]) if (id != null) requireId(id);
  if (event.reason && !/^[a-z_]{1,80}$/.test(event.reason)) throw new AppError("invalid_attachment_event");
  if (event.route && (!/^[A-Za-z0-9._:/@+-]{1,384}$/.test(event.route))) throw new AppError("invalid_attachment_event");
  const detail = event.detail ?? {};
  if (Object.entries(detail).some(([key, value]) => !detailKeys.has(key) ||
    (typeof value === "string" && !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) ||
    (typeof value === "number" && (!Number.isSafeInteger(value) || value < 0)))) throw new AppError("invalid_attachment_event");
  const json = JSON.stringify(detail);
  if (Buffer.byteLength(json) > 1024) throw new AppError("invalid_attachment_event");
  tx.run(`INSERT INTO attachment_events (project_id, attachment_id, kind, status, reason, run_id, job_id, route, bytes, detail_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, event.projectId, event.attachmentId ?? null, event.kind, event.status, event.reason ?? null,
    event.runId ?? null, event.jobId ?? null, event.route ?? null, event.bytes ?? null, json, event.createdAt);
  tx.run(`DELETE FROM attachment_events WHERE project_id = ? AND sequence <=
    (SELECT sequence FROM attachment_events WHERE project_id = ? ORDER BY sequence DESC LIMIT 1 OFFSET 5000)`, event.projectId, event.projectId);
}
/** A bounded audit page contains identities/counts only and never attachment content, a display name or hash. */
export interface AttachmentEventView extends Omit<AttachmentEvent, "detail"> { sequence: number; detail: Record<string, string | number | boolean | null> }
/** Reads newest-first, before an exclusive sequence cursor, optionally narrowed to one attachment, limit 1–100. */
export function readAttachmentEvents(tx: AppTransaction, projectId: string, options: { before?: number; limit?: number; attachmentId?: string } = {}): AttachmentEventView[] {
  requireId(projectId); if (options.attachmentId !== undefined) requireId(options.attachmentId);
  const before = options.before ?? Number.MAX_SAFE_INTEGER, limit = options.limit ?? 50;
  if (!Number.isSafeInteger(before) || before < 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new AppError("invalid_cursor");
  return tx.all<Omit<AttachmentEventView, "detail"> & { detailJson: string }>(`SELECT sequence, project_id AS projectId, attachment_id AS attachmentId,
    kind, status, reason, run_id AS runId, job_id AS jobId, route, bytes, detail_json AS detailJson, created_at AS createdAt
    FROM attachment_events WHERE project_id = ? AND sequence < ? ${options.attachmentId !== undefined ? "AND attachment_id = ?" : ""}
    ORDER BY sequence DESC LIMIT ?`, ...[projectId, before, ...options.attachmentId !== undefined ? [options.attachmentId] : [], limit])
    .map(({ detailJson, ...row }) => ({ ...row, detail: JSON.parse(detailJson) }));
}
/** Counts each original hash once per project, across staged and bound live rows. Derivatives consume disk reserve, not quota. */
export function attachmentProjectBytes(tx: AppTransaction, projectId: string): number {
  return tx.get<{ bytes: number }>(`SELECT coalesce(sum(bytes), 0) AS bytes FROM
    (SELECT sha256, max(bytes) AS bytes FROM attachments WHERE project_id = ? AND state != 'deleted' AND sha256 IS NOT NULL GROUP BY sha256)`, projectId)!.bytes;
}
/** True when an original or derivative is still referenced by any live row of this project. Call under an immediate transaction before unlink. */
export function attachmentBlobReferenced(tx: AppTransaction, projectId: string, hash: string): boolean {
  return tx.get(`SELECT 1 FROM attachments WHERE project_id = ? AND state != 'deleted'
    AND (sha256 = ? OR clean_sha256 = ? OR model_sha256 = ? OR text_sha256 = ?) LIMIT 1`, projectId, hash, hash, hash, hash) !== null;
}
