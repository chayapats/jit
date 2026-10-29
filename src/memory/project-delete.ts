import { invalidatePendingJob } from "../jobs/queue";
import { readDeliveryReport, retireDeliveryReport } from "../delivery/outbox";
import { createHash } from "node:crypto";
import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import { mutateMonitor, readMonitors } from "../pr/authority";
import { ensurePrSchema } from "../pr/schema";

const marker = "(memory ไม่พร้อมใช้งาน)";
/** Identity-only collateral disclosed in the digest-bound project preview. No paths or payload text may be persisted. */
export interface ProjectCollateralInventory { key: string; count: number; bytes: number; digest: string; identities: string[] }
/** Durable cleanup state; a missing contributor fails closed and a pending scope prevents completion. */
export interface ProjectCollateralScope extends ProjectCollateralInventory { state: "pending" | "purged" | "failed"; attempts: number; reason: string | null }
/**
 * Service-owned project collateral extension point (ATT06). preview is synchronous, deterministic and identity-only;
 * confirm retires metadata/fences writers in the app transaction; reconcile idempotently purges external artifacts.
 * Implementations must use service-authorized roots, never a persisted path, and support restore replay before readers resume.
 */
export interface ProjectCollateralContributor {
  key: string;
  preview(tx: AppTransaction, projectId: string): Omit<ProjectCollateralInventory, "key">;
  confirm(tx: AppTransaction, projectId: string, inventory: ProjectCollateralInventory, operationId: string, now: number): void;
  reconcile(projectId: string, inventory: ProjectCollateralInventory): Promise<void>;
}
/** Project-owned identities and lifecycle states shown before deletion; stateDigest covers all owned rows, never their text. */
export interface ProjectDeletionInventory {
  topics: { id: string; revision: number }[]; messages: { id: string }[];
  tasks: { id: string; revision: number; state: string }[];
  schedules: { id: string; revision: number; state: string }[];
  prMonitors: { id: string; revision: number; state: string }[];
  discussions: { id: string; revision: number }[];
  collateral: ProjectCollateralInventory[];
  stateDigest: string;
}

interface OwnedTable { table: string; where: string; columns: string[] }
/** All direct and dependent project rows. New disk artifacts must additionally supply a collateral contributor. */
function ownedTables(tx: AppTransaction): OwnedTable[] {
  const tables: OwnedTable[] = [];
  const dependent: Record<string, string> = {
    source_versions: "source_id IN (SELECT id FROM sources WHERE project_id = ?)",
    job_attempts: "job_id IN (SELECT id FROM jobs WHERE project_id = ?)",
    job_authority: "job_id IN (SELECT id FROM jobs WHERE project_id = ?)",
    job_schedule_occurrences: "schedule_id IN (SELECT id FROM job_schedules WHERE project_id = ?)",
    delivery_attempts: "intent_id IN (SELECT id FROM delivery_intents WHERE project_id = ?)",
    pr_snapshots: "candidate_id IN (SELECT id FROM pr_candidates WHERE project_id = ?)",
    pr_poll_checkpoints: "monitor_id IN (SELECT id FROM pr_monitors WHERE project_id = ?)",
    pr_report_annotations: "report_id IN (SELECT id FROM pr_reports WHERE project_id = ?)",
    memory_context_entries: "context_id IN (SELECT id FROM memory_contexts WHERE project_id = ?)",
  };
  for (const { name: table } of tx.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")) {
    if (!/^[a-z_]+$/.test(table)) throw new AppError("project_delete_schema_unreadable", 409);
    const columns = tx.all<{ name: string }>(`PRAGMA table_info(${table})`).map(c => c.name);
    const where = columns.includes("project_id") ? "project_id = ?" : dependent[table];
    if (where) tables.push({ table, columns, where });
  }
  return tables;
}
const identityTables = new Set(["audit", "deletion_previews", "deletion_operations", "deletion_ledger", "lifecycle_ledger"]);

/** Builds the complete project inventory; unreadable records, oversized lists and owner copies refuse confirmation. */
export function projectDeletionInventory(tx: AppTransaction, projectId: string, contributors: readonly ProjectCollateralContributor[], blockers: Set<string>): ProjectDeletionInventory {
  ensurePrSchema(tx);
  const rows = <T,>(table: string, columns: string) => tx.all<T>(`SELECT ${columns} FROM ${table} WHERE project_id = ? ORDER BY rowid`, projectId);
  const topics = rows<{ id: string; revision: number }>("topics", "id, revision"), messages = rows<{ id: string }>("messages", "id");
  const tasks = rows<{ id: string; revision: number; state: string }>("tasks", "id, task_revision AS revision, state");
  for (const task of tasks) if (["proposed", "accepted", "ready_for_review"].includes(task.state)) blockers.add(`active_task_current_proposal:${task.id}`);
  for (const decision of rows<{ id: string; superseded_by: string | null }>("owner_decisions", "id, superseded_by")) if (!decision.superseded_by) blockers.add(`owner_decision_copy:${decision.id}`);
  for (const card of rows<{ id: string; state: string }>("approval_cards", "id, state")) if (["executing", "unknown"].includes(card.state)) blockers.add(`project_effect_unsettled:${card.id}`);
  for (const server of rows<{ id: string; state: string }>("mcp_servers", "id, state")) if (server.state === "installing") blockers.add(`project_mcp_installing:${server.id}`);
  const schedules = rows<{ id: string; record_json: string }>("job_schedules", "id, record_json").map(row => {
    try { const value = JSON.parse(row.record_json); return { id: row.id, revision: value.revision as number, state: value.state as string }; }
    catch { blockers.add("unreadable_record:job_schedules"); return { id: row.id, revision: 0, state: "unknown" }; }
  });
  const discussions = rows<{ id: string; record_json: string }>("team_runs", "id, record_json").flatMap(row => {
    try { const value = JSON.parse(row.record_json); return value.kind === "discussion" ? [{ id: row.id, revision: value.revision as number }] : []; }
    catch { blockers.add("unreadable_record:team_runs"); return []; }
  });
  const prMonitors = rows<{ id: string; revision: number; state: string }>("pr_monitors", "id, revision, state");
  const state = createHash("sha256");
  for (const { table, where, columns } of ownedTables(tx)) {
    if (identityTables.has(table)) continue;
    let after = 0, seen = 0;
    for (;;) {
      const page = tx.all<Record<string, unknown> & { rowid_: number }>(`SELECT rowid AS rowid_, * FROM ${table} WHERE ${where} AND rowid > ? ORDER BY rowid LIMIT 500`, projectId, after);
      for (const row of page) {
        if (++seen > 200_000) { blockers.add(`inventory_scan_ceiling:${table}`); break; }
        state.update(JSON.stringify([table, row]));
        for (const column of columns.filter(c => c.endsWith("_json"))) if (row[column] != null) {
          try { JSON.parse(row[column] as string); } catch { blockers.add(`unreadable_record:${table}`); }
        }
      }
      if (page.length < 500 || seen > 200_000) break;
      after = page.at(-1)!.rowid_;
    }
  }
  const collateral = contributors.map(contributor => ({ key: contributor.key, ...contributor.preview(tx, projectId) })).sort((a, b) => a.key.localeCompare(b.key));
  if (new Set(collateral.map(c => c.key)).size !== collateral.length || collateral.some(c => !/^[a-z][a-z0-9_]{0,63}$/.test(c.key) || !Number.isSafeInteger(c.count) || c.count < 0 || !Number.isSafeInteger(c.bytes) || c.bytes < 0 || !/^[a-f0-9]{64}$/.test(c.digest) || !Array.isArray(c.identities) || c.identities.some(id => typeof id !== "string" || id.length > 200))) throw new AppError("invalid_project_collateral", 500);
  for (const [key, list] of Object.entries({ topics, messages, tasks, schedules, prMonitors, discussions, collateral })) if (list.length > 1000) blockers.add(`inventory_truncated:project.${key}`);
  return { topics: topics.slice(0, 1000), messages: messages.slice(0, 1000), tasks: tasks.slice(0, 1000), schedules: schedules.slice(0, 1000), prMonitors: prMonitors.slice(0, 1000), discussions: discussions.slice(0, 1000), collateral, stateDigest: state.digest("hex") };
}

const structural = /^(?:id|ids|kind|type|state|status|channel|provider|adapter|nextAction|layer|availability|origin|mode|storage|contract|policyVersion|outcome|digest|inventoryDigest|stateDigest)$|(?:Id|Ids|_id|_ids)$/;
/** Removes project payload strings while retaining identity references and lifecycle enums needed for reconciliation. */
function redact(value: unknown, key = ""): unknown {
  if (typeof value === "string") return structural.test(key) || (key === "reason" && ["revoked", "source_retired", "context_retired", "cancelled", "project_deleted", "superseded", "complete", "queued", "interrupted"].includes(value)) ? value : value ? marker : value;
  if (Array.isArray(value)) return value.map(item => redact(item, key));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redact(v, k)]));
  return value;
}

/**
 * Purges all project-owned payloads while preserving identity rows and owner task/decision states. Used by confirm
 * and quarantined restore replay after owner blockers have been checked (replay enforces the existing ledger).
 * Native bytes and external artifacts are handled only by managed cleanup scopes, outside this transaction.
 */
export function purgeProjectPayloads(tx: AppTransaction, projectId: string, now: number): void {
  ensurePrSchema(tx);
  for (const row of tx.all<{ id: string }>("SELECT id FROM jobs WHERE project_id = ?", projectId)) invalidatePendingJob(tx, projectId, row.id, "source_retired", now);
  for (const row of tx.all<{ id: string }>("SELECT id FROM delivery_reports WHERE project_id = ?", projectId)) {
    const report = readDeliveryReport(tx, projectId, row.id);
    if (report.availability === "available") retireDeliveryReport(tx, projectId, row.id, "delete", report.revision, now);
  }
  for (const monitor of readMonitors(tx, projectId)) if (monitor.state !== "revoked") mutateMonitor(tx, {
    kind: "pr.monitor.revoke", requestId: crypto.randomUUID(), projectId,
    expectedRevision: tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", projectId)!.revision,
    payload: { monitorId: monitor.id },
  }, now);
  for (const row of tx.all<{ id: string; record_json: string }>("SELECT id, record_json FROM job_schedules WHERE project_id = ?", projectId)) {
    const schedule = JSON.parse(row.record_json);
    tx.run("UPDATE job_schedules SET record_json = ? WHERE id = ?", JSON.stringify({ ...schedule, state: "revoked", revision: schedule.revision + 1, nextRun: null, updatedAt: now }), row.id);
  }
  tx.run("UPDATE approval_cards SET state = 'denied', reason = 'project_deleted', revision = revision + 1 WHERE project_id = ? AND state IN ('pending', 'approved')", projectId);
  tx.run("UPDATE auto_approve_rules SET enabled = 0 WHERE project_id = ?", projectId);
  tx.run("UPDATE mcp_servers SET state = 'removed', reason = 'project_deleted' WHERE project_id = ?", projectId);
  tx.run("UPDATE dispatch_proposals SET state = 'dismissed' WHERE project_id = ? AND state = 'proposed'", projectId);
  tx.run("UPDATE takeover_sessions SET state = 'ended' WHERE project_id = ?", projectId);
  for (const { table, where, columns } of ownedTables(tx)) {
    if (identityTables.has(table) || table === "export_artifacts") continue;
    for (const column of columns.filter(c => c.endsWith("_json"))) {
      for (const row of tx.all<{ rowid_: number; value: string }>(`SELECT rowid AS rowid_, ${column} AS value FROM ${table} WHERE ${where} AND ${column} IS NOT NULL ORDER BY rowid`, projectId)) {
        const parsed = JSON.parse(row.value);
        const next = redact(parsed) as Record<string, unknown> | null;
        if (table === "team_runs" && parsed.kind === "discussion" && next) next.stoppedAll = true;
        tx.run(`UPDATE ${table} SET ${column} = ? WHERE rowid = ?`, JSON.stringify(next), row.rowid_);
      }
    }
  }
  // Plain payload columns and descriptor copies that are not represented by source content.
  tx.run("UPDATE source_versions SET descriptor_json = json_object('kind', json_extract(descriptor_json, '$.kind')) WHERE source_id IN (SELECT id FROM sources WHERE project_id = ?)", projectId);
  tx.run("UPDATE source_versions SET content_text = NULL WHERE source_id IN (SELECT id FROM sources WHERE project_id = ?)", projectId);
  tx.run("UPDATE sources SET availability = 'unavailable' WHERE project_id = ?", projectId);
  tx.run("UPDATE projects SET name = ?, revision = revision + 1 WHERE id = ?", marker, projectId);
  tx.run("UPDATE tasks SET title = ?, summary = ? WHERE project_id = ?", marker, marker, projectId);
  tx.run("UPDATE task_proposals SET title = ?, summary = ? WHERE project_id = ?", marker, marker, projectId);
  tx.run("UPDATE owner_decisions SET conclusion = ?, rationale = ? WHERE project_id = ?", marker, marker, projectId);
  tx.run("UPDATE task_events SET reason = ? WHERE project_id = ? AND reason IS NOT NULL", marker, projectId);
  tx.run("UPDATE tasks SET closed_reason = ? WHERE project_id = ? AND closed_reason IS NOT NULL", marker, projectId);
  tx.run("UPDATE execution_halts SET reason = ? WHERE project_id = ?", "project_deleted", projectId);
  tx.run("UPDATE execution_tool_calls SET subject = ? WHERE project_id = ?", marker, projectId);
  for (const table of ["delivery_intents", "pr_candidates"]) tx.run(`UPDATE ${table} SET dedupe_key = 'deleted:' || rowid WHERE project_id = ?`, projectId);
  tx.run("UPDATE pr_poll_due SET last_failure = 'project_deleted' WHERE project_id = ? AND last_failure IS NOT NULL", projectId);
  tx.run("UPDATE project_team SET route_json = NULL, overrides_json = '{}' WHERE project_id = ?", projectId);
  tx.run("UPDATE mcp_servers SET spec_json = '{}', env_json = '{}', tools_json = '[]' WHERE project_id = ?", projectId);
  tx.run("UPDATE mcp_proposals SET spec_json = '{}', dropped_json = '{}' WHERE project_id = ?", projectId);
  tx.run("UPDATE auto_approve_rules SET scope_json = '{}' WHERE project_id = ?", projectId);
  tx.run("UPDATE approval_cards SET action_json = '{}', decision_json = NULL, receipt_json = NULL WHERE project_id = ?", projectId);
  // These owner-configured names are composite keys; opaque replacements remain unique inside the tombstone.
  for (const table of ["git_remotes", "deploy_targets"]) tx.run(`UPDATE ${table} SET name = 'deleted-' || rowid, url = ?, removed = 1 WHERE project_id = ?`, marker, projectId);
  tx.run("UPDATE mcp_servers SET name = 'deleted-' || rowid WHERE project_id = ?", projectId);
  for (const row of tx.all<{ request_id: string; result_json: string }>(`SELECT request_id, result_json FROM command_receipts WHERE request_id IN (SELECT request_id FROM audit WHERE project_id = ?)`, projectId)) {
    tx.run("UPDATE command_receipts SET result_json = ? WHERE request_id = ?", JSON.stringify(redact(JSON.parse(row.result_json))), row.request_id);
  }
}
