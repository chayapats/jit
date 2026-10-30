import { Database } from "bun:sqlite";
import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../errors";
import { inspectS14Store } from "./store";

/** Holds an OS-backed exclusive SQLite transaction until release or process death; never unlinks the lock inode. */
export function acquireS14RuntimeLock(storePath: string): () => void {
  inspectS14Store(storePath); // No lock or writable SQLite open for legacy/unknown application stores.
  mkdirSync(dirname(storePath), { recursive: true, mode: 0o700 });
  const path = `${storePath}.runtime-lock.sqlite`;
  try { closeSync(openSync(path, "wx", 0o600)); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  const db = new Database(path, { create: false, strict: true });
  try {
    // Let concurrent pager lock upgrades settle; a live owner still refuses within one second.
    db.exec("PRAGMA busy_timeout=1000; BEGIN EXCLUSIVE");
  } catch (e) {
    db.close();
    if ((e as { code?: string }).code === "SQLITE_BUSY") throw new AppError("s14_runtime_already_open", 409);
    throw e;
  }
  let held = true;
  return () => { if (held) { held = false; db.close(); } };
}
