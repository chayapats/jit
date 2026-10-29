import { purgeProjectPayloads } from "../memory/project-delete";
import { redactRoleProposals } from "../team/role-proposals";
import { redactPromotionProposal } from "../promotion";
import { createHash, randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../errors";
import { requireId } from "../sources";
import { TransactionStore, type AppTransaction } from "../store";
import { invalidateJob } from "../jobs/attempts";
import { reconcileSessions } from "../jobs/reconcile";
import { invalidatePendingJob } from "../jobs/queue";
import type { Job } from "../jobs/types";
import { fenceStaleContexts } from "../memory/context";
import { fenceUnavailableExtractions } from "../memory/extract";
import {
  contextCitations, reconcileDeletions, redactReplayedLineage, redactedText, refreshOperationState, scrubFreeTextOccurrences, scrubOutputSources, type DeletionOperation,
} from "../memory/delete";
import type { ApplicationRunPort } from "../team/run-port";
import { assertRestorableBackup, jitAppVersion, validateManifestRecord, verifyBackupArtifacts, type BackupManifest, type BackupNativePort } from "./backup";
import { ledgerView, syncLedgerCheckpoint, type LifecycleLedgerEntry, type TrustedLedger } from "./lifecycle-ledger";
import {
  currentSupportedSchema, inspectUpgradeEngine, managedStateDigest, managedTables, minSupportedSchema, tableDigest,
  upgradeEngineContract, upgradeNativeFormatVersion,
  type UpgradeEngineCheck, type UpgradeQuiesceResult, type UpgradeResumeResult, type UpgradeServiceControl,
} from "./upgrade";
import { clearUpgradeFence, readUpgradeFence, writeFileAtomic, writeUpgradeFence } from "./upgrade-fence";

/**
 * ops.quarantined_restore/v1 — owner-authorized restore of a managed backup
 * through quarantine (OPS02, issue #33). See
 * docs/contracts/ops-quarantined-restore-v1.md and ADR 0027.
 *
 * Flow: prepare (manifest, app/schema/engine compatibility and artifact
 * integrity, then the shared ops.schema_migrations/v1 admission fence and
 * service quiesce, then a verified copy into quarantine) → migrate (OPS06
 * staged migration of the quarantine copy with row preservation) →
 * apply_ledger (replay of the latest trusted installation lifecycle ledger:
 * tombstones, suppressions, derived invalidation, context retirement/deletion
 * scheduling, attempt/job/outbox fencing and a revision generation fence) →
 * validate (coverage, payload absence, quiesce and integrity checks; owner
 * report) → activate (durable intent, atomic swap, identity check, session
 * revocation, managed native-session deletion while still fenced, then fence
 * release and service resume with job/session/outbox reconciliation) →
 * complete. `discard` abandons any attempt before activation.
 *
 * Control state (journal, request receipts, quarantine copy) lives in files
 * under `<restoreDir>/<id>/`, outside the swapped database, so activation can
 * never erase its own evidence; the fence is the upgrade fence with holder
 * `restore`, so restore and upgrade exclude each other.
 */
export const restoreContract = "ops.quarantined_restore/v1" as const;

export type RestoreState =
  | "preparing" | "quarantined" | "migrated" | "ledger_applied" | "validated"
  | "activating" | "activated" | "complete" | "blocked" | "failed" | "discarded";
/** States that hold the durable admission fence. */
export const fencedRestoreStates: readonly RestoreState[] = Object.freeze(["preparing", "quarantined", "migrated", "ledger_applied", "validated", "blocked", "activating", "activated"]);
export const terminalRestoreStates: readonly RestoreState[] = Object.freeze(["complete", "failed", "discarded"]);
export type RestoreAction = "migrate" | "apply_ledger" | "validate" | "activate" | "discard";

export interface RestorePrepareCommand {
  kind: "restore.prepare"; requestId: string; projectId: null; expectedRevision: number;
  payload: { backupId: string; note: string };
}
/** Every later step names only the quarantine. Ledger tombstones are never accepted from a command payload. */
export interface RestoreStepCommand {
  kind: "restore.migrate" | "restore.apply_ledger" | "restore.validate" | "restore.activate" | "restore.discard";
  requestId: string; projectId: null; expectedRevision: number;
  payload: { quarantineId: string };
}
export type RestoreCommand = RestorePrepareCommand | RestoreStepCommand;

export interface RestoreCheck { name: string; pass: boolean; detail: string }
export interface RestoreStep { name: string; at: number; ok: boolean; detail: string }
export interface RestoreRequest { requestId: string; kind: RestoreCommand["kind"]; payloadHash: string; at: number }

/** Compatibility verdict recorded before anything is fenced or copied. */
export interface RestoreCompat {
  action: "direct" | "migrate" | "reject"; reason: string | null;
  backupSchema: number; currentSchema: number; minSchema: number;
  jitVersion: { backup: string; current: string; compatible: boolean; reason: string | null };
  engine: { nativeRefs: number; backupContract: string | null; backupFormatVersion: number | null; current: UpgradeEngineCheck | null; compatible: boolean; reason: string | null };
}

export interface RestoreLedgerSummary {
  source: "installation_lifecycle_ledger";
  head: number; count: number; digest: string; checkpointWrittenAt: number; established: boolean;
  deletions: number; suppressions: number; suppressedClaims: number; suppressedSources: number;
  backup: { checkpoint: string | null; position: { deletions: number; suppressions: number } | null };
}

export interface RestoreReplay {
  appliedDeletions: number; appliedSuppressions: number; ledgerOnlySuppressions: number; notInImage: number;
  purgedSources: number; purgedClaims: number; forgottenClaims: number;
  contexts: { retired: number; deletedLive: number; deleteScheduled: number; unknownCitation: number };
  deleteOperations: string[];
  jobsFenced: { id: string; projectId: string; type: string; priorState: string }[];
  attemptsFenced: number;
  deliveriesHeld: { id: string; projectId: string; priorStatus: string }[];
  /** External integrations keep the live authority: a restore never silently re-enables one. */
  integrations: { telegramBinding: "unchanged" | "adopted_live"; prMonitorsAdopted: number };
  revision: { live: number; image: number; restored: number };
}

/** Live external-integration authority captured before replay (identity and state only). */
export interface LiveIntegrations {
  binding: Record<string, unknown> | null;
  monitors: Map<string, { revision: number; state: string; record_json: string }>;
}

export interface RestoreValidation {
  checks: RestoreCheck[];
  pendingJobs: { id: string; projectId: string; state: string; reason: string }[];
  unknownOutbox: number;
  nativePending: { operationId: string; contexts: number; state: string }[];
  liveOnly: { projects: number; sources: number; contexts: number };
  quarantineSchema: number;
}

export interface RestoreJournal {
  id: string; contract: typeof restoreContract;
  backupId: string; note: string;
  state: RestoreState;
  steps: RestoreStep[];
  compat: RestoreCompat;
  quiesce: (UpgradeQuiesceResult & { disabled: string[] }) | null;
  quarantinePath: string; stagedSchema: number | null;
  artifactHash: string | null;
  /** Fenced live installation at prepare (revision and managed-state digest); activation requires it unchanged. */
  live: { revision: number; digest: string } | null;
  ledger: RestoreLedgerSummary | null;
  replay: RestoreReplay | null;
  validation: RestoreValidation | null;
  /** Managed-state digest of the validated quarantine copy; the activated installation must match it. */
  quarantineDigest: string | null;
  activation: { sessionsRevoked: boolean; nativeReconciled: boolean; fenceReleased: boolean; at: number | null };
  reconcile: (UpgradeResumeResult & { at: number }) | null;
  reason: string | null; nextAction: string;
  requests: RestoreRequest[];
  createdAt: number; updatedAt: number;
}

/** Owner report: versions, invalidated artifacts, pending/blocked items, retention limits and activation decision. */
export interface RestoreReport {
  versions: { backupJit: string; currentJit: string; backupSchema: number; currentSchema: number; quarantineSchema: number | null; engine: RestoreCompat["engine"] };
  ledger: RestoreLedgerSummary | null;
  invalidated: {
    sourcesPurged: number; claimsPurged: number; claimsForgotten: number; suppressionsApplied: number; ledgerOnlySuppressions: number;
    contextsRetired: number; contextsAlreadyDeleted: number; contextsScheduledForDeletion: number; contextsUnknownCitation: number;
    jobsFenced: number; attemptsFenced: number; deliveriesHeld: number;
    telegramBinding: "unchanged" | "adopted_live"; prMonitorsAdopted: number;
  } | null;
  pending: { jobsAwaitingOwnerResume: number; unknownDeliveries: number; nativeDeletesPending: number };
  discarded: { liveOnlyProjects: number; liveOnlySources: number; liveOnlyContexts: number };
  retention: string[];
  generation: { liveRevision: number | null; restoredRevision: number | null; sessionsRevoked: boolean };
  activation: { allowed: boolean; blockers: string[] };
}
export type RestoreEvidence = RestoreJournal & { actions: RestoreAction[]; report: RestoreReport };
export interface RestoreReceipt { quarantine: RestoreEvidence; duplicate: boolean }

/** Service control the restore drives (the managed service implements `fencedLifecycle`). */
export interface RestoreServiceControl extends UpgradeServiceControl {
  fencedLifecycle?<T>(run: (port: ApplicationRunPort) => Promise<T>): Promise<T>;
}

/** Journal boundaries where deterministic tests inject a simulated crash. */
export type RestoreFaultPoint = "fenced" | "quiesced" | "staged_copy" | "migrated" | "ledger_applied" | "validated"
  | "activation_intent" | "swapped" | "activated" | "native_reconciled" | "reconciled";

/** Fault-injection seam: models process death at a restore boundary (no cleanup, like a crash). */
export class SimulatedRestoreCrash extends Error {
  constructor(readonly point: RestoreFaultPoint) { super(`simulated restore crash at ${point}`); }
}

export interface RestoreContext {
  /** Trusted external collateral cleanup, shared with ordinary project deletion reconciliation. */
  deletionEnvironment?: import("../memory/delete").DeletionEnvironment;
  store: TransactionStore;
  restoreDir: string;
  backupDir: string;
  /** Lifecycle ledger checkpoint file (app.deletion_ledger/v1). */
  ledgerPath: string;
  port: BackupNativePort | undefined;
  /** This build's identity (`jit/<semver>`); restore refuses images from newer builds. */
  jitVersion: string;
  now(): number;
  service: RestoreServiceControl;
  authorize(tx: AppTransaction): void;
  fault?(point: RestoreFaultPoint): void;
}

/** Documented bounds; above them the restore fails closed instead of sampling. */
export const restoreLimits = Object.freeze({ rows: 200_000, journals: 50 });

const exact = (value: unknown, keys: string[]) =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const disabledWork = ["job_admission", "model_runs", "memory_extraction", "context_assembly", "pr_monitoring", "schedules", "delivery"];

/** Validates the command shape and returns its payload identity. Throws `invalid_restore_command`. */
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
  } else if (["restore.migrate", "restore.apply_ledger", "restore.validate", "restore.activate", "restore.discard"].includes(command.kind)) {
    if (!exact(command.payload, ["quarantineId"])) throw new AppError("invalid_restore_command");
    requireId((command.payload as { quarantineId: string }).quarantineId);
  } else throw new AppError("invalid_restore_command");
  return sha256(JSON.stringify([command.kind, command.expectedRevision, command.payload]));
}

export function restoreDirFor(databasePath: string): string {
  return `${databasePath}.restores`;
}

export function ownRestoreDirFor(databasePath: string, override?: string): string {
  const dir = override ?? restoreDirFor(databasePath);
  if (dirname(dir) === dir || dir.length > 1024) throw new AppError("invalid_restore_destination", 500);
  return dir;
}

/**
 * Pure schema compatibility for a backup image against this build.
 * `direct` needs no migration; `migrate` runs the OPS06 staged migration inside
 * quarantine; anything else never activates restored data.
 */
export function restoreCompat(backupSchema: number): { action: "direct" | "migrate" | "reject"; reason: string | null } {
  if (!Number.isSafeInteger(backupSchema) || backupSchema < 0) return { action: "reject", reason: "backup_corrupt" };
  if (backupSchema > currentSupportedSchema) return { action: "reject", reason: "newer_backup_unsupported" };
  if (backupSchema === currentSupportedSchema) return { action: "direct", reason: null };
  if (backupSchema < minSupportedSchema) return { action: "reject", reason: "manual_recovery_required" };
  return { action: "migrate", reason: null };
}

/**
 * Application build compatibility (`jit/<semver>`): this build restores images
 * produced by itself or an older build of the same major version. A newer
 * build (any higher major, minor or patch), another major line or an
 * unparseable identity is refused before any fence, even at an equal schema
 * number, because a newer build may write state this one cannot interpret.
 */
export function restoreAppCompat(backup: string, current: string): { compatible: boolean; reason: string | null } {
  const parse = (value: string) => {
    const match = /^jit\/(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] as const : null;
  };
  const b = parse(backup), c = parse(current);
  if (!b || !c || b.some(n => !Number.isSafeInteger(n)) || c.some(n => !Number.isSafeInteger(n))) return { compatible: false, reason: "unsupported_app_version" };
  if (b[0] !== c[0]) return { compatible: false, reason: b[0] > c[0] ? "newer_app_unsupported" : "unsupported_app_version" };
  for (let i = 1; i < 3; i++) {
    if (b[i]! > c[i]!) return { compatible: false, reason: "newer_app_unsupported" };
    if (b[i]! < c[i]!) break;
  }
  return { compatible: true, reason: null };
}

/**
 * Engine compatibility for a backup. A backup without native references does
 * not depend on the engine. Otherwise its native capture must declare the
 * supported snapshot contract and format, and the current engine port must be
 * available and declare the same (metadata only; never snapshots).
 */
export function restoreEngineCompat(manifest: Pick<BackupManifest, "native">, port: BackupNativePort | undefined): RestoreCompat["engine"] {
  const nativeRefs = manifest.native?.refs?.length ?? 0;
  const base = { nativeRefs, backupContract: manifest.native?.contract ?? null, backupFormatVersion: manifest.native?.formatVersion ?? null };
  if (nativeRefs === 0) return { ...base, current: port ? inspectUpgradeEngine(port) : null, compatible: true, reason: null };
  const current = inspectUpgradeEngine(port);
  if (base.backupContract !== upgradeEngineContract || base.backupFormatVersion !== upgradeNativeFormatVersion) {
    return { ...base, current, compatible: false, reason: "unsupported_engine" };
  }
  if (!current.compatible) return { ...base, current, compatible: false, reason: current.reason ?? "engine_unavailable" };
  return { ...base, current, compatible: true, reason: null };
}

/** Recovery choices valid for a journal's phase. */
export function restoreActions(journal: Pick<RestoreJournal, "state" | "stagedSchema" | "ledger" | "reason">): RestoreAction[] {
  switch (journal.state) {
    case "quarantined": return ["migrate", "discard"];
    case "migrated": return ["apply_ledger", "discard"];
    case "ledger_applied": return ["validate", "apply_ledger", "discard"];
    case "validated": return ["activate", "apply_ledger", "discard"];
    case "blocked":
      if (journal.reason === "activation_state_unknown") return [];
      if (journal.stagedSchema === null) return ["migrate", "discard"];
      if (!journal.ledger) return ["apply_ledger", "discard"];
      return ["apply_ledger", "validate", "discard"];
    case "activating": case "activated": return ["activate"];
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// Control-plane journal (outside the swapped database)
// ---------------------------------------------------------------------------

const journalPath = (dir: string, id: string) => join(dir, id, "journal.json");

function parseJournal(text: string, id: string): RestoreJournal {
  let journal: RestoreJournal;
  try { journal = JSON.parse(text) as RestoreJournal; } catch { throw new AppError("restore_corrupt", 500); }
  if (!journal || journal.contract !== restoreContract || journal.id !== id || !Array.isArray(journal.requests)) throw new AppError("restore_corrupt", 500);
  return journal;
}

/** Reads one journal. Throws `restore_not_found` or `restore_corrupt`. */
export function readRestore(restoreDir: string, id: string): RestoreJournal {
  requireId(id);
  let text: string;
  try { text = readFileSync(journalPath(restoreDir, id), "utf8"); } catch { throw new AppError("restore_not_found", 404); }
  return parseJournal(text, id);
}

/** Bounded journal list, oldest first; unreadable journals appear as blocked placeholders, never skipped. */
export function listRestores(restoreDir: string, limit = 50): RestoreJournal[] {
  let entries: string[];
  try { entries = readdirSync(restoreDir).filter(name => ID.test(name)); } catch { return []; }
  const journals: RestoreJournal[] = [];
  for (const id of entries) {
    try { journals.push(readRestore(restoreDir, id)); }
    catch (error) {
      if (error instanceof AppError && error.code === "restore_not_found") continue;
      journals.push(corruptPlaceholder(restoreDir, id));
    }
  }
  journals.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return journals.slice(-Math.min(Math.max(limit, 1), 100));
}

function emptyCompat(): RestoreCompat {
  return { action: "reject", reason: "restore_corrupt", backupSchema: -1, currentSchema: currentSupportedSchema, minSchema: minSupportedSchema,
    jitVersion: { backup: "unknown", current: jitAppVersion, compatible: false, reason: "restore_corrupt" },
    engine: { nativeRefs: 0, backupContract: null, backupFormatVersion: null, current: null, compatible: false, reason: "restore_corrupt" } };
}

function corruptPlaceholder(restoreDir: string, id: string): RestoreJournal {
  return { ...baseJournal(restoreDir, id, "unknown", "", emptyCompat(), 0), state: "blocked", reason: "activation_state_unknown",
    nextAction: "inspect_corrupt_restore_journal" };
}

/** The journal currently holding (or entitled to) the fence, if any. */
export function activeRestore(restoreDir: string): RestoreJournal | null {
  return listRestores(restoreDir, 100).find(j => fencedRestoreStates.includes(j.state)) ?? null;
}

/** Finds the journal that already accepted `requestId`. */
export function findRestoreRequest(restoreDir: string, requestId: string): { journal: RestoreJournal; request: RestoreRequest } | null {
  for (const journal of listRestores(restoreDir, 100)) {
    const request = journal.requests.find(r => r.requestId === requestId);
    if (request) return { journal, request };
  }
  return null;
}

function save(restoreDir: string, journal: RestoreJournal): RestoreJournal {
  try { writeFileAtomic(journalPath(restoreDir, journal.id), JSON.stringify(journal)); }
  catch { throw new AppError("restore_storage_unavailable", 503); }
  return journal;
}

function step(journal: RestoreJournal, name: string, at: number, ok: boolean, detail: string): RestoreStep[] {
  return [...journal.steps, { name, at, ok, detail }];
}

function withRequest(journal: RestoreJournal, request: RestoreRequest | null): RestoreRequest[] {
  return request && !journal.requests.some(r => r.requestId === request.requestId) ? [...journal.requests, request] : journal.requests;
}

function baseJournal(restoreDir: string, id: string, backupId: string, note: string, compat: RestoreCompat, now: number): RestoreJournal {
  return { id, contract: restoreContract, backupId, note, state: "preparing", steps: [], compat, quiesce: null,
    quarantinePath: join(restoreDir, id, "quarantine.sqlite"), stagedSchema: null, artifactHash: null, live: null,
    ledger: null, replay: null, validation: null, quarantineDigest: null,
    activation: { sessionsRevoked: false, nativeReconciled: false, fenceReleased: false, at: null },
    reconcile: null, reason: null, nextAction: "", requests: [], createdAt: now, updatedAt: now };
}

/** Builds the owner report from a journal (sanitized: identities and counts only, no payload). */
export function restoreReport(journal: RestoreJournal): RestoreReport {
  const replay = journal.replay, validation = journal.validation;
  const blockers = journal.state === "validated" ? [] : validation ? validation.checks.filter(c => !c.pass).map(c => `${c.name}:${c.detail}`)
    : [journal.reason ?? `state_${journal.state}`];
  return {
    versions: { backupJit: journal.compat.jitVersion.backup, currentJit: journal.compat.jitVersion.current,
      backupSchema: journal.compat.backupSchema, currentSchema: journal.compat.currentSchema, quarantineSchema: journal.stagedSchema, engine: journal.compat.engine },
    ledger: journal.ledger,
    invalidated: replay ? {
      sourcesPurged: replay.purgedSources, claimsPurged: replay.purgedClaims, claimsForgotten: replay.forgottenClaims,
      suppressionsApplied: replay.appliedSuppressions, ledgerOnlySuppressions: replay.ledgerOnlySuppressions,
      contextsRetired: replay.contexts.retired, contextsAlreadyDeleted: replay.contexts.deletedLive, contextsScheduledForDeletion: replay.contexts.deleteScheduled,
      contextsUnknownCitation: replay.contexts.unknownCitation ?? 0,
      jobsFenced: replay.jobsFenced.length, attemptsFenced: replay.attemptsFenced, deliveriesHeld: replay.deliveriesHeld.length,
      telegramBinding: replay.integrations?.telegramBinding ?? "unchanged", prMonitorsAdopted: replay.integrations?.prMonitorsAdopted ?? 0,
    } : null,
    pending: {
      jobsAwaitingOwnerResume: validation?.pendingJobs.length ?? replay?.jobsFenced.length ?? 0,
      unknownDeliveries: validation?.unknownOutbox ?? 0,
      nativeDeletesPending: validation?.nativePending.reduce((n, p) => n + p.contexts, 0) ?? 0,
    },
    discarded: { liveOnlyProjects: validation?.liveOnly.projects ?? 0, liveOnlySources: validation?.liveOnly.sources ?? 0, liveOnlyContexts: validation?.liveOnly.contexts ?? 0 },
    retention: [
      "the restored backup and other retained backups still hold data deleted after they were taken until retention prunes them",
      "live writes after the backup are discarded by activation (counts under discarded)",
      "native sessions are not restored from snapshots; post-backup native sessions stay with the engine and are listed as live-only contexts",
      "Telegram and provider copies are outside Jit and are not recalled",
    ],
    generation: { liveRevision: journal.live?.revision ?? null, restoredRevision: replay?.revision.restored ?? null, sessionsRevoked: journal.activation.sessionsRevoked },
    activation: { allowed: journal.state === "validated", blockers: journal.state === "validated" ? [] : blockers },
  };
}

/** Sanitized restore evidence plus valid next actions and the owner report. No secrets or payloads. */
export function restoreEvidence(journal: RestoreJournal): RestoreEvidence {
  const copy = JSON.parse(JSON.stringify(journal)) as RestoreJournal;
  return { ...copy, actions: restoreActions(copy), report: restoreReport(copy) };
}

function removeQuarantine(journal: RestoreJournal): void {
  const dir = dirname(journal.quarantinePath);
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name === "journal.json" || name.startsWith("journal.json.tmp")) continue;
    try { rmSync(join(dir, name), { force: true, recursive: true }); } catch { /* Retried on the next prune. */ }
  }
}

function pruneJournals(restoreDir: string): void {
  const journals = listRestores(restoreDir, 100).filter(j => terminalRestoreStates.includes(j.state));
  for (const journal of journals.slice(0, Math.max(0, journals.length - restoreLimits.journals))) {
    try { rmSync(join(restoreDir, journal.id), { recursive: true, force: true }); } catch { /* Retried next prune. */ }
  }
}

/**
 * Mirrors accepted requests into the installation's receipts and audit once
 * the attempt is terminal (after any swap, so activation cannot discard them).
 */
function recordAudit(ctx: RestoreContext, journal: RestoreJournal): void {
  try {
    ctx.store.transaction(tx => {
      for (const request of journal.requests) {
        tx.run("INSERT OR IGNORE INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", request.requestId, request.payloadHash,
          JSON.stringify({ restoreId: journal.id, kind: request.kind, state: journal.state }), request.at);
        tx.run("INSERT OR IGNORE INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)",
          request.kind, request.requestId, request.at);
      }
    });
  } catch { /* The control-plane journal stays the authoritative record. */ }
  pruneJournals(ctx.restoreDir);
}

/** Re-establishes this restore's fence; any other holder means another operation owns the installation. */
function ensureFence(ctx: RestoreContext, journal: RestoreJournal): void {
  // Exclusive acquisition: no-op when this restore already holds it, refused when anyone else does.
  writeUpgradeFence(ctx.store.path, journal.id, ctx.now(), "restore");
}

function releaseFence(ctx: RestoreContext, journal: RestoreJournal): void {
  clearUpgradeFence(ctx.store.path, journal.id);
}

/**
 * Durable "restore complete" predicate. `<db>.restore-pending` exists from the
 * activation intent until the restore is complete (or the intent resolves to
 * not swapped). While it exists the application serves only sanitized restore
 * status and remediation (Application gate), whatever the fence state.
 */
export function restoreGatePath(databasePath: string): string {
  return `${databasePath}.restore-pending`;
}

/** The restore id holding the read gate, `unknown` for an unreadable gate, or null when normal service is allowed. */
export function readRestoreGate(databasePath: string): string | null {
  const path = restoreGatePath(databasePath);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { contract?: unknown; restoreId?: unknown };
    if (parsed?.contract === restoreContract && typeof parsed.restoreId === "string") return parsed.restoreId;
  } catch { /* Unreadable gate still gates. */ }
  return "unknown";
}

function writeRestoreGate(databasePath: string, restoreId: string): void {
  if (readRestoreGate(databasePath) === restoreId) return;
  try { writeFileAtomic(restoreGatePath(databasePath), JSON.stringify({ contract: restoreContract, restoreId })); }
  catch { throw new AppError("restore_storage_unavailable", 503); }
}

function clearRestoreGate(databasePath: string, restoreId: string): void {
  if (readRestoreGate(databasePath) !== restoreId) return;
  try { rmSync(restoreGatePath(databasePath), { force: true }); } catch { throw new AppError("restore_storage_unavailable", 503); }
}

async function safeResume(ctx: RestoreContext): Promise<UpgradeResumeResult> {
  try { return await ctx.service.resume(); }
  catch (error) { return { reconciled: false, detail: error instanceof AppError ? error.code : "service_resume_failed" }; }
}

function withQuarantine<T>(path: string, migrate: boolean, fn: (store: TransactionStore) => T): T {
  const staged = new TransactionStore(path, { migrateExisting: migrate });
  try { return fn(staged); } finally { staged.close(); }
}

const readSchema = (tx: AppTransaction) => tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
const readRevision = (tx: AppTransaction) => tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")?.revision ?? 0;

function hasTable(tx: AppTransaction, name: string): boolean {
  return !!tx.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name);
}

function boundedCount(tx: AppTransaction, table: string): number {
  const n = tx.get<{ n: number }>(`SELECT count(*) AS n FROM "${table}"`)!.n;
  if (n > restoreLimits.rows) throw new AppError("restore_bound_exceeded", 409);
  return n;
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

/**
 * restore.prepare. The manifest, app/schema compatibility, engine contract and
 * artifact integrity are checked first; a rejection writes a `failed` journal
 * with a visible next action and leaves the backup untouched. A compatible
 * backup then takes the shared admission fence (holder `restore`), quiesces
 * the service (queue, model runs, extraction, context assembly, monitoring,
 * schedules and deliveries stop), records the fenced live digest and writes a
 * hash-verified copy of the image into quarantine. Nothing restored is opened
 * by any worker.
 */
export async function prepareRestore(ctx: RestoreContext, input: { request: RestoreRequest; backupId: string; note: string; upgradeActive: boolean }): Promise<RestoreJournal> {
  const now = ctx.now();
  const fence = readUpgradeFence(ctx.store.path);
  if (fence) throw new AppError(fence.holder === "restore" ? "restore_in_progress" : "upgrade_in_progress", 409);
  if (input.upgradeActive) throw new AppError("upgrade_in_progress", 409);
  if (activeRestore(ctx.restoreDir)) throw new AppError("restore_in_progress", 409);
  const row = ctx.store.read(tx => { ctx.authorize(tx); return tx.get<{ record_json: string }>("SELECT record_json FROM ops_backups WHERE id = ?", input.backupId); });
  if (!row) throw new AppError("backup_not_found", 404);
  const id = randomUUID();
  const fail = (compat: RestoreCompat, reason: string, nextAction: string, code = reason, status = 409): never => {
    const failed = save(ctx.restoreDir, { ...baseJournal(ctx.restoreDir, id, input.backupId, input.note, compat, now), state: "failed",
      steps: [{ name: "preflight", at: now, ok: false, detail: reason }], reason, nextAction, requests: [input.request] });
    recordAudit(ctx, failed);
    throw new AppError(code, status);
  };
  let manifest: BackupManifest;
  try {
    manifest = validateManifestRecord(JSON.parse(row.record_json));
    if (manifest.id !== input.backupId) throw new AppError("backup_corrupt", 500);
  } catch {
    return fail(emptyCompat(), "backup_corrupt", "inspect_backup_registry_entry_then_choose_another_backup", "backup_corrupt", 500);
  }
  const schema = restoreCompat(manifest.appSchema);
  const app = restoreAppCompat(manifest.jitVersion, ctx.jitVersion);
  const engine = restoreEngineCompat(manifest, ctx.port);
  const compat: RestoreCompat = { action: schema.action === "reject" || !app.compatible || !engine.compatible ? "reject" : schema.action,
    reason: schema.reason ?? app.reason ?? engine.reason, backupSchema: manifest.appSchema, currentSchema: currentSupportedSchema, minSchema: minSupportedSchema,
    jitVersion: { backup: manifest.jitVersion, current: ctx.jitVersion, ...app }, engine };
  if (!app.compatible) {
    return fail(compat, app.reason!, app.reason === "newer_app_unsupported" ? "keep_backup_and_restore_with_the_build_that_produced_it_or_newer"
      : "manual_recovery_required_keep_backup", app.reason!);
  }
  if (schema.action === "reject") {
    return fail(compat, schema.reason!, schema.reason === "newer_backup_unsupported" ? "keep_backup_and_restore_with_a_build_supporting_its_schema"
      : "manual_recovery_required_keep_backup", schema.reason === "newer_backup_unsupported" ? "newer_backup_unsupported" : "backup_unrestorable");
  }
  // Manifest completeness and managed-file integrity before the engine contract (both before any fence or copy).
  try { assertRestorableBackup(manifest, ctx.backupDir); }
  catch (error) {
    const code = error instanceof AppError ? error.code : "backup_integrity_failed";
    return fail(compat, code, code === "backup_incomplete" ? "choose_a_complete_verified_backup" : "inspect_backup_artifact_then_choose_another_backup", code);
  }
  if (!engine.compatible) {
    return fail(compat, engine.reason!, "configure_supported_engine_snapshot_contract_then_prepare_again",
      engine.reason === "unsupported_engine" ? "unsupported_engine" : "engine_unavailable");
  }
  let journal = save(ctx.restoreDir, { ...baseJournal(ctx.restoreDir, id, input.backupId, input.note, compat, now),
    steps: [{ name: "preflight", at: now, ok: true, detail: `schema_${manifest.appSchema}_${schema.action}` }],
    artifactHash: manifest.artifact.hash, nextAction: "wait_for_quiesce_and_quarantine_copy", requests: [input.request] });
  try { writeUpgradeFence(ctx.store.path, id, now, "restore"); }
  catch (error) {
    // Lost the exclusive acquisition to a concurrent upgrade or restore: this attempt never held the fence.
    const code = error instanceof AppError ? error.code : "restore_storage_unavailable";
    removeQuarantine(journal);
    const failed = save(ctx.restoreDir, { ...journal, state: "failed", steps: step(journal, "fence", now, false, code), reason: code,
      nextAction: "wait_for_the_other_installation_operation_then_prepare_again", updatedAt: now });
    recordAudit(ctx, failed);
    throw error;
  }
  journal = save(ctx.restoreDir, { ...journal, steps: step(journal, "fence", now, true, "admission_fenced") });
  ctx.fault?.("fenced");
  let phase = "quiesce";
  try {
    const quiesce = await ctx.service.quiesce();
    journal = save(ctx.restoreDir, { ...journal, quiesce: { ...quiesce, disabled: [...disabledWork] },
      steps: step(journal, "quiesce", ctx.now(), quiesce.settled, quiesce.detail), updatedAt: ctx.now() });
    if (!quiesce.settled) throw new AppError("restore_quiesce_incomplete", 409);
    ctx.fault?.("quiesced");
    phase = "quarantine_copy";
    const live = ctx.store.read(tx => ({ revision: readRevision(tx), digest: managedStateDigest(tx) }));
    let bytes: Uint8Array;
    try { bytes = readFileSync(manifest.artifact.path); } catch { throw new AppError("backup_artifact_missing", 409); }
    if (sha256(bytes) !== manifest.artifact.hash || bytes.length !== manifest.artifact.bytes) throw new AppError("backup_integrity_failed", 409);
    try { writeFileAtomic(journal.quarantinePath, bytes); } catch { throw new AppError("restore_storage_unavailable", 503); }
    ctx.fault?.("staged_copy");
    if (sha256(readFileSync(journal.quarantinePath)) !== manifest.artifact.hash) throw new AppError("restore_quarantine_copy_mismatch", 409);
    journal = save(ctx.restoreDir, { ...journal, state: "quarantined", live,
      steps: step(journal, "quarantine_copy", ctx.now(), true, `verified_${bytes.length}_bytes`), reason: null,
      nextAction: schema.action === "migrate" ? "migrate_quarantine_to_current_schema" : "migrate_quarantine_not_required_run_migrate_to_verify",
      updatedAt: ctx.now() });
    return journal;
  } catch (error) {
    if (error instanceof SimulatedRestoreCrash) throw error;
    const reason = error instanceof AppError && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : `interrupted_at_${phase}`;
    await failBeforeActivation(ctx, journal, phase, reason, "inspect_failure_then_prepare_again");
    throw error instanceof AppError ? error : new AppError(reason, 500);
  }
}

/** Ends an attempt that never activated: journal terminal, quarantine removed, fence released, service resumed. */
async function failBeforeActivation(ctx: RestoreContext, journal: RestoreJournal, phase: string, reason: string, nextAction: string,
  state: "failed" | "discarded" = "failed", request: RestoreRequest | null = null): Promise<RestoreJournal> {
  const now = ctx.now();
  removeQuarantine(journal);
  let ended = save(ctx.restoreDir, { ...journal, state, steps: step(journal, phase, now, state === "discarded", reason), reason, nextAction,
    requests: withRequest(journal, request), updatedAt: now });
  releaseFence(ctx, ended);
  const resumed = await safeResume(ctx);
  ended = save(ctx.restoreDir, { ...ended, reconcile: { ...resumed, at: ctx.now() } });
  recordAudit(ctx, ended);
  return ended;
}

// ---------------------------------------------------------------------------
// Migrate
// ---------------------------------------------------------------------------

/**
 * restore.migrate: applies this build's ops.schema_migrations/v1 migrations to
 * the quarantine copy only and proves every pre-migration table, column and
 * row survives (projection digests), plus foreign keys. A current-schema copy
 * is verified without migration. Failure blocks the quarantine; the backup
 * stays recoverable and the live installation is untouched.
 */
export function migrateRestore(ctx: RestoreContext, journal: RestoreJournal, request: RestoreRequest | null): RestoreJournal {
  if (!(journal.state === "quarantined" || (journal.state === "blocked" && journal.stagedSchema === null && journal.live))) throw new AppError("restore_bad_state", 409);
  ensureFence(ctx, journal);
  const now = ctx.now();
  const block = (reason: string, detail: string): never => {
    save(ctx.restoreDir, { ...journal, state: "blocked", steps: step(journal, "migrate", now, false, detail), reason,
      stagedSchema: null, nextAction: "discard_quarantine_and_keep_backup_or_retry_migrate", requests: withRequest(journal, request), updatedAt: now });
    throw new AppError(reason, 409);
  };
  let before: { schema: number; tables: { name: string; columns: string[]; hash: string }[] };
  try {
    before = withQuarantine(journal.quarantinePath, false, staged => staged.read(tx => ({
      schema: readSchema(tx),
      tables: managedTables(tx).map(t => ({ name: t.name, columns: t.columns, hash: tableDigest(tx, t.name, t.columns).hash })),
    })));
  } catch { return block("quarantine_unreadable", "quarantine_unreadable"); }
  if (before.schema !== journal.compat.backupSchema) return block("quarantine_schema_mismatch", `schema_${before.schema}`);
  let after: { schema: number; lost: string[]; fk: number };
  try {
    after = withQuarantine(journal.quarantinePath, true, staged => staged.read(tx => {
      const tables = new Map(managedTables(tx).map(t => [t.name, t]));
      const lost: string[] = [];
      for (const table of before.tables) {
        const target = tables.get(table.name);
        if (!target || table.columns.some(c => !target.columns.includes(c))) { lost.push(`${table.name}_dropped`); continue; }
        if (tableDigest(tx, table.name, table.columns).hash !== table.hash) lost.push(`${table.name}_changed`);
      }
      return { schema: readSchema(tx), lost, fk: tx.all("PRAGMA foreign_key_check").length };
    }));
  } catch { return block("quarantine_migration_failed", "quarantine_migration_failed"); }
  if (after.schema !== currentSupportedSchema) return block("quarantine_migration_failed", `schema_${after.schema}`);
  if (after.lost.length) return block("quarantine_migration_failed", after.lost.slice(0, 8).join(","));
  if (after.fk) return block("quarantine_migration_failed", "foreign_key_violations");
  const migrated = save(ctx.restoreDir, { ...journal, state: "migrated", stagedSchema: after.schema,
    steps: step(journal, "migrate", now, true, before.schema === after.schema ? "not_required_schema_current" : `schema_${before.schema}_to_${after.schema}`),
    reason: null, nextAction: "apply_latest_installation_ledger", requests: withRequest(journal, request), updatedAt: now });
  ctx.fault?.("migrated");
  return migrated;
}

// ---------------------------------------------------------------------------
// Ledger replay
// ---------------------------------------------------------------------------

function trustedSummary(trusted: Extract<TrustedLedger, { state: "trusted" }>, manifest: BackupManifest | null): RestoreLedgerSummary {
  const view = ledgerView(trusted.entries);
  return { source: "installation_lifecycle_ledger", head: trusted.head, count: trusted.count, digest: trusted.digest,
    checkpointWrittenAt: trusted.writtenAt, established: trusted.established,
    deletions: view.deletions.length, suppressions: view.suppressions.length,
    suppressedClaims: view.suppressedClaims.length, suppressedSources: view.suppressedSources.length,
    backup: { checkpoint: manifest?.lifecycle?.checkpoint ?? null, position: manifest?.lifecycle?.position ?? null } };
}

function liveManifest(ctx: RestoreContext, backupId: string): BackupManifest | null {
  const row = ctx.store.read(tx => tx.get<{ record_json: string }>("SELECT record_json FROM ops_backups WHERE id = ?", backupId));
  if (!row) return null;
  try { return validateManifestRecord(JSON.parse(row.record_json)); } catch { return null; }
}

/** Context identities a pending, blocked or failed deletion operation still has to delete. */
function openDeletionContexts(tx: AppTransaction): Set<string> {
  const open = new Set<string>();
  for (const op of tx.all<{ record_json: string }>("SELECT record_json FROM deletion_operations WHERE state IN ('pending', 'blocked')")) {
    try {
      for (const c of (JSON.parse(op.record_json) as DeletionOperation).contexts ?? []) if (c.state !== "deleted") open.add(`${c.id}:${c.generation}`);
    } catch { /* Unreadable operations surface through validation. */ }
  }
  return open;
}

/** Context states that still hold native data (a `missing` context was reported absent by the engine). */
const undeletedStates = new Set(["pending", "delete_failed", "retire_failed"]);

/** Opens one budgeted app.data_lifecycle/v1 deletion operation for restored contexts (managed delete through the run port). */
function scheduleRestoreDeletion(tx: AppTransaction, projectId: string, contexts: { id: string; generation: number }[], now: number, reason: string): string {
  const operationId = randomUUID();
  const operation = {
    id: operationId, contract: "app.data_deletion_operation/v1", projectId, previewId: `restore-replay:${operationId}`,
    scope: { kind: "source", projectId, source: { sourceId: "restore-ledger-replay", revision: 1, generation: 1 } },
    state: "pending", attempts: 0, maxAttempts: 5, tombstones: [],
    contexts: contexts.map(c => ({ ...c, state: "pending", attempts: 0, reason, nextAction: "reconcile_managed_delete_then_verify", updatedAt: now })),
    exports: [], scopes: [], backupsRetained: [],
    residuals: ["telegram_delivery_copies_not_deleted", "provider_session_copies_not_deleted", "retained_backups_require_retention_purge"],
    reason: "native_sessions_pending_managed_delete", nextAction: "reconcile_managed_delete_then_verify", createdAt: now, updatedAt: now,
  };
  tx.run("INSERT INTO deletion_operations (id, project_id, preview_id, state, attempts, record_json) VALUES (?, ?, ?, 'pending', 0, ?)",
    operationId, projectId, operation.previewId, JSON.stringify(operation));
  return operationId;
}

/** Every deletion operation (budget-exhausted included) still holding native or project-local collateral. */
function undeletedOperations(tx: AppTransaction): { id: string; state: string; projectId: string; contexts: { id: string; generation: number }[] }[] {
  return tx.all<{ id: string; state: string; projectId: string; json: string }>(
    "SELECT id, state, project_id AS projectId, record_json AS json FROM deletion_operations WHERE state IN ('pending', 'blocked', 'failed')")
    .flatMap(op => {
      try {
        const operation = JSON.parse(op.json) as DeletionOperation;
        const localPending = operation.databasePurge === "pending" || operation.collateral?.some(c => c.state !== "purged") || operation.exports?.some(e => e.state !== "purged");
        const contexts = (operation.contexts ?? []).filter(c => undeletedStates.has(c.state))
          .filter(c => tx.get<{ state: string }>("SELECT state FROM team_contexts WHERE id = ? AND generation = ?", c.id, c.generation)?.state !== "deleted");
        return contexts.length || localPending ? [{ id: op.id, state: op.state, projectId: op.projectId, contexts: contexts.map(c => ({ id: c.id, generation: c.generation })) }] : [];
      } catch { return [{ id: op.id, state: op.state, projectId: op.projectId, contexts: [] }]; }
    });
}

/**
 * Replays the latest trusted ledger into the quarantine copy (one transaction).
 * Identity-only: payloads come from the image itself and are purged, never
 * read from the ledger. Returns the replay summary.
 */
function replayLedger(staged: TransactionStore, entries: LifecycleLedgerEntry[], liveContexts: Map<string, string>, live: LiveIntegrations,
  liveRevision: number, now: number): RestoreReplay {
  const view = ledgerView(entries);
  // Purged payload bytes are zeroed in the quarantine file, not left in freed page space.
  staged.read(tx => tx.run("PRAGMA secure_delete = ON"));
  return staged.transaction(tx => {
    const projectExists = (id: string) => !!tx.get("SELECT 1 FROM projects WHERE id = ?", id);
    // Deny lookups inside quarantine see the full latest ledger (the live table replaces this copy at activation).
    for (const entry of entries) {
      tx.run("INSERT OR IGNORE INTO lifecycle_ledger (kind, entry_key, subject, project_id, record_json, recorded_at) VALUES (?, ?, ?, ?, ?, ?)",
        entry.kind, entry.key, entry.subject, entry.projectId, JSON.stringify(entry.record), entry.recordedAt);
    }
    const replay: RestoreReplay = { appliedDeletions: 0, appliedSuppressions: 0, ledgerOnlySuppressions: 0, notInImage: 0,
      purgedSources: 0, purgedClaims: 0, forgottenClaims: 0, contexts: { retired: 0, deletedLive: 0, deleteScheduled: 0, unknownCitation: 0 },
      deleteOperations: [], jobsFenced: [], attemptsFenced: 0, deliveriesHeld: [],
      integrations: { telegramBinding: "unchanged", prMonitorsAdopted: 0 },
      revision: { live: liveRevision, image: readRevision(tx), restored: 0 } };
    const needles = new Set<string>();
    const needle = (value: unknown) => { if (typeof value === "string" && Array.from(value).length >= 8 && value !== redactedText) needles.add(value); };
    const deletedClaims = new Set<string>(), deletedSources = new Set<string>(), suppressedClaims = new Set<string>(), suppressedSources = new Set<string>();
    const projects = new Set<string>();
    for (const d of view.projectDeletions) {
      if (!projectExists(d.projectId)) { replay.notInImage++; continue; }
      projects.add(d.projectId);
      for (const row of tx.all<{ sourceId: string; revision: number; generation: number; text: string | null }>("SELECT v.source_id AS sourceId, v.revision, v.generation, v.content_text AS text FROM source_versions v JOIN sources s ON s.id = v.source_id WHERE s.project_id = ?", d.projectId)) {
        deletedSources.add(`${row.sourceId}:${row.revision}:${row.generation}`); needle(row.text);
      }
      for (const row of tx.all<{ id: string }>("SELECT id FROM memory_claims WHERE project_id = ?", d.projectId)) deletedClaims.add(row.id);
      purgeProjectPayloads(tx, d.projectId, now);
      replay.appliedDeletions++;
    }
    for (const d of view.deletions) {
      if (d.kind === "source") deletedSources.add(`${d.sourceId}:${d.revision}:${d.generation}`); else deletedClaims.add(d.claimId!);
      if (!projectExists(d.projectId)) { replay.notInImage++; continue; }
      projects.add(d.projectId);
      if (d.kind === "source") {
        const version = tx.get<{ text: string | null }>("SELECT content_text AS text FROM source_versions WHERE source_id = ? AND revision = ? AND generation = ?",
          d.sourceId, d.revision, d.generation);
        if (version) {
          needle(version.text);
          if (version.text !== null) replay.purgedSources++;
          tx.run("UPDATE source_versions SET content_text = NULL WHERE source_id = ? AND revision = ? AND generation = ?", d.sourceId, d.revision, d.generation);
          tx.run("UPDATE sources SET availability = 'unavailable' WHERE id = ? AND current_revision = ? AND generation = ?", d.sourceId, d.revision, d.generation);
        }
      } else {
        const stored = tx.get<{ record_json: string }>("SELECT record_json FROM memory_claims WHERE id = ?", d.claimId)?.record_json;
        if (stored) {
          try {
            const claim = JSON.parse(stored) as { text?: unknown; quote?: unknown; status?: unknown };
            needle(claim.text); needle(claim.quote);
            if (claim.status !== "deleted" || claim.text !== redactedText) {
              tx.run("UPDATE memory_claims SET record_json = ? WHERE id = ?", JSON.stringify({ ...claim, status: "deleted", text: redactedText, quote: redactedText }), d.claimId);
              replay.purgedClaims++;
            }
          } catch { /* The ledger entry still denies every consumer. */ }
        }
      }
      const before = tx.get<{ n: number }>("SELECT count(*) AS n FROM deletion_ledger")!.n;
      tx.run("INSERT OR IGNORE INTO deletion_ledger (id, operation_id, project_id, kind, source_id, claim_id, revision, generation, deleted_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        d.id, d.operationId, d.projectId, d.kind, d.sourceId, d.claimId, d.revision, d.generation, d.deletedAt);
      if (tx.get<{ n: number }>("SELECT count(*) AS n FROM deletion_ledger")!.n > before) replay.appliedDeletions++;
    }
    for (const c of view.suppressedClaims) suppressedClaims.add(c.claimId);
    for (const s of view.suppressedSources) suppressedSources.add(`${s.sourceId}:${s.revision}:${s.generation}`);
    for (const s of view.suppressions) {
      suppressedClaims.add(s.claimId);
      const claims = view.suppressedClaims.filter(c => c.suppressionId === s.id);
      const sources = view.suppressedSources.filter(c => c.suppressionId === s.id);
      for (const c of [{ claimId: s.claimId }, ...claims]) {
        const stored = tx.get<{ record_json: string }>("SELECT record_json FROM memory_claims WHERE id = ?", c.claimId)?.record_json;
        if (!stored) continue;
        try {
          const claim = JSON.parse(stored) as { status?: unknown };
          if (claim.status === "active") { tx.run("UPDATE memory_claims SET record_json = ? WHERE id = ?", JSON.stringify({ ...claim, status: "forgotten" }), c.claimId); replay.forgottenClaims++; }
        } catch { /* The ledger entry still denies every consumer. */ }
      }
      if (tx.get("SELECT 1 FROM memory_suppressions WHERE id = ?", s.id)) continue;
      const root = tx.get<{ revision: number; generation: number }>("SELECT revision, generation FROM memory_claims WHERE id = ? AND project_id = ?", s.claimId, s.projectId);
      if (!root || !projectExists(s.projectId)) { replay.ledgerOnlySuppressions++; continue; }
      projects.add(s.projectId);
      const withdrawn = claims.flatMap(c => {
        const row = tx.get<{ revision: number; generation: number }>("SELECT revision, generation FROM memory_claims WHERE id = ? AND project_id = ?", c.claimId, c.projectId);
        return row ? [{ projectId: c.projectId, claimId: c.claimId, revision: row.revision, generation: row.generation }] : [];
      });
      const lineage = sources.filter(c => !!tx.get("SELECT 1 FROM sources WHERE id = ? AND project_id = ?", c.sourceId, c.projectId));
      tx.run("INSERT INTO memory_suppressions (id, project_id, claim_id, record_json) VALUES (?, ?, ?, ?)", s.id, s.projectId, s.claimId,
        JSON.stringify({ id: s.id, projectId: s.projectId, claimId: s.claimId, fromRevision: s.fromRevision ?? root.revision, fromGeneration: s.fromGeneration ?? root.generation,
          withdrawn, sources: lineage.map(c => ({ projectId: c.projectId, source: { sourceId: c.sourceId, revision: c.revision, generation: c.generation } })),
          contexts: [], overlaps: [], reason: "(restored from the installation lifecycle ledger)", acknowledged: true,
          ownerRevision: 0, projectRevision: 0, createdAt: s.createdAt }));
      for (const c of withdrawn) tx.run("INSERT OR IGNORE INTO memory_suppressed_claims VALUES (?, ?, ?)", s.id, c.projectId, c.claimId);
      for (const c of lineage) tx.run("INSERT OR IGNORE INTO memory_suppressed_sources VALUES (?, ?, ?, ?, ?)", s.id, c.projectId, c.sourceId, c.revision, c.generation);
      replay.appliedSuppressions++;
    }
    // Derived invalidation: the deletion inventory's own job evidence (runs, syntheses, extractions, attempts) classifies
    // every managed native context; opaque or manifest-less owners are unknown and handled like deleted (fail closed).
    const citations = contextCitations(tx, { sources: deletedSources, claims: deletedClaims, projects: new Set(view.projectDeletions.map(d => d.projectId)) }, { sources: suppressedSources, claims: suppressedClaims });
    if (citations.blockers.length) throw new AppError("restore_context_inventory_blocked", 409);
    const contextAction = new Map(citations.contexts.map(c => [c.id, c]));
    replay.contexts.unknownCitation = citations.contexts.filter(c => c.cites === "unknown").length;
    try { fenceStaleContexts(tx, now); } catch { /* Wholesale job fencing below still denies commit authority. */ }
    for (const project of projects) {
      try { fenceUnavailableExtractions(tx, project, now); } catch { /* Same. */ }
    }
    // Quoted copies of purged payloads in run records, syntheses, jobs and free text.
    for (const table of ["team_runs", "coordinator_syntheses", "jobs"] as const) {
      for (const row of tx.all<{ rowid_: number; json: string }>(`SELECT rowid AS rowid_, record_json AS json FROM ${table}`)) {
        let changed = false;
        const parsed = (() => { try { return JSON.parse(row.json) as unknown; } catch { return null; } })();
        if (!parsed || typeof parsed !== "object") continue;
        const redact = (node: unknown): unknown => {
          if (Array.isArray(node)) return node.map(redact);
          if (!node || typeof node !== "object") return node;
          return Object.fromEntries(Object.entries(node as Record<string, unknown>).map(([key, item]) => {
            // app.role_proposals/v1: the typed rule (Jit text only; owner revisions and routes stay) closes open cards.
            if (key === "roleProposals") {
              const proposals = redactRoleProposals(item, text => needles.has(text) ? redactedText : text);
              if (proposals.changed) changed = true;
              return [key, proposals.value];
            }
            if (key === "promotionProposal") {
              const proposal = redactPromotionProposal(item, text => needles.has(text) ? redactedText : text);
              if (proposal.changed) changed = true;
              return [key, proposal.value];
            }
            if (typeof item === "string" && needles.has(item)) { changed = true; return [key, redactedText]; }
            return [key, redact(item)];
          }));
        };
        const next = JSON.stringify(redact(parsed));
        if (changed) tx.run(`UPDATE ${table} SET record_json = ? WHERE rowid = ?`, next, row.rowid_);
      }
    }
    // Lineage-bound copies (producing runs, stored manifests, receipts), exactly as a deletion confirm redacts them.
    const replayedSources = view.deletions.filter(d => d.kind === "source" && projectExists(d.projectId))
      .map(d => ({ projectId: d.projectId, source: { sourceId: d.sourceId!, revision: d.revision, generation: d.generation } }));
    redactReplayedLineage(tx, replayedSources, deletedClaims);
    for (const entry of replayedSources) {
      for (const proposal of tx.all<{ id: string; taskId: string }>("SELECT id, task_id AS taskId FROM task_proposals WHERE source_id = ? AND source_revision = ? AND source_generation = ?",
        entry.source.sourceId, entry.source.revision, entry.source.generation)) {
        tx.run("UPDATE task_proposals SET title = ?, summary = ? WHERE id = ?", redactedText, redactedText, proposal.id);
        tx.run("UPDATE tasks SET title = ?, summary = ? WHERE id = ? AND current_proposal_id = ?", redactedText, redactedText, proposal.taskId, proposal.id);
      }
    }
    const scrub = [...needles].sort();
    for (let i = 0; i < scrub.length; i += 500) {
      scrubFreeTextOccurrences(tx, scrub.slice(i, i + 500));
      scrubOutputSources(tx, scrub.slice(i, i + 500));
    }
    // Local notification copies quoting a purged payload (they are also held below and never sent automatically).
    for (const table of ["delivery_intents", "delivery_reports"] as const) {
      // `sequence`/`id` may alias the rowid; select it under an explicit alias.
      for (const row of tx.all<{ rowid_: number; json: string }>(`SELECT rowid AS rowid_, record_json AS json FROM ${table}`)) {
        let next = row.json;
        for (const term of scrub) if (next.includes(term)) next = next.split(term).join(redactedText);
        if (next !== row.json) tx.run(`UPDATE ${table} SET record_json = ? WHERE rowid = ?`, next, row.rowid_);
      }
    }
    // Native contexts: adopt the live lifecycle (it is newer), retire suppressed, schedule managed deletion of deleted/unknown.
    const pendingByProject = new Map<string, { id: string; generation: number }[]>();
    const covered = openDeletionContexts(tx);
    for (const context of tx.all<{ id: string; generation: number; state: string }>("SELECT id, generation, state FROM team_contexts")) {
      if (context.state === "deleted") continue;
      const live = liveContexts.get(`${context.id}:${context.generation}`);
      if (live === "deleted") {
        tx.run("UPDATE team_contexts SET state = 'deleted' WHERE id = ? AND generation = ?", context.id, context.generation);
        replay.contexts.deletedLive++;
        continue;
      }
      const citation = contextAction.get(context.id);
      const nextState = live === "delete_failed" || context.state === "delete_failed" ? "delete_failed" : citation || live === "retired" ? "retired" : context.state;
      if (nextState !== context.state) {
        tx.run("UPDATE team_contexts SET state = ? WHERE id = ? AND generation = ?", nextState, context.id, context.generation);
        replay.contexts.retired++;
      }
      if (citation && citation.cites !== "suppressed" && !covered.has(`${context.id}:${context.generation}`)) {
        const list = pendingByProject.get(citation.projectId) ?? [];
        list.push({ id: context.id, generation: context.generation });
        pendingByProject.set(citation.projectId, list);
      }
    }
    for (const [projectId, contexts] of pendingByProject) {
      replay.deleteOperations.push(scheduleRestoreDeletion(tx, projectId, contexts, now, "restore_ledger_replay"));
      replay.contexts.deleteScheduled += contexts.length;
    }
    for (const op of tx.all<{ id: string }>("SELECT id FROM deletion_operations WHERE state IN ('pending', 'blocked')")) {
      try { refreshOperationState(tx, op.id, now); } catch { /* Validation reports unreadable operations. */ }
    }
    // Jobs: nothing restored runs by itself. Every non-terminal job loses commit authority and waits for an explicit owner resume.
    for (const row of tx.all<{ id: string; projectId: string; state: string; json: string }>(
      "SELECT id, project_id AS projectId, state, record_json AS json FROM jobs WHERE state IN ('queued', 'admitted', 'waiting') OR occupies = 1")) {
      let job: Job;
      try { job = JSON.parse(row.json) as Job; } catch { continue; }
      const active = tx.all<{ n: number }>("SELECT 1 AS n FROM job_attempts WHERE job_id = ? AND json_extract(record_json, '$.state') IN ('prepared', 'dispatched')", row.id).length;
      invalidateJob(tx, row.id, "interrupted", now);
      replay.attemptsFenced += active;
      if (["succeeded", "partial", "failed", "blocked"].includes(job.state)) { tx.run("UPDATE jobs SET occupies = 0 WHERE id = ?", row.id); continue; }
      replay.jobsFenced.push({ id: row.id, projectId: row.projectId, type: job.type, priorState: job.state });
      job.state = "waiting"; job.reason = "interrupted"; job.revision++; job.updatedAt = Math.max(job.updatedAt, now);
      job.occupiesAdmission = false; job.nextAction = "inspect_restored_job_then_resume_explicitly";
      job.remaining.wallMs = Math.max(0, job.deadlineAt - job.updatedAt);
      tx.run("UPDATE jobs SET state = 'waiting', occupies = 0, record_json = ? WHERE id = ?", JSON.stringify(job), row.id);
    }
    // Outbox: a restored unsent notification may already have been sent after the backup; never replay it blindly.
    for (const row of tx.all<{ id: string; projectId: string; json: string }>("SELECT id, project_id AS projectId, record_json AS json FROM delivery_intents")) {
      let intent: { status?: string; retryable?: boolean; remote?: string; revision?: number; nextAction?: string; updatedAt?: number };
      try { intent = JSON.parse(row.json); } catch { continue; }
      const unsent = ["waiting", "queued", "claimed"].includes(intent.status ?? "") || (intent.status === "failed" && intent.retryable === true);
      if (!unsent) continue;
      replay.deliveriesHeld.push({ id: row.id, projectId: row.projectId, priorStatus: intent.status ?? "unknown" });
      tx.run("UPDATE delivery_intents SET record_json = ? WHERE id = ?", JSON.stringify({ ...intent, status: "unknown",
        remote: intent.remote === "none" || !intent.remote ? "uncertain" : intent.remote, retryable: false, failureReason: "restored_outcome_unknown",
        nextAction: "inspect_restored_intent_then_resend_explicitly", revision: (intent.revision ?? 0) + 1, updatedAt: Math.max(intent.updatedAt ?? 0, now) }), row.id);
    }
    for (const row of tx.all<{ id: string; json: string }>("SELECT id, record_json AS json FROM delivery_attempts")) {
      let attempt: { state?: string; outcome?: string };
      try { attempt = JSON.parse(row.json); } catch { continue; }
      if (!["authorized", "claimed", "sending"].includes(attempt.state ?? "")) continue;
      tx.run("UPDATE delivery_attempts SET record_json = ? WHERE id = ?", JSON.stringify({ ...attempt, state: "interrupted",
        outcome: attempt.outcome === "none" ? "unknown" : attempt.outcome, reason: "restored_attempt_fenced" }), row.id);
    }
    // External integrations: a binding or monitor revoked/paused after the backup is never re-enabled by the restore.
    if (live.binding && hasTable(tx, "telegram_binding")) {
      const image = tx.get<Record<string, unknown>>("SELECT * FROM telegram_binding WHERE id = 1");
      const differs = !image || ["state", "telegram_user_id", "telegram_chat_id", "revision"].some(key => image[key] !== live.binding![key]);
      if (differs) {
        const b = live.binding;
        tx.run(`INSERT INTO telegram_binding (id, revision, state, telegram_user_id, telegram_chat_id, username_hint, challenge_nonce, challenge_expires_at, bound_at, proof_json)
          VALUES (1, ?, ?, ?, ?, ?, NULL, NULL, ?, ?) ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, state = excluded.state,
          telegram_user_id = excluded.telegram_user_id, telegram_chat_id = excluded.telegram_chat_id, username_hint = excluded.username_hint,
          challenge_nonce = NULL, challenge_expires_at = NULL, bound_at = excluded.bound_at, proof_json = excluded.proof_json`,
        Math.max(Number(image?.revision ?? 0), Number(b.revision ?? 0)) + 1, String(b.state ?? "unbound"), (b.telegram_user_id ?? null) as number | null,
        (b.telegram_chat_id ?? null) as number | null, (b.username_hint ?? null) as string | null, (b.bound_at ?? null) as number | null, String(b.proof_json ?? "{}"));
        replay.integrations.telegramBinding = "adopted_live";
      }
    }
    if (hasTable(tx, "pr_monitors")) {
      for (const monitor of tx.all<{ id: string; revision: number; record_json: string }>("SELECT id, revision, record_json FROM pr_monitors WHERE state = 'active'")) {
        const current = live.monitors.get(monitor.id);
        if (current?.state === "active") continue;
        if (current) {
          tx.run("UPDATE pr_monitors SET revision = ?, state = ?, record_json = ? WHERE id = ?", current.revision, current.state, current.record_json, monitor.id);
        } else {
          let record: Record<string, unknown> = {};
          try { record = JSON.parse(monitor.record_json) as Record<string, unknown>; } catch { /* Paused regardless. */ }
          tx.run("UPDATE pr_monitors SET revision = ?, state = 'paused', record_json = ? WHERE id = ?", monitor.revision + 1,
            JSON.stringify({ ...record, state: "paused", revision: monitor.revision + 1 }), monitor.id);
        }
        replay.integrations.prMonitorsAdopted++;
      }
    }
    // Generation fence: stale pre-restore commands carrying a previously valid installation revision are refused.
    replay.revision.restored = Math.max(liveRevision, replay.revision.image) + 1;
    tx.run("UPDATE app_state SET revision = ? WHERE id = 1", replay.revision.restored);
    for (const table of ["job_scheduler", "delivery_worker"]) if (hasTable(tx, table)) tx.run(`DELETE FROM "${table}"`);
    return replay;
  });
}

/**
 * restore.apply_ledger: resolves the latest trusted installation lifecycle
 * ledger (table plus verified checkpoint) and replays it into quarantine. An
 * untrusted ledger (missing, unverifiable, mismatched, incompatible) blocks
 * the quarantine; no payload or owner acknowledgment can substitute for it.
 */
export function applyRestoreLedger(ctx: RestoreContext, journal: RestoreJournal, request: RestoreRequest | null): RestoreJournal {
  const ready = journal.stagedSchema !== null && journal.live &&
    (["migrated", "ledger_applied", "validated"].includes(journal.state) || (journal.state === "blocked" && journal.reason !== "activation_state_unknown"));
  if (!ready) throw new AppError("restore_bad_state", 409);
  ensureFence(ctx, journal);
  const now = ctx.now();
  const block = (reason: string, nextAction: string, detail = reason): never => {
    save(ctx.restoreDir, { ...journal, state: "blocked", steps: step(journal, "apply_ledger", now, false, detail), reason, nextAction,
      validation: null, quarantineDigest: null, requests: withRequest(journal, request), updatedAt: now });
    throw new AppError(reason, 409);
  };
  const trusted = syncLedgerCheckpoint(ctx.store, ctx.ledgerPath, now);
  if (trusted.state !== "trusted") return block(trusted.reason, trusted.nextAction);
  const manifest = liveManifest(ctx, journal.backupId);
  const liveContexts = new Map(ctx.store.read(tx => tx.all<{ id: string; generation: number; state: string }>("SELECT id, generation, state FROM team_contexts"))
    .map(c => [`${c.id}:${c.generation}`, c.state]));
  const live: LiveIntegrations = ctx.store.read(tx => ({
    binding: hasTable(tx, "telegram_binding") ? tx.get<Record<string, unknown>>("SELECT * FROM telegram_binding WHERE id = 1") : null,
    monitors: new Map(hasTable(tx, "pr_monitors")
      ? tx.all<{ id: string; revision: number; state: string; record_json: string }>("SELECT id, revision, state, record_json FROM pr_monitors").map(m => [m.id, m])
      : []),
  }));
  let replay: RestoreReplay;
  try {
    replay = withQuarantine(journal.quarantinePath, false, staged => {
      if (staged.read(readSchema) !== currentSupportedSchema) throw new AppError("quarantine_schema_mismatch", 409);
      return replayLedger(staged, trusted.entries, liveContexts, live, journal.live!.revision, now);
    });
  } catch (error) {
    const code = error instanceof AppError ? error.code : "ledger_replay_failed";
    return block(code, "inspect_quarantine_then_retry_apply_ledger_or_discard");
  }
  const applied = save(ctx.restoreDir, { ...journal, state: "ledger_applied", ledger: trustedSummary(trusted, manifest), replay,
    validation: null, quarantineDigest: null,
    steps: step(journal, "apply_ledger", now, true, `head_${trusted.head}_deletions_${replay.appliedDeletions}_suppressions_${replay.appliedSuppressions}`),
    reason: null, nextAction: "validate_quarantine_before_activation", requests: withRequest(journal, request), updatedAt: now });
  ctx.fault?.("ledger_applied");
  return applied;
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

function check(checks: RestoreCheck[], name: string, run: () => string | true): void {
  try {
    const result = run();
    checks.push(result === true ? { name, pass: true, detail: "ok" } : { name, pass: false, detail: result });
  } catch (error) {
    checks.push({ name, pass: false, detail: error instanceof AppError ? error.code : "check_failed" });
  }
}

/**
 * restore.validate: checks the quarantine copy before anything switches and
 * records the owner report. Every trusted ledger entry must be applied (or be
 * outside the image), the backup's own tombstones and suppressions must be
 * covered by the trusted ledger (a backup's own ledger never proves that no
 * later deletion happened), no restored job/attempt/outbox intent may run or
 * send by itself, no context citing deleted data may stay active, the
 * revision generation fence must be ahead of live, and the live installation,
 * backup artifact, engine contract and ledger must be unchanged.
 */
export function validateRestore(ctx: RestoreContext, journal: RestoreJournal, request: RestoreRequest | null): RestoreJournal {
  const ready = journal.ledger && journal.replay && (["ledger_applied", "validated"].includes(journal.state) ||
    (journal.state === "blocked" && journal.reason !== "activation_state_unknown"));
  if (!ready) throw new AppError("restore_bad_state", 409);
  ensureFence(ctx, journal);
  const now = ctx.now();
  const checks: RestoreCheck[] = [];
  const manifest = liveManifest(ctx, journal.backupId);
  check(checks, "fence", () => readUpgradeFence(ctx.store.path)?.upgradeId === journal.id || "fence_not_held");
  check(checks, "live_unchanged_since_prepare", () => ctx.store.read(managedStateDigest) === journal.live?.digest || "live_changed_since_prepare");
  check(checks, "backup_integrity", () => {
    if (!manifest) return "backup_missing_from_registry";
    if (manifest.artifact.hash !== journal.artifactHash) return "backup_manifest_changed";
    const integrity = verifyBackupArtifacts(manifest, ctx.backupDir);
    return integrity.state === "verified" || `backup_${integrity.reason}`;
  });
  check(checks, "engine_compat", () => {
    if (!manifest) return "backup_missing_from_registry";
    const engine = restoreEngineCompat(manifest, ctx.port);
    return engine.compatible || `engine_${engine.reason}`;
  });
  const trusted = syncLedgerCheckpoint(ctx.store, ctx.ledgerPath, now);
  check(checks, "ledger_trusted", () => trusted.state === "trusted" || trusted.reason);
  check(checks, "ledger_unchanged_since_replay", () => trusted.state !== "trusted" ? "ledger_untrusted"
    : trusted.head === journal.ledger!.head && trusted.digest === journal.ledger!.digest || "ledger_moved_since_replay_apply_again");
  const entries = trusted.state === "trusted" ? trusted.entries : [];
  const view = ledgerView(entries);
  const liveState = ctx.store.read(tx => ({
    projects: tx.all<{ id: string }>("SELECT id FROM projects").map(r => r.id),
    sources: tx.all<{ id: string }>("SELECT id FROM sources").map(r => r.id),
    contexts: tx.all<{ id: string }>("SELECT id FROM team_contexts").map(r => r.id),
  }));
  let summary: { schema: number; pendingJobs: RestoreValidation["pendingJobs"]; unknownOutbox: number; nativePending: RestoreValidation["nativePending"];
    liveOnly: RestoreValidation["liveOnly"]; digest: string | null } = {
    schema: -1, pendingJobs: [], unknownOutbox: 0, nativePending: [], liveOnly: { projects: 0, sources: 0, contexts: 0 }, digest: null };
  try {
    summary = withQuarantine(journal.quarantinePath, false, staged => staged.read(tx => {
      const schema = readSchema(tx);
      check(checks, "schema", () => schema === currentSupportedSchema || `schema_${schema}_unsupported`);
      check(checks, "integrity", () => tx.get<{ quick_check: string }>("PRAGMA quick_check")?.quick_check === "ok" || "quick_check_failed");
      check(checks, "foreign_keys", () => tx.all("PRAGMA foreign_key_check").length === 0 || "violations_found");
      for (const table of ["deletion_ledger", "memory_suppressions", "jobs", "delivery_intents", "team_contexts", "source_versions", "memory_claims"]) {
        if (hasTable(tx, table)) boundedCount(tx, table);
      }
      check(checks, "ledger_covers_backup", () => {
        if (trusted.state !== "trusted") return "ledger_untrusted";
        if (!manifest?.lifecycle?.available) return "backup_lifecycle_checkpoint_unavailable";
        const position = manifest.lifecycle.position;
        if (position && (position.deletions > view.deletions.length || position.suppressions > view.suppressions.length)) return "backup_ledger_ahead_of_latest_ledger";
        const deletionIds = new Set(view.deletions.map(d => d.id));
        const own = tx.all<{ id: string }>("SELECT id FROM deletion_ledger").filter(r => !deletionIds.has(r.id)).length;
        if (own) return `backup_tombstones_missing_from_latest_ledger_${own}`;
        const suppressionIds = new Set(view.suppressions.map(s => s.id));
        const ownSuppressions = tx.all<{ id: string }>("SELECT id FROM memory_suppressions").filter(r => !suppressionIds.has(r.id)).length;
        return ownSuppressions === 0 || `backup_suppressions_missing_from_latest_ledger_${ownSuppressions}`;
      });
      check(checks, "ledger_applied", () => {
        let missing = 0;
        for (const d of view.projectDeletions) {
          const project = tx.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", d.projectId);
          if (project && (project.name !== redactedText || tx.get("SELECT 1 FROM source_versions WHERE source_id IN (SELECT id FROM sources WHERE project_id = ?) AND content_text IS NOT NULL LIMIT 1", d.projectId))) missing++;
        }
        for (const d of view.deletions) {
          if (!tx.get("SELECT 1 FROM projects WHERE id = ?", d.projectId)) continue;
          if (!tx.get("SELECT 1 FROM deletion_ledger WHERE id = ?", d.id)) { missing++; continue; }
          if (d.kind === "source") {
            if (tx.get("SELECT 1 FROM source_versions WHERE source_id = ? AND revision = ? AND generation = ? AND content_text IS NOT NULL", d.sourceId, d.revision, d.generation)) missing++;
          } else {
            const stored = tx.get<{ record_json: string }>("SELECT record_json FROM memory_claims WHERE id = ?", d.claimId)?.record_json;
            if (stored && (JSON.parse(stored) as { status?: string }).status !== "deleted") missing++;
          }
        }
        for (const c of [...view.suppressedClaims.map(c => c.claimId), ...view.suppressions.map(s => s.claimId)]) {
          const stored = tx.get<{ record_json: string }>("SELECT record_json FROM memory_claims WHERE id = ?", c)?.record_json;
          if (stored && (JSON.parse(stored) as { status?: string }).status === "active") missing++;
        }
        const entryKeys = new Set(tx.all<{ entry_key: string }>("SELECT entry_key FROM lifecycle_ledger").map(r => r.entry_key));
        missing += entries.filter(e => !entryKeys.has(e.key)).length;
        return missing === 0 || `entries_not_applied_${missing}`;
      });
      const pendingJobs = tx.all<{ id: string; projectId: string; state: string; json: string }>(
        "SELECT id, project_id AS projectId, state, record_json AS json FROM jobs WHERE state IN ('queued', 'admitted', 'waiting')")
        .map(row => ({ id: row.id, projectId: row.projectId, state: row.state, reason: (() => { try { return String((JSON.parse(row.json) as Job).reason); } catch { return "unreadable"; } })() }));
      check(checks, "jobs_fenced", () => {
        const runnable = pendingJobs.filter(j => j.state !== "waiting").length;
        const occupying = tx.get<{ n: number }>("SELECT count(*) AS n FROM jobs WHERE occupies = 1")!.n;
        const attempts = tx.get<{ n: number }>("SELECT count(*) AS n FROM job_attempts WHERE json_extract(record_json, '$.state') IN ('prepared', 'dispatched')")!.n;
        return runnable + occupying + attempts === 0 || `runnable_${runnable}_occupying_${occupying}_attempts_${attempts}`;
      });
      let unknownOutbox = 0;
      check(checks, "outbox_held", () => {
        let claimable = 0;
        for (const row of tx.all<{ json: string }>("SELECT record_json AS json FROM delivery_intents")) {
          const intent = JSON.parse(row.json) as { status?: string; retryable?: boolean };
          if (intent.status === "unknown") unknownOutbox++;
          if (["waiting", "queued", "claimed"].includes(intent.status ?? "") || (intent.status === "failed" && intent.retryable)) claimable++;
        }
        const sending = tx.get<{ n: number }>("SELECT count(*) AS n FROM delivery_attempts WHERE json_extract(record_json, '$.state') IN ('authorized', 'claimed', 'sending')")!.n;
        return claimable + sending === 0 || `claimable_${claimable}_sending_${sending}`;
      });
      const deletedClaims = new Set(view.deletions.flatMap(d => d.kind === "claim" ? [d.claimId!] : []));
      const deletedSources = new Set(view.deletions.flatMap(d => d.kind === "source" ? [`${d.sourceId}:${d.revision}:${d.generation}`] : []));
      const suppressed = new Set([...view.suppressedClaims.map(c => c.claimId), ...view.suppressions.map(s => s.claimId)]);
      const suppressedSources = new Set(view.suppressedSources.map(s => `${s.sourceId}:${s.revision}:${s.generation}`));
      const nativePending: RestoreValidation["nativePending"] = [];
      check(checks, "native_sessions", () => {
        // Every operation that still holds native data is pending, whatever its retry budget.
        const scheduled = new Set<string>();
        for (const op of undeletedOperations(tx)) {
          for (const c of op.contexts) scheduled.add(`${c.id}:${c.generation}`);
          nativePending.push({ operationId: op.id, contexts: op.contexts.length, state: op.state });
        }
        const citations = contextCitations(tx, { sources: deletedSources, claims: deletedClaims, projects: new Set(view.projectDeletions.map(d => d.projectId)) }, { sources: suppressedSources, claims: suppressed });
        if (citations.blockers.length) return `context_inventory_${citations.blockers.slice(0, 4).join(",")}`;
        let active = 0, unscheduled = 0;
        for (const citation of citations.contexts) {
          for (const row of tx.all<{ generation: number; state: string }>("SELECT generation, state FROM team_contexts WHERE id = ?", citation.id)) {
            if (row.state === "active") active++;
            if (citation.cites !== "suppressed" && row.state !== "deleted" && !scheduled.has(`${citation.id}:${row.generation}`)) unscheduled++;
          }
        }
        return active + unscheduled === 0 || `active_${active}_unscheduled_${unscheduled}`;
      });
      check(checks, "generation_fence", () => readRevision(tx) > (journal.live?.revision ?? Number.POSITIVE_INFINITY) || "revision_not_ahead_of_live");
      const image = {
        projects: new Set(tx.all<{ id: string }>("SELECT id FROM projects").map(r => r.id)),
        sources: new Set(tx.all<{ id: string }>("SELECT id FROM sources").map(r => r.id)),
        contexts: new Set(tx.all<{ id: string }>("SELECT id FROM team_contexts").map(r => r.id)),
      };
      const liveOnly = {
        projects: liveState.projects.filter(id => !image.projects.has(id)).length,
        sources: liveState.sources.filter(id => !image.sources.has(id)).length,
        contexts: liveState.contexts.filter(id => !image.contexts.has(id)).length,
      };
      let digest: string | null = null;
      try { digest = managedStateDigest(tx); } catch { digest = null; }
      check(checks, "quarantine_digest", () => digest !== null || "restore_bound_exceeded");
      return { schema, pendingJobs, unknownOutbox, nativePending, liveOnly, digest };
    }));
  } catch {
    checks.push({ name: "quarantine_copy", pass: false, detail: "quarantine_unreadable" });
  }
  const pass = checks.every(c => c.pass);
  const validation: RestoreValidation = { checks, pendingJobs: summary.pendingJobs, unknownOutbox: summary.unknownOutbox,
    nativePending: summary.nativePending, liveOnly: summary.liveOnly, quarantineSchema: summary.schema };
  const failedNames = checks.filter(c => !c.pass).map(c => c.name);
  const ledgerProblem = failedNames.some(n => n.startsWith("ledger_"));
  const validated = save(ctx.restoreDir, { ...journal, state: pass ? "validated" : "blocked", validation,
    quarantineDigest: pass ? summary.digest : null,
    steps: step(journal, "validate", now, pass, pass ? "all_checks_pass" : failedNames.join(",")),
    reason: pass ? null : ledgerProblem ? (trusted.state !== "trusted" ? trusted.reason : "ledger_validation_failed") : "validation_failed",
    nextAction: pass ? "review_report_then_activate_or_discard"
      : trusted.state !== "trusted" ? trusted.nextAction : "inspect_failed_checks_then_apply_ledger_again_or_discard",
    requests: withRequest(journal, request), updatedAt: now });
  ctx.fault?.("validated");
  return validated;
}

// ---------------------------------------------------------------------------
// Activate and reconcile
// ---------------------------------------------------------------------------

/**
 * Resolves a persisted activation intent against the live identity: the
 * validated quarantine digest means the swap happened (`activated`); the
 * fenced pre-activation digest means it did not (`validated`, intent void);
 * anything else stays `blocked` with `activation_state_unknown`. Never guesses.
 */
export function resolveRestoreActivation(store: TransactionStore, restoreDir: string, journal: RestoreJournal, now: number): RestoreJournal {
  if (journal.state !== "activating") return journal;
  let digest: string | null = null;
  try { digest = store.read(managedStateDigest); } catch { digest = null; }
  if (digest !== null && digest === journal.quarantineDigest) {
    return save(restoreDir, { ...journal, state: "activated", steps: step(journal, "activate", now, true, "quarantine_is_live"),
      reason: null, nextAction: "complete_native_reconciliation_then_resume", activation: { ...journal.activation, at: journal.activation.at ?? now }, updatedAt: now });
  }
  if (digest !== null && digest === journal.live?.digest) {
    clearRestoreGate(store.path, journal.id);
    return save(restoreDir, { ...journal, state: "validated", steps: step(journal, "activate", now, false, "swap_not_applied"),
      reason: "activation_interrupted", nextAction: "review_report_then_activate_or_discard", updatedAt: now });
  }
  return save(restoreDir, { ...journal, state: "blocked", steps: step(journal, "activate", now, false, "live_identity_unknown"),
    reason: "activation_state_unknown", nextAction: "inspect_installation_manually_backup_remains_in_registry", updatedAt: now });
}

/**
 * Reopen recovery: an interrupted prepare fails and releases its fence (live
 * was never touched); an activation intent is resolved by identity; a fenced
 * journal whose fence file vanished is re-fenced; a fence left by a terminal
 * restore is released. Synchronous; never resumes work by itself.
 */
export function recoverRestoresOnOpen(store: TransactionStore, restoreDir: string, now: number): RestoreJournal | null {
  for (const journal of listRestores(restoreDir, 100)) {
    if (journal.state === "preparing") {
      removeQuarantine(journal);
      save(restoreDir, { ...journal, state: "failed", steps: step(journal, "prepare", now, false, "prepare_interrupted"),
        reason: "prepare_interrupted", nextAction: "inspect_failure_then_prepare_again", updatedAt: now });
      clearUpgradeFence(store.path, journal.id);
    } else if (journal.state === "activating") {
      resolveRestoreActivation(store, restoreDir, journal, now);
    }
  }
  const journals = listRestores(restoreDir, 100);
  const active = journals.find(j => fencedRestoreStates.includes(j.state)) ?? null;
  const fence = readUpgradeFence(store.path);
  if (active) {
    // Durable intent wins: an unfinished restore is always fenced on reopen, even if a crash hit after release.
    if (!fence) { try { writeUpgradeFence(store.path, active.id, now, "restore"); } catch { /* Another holder already fences. */ } }
    if (["activating", "activated"].includes(active.state)) writeRestoreGate(store.path, active.id);
  } else if (fence?.holder === "restore") {
    const owner = journals.find(j => j.id === fence.upgradeId);
    if (owner && terminalRestoreStates.includes(owner.state)) clearUpgradeFence(store.path, owner.id);
  }
  const gate = readRestoreGate(store.path);
  if (gate && gate !== "unknown") {
    const owner = journals.find(j => j.id === gate);
    if (owner && (terminalRestoreStates.includes(owner.state) || ["validated", "ledger_applied", "migrated", "quarantined"].includes(owner.state))) clearRestoreGate(store.path, gate);
  }
  return active;
}

/**
 * restore.activate: under service lifecycle ownership — quiesce again, prove
 * the fenced live installation, the trusted ledger and the validated
 * quarantine are exactly what validation saw, persist intent, swap atomically
 * and prove the live identity, then complete (see {@link completeRestoreActivation}).
 */
export async function activateRestore(ctx: RestoreContext, journal: RestoreJournal, request: RestoreRequest | null): Promise<RestoreJournal> {
  if (journal.state === "activating") journal = resolveRestoreActivation(ctx.store, ctx.restoreDir, journal, ctx.now());
  if (journal.state === "activated") return completeRestoreActivation(ctx, journal, request);
  if (journal.state !== "validated" || !journal.quarantineDigest || !journal.live || !journal.ledger) throw new AppError("restore_bad_state", 409);
  ensureFence(ctx, journal);
  const quiesce = await ctx.service.quiesce();
  if (!quiesce.settled) {
    save(ctx.restoreDir, { ...journal, steps: step(journal, "quiesce", ctx.now(), false, quiesce.detail), updatedAt: ctx.now() });
    throw new AppError("restore_quiesce_incomplete", 409);
  }
  // From here to the swap nothing awaits: no in-process writer can interleave.
  const now = ctx.now();
  const block = (reason: string, detail: string, nextAction: string): never => {
    save(ctx.restoreDir, { ...journal, state: "blocked", steps: step(journal, "activate", now, false, detail), reason, quarantineDigest: null,
      nextAction, requests: withRequest(journal, request), updatedAt: now });
    throw new AppError(reason, 409);
  };
  const trusted = syncLedgerCheckpoint(ctx.store, ctx.ledgerPath, now);
  if (trusted.state !== "trusted") return block(trusted.reason, trusted.reason, trusted.nextAction);
  if (trusted.head !== journal.ledger.head || trusted.digest !== journal.ledger.digest) {
    return block("restore_ledger_moved", "ledger_moved_since_validate", "apply_ledger_again_then_validate");
  }
  let liveDigest: string | null = null, quarantineDigest: string | null = null;
  try { liveDigest = ctx.store.read(managedStateDigest); } catch { liveDigest = null; }
  if (liveDigest !== journal.live.digest) return block("restore_stale_live", "live_changed_since_prepare", "discard_and_prepare_again");
  try { quarantineDigest = withQuarantine(journal.quarantinePath, false, staged => staged.read(managedStateDigest)); } catch { quarantineDigest = null; }
  if (quarantineDigest !== journal.quarantineDigest) return block("restore_quarantine_changed", "quarantine_changed_since_validate", "apply_ledger_again_then_validate");
  // From the intent on, only restore status and remediation are served until the restore is complete.
  writeRestoreGate(ctx.store.path, journal.id);
  const intent = save(ctx.restoreDir, { ...journal, state: "activating", steps: step(journal, "activation_intent", now, true, "intent_persisted"),
    nextAction: "reconcile_activation_intent", requests: withRequest(journal, request), updatedAt: now });
  ctx.fault?.("activation_intent");
  try {
    ctx.store.swapFrom(journal.quarantinePath);
  } catch (error) {
    if (error instanceof SimulatedRestoreCrash) throw error;
    const resolved = resolveRestoreActivation(ctx.store, ctx.restoreDir, intent, ctx.now());
    if (resolved.state !== "activated") throw new AppError("restore_activation_failed", 503);
    return completeRestoreActivation(ctx, resolved, null);
  }
  ctx.fault?.("swapped");
  const activated = resolveRestoreActivation(ctx.store, ctx.restoreDir, intent, ctx.now());
  if (activated.state !== "activated") throw new AppError("restore_activation_failed", 503);
  return completeRestoreActivation(ctx, activated, null);
}

/**
 * Completes an activated restore, idempotently and in this order:
 * 1. revoke every browser/adapter session (pre-restore clients and stale
 *    commands are fenced; the owner signs in again);
 * 2. with the fence still held, run managed native-session deletion for every
 *    open deletion operation through the service's team port; any context
 *    left undeleted keeps the installation fenced (`native_delete_pending`);
 * 3. release the fence and resume the service, which rebuilds the scheduler
 *    and reconciles jobs, native sessions and outbox before admission.
 * Without a managed service the journal stays `activated` (fence held) until
 * the next service boot completes it.
 */
export async function completeRestoreActivation(ctx: RestoreContext, journal: RestoreJournal, request: RestoreRequest | null): Promise<RestoreJournal> {
  if (journal.state !== "activated") throw new AppError("restore_bad_state", 409);
  let current = { ...journal, requests: withRequest(journal, request) };
  writeRestoreGate(ctx.store.path, current.id);
  // Completion only ever runs fenced; a journal left unfenced by an earlier failure is re-fenced first.
  if (current.activation.fenceReleased || !readUpgradeFence(ctx.store.path)) {
    ensureFence(ctx, current);
    current = save(ctx.restoreDir, { ...current, activation: { ...current.activation, fenceReleased: false }, updatedAt: ctx.now() });
  }
  if (!current.activation.sessionsRevoked) {
    ctx.store.transaction(tx => tx.run("DELETE FROM sessions"));
    current = save(ctx.restoreDir, { ...current, activation: { ...current.activation, sessionsRevoked: true },
      steps: step(current, "generation_fence", ctx.now(), true, "sessions_revoked"), updatedAt: ctx.now() });
  }
  ctx.fault?.("activated");
  if (!current.activation.nativeReconciled) {
    if (!ctx.service.fencedLifecycle) {
      return save(ctx.restoreDir, { ...current, reason: "reconcile_pending", nextAction: "start_service_to_reconcile_native_sessions_jobs_outbox", updatedAt: ctx.now() });
    }
    // An exhausted operation still holding native data gets a fresh, explicit managed-delete operation on each owner retry.
    ctx.store.transaction(tx => {
      const open = openDeletionContexts(tx);
      for (const op of undeletedOperations(tx).filter(o => o.state === "failed")) {
        const contexts = op.contexts.filter(c => !open.has(`${c.id}:${c.generation}`));
        if (contexts.length) scheduleRestoreDeletion(tx, op.projectId, contexts, ctx.now(), "restore_retry_exhausted_operation");
      }
    });
    let detail = "native_sessions_reconciled";
    try {
      // Sessions and managed deletions reconcile through the team port while nothing can be admitted.
      await ctx.service.fencedLifecycle(async port => {
        await reconcileSessions(ctx.store, port, ctx.now());
        await reconcileDeletions(ctx.store, port, ctx.now(), undefined, ctx.deletionEnvironment);
      });
    } catch (error) { detail = error instanceof AppError ? error.code : "native_reconcile_failed"; }
    const open = ctx.store.transaction(tx => {
      for (const op of tx.all<{ id: string }>("SELECT id FROM deletion_operations WHERE state IN ('pending', 'blocked', 'failed')")) {
        try { refreshOperationState(tx, op.id, ctx.now()); } catch { /* Counted below. */ }
      }
      return undeletedOperations(tx);
    });
    if (open.length || detail !== "native_sessions_reconciled") {
      return save(ctx.restoreDir, { ...current, reason: "native_delete_pending",
        steps: step(current, "native_reconcile", ctx.now(), false, open.length ? `operations_${open.length}_hold_native_data` : detail),
        nextAction: "retry_activate_to_reconcile_native_sessions", updatedAt: ctx.now() });
    }
    current = save(ctx.restoreDir, { ...current, activation: { ...current.activation, nativeReconciled: true },
      steps: step(current, "native_reconcile", ctx.now(), true, detail), updatedAt: ctx.now() });
  }
  ctx.fault?.("native_reconciled");
  // Scheduler admission needs the fence gone; reads stay gated until completion and a failure re-acquires the fence.
  releaseFence(ctx, current);
  current = save(ctx.restoreDir, { ...current, activation: { ...current.activation, fenceReleased: true }, updatedAt: ctx.now() });
  const resumed = await safeResume(ctx);
  ctx.fault?.("reconciled");
  const now = ctx.now();
  if (!resumed.reconciled) {
    ensureFence(ctx, current);
    return save(ctx.restoreDir, { ...current, activation: { ...current.activation, fenceReleased: false },
      reconcile: { ...resumed, at: now }, steps: step(current, "reconcile", now, false, resumed.detail),
      reason: "reconcile_pending", nextAction: resumed.detail === "no_scheduler_in_process" || resumed.detail === "service_restart_required"
        ? "start_service_to_reconcile_native_sessions_jobs_outbox" : "retry_activate_to_reconcile", updatedAt: now });
  }
  const complete = save(ctx.restoreDir, { ...current, state: "complete", reconcile: { ...resumed, at: now },
    steps: step(current, "reconcile", now, true, resumed.detail), reason: null,
    nextAction: "sign_in_again_then_inspect_jobs_awaiting_resume_and_unknown_deliveries", updatedAt: now });
  clearRestoreGate(ctx.store.path, complete.id);
  removeQuarantine(complete);
  recordAudit(ctx, complete);
  return complete;
}

/** Boot completion: an activated restore is completed under the booting service before admission. */
export async function completeRestoreOnBoot(ctx: RestoreContext): Promise<RestoreJournal | null> {
  const journal = listRestores(ctx.restoreDir, 100).find(j => j.state === "activated");
  return journal ? completeRestoreActivation(ctx, journal, null) : null;
}

/** restore.discard: abandons a quarantine before activation; live is untouched, the backup stays in the registry. */
export async function discardRestore(ctx: RestoreContext, journal: RestoreJournal, request: RestoreRequest | null): Promise<RestoreJournal> {
  if (!restoreActions(journal).includes("discard")) throw new AppError("restore_bad_state", 409);
  return failBeforeActivation(ctx, journal, "discard", "discarded_by_owner", "prepare_a_new_quarantine_when_ready", "discarded", request);
}
