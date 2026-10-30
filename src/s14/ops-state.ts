import { existsSync, lstatSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { AppError } from "../errors";
import { opsPath, opsRead } from "./ops-files";
import { restoreActivationContract, opsLimits, type OpsControl } from "./ops-types";

/** Stable installation maintenance root, excluded from application snapshots. */
export const opsRoot = (path: string): string => `${path}.ops`;
/** Blocks boot and ordinary store access whenever an unfinished operation or unreadable fence exists. */
export function assertS14OpsUnfenced(path: string): void {
  if (lstatSync(join(opsRoot(path), "fence.json"), { throwIfNoEntry: false })) throw new AppError("s14_ops_reconciliation_required", 503);
}
/** Reads bounded non-secret maintenance metadata without opening an image or starting any worker. */
export function readS14Ops(path: string): OpsControl {
  const file = join(opsRoot(path), "control.json");
  if (!existsSync(file)) return { contract: restoreActivationContract, revision: 0, backups: [], pendingBackupId: null, stage: null, receipts: [] };
  const value = JSON.parse(opsRead(file, opsLimits.journalBytes).toString()) as OpsControl;
  if (value.contract !== restoreActivationContract || !Number.isSafeInteger(value.revision) || !Array.isArray(value.backups) || value.backups.length > opsLimits.backups || !Array.isArray(value.receipts) || value.receipts.length > 100) throw new AppError("s14_ops_journal_invalid", 503);
  const validId = (id: unknown) => typeof id === "string" && /^[a-f0-9]{32}$/.test(id);
  if (value.backups.some(id => !validId(id)) || new Set(value.backups).size !== value.backups.length ||
      value.pendingBackupId !== null && !validId(value.pendingBackupId)) throw new AppError("s14_ops_journal_invalid", 503);
  if (value.stage && (!validId(value.stage.id) || value.stage.nativeDirectory !== join(opsRoot(path), "stages", value.stage.id, "native-sessions"))) throw new AppError("s14_ops_journal_invalid", 503);
  return value;
}
/** Reads the active opaque native store pointer; it never changes the stable correlation workspace identity. */
export function nativeSessionDirectory(directory: string): string {
  const file = `${directory}.session-store.json`;
  if (!existsSync(file)) return join(directory, "sessions");
  const value = JSON.parse(opsRead(file, 4096).toString()) as { contract: string; directory: string };
  if (value.contract !== restoreActivationContract || typeof value.directory !== "string") throw new AppError("s14_ops_native_pointer_invalid", 503);
  const local = relative(dirname(directory), value.directory);
  if (!/^[^/]+\.ops\/stages\/[a-f0-9]{32}\/native-sessions$/.test(local) || local.includes("..")) throw new AppError("s14_ops_native_pointer_invalid", 503);
  opsPath(value.directory);
  return value.directory;
}
