import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { AppError } from "../errors";
import type { AppTransaction, TransactionStore } from "../store";
import { writeFileAtomic } from "./upgrade-fence";

/**
 * app.deletion_ledger/v1 — installation lifecycle ledger and its independent
 * checkpoint (OPS02, issue #33). See docs/contracts/data-lifecycle-v1.md.
 *
 * The ledger is the append-only `lifecycle_ledger` table (schema 23). SQLite
 * triggers append one identity-only entry for every committed deletion
 * tombstone (`deletion_ledger`), owner forget (`memory_suppressions`) and
 * suppressed claim/source lineage, inside the same transaction as that commit.
 * The table is installation-scoped: backup images exclude it and every
 * activation (`TransactionStore.swapFrom`) keeps the live rows, so restoring a
 * backup can never roll back current tombstones or suppressions.
 *
 * The checkpoint file (`jit.deletion.ledger/v1`, default
 * `<db>.lifecycle-ledger.json`, service `ledgerPath`) is an independent,
 * atomically replaced copy of the ledger with a SHA-256 digest. It is written
 * after lifecycle commits, at boot and by every restore step. A ledger is
 * trusted only when the table is readable and the checkpoint is a verified
 * prefix of it; a missing (after first establishment), unverifiable,
 * incompatible or diverged checkpoint is untrusted and keeps a restore
 * quarantined. Nothing here can be overridden by an owner acknowledgment.
 */
export const lifecycleLedgerContract = "app.deletion_ledger/v1" as const;
/** Checkpoint file format (also the format the service preflight gate recognizes). */
export const ledgerCheckpointFormat = "jit.deletion.ledger/v1" as const;
/** Upper bound on ledger entries read for a checkpoint or restore; above it everything fails closed. */
export const lifecycleLedgerLimit = 200_000;

export type LifecycleEntryKind = "deletion" | "suppression" | "suppressed_claim" | "suppressed_source";

/** One identity-only ledger entry. `record` never holds payload text, reasons or credentials. */
export interface LifecycleLedgerEntry {
  sequence: number; kind: LifecycleEntryKind; key: string; subject: string; projectId: string;
  record: Record<string, unknown>; recordedAt: number;
}

/** Deletion entry record (mirrors one `deletion_ledger` row). */
export interface LedgerDeletion {
  id: string; operationId: string; projectId: string; kind: "source" | "claim";
  sourceId: string | null; claimId: string | null; revision: number; generation: number; deletedAt: number;
}
/** Suppression entry record (identity of one owner forget; reason and overlaps are never recorded). */
export interface LedgerSuppression { id: string; projectId: string; claimId: string; fromRevision: number; fromGeneration: number; createdAt: number }
export interface LedgerSuppressedClaim { suppressionId: string; projectId: string; claimId: string }
export interface LedgerSuppressedSource { suppressionId: string; projectId: string; sourceId: string; revision: number; generation: number }

/** Persisted checkpoint file. `revision` is `count + 1` (the placeholder seed is revision 1 with no digest). */
export interface LedgerCheckpointFile {
  ledger: typeof ledgerCheckpointFormat; contract: typeof lifecycleLedgerContract;
  revision: number; head: number; count: number; digest: string; writtenAt: number;
  entries: { sequence: number; kind: LifecycleEntryKind; key: string; subject: string; projectId: string; record: Record<string, unknown>; recordedAt: number }[];
}

export type LedgerUntrustedReason =
  | "ledger_unreadable" | "ledger_bound_exceeded" | "ledger_checkpoint_missing" | "ledger_checkpoint_unverifiable"
  | "ledger_checkpoint_incompatible" | "ledger_checkpoint_mismatch" | "ledger_checkpoint_unavailable";

/** Result of resolving the latest trusted lifecycle ledger. */
export type TrustedLedger =
  | { state: "trusted"; head: number; count: number; digest: string; entries: LifecycleLedgerEntry[]; writtenAt: number; established: boolean }
  | { state: "untrusted"; reason: LedgerUntrustedReason; nextAction: string; head: number | null; count: number | null };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const kinds = new Set<LifecycleEntryKind>(["deletion", "suppression", "suppressed_claim", "suppressed_source"]);

/** Default checkpoint location for one installation database. */
export function ledgerCheckpointPathFor(databasePath: string): string {
  return `${databasePath}.lifecycle-ledger.json`;
}

/** Reads every ledger entry in commit order. Throws `deletion_ledger_unavailable` or `ledger_bound_exceeded`. */
export function readLifecycleLedger(tx: AppTransaction): LifecycleLedgerEntry[] {
  let rows: { sequence: number; kind: LifecycleEntryKind; entry_key: string; subject: string; project_id: string; record_json: string; recorded_at: number }[];
  try {
    const count = tx.get<{ n: number }>("SELECT count(*) AS n FROM lifecycle_ledger")!.n;
    if (count > lifecycleLedgerLimit) throw new AppError("ledger_bound_exceeded", 409);
    rows = tx.all("SELECT sequence, kind, entry_key, subject, project_id, record_json, recorded_at FROM lifecycle_ledger ORDER BY sequence");
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("deletion_ledger_unavailable", 503);
  }
  return rows.map(row => {
    let record: unknown;
    try { record = JSON.parse(row.record_json); } catch { throw new AppError("deletion_ledger_unavailable", 503); }
    if (!record || typeof record !== "object" || Array.isArray(record) || !kinds.has(row.kind)) throw new AppError("deletion_ledger_unavailable", 503);
    return { sequence: row.sequence, kind: row.kind, key: row.entry_key, subject: row.subject, projectId: row.project_id,
      record: record as Record<string, unknown>, recordedAt: row.recorded_at };
  });
}

/** Canonical digest of entries in sequence order (the checkpoint identity). */
export function ledgerDigest(entries: readonly Pick<LifecycleLedgerEntry, "sequence" | "kind" | "key" | "subject" | "projectId" | "record">[]): string {
  return sha256(entries.map(e => JSON.stringify([e.sequence, e.kind, e.key, e.subject, e.projectId, e.record])).join("\n"));
}

type FileRead = { state: "missing" } | { state: "placeholder" } | { state: "corrupt" } | { state: "incompatible" } | { state: "valid"; file: LedgerCheckpointFile };

function readCheckpoint(path: string): FileRead {
  if (!existsSync(path)) return { state: "missing" };
  let parsed: Partial<LedgerCheckpointFile> & Record<string, unknown>;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { return { state: "corrupt" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { state: "corrupt" };
  if (typeof parsed.ledger === "string" && parsed.ledger !== ledgerCheckpointFormat) return { state: "incompatible" };
  if (parsed.ledger !== ledgerCheckpointFormat) return { state: "corrupt" };
  // Seed written by service packaging before the first boot: carries no ledger content.
  if (!("digest" in parsed) && !("entries" in parsed)) return Number.isSafeInteger(parsed.revision) ? { state: "placeholder" } : { state: "corrupt" };
  if (parsed.contract !== lifecycleLedgerContract) return { state: "incompatible" };
  const entries = parsed.entries;
  if (!Array.isArray(entries) || entries.length > lifecycleLedgerLimit || !Number.isSafeInteger(parsed.head) || !Number.isSafeInteger(parsed.count) ||
      typeof parsed.digest !== "string" || parsed.count !== entries.length || parsed.revision !== entries.length + 1) return { state: "corrupt" };
  let previous = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || !Number.isSafeInteger(entry.sequence) || entry.sequence <= previous || !kinds.has(entry.kind) ||
        typeof entry.key !== "string" || typeof entry.subject !== "string" || typeof entry.projectId !== "string" ||
        !entry.record || typeof entry.record !== "object" || Array.isArray(entry.record)) return { state: "corrupt" };
    previous = entry.sequence;
  }
  if ((entries.at(-1)?.sequence ?? 0) > (parsed.head as number) || ledgerDigest(entries) !== parsed.digest) return { state: "corrupt" };
  return { state: "valid", file: parsed as LedgerCheckpointFile };
}

function untrusted(reason: LedgerUntrustedReason, head: number | null = null, count: number | null = null): TrustedLedger {
  const nextAction = reason === "ledger_checkpoint_missing" ? "restore_the_ledger_checkpoint_file_from_its_configured_location_then_retry"
    : reason === "ledger_checkpoint_mismatch" ? "inspect_installation_database_and_ledger_checkpoint_then_retry"
      : reason === "ledger_unreadable" ? "inspect_installation_lifecycle_ledger"
        : reason === "ledger_bound_exceeded" ? "ledger_exceeds_supported_bound_manual_recovery_required"
          : reason === "ledger_checkpoint_unavailable" ? "check_ledger_checkpoint_storage_then_retry"
            : "replace_the_unverifiable_ledger_checkpoint_with_a_verified_copy_then_retry";
  return { state: "untrusted", reason, nextAction, head, count };
}

/**
 * Resolves the latest trusted lifecycle ledger and brings its checkpoint up to
 * date. Rules (fail closed, never overridable):
 *
 * - The table must be readable and within bounds.
 * - No checkpoint file and no recorded establishment: the ledger is established
 *   now (first boot or first use after the schema 23 upgrade) and written.
 *   A placeholder seed (`{ledger, revision}` only) is treated the same way.
 * - No checkpoint file after establishment: `ledger_checkpoint_missing`.
 * - Unparseable, self-inconsistent or wrong-contract file: `..._unverifiable` /
 *   `..._incompatible`.
 * - A valid checkpoint must be a verified prefix of the table (same entries up
 *   to its head); a checkpoint ahead of or diverging from the table means the
 *   installation database was replaced outside the restore flow:
 *   `ledger_checkpoint_mismatch`. A checkpoint that lags (crash between commit
 *   and file write) is extended.
 */
export function syncLedgerCheckpoint(store: TransactionStore, path: string, now: number, options: { write?: boolean } = {}): TrustedLedger {
  const write = options.write !== false;
  let state: { entries: LifecycleLedgerEntry[]; marker: { head: number; count: number; digest: string; written_at: number; path: string } | null };
  try {
    state = store.read(tx => ({
      entries: readLifecycleLedger(tx),
      marker: tx.get<{ head: number; count: number; digest: string; written_at: number; path: string }>("SELECT head, count, digest, written_at, path FROM lifecycle_checkpoint WHERE id = 1"),
    }));
  } catch (error) {
    return untrusted(error instanceof AppError && error.code === "ledger_bound_exceeded" ? "ledger_bound_exceeded" : "ledger_unreadable");
  }
  const { entries, marker } = state;
  const head = entries.at(-1)?.sequence ?? 0;
  const digest = ledgerDigest(entries);
  if (marker) {
    // The marker lives in the same database: it proves the table did not lose entries it already checkpointed.
    const prefix = entries.filter(e => e.sequence <= marker.head);
    if (prefix.length !== marker.count || ledgerDigest(prefix) !== marker.digest) return untrusted("ledger_checkpoint_mismatch", head, entries.length);
  }
  const read = readCheckpoint(path);
  let established = false;
  if (read.state === "missing" || read.state === "placeholder") {
    // Only a checkpoint already established at this location can go missing; a new location (or the first
    // use after the schema 23 upgrade) is established from the verified installation ledger.
    if (marker && marker.path === path) return untrusted(read.state === "missing" ? "ledger_checkpoint_missing" : "ledger_checkpoint_unverifiable", head, entries.length);
    established = true;
  } else if (read.state === "corrupt") return untrusted("ledger_checkpoint_unverifiable", head, entries.length);
  else if (read.state === "incompatible") return untrusted("ledger_checkpoint_incompatible", head, entries.length);
  else {
    const file = read.file;
    const prefix = entries.filter(e => e.sequence <= file.head);
    if (file.head > head || prefix.length !== file.count || ledgerDigest(prefix) !== file.digest) return untrusted("ledger_checkpoint_mismatch", head, entries.length);
    if (file.head === head && file.count === entries.length) {
      if (write && (!marker || marker.head !== head || marker.path !== path)) recordMarker(store, path, head, entries.length, digest, file.writtenAt);
      return { state: "trusted", head, count: entries.length, digest, entries, writtenAt: file.writtenAt, established: false };
    }
  }
  if (!write) return { state: "trusted", head, count: entries.length, digest, entries, writtenAt: now, established };
  const body: LedgerCheckpointFile = { ledger: ledgerCheckpointFormat, contract: lifecycleLedgerContract, revision: entries.length + 1,
    head, count: entries.length, digest, writtenAt: now,
    entries: entries.map(e => ({ sequence: e.sequence, kind: e.kind, key: e.key, subject: e.subject, projectId: e.projectId, record: e.record, recordedAt: e.recordedAt })) };
  try { writeFileAtomic(path, JSON.stringify(body)); }
  catch { return untrusted("ledger_checkpoint_unavailable", head, entries.length); }
  try { recordMarker(store, path, head, entries.length, digest, now); }
  catch { return untrusted("ledger_unreadable", head, entries.length); }
  return { state: "trusted", head, count: entries.length, digest, entries, writtenAt: now, established };
}

function recordMarker(store: TransactionStore, path: string, head: number, count: number, digest: string, writtenAt: number): void {
  store.transaction(tx => tx.run(`INSERT INTO lifecycle_checkpoint (id, head, count, digest, written_at, path) VALUES (1, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET head = excluded.head, count = excluded.count, digest = excluded.digest, written_at = excluded.written_at, path = excluded.path`,
  head, count, digest, writtenAt, path));
}

/** Typed views over ledger entries for replay and coverage checks. */
export function ledgerView(entries: readonly LifecycleLedgerEntry[]) {
  const pick = <T>(kind: LifecycleEntryKind) => entries.filter(e => e.kind === kind).map(e => e.record as unknown as T);
  return {
    deletions: pick<LedgerDeletion>("deletion"),
    suppressions: pick<LedgerSuppression>("suppression"),
    suppressedClaims: pick<LedgerSuppressedClaim>("suppressed_claim"),
    suppressedSources: pick<LedgerSuppressedSource>("suppressed_source"),
  };
}
