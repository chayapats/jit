import { Database } from "bun:sqlite";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync } from "node:fs";
import { dirname } from "node:path";
import { AppError } from "../../errors";
import { canonical, identity } from "./validation";
import type { ConversationEvent, ConversationEvidence, ConversationRequest } from "./types";

const applicationId = 0x4a495435;
/**
 * Fresh opt-in protected conversation journal, outside guest/native/recovery images. Never opens an
 * S14/legacy database for writing. One OS-backed process lock makes boot recovery exclusive; receipts,
 * queues, claims, evidence and events share synchronous FULL SQLite transactions. No migration/import.
 */
export class ConversationStore {
  readonly db!: Database;
  #lock: Database;
  #closed = false;
  constructor(readonly path: string, installationId: string, create = false) {
    identity(installationId);
    const existing = existsSync(path);
    if (existing) {
      const stat = lstatSync(path);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new AppError("conversation_store_incompatible", 409);
      const header = Buffer.alloc(100), fd = openSync(path, "r");
      let length: number;
      try { length = readSync(fd, header, 0, 100, 0); } finally { closeSync(fd); }
      if (length < 100 || header.toString("ascii", 0, 16) !== "SQLite format 3\0" || header.readUInt32BE(68) !== applicationId || header.readUInt32BE(60) !== 1) throw new AppError("conversation_store_incompatible", 409);
    } else if (!create) throw new AppError("continuity_unavailable", 503);
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const lockPath = `${path}.runtime-lock.sqlite`;
    if (existsSync(lockPath) && lstatSync(lockPath).isSymbolicLink()) throw new AppError("continuity_unavailable", 503);
    try { closeSync(openSync(lockPath, "wx", 0o600)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    this.#lock = new Database(lockPath, { create: false, strict: true });
    try { this.#lock.exec("PRAGMA busy_timeout=10; BEGIN EXCLUSIVE"); }
    catch { this.#lock.close(); throw new AppError("conversation_runtime_already_open", 409); }
    try {
      if (!existing) closeSync(openSync(path, "wx", 0o600));
      this.db = new Database(path, { create: false, strict: true });
      this.db.exec("PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=2000; PRAGMA secure_delete=ON");
      if (!existing) this.db.transaction(() => {
        this.db.exec(`PRAGMA application_id=${applicationId}; PRAGMA user_version=1;
          CREATE TABLE identity (id TEXT PRIMARY KEY);
          CREATE TABLE requests (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, state TEXT NOT NULL, record_json TEXT NOT NULL);
          CREATE TABLE commands (id TEXT PRIMARY KEY, payload_hash TEXT NOT NULL, root_id TEXT NOT NULL REFERENCES requests(id), receipt_json TEXT NOT NULL, command_json TEXT NOT NULL);
          CREATE TABLE events (sequence INTEGER PRIMARY KEY AUTOINCREMENT, request_id TEXT NOT NULL REFERENCES requests(id), conversation_id TEXT NOT NULL, at INTEGER NOT NULL, kind TEXT NOT NULL, code TEXT);
          CREATE INDEX conversation_events ON events(conversation_id,sequence);
          CREATE TABLE tool_calls (id TEXT PRIMARY KEY, request_id TEXT NOT NULL REFERENCES requests(id), tool TEXT NOT NULL, input_hash TEXT NOT NULL, state TEXT NOT NULL, evidence_json TEXT);
          CREATE TABLE native_sessions (request_id TEXT NOT NULL REFERENCES requests(id), phase TEXT NOT NULL, session_id TEXT NOT NULL, branch_id TEXT NOT NULL, PRIMARY KEY(request_id,phase));
          CREATE TRIGGER immutable_command_update BEFORE UPDATE ON commands BEGIN SELECT RAISE(ABORT,'immutable_command'); END;
          CREATE TRIGGER immutable_command_delete BEFORE DELETE ON commands BEGIN SELECT RAISE(ABORT,'immutable_command'); END;
          CREATE TRIGGER immutable_event_update BEFORE UPDATE ON events BEGIN SELECT RAISE(ABORT,'immutable_event'); END;
          CREATE TRIGGER immutable_event_delete BEFORE DELETE ON events BEGIN SELECT RAISE(ABORT,'immutable_event'); END;
        `);
        this.db.query("INSERT INTO identity VALUES (?)").run(installationId);
      }).immediate();
      if (this.db.query<{ id: string }, []>("SELECT id FROM identity").get()?.id !== installationId) throw new AppError("continuity_unavailable", 503);
    } catch (error) { this.db!?.close(); this.#lock.close(); throw error; }
  }
  /** Synchronous writer boundary; no model, tool or async callback is permitted inside it. */
  transaction<T>(action: () => T): T { return this.db.transaction(action).immediate(); }
  /** Reads one exact retained request; absence never creates a new authority or queue. */
  request(requestId: string): ConversationRequest {
    identity(requestId);
    const row = this.db.query<{ record_json: string }, [string]>("SELECT record_json FROM requests WHERE id=?").get(requestId);
    if (!row) throw new AppError("not_found", 404);
    return JSON.parse(row.record_json) as ConversationRequest;
  }
  /** Saves a validated service-owned lifecycle projection within the caller's transaction. */
  save(request: ConversationRequest): void { this.db.query("UPDATE requests SET state=?,record_json=? WHERE id=?").run(request.state, canonical(request), request.receipt.rootRequestId); }
  /** Appends safe control metadata only; model deltas and raw errors never enter this journal. */
  event(request: ConversationRequest, kind: ConversationEvent["kind"], at: number, code: string | null = null): void {
    this.db.query("INSERT INTO events(request_id,conversation_id,at,kind,code) VALUES (?,?,?,?,?)").run(request.receipt.rootRequestId, request.receipt.conversationId, at, kind, code);
  }
  /** Evidence comes exclusively from the tool wrapper after an actual invocation returned. */
  evidence(requestId: string): ConversationEvidence[] { return this.db.query<{ evidence_json: string }, [string]>("SELECT evidence_json FROM tool_calls WHERE request_id=? AND evidence_json IS NOT NULL ORDER BY rowid").all(requestId).map(row => JSON.parse(row.evidence_json) as ConversationEvidence); }
  /** Finite custody refuses new ingress without evicting dedupe identities or claims. */
  capacity(): void {
    const count = this.db.query<{ n: number }, []>("SELECT count(*) AS n FROM commands").get()!.n;
    // Include all admitted future output: queued work cannot overrun custody after ingress has passed.
    const bytes = this.db.query<{ n: number }, []>(`SELECT
      (SELECT coalesce(sum(length(CAST(record_json AS BLOB)) + coalesce(json_extract(record_json,'$.authority.limits.outputBytes'),0)*2),0) FROM requests)
      + (SELECT coalesce(sum(length(CAST(command_json AS BLOB))+length(CAST(receipt_json AS BLOB))),0) FROM commands)
      + (SELECT coalesce(sum(length(CAST(evidence_json AS BLOB))),0) FROM tool_calls) AS n`).get()!.n;
    if (count >= 10000 || bytes + 262144 >= 64 * 1024 * 1024) throw new AppError("continuity_capacity", 409);
  }
  /** Close only after application shutdown has awaited its active Schway/tool calls. */
  close(): void { if (!this.#closed) { this.#closed = true; this.db.close(); this.#lock.close(); } }
}
