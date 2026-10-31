import { AppError } from "../errors";
import type { S14Application } from "./application";
import { backupInventory, type S14BackupItem } from "./backup-inventory";
import { assertS14BackupQuiescent } from "./ops-capture";
import { readS14Ops } from "./ops-state";
import { opsLimits, type OnlineBackupReceipt } from "./ops-types";
import type { S14OpsStage } from "./ops-guide";
import type { OwnerActor } from "./types";

/** Online retry journal bound; a full journal refuses every new request until an archival policy exists. */
const journalBound = 100;
/** Read-only surface for all three backup pages. No field here can start a capture, a restore or a stop. */
export interface S14BackupSurface {
  kind: "settings-backup"; screen: "overview" | "item" | "restore";
  /** Online command revision for `backup.create`, and the separate offline maintenance revision a restore must name. */
  revision: number; maintenance: number;
  retention: ReturnType<S14Application["backups"]["status"]>["retention"];
  items: S14BackupItem[]; item: S14BackupItem | null;
  /** The newest request, or the one the landing URL names. Reread from the journal, so a link cannot fake a result. */
  receipt: OnlineBackupReceipt | null;
  /** Why the service would refuse a new backup right now, read without capturing. Advisory: `backup.create` rechecks everything. */
  refusal: string | null; signIn: boolean;
  workers: "paused" | "running"; stage: S14OpsStage | null;
}

const safe = (read: () => OnlineBackupReceipt) => {
  try { return read(); }
  catch (error) { if (error instanceof AppError && ["not_found", "invalid_identity"].includes(error.code)) return null; throw error; }
};
/** Mirrors the reads `S14Backups.execute` starts with, so the page can name a block before a press. */
function refusal(app: S14Application, retention: S14BackupSurface["retention"], revision: number, rotatable: number, signIn: boolean): string | null {
  if (app.backups.busy) return "s14_backup_in_progress";
  if (revision >= journalBound) return "s14_ops_receipt_bound";
  if (retention.count - rotatable >= retention.limit) return "s14_ops_retention_full";
  const native = app.backups.native;
  if (!native) return "s14_ops_native_unsupported";
  try { assertS14BackupQuiescent(app.store, native); }
  catch (error) { if (error instanceof AppError) return error.code; throw error; }
  return signIn || app.recovery.booting ? "s14_ops_quiesce_required" : null;
}
/** `/settings/backup`, one backup, and its restore steps. It reads journals and manifests; it never opens a backup image. */
export function backupView(app: S14Application, url: URL, actor: OwnerActor): S14BackupSurface | null {
  const route = /^\/settings\/backup(?:\/([a-f0-9]{32})(\/restore)?)?$/.exec(url.pathname); if (!route) return null;
  const status = app.backups.status(actor), control = readS14Ops(app.store.path), found = control.stage;
  const items = backupInventory(app.store.path, control.backups, status.retention.protected), item = route[1] ? items.find(entry => entry.id === route[1]) ?? null : null;
  if (route[1] && !item) throw new AppError("not_found", 404);
  const stage: S14OpsStage | null = found ? { id: found.id, mode: found.mode, backupId: found.backupId, state: found.state, reason: found.reason, actionHash: found.actionHash, recoveryBackupId: found.recoveryBackupId } : null;
  const rotatable = items.filter(entry => entry.origin === "online" && entry.id !== stage?.backupId && entry.id !== stage?.recoveryBackupId).length;
  const signIn = app.signIns.flows.busy("codex") || app.signIns.flows.busy("grok"), request = url.searchParams.get("request");
  // A capture in flight outranks an older landing link, so no page offers a second press beside it.
  const receipt = status.latest?.state === "capturing" ? status.latest : (request ? safe(() => app.backups.receipt(actor, request)) : null) ?? status.latest;
  return { kind: "settings-backup", screen: route[2] ? "restore" : item ? "item" : "overview", revision: status.revision, maintenance: control.revision, retention: status.retention, items, item, receipt,
    refusal: refusal(app, status.retention, status.revision, rotatable, signIn), signIn, workers: app.backups.busy ? "paused" : "running", stage };
}
/** Landing address for a posted backup request; the page rereads the receipt, so this carries only its identity. */
export const backupSurface = (requestId: string) => `/settings/backup?request=${requestId}`;
/** Where a refused backup request returns. */
export const backupNext = (value: unknown) => (value as { kind?: string } | null)?.kind === "backup.create" ? "/settings/backup" : null;
/** Backups an offline recovery point can still join; a restore cannot begin at zero. */
export const recoveryRoom = (view: Pick<S14BackupSurface, "items">) => opsLimits.backups - view.items.length;
