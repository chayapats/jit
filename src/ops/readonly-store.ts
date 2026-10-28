import { Database, type SQLQueryBindings } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AppTransaction } from "../store";
import type { ReadableStore } from "./lifecycle";

/** Read-only store whose every query fails: missing or unreadable installations read as unavailable. */
export function unavailableReadOnlyStore(path: string, reason = "store_unavailable"): ReadableStore {
  const fail = (): never => { throw new Error(reason); };
  const tx: AppTransaction = { get: fail, all: fail, run: fail };
  return { path, read: <T>(fn: (tx: AppTransaction) => T): T => fn(tx) } as ReadableStore;
}

/**
 * Read-only view of an installation database for status, preflight and
 * diagnostics (ops.service_package/v1). Never creates, migrates, journals,
 * checkpoints or chmods the installation; `run` always throws.
 *
 * - No database: null (callers report it missing/unavailable).
 * - Neither `-wal` nor `-shm`: no WAL content can exist, so the main file is
 *   read as a consistent in-memory snapshot (`Database.deserialize`, with
 *   the WAL-mode header bytes rewritten to rollback mode in the copy only).
 *   This is identical on every platform: `file:...?immutable=1` URIs work
 *   with macOS's system SQLite (compiled with SQLITE_USE_URI) but are taken
 *   as a literal filename by the SQLite Bun bundles on Linux, and a plain
 *   read-only open of a WAL-mode file without `-shm` fails everywhere. The
 *   snapshot is discarded when the file or its sidecars change during the
 *   read.
 * - Both sidecars: the installation's live WAL set is never opened (even a
 *   read-only SQLite connection writes reader marks into `-shm`). The main
 *   file and `-wal` are copied into a private disposable directory, the
 *   originals' size/mtime/inode must be unchanged across the copy (else the
 *   read is retried, at most 3 times, then fails `store_changed_during_read`),
 *   and the copy is opened; SQLite rebuilds the WAL index for the copy only.
 * - Exactly one sidecar: committed WAL data could be ignored or unreadable,
 *   so every query fails (`store_sidecars_incomplete`) and the store reads as
 *   unavailable rather than stale.
 *
 * Each `read` opens and closes its own connection.
 */
/** Largest installation database read as an in-memory snapshot; larger ones read as unavailable. */
export const snapshotLimitBytes = 512 * 1024 * 1024;

function snapshot(path: string): Database | null {
  const before = statSync(path);
  if (before.size > snapshotLimitBytes) throw new Error("store_too_large_for_snapshot");
  const bytes = new Uint8Array(readFileSync(path));
  const after = statSync(path);
  // A writer that attached meanwhile creates sidecars or changes the file: never serve a torn copy.
  if (existsSync(`${path}-wal`) || existsSync(`${path}-shm`) || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
      after.ino !== before.ino || bytes.length !== before.size) return null;
  // Header bytes 18/19 are the write/read format versions (2 = WAL). An in-memory copy has no WAL; mark it legacy.
  if (bytes.length >= 20 && bytes[18] === 2 && bytes[19] === 2) { bytes[18] = 1; bytes[19] = 1; }
  return Database.deserialize(bytes, { readonly: true, strict: true });
}

type Identity = { size: number; mtimeMs: number; ino: number };
const identity = (path: string): Identity => { const s = statSync(path); return { size: s.size, mtimeMs: s.mtimeMs, ino: s.ino }; };
const same = (a: Identity, b: Identity): boolean => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino;

/**
 * Disposable copy of a live WAL set (main + `-wal`), consistency-checked
 * against the originals. Returns the open copy and its cleanup, or null when
 * the originals kept changing.
 */
function walSnapshot(path: string): { db: Database; dispose: () => void } | null {
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = { main: identity(path), wal: identity(`${path}-wal`) };
    if (before.main.size + before.wal.size > snapshotLimitBytes) throw new Error("store_too_large_for_snapshot");
    const dir = mkdtempSync(join(tmpdir(), "jit-ro-store-"));
    const dispose = (): void => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* Best-effort temp cleanup. */ } };
    try {
      const copy = join(dir, "snapshot.sqlite");
      copyFileSync(path, copy);
      copyFileSync(`${path}-wal`, `${copy}-wal`);
      const after = { main: identity(path), wal: identity(`${path}-wal`) };
      if (!same(before.main, after.main) || !same(before.wal, after.wal) ||
          statSync(copy).size !== before.main.size || statSync(`${copy}-wal`).size !== before.wal.size) { dispose(); continue; }
      // The copy is private: a read-write connection may build its own WAL index there; queries stay read-only (`run` throws).
      const db = new Database(copy, { create: false, strict: true });
      return { db, dispose: () => { try { db.close(); } finally { dispose(); } } };
    } catch (error) { dispose(); throw error; }
  }
  return null;
}

export function openReadOnlyStore(path: string): ReadableStore | null {
  try { if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) return null; } catch { return null; }
  return {
    path,
    read<T>(fn: (tx: AppTransaction) => T): T {
      const wal = existsSync(`${path}-wal`), shm = existsSync(`${path}-shm`);
      if (wal !== shm) return unavailableReadOnlyStore(path, "store_sidecars_incomplete").read(fn);
      const opened = wal ? walSnapshot(path) : (() => { const db = snapshot(path); return db ? { db, dispose: () => db.close() } : null; })();
      if (!opened) return unavailableReadOnlyStore(path, "store_changed_during_read").read(fn);
      const db = opened.db;
      try {
        const tx: AppTransaction = {
          get: <R>(sql: string, ...bindings: SQLQueryBindings[]) => db.query(sql).get(...bindings) as R | null,
          all: <R>(sql: string, ...bindings: SQLQueryBindings[]) => db.query(sql).all(...bindings) as R[],
          run: () => { throw new Error("read_only_store"); },
        };
        return fn(tx);
      } finally { opened.dispose(); }
    },
  } as ReadableStore;
}
