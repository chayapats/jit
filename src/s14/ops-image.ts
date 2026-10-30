import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { AppError } from "../errors";
import { containsCredential } from "../security/credentials";
import type { AppTransaction } from "../store";
import { s14ApplicationId, s14SchemaVersion, type S14Store } from "./store";
import { opsLimits, type ManagedBackupManifest } from "./ops-types";

const included = new Set(`
  installation memory_identity memory_sources memory_claims memory_access
  memory_access_history memory_shares memory_decisions memory_contexts
  parallel_settings web_reads external_evidence bot_lifecycle capability_proposals work_payload_deletions attempt_payload_deletions
  routines routine_occurrences routine_results attention_setting attention_decisions attention_notices
  bots conversations messages bot_proposals proposal_versions reply_outbox audit work_items
  work_grants grant_state grant_usage reports artifacts snapshot_shares work_defaults work_graphs work_steps
  native_intents work_checkpoints work_queue work_attempts attempt_usage work_results
  effects effect_versions bot_computers computer_operations computer_attempts
`.trim().split(/\s+/));
const excluded = new Set(`sessions login_throttle parallel_connections parallel_sessions command_receipts artifact_staging reply_transports attempt_transports input_leases computer_inputs
`.trim().split(/\s+/));

/** Hashes exact bounded component bytes, including binary images. */
export const opsHash = (bytes: Uint8Array | string): string => createHash("sha256").update(bytes).digest("hex");
/** Fingerprints all immutable schema objects so forged image triggers cannot run during quarantine. */
export function opsSchema(tx: AppTransaction): string {
  return opsHash(JSON.stringify(tx.all("SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name")));
}
/** Requires a readable, identity-matched independent ledger and returns its complete bounded logical position. */
export function opsLedger(tx: AppTransaction): string {
  const application = tx.get<{ id: string }>("SELECT id FROM main.memory_identity")?.id;
  if (!application || application !== tx.get<{ id: string }>("SELECT id FROM lifecycle.identity")?.id) throw new AppError("s14_lifecycle_ledger_unavailable", 503);
  const tables = ["identity", "withdrawals", "bot_events", "native_intents", "grant_usage", "routine_usage", "effect_outcomes"];
  const entries: unknown[] = [];
  let count = 0;
  for (const table of tables) {
    const rows = tx.all(`SELECT * FROM lifecycle.${table} ORDER BY rowid LIMIT ${opsLimits.rows + 1}`);
    count += rows.length;
    if (count > opsLimits.rows) throw new AppError("s14_ops_ledger_bound", 409);
    entries.push([table, rows]);
  }
  return opsHash(JSON.stringify(entries));
}
/** Verifies a SQLite image in memory before any writable open, rejecting unknown schemas, credentials and bounds. */
export function inspectOpsImage(bytes: Uint8Array, schemaHash: string): void {
  if (bytes.length > opsLimits.bytes || bytes.length < 100) throw new AppError("s14_ops_image_invalid", 409);
  const header = Buffer.from(bytes.buffer, bytes.byteOffset, 100);
  if (header.toString("ascii", 0, 16) !== "SQLite format 3\0" || header.readUInt32BE(68) !== s14ApplicationId || header.readUInt32BE(60) !== s14SchemaVersion) throw new AppError("s14_ops_version_unsupported", 409);
  const db = Database.deserialize(bytes);
  try {
    const objects = db.query("SELECT type,name,tbl_name,sql FROM main.sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all();
    if (opsHash(JSON.stringify(objects)) !== schemaHash || (db.query("PRAGMA integrity_check").get() as { integrity_check: string } | null)?.integrity_check !== "ok") throw new AppError("s14_ops_schema_invalid", 409);
    let rows = 0;
    for (const { name } of db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]) {
      if (!included.has(name) && !excluded.has(name) && name !== "owner") throw new AppError("s14_ops_unclassified_table", 409);
      if (!/^[a-z_]+$/.test(name)) throw new AppError("s14_ops_schema_invalid", 409);
      const count = (db.query(`SELECT count(*) n FROM ${name}`).get() as { n: number }).n;
      rows += count;
      if (rows > opsLimits.rows) throw new AppError("s14_ops_row_bound", 409);
      if (excluded.has(name) && count !== 0) throw new AppError("s14_ops_credential_excluded", 409);
      for (const row of db.query(`SELECT * FROM ${name}`).iterate()) for (const value of Object.values(row as Record<string, unknown>)) {
        const text = typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : "";
        if (containsCredential(text)) throw new AppError("s14_ops_credential_excluded", 409);
      }
    }
    const owner = db.query("SELECT password_hash,generation FROM owner").get() as { password_hash: string; generation: number } | null;
    if (owner && (owner.password_hash !== "[reconnect]" || owner.generation !== 0)) throw new AppError("s14_ops_credential_excluded", 409);
    if (rows > opsLimits.rows || db.query("PRAGMA foreign_key_check").get()) throw new AppError("s14_ops_image_invalid", 409);
  } finally { db.close(); }
}
/** Produces a freshly compacted allowlisted image with credentials, sessions and transient payloads excluded. */
export function credentialFreeImage(store: S14Store): Uint8Array {
  const source = store.snapshotBytes();
  if (source.length > opsLimits.bytes) throw new AppError("s14_ops_backup_too_large", 409);
  const db = Database.deserialize(source);
  try {
    db.exec("PRAGMA foreign_keys=OFF; PRAGMA secure_delete=ON; PRAGMA trusted_schema=OFF");
    const names = db.query("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[];
    for (const { name } of names) {
      if (excluded.has(name)) db.exec(`DELETE FROM ${name}`);
      else if (name === "owner") db.exec("UPDATE owner SET password_hash='[reconnect]',generation=0");
      else if (!included.has(name)) throw new AppError("s14_ops_unclassified_table", 409);
    }
    db.exec(`UPDATE parallel_settings SET record_json='{"id":"parallel","revision":1,"mode":"anonymous","connectionId":null,"billingAcknowledged":false}'`);
    for (const { name } of names) {
      for (const row of db.query(`SELECT * FROM ${name}`).iterate()) {
        for (const value of Object.values(row as Record<string, unknown>)) {
          const text = typeof value === "string" ? value : value instanceof Uint8Array ? Buffer.from(value).toString("utf8") : "";
          if (containsCredential(text)) throw new AppError("s14_ops_credential_excluded", 409);
        }
      }
    }
    db.exec("VACUUM");
    const bytes = db.serialize();
    inspectOpsImage(bytes, store.read(opsSchema));
    return bytes;
  } finally { db.close(); }
}
/** Records exact committed artifact bytes in the manifest; artifacts remain transactional inside the image. */
export function imageArtifacts(store: S14Store): ManagedBackupManifest["artifacts"] {
  return store.read(tx => tx.all<{ id: string; content: Uint8Array }>("SELECT id,content FROM artifacts WHERE content IS NOT NULL ORDER BY id").map(row => ({ id: row.id, size: row.content.length, sha256: opsHash(row.content) })));
}

/** Binds managed application state while allowing offline owner login and session rotation between commands. */
export function opsManagedHash(tx: Pick<AppTransaction, "all">): string {
  const hash = createHash("sha256");
  let count = 0;
  for (const { name } of tx.all<{ name: string }>("SELECT name FROM main.sqlite_master WHERE type='table' AND name NOT IN ('sessions','login_throttle') ORDER BY name")) {
    if (!/^[a-z_]+$/.test(name)) throw new AppError("s14_ops_schema_invalid", 409);
    hash.update(name);
    const rows = tx.all(`SELECT * FROM main.${name} ORDER BY rowid LIMIT ${opsLimits.rows + 1}`);
    count += rows.length;
    if (count > opsLimits.rows) throw new AppError("s14_ops_row_bound", 409);
    for (const row of rows) hash.update(JSON.stringify(row));
  }
  return hash.digest("hex");
}

/** Reads the bounded managed-state digest under a consistent application read transaction. */
export function opsLiveHash(store: S14Store): string { return store.read(opsManagedHash); }

/** Records hash-only append-ledger prefixes; an archive can verify continuity but cannot supply authority. */
export function opsLedgerPosition(store: S14Store): { table: string; count: number; digest: string }[] {
  return store.read(tx => ["withdrawals", "bot_events", "native_intents", "effect_outcomes"].map(table => {
    const rows = tx.all(`SELECT * FROM lifecycle.${table} ORDER BY rowid LIMIT ${opsLimits.rows + 1}`);
    if (rows.length > opsLimits.rows) throw new AppError("s14_ops_ledger_bound", 409);
    return { table, count: rows.length, digest: opsHash(JSON.stringify(rows)) };
  }));
}
/** Rejects an independent ledger older than the archived append-only position without importing any archived row. */
export function verifyOpsLedgerPosition(store: S14Store, position: { table: string; count: number; digest: string }[]): void {
  const tables = ["withdrawals", "bot_events", "native_intents", "effect_outcomes"];
  if (!Array.isArray(position) || position.length !== tables.length) throw new AppError("s14_ops_ledger_position_invalid", 409);
  store.read(tx => {
    for (const [index, entry] of position.entries()) {
      if (entry.table !== tables[index] || !Number.isSafeInteger(entry.count) || entry.count < 0 || entry.count > opsLimits.rows || !/^[a-f0-9]{64}$/.test(entry.digest)) throw new AppError("s14_ops_ledger_position_invalid", 409);
      const rows = tx.all(`SELECT * FROM lifecycle.${entry.table} ORDER BY rowid LIMIT ${entry.count}`);
      if (rows.length !== entry.count || opsHash(JSON.stringify(rows)) !== entry.digest) throw new AppError("s14_ops_current_ledger_incomplete", 503);
    }
  });
}
