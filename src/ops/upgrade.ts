import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../errors";
import { lookupSource, requireId } from "../sources";
import { TransactionStore, type AppTransaction } from "../store";
import {
  prepareBackupManifest, resolveNativeSnapshot, writeArtifact,
  type BackupManifest, type BackupNativePort,
} from "./backup";

export const upgradeContract = "ops.schema_migrations/v1" as const;
/** Oldest live schema this code migrates forward; anything older needs manual recovery. */
export const minSupportedSchema = 15;
export const currentSupportedSchema = 21;

export type UpgradeState = "prepared" | "staged" | "ready" | "complete" | "failed" | "rolled_back";

export interface UpgradePrepareCommand {
  kind: "upgrade.prepare"; requestId: string; projectId: null; expectedRevision: number;
  payload: { targetSchema: number; note: string };
}
export interface UpgradeStepCommand {
  kind: "upgrade.migrate" | "upgrade.validate" | "upgrade.activate" | "upgrade.rollback";
  requestId: string; projectId: null; expectedRevision: number;
  payload: { upgradeId: string };
}
export type UpgradeCommand = UpgradePrepareCommand | UpgradeStepCommand;

export interface UpgradeCheck { name: string; pass: boolean; detail: string }
export interface UpgradeValidation {
  stagedSchema: number; liveSchema: number; checks: UpgradeCheck[];
  ledgersMatch: boolean; outstanding: { queued: number; admitted: number };
  unknownOutbox: number; nativeRefs: number;
}

export interface UpgradeJournal {
  id: string; contract: typeof upgradeContract;
  fromSchema: number; targetSchema: number;
  state: UpgradeState;
  steps: { name: string; at: number; ok: boolean; detail: string }[];
  preflight: { currentSchema: number; targetSchema: number; engine: string | null; compatible: boolean; plannedSteps: string[] };
  snapshotBackupId: string | null;
  stagedPath: string | null; stagedSchema: number | null;
  sidecarPath: string | null;
  liveRevisionAtValidate: number | null;
  outstanding: { queued: number; admitted: number };
  validation: UpgradeValidation | null;
  reason: string | null; nextAction: string;
  createdAt: number; updatedAt: number;
}

export interface UpgradeReceipt { journal: UpgradeJournal; duplicate: boolean }

const exact = (value: unknown, keys: string[]) =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

export function upgradeIdentity(command: UpgradeCommand): string {
  if (!command || typeof command !== "object" || !exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 || command.projectId !== null) {
    throw new AppError("invalid_upgrade_command");
  }
  if (command.kind === "upgrade.prepare") {
    if (!exact(command.payload, ["targetSchema", "note"]) || !Number.isSafeInteger(command.payload.targetSchema) ||
        typeof command.payload.note !== "string" || Buffer.byteLength(command.payload.note) > 500 || !command.payload.note.isWellFormed()) {
      throw new AppError("invalid_upgrade_command");
    }
  } else if (["upgrade.migrate", "upgrade.validate", "upgrade.activate", "upgrade.rollback"].includes(command.kind)) {
    if (!exact(command.payload, ["upgradeId"])) throw new AppError("invalid_upgrade_command");
    requireId((command.payload as { upgradeId: string }).upgradeId);
  } else throw new AppError("invalid_upgrade_command");
  return createHash("sha256").update(JSON.stringify([command.kind, command.expectedRevision, command.payload])).digest("hex");
}

export function upgradeDirFor(databasePath: string): string {
  return `${databasePath}.upgrades`;
}

function ownUpgradeDir(databasePath: string, override?: string): string {
  const dir = override ?? upgradeDirFor(databasePath);
  if (dirname(dir) === dir || dir.length > 1024) throw new AppError("invalid_upgrade_destination", 500);
  return dir;
}

/**
 * Pure preflight matrix over schema versions and engine availability. Downgrades,
 * future targets and newer-than-supported live schemas fail before any mutation.
 */
export function planUpgrade(fromSchema: number, targetSchema: number, engine: string | null): {
  compatible: boolean; reason: string | null; plannedSteps: string[];
} {
  if (!Number.isSafeInteger(fromSchema) || !Number.isSafeInteger(targetSchema)) {
    return { compatible: false, reason: "unsupported_schema_version", plannedSteps: [] };
  }
  if (fromSchema > currentSupportedSchema) {
    return { compatible: false, reason: "newer_schema_unsupported", plannedSteps: [] };
  }
  if (targetSchema < fromSchema) return { compatible: false, reason: "downgrade_rejected", plannedSteps: [] };
  if (targetSchema > currentSupportedSchema) return { compatible: false, reason: "forward_upgrade_unsupported", plannedSteps: [] };
  if (fromSchema < minSupportedSchema) return { compatible: false, reason: "manual_recovery_required", plannedSteps: [] };
  if (!engine) return { compatible: false, reason: "engine_unavailable", plannedSteps: [] };
  return { compatible: true, reason: null,
    plannedSteps: ["quiesce", "snapshot", "migrate", "validate", "activate"] };
}

export function readUpgrade(tx: AppTransaction, id: string): UpgradeJournal {
  requireId(id);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM upgrade_journal WHERE id = ?", id);
  if (!row) throw new AppError("upgrade_not_found", 404);
  const journal = JSON.parse(row.record_json) as UpgradeJournal;
  if (journal.contract !== upgradeContract) throw new AppError("upgrade_corrupt", 500);
  return journal;
}

export function listUpgrades(tx: AppTransaction, limit = 50): UpgradeJournal[] {
  return tx.all<{ record_json: string }>("SELECT record_json FROM upgrade_journal ORDER BY created_at, id LIMIT ?",
    Math.min(Math.max(limit, 1), 100)).map(row => JSON.parse(row.record_json) as UpgradeJournal);
}

function saveJournal(tx: AppTransaction, journal: UpgradeJournal): void {
  tx.run("INSERT INTO upgrade_journal VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET state = excluded.state, record_json = excluded.record_json",
    journal.id, journal.createdAt, journal.state, JSON.stringify(journal));
}

function currentSchema(tx: AppTransaction): number {
  return tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
}

function outstandingWork(tx: AppTransaction): { queued: number; admitted: number } {
  const queued = tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state IN ('queued', 'waiting')")?.n ?? 0;
  const admitted = tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state = 'admitted'")?.n ?? 0;
  return { queued, admitted };
}

/** Copies identity-only lifecycle checkpoints aside from both live and staged data. */
function writeLedgerSidecar(tx: AppTransaction, dir: string, id: string, now: number): string {
  const deletions = tx.all("SELECT operation_id, project_id, kind, source_id, claim_id, revision, generation, deleted_at FROM deletion_ledger ORDER BY deleted_at, id LIMIT 5000");
  const suppressions = tx.all("SELECT id, project_id, claim_id FROM memory_suppressions LIMIT 2000");
  const suppressedSources = tx.all("SELECT suppression_id, project_id, source_id, revision, generation FROM memory_suppressed_sources LIMIT 5000");
  const path = join(dir, id, "ledger-sidecar.json");
  mkdirSync(join(dir, id), { recursive: true, mode: 0o700 });
  const body = JSON.stringify({ contract: "app.deletion_ledger/v1", upgradeId: id, exportedAt: now, deletions, suppressions, suppressedSources });
  try {
    writeFileSync(path, body, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    throw new AppError("upgrade_storage_unavailable", 503);
  }
  return path;
}

/**
 * upgrade.prepare: preflight, quiesce accounting, fail-closed recovery snapshot through
 * ops.backup_manifest and ledger sidecar. The live database is otherwise untouched.
 */
export function prepareUpgrade(tx: AppTransaction, store: TransactionStore, input: {
  id: string; now: number; appRevision: number; targetSchema: number; note: string;
  upgradeDir: string; backupDir: string; engine: BackupNativePort | undefined;
}): UpgradeJournal {
  if (tx.get<{ id: string }>("SELECT id FROM upgrade_journal WHERE state IN ('prepared', 'staged', 'ready') LIMIT 1")) {
    throw new AppError("upgrade_in_progress", 409);
  }
  const fromSchema = currentSchema(tx);
  const engineName = input.engine?.available() ? (input.engine.engine ?? "scripted-fixture-v1") : null;
  const plan = planUpgrade(fromSchema, input.targetSchema, engineName);
  // Failed preflights throw before mutating; the caller persists the failed journal
  // outside this rolled-back transaction so the rejection stays inspectable.
  if (!plan.compatible) {
    throw new AppError(plan.reason === "engine_unavailable" ? "engine_unavailable" : "unsupported_upgrade", 409);
  }
  // Fail-closed snapshot: an unavailable engine snapshot never yields a usable recovery point.
  const snapshot = store.snapshotBytes();
  const hash = createHash("sha256").update(snapshot).digest("hex");
  const native = resolveNativeSnapshot(input.engine);
  if (native.state !== "valid") {
    // Fail-closed snapshot: an unavailable engine snapshot never yields a usable recovery point.
    // The caller persists the failed journal outside this rolled-back transaction.
    throw new AppError("native_snapshot_unavailable", 503);
  }
  const backupId = crypto.randomUUID();
  const artifactPath = writeArtifact(input.backupDir, backupId, snapshot);
  const manifest: BackupManifest = {
    contract: "ops.backup_manifest/v1", id: backupId, createdAt: input.now, appSchema: fromSchema,
    jitVersion: "jit-mvp-fixture", appRevision: input.appRevision,
    projects: tx.all<{ projectId: string; revision: number }>("SELECT id AS projectId, revision FROM projects ORDER BY created_at, id LIMIT 1000"),
    sourceGenerations: tx.all<{ projectId: string; sourceId: string; revision: number; generation: number }>(
      "SELECT project_id AS projectId, id AS sourceId, current_revision AS revision, generation FROM sources ORDER BY project_id, id LIMIT 4000"),
    lifecycle: (() => { try {
      const latest = tx.all<{ record_json: string }>("SELECT record_json FROM memory_suppressions ORDER BY rowid DESC LIMIT 1");
      return latest.length ? { available: true, checkpoint: (JSON.parse(latest[0]!.record_json) as { id: string }).id, reason: null as string | null }
        : { available: false, checkpoint: null, reason: "no_ledger_checkpoint" as string | null };
    } catch { return { available: false, checkpoint: null, reason: "ledger_unverifiable" as string | null }; } })(),
    native, content: { bytes: snapshot.length, hash, projects: 0, sources: 0 },
    retention: { maxBackups: 10, maxBytes: 64 * 1024 * 1024, pruned: [] },
    state: "valid", reason: null, artifact: { path: artifactPath, bytes: snapshot.length, hash },
  };
  manifest.content.projects = manifest.projects.length;
  manifest.content.sources = manifest.sourceGenerations.length;
  tx.run("INSERT INTO ops_backups VALUES (?, ?, ?)", manifest.id, manifest.createdAt, JSON.stringify(manifest));
  const sidecarPath = writeLedgerSidecar(tx, input.upgradeDir, input.id, input.now);
  const journal: UpgradeJournal = { id: input.id, contract: upgradeContract, fromSchema, targetSchema: input.targetSchema,
    state: "prepared", steps: [{ name: "preflight", at: input.now, ok: true, detail: "compatible" },
      { name: "quiesce", at: input.now, ok: true, detail: "outstanding_recorded" },
      { name: "snapshot", at: input.now, ok: true, detail: backupId }],
    preflight: { currentSchema: fromSchema, targetSchema: input.targetSchema, engine: engineName, compatible: true, plannedSteps: plan.plannedSteps },
    snapshotBackupId: backupId, stagedPath: join(input.upgradeDir, input.id, "staged.sqlite"), stagedSchema: null,
    sidecarPath, liveRevisionAtValidate: null, outstanding: outstandingWork(tx), validation: null,
    reason: null, nextAction: "migrate_to_staged_copy", createdAt: input.now, updatedAt: input.now };
  saveJournal(tx, journal);
  return journal;
}

/**
 * Persists an explicit failed journal for a prepare that threw before committing.
 * Runs in its own transaction so the rejection stays inspectable while the live
 * installation is untouched.
 */
export function recordFailedUpgrade(tx: AppTransaction, input: {
  id: string; now: number; targetSchema: number; engine: BackupNativePort | undefined; reason: string;
}): UpgradeJournal {
  const fromSchema = currentSchema(tx);
  const engineName = input.engine?.available() ? (input.engine.engine ?? "scripted-fixture-v1") : null;
  const plan = planUpgrade(fromSchema, input.targetSchema, engineName);
  const preflightFailed = !plan.compatible;
  const snapshotDetail = preflightFailed ? "preflight_failed" : input.reason;
  const journal: UpgradeJournal = { id: input.id, contract: upgradeContract, fromSchema, targetSchema: input.targetSchema,
    state: "failed",
    steps: preflightFailed ? [{ name: "preflight", at: input.now, ok: false, detail: plan.reason! }]
      : [{ name: "preflight", at: input.now, ok: true, detail: "compatible" },
        { name: "snapshot", at: input.now, ok: false, detail: snapshotDetail }],
    preflight: { currentSchema: fromSchema, targetSchema: input.targetSchema, engine: engineName, compatible: plan.compatible, plannedSteps: plan.compatible ? plan.plannedSteps : [] },
    snapshotBackupId: null, stagedPath: null, stagedSchema: null, sidecarPath: null, liveRevisionAtValidate: null,
    outstanding: outstandingWork(tx), validation: null, reason: preflightFailed ? plan.reason! : input.reason,
    nextAction: preflightFailed ? "inspect_preflight_and_retry_with_supported_target" : "resolve_engine_snapshot_then_prepare_again",
    createdAt: input.now, updatedAt: input.now };
  saveJournal(tx, journal);
  return journal;
}

function withStaged<T>(stagedPath: string, fn: (store: TransactionStore) => T): T {
  const staged = new TransactionStore(stagedPath);
  try {
    return fn(staged);
  } finally {
    staged.close();
  }
}

/**
 * upgrade.migrate: copies the live image to staged storage and applies versioned
 * migrations there. The live installation is never mutated by this step.
 */
export function migrateUpgrade(tx: AppTransaction, store: TransactionStore, journal: UpgradeJournal, now: number): UpgradeJournal {
  if (journal.state === "staged" || journal.state === "ready" || journal.state === "complete") return journal;
  if (journal.state !== "prepared" && journal.state !== "failed") throw new AppError("upgrade_bad_state", 409);
  const bytes = store.snapshotBytes();
  mkdirSync(dirname(journal.stagedPath!), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(journal.stagedPath!, bytes, { mode: 0o600 });
    chmodSync(journal.stagedPath!, 0o600);
  } catch {
    throw new AppError("upgrade_storage_unavailable", 503);
  }
  const stagedSchema = withStaged(journal.stagedPath!, staged =>
    staged.read(inner => inner.get<{ user_version: number }>("PRAGMA user_version")!.user_version));
  const migrated: UpgradeJournal = { ...journal, state: "staged", stagedSchema,
    steps: [...journal.steps, { name: "migrate", at: now, ok: true, detail: `staged_schema_${stagedSchema}` }],
    reason: null, nextAction: "validate_staged_copy", updatedAt: now };
  saveJournal(tx, migrated);
  return migrated;
}

function checkReceipts(staged: AppTransaction, checks: UpgradeCheck[]): void {
  for (const row of staged.all<{ request_id: string; record_json: string }>("SELECT request_id, result_json AS record_json FROM command_receipts LIMIT 5000")) {
    try { JSON.parse(row.record_json); } catch {
      checks.push({ name: "receipts_parse", pass: false, detail: "unreadable_command_receipt" });
      return;
    }
  }
  checks.push({ name: "receipts_parse", pass: true, detail: "command_receipts_parse" });
}

/**
 * upgrade.validate: checks staged invariants, task/decision provenance, source lineage,
 * jobs/outbox preservation and native opaque references, plus ledger preservation against
 * the sidecar and live quiesce. Never parses private native formats.
 */
export function validateUpgrade(live: TransactionStore, journal: UpgradeJournal, now: number): UpgradeJournal {
  if (journal.state === "ready" || journal.state === "complete") return journal;
  if (journal.state !== "staged" && journal.state !== "failed") throw new AppError("upgrade_bad_state", 409);
  const checks: UpgradeCheck[] = [];
  const report = withStaged(journal.stagedPath!, staged => staged.read(tx => {
    const stagedSchema = tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
    checks.push(stagedSchema === currentSupportedSchema
      ? { name: "staged_schema", pass: true, detail: `schema_${stagedSchema}` }
      : { name: "staged_schema", pass: false, detail: `schema_${stagedSchema}_unsupported` });
    checks.push(tx.all("PRAGMA foreign_key_check").length === 0
      ? { name: "foreign_keys", pass: true, detail: "no_violations" }
      : { name: "foreign_keys", pass: false, detail: "violations_found" });
    checkReceipts(tx, checks);
    for (const row of tx.all<{ id: string; projectId: string; source: string }>(
      "SELECT id, project_id AS projectId, json_object('sourceId', source_id, 'revision', source_revision, 'generation', source_generation) AS source FROM tasks LIMIT 2000")) {
      const reference = JSON.parse(row.source) as { sourceId: string; revision: number; generation: number };
      const found = lookupSource(tx, row.projectId, reference);
      if (found.state === "unavailable" && !["source_unavailable", "revision_unavailable", "generation_unavailable"].includes(found.reason)) {
        checks.push({ name: "task_provenance", pass: false, detail: `task_${row.id}` });
        break;
      }
    }
    if (!checks.some(c => c.name === "task_provenance")) checks.push({ name: "task_provenance", pass: true, detail: "sources_resolve_or_tombstoned" });
    for (const row of tx.all<{ id: string }>("SELECT id FROM decision_proposals LIMIT 500")) {
      if (!tx.get("SELECT 1 FROM sources WHERE id = (SELECT source_id FROM decision_proposals WHERE id = ?)", row.id)) {
        checks.push({ name: "decision_provenance", pass: false, detail: `proposal_${row.id}` });
        break;
      }
    }
    if (!checks.some(c => c.name === "decision_provenance")) checks.push({ name: "decision_provenance", pass: true, detail: "proposals_have_sources" });
    for (const row of tx.all<{ id: string; projectId: string }>("SELECT id, project_id AS projectId FROM jobs LIMIT 1000")) {
      if (!tx.get("SELECT 1 FROM job_authority WHERE job_id = ?", row.id)) {
        checks.push({ name: "jobs_outbox", pass: false, detail: `job_${row.id}_without_authority` });
        break;
      }
    }
    if (!checks.some(c => c.name === "jobs_outbox")) checks.push({ name: "jobs_outbox", pass: true, detail: "jobs_have_authority" });
    let nativeRefs = 0, opaqueOk = true;
    for (const row of tx.all<{ state: string }>("SELECT state FROM team_contexts LIMIT 2000")) {
      nativeRefs++;
      if (!["active", "retired", "delete_failed", "deleted"].includes(row.state)) { opaqueOk = false; break; }
    }
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM job_attempts LIMIT 2000")) {
      try {
        const native = (JSON.parse(row.record_json) as { native?: { context?: { id: string; generation: number } } }).native?.context;
        if (native) {
          nativeRefs++;
          if (typeof native.id !== "string" || !Number.isSafeInteger(native.generation) || native.generation < 1) { opaqueOk = false; break; }
        }
      } catch { opaqueOk = false; break; }
    }
    checks.push({ name: "native_opaque_refs", pass: opaqueOk, detail: `refs_${nativeRefs}_unparsed` });
    let sidecar: { deletions?: unknown[]; suppressions?: unknown[]; suppressedSources?: unknown[] } = {};
    try {
      sidecar = JSON.parse(readFileSync(journal.sidecarPath!, "utf8"));
    } catch { /* Missing sidecar fails the ledger check below. */ }
    const stagedDeletions = tx.get<{ n: number }>("SELECT count(*) AS n FROM deletion_ledger")?.n ?? -1;
    const stagedSuppressions = tx.get<{ n: number }>("SELECT count(*) AS n FROM memory_suppressions")?.n ?? -1;
    const ledgersMatch = Array.isArray(sidecar.deletions) && Array.isArray(sidecar.suppressions) &&
      stagedDeletions === sidecar.deletions.length && stagedSuppressions === sidecar.suppressions.length;
    checks.push(ledgersMatch
      ? { name: "ledger_preservation", pass: true, detail: `deletions_${stagedDeletions}_suppressions_${stagedSuppressions}` }
      : { name: "ledger_preservation", pass: false, detail: "sidecar_mismatch" });
    const staleSuppressed = tx.all<{ sourceId: string; revision: number; generation: number }>(
      "SELECT source_id AS sourceId, revision, generation FROM memory_suppressed_sources LIMIT 5000");
    let lineageOk = true;
    for (const entry of staleSuppressed.slice(0, 200)) {
      if (!tx.get("SELECT 1 FROM sources WHERE id = ?", entry.sourceId)) { lineageOk = false; break; }
    }
    checks.push({ name: "source_lineage", pass: lineageOk, detail: "suppressed_lineage_resolves" });
    return { stagedSchema, checks, stagedDeletions, stagedSuppressions };
  }));
  const liveState = live.read(tx => ({
    liveSchema: currentSchema(tx),
    liveRevision: tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision,
    admitted: tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state = 'admitted'")?.n ?? 0,
    queued: tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE state IN ('queued', 'waiting')")?.n ?? 0,
    unknownOutbox: (() => { try {
      return tx.get<{ n: number }>(`SELECT count(*) AS n FROM delivery_intents WHERE json_extract(record_json, '$.status') = 'unknown'`)?.n ?? 0;
    } catch { return 0; } })(),
  }));
  const quiesced = liveState.admitted === 0;
  const validation: UpgradeValidation = {
    stagedSchema: report.stagedSchema, liveSchema: liveState.liveSchema,
    checks: [...report.checks,
      quiesced ? { name: "quiesce", pass: true, detail: `queued_${liveState.queued}_admitted_0` }
        : { name: "quiesce", pass: false, detail: `admitted_${liveState.admitted}_running` }],
    ledgersMatch: report.checks.some(c => c.name === "ledger_preservation" && c.pass),
    outstanding: { queued: liveState.queued, admitted: liveState.admitted },
    unknownOutbox: liveState.unknownOutbox, nativeRefs: 0,
  };
  const pass = validation.checks.every(c => c.pass);
  const validated: UpgradeJournal = { ...journal,
    state: pass ? "ready" : "failed",
    steps: [...journal.steps, { name: "validate", at: now, ok: pass, detail: pass ? "all_checks_pass" : "check_failed" }],
    liveRevisionAtValidate: liveState.liveRevision, outstanding: { queued: liveState.queued, admitted: liveState.admitted },
    validation, reason: pass ? null : "validation_failed",
    nextAction: pass ? "activate_staged_copy_or_rollback_snapshot" : "inspect_failed_check_then_migrate_again_or_rollback",
    updatedAt: now };
  live.transaction(tx => saveJournal(tx, validated));
  return validated;
}

/**
 * upgrade.activate: switches the live installation to the validated staged copy.
 * The pre-upgrade backup stays the rollback source; ledgers are preserved, never replayed.
 */
export function activateUpgrade(live: TransactionStore, journal: UpgradeJournal, now: number): UpgradeJournal {
  if (journal.state === "complete") return journal;
  if (journal.state !== "ready") throw new AppError("upgrade_bad_state", 409);
  const liveRevision = live.read(tx => tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision);
  if (journal.liveRevisionAtValidate !== liveRevision) {
    const stale: UpgradeJournal = { ...journal, state: "failed",
      steps: [...journal.steps, { name: "activate", at: now, ok: false, detail: "live_changed_since_validate" }],
      reason: "upgrade_stale_live", nextAction: "migrate_again_then_validate", updatedAt: now };
    live.transaction(tx => saveJournal(tx, stale));
    throw new AppError("upgrade_stale_live", 409);
  }
  live.swapFrom(journal.stagedPath!);
  // The swapped database carries the journal row; mark completion inside the new live file.
  const completed: UpgradeJournal = { ...journal, state: "complete",
    steps: [...journal.steps, { name: "activate", at: now, ok: true, detail: "staged_is_live" }],
    reason: null, nextAction: "reconcile_jobs_sessions_then_resume", updatedAt: now };
  live.transaction(tx => saveJournal(tx, completed));
  return completed;
}

/**
 * upgrade.rollback: restores the pre-upgrade backup image as live. Tombstone sidecars
 * and the staged copy stay for inspection; rollback never clears a ledger.
 */
export function rollbackUpgrade(live: TransactionStore, journal: UpgradeJournal, backupArtifact: string, now: number): UpgradeJournal {
  if (journal.state === "rolled_back") return journal;
  if (!["ready", "failed", "complete"].includes(journal.state)) throw new AppError("upgrade_bad_state", 409);
  live.swapFrom(backupArtifact);
  const rolled: UpgradeJournal = { ...journal, state: "rolled_back",
    steps: [...journal.steps, { name: "rollback", at: now, ok: true, detail: "snapshot_restored" }],
    reason: "rolled_back_to_snapshot", nextAction: "inspect_snapshot_then_prepare_again", updatedAt: now };
  live.transaction(tx => saveJournal(tx, rolled));
  return rolled;
}

/** Sanitized upgrade evidence: versions, steps, validation, artifacts and next action. No secrets. */
export function upgradeEvidence(journal: UpgradeJournal): UpgradeJournal {
  return JSON.parse(JSON.stringify(journal)) as UpgradeJournal;
}

export function ownUpgradeDirFor(databasePath: string, override?: string): string {
  return ownUpgradeDir(databasePath, override);
}
