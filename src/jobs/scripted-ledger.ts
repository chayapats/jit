import { Database } from "bun:sqlite";
import { chmodSync } from "node:fs";
import type { NativeRunInspection } from "../team/run-port";

/** Fixture-only second store simulates native appends; this is not Schway's session format or implementation. */
export class ScriptedNativeLedger {
  constructor(readonly path: string) {}
  #use<T>(fn: (db: Database) => T): T {
    const db = new Database(this.path, { create: true, strict: true });
    try {
      chmodSync(this.path, 0o600);
      db.exec("PRAGMA busy_timeout = 2000; PRAGMA synchronous = FULL; CREATE TABLE IF NOT EXISTS runs (sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, record_json TEXT NOT NULL); CREATE TABLE IF NOT EXISTS contexts (id TEXT NOT NULL, generation INTEGER NOT NULL, state TEXT NOT NULL, PRIMARY KEY(id, generation))");
      return fn(db);
    } finally { db.close(); }
  }
  /** Appends/updates only fixture lifecycle evidence, never canonical output or an application obligation. */
  put(run: NativeRunInspection): void {
    this.#use(db => db.transaction(() => {
      const prior = db.query("SELECT record_json FROM runs WHERE id = ?").get(run.runId) as { record_json: string } | null;
      if (prior) { const previous = JSON.parse(prior.record_json) as NativeRunInspection; if (previous.contextState !== "active") run = { ...run, contextState: previous.contextState }; }
      db.query("INSERT INTO runs (id, record_json) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET record_json = excluded.record_json").run(run.runId, JSON.stringify(run));
    }).immediate());
  }
  /** Reads bounded ordered fixture native evidence independently of the app transaction. */
  page(after = 0): { items: NativeRunInspection[]; nextAfter: number | null } {
    return this.#use(db => {
      const rows = db.query("SELECT sequence, record_json FROM runs WHERE sequence > ? ORDER BY sequence LIMIT 101").all(after) as { sequence: number; record_json: string }[];
      return { items: rows.slice(0, 100).map(r => JSON.parse(r.record_json)), nextAfter: rows.length > 100 ? rows[99]!.sequence : null };
    });
  }
  /** Native retirement tombstones are independent of the app database, including contexts retired before dispatch. */
  contextState(context: { id: string; generation: number }): NativeRunInspection["contextState"] | null {
    return this.#use(db => (db.query("SELECT state FROM contexts WHERE id = ? AND generation = ?").get(context.id, context.generation) as { state: NativeRunInspection["contextState"] } | null)?.state ?? null);
  }
  /** Finds orphan native contexts without requiring a matching app record. */
  hasContext(context: { id: string; generation: number }): boolean {
    return this.contextState(context) !== null || this.#use(db => (db.query("SELECT record_json FROM runs").all() as { record_json: string }[]).some(row => {
      const run = JSON.parse(row.record_json) as NativeRunInspection;
      return run.context.id === context.id && run.context.generation === context.generation;
    }));
  }
  /** Records replay retirement/deletion for every fixture session owning this exact context generation. */
  context(context: { id: string; generation: number }, state: NativeRunInspection["contextState"]): void {
    this.#use(db => db.transaction(() => {
      const prior = db.query("SELECT state FROM contexts WHERE id = ? AND generation = ?").get(context.id, context.generation) as { state: string } | null;
      if (prior?.state === "deleted") state = "deleted";
      db.query("INSERT INTO contexts VALUES (?, ?, ?) ON CONFLICT(id, generation) DO UPDATE SET state = excluded.state").run(context.id, context.generation, state);
      for (const row of db.query("SELECT id, record_json FROM runs").all() as { id: string; record_json: string }[]) {
        const run = JSON.parse(row.record_json) as NativeRunInspection;
        if (run.context.id === context.id && run.context.generation === context.generation) {
          run.contextState = state; db.query("UPDATE runs SET record_json = ? WHERE id = ?").run(JSON.stringify(run), row.id);
        }
      }
    }).immediate());
  }
}
