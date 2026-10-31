import { lstatSync } from "node:fs";
import { join } from "node:path";
import { AppError } from "../errors";
import { opsRead } from "./ops-files";
import { opsRoot } from "./ops-state";
import { managedBackupContract, opsLimits, type ManagedBackupManifest } from "./ops-types";
import { s14SchemaVersion } from "./store";

/**
 * What a cheap look can say. `intact` means every listed file is present at its recorded size, never that its bytes were
 * verified: full hash and quarantine validation runs only in offline `restore.prepare`.
 */
export type S14BackupHealth = "intact" | "damaged" | "unsupported";
/** Metadata for one registered backup. Numbers only: no path, hash or manifest text leaves this module. Null means unreadable, not zero. */
export interface S14BackupItem { id: string; origin: "online" | "offline"; health: S14BackupHealth; createdAt: number | null; bytes: number | null; sessions: number | null; files: number | null; schema: number | null }

const count = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
function inspect(directory: string, id: string): Omit<S14BackupItem, "id" | "origin"> {
  const manifest = JSON.parse(opsRead(join(directory, "manifest.json"), opsLimits.journalBytes).toString()) as ManagedBackupManifest;
  if (manifest.id !== id || !Array.isArray(manifest.native) || !Array.isArray(manifest.artifacts) || !count(manifest.createdAt) || !count(manifest.schema) || !count(manifest.image?.size)) throw new AppError("s14_ops_bounds_or_type", 409);
  const components = [manifest.image, ...manifest.native.map(entry => entry.component)];
  if (components.some(item => !count(item?.size) || !/^(application\.sqlite|native-[0-9]{1,4}\.json)$/.test(item.name))) throw new AppError("s14_ops_bounds_or_type", 409);
  const present = components.every(item => { const stat = lstatSync(join(directory, item.name), { throwIfNoEntry: false }); return stat?.isFile() && stat.size === item.size; });
  const facts = { createdAt: manifest.createdAt, bytes: components.reduce((sum, item) => sum + item.size, 0), sessions: manifest.native.length, files: manifest.artifacts.length, schema: manifest.schema };
  const supported = manifest.contract === managedBackupContract && manifest.format === "jit.s14/v1" && manifest.schema === s14SchemaVersion && manifest.state === "complete";
  return { ...facts, health: !present ? "damaged" : supported ? "intact" : "unsupported" };
}
/** Reads registered manifests, newest first, for owner display. It opens no image, grants nothing and is never restore evidence. */
export function backupInventory(path: string, ids: readonly string[], offline: readonly string[]): S14BackupItem[] {
  const items = ids.map((id): S14BackupItem => {
    const origin = offline.includes(id) ? "offline" as const : "online" as const;
    try { return { id, origin, ...inspect(join(opsRoot(path), "backups", id), id) }; }
    catch { return { id, origin, health: "damaged", createdAt: null, bytes: null, sessions: null, files: null, schema: null }; }
  });
  return items.sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0));
}
