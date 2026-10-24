import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../errors";

/**
 * Durable upgrade admission fence (ops.schema_migrations/v1).
 *
 * While an owner-authorized upgrade holds the fence, every managed writer
 * refuses new work: application commands other than `upgrade.*`, job
 * admission and pumping (so automatic contexts, extraction, PR monitoring and
 * schedules never start), schedule ticks and delivery claims/sends. The fence
 * is a file beside the database, not a row inside it, so it survives process
 * restarts and the activation swap, and every component that knows the store
 * path finds it without configuration. A present but unreadable fence still
 * fences (fail closed). The fence is only a liveness gate: activation is
 * additionally bound to a digest of all managed state, so a writer that
 * ignored the fence makes activation fail instead of losing its write.
 */
export interface UpgradeFence { contract: "ops.schema_migrations/v1"; upgradeId: string; since: number }

/** Fence file location for one installation database. */
export function upgradeFencePath(databasePath: string): string {
  return `${databasePath}.upgrade-fence`;
}

/** Reads the fence; null when absent. An unreadable fence fails closed as a fence of unknown origin. */
export function readUpgradeFence(databasePath: string): UpgradeFence | null {
  const path = upgradeFencePath(databasePath);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as UpgradeFence;
    if (parsed?.contract === "ops.schema_migrations/v1" && typeof parsed.upgradeId === "string" && Number.isSafeInteger(parsed.since)) return parsed;
  } catch { /* Fall through: unreadable fence still fences. */ }
  return { contract: "ops.schema_migrations/v1", upgradeId: "unknown", since: 0 };
}

/** True while any upgrade fence is present for this database. */
export function upgradeFenced(databasePath: string): boolean {
  return existsSync(upgradeFencePath(databasePath));
}

/** Throws `upgrade_in_progress` while the fence is held. */
export function assertNotUpgradeFenced(databasePath: string): void {
  if (upgradeFenced(databasePath)) throw new AppError("upgrade_in_progress", 409);
}

/** Durably establishes the fence for `upgradeId`. */
export function writeUpgradeFence(databasePath: string, upgradeId: string, since: number): void {
  writeFileAtomic(upgradeFencePath(databasePath), JSON.stringify({ contract: "ops.schema_migrations/v1", upgradeId, since } satisfies UpgradeFence));
}

/** Releases the fence (idempotent). */
export function clearUpgradeFence(databasePath: string): void {
  const path = upgradeFencePath(databasePath);
  try { rmSync(path, { force: true }); } catch { throw new AppError("upgrade_storage_unavailable", 503); }
  fsyncDir(dirname(path));
}

function fsyncDir(dir: string): void {
  try { const fd = openSync(dir, "r"); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* Best effort on filesystems without directory fsync. */ }
}

/**
 * Crash-safe file replacement: writes a sibling temp file (mode 0600), fsyncs
 * it, renames it over `path` and fsyncs the directory. Readers observe either
 * the previous or the new complete content. Throws `upgrade_storage_unavailable`.
 */
export function writeFileAtomic(path: string, content: string | Uint8Array): void {
  const temp = `${path}.tmp-${crypto.randomUUID()}`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, content); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temp, path);
  } catch {
    try { rmSync(temp, { force: true }); } catch { /* Leftover temp files are inert. */ }
    throw new AppError("upgrade_storage_unavailable", 503);
  }
  fsyncDir(dirname(path));
}
