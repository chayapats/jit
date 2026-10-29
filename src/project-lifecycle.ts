import { AppError } from "./errors";
import type { AppTransaction } from "./store";

/** SQL predicate for a live project alias. Project tombstones are identity-only installation ledger entries. */
export function liveProjectSql(alias: string): string {
  if (!/^[a-z_]+$/.test(alias)) throw new AppError("invalid_project_alias");
  return `NOT EXISTS (SELECT 1 FROM lifecycle_ledger lp WHERE lp.kind = 'deletion' AND lp.subject = 'project:' || ${alias}.id)`;
}
/** Fails closed on an unreadable current ledger. Only a pre-schema-23 migration without the table reads as empty. */
export function projectDeleted(tx: AppTransaction, projectId: string): boolean {
  try { return !!tx.get("SELECT 1 FROM lifecycle_ledger WHERE kind = 'deletion' AND subject = ? LIMIT 1", `project:${projectId}`); }
  catch {
    try {
      if ((tx.get<{ user_version: number }>("PRAGMA user_version")?.user_version ?? 23) < 23 &&
          !tx.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'lifecycle_ledger'")) return false;
    } catch { /* Current-schema or unreadable metadata still fails closed. */ }
    throw new AppError("deletion_ledger_unavailable", 503);
  }
}
/** The common command, worker and execution admission gate for a stable project identity. */
export function requireLiveProject(tx: AppTransaction, projectId: string): void {
  if (projectDeleted(tx, projectId)) throw new AppError("project_deleted", 409);
}
