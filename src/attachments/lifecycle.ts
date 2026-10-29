import { createHash } from "node:crypto";
import type { AppTransaction } from "../store";
import type { SourceReference } from "../sources";
import type { ProjectCollateralContributor } from "../memory/project-delete";
import { writeAttachmentEvent } from "./records";
import type { AttachmentStorage } from "./storage";

/** Identity-only attachment inventory; digest binds all original and derivative references without disclosing hashes. */
export interface AttachmentInventory { count: number; bytes: number; digest: string; identities: string[] }
/** Durable file cleanup scope. Completion requires the service cleanup hook to verify disk and future ATT05 box copies. */
export interface AttachmentDeletionScope extends AttachmentInventory { projectId: string; state: "pending" | "purged" | "failed"; attempts: number; reason: string | null }
/** Service-owned ATT05 extension; resolve only authorized roots, remove copies idempotently and verify absence before returning. */
export interface AttachmentCopyCleanup { reconcile(projectId: string, attachmentIds: readonly string[]): Promise<void> }

/** Bound attachment sources reached by a message, topic or attachment source; unbound drafts have no source. */
export function attachmentSources(tx: AppTransaction, sourceIds: readonly string[]): { projectId: string; source: SourceReference }[] {
  const found = new Map<string, { projectId: string; source: SourceReference }>();
  for (const id of sourceIds) for (const row of tx.all<{ id: string; projectId: string; revision: number; generation: number }>(`SELECT s.id, s.project_id AS projectId, s.current_revision AS revision, s.generation
    FROM attachments a JOIN sources s ON s.id = a.id WHERE a.message_id IS NOT NULL AND (a.id = ? OR a.message_id IN (SELECT json_extract(v.descriptor_json, '$.messageId') FROM source_versions v WHERE v.source_id = ? AND json_extract(v.descriptor_json, '$.kind') = 'message')
      OR a.topic_id IN (SELECT json_extract(v.descriptor_json, '$.topicId') FROM source_versions v WHERE v.source_id = ? AND json_extract(v.descriptor_json, '$.kind') = 'topic'))`, id, id, id)) {
    found.set(row.id, { projectId: row.projectId, source: { sourceId: row.id, revision: row.revision, generation: row.generation } });
  }
  return [...found.values()];
}

/** Computes distinct per-project original/derivative bytes for the selected live rows; names and file bytes never enter the digest input. */
export function attachmentInventory(tx: AppTransaction, projectId: string, ids?: readonly string[]): AttachmentInventory {
  const selected = ids ? new Set(ids) : null;
  const rows = tx.all<{ id: string; revision: number; state: string; sha256: string | null; bytes: number; clean_sha256: string | null; clean_bytes: number | null; model_sha256: string | null; model_bytes: number | null; text_sha256: string | null; text_bytes: number | null }>("SELECT * FROM attachments WHERE project_id = ? AND state != 'deleted' ORDER BY id", projectId).filter(row => !selected || selected.has(row.id));
  const blobs = new Map<string, number>();
  for (const r of rows) for (const [hash, bytes] of [[r.sha256, r.bytes], [r.clean_sha256, r.clean_bytes], [r.model_sha256, r.model_bytes], [r.text_sha256, r.text_bytes]] as const) if (hash) blobs.set(hash, Math.max(blobs.get(hash) ?? 0, bytes ?? 0));
  return { count: rows.length, bytes: [...blobs.values()].reduce((a, b) => a + b, 0), identities: rows.map(r => r.id), digest: createHash("sha256").update(JSON.stringify(rows.map(r => [r.id, r.revision, r.state, r.sha256, r.bytes, r.clean_sha256, r.clean_bytes, r.model_sha256, r.model_bytes, r.text_sha256, r.text_bytes]))).digest("hex") };
}

/** Retires files atomically with ledger/fencing; disk cleanup runs only after commit. Repeated replay is a no-op. */
export function retireAttachments(tx: AppTransaction, projectId: string, ids: readonly string[], reason: "delete" | "forget" | "restore_dropped", now: number): void {
  const retiredIds: string[] = [];
  for (const id of ids) {
    const row = tx.get<{ state: string }>("SELECT state FROM attachments WHERE project_id = ? AND id = ?", projectId, id);
    if (!row || row.state === "deleted") continue;
    retiredIds.push(id);
    tx.run(`UPDATE attachments SET state = 'deleted', revision = revision + 1, reason = ?, display_name = NULL, sha256 = NULL,
      clean_sha256 = NULL, model_sha256 = NULL, text_sha256 = NULL, updated_at = ?, deleted_at = ? WHERE id = ?`, reason, now, now, id);
    tx.run("UPDATE sources SET availability = 'unavailable' WHERE id = ? AND project_id = ?", id, projectId);
    tx.run("UPDATE source_versions SET descriptor_json = json_remove(descriptor_json, '$.name', '$.displayName') WHERE source_id = ?", id);
    writeAttachmentEvent(tx, { projectId, attachmentId: id, kind: "delete", status: "ok", reason, createdAt: now });
  }
  // Completed runs can retain exact outbound payloads too. Reach cards through recorded source/run/job identities.
  if (retiredIds.length) {
    const attachmentIds = new Set(retiredIds), runIds = new Set<string>(), jobIds = new Set<string>(), cardIds = new Set<string>();
    for (const id of retiredIds) for (const event of tx.all<{ runId: string | null; jobId: string | null }>("SELECT run_id AS runId, job_id AS jobId FROM attachment_events WHERE project_id = ? AND attachment_id = ?", projectId, id)) {
      if (event.runId) runIds.add(event.runId); if (event.jobId) jobIds.add(event.jobId);
    }
    for (const table of ["team_runs", "jobs", "job_attempts"]) {
      const where = table === "job_attempts" ? "job_id IN (SELECT id FROM jobs WHERE project_id = ?)" : "project_id = ?";
      for (const row of tx.all<{ id: string; jobId: string; json: string }>(`SELECT id, ${table === "jobs" ? "id" : "job_id"} AS jobId, record_json AS json FROM ${table} WHERE ${where}`, projectId)) {
        const record = JSON.parse(row.json);
        if (!referencesAttachment(record, attachmentIds)) continue;
        jobIds.add(row.jobId); if (table === "team_runs") runIds.add(row.id);
        if (typeof record.request?.runId === "string") runIds.add(record.request.runId);
        if (typeof record.data?.runId === "string") runIds.add(record.data.runId);
      }
    }
    for (const card of tx.all<{ id: string; runId: string; jobId: string; action: string }>("SELECT id, run_id AS runId, job_id AS jobId, action_json AS action FROM approval_cards WHERE project_id = ? AND kind = 'outbound_release'", projectId)) {
      if (!runIds.has(card.runId) && !jobIds.has(card.jobId) && !referencesAttachment(JSON.parse(card.action), attachmentIds)) continue;
      cardIds.add(card.id);
      tx.run(`UPDATE approval_cards SET action_json = '{}', decision_json = NULL, receipt_json = NULL,
        state = CASE WHEN state IN ('pending', 'approved') THEN 'denied' ELSE state END, reason = 'source_retired', revision = revision + 1
        WHERE id = ?`, card.id);
    }
    redactOutboundRecords(tx, projectId, { attachmentIds, runIds, jobIds, cardIds });
  }
}

interface ReleaseScope { attachmentIds: Set<string>; runIds: Set<string>; jobIds: Set<string>; cardIds: Set<string> }
function referencesAttachment(value: unknown, ids: ReadonlySet<string>, key = ""): boolean {
  if (typeof value === "string") return /(?:attachmentId|attachmentIds|sourceId|source_id)$/.test(key) && ids.has(value);
  if (Array.isArray(value)) return value.some(item => referencesAttachment(item, ids, key));
  return !!value && typeof value === "object" && Object.entries(value).some(([k, v]) => referencesAttachment(v, ids, k));
}
/** Redacts exact release payloads in JSON copies (receipts/jobs); safe for export and credential-free backups too. */
export function redactOutboundRelease<T>(value: T, scope?: ReleaseScope): T {
  if (Array.isArray(value)) return value.map(v => redactOutboundRelease(v, scope)) as T;
  if (!value || typeof value !== "object") return value;
  const row = value as Record<string, unknown>;
  if (row.kind === "outbound_release" && (!scope || scope.cardIds.has(String(row.id ?? row.cardId)) || scope.runIds.has(String(row.runId)) || scope.jobIds.has(String(row.jobId)) || referencesAttachment(row, scope.attachmentIds))) return { ...row, action: {}, arguments: undefined, decision: null, receipt: null } as T;
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, redactOutboundRelease(v, scope)])) as T;
}
function redactOutboundRecords(tx: AppTransaction, projectId: string, scope: ReleaseScope): void {
  for (const table of ["jobs", "job_attempts", "team_runs", "coordinator_syntheses"]) {
    const where = table === "job_attempts" ? "job_id IN (SELECT id FROM jobs WHERE project_id = ?)" : "project_id = ?";
    for (const row of tx.all<{ rowid_: number; json: string }>(`SELECT rowid AS rowid_, record_json AS json FROM ${table} WHERE ${where}`, projectId)) {
      const next = JSON.stringify(redactOutboundRelease(JSON.parse(row.json), scope));
      if (next !== row.json) tx.run(`UPDATE ${table} SET record_json = ? WHERE rowid = ?`, next, row.rowid_);
    }
  }
  for (const row of tx.all<{ rowid_: number; json: string }>(`SELECT rowid AS rowid_, result_json AS json FROM command_receipts WHERE request_id IN (SELECT request_id FROM audit WHERE project_id = ?)`, projectId)) tx.run("UPDATE command_receipts SET result_json = ? WHERE rowid = ?", JSON.stringify(redactOutboundRelease(JSON.parse(row.json), scope)), row.rowid_);
}

/** Applies latest lifecycle authority and returns pre-retirement cleanup inventories; restore must persist them before activation. Also discards drafts when requested. */
export function replayAttachmentLifecycle(tx: AppTransaction, now: number, dropStaged = false): AttachmentDeletionScope[] {
  const rows = tx.all<{ id: string; projectId: string; messageId: string | null; deleted: number; suppressed: number }>(`SELECT a.id, a.project_id AS projectId, a.message_id AS messageId,
    EXISTS(SELECT 1 FROM lifecycle_ledger l WHERE l.kind = 'deletion' AND (l.subject = 'project:' || a.project_id OR (json_extract(l.record_json, '$.kind') = 'source' AND json_extract(l.record_json, '$.sourceId') = a.id))) AS deleted,
    EXISTS(SELECT 1 FROM lifecycle_ledger l WHERE l.kind = 'suppressed_source' AND json_extract(l.record_json, '$.sourceId') = a.id) AS suppressed
    FROM attachments a WHERE a.state != 'deleted'`);
  const groups = new Map<string, { projectId: string; reason: "delete" | "forget" | "restore_dropped"; ids: string[] }>();
  for (const row of rows) if (row.deleted || row.suppressed || (dropStaged && !row.messageId)) {
    const reason = row.deleted ? "delete" : row.suppressed ? "forget" : "restore_dropped", key = `${row.projectId}/${reason}`;
    const group = groups.get(key) ?? { projectId: row.projectId, reason, ids: [] }; group.ids.push(row.id); groups.set(key, group);
  }
  const byProject = new Map<string, string[]>();
  for (const group of groups.values()) byProject.set(group.projectId, [...(byProject.get(group.projectId) ?? []), ...group.ids]);
  // Capture hashes/bytes in the digest before retirement clears them. Only identities leave this transaction.
  const scopes: AttachmentDeletionScope[] = [...byProject].map(([projectId, ids]) => ({
    ...attachmentInventory(tx, projectId, ids), projectId, state: "pending", attempts: 0, reason: null,
  }));
  for (const group of groups.values()) retireAttachments(tx, group.projectId, group.ids, group.reason, now);
  return scopes;
}

/** Registers ATT06 on LIFE02's service-owned project collateral contract; all files, including drafts/orphans, are purged. */
export function attachmentProjectContributor(storage: AttachmentStorage, copies?: AttachmentCopyCleanup): ProjectCollateralContributor {
  return { key: "attachments", preview: (tx, projectId) => attachmentInventory(tx, projectId),
    confirm: (tx, projectId, inventory, _operationId, now) => retireAttachments(tx, projectId, inventory.identities, "delete", now),
    reconcile: async (projectId, inventory) => { await copies?.reconcile(projectId, inventory.identities); storage.purgeDeleted(); storage.purgeProject(projectId); } };
}

/** Reconciles forget file scopes independently of native retirement; failed files keep the suppression ledger incomplete. */
export async function reconcileForgottenAttachments(store: import("../store").TransactionStore, cleanup: AttachmentCopyCleanup | undefined): Promise<void> {
  if (!cleanup) return;
  const rows = store.read(tx => tx.all<{ id: string; json: string }>("SELECT id, record_json AS json FROM memory_suppressions"));
  for (const row of rows) {
    const suppression = JSON.parse(row.json) as import("../memory/types").MemorySuppression;
    for (const scope of suppression.attachments ?? []) {
      if (scope.state === "purged") continue;
      try { await cleanup.reconcile(scope.projectId, scope.identities); }
      catch { continue; }
      store.transaction(tx => {
        const current = JSON.parse(tx.get<{ json: string }>("SELECT record_json AS json FROM memory_suppressions WHERE id = ?", row.id)!.json) as import("../memory/types").MemorySuppression;
        const item = current.attachments?.find(a => a.projectId === scope.projectId);
        if (item) item.state = "purged";
        tx.run("UPDATE memory_suppressions SET record_json = ? WHERE id = ?", JSON.stringify(current), row.id);
      });
    }
  }
}
