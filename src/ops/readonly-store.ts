import { Database, type SQLQueryBindings } from "bun:sqlite";
import { existsSync, statSync } from "node:fs";
import type { AppTransaction } from "../store";
import type { ReadableStore } from "./lifecycle";

/**
 * Read-only view of an installation database for status and preflight
 * (ops.service_package/v1). Opens SQLite with `readonly: true, create:
 * false`, so inspection never creates, migrates, journals, checkpoints or
 * chmods the installation; `run` always throws. Returns null when no
 * database exists. Each `read` opens and closes its own connection.
 */
export function openReadOnlyStore(path: string): ReadableStore | null {
  try { if (!existsSync(path) || !statSync(path).isFile() || statSync(path).size === 0) return null; } catch { return null; }
  return {
    path,
    read<T>(fn: (tx: AppTransaction) => T): T {
      // A live WAL writer leaves -wal/-shm: a plain read-only connection shares them. Without them no
      // writer is attached, and `immutable=1` reads the file without creating a WAL index or journal.
      const live = existsSync(`${path}-wal`) && existsSync(`${path}-shm`);
      const db = live ? new Database(path, { readonly: true, create: false, strict: true })
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
