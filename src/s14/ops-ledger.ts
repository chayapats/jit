import { Database, type SQLQueryBindings } from "bun:sqlite";
import { AppError } from "../errors";
import { opsLedger } from "./ops-image";
import type { S14Store } from "./store";

/** Commits only the exact validated quarantine ledger after durable owner activation intent; retries are idempotent. */
export function commitOpsLedger(store: S14Store, bytes: Uint8Array, prior: string, target: string): void {
  const staged = Database.deserialize(bytes);
  try {
    store.transaction(tx => {
      const current = opsLedger(tx);
      if (current === target) return;
      if (current !== prior) throw new AppError("s14_ops_live_or_ledger_changed", 409);
      for (const table of ["withdrawals", "bot_events", "native_intents", "effect_outcomes", "git_connection_revisions", "git_outcomes"]) {
        for (const row of staged.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, SQLQueryBindings>[]) {
          const values = Object.values(row);
          tx.run(`INSERT OR IGNORE INTO lifecycle.${table} VALUES (${values.map(() => "?").join(",")})`, ...values);
        }
      }
      for (const [table, key, columns] of [
        ["grant_usage", "grant_id", ["attempts", "steps", "calls", "output_bytes", "reads"]],
        ["routine_usage", "routine_id", ["consumed", "last_instant"]],
      ] as const) {
        for (const row of staged.query(`SELECT * FROM ${table} ORDER BY rowid`).all() as Record<string, SQLQueryBindings>[]) {
          const values = Object.values(row);
          tx.run(`INSERT INTO lifecycle.${table} VALUES (${values.map(() => "?").join(",")}) ON CONFLICT(${key}) DO UPDATE SET ${columns.map(column => `${column}=max(${column},excluded.${column})`).join(",")}`, ...values);
        }
      }
      if (opsLedger(tx) !== target) throw new AppError("s14_ops_ledger_changed", 503);
    });
  } finally { staged.close(); }
}
