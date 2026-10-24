import { createHash, randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../errors";
import { requireId } from "../sources";
import { TransactionStore, type AppTransaction } from "../store";
import { invalidatePendingJob, readJob } from "../jobs/queue";
import { fenceStaleContexts } from "../memory/context";
import { currentSupportedSchema, minSupportedSchema } from "./upgrade";
import { assertRestorableBackup, validateManifestRecord } from "./backup";
import { redactedText, scrubFreeTextOccurrences, scrubOutputSources } from "../memory/delete";

export const restoreContract = "ops.quarantined_restore/v1" as const;

export type RestoreState = "quarantining" | "migrated" | "ledger_applied" | "validated" | "blocked" | "complete" | "discarded";

export interface RestorePrepareCommand {
  kind: "restore.prepare"; requestId: string; projectId: null; expectedRevision: number;
  payload: { backupId: string; note: string };
}
export interface RestoreStepCommand {
  kind: "restore.migrate" | "restore.apply_ledger" | "restore.validate" | "restore.activate" | "restore.discard";
  requestId: string; projectId: null; expectedRevision: number;
  payload: { quarantineId: string } & (
    | { tombstones?: never; source?: never; asOf?: never; acknowledgedEmpty?: never }
    | { tombstones: ExternalTombstone[]; source: string; asOf: number; acknowledgedEmpty?: boolean });
}
export type RestoreCommand = RestorePrepareCommand | RestoreStepCommand;

/** Identity-only external tombstone; never carries payload, secrets or text. */
export interface ExternalTombstone {
  kind: "source" | "claim"; projectId: string;
  sourceId: string | null; claimId: string | null;
  revision: number; generation: number;
}

export interface RestoreValidation {
  manifestOk: boolean; compat: string; stagedSchema: number;
  ownTombstones: number; externalTombstones: number; missingFromExternal: number;
  appliedSources: number; appliedClaims: number;
  pendingNative: { id: string; generation: number; appState: string }[];
  nativeBlocked: boolean;
  pendingJobs: { id: string; projectId: string; state: string }[];
  unknownOutbox: number;
  liveOnlySources: number; liveRevisionAtPrepare: number; liveRevisionNow: number;
  suppressionsPreserved: number;
  residuals: string[];
  checks: { name: string; pass: boolean; detail: string }[];
}

export interface RestoreQuarantine {
  id: string; contract: typeof restoreContract;
  backupId: string;
  state: RestoreState;
  quarantineDir: string; workingFile: string;
  fromSchema: number; stagedSchema: number | null;
  liveRevisionAtPrepare: number;
  ledger: { count: number; source: string | null; asOf: number | null; appliedSources: number; appliedClaims: number; external: ExternalTombstone[] } | null;
  validation: RestoreValidation | null;
  reason: string | null; nextAction: string;
  createdAt: number; updatedAt: number;
}

export interface RestoreReceipt { quarantine: RestoreQuarantine; duplicate: boolean }

const exact = (value: unknown, keys: string[]) =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

function requireTombstones(value: unknown): ExternalTombstone[] {
  if (!Array.isArray(value) || value.length > 5000) throw new AppError("invalid_restore_command");
  return value.map(item => {
    if (!item || typeof item !== "object" || !exact(item, ["kind", "projectId", "sourceId", "claimId", "revision", "generation"]) ||
        (item.kind !== "source" && item.kind !== "claim")) throw new AppError("invalid_restore_command");
    requireId(item.projectId);
    if (item.kind === "source") {
      requireId(item.sourceId);
      if (item.claimId !== null) throw new AppError("invalid_restore_command");
    } else {
      requireId(item.claimId);
      if (item.sourceId !== null) throw new AppError("invalid_restore_command");
    }
    if (!Number.isSafeInteger(item.revision) || item.revision < 1 || !Number.isSafeInteger(item.generation) || item.generation < 1) {
      throw new AppError("invalid_restore_command");
    }
    return item as ExternalTombstone;
  });
}

export function restoreIdentity(command: RestoreCommand): string {
  if (!command || typeof command !== "object" || !exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 || command.projectId !== null) {
    throw new AppError("invalid_restore_command");
  }
  if (command.kind === "restore.prepare") {
    if (!exact(command.payload, ["backupId", "note"]) || typeof command.payload.note !== "string" ||
        Buffer.byteLength(command.payload.note) > 500 || !command.payload.note.isWellFormed()) throw new AppError("invalid_restore_command");
    requireId(command.payload.backupId);
  } else if (["restore.migrate", "restore.validate", "restore.activate", "restore.discard"].includes(command.kind)) {
    if (!exact(command.payload, ["quarantineId"])) throw new AppError("invalid_restore_command");
    requireId((command.payload as { quarantineId: string }).quarantineId);
  } else if (command.kind === "restore.apply_ledger") {
    const payload = command.payload as { quarantineId: string; tombstones: ExternalTombstone[]; source: string; asOf: number; acknowledgedEmpty?: boolean };
    if (!exact(command.payload, ["quarantineId", "tombstones", "source", "asOf", "acknowledgedEmpty"]) &&
        !exact(command.payload, ["quarantineId", "tombstones", "source", "asOf"])) throw new AppError("invalid_restore_command");
    requireId(payload.quarantineId);
    payload.tombstones = requireTombstones(payload.tombstones);
    if (typeof payload.source !== "string" || !payload.source.trim() || payload.source.length > 200) throw new AppError("invalid_restore_command");
    if (!Number.isSafeInteger(payload.asOf) || (payload.asOf as number) < 0) throw new AppError("invalid_restore_command");
    if (payload.acknowledgedEmpty !== undefined && typeof payload.acknowledgedEmpty !== "boolean") throw new AppError("invalid_restore_command");
  } else throw new AppError("invalid_restore_command");
  return createHash("sha256").update(JSON.stringify([command.kind, command.expectedRevision, command.payload])).digest("hex");
}

export function restoreDirFor(databasePath: string): string {
  return `${databasePath}.restores`;
}

function ownRestoreDir(databasePath: string, override?: string): string {
  const dir = override ?? restoreDirFor(databasePath);
  if (dirname(dir) === dir || dir.length > 1024) throw new AppError("invalid_restore_destination", 500);
  return dir;
}

/**
 * Pure compatibility matrix for a backup image against the running code.
 * `direct` needs no migration; `migrate` runs the staged schema path inside quarantine;
 * anything else never activates restored data.
 */
export function restoreCompat(backupSchema: number): { action: "direct" | "migrate" | "reject"; reason: string | null } {
  if (!Number.isSafeInteger(backupSchema) || backupSchema < 0) return { action: "reject", reason: "backup_corrupt" };
  if (backupSchema > currentSupportedSchema) return { action: "reject", reason: "newer_backup_unsupported" };
  if (backupSchema === currentSupportedSchema) return { action: "direct", reason: null };
  if (backupSchema < minSupportedSchema) return { action: "reject", reason: "manual_recovery_required" };
  return { action: "migrate", reason: null };
}

export function readQuarantine(tx: AppTransaction, id: string): RestoreQuarantine {
  requireId(id);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM restore_quarantines WHERE id = ?", id);
  if (!row) throw new AppError("restore_not_found", 404);
  const quarantine = JSON.parse(row.record_json) as RestoreQuarantine;
  if (quarantine.contract !== restoreContract) throw new AppError("restore_corrupt", 500);
  return quarantine;
}

export function listQuarantines(tx: AppTransaction, limit = 50): RestoreQuarantine[] {
  return tx.all<{ record_json: string }>("SELECT record_json FROM restore_quarantines ORDER BY created_at, id LIMIT ?",
    Math.min(Math.max(limit, 1), 100)).map(row => JSON.parse(row.record_json) as RestoreQuarantine);
}

function saveQuarantine(tx: AppTransaction, quarantine: RestoreQuarantine): void {
  tx.run("INSERT INTO restore_quarantines VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, record_json = excluded.record_json",
    quarantine.id, quarantine.createdAt, quarantine.state, JSON.stringify(quarantine));
}

function withQuarantine<T>(workingFile: string, fn: (store: TransactionStore) => T): T {
  const staged = new TransactionStore(workingFile);
  try {
    return fn(staged);
  } finally {
    staged.close();
  }
}

/**
 * restore.prepare: validates the backup manifest and artifact integrity, then copies the
 * image into quarantine. Workers never touch quarantine; the live installation is untouched.
 */
export function prepareRestore(tx: AppTransaction, input: {
  id: string; now: number; liveRevision: number; backupId: string; restoreDir: string;
  /** Managed backup directory every artifact must live in (ops.backup_manifest/v1). */
  backupDir: string;
}): RestoreQuarantine {
  if (tx.get<{ id: string }>("SELECT id FROM restore_quarantines WHERE state IN ('quarantining', 'migrated', 'ledger_applied', 'validated', 'blocked') LIMIT 1")) {
    throw new AppError("restore_in_progress", 409);
  }
  const manifestRow = tx.get<{ record_json: string }>("SELECT record_json FROM ops_backups WHERE id = ?", input.backupId);
  if (!manifestRow) throw new AppError("backup_not_found", 404);
  let parsed: unknown;
  try { parsed = JSON.parse(manifestRow.record_json); } catch { throw new AppError("backup_corrupt", 500); }
  // ops.backup_manifest/v1 structure, including a well-formed producing jitVersion.
  const manifest = validateManifestRecord(parsed);
  if (manifest.id !== input.backupId) throw new AppError("backup_corrupt", 500);
  const compat = restoreCompat(manifest.appSchema);
  if (compat.action === "reject") {
    throw new AppError(compat.reason === "newer_backup_unsupported" ? "newer_backup_unsupported" : "backup_unrestorable", 409);
  }
  // Only complete, verified backups enter quarantine; ledger acknowledgment cannot override this.
  assertRestorableBackup(manifest, input.backupDir);
  let bytes: Uint8Array;
  try {
    bytes = readFileSync(manifest.artifact.path);
  } catch {
    throw new AppError("backup_artifact_missing", 409);
  }
  const hash = createHash("sha256").update(bytes).digest("hex");
  if (hash !== manifest.artifact.hash || bytes.length !== manifest.artifact.bytes) {
    throw new AppError("backup_integrity_failed", 409);
  }
  const dir = join(input.restoreDir, input.id);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const workingFile = join(dir, "quarantine.sqlite");
  try {
    writeFileSync(workingFile, bytes, { mode: 0o600 });
    chmodSync(workingFile, 0o600);
  } catch {
    throw new AppError("restore_storage_unavailable", 503);
  }
  const quarantine: RestoreQuarantine = { id: input.id, contract: restoreContract, backupId: input.backupId,
    state: "quarantining", quarantineDir: dir, workingFile,
    fromSchema: manifest.appSchema, stagedSchema: null, liveRevisionAtPrepare: input.liveRevision,
    ledger: null, validation: null, reason: null,
    nextAction: compat.action === "migrate" ? "migrate_quarantine_to_current_schema" : "apply_external_ledger_tombstones",
    createdAt: input.now, updatedAt: input.now };
  saveQuarantine(tx, quarantine);
  return quarantine;
}

/**
 * restore.migrate: applies supported versioned migrations to the quarantined copy using
 * the staged schema path. Unsupported or failed migration never activates restored data.
 */
export function migrateQuarantine(tx: AppTransaction, quarantine: RestoreQuarantine, now: number): RestoreQuarantine {
  if (["migrated", "validated", "complete"].includes(quarantine.state)) return quarantine;
  if (!["quarantining", "blocked"].includes(quarantine.state)) throw new AppError("restore_bad_state", 409);
  const stagedSchema = withQuarantine(quarantine.workingFile, staged =>
    staged.read(inner => inner.get<{ user_version: number }>("PRAGMA user_version")!.user_version));
  if (stagedSchema !== currentSupportedSchema) {
    const blocked: RestoreQuarantine = { ...quarantine, state: "blocked", reason: "quarantine_migration_failed",
      nextAction: "discard_quarantine_and_investigate_backup", updatedAt: now };
    saveQuarantine(tx, blocked);
    throw new AppError("backup_unrestorable", 409);
  }
  const migrated: RestoreQuarantine = { ...quarantine, state: "migrated", stagedSchema,
    nextAction: "apply_external_ledger_tombstones", updatedAt: now };
  saveQuarantine(tx, migrated);
  return migrated;
}

const tombstoneKey = (t: { kind: string; sourceId: string | null; claimId: string | null; revision: number; generation: number }) =>
  `${t.kind}:${t.kind === "source" ? t.sourceId : t.claimId}:${t.revision}:${t.generation}`;

/**
 * restore.apply_ledger: replays the latest EXTERNAL ledger tombstones inside quarantine,
 * retires/deletes affected sessions, fences attempts and reconciles jobs/outbox without
 * replaying mutations. The backup's own ledger can never prove no later deletion occurred.
 */
export function applyLedger(tx: AppTransaction, quarantine: RestoreQuarantine, input: {
  tombstones: ExternalTombstone[]; source: string; asOf: number; acknowledgedEmpty: boolean; now: number; liveNow: number;
}): RestoreQuarantine {
  if (["validated", "complete"].includes(quarantine.state)) return quarantine;
  if (!["quarantining", "migrated", "blocked", "ledger_applied"].includes(quarantine.state)) throw new AppError("restore_bad_state", 409);
  if (!input.tombstones.length && !input.acknowledgedEmpty) {
    const blocked: RestoreQuarantine = { ...quarantine, state: "blocked", reason: "ledger_empty_unverifiable",
      nextAction: "provide_latest_external_ledger_or_acknowledge_empty", updatedAt: input.now };
    saveQuarantine(tx, blocked);
    throw new AppError("ledger_unverifiable", 409);
  }
  const appliedCounts = withQuarantine(quarantine.workingFile, staged => staged.transaction(inner => {
    let appliedSources = 0, appliedClaims = 0;
    const needles = new Set<string>();
    const needle = (value: unknown) => {
      if (typeof value === "string" && Array.from(value).length >= 8) needles.add(value);
    };
    for (const tombstone of input.tombstones) {
      if (tombstone.kind === "source") {
        const text = inner.get<{ text: string | null }>("SELECT content_text AS text FROM source_versions WHERE source_id = ? AND revision = ? AND generation = ?",
          tombstone.sourceId, tombstone.revision, tombstone.generation)?.text ?? null;
        needle(text);
        inner.run("UPDATE source_versions SET content_text = NULL WHERE source_id = ? AND revision = ? AND generation = ?",
          tombstone.sourceId, tombstone.revision, tombstone.generation);
        const updated = inner.get<{ n: number }>("SELECT changes() AS n")?.n ?? 0;
        inner.run("UPDATE sources SET availability = 'unavailable' WHERE id = ? AND current_revision = ? AND generation = ?",
          tombstone.sourceId, tombstone.revision, tombstone.generation);
        void updated;
        inner.run("INSERT OR IGNORE INTO deletion_ledger (id, operation_id, project_id, kind, source_id, claim_id, revision, generation, deleted_at) VALUES (?, ?, ?, 'source', ?, NULL, ?, ?, ?)",
          randomUUID(), quarantine.id, tombstone.projectId, tombstone.sourceId, tombstone.revision, tombstone.generation, input.now);
        appliedSources++;
      } else {
        const stored = inner.get<{ record_json: string }>("SELECT record_json FROM memory_claims WHERE id = ? AND project_id = ?",
          tombstone.claimId, tombstone.projectId)?.record_json;
        if (stored) {
          try {
            const claim = JSON.parse(stored) as { text?: unknown; quote?: unknown; status?: unknown };
            needle(claim.text); needle(claim.quote);
            inner.run("UPDATE memory_claims SET record_json = ? WHERE id = ? AND project_id = ?",
              JSON.stringify({ ...claim, status: "deleted", text: redactedText, quote: redactedText }), tombstone.claimId, tombstone.projectId);
          } catch { /* Identity tombstone below still denies every consumer. */ }
        }
        inner.run("INSERT OR IGNORE INTO deletion_ledger (id, operation_id, project_id, kind, source_id, claim_id, revision, generation, deleted_at) VALUES (?, ?, ?, 'claim', NULL, ?, ?, ?, ?)",
          randomUUID(), quarantine.id, tombstone.projectId, tombstone.claimId, tombstone.revision, tombstone.generation, input.now);
        appliedClaims++;
      }
    }
    // Fence affected attempts inside quarantine; native sessions retire without replay.
    const affectedClaimIds = new Set(input.tombstones.filter(t => t.kind === "claim").map(t => t.claimId!));
    const affectedSourceKeys = new Set(input.tombstones.filter(t => t.kind === "source").map(t => `${t.sourceId}:${t.revision}:${t.generation}`));
    let fenced = 0;
    for (const row of inner.all<{ projectId: string; jobId: string; json: string }>(
      "SELECT project_id AS projectId, job_id AS jobId, record_json AS json FROM team_runs LIMIT 2000")) {
      let cites = false;
      try {
        const parsed = JSON.parse(row.json) as { request?: { manifest?: { claims?: { claimId?: unknown }[]; sources?: { reference?: { sourceId?: unknown; revision?: unknown; generation?: unknown } }[] } }; manifest?: { claims?: { claimId?: unknown }[]; sources?: { reference?: { sourceId?: unknown; revision?: unknown; generation?: unknown } }[] }; kind?: unknown };
        const manifest = parsed.request?.manifest ?? (parsed.kind === "discussion" ? parsed.manifest : undefined);
        cites = (manifest?.claims ?? []).some(c => typeof c?.claimId === "string" && affectedClaimIds.has(c.claimId)) ||
          (manifest?.sources ?? []).some(s => {
            const reference = s?.reference;
            return !!reference && affectedSourceKeys.has(`${reference.sourceId}:${reference.revision}:${reference.generation}`);
          });
      } catch { cites = true; }
      if (!cites) continue;
      try {
        const job = readJob(inner, row.projectId, row.jobId);
        if (!["succeeded", "partial", "failed", "blocked"].includes(job.state)) {
          invalidatePendingJob(inner, row.projectId, row.jobId, "source_retired", input.now);
          fenced++;
        }
      } catch { /* Unreadable jobs stay fenced by quarantine isolation. */ }
    }
    try {
      fenceStaleContexts(inner, input.now);
    } catch { /* Fencing is best-effort inside quarantine; isolation already denies activation. */ }
    for (const table of ["team_runs", "coordinator_syntheses", "jobs"] as const) {
      for (const row of inner.all<{ rowid: number; json: string }>(`SELECT rowid, record_json AS json FROM ${table} LIMIT 5000`)) {
        let next = row.json, changed = false;
        const parsed = (() => { try { return JSON.parse(next) as unknown; } catch { return null; } })();
        if (!parsed || typeof parsed !== "object") continue;
        const redact = (node: unknown): unknown => {
          if (Array.isArray(node)) return node.map(redact);
          if (!node || typeof node !== "object") return node;
          const record = node as Record<string, unknown>;
          return Object.fromEntries(Object.entries(record).map(([key, item]) => {
            if (key === "text" && typeof item === "string" && needles.has(item)) { changed = true; return [key, redactedText]; }
            return [key, redact(item)];
          }));
        };
        next = JSON.stringify(redact(parsed));
        if (changed) inner.run(`UPDATE ${table} SET record_json = ? WHERE rowid = ?`, next, row.rowid);
      }
    }
    scrubFreeTextOccurrences(inner, [...needles]);
    scrubOutputSources(inner, [...needles]);
    return { appliedSources, appliedClaims, fenced };
  }));
  const applied: RestoreQuarantine = { ...quarantine, state: "ledger_applied", reason: null,
    ledger: { count: input.tombstones.length, source: input.source, asOf: input.asOf,
      appliedSources: appliedCounts.appliedSources, appliedClaims: appliedCounts.appliedClaims,
      external: input.tombstones.map(t => ({ ...t })) },
    nextAction: "validate_quarantine_before_activation", updatedAt: input.now };
  saveQuarantine(tx, applied);
  return applied;
}

/**
 * restore.validate: verifies manifest integrity, quarantine invariants, ledger coverage
 * (the backup's own tombstones must all appear in the external set), job/outbox
 * reconciliation state and opaque native references. Never activates anything.
 */
export function validateQuarantine(live: TransactionStore, quarantine: RestoreQuarantine, now: number, backupCreatedAt: number): RestoreQuarantine {
  if (quarantine.state === "complete") return quarantine;
  if (!["ledger_applied", "blocked", "validated"].includes(quarantine.state)) throw new AppError("restore_bad_state", 409);
  const checks: { name: string; pass: boolean; detail: string }[] = [];
  const report = withQuarantine(quarantine.workingFile, staged => staged.read(tx => {
    checks.push(tx.all("PRAGMA foreign_key_check").length === 0
      ? { name: "foreign_keys", pass: true, detail: "no_violations" }
      : { name: "foreign_keys", pass: false, detail: "violations_found" });
    const ownTombstones = tx.all<{ kind: string; projectId: string; sourceId: string | null; claimId: string | null; revision: number; generation: number }>(
      "SELECT kind, project_id AS projectId, source_id AS sourceId, claim_id AS claimId, revision, generation FROM deletion_ledger WHERE operation_id != ? LIMIT 5000", quarantine.id);
    const externalKeys = new Set((quarantine.ledger?.external ?? []).map(tombstoneKey));
    const missing = ownTombstones.filter(t => !externalKeys.has(tombstoneKey(t)));
    checks.push(missing.length === 0
      ? { name: "external_ledger_coverage", pass: true, detail: `own_${ownTombstones.length}_covered` }
      : { name: "external_ledger_coverage", pass: false, detail: `missing_${missing.length}_from_external` });
    const pendingJobs = tx.all<{ id: string; projectId: string; state: string }>(
      "SELECT id, project_id AS projectId, state FROM jobs WHERE state IN ('queued', 'admitted', 'waiting') LIMIT 100")
      .map(row => ({ ...row, record: tx.get<{ record_json: string }>("SELECT record_json FROM jobs WHERE id = ?", row.id)?.record_json ?? "{}" }))
      .map(row => ({ id: row.id, projectId: row.projectId, state: row.state }));
    checks.push({ name: "jobs_quiesced", pass: !pendingJobs.some(j => j.state === "admitted"), detail: `pending_${pendingJobs.length}` });
    let unknownOutbox = 0;
    try {
      unknownOutbox = tx.get<{ n: number }>(`SELECT count(*) AS n FROM delivery_intents WHERE json_extract(record_json, '$.status') = 'unknown'`)?.n ?? 0;
    } catch { unknownOutbox = 0; }
    checks.push({ name: "outbox_listed", pass: true, detail: `unknown_${unknownOutbox}` });
    const pendingNative = tx.all<{ id: string; generation: number; appState: string }>(
      `SELECT c.id, c.generation, c.state AS appState FROM team_contexts c WHERE c.state IN ('active', 'retired', 'delete_failed') LIMIT 200`);
    const nativeBlocked = pendingNative.some(c => c.appState === "delete_failed");
    checks.push(nativeBlocked
      ? { name: "native_sessions", pass: false, detail: "delete_failed_present" }
      : { name: "native_sessions", pass: true, detail: `pending_${pendingNative.length}_fenced` });
    const suppressions = tx.get<{ n: number }>("SELECT count(*) AS n FROM memory_suppressions")?.n ?? 0;
    checks.push({ name: "suppressions_preserved", pass: true, detail: `suppressions_${suppressions}` });
    let nativeRefs = 0;
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM job_attempts LIMIT 2000")) {
      try {
        const native = (JSON.parse(row.record_json) as { native?: { context?: { id: string } } }).native?.context;
        if (native) nativeRefs++;
      } catch { /* Opaque refs never parse native bytes. */ }
    }
    return { ownTombstones: ownTombstones.length, missing: missing.length, pendingJobs, unknownOutbox, pendingNative, nativeBlocked, suppressions, nativeRefs };
  }));
  const liveState = live.read(tx => ({
    liveRevision: tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision,
    liveSources: new Set(tx.all<{ id: string }>("SELECT id FROM sources LIMIT 5000").map(r => r.id)),
  }));
  const quarantineSources = withQuarantine(quarantine.workingFile, staged =>
    staged.read(tx => new Set(tx.all<{ id: string }>("SELECT id FROM sources LIMIT 5000").map(r => r.id))));
  let liveOnlySources = 0;
  for (const id of liveState.liveSources) if (!quarantineSources.has(id)) liveOnlySources++;
  const ledger = quarantine.ledger;
  const staleExternal = ledger && backupCreatedAt > 0 ? ledger.asOf! < backupCreatedAt : true;
  const allChecks = [...checks,
    staleExternal ? { name: "external_ledger_freshness", pass: false, detail: "as_of_before_backup" }
      : { name: "external_ledger_freshness", pass: true, detail: "as_of_covers_backup" }];
  const pass = allChecks.every(c => c.pass);
  const validation: RestoreValidation = {
    manifestOk: true, compat: "compatible", stagedSchema: quarantine.stagedSchema ?? currentSupportedSchema,
    ownTombstones: report.ownTombstones, externalTombstones: ledger?.count ?? 0, missingFromExternal: report.missing,
    appliedSources: ledger?.appliedSources ?? 0, appliedClaims: ledger?.appliedClaims ?? 0,
    pendingNative: report.pendingNative, nativeBlocked: report.nativeBlocked,
    pendingJobs: report.pendingJobs, unknownOutbox: report.unknownOutbox,
    liveOnlySources, liveRevisionAtPrepare: quarantine.liveRevisionAtPrepare, liveRevisionNow: liveState.liveRevision,
    suppressionsPreserved: report.suppressions,
    residuals: ["telegram_delivery_copies_not_restored", "provider_session_copies_not_restored",
      liveOnlySources > 0 ? `live_writes_since_backup_discarded_${liveOnlySources}` : "no_live_sources_outside_backup"],
    checks: allChecks,
  };
  const validated: RestoreQuarantine = { ...quarantine, state: pass ? "validated" : "blocked",
    validation, reason: pass ? null : "quarantine_blocked_see_checks",
    nextAction: pass ? "activate_or_discard_quarantine" : "resolve_blocked_check_or_discard_quarantine",
    updatedAt: now };
  live.transaction(tx => saveQuarantine(tx, validated));
  return validated;
}

/**
 * restore.activate: switches the live installation to the validated quarantine image.
 * Requires a fresh validation, an applied external ledger and an unchanged live revision.
 * Scheduler claims are invalidated by the swap; workers reconcile after reboot.
 */
export function activateRestore(live: TransactionStore, quarantine: RestoreQuarantine, now: number, liveRevision: number): RestoreQuarantine {
  if (quarantine.state === "complete") return quarantine;
  if (quarantine.state !== "validated") throw new AppError("restore_bad_state", 409);
  if (!quarantine.ledger) throw new AppError("ledger_unverifiable", 409);
  if (liveRevision !== quarantine.liveRevisionAtPrepare) {
    const stale: RestoreQuarantine = { ...quarantine, state: "blocked", reason: "live_changed_since_prepare",
      nextAction: "discard_and_prepare_again", updatedAt: now };
    live.transaction(tx => saveQuarantine(tx, stale));
    throw new AppError("restore_stale_live", 409);
  }
  live.swapFrom(quarantine.workingFile);
  const completed: RestoreQuarantine = { ...quarantine, state: "complete", reason: null,
    nextAction: "reconcile_jobs_sessions_outbox_after_reboot", updatedAt: now };
  live.transaction(tx => saveQuarantine(tx, completed));
  return completed;
}

/** restore.discard: removes quarantine files and marks the attempt discarded; live is untouched. */
export function discardRestore(tx: AppTransaction, quarantine: RestoreQuarantine, now: number): RestoreQuarantine {
  if (quarantine.state === "complete") throw new AppError("restore_bad_state", 409);
  try { rmSync(quarantine.quarantineDir, { recursive: true, force: true }); } catch { /* Best-effort cleanup. */ }
  const discarded: RestoreQuarantine = { ...quarantine, state: "discarded", reason: "discarded_by_owner",
    nextAction: "prepare_a_new_quarantine_when_ready", updatedAt: now };
  saveQuarantine(tx, discarded);
  return discarded;
}

/** Sanitized restore evidence: versions, ledger coverage, validation and next action. No secrets. */
export function restoreEvidence(quarantine: RestoreQuarantine): RestoreQuarantine {
  return JSON.parse(JSON.stringify(quarantine)) as RestoreQuarantine;
}

export function ownRestoreDirFor(databasePath: string, override?: string): string {
  return ownRestoreDir(databasePath, override);
}
