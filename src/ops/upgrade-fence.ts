import { Database } from "bun:sqlite";
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
export interface UpgradeFence {
  contract: "ops.schema_migrations/v1"; upgradeId: string; since: number;
  /**
   * Which owner-authorized installation operation holds the fence. Absent means
   * an upgrade (OPS06). `restore` (ops.quarantined_restore/v1) holds the same
   * fence, so restore and upgrade exclude each other; `upgradeId` is then the
   * restore id.
   */
  holder?: "upgrade" | "restore";
}

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
    if (parsed?.contract === "ops.schema_migrations/v1" && typeof parsed.upgradeId === "string" && Number.isSafeInteger(parsed.since) &&
        (parsed.holder === undefined || parsed.holder === "upgrade" || parsed.holder === "restore")) return parsed;
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

/** Lock file beside the fence that serializes fence acquisition and owner-scoped release (OPS15-01). */
export function upgradeFenceLockPath(databasePath: string): string {
  return `${upgradeFencePath(databasePath)}.lock`;
}

/** Default bound for waiting on another holder of the fence lock. The critical section is a few file operations. */
const fenceLockTimeoutMs = 5000;

/**
 * Creates the empty lock file once without ever holding a non-SQLite descriptor on its inode: a private
 * temporary file is created and closed, then hard-linked into place (failing rather than following or
 * replacing anything at the lock path). Closing any other descriptor on the lock inode would drop this
 * process's POSIX record locks on it, so only SQLite ever opens the lock path itself.
 */
function createFenceLock(path: string): void {
  const temporary = join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}`);
  closeSync(openSync(temporary, "wx", 0o600));
  try {
    chmodSync(temporary, 0o600);
    try { linkSync(temporary, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  } finally { try { unlinkSync(temporary); } catch { /* A leftover empty temporary file is inert. */ } }
}

/**
 * Runs `work` while holding the installation-wide fence lock: a SQLite `BEGIN IMMEDIATE` transaction on an
 * always-empty lock file (Schway's credential-store lock pattern, schway#428). SQLite holds it as a POSIX
 * advisory record lock that the operating system releases when the holding process exits for any reason,
 * including SIGKILL, so there is no owner stamp, liveness check or stale lock to remove. A write probe
 * inside the never-committed transaction refuses a connection SQLite silently opened read-only (whose
 * `BEGIN IMMEDIATE` would exclude nobody); the journal stays in memory, so the file stays empty. The
 * connection stays referenced for the whole critical section and is closed (rolled back) afterwards.
 * A holder that outlasts the bounded wait is refused with `upgrade_in_progress`; an unusable lock path
 * (unwritable, not an empty regular file) is refused with `upgrade_storage_unavailable`.
 */
export function withUpgradeFenceLock<T>(databasePath: string, work: () => T, options: { timeoutMs?: number } = {}): T {
  const path = upgradeFenceLockPath(databasePath), timeoutMs = options.timeoutMs ?? fenceLockTimeoutMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new AppError("upgrade_storage_unavailable", 503);
  let lock: Database, opened: { dev: number; ino: number };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) createFenceLock(path);
    const stat = lstatSync(path);
    // A fence lock file is always empty; never open (and possibly rewrite) any other file as SQLite.
    if (!stat.isFile() || stat.size !== 0) throw new Error("not_a_fence_lock");
    opened = { dev: stat.dev, ino: stat.ino };
    lock = new Database(path, { readwrite: true, create: false });
  } catch { throw new AppError("upgrade_storage_unavailable", 503); }
  try {
    try { lock.exec(`PRAGMA busy_timeout = ${timeoutMs}; PRAGMA journal_mode = MEMORY`); }
    catch { throw new AppError("upgrade_storage_unavailable", 503); }
    try { lock.exec("BEGIN IMMEDIATE"); }
    catch (error) {
      const busy = String((error as { code?: unknown })?.code ?? "").startsWith("SQLITE_BUSY");
      throw new AppError(busy ? "upgrade_in_progress" : "upgrade_storage_unavailable", busy ? 409 : 503);
    }
    // Verify the connection, not the path: a read-only connection fails this write inside the open transaction.
    try { lock.exec("PRAGMA user_version = 1"); } catch { throw new AppError("upgrade_storage_unavailable", 503); }
    // A lock file replaced since the open would let another process lock a different inode behind the same path.
    let current: ReturnType<typeof statSync> | null = null;
    try { current = statSync(path); } catch { /* Removed: refused below. */ }
    if (!current || current.dev !== opened.dev || current.ino !== opened.ino) throw new AppError("upgrade_storage_unavailable", 503);
    return work();
  } finally {
    // Closing rolls back the never-committed transaction and drops the lock.
    try { lock.close(); } catch { /* Process exit releases the lock regardless. */ }
  }
}

/**
 * Durably acquires the fence for `upgradeId` (or, with `holder: "restore"`,
 * for a restore id). Acquisition is an OS-level exclusive create: the complete
 * claim is written to a private temp file and hard-linked into place, which
 * fails if any fence already exists, so two processes can never both hold it
 * and a claim is never overwritten. The check-and-link runs under the
 * OS-released fence lock (`withUpgradeFenceLock`), so it never interleaves with
 * an owner-scoped release. Re-acquiring a fence this id already holds is a
 * no-op. Throws `upgrade_in_progress` / `restore_in_progress` when another id
 * holds it (or the lock stays held past its bound), `upgrade_storage_unavailable`
 * on storage errors.
 */
export function writeUpgradeFence(databasePath: string, upgradeId: string, since: number, holder: "upgrade" | "restore" = "upgrade"): void {
  const path = upgradeFencePath(databasePath);
  const body = JSON.stringify({ contract: "ops.schema_migrations/v1", upgradeId, since, ...(holder === "restore" ? { holder } : {}) } satisfies UpgradeFence);
  const linked = withUpgradeFenceLock(databasePath, () => {
    const temp = `${path}.claim-${crypto.randomUUID()}`;
    let created = false;
    try {
      const fd = openSync(temp, "wx", 0o600);
      try { writeFileSync(fd, body); fsyncSync(fd); } finally { closeSync(fd); }
      try { linkSync(temp, path); created = true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } catch {
      throw new AppError("upgrade_storage_unavailable", 503);
    } finally {
      try { rmSync(temp, { force: true }); } catch { /* Leftover claim temp files are inert. */ }
    }
    if (created) fsyncDir(dirname(path));
    return created;
  });
  if (linked) return;
  const current = readUpgradeFence(databasePath);
  if (current?.upgradeId === upgradeId) return;
  throw new AppError(current?.holder === "restore" ? "restore_in_progress" : "upgrade_in_progress", 409);
}

/**
 * Releases the fence (idempotent). With `ownerId`, only a fence whose claim
 * names that id is removed: the read-compare-unlink runs under the OS-released
 * fence lock, so a stale clearer can never remove a fence that a different id
 * acquired after its read. Without `ownerId` the fence is removed unconditionally,
 * still under the lock so it never interleaves with an acquisition.
 * `hooks.afterRead` is a deterministic-test barrier inside the critical section.
 */
export function clearUpgradeFence(databasePath: string, ownerId?: string, hooks: { afterRead?: () => void } = {}): void {
  const path = upgradeFencePath(databasePath);
  const remove = () => {
    try { rmSync(path, { force: true }); } catch { throw new AppError("upgrade_storage_unavailable", 503); }
    fsyncDir(dirname(path));
  };
  withUpgradeFenceLock(databasePath, () => {
    if (ownerId === undefined) { remove(); return; }
    const current = readUpgradeFence(databasePath);
    hooks.afterRead?.();
    if (current && current.upgradeId === ownerId) remove();
  });
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
