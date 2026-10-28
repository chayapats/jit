import { retireDeliveryIntent } from "../delivery";
import type { AppTransaction } from "../store";
import { ensurePrSchema } from "./schema";
import type { AlertLink } from "./types";

/** Scope selecting linked PR alert intents; exactly one of report/candidate/monitor is required. */
export type AlertScope =
  | { projectId: string; reportId: string; findingId?: string }
  | { projectId: string; candidateId: string }
  | { projectId: string; monitorId: string };

/** Reads the durable link rows for one report in creation order. */
export function readAlertLinks(tx: AppTransaction, reportId: string): AlertLink[] {
  ensurePrSchema(tx);
  return tx.all<{ record_json: string }>("SELECT record_json FROM pr_alerts WHERE report_id = ? ORDER BY rowid", reportId)
    .map(row => JSON.parse(row.record_json) as AlertLink);
}

/** Reads the link for one outbox intent, or null when the intent is not a PR alert. */
export function readAlertLink(tx: AppTransaction, intentId: string): AlertLink | null {
  ensurePrSchema(tx);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM pr_alerts WHERE intent_id = ?", intentId);
  return row ? JSON.parse(row.record_json) as AlertLink : null;
}

function linksIn(tx: AppTransaction, scope: AlertScope): AlertLink[] {
  const rows = "reportId" in scope
    ? scope.findingId !== undefined
      ? tx.all<{ record_json: string }>("SELECT record_json FROM pr_alerts WHERE project_id = ? AND report_id = ? AND finding_id = ? ORDER BY rowid", scope.projectId, scope.reportId, scope.findingId)
      : tx.all<{ record_json: string }>("SELECT record_json FROM pr_alerts WHERE project_id = ? AND report_id = ? ORDER BY rowid", scope.projectId, scope.reportId)
    : "candidateId" in scope
      ? tx.all<{ record_json: string }>("SELECT record_json FROM pr_alerts WHERE project_id = ? AND candidate_id = ? ORDER BY rowid", scope.projectId, scope.candidateId)
      : tx.all<{ record_json: string }>("SELECT record_json FROM pr_alerts WHERE project_id = ? AND monitor_id = ? ORDER BY rowid", scope.projectId, scope.monitorId);
  return rows.map(row => JSON.parse(row.record_json) as AlertLink);
}

/**
 * Retires linked PR alert intents inside the caller's transaction when their source stops being current.
 * Unsent intents are cancelled and marked stale with `reason`; with `markSettledStale` an already
 * sent/unknown/failed alert stays recorded but becomes visibly stale (supersede, close, revoke).
 * Dismissal and policy changes pass `markSettledStale:false`: they stop pending sends without
 * relabelling a delivered alert. `filter` narrows which links are touched. Returns retired intent IDs.
 */
export function retirePrAlerts(
  tx: AppTransaction,
  scope: AlertScope,
  reason: string,
  now: number,
  options: { markSettledStale: boolean; filter?: (link: AlertLink) => boolean },
): string[] {
  ensurePrSchema(tx);
  const retired: string[] = [];
  for (const link of linksIn(tx, scope)) {
    if (options.filter && !options.filter(link)) continue;
    let outcome: ReturnType<typeof retireDeliveryIntent>;
    try { outcome = retireDeliveryIntent(tx, link.projectId, link.intentId, reason, now, { markSettledStale: options.markSettledStale }); }
    catch { continue; }
    if (outcome !== "unchanged") retired.push(link.intentId);
  }
  return retired;
}
