import { AppError } from "../errors";
import { commitAttachmentSource, requireId } from "../sources";
import type { AppTransaction } from "../store";
import { readAttachment, writeAttachmentEvent, type AttachmentView } from "./records";

/** The configurable upper bound of `JIT_ATTACHMENT_MESSAGE_FILES`; the configured value is checked when binding. */
const maximumIds = 10;

/**
 * Validates `message.send` `attachmentIds` (app.attachments/v1): an array of attachment ids. An empty array means no
 * attachments. A duplicate id is 409 `attachment_stale`; any other shape is `invalid_conversation_command`.
 * Returns the ids sorted, the form the receipt identity uses.
 */
export function requireAttachmentIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > maximumIds) throw new AppError("invalid_conversation_command");
  for (const id of value) requireId(id);
  if (new Set(value).size !== value.length) throw new AppError("attachment_stale", 409);
  return [...value as string[]].sort();
}

/**
 * Binds staged attachments to a message inside the message transaction (ATT03). Each id must be an unbound attachment
 * of this project and topic in `pending` or `ready`: an unknown id, or one of another project or topic, is 404
 * `attachment_not_found`; a bound, rejected or deleted one is 409 `attachment_stale`. More than `messageFiles` ids is
 * 413 `attachment_quota_exceeded` (`limit: message_files`). Each bound attachment gets its `attachment` source,
 * its `message_id`, a revision step and a `bind` event. A throw rolls back the message with it.
 */
export function bindAttachments(tx: AppTransaction, input: {
  projectId: string; topicId: string; messageId: string; ids: readonly string[]; messageFiles: number; now: number;
}): void {
  if (input.ids.length > input.messageFiles) throw new AppError("attachment_quota_exceeded", 413, { limit: "message_files" });
  if (new Set(input.ids).size !== input.ids.length) throw new AppError("attachment_stale", 409);
  for (const id of input.ids) {
    requireId(id);
    const row = tx.get<{ state: string; messageId: string | null }>("SELECT state, message_id AS messageId FROM attachments WHERE id = ? AND project_id = ? AND topic_id = ?",
      id, input.projectId, input.topicId);
    if (!row) throw new AppError("attachment_not_found", 404);
    if (row.messageId !== null || (row.state !== "pending" && row.state !== "ready")) throw new AppError("attachment_stale", 409);
    commitAttachmentSource(tx, { projectId: input.projectId, topicId: input.topicId, messageId: input.messageId, attachmentId: id, committedAt: input.now });
    tx.run("UPDATE attachments SET message_id = ?, revision = revision + 1, bound_at = ?, updated_at = ? WHERE id = ? AND message_id IS NULL",
      input.messageId, input.now, input.now, id);
    writeAttachmentEvent(tx, { projectId: input.projectId, attachmentId: id, kind: "bind", status: "ok", createdAt: input.now });
  }
}

/**
 * Removes one staged attachment (the composer chip ×): `pending`, `ready` or `rejected` and never bound become
 * `deleted` with reason `discarded`, with the display name and every hash cleared, and a `delete` event. A bound or
 * already deleted attachment is 409 `attachment_stale`; a revision other than `expectedRevision` is 409
 * `stale_revision`. The blob is unlinked later by the blob sweep, which removes only unreferenced files.
 */
export function discardStagedAttachment(tx: AppTransaction, input: {
  projectId: string; topicId: string; id: string; expectedRevision: number | null; now: number;
}): AttachmentView {
  const row = tx.get<{ state: string; messageId: string | null; revision: number }>(
    "SELECT state, message_id AS messageId, revision FROM attachments WHERE id = ? AND project_id = ? AND topic_id = ?", input.id, input.projectId, input.topicId);
  if (!row) throw new AppError("attachment_not_found", 404);
  if (row.messageId !== null || row.state === "deleted") throw new AppError("attachment_stale", 409);
  if (input.expectedRevision !== null && row.revision !== input.expectedRevision) throw new AppError("stale_revision", 409);
  tx.run(`UPDATE attachments SET state = 'deleted', revision = revision + 1, reason = 'discarded', display_name = NULL, sha256 = NULL,
    clean_sha256 = NULL, model_sha256 = NULL, text_sha256 = NULL, updated_at = ?, deleted_at = ? WHERE id = ?`, input.now, input.now, input.id);
  writeAttachmentEvent(tx, { projectId: input.projectId, attachmentId: input.id, kind: "delete", status: "ok", reason: "discarded", createdAt: input.now });
  return readAttachment(tx, input.projectId, input.topicId, input.id);
}

/**
 * The attachments bound to the given messages of one topic, keyed by message id, in binding then upload order. Tombstones
 * (deleted rows) are included, so the transcript can say "file deleted". Metadata only; never file content.
 */
export function readMessageAttachments(tx: AppTransaction, projectId: string, topicId: string, messageIds: readonly string[]): Map<string, AttachmentView[]> {
  const result = new Map<string, AttachmentView[]>();
  for (let at = 0; at < messageIds.length; at += 100) {
    const batch = messageIds.slice(at, at + 100);
    for (const id of batch) requireId(id);
    if (!batch.length) continue;
    const rows = tx.all<{ id: string; messageId: string }>(`SELECT id, message_id AS messageId FROM attachments
      WHERE project_id = ? AND topic_id = ? AND message_id IN (${batch.map(() => "?").join(", ")}) ORDER BY bound_at, created_at, rowid`,
      projectId, topicId, ...batch);
    for (const row of rows) {
      const list = result.get(row.messageId) ?? [];
      list.push(readAttachment(tx, projectId, topicId, row.id));
      result.set(row.messageId, list);
    }
  }
  return result;
}
