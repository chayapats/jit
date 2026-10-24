import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
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
 *   read with `immutable=1` (no WAL index or journal is created).
 * - Both sidecars: a plain `readonly` connection that reads committed WAL data.
 * - Exactly one sidecar: committed WAL data could be ignored or unreadable,
 *   so every query fails (`store_sidecars_incomplete`) and the store reads as
 *   unavailable rather than stale.
 *
 * Each `read` opens and closes its own connection.
 */
export function openReadOnlyStore(path: string): ReadableStore | null {
  try { if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) return null; } catch { return null; }
  return {
    path,
    read<T>(fn: (tx: AppTransaction) => T): T {
      const wal = existsSync(`${path}-wal`), shm = existsSync(`${path}-shm`);
      if (wal !== shm) return unavailableReadOnlyStore(path, "store_sidecars_incomplete").read(fn);
      const db = wal
        ? new Database(path, { readonly: true, create: false, strict: true })
        : new Database(`file:${path.replace(/[%?#]/g, c => encodeURIComponent(c))}?immutable=1`, { readonly: true, create: false, strict: true });
      try {
        const tx: AppTransaction = {
          get: <R>(sql: string, ...bindings: SQLQueryBindings[]) => db.query(sql).get(...bindings) as R | null,
          all: <R>(sql: string, ...bindings: SQLQueryBindings[]) => db.query(sql).all(...bindings) as R[],
          run: () => { throw new Error("read_only_store"); },
        };
        return fn(tx);
      } finally { db.close(); }
    },
  } as ReadableStore;
}
