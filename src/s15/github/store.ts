import { Database } from "bun:sqlite";
import { closeSync, existsSync, lstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import { canonical, fail, identity } from "./validation";

const appId = 0x4a473135;
/** Protected current GitHub continuity, separate from S14, guest disks and native snapshots. One process owns recovery. */
export class GithubStore {
  /** Original invocation guards stay process-local and are never restored from ledger JSON. */
  readonly dispatchGuards = new Map<string, () => void>();
  private readonly db: Database;
  private readonly lock: Database;
  constructor(path: string, installationId: string, create: boolean) {
    identity(installationId); if (!isAbsolute(path)) fail("protected_ledger_path_required");
    if (create) { closeSync(openSync(path, "wx", 0o600)); }
    else {
      if (!existsSync(path)) fail("continuity_unavailable");
      const s = lstatSync(path); if (!s.isFile() || s.isSymbolicLink() || (s.mode & 0o077) !== 0) fail("unprotected_ledger");
      const header = Buffer.alloc(100), fd = openSync(path, "r"); let n: number;
      try { n = readSync(fd, header, 0, 100, 0); } finally { closeSync(fd); }
      if (n !== 100 || header.toString("ascii", 0, 16) !== "SQLite format 3\0" || header.readUInt32BE(68) !== appId || header.readUInt32BE(60) !== 1) fail("github_store_incompatible");
    }
    const lockPath = `${path}.runtime-lock.sqlite`;
    if (existsSync(lockPath) && (lstatSync(lockPath).isSymbolicLink() || (lstatSync(lockPath).mode & 0o077) !== 0)) fail("unprotected_ledger");
    try { closeSync(openSync(lockPath, "wx", 0o600)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
    this.lock = new Database(lockPath, { strict: true, create: false });
    try { this.lock.exec("PRAGMA busy_timeout=10; BEGIN EXCLUSIVE"); } catch { this.lock.close(); fail("github_runtime_already_open"); }
    this.db = new Database(path, { strict: true, create: false });
    try {
      this.db.exec("PRAGMA synchronous=FULL; PRAGMA secure_delete=ON; PRAGMA busy_timeout=2000");
      if (create) this.tx(() => { this.db.exec(`PRAGMA application_id=${appId}; PRAGMA user_version=1;
        CREATE TABLE identity (id TEXT PRIMARY KEY);
        CREATE TABLE records (kind TEXT NOT NULL,id TEXT NOT NULL,json TEXT NOT NULL,PRIMARY KEY(kind,id));
        CREATE TABLE receipts (id TEXT PRIMARY KEY,hash TEXT NOT NULL,json TEXT NOT NULL);
      `); this.db.query("INSERT INTO identity VALUES (?)").run(installationId); });
      if (this.db.query<{ id: string }, []>("SELECT id FROM identity").get()?.id !== installationId) fail("continuity_unavailable");
      this.tx(() => {
        for (const row of this.all<{ id: string; state: string }>("selection")) if (row.state === "implementing") this.put("selection", row.id, { ...row, state: "reconcile_only" });
        for (const row of this.all<{ id: string; state: string }>("babysit")) if (row.state === "remediating") this.put("babysit", row.id, { ...row, state: "reconcile_only", reasons: ["github_attempt_interrupted"] });
      });
    } catch (error) { this.db.close(); this.lock.close(); throw error; }
  }
  tx<T>(fn: () => T): T { return this.db.transaction(fn).immediate(); }
  get<T>(kind: string, id: string): T | null { const r = this.db.query<{ json: string }, [string, string]>("SELECT json FROM records WHERE kind=? AND id=?").get(kind, id); return r ? JSON.parse(r.json) as T : null; }
  all<T>(kind: string): T[] { return this.db.query<{ json: string }, [string]>("SELECT json FROM records WHERE kind=? ORDER BY id").all(kind).map(r => JSON.parse(r.json) as T); }
  put(kind: string, id: string, value: unknown): void {
    const json = canonical(value); if (Buffer.byteLength(json) > 1024 * 1024) fail("github_custody_limit");
    const total = this.db.query<{ n: number }, []>("SELECT coalesce(sum(length(CAST(json AS BLOB))),0) AS n FROM records").get()!.n;
    if (total + Buffer.byteLength(json) > 64 * 1024 * 1024) fail("github_custody_limit");
    this.db.query("INSERT INTO records VALUES (?,?,?) ON CONFLICT(kind,id) DO UPDATE SET json=excluded.json").run(kind, id, json);
  }
  receipt<T>(id: string, hash: string): T | null {
    const r = this.db.query<{ hash: string; json: string }, [string]>("SELECT hash,json FROM receipts WHERE id=?").get(id);
    if (r && r.hash !== hash) fail("request_id_conflict"); return r ? JSON.parse(r.json) as T : null;
  }
  commitReceipt(id: string, hash: string, value: unknown): void { this.db.query("INSERT INTO receipts VALUES (?,?,?)").run(id, hash, canonical(value)); }
  close(): void { this.db.close(); this.lock.close(); }
}
