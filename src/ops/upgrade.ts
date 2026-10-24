import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { SNAPSHOT_NATIVE_FORMAT_VERSION } from "schway/host";
import { AppError } from "../errors";
import { lookupSource, requireId } from "../sources";
import { TransactionStore, installationScopedTables, schemaVersion, type AppTransaction } from "../store";
import {
  jitAppVersion, lifecycleCheckpoint, readBackupManifest, stageManagedBackup, verifyBackupArtifacts,
  type BackupManifest, type BackupNativePort,
} from "./backup";
import { clearUpgradeFence, readUpgradeFence, writeFileAtomic, writeUpgradeFence } from "./upgrade-fence";

/**
 * ops.schema_migrations/v1 — owner-authorized staged installation upgrade
 * (OPS06, issue #32). See docs/contracts/ops-schema-migrations-v1.md.
 *
 * Flow: preflight (schema rules, then the engine's declared snapshot
 * contract; neither touches native state) → durable admission fence →
 * quiesce through the job/session contracts → one pre-upgrade recovery point
 * through staged ops.backup_manifest/v1 creation plus a separate trusted
 * ledger sidecar → versioned migrations applied to a staged copy only →
 * validation of the staged copy against the fenced live state → crash-safe
 * activation (durable intent, atomic swap, identity check) → reconciliation
 * of jobs/native sessions under service ownership → complete.
 *
 * Control state (the journal, its request receipts and the fence) lives
 * outside the swapped database, so activation can never discard it and a
 * crash at any boundary is reconciled from durable intent on reopen.
 */
export const upgradeContract = "ops.schema_migrations/v1" as const;
/** Oldest schema the staged migration chain accepts (also bounds OPS02 quarantine migration). */
export const minSupportedSchema = 15;
/**
 * Oldest live installation the owner upgrade can checkpoint: a recovery point
 * needs the managed backup registry (schema 16) and the deletion ledger
 * (schema 17). Older installations require manual recovery.
 */
export const minUpgradeSourceSchema = 17;
/** The one supported target: the schema this build migrates to. */
export const currentSupportedSchema = schemaVersion;
/**
 * Supported engine session-snapshot contract. Native sessions are validated
 * and captured only through this contract (Schway `snapshotSessions` and
 * `validateSessionSnapshot`); Jit never parses or rewrites their private
 * format and the upgrade never migrates native storage. Exact-match only.
 */
export const upgradeEngineContract = "schway.host.session-snapshot/v1" as const;
/** Supported native snapshot format version (pinned Schway host). */
export const upgradeNativeFormatVersion = SNAPSHOT_NATIVE_FORMAT_VERSION;
/**
 * Documented validation and capture bounds. Validation pages every row of every
 * managed table; a table above `rowsPerTable` (or a ledger above `ledgerRows`)
 * fails closed with `upgrade_validation_bound_exceeded` instead of sampling.
 */
export const upgradeLimits = Object.freeze({ rowsPerTable: 200_000, ledgerRows: 200_000, journals: 50 });

export type UpgradeState =
  | "preparing" | "prepared" | "staged" | "ready" | "activating" | "activated"
  | "complete" | "blocked" | "failed" | "rolled_back";
/** States that hold the durable admission fence. */
export const fencedUpgradeStates: readonly UpgradeState[] = Object.freeze(["preparing", "prepared", "staged", "ready", "activating", "blocked"]);
/** States after which nothing more happens to the attempt. */
export const terminalUpgradeStates: readonly UpgradeState[] = Object.freeze(["complete", "failed", "rolled_back"]);

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
export type UpgradeAction = "migrate" | "validate" | "activate" | "rollback";

export interface UpgradeCheck { name: string; pass: boolean; detail: string }
export interface UpgradeValidation {
  stagedSchema: number; liveSchema: number; checks: UpgradeCheck[];
  ledgersMatch: boolean; outstanding: { queued: number; admitted: number };
  unknownOutbox: number; nativeRefs: number; tables: number; rows: number;
}

/** Declared engine compatibility; derived from port metadata only, never from a snapshot. */
export interface UpgradeEngineCheck {
  engine: string | null; contract: string | null; formatVersion: number | null;
  compatible: boolean; reason: string | null;
}

export interface UpgradeStep { name: string; at: number; ok: boolean; detail: string }
/** One accepted owner request against a journal (control-plane receipt). */
export interface UpgradeRequest { requestId: string; kind: UpgradeCommand["kind"]; payloadHash: string; at: number }

export interface UpgradeJournal {
  id: string; contract: typeof upgradeContract;
  fromSchema: number; targetSchema: number;
  state: UpgradeState;
  steps: UpgradeStep[];
  preflight: {
    currentSchema: number; targetSchema: number; jitVersion: string;
    supported: { minSource: number; target: number };
    migrations: number[]; engine: UpgradeEngineCheck;
    compatible: boolean; reason: string | null; plannedSteps: string[];
  };
  quiesce: { settled: boolean; fencedJobs: number; detail: string; disabled: string[] } | null;
  snapshotBackupId: string | null;
  checkpoint: {
    backupId: string; appSchema: number; appRevision: number; jitVersion: string; lifecycle: string | null;
    nativeRefs: number; nativeEngine: string | null; nativeContract: string | null; artifactHash: string;
  } | null;
  /** Trusted lifecycle ledger and source generations captured separately from the rollback snapshot. */
  ledger: { path: string; hash: string; checkpoint: string | null; deletions: number; suppressions: number; suppressedSources: number; sources: number } | null;
  stagedPath: string | null; stagedSchema: number | null;
  /** Managed-state digest of the fenced live installation at migrate; activation requires it unchanged. */
  liveDigest: string | null;
  /** Managed-state digest of the validated staged copy; the activated installation must match it. */
  stagedDigest: string | null;
  validation: UpgradeValidation | null;
  reconcile: { reconciled: boolean; detail: string; at: number } | null;
  reason: string | null; nextAction: string;
  requests: UpgradeRequest[];
  createdAt: number; updatedAt: number;
}

/** Sanitized journal plus the recovery choices valid for its phase. */
export type UpgradeEvidence = UpgradeJournal & { actions: UpgradeAction[] };
export interface UpgradeReceipt { journal: UpgradeEvidence; duplicate: boolean }

/** Settlement evidence from stopping admission and in-flight work. */
export interface UpgradeQuiesceResult { settled: boolean; fencedJobs: number; detail: string }
/** Result of rebuilding the scheduler/ports and reconciling jobs, native sessions and outbox. */
export interface UpgradeResumeResult { reconciled: boolean; detail: string }

/**
 * Service lifecycle ownership used by the upgrade. `quiesce` stops admission,
 * fences in-flight attempts through the job/session contracts (JobQueue.close)
 * and waits, bounded, for settlement. `resume` rebuilds the scheduler and
 * ports for the current (possibly swapped) store and reconciles outstanding
 * job/session references before any admission resumes.
 */
export interface UpgradeServiceControl {
  quiesce(): Promise<UpgradeQuiesceResult>;
  resume(): Promise<UpgradeResumeResult>;
}

/** Journal boundaries where deterministic tests inject a simulated crash. */
export type UpgradeFaultPoint =
  | "fenced" | "quiesced" | "snapshot" | "ledger" | "staged_copy" | "migrated" | "validated"
  | "activation_intent" | "swapped" | "activated" | "reconciled";

/**
 * Fault-injection seam: models process death at a journal boundary. The
 * engine performs no cleanup or failure recording for it, exactly like a
 * crash; recovery happens on reopen ({@link recoverUpgradesOnOpen}).
 */
export class SimulatedCrash extends Error {
  constructor(readonly point: UpgradeFaultPoint) { super(`simulated crash at ${point}`); }
}

/** Everything one upgrade command needs; Application builds it after owner authorization. */
export interface UpgradeContext {
  store: TransactionStore;
  upgradeDir: string;
  backupDir: string;
  port: BackupNativePort | undefined;
  jitVersion: string;
  now(): number;
  inflight: Set<string>;
  service: UpgradeServiceControl;
  /** Re-verifies the authorized owner inside each transaction that commits upgrade work. */
  authorize(tx: AppTransaction): void;
  fault?(point: UpgradeFaultPoint): void;
}

const exact = (value: unknown, keys: string[]) =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");

/** Validates the command shape and returns its payload identity. Throws `invalid_upgrade_command`. */
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
  return sha256(JSON.stringify([command.kind, command.expectedRevision, command.payload]));
}

export function upgradeDirFor(databasePath: string): string {
  return `${databasePath}.upgrades`;
}

export function ownUpgradeDirFor(databasePath: string, override?: string): string {
  const dir = override ?? upgradeDirFor(databasePath);
  if (dir.length < 2 || dir.length > 1024) throw new AppError("invalid_upgrade_destination", 500);
  return dir;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

/**
 * Schema-only preflight. Downgrades, targets other than this build's schema,
 * newer-than-supported live schemas and installations too old to checkpoint
 * are rejected without touching the engine, the native port or any state.
 */
export function planSchema(fromSchema: number, targetSchema: number): { compatible: boolean; reason: string | null; migrations: number[] } {
  if (!Number.isSafeInteger(fromSchema) || !Number.isSafeInteger(targetSchema) || fromSchema < 0) {
    return { compatible: false, reason: "unsupported_schema_version", migrations: [] };
  }
  if (fromSchema > currentSupportedSchema) return { compatible: false, reason: "newer_schema_unsupported", migrations: [] };
  if (targetSchema < fromSchema) return { compatible: false, reason: "downgrade_rejected", migrations: [] };
  if (targetSchema > currentSupportedSchema) return { compatible: false, reason: "forward_upgrade_unsupported", migrations: [] };
  if (targetSchema !== currentSupportedSchema) return { compatible: false, reason: "unsupported_target_schema", migrations: [] };
  if (fromSchema < minUpgradeSourceSchema) return { compatible: false, reason: "manual_recovery_required", migrations: [] };
  const migrations: number[] = [];
  for (let version = fromSchema + 1; version <= targetSchema; version++) migrations.push(version);
  return { compatible: true, reason: null, migrations };
}

/**
 * Supported-engine compat over a declared snapshot contract. Null reports
 * engine_unavailable; any other contract (legacy placeholders and future
 * versions included) reports unsupported_engine.
 */
export function checkUpgradeEngine(contract: string | null): { supported: boolean; reason: string | null } {
  if (!contract) return { supported: false, reason: "engine_unavailable" };
  if (contract !== upgradeEngineContract) return { supported: false, reason: "unsupported_engine" };
  return { supported: true, reason: null };
}

/**
 * Engine compatibility from the port's declared identity only: availability
 * (the cheap gate probe), snapshot contract and native format version. It
 * never calls `snapshot` or `resolve`, so preflight cannot create host-side
 * state; the single snapshot happens inside the recovery-point backup.
 */
export function inspectUpgradeEngine(port: BackupNativePort | undefined): UpgradeEngineCheck {
  const identity = { engine: port?.engine ?? null, contract: port?.contract ?? null, formatVersion: port?.formatVersion ?? null };
  if (!port) return { ...identity, compatible: false, reason: "engine_unavailable" };
  let available = false;
  try { available = port.available() === true; } catch { available = false; }
  if (!available) return { ...identity, compatible: false, reason: "engine_unavailable" };
  const compat = checkUpgradeEngine(identity.contract);
  if (!compat.supported) return { ...identity, compatible: false, reason: compat.reason };
  if (identity.formatVersion !== upgradeNativeFormatVersion) return { ...identity, compatible: false, reason: "unsupported_engine" };
  return { ...identity, compatible: true, reason: null };
}

const plannedSteps = ["preflight", "fence", "quiesce", "snapshot", "ledger", "migrate", "validate", "activate", "reconcile"];

/** Pure preflight matrix: schema rules first, then the declared engine contract. */
export function planUpgrade(fromSchema: number, targetSchema: number, engineContract: string | null): {
  compatible: boolean; reason: string | null; plannedSteps: string[];
} {
  const schema = planSchema(fromSchema, targetSchema);
  if (!schema.compatible) return { compatible: false, reason: schema.reason, plannedSteps: [] };
  const compat = checkUpgradeEngine(engineContract);
  if (!compat.supported) return { compatible: false, reason: compat.reason, plannedSteps: [] };
  return { compatible: true, reason: null, plannedSteps: [...plannedSteps] };
}

/**
 * Recovery choices the owner may take next, derived from the phase and from
 * which artifacts exist. Rollback is only offered before activation (it keeps
 * the untouched live installation); after activation the pre-upgrade backup
 * is restored only through OPS02 quarantine and current-ledger replay.
 */
export function upgradeActions(journal: Pick<UpgradeJournal, "state" | "snapshotBackupId" | "stagedPath" | "stagedSchema" | "reason">): UpgradeAction[] {
  switch (journal.state) {
    case "prepared": return ["migrate", "rollback"];
    case "staged": return ["validate", "rollback"];
    case "ready": return ["activate", "rollback"];
    case "blocked":
      if (journal.reason === "activation_state_unknown" || journal.reason === "upgrade_corrupt") return [];
      return journal.snapshotBackupId ? ["migrate", "rollback"] : ["rollback"];
    case "activating": case "activated": return ["activate"];
    default: return [];
  }
}

// ---------------------------------------------------------------------------
// Control-plane journal (outside the swapped database)
// ---------------------------------------------------------------------------

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const journalPath = (dir: string, id: string) => join(dir, id, "journal.json");

/** Trusted per-attempt directory; every attempt file path is derived from it, never read from the journal. */
export function upgradeAttemptDir(upgradeDir: string, id: string): string {
  if (!ID.test(id)) throw new AppError("upgrade_corrupt", 500);
  return join(upgradeDir, id);
}
/** The one staged-copy path an attempt may use. */
export function upgradeStagedPath(upgradeDir: string, id: string): string { return join(upgradeAttemptDir(upgradeDir, id), "staged.sqlite"); }
/** The one ledger-sidecar path an attempt may use. */
export function upgradeLedgerPath(upgradeDir: string, id: string): string { return join(upgradeAttemptDir(upgradeDir, id), "ledger.json"); }

const HEX64 = /^[0-9a-f]{64}$/;
const states: readonly UpgradeState[] = ["preparing", "prepared", "staged", "ready", "activating", "activated", "complete", "blocked", "failed", "rolled_back"];
const kinds: readonly UpgradeCommand["kind"][] = ["upgrade.prepare", "upgrade.migrate", "upgrade.validate", "upgrade.activate", "upgrade.rollback"];
const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);
const isInt = (value: unknown, min = 0) => Number.isSafeInteger(value) && (value as number) >= min;
const isText = (value: unknown, max = 512) => typeof value === "string" && value.length <= max;
const isNullable = (value: unknown, check: (v: unknown) => boolean): boolean => value === null || check(value);

/**
 * Exact journal schema and state-dependent invariants. The journal is
 * control-plane data outside the database, so it is never trusted beyond what
 * this check proves: paths must equal the ones derived from the trusted
 * upgrade directory and id, and each state must carry exactly the artifacts
 * it implies. Anything else is `upgrade_corrupt`.
 */
function checkJournal(value: unknown, upgradeDir: string, id: string): UpgradeJournal {
  const corrupt = (): never => { throw new AppError("upgrade_corrupt", 500); };
  if (!isObject(value) || !exact(value, ["id", "contract", "fromSchema", "targetSchema", "state", "steps", "preflight", "quiesce", "snapshotBackupId",
    "checkpoint", "ledger", "stagedPath", "stagedSchema", "liveDigest", "stagedDigest", "validation", "reconcile", "reason", "nextAction",
    "requests", "createdAt", "updatedAt"])) return corrupt();
  const j = value as unknown as UpgradeJournal;
  if (j.contract !== upgradeContract || j.id !== id || !ID.test(id) || !states.includes(j.state) ||
      !Number.isSafeInteger(j.fromSchema) || !Number.isSafeInteger(j.targetSchema) || !isInt(j.createdAt) || !isInt(j.updatedAt) ||
      !isNullable(j.reason, v => isText(v, 128)) || !isText(j.nextAction) ||
      !isNullable(j.stagedSchema, v => isInt(v)) || !isNullable(j.liveDigest, v => typeof v === "string" && HEX64.test(v)) ||
      !isNullable(j.stagedDigest, v => typeof v === "string" && HEX64.test(v)) ||
      !isNullable(j.snapshotBackupId, v => typeof v === "string" && ID.test(v))) return corrupt();
  if (!Array.isArray(j.steps) || j.steps.length > 200 || !j.steps.every(step => isObject(step) && exact(step, ["name", "at", "ok", "detail"]) &&
      isText(step.name, 64) && isInt(step.at) && typeof step.ok === "boolean" && isText(step.detail))) return corrupt();
  if (!Array.isArray(j.requests) || j.requests.length > 100 || !j.requests.every(r => isObject(r) && exact(r, ["requestId", "kind", "payloadHash", "at"]) &&
      typeof r.requestId === "string" && /^[a-zA-Z0-9_-]{8,128}$/.test(r.requestId) && kinds.includes(r.kind as UpgradeCommand["kind"]) &&
      typeof r.payloadHash === "string" && HEX64.test(r.payloadHash) && isInt(r.at))) return corrupt();
  const p = j.preflight as unknown;
  if (!isObject(p) || !Number.isSafeInteger(p.currentSchema) || !Number.isSafeInteger(p.targetSchema) || !isText(p.jitVersion, 128) ||
      !isObject(p.supported) || !Array.isArray(p.migrations) || !(p.migrations as unknown[]).every(v => isInt(v)) || !isObject(p.engine) ||
      typeof p.compatible !== "boolean" || !Array.isArray(p.plannedSteps)) return corrupt();
  if (j.stagedPath !== null && j.stagedPath !== upgradeStagedPath(upgradeDir, id)) return corrupt();
  if (j.ledger !== null && (!isObject(j.ledger) || j.ledger.path !== upgradeLedgerPath(upgradeDir, id) || typeof j.ledger.hash !== "string" ||
      !HEX64.test(j.ledger.hash) || !isNullable(j.ledger.checkpoint, v => isText(v, 128)) || !isInt(j.ledger.deletions) ||
      !isInt(j.ledger.suppressions) || !isInt(j.ledger.suppressedSources) || !isInt(j.ledger.sources))) return corrupt();
  if (!isNullable(j.quiesce, v => isObject(v) && typeof v.settled === "boolean" && isInt(v.fencedJobs) && isText(v.detail) && Array.isArray(v.disabled))) return corrupt();
  if (!isNullable(j.checkpoint, v => isObject(v) && typeof v.backupId === "string" && v.backupId === j.snapshotBackupId && isInt(v.nativeRefs))) return corrupt();
  if (!isNullable(j.validation, v => isObject(v) && Array.isArray(v.checks))) return corrupt();
  if (!isNullable(j.reconcile, v => isObject(v) && typeof v.reconciled === "boolean" && isText(v.detail) && isInt(v.at))) return corrupt();
  // State-dependent invariants: each phase carries exactly the artifacts it implies.
  const prepared = j.snapshotBackupId !== null && j.ledger !== null && j.stagedPath !== null && j.preflight.compatible;
  switch (j.state) {
    case "prepared": if (!prepared) return corrupt(); break;
    case "staged": if (!prepared || j.stagedSchema === null || j.liveDigest === null) return corrupt(); break;
    case "ready": case "activating":
      if (!prepared || j.stagedSchema === null || j.liveDigest === null || j.stagedDigest === null) return corrupt(); break;
    case "activated": case "complete": if (!prepared || j.stagedDigest === null) return corrupt(); break;
    case "blocked": if (j.snapshotBackupId !== null && !prepared) return corrupt(); break;
    case "rolled_back": if (!prepared) return corrupt(); break;
    case "preparing": case "failed": break;
  }
  return j;
}

/** Regular, non-symlink file check; absent is allowed when `optional`. */
function regularFile(path: string, optional: boolean): boolean {
  let stats;
  try { stats = lstatSync(path); } catch { return optional; }
  return stats.isFile() && !stats.isSymbolicLink();
}

/** Trusted attempt directory must be a real directory (not a symlink) when present. */
function realAttemptDir(upgradeDir: string, id: string): boolean {
  let stats;
  try { stats = lstatSync(upgradeAttemptDir(upgradeDir, id)); } catch { return true; }
  return stats.isDirectory() && !stats.isSymbolicLink();
}

/**
 * Resolves an attempt file for a file operation: always the derived path,
 * inside a real attempt directory, a regular non-symlink file (or absent when
 * `optional`), and never the live database or anything inside the backup
 * directory. Throws `upgrade_corrupt` otherwise, before any I/O on it.
 */
function attemptFile(ctx: Pick<UpgradeContext, "upgradeDir" | "backupDir" | "store">, id: string, name: "staged.sqlite" | "ledger.json", optional: boolean): string {
  const path = name === "staged.sqlite" ? upgradeStagedPath(ctx.upgradeDir, id) : upgradeLedgerPath(ctx.upgradeDir, id);
  const absolute = resolve(path), live = resolve(ctx.store.path), backups = resolve(ctx.backupDir);
  if (absolute === live || absolute.startsWith(`${live}-`) || absolute === backups || absolute.startsWith(`${backups}/`)) throw new AppError("upgrade_corrupt", 500);
  if (!realAttemptDir(ctx.upgradeDir, id)) throw new AppError("upgrade_corrupt", 500);
  for (const suffix of name === "staged.sqlite" ? ["", "-wal", "-shm"] : [""]) {
    if (!regularFile(`${path}${suffix}`, optional || suffix !== "")) throw new AppError("upgrade_corrupt", 500);
  }
  return path;
}

/**
 * {@link attemptFile} for a step on a fenced journal: an unsafe attempt file
 * moves the journal to a durable `blocked` `upgrade_corrupt` state with no
 * actions before throwing, so nothing destructive can be retried on it.
 */
function stepFile(ctx: UpgradeContext, journal: UpgradeJournal, name: "staged.sqlite" | "ledger.json", optional: boolean): string {
  try { return attemptFile(ctx, journal.id, name, optional); }
  catch (error) {
    saveJournal(ctx.upgradeDir, { ...journal, state: "blocked", steps: step(journal, "attempt_files", ctx.now(), false, "upgrade_corrupt"),
      reason: "upgrade_corrupt", stagedDigest: null, nextAction: "inspect_corrupt_upgrade_attempt_files", updatedAt: ctx.now() });
    throw error;
  }
}

/** Reads one journal. Throws `upgrade_not_found` or `upgrade_corrupt` (exact schema, derived paths, regular files). */
export function readUpgrade(upgradeDir: string, id: string): UpgradeJournal {
  requireId(id);
  if (!ID.test(id)) throw new AppError("upgrade_not_found", 404);
  const path = journalPath(upgradeDir, id);
  let stats;
  try { stats = lstatSync(path); } catch { throw new AppError("upgrade_not_found", 404); }
  if (!stats.isFile() || stats.isSymbolicLink() || !realAttemptDir(upgradeDir, id)) throw new AppError("upgrade_corrupt", 500);
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, "utf8")); } catch { throw new AppError("upgrade_corrupt", 500); }
  return checkJournal(parsed, upgradeDir, id);
}

/** Bounded journal list, oldest first; unreadable entries are reported as corrupt placeholders, never skipped silently. */
export function listUpgrades(upgradeDir: string, limit = 50): UpgradeJournal[] {
  let entries: string[];
  try { entries = readdirSync(upgradeDir).filter(name => ID.test(name)); } catch { return []; }
  const journals: UpgradeJournal[] = [];
  for (const id of entries) {
    try { journals.push(readUpgrade(upgradeDir, id)); }
    catch (error) {
      if (error instanceof AppError && error.code === "upgrade_not_found") continue;
      journals.push(corruptUpgrade(id));
    }
  }
  journals.sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  return journals.slice(-Math.min(Math.max(limit, 1), 100));
}

/**
 * Durable blocked view of a journal that failed {@link readUpgrade}: no
 * actions, no paths, and it keeps the installation fenced (prepare refuses)
 * until a human inspects the control-plane file.
 */
export function corruptUpgrade(id: string): UpgradeJournal {
  return { id, contract: upgradeContract, fromSchema: -1, targetSchema: -1, state: "blocked", steps: [],
    preflight: { currentSchema: -1, targetSchema: -1, jitVersion: jitAppVersion, supported: { minSource: minUpgradeSourceSchema, target: currentSupportedSchema },
      migrations: [], engine: { engine: null, contract: null, formatVersion: null, compatible: false, reason: "upgrade_corrupt" },
      compatible: false, reason: "upgrade_corrupt", plannedSteps: [] },
    quiesce: null, snapshotBackupId: null, checkpoint: null, ledger: null, stagedPath: null, stagedSchema: null,
    liveDigest: null, stagedDigest: null, validation: null, reconcile: null,
    reason: "upgrade_corrupt", nextAction: "inspect_corrupt_upgrade_journal", requests: [], createdAt: 0, updatedAt: 0 };
}

/** The journal currently holding (or entitled to) the fence, if any. */
export function activeUpgrade(upgradeDir: string): UpgradeJournal | null {
  return listUpgrades(upgradeDir, 100).find(j => fencedUpgradeStates.includes(j.state) || j.state === "activated") ?? null;
}

/** Finds the journal that already accepted `requestId`. */
export function findUpgradeRequest(upgradeDir: string, requestId: string): { journal: UpgradeJournal; request: UpgradeRequest } | null {
  for (const journal of listUpgrades(upgradeDir, 100)) {
    const request = journal.requests.find(r => r.requestId === requestId);
    if (request) return { journal, request };
  }
  return null;
}

function saveJournal(upgradeDir: string, journal: UpgradeJournal): UpgradeJournal {
  writeFileAtomic(journalPath(upgradeDir, journal.id), JSON.stringify(journal));
  return journal;
}

function step(journal: UpgradeJournal, name: string, at: number, ok: boolean, detail: string): UpgradeStep[] {
  return [...journal.steps, { name, at, ok, detail }];
}

function withRequest(journal: UpgradeJournal, request: UpgradeRequest | null): UpgradeRequest[] {
  return request && !journal.requests.some(r => r.requestId === request.requestId) ? [...journal.requests, request] : journal.requests;
}

/** Sanitized upgrade evidence: versions, steps, validation, artifacts and next action. No secrets or native bytes. */
export function upgradeEvidence(journal: UpgradeJournal): UpgradeEvidence {
  return { ...(JSON.parse(JSON.stringify(journal)) as UpgradeJournal), actions: upgradeActions(journal) };
}

// ---------------------------------------------------------------------------
// Managed-state digest
// ---------------------------------------------------------------------------

/**
 * Tables outside managed application state: installation-scoped rows carried
 * across activation, scheduler/delivery claims, and the superseded in-database
 * upgrade journal (schema 19; control state now lives outside the database).
 */
const controlTables = new Set<string>([...installationScopedTables, "job_scheduler", "delivery_worker", "upgrade_journal"]);

interface TableShape { name: string; sql: string; columns: string[] }

function quoteIdent(name: string): string { return `"${name.replaceAll('"', '""')}"`; }

function managedTables(tx: AppTransaction): TableShape[] {
  return tx.all<{ name: string; sql: string | null }>("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .filter(row => !controlTables.has(row.name))
    .map(row => ({ name: row.name, sql: row.sql ?? "", columns: tx.all<{ name: string }>(`PRAGMA table_info(${quoteIdent(row.name)})`).map(c => c.name) }));
}

function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => item instanceof Uint8Array ? { $blob: Buffer.from(item).toString("hex") }
    : typeof item === "bigint" ? { $int: item.toString() } : item);
}

/** Order-independent digest of every row of `table` projected on `columns`; bounded, fail closed. */
function tableDigest(tx: AppTransaction, table: string, columns: string[]): { rows: number; hash: string } {
  const count = tx.get<{ n: number }>(`SELECT count(*) AS n FROM ${quoteIdent(table)}`)!.n;
  if (count > upgradeLimits.rowsPerTable) throw new AppError("upgrade_validation_bound_exceeded", 409);
  const rows = tx.all<Record<string, unknown>>(`SELECT ${columns.map(quoteIdent).join(", ")} FROM ${quoteIdent(table)}`);
  const lines = rows.map(row => canonical(columns.map(column => row[column]))).sort();
  return { rows: rows.length, hash: sha256(lines.join("\n")) };
}

/**
 * Epoch digest over all managed application state: schema version, every
 * managed table's definition and every row. Any committed write by any
 * writer (fenced or not) changes it, so activation bound to an unchanged
 * digest can never discard concurrent work.
 */
export function managedStateDigest(tx: AppTransaction): string {
  const parts: string[] = [`user_version:${tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version}`];
  for (const table of managedTables(tx)) parts.push(`${table.name}\n${table.sql}\n${tableDigest(tx, table.name, table.columns).hash}`);
  return sha256(parts.join("\n\n"));
}

function readSchema(tx: AppTransaction): number {
  return tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
}

/** Opens a staged copy; `migrate` applies this build's versioned migrations to it (never to live). */
function withStaged<T>(path: string, migrate: boolean, fn: (store: TransactionStore) => T): T {
  const staged = new TransactionStore(path, { migrateExisting: migrate });
  try { return fn(staged); } finally { staged.close(); }
}

// ---------------------------------------------------------------------------
// Trusted ledger sidecar
// ---------------------------------------------------------------------------

interface LedgerRows { deletions: string[]; suppressions: string[]; suppressedClaims: string[]; suppressedSources: string[]; sources: string[] }

function hasTable(tx: AppTransaction, name: string): boolean {
  return !!tx.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?", name);
}

/** Every lifecycle-ledger identity and source generation, canonical and sorted; bounded, fail closed. */
function ledgerRows(tx: AppTransaction): LedgerRows {
  const read = (table: string, columns: string[]): string[] => {
    if (!hasTable(tx, table)) return [];
    const count = tx.get<{ n: number }>(`SELECT count(*) AS n FROM ${quoteIdent(table)}`)!.n;
    if (count > upgradeLimits.ledgerRows) throw new AppError("upgrade_validation_bound_exceeded", 409);
    return tx.all<Record<string, unknown>>(`SELECT ${columns.map(quoteIdent).join(", ")} FROM ${quoteIdent(table)}`)
      .map(row => canonical(columns.map(c => row[c]))).sort();
  };
  return {
    deletions: read("deletion_ledger", ["id", "operation_id", "project_id", "kind", "source_id", "claim_id", "revision", "generation", "deleted_at"]),
    suppressions: read("memory_suppressions", ["id", "project_id", "claim_id", "record_json"]),
    suppressedClaims: read("memory_suppressed_claims", ["suppression_id", "project_id", "claim_id"]),
    suppressedSources: read("memory_suppressed_sources", ["suppression_id", "project_id", "source_id", "revision", "generation"]),
    sources: read("sources", ["id", "project_id", "current_revision", "generation", "availability"]),
  };
}

function writeLedgerSidecar(ctx: UpgradeContext, id: string, now: number): NonNullable<UpgradeJournal["ledger"]> {
  const captured = ctx.store.read(tx => ({ rows: ledgerRows(tx), checkpoint: lifecycleCheckpoint(tx).checkpoint }));
  const path = attemptFile(ctx, id, "ledger.json", true);
  const body = JSON.stringify({ contract: "app.deletion_ledger/v1", upgradeId: id, capturedAt: now, checkpoint: captured.checkpoint, ...captured.rows });
  writeFileAtomic(path, body);
  return { path, hash: sha256(body), checkpoint: captured.checkpoint, deletions: captured.rows.deletions.length,
    suppressions: captured.rows.suppressions.length, suppressedSources: captured.rows.suppressedSources.length, sources: captured.rows.sources.length };
}

function readLedgerSidecar(ctx: UpgradeContext, id: string, ledger: NonNullable<UpgradeJournal["ledger"]>): LedgerRows | null {
  try {
    const body = readFileSync(attemptFile(ctx, id, "ledger.json", false), "utf8");
    if (sha256(body) !== ledger.hash) return null;
    const parsed = JSON.parse(body) as LedgerRows;
    return parsed;
  } catch { return null; }
}

// ---------------------------------------------------------------------------
// Prepare
// ---------------------------------------------------------------------------

function baseJournal(ctx: UpgradeContext, id: string, fromSchema: number, targetSchema: number, now: number, engine: UpgradeEngineCheck,
  migrations: number[]): UpgradeJournal {
  return { id, contract: upgradeContract, fromSchema, targetSchema, state: "preparing", steps: [],
    preflight: { currentSchema: fromSchema, targetSchema, jitVersion: ctx.jitVersion,
      supported: { minSource: minUpgradeSourceSchema, target: currentSupportedSchema }, migrations, engine,
      compatible: false, reason: null, plannedSteps: [] },
    quiesce: null, snapshotBackupId: null, checkpoint: null, ledger: null, stagedPath: null, stagedSchema: null,
    liveDigest: null, stagedDigest: null, validation: null, reconcile: null, reason: null, nextAction: "",
    requests: [], createdAt: now, updatedAt: now };
}

const disabledWork = ["job_admission", "automatic_contexts", "memory_extraction", "pr_monitoring", "schedules", "delivery"];

/**
 * upgrade.prepare. Schema preflight and declared engine compatibility run
 * first and fail with a failed journal before anything is fenced, snapshotted
 * or written to the installation database. A compatible plan then fences
 * admission durably, quiesces the service, creates exactly one recovery point
 * through staged ops.backup_manifest/v1 creation (the native port is invoked
 * once, inside that backup) and writes the trusted ledger sidecar. Any failure
 * after the fence releases it, resumes the service and leaves a failed
 * journal; the live installation is unchanged except for the committed backup.
 */
export async function prepareUpgrade(ctx: UpgradeContext, input: { request: UpgradeRequest; targetSchema: number; note: string }): Promise<UpgradeJournal> {
  const now = ctx.now();
  if (readUpgradeFence(ctx.store.path) || activeUpgrade(ctx.upgradeDir)) throw new AppError("upgrade_in_progress", 409);
  const fromSchema = ctx.store.read(readSchema);
  const id = randomUUID();
  const schema = planSchema(fromSchema, input.targetSchema);
  const unchecked: UpgradeEngineCheck = { engine: ctx.port?.engine ?? null, contract: ctx.port?.contract ?? null,
    formatVersion: ctx.port?.formatVersion ?? null, compatible: false, reason: "not_checked" };
  if (!schema.compatible) {
    // Schema rejection never consults the engine or native port.
    saveJournal(ctx.upgradeDir, { ...baseJournal(ctx, id, fromSchema, input.targetSchema, now, unchecked, []), state: "failed",
      steps: [{ name: "preflight", at: now, ok: false, detail: schema.reason! }],
      preflight: { ...baseJournal(ctx, id, fromSchema, input.targetSchema, now, unchecked, []).preflight, reason: schema.reason },
      reason: schema.reason, nextAction: "inspect_preflight_and_retry_with_supported_target", requests: [input.request] });
    throw new AppError("unsupported_upgrade", 409);
  }
  const engine = inspectUpgradeEngine(ctx.port);
  const base = baseJournal(ctx, id, fromSchema, input.targetSchema, now, engine, schema.migrations);
  if (!engine.compatible) {
    saveJournal(ctx.upgradeDir, { ...base, state: "failed", steps: [{ name: "preflight", at: now, ok: false, detail: engine.reason! }],
      preflight: { ...base.preflight, reason: engine.reason }, reason: engine.reason,
      nextAction: "configure_supported_engine_snapshot_then_prepare_again", requests: [input.request] });
    throw new AppError(engine.reason === "unsupported_engine" ? "unsupported_engine" : "engine_unavailable", 409);
  }
  let journal = saveJournal(ctx.upgradeDir, { ...base, state: "preparing",
    preflight: { ...base.preflight, compatible: true, plannedSteps: [...plannedSteps] },
    steps: [{ name: "preflight", at: now, ok: true, detail: `schema_${fromSchema}_to_${input.targetSchema}` }],
    nextAction: "wait_for_quiesce_and_recovery_point", requests: [input.request] });
  writeUpgradeFence(ctx.store.path, id, now);
  journal = saveJournal(ctx.upgradeDir, { ...journal, steps: step(journal, "fence", now, true, "admission_fenced") });
  ctx.fault?.("fenced");
  let phase = "quiesce";
  try {
    const quiesce = await ctx.service.quiesce();
    journal = saveJournal(ctx.upgradeDir, { ...journal, quiesce: { ...quiesce, disabled: [...disabledWork] },
      steps: step(journal, "quiesce", ctx.now(), quiesce.settled, quiesce.detail), updatedAt: ctx.now() });
    if (!quiesce.settled) throw new AppError("upgrade_quiesce_incomplete", 409);
    ctx.fault?.("quiesced");
    phase = "snapshot";
    const manifest = await stageManagedBackup<BackupManifest>({
      store: ctx.store, backupDir: ctx.backupDir, port: ctx.port, jitVersion: ctx.jitVersion, now: ctx.now, inflight: ctx.inflight,
      guard: tx => { ctx.authorize(tx); return null; },
      record: (_tx, committed) => committed,
    });
    journal = saveJournal(ctx.upgradeDir, { ...journal, snapshotBackupId: manifest.id,
      checkpoint: { backupId: manifest.id, appSchema: manifest.appSchema, appRevision: manifest.appRevision, jitVersion: manifest.jitVersion,
        lifecycle: manifest.lifecycle.checkpoint, nativeRefs: manifest.native.refs.length, nativeEngine: manifest.native.engine,
        nativeContract: manifest.native.contract, artifactHash: manifest.artifact.hash },
      updatedAt: ctx.now() });
    if (manifest.state !== "valid") throw new AppError(`recovery_point_${manifest.reason ?? "incomplete"}`.slice(0, 64), 409);
    const integrity = verifyBackupArtifacts(manifest, ctx.backupDir);
    if (integrity.state !== "verified") throw new AppError(`recovery_point_${integrity.reason}`.slice(0, 64), 409);
    journal = saveJournal(ctx.upgradeDir, { ...journal, steps: step(journal, "snapshot", ctx.now(), true, manifest.id) });
    ctx.fault?.("snapshot");
    phase = "ledger";
    const ledger = writeLedgerSidecar(ctx, id, ctx.now());
    // The fence holds, so the separately captured ledger must be the recovery point's position.
    if (ledger.checkpoint !== manifest.lifecycle.checkpoint) throw new AppError("ledger_moved_during_snapshot", 409);
    journal = saveJournal(ctx.upgradeDir, { ...journal, state: "prepared", ledger,
      stagedPath: upgradeStagedPath(ctx.upgradeDir, id),
      steps: step(journal, "ledger", ctx.now(), true, `deletions_${ledger.deletions}_suppressions_${ledger.suppressions}_sources_${ledger.sources}`),
      reason: null, nextAction: "migrate_to_staged_copy", updatedAt: ctx.now() });
    ctx.fault?.("ledger");
    return journal;
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error;
    const reason = error instanceof AppError && /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : `interrupted_at_${phase}`;
    await failAfterFence(ctx, journal, phase, reason);
    throw error instanceof AppError ? error : new AppError(reason, 500);
  }
}

/** Ends a fenced attempt that never activated: failed journal, fence released, service resumed. */
async function failAfterFence(ctx: UpgradeContext, journal: UpgradeJournal, phase: string, reason: string): Promise<UpgradeJournal> {
  const now = ctx.now();
  let failed = saveJournal(ctx.upgradeDir, { ...journal, state: "failed", steps: step(journal, phase, now, false, reason), reason,
    nextAction: journal.snapshotBackupId ? "inspect_failure_then_prepare_again" : "resolve_engine_snapshot_then_prepare_again", updatedAt: now });
  clearUpgradeFence(ctx.store.path);
  const resumed = await safeResume(ctx);
  failed = saveJournal(ctx.upgradeDir, { ...failed, reconcile: { ...resumed, at: ctx.now() } });
  removeStaged(ctx, failed);
  recordAudit(ctx, failed);
  return failed;
}

async function safeResume(ctx: UpgradeContext): Promise<UpgradeResumeResult> {
  try { return await ctx.service.resume(); }
  catch (error) { return { reconciled: false, detail: error instanceof AppError ? error.code : "service_resume_failed" }; }
}

/**
 * Best-effort maintenance cleanup for attempts that already ended (complete,
 * failed) or are about to be re-copied: removes only a regular file at the
 * derived staged path; anything else is left untouched. Rollback uses the
 * strict {@link discardStaged} instead.
 */
function removeStaged(ctx: UpgradeContext, journal: UpgradeJournal): void {
  if (!journal.stagedPath) return;
  let path: string;
  try { path = attemptFile(ctx, journal.id, "staged.sqlite", true); } catch { return; }
  for (const suffix of ["", "-wal", "-shm"]) {
    try { rmSync(`${path}${suffix}`, { force: true }); } catch { /* Left for the next prune. */ }
  }
}

/**
 * Strict staged-copy removal for a fenced attempt: the artifact must be a
 * regular file at the derived path ({@link stepFile}) and must be gone
 * afterwards. Anything unsafe or undeletable moves the journal to durable
 * `blocked` `upgrade_corrupt` and throws, so the fence is never released over it.
 */
function discardStaged(ctx: UpgradeContext, journal: UpgradeJournal): void {
  if (!journal.stagedPath) return;
  const path = stepFile(ctx, journal, "staged.sqlite", true);
  for (const suffix of ["", "-wal", "-shm"]) {
    const target = `${path}${suffix}`;
    let gone = false;
    try { rmSync(target, { force: true }); gone = !existsSync(target); } catch { gone = false; }
    if (!gone) {
      saveJournal(ctx.upgradeDir, { ...journal, state: "blocked", steps: step(journal, "attempt_files", ctx.now(), false, "staged_copy_undeletable"),
        reason: "upgrade_corrupt", stagedDigest: null, nextAction: "inspect_corrupt_upgrade_attempt_files", updatedAt: ctx.now() });
      throw new AppError("upgrade_corrupt", 500);
    }
  }
}

/**
 * Mirrors the journal's accepted requests into the installation's ordinary
 * receipts and audit, once the attempt is terminal (after any swap, so the
 * rows can never be discarded by activation). Idempotent.
 */
function recordAudit(ctx: UpgradeContext, journal: UpgradeJournal): void {
  try {
    ctx.store.transaction(tx => {
      for (const request of journal.requests) {
        tx.run("INSERT OR IGNORE INTO command_receipts VALUES ('owner', ?, ?, ?, ?)", request.requestId, request.payloadHash,
          JSON.stringify({ upgradeId: journal.id, kind: request.kind, state: journal.state }), request.at);
        tx.run("INSERT OR IGNORE INTO audit (actor_id, command_kind, request_id, project_id, committed_at) VALUES ('owner', ?, ?, 'owner', ?)",
          request.kind, request.requestId, request.at);
      }
    });
  } catch { /* The control-plane journal remains the authoritative record. */ }
  pruneJournals(ctx.upgradeDir);
}

function pruneJournals(upgradeDir: string): void {
  const journals = listUpgrades(upgradeDir, 100).filter(j => terminalUpgradeStates.includes(j.state));
  for (const journal of journals.slice(0, Math.max(0, journals.length - upgradeLimits.journals))) {
    try { rmSync(join(upgradeDir, journal.id), { recursive: true, force: true }); } catch { /* Retried next prune. */ }
  }
}

/** Re-establishes the fence for a fenced journal whose fence file disappeared. */
function ensureFence(ctx: UpgradeContext, journal: UpgradeJournal): void {
  const fence = readUpgradeFence(ctx.store.path);
  if (fence && fence.upgradeId !== journal.id) throw new AppError("upgrade_in_progress", 409);
  if (!fence) writeUpgradeFence(ctx.store.path, journal.id, ctx.now());
}

// ---------------------------------------------------------------------------
// Migrate
// ---------------------------------------------------------------------------

/**
 * upgrade.migrate: copies the fenced live image to staged storage, proves the
 * copy is faithful (same managed digest), then applies this build's versioned
 * migrations to the staged copy only. The live installation is never
 * migrated or otherwise written. Native sessions are not migrated: the engine
 * contract is unchanged (exact-match compat) and native bytes stay opaque.
 */
export function migrateUpgrade(ctx: UpgradeContext, journal: UpgradeJournal, request: UpgradeRequest | null): UpgradeJournal {
  if (!(journal.state === "prepared" || (journal.state === "blocked" && journal.snapshotBackupId && journal.stagedPath))) {
    throw new AppError("upgrade_bad_state", 409);
  }
  ensureFence(ctx, journal);
  const now = ctx.now();
  const stagedPath = stepFile(ctx, journal, "staged.sqlite", true);
  const block = (reason: string, detail: string, liveDigest: string | null): never => {
    removeStaged(ctx, journal);
    saveJournal(ctx.upgradeDir, { ...journal, state: "blocked", steps: step(journal, "migrate", now, false, detail), reason,
      stagedSchema: null, liveDigest, stagedDigest: null, validation: null,
      nextAction: "inspect_failed_migration_then_migrate_again_or_rollback", requests: withRequest(journal, request), updatedAt: now });
    throw new AppError(reason, 409);
  };
  let captured: { digest: string; bytes: Uint8Array };
  try { captured = ctx.store.read(tx => ({ digest: managedStateDigest(tx), bytes: ctx.store.snapshotBytes() })); }
  catch (error) {
    const code = error instanceof AppError ? error.code : "staged_copy_unreadable";
    return block(code, code, null);
  }
  removeStaged(ctx, journal);
  writeFileAtomic(stagedPath, captured.bytes);
  ctx.fault?.("staged_copy");
  let copyDigest: string;
  try { copyDigest = withStaged(stagedPath, false, staged => staged.read(managedStateDigest)); }
  catch { return block("staged_copy_unreadable", "staged_copy_unreadable", captured.digest); }
  if (copyDigest !== captured.digest) return block("staged_copy_mismatch", "staged_copy_mismatch", captured.digest);
  let stagedSchema: number;
  try { stagedSchema = withStaged(stagedPath, true, staged => staged.read(readSchema)); }
  catch { return block("staged_migration_failed", "staged_migration_failed", captured.digest); }
  if (stagedSchema !== journal.targetSchema) return block("staged_migration_failed", `staged_schema_${stagedSchema}`, captured.digest);
  const migrated = saveJournal(ctx.upgradeDir, { ...journal, state: "staged", stagedSchema, liveDigest: captured.digest, stagedDigest: null,
    validation: null, steps: step(journal, "migrate", now, true, `staged_schema_${journal.fromSchema}_to_${stagedSchema}`),
    reason: null, nextAction: "validate_staged_copy", requests: withRequest(journal, request), updatedAt: now });
  ctx.fault?.("migrated");
  return migrated;
}

// ---------------------------------------------------------------------------
// Validate
// ---------------------------------------------------------------------------

function check(checks: UpgradeCheck[], name: string, run: () => string | true): void {
  try {
    const result = run();
    checks.push(result === true ? { name, pass: true, detail: "ok" } : { name, pass: false, detail: result });
  } catch (error) {
    checks.push({ name, pass: false, detail: error instanceof AppError ? error.code : "check_failed" });
  }
}

function count(tx: AppTransaction, sql: string, ...bindings: (string | number)[]): number {
  return tx.get<{ n: number }>(sql, ...bindings)?.n ?? 0;
}

function boundedAll<T>(tx: AppTransaction, table: string, sql: string): T[] {
  if (count(tx, `SELECT count(*) AS n FROM ${quoteIdent(table)}`) > upgradeLimits.rowsPerTable) throw new AppError("upgrade_validation_bound_exceeded", 409);
  return tx.all<T>(sql);
}

const attemptStates = ["prepared", "dispatched", "committed", "interrupted", "rejected"];
const attemptNativeStates = ["uninspected", "missing", "running", "finished"];
const attemptContextStates = ["none", "pending", "retired", "deleted", "retire_failed", "delete_failed"];
const attemptTransports = ["none", "dispatched", "settled"];
const runRequestKeys = ["runId", "projectId", "topicId", "roleId", "purpose", "route", "configuration", "context", "fence", "instructions", "manifest", "tools", "policy", "limits"];

/**
 * Exact JobAttempt schema (src/jobs/attempts.ts) bound to its table row and
 * owning job; a non-null native reference additionally requires `data` to be
 * the admitted ApplicationRunRequest for exactly that run, context, job and
 * attempt generation. Returns a problem label, or null when the envelope holds.
 */
function attemptEnvelopeProblem(attempt: unknown, row: { id: string; job_id: string }): string | null {
  if (!isObject(attempt) || !exact(attempt, ["native", "data", "id", "jobId", "generation", "scheduler", "leaseUntil", "snapshot", "createdAt",
    "state", "reason", "nativeState", "contextState", "transport"])) return "envelope_invalid";
  if (attempt.id !== row.id || attempt.jobId !== row.job_id || !isInt(attempt.generation, 1) || typeof attempt.scheduler !== "string" ||
      !attempt.scheduler || !isInt(attempt.leaseUntil) || !isInt(attempt.createdAt) || !attemptStates.includes(attempt.state as string) ||
      !(attempt.reason === null || isText(attempt.reason, 64)) || !attemptNativeStates.includes(attempt.nativeState as string) ||
      !attemptContextStates.includes(attempt.contextState as string) || !attemptTransports.includes(attempt.transport as string)) return "envelope_invalid";
  const snapshot = attempt.snapshot;
  if (!isObject(snapshot) || snapshot.id !== row.job_id || typeof snapshot.projectId !== "string" || typeof snapshot.type !== "string" ||
      !isInt(snapshot.revision, 1) || typeof snapshot.state !== "string") return "snapshot_invalid";
  const native = attempt.native;
  if (native === null) return attempt.contextState === "none" ? null : "context_state_without_native";
  if (!isObject(native) || !exact(native, ["adapter", "runId", "sessionId", "context"]) || !["scripted", "schway"].includes(native.adapter as string) ||
      typeof native.runId !== "string" || !ID.test(native.runId) || native.sessionId !== native.runId || !isObject(native.context) ||
      !exact(native.context, ["id", "generation"]) || typeof native.context.id !== "string" || !isInt(native.context.generation, 1)) {
    return "native_ref_invalid";
  }
  if (attempt.contextState === "none") return "native_without_context_state";
  const data = attempt.data;
  if (!isObject(data) || !exact(data, runRequestKeys)) return "run_request_invalid";
  const context = native.context as { id: string; generation: number };
  const runContext = data.context, fence = data.fence;
  if (data.runId !== native.runId || data.projectId !== snapshot.projectId || !isObject(runContext) || !exact(runContext, ["id", "generation"]) ||
      runContext.id !== context.id || runContext.generation !== context.generation) return "run_mismatch";
  if (!isObject(fence) || fence.jobId !== row.job_id || fence.generation !== attempt.generation || !isInt(fence.ownerGeneration, 1)) return "fence_mismatch";
  return null;
}

/**
 * upgrade.validate: checks the staged copy before anything switches. Every
 * row of every managed table is examined (bounded by `upgradeLimits`, fail
 * closed): the live installation is unchanged since migrate; every live table,
 * column and row survives in the staged copy except supported schema
 * evolution (which covers command receipts, revisions, jobs, outbox and
 * native references exactly); foreign keys; receipts parse; task and
 * decision provenance; source lineage; job authority and attempts; outbox
 * intent/attempt relations; native opaque references against the recovery
 * point's native set; the trusted ledger sidecar row-for-row; and quiesce.
 */
export function validateUpgrade(ctx: UpgradeContext, journal: UpgradeJournal, request: UpgradeRequest | null): UpgradeJournal {
  if (journal.state !== "staged" || !journal.stagedPath || journal.stagedSchema === null) throw new AppError("upgrade_bad_state", 409);
  ensureFence(ctx, journal);
  const now = ctx.now();
  const checks: UpgradeCheck[] = [];
  const manifest = journal.snapshotBackupId ? ctx.store.read(tx => readBackupManifest(tx, journal.snapshotBackupId!)) : null;
  const live = ctx.store.read(tx => {
    const tables = managedTables(tx);
    let digests: Map<string, string> | null = null;
    try { digests = new Map(tables.map(t => [t.name, tableDigest(tx, t.name, t.columns).hash])); } catch { digests = null; }
    let digest: string | null = null;
    try { digest = managedStateDigest(tx); } catch { digest = null; }
    return {
      schema: readSchema(tx), tables, digests, digest,
      admitted: count(tx, "SELECT count(*) AS n FROM jobs WHERE state = 'admitted' OR occupies = 1"),
      queued: count(tx, "SELECT count(*) AS n FROM jobs WHERE state IN ('queued', 'waiting')"),
    };
  });
  check(checks, "live_unchanged_since_migrate", () => live.digest === journal.liveDigest || "live_changed_since_migrate");
  check(checks, "engine_compat", () => {
    if (!journal.preflight.engine.compatible || journal.preflight.engine.contract !== upgradeEngineContract) return "unsupported_upgrade_engine";
    const current = inspectUpgradeEngine(ctx.port);
    return current.compatible && current.contract === journal.preflight.engine.contract && current.formatVersion === journal.preflight.engine.formatVersion
      || `engine_${current.reason ?? "changed"}`;
  });
  check(checks, "recovery_point", () => {
    if (!manifest || manifest.state !== "valid") return "recovery_point_missing";
    const integrity = verifyBackupArtifacts(manifest, ctx.backupDir);
    return integrity.state === "verified" || `recovery_point_${integrity.reason}`;
  });
  check(checks, "quiesce", () => live.admitted === 0 || `admitted_${live.admitted}_running`);
  let summary = { tables: 0, rows: 0, nativeRefs: 0, unknownOutbox: 0, ledgersMatch: false, stagedSchema: journal.stagedSchema, stagedDigest: null as string | null };
  const stagedPath = stepFile(ctx, journal, "staged.sqlite", false);
  try {
    summary = withStaged(stagedPath, false, staged => staged.read(tx => {
      const stagedSchema = readSchema(tx);
      let tables = 0, rows = 0, nativeRefs = 0, unknownOutbox = 0, ledgersMatch = false;
      check(checks, "staged_schema", () => stagedSchema === journal.targetSchema && stagedSchema === currentSupportedSchema || `schema_${stagedSchema}_unsupported`);
      check(checks, "foreign_keys", () => tx.all("PRAGMA foreign_key_check").length === 0 || "violations_found");
      check(checks, "preservation", () => {
        if (!live.digests) return "upgrade_validation_bound_exceeded";
        const stagedTables = new Map(managedTables(tx).map(t => [t.name, t]));
        const lost: string[] = [];
        for (const table of live.tables) {
          const target = stagedTables.get(table.name);
          if (!target || table.columns.some(c => !target.columns.includes(c))) { lost.push(`${table.name}_dropped`); continue; }
          const digest = tableDigest(tx, table.name, table.columns);
          tables++; rows += digest.rows;
          // Same projection on the live columns: identical rows, nothing added, lost or rewritten.
          if (digest.hash !== live.digests.get(table.name)) lost.push(`${table.name}_changed`);
        }
        return lost.length === 0 || lost.slice(0, 8).join(",");
      });
      check(checks, "receipts_and_revisions", () => {
        for (const row of boundedAll<{ result_json: string }>(tx, "command_receipts", "SELECT result_json FROM command_receipts")) {
          try { JSON.parse(row.result_json); } catch { return "unreadable_command_receipt"; }
        }
        const revision = tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")?.revision;
        const liveRevision = ctx.store.read(ltx => ltx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")?.revision);
        if (revision === undefined || revision !== liveRevision) return "app_revision_changed";
        for (const row of boundedAll<{ revision: number }>(tx, "projects", "SELECT revision FROM projects")) {
          if (!Number.isSafeInteger(row.revision) || row.revision < 1) return "project_revision_invalid";
        }
        return true;
      });
      check(checks, "task_provenance", () => {
        if (!hasTable(tx, "tasks")) return true;
        for (const row of boundedAll<{ id: string; projectId: string; sourceId: string; revision: number; generation: number }>(tx, "tasks",
          "SELECT id, project_id AS projectId, source_id AS sourceId, source_revision AS revision, source_generation AS generation FROM tasks")) {
          const found = lookupSource(tx, row.projectId, { sourceId: row.sourceId, revision: row.revision, generation: row.generation });
          if (found.state === "unavailable" && !["source_unavailable", "revision_unavailable", "generation_unavailable"].includes(found.reason)) return `task_${row.id}`;
        }
        return true;
      });
      check(checks, "decision_provenance", () => {
        if (!hasTable(tx, "decision_proposals")) return true;
        const orphans = count(tx, "SELECT count(*) AS n FROM decision_proposals d WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = d.source_id)");
        return orphans === 0 || `proposals_without_source_${orphans}`;
      });
      check(checks, "source_lineage", () => {
        const missingVersion = count(tx, `SELECT count(*) AS n FROM sources s WHERE NOT EXISTS (SELECT 1 FROM source_versions v
          WHERE v.source_id = s.id AND v.revision = s.current_revision AND v.generation = s.generation)`);
        if (missingVersion) return `sources_without_current_version_${missingVersion}`;
        const orphanVersions = count(tx, "SELECT count(*) AS n FROM source_versions v WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = v.source_id)");
        if (orphanVersions) return `versions_without_source_${orphanVersions}`;
        const suppressed = hasTable(tx, "memory_suppressed_sources")
          ? count(tx, "SELECT count(*) AS n FROM memory_suppressed_sources m WHERE NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = m.source_id)") : 0;
        return suppressed === 0 || `suppressed_lineage_missing_${suppressed}`;
      });
      check(checks, "jobs", () => {
        const withoutAuthority = count(tx, "SELECT count(*) AS n FROM jobs j WHERE NOT EXISTS (SELECT 1 FROM job_authority a WHERE a.job_id = j.id)");
        if (withoutAuthority) return `jobs_without_authority_${withoutAuthority}`;
        const orphanAttempts = count(tx, "SELECT count(*) AS n FROM job_attempts a WHERE NOT EXISTS (SELECT 1 FROM jobs j WHERE j.id = a.job_id)");
        if (orphanAttempts) return `attempts_without_job_${orphanAttempts}`;
        for (const row of boundedAll<{ id: string; record_json: string }>(tx, "jobs", "SELECT id, record_json FROM jobs")) {
          try { if ((JSON.parse(row.record_json) as { id?: unknown }).id !== row.id) return `job_${row.id}_record_mismatch`; }
          catch { return `job_${row.id}_unreadable`; }
        }
        return true;
      });
      check(checks, "outbox", () => {
        if (!hasTable(tx, "delivery_intents")) return true;
        const orphans = count(tx, "SELECT count(*) AS n FROM delivery_attempts a WHERE NOT EXISTS (SELECT 1 FROM delivery_intents i WHERE i.id = a.intent_id)");
        if (orphans) return `attempts_without_intent_${orphans}`;
        for (const row of boundedAll<{ record_json: string }>(tx, "delivery_intents", "SELECT record_json FROM delivery_intents")) {
          let status: unknown;
          try { status = (JSON.parse(row.record_json) as { status?: unknown }).status; } catch { return "unreadable_delivery_intent"; }
          if (status === "unknown") unknownOutbox++;
        }
        return true;
      });
      check(checks, "native_opaque_refs", () => {
        const contexts = new Map<string, string>();
        for (const row of boundedAll<{ id: string; generation: number; state: string }>(tx, "team_contexts", "SELECT id, generation, state FROM team_contexts")) {
          if (!["active", "retired", "delete_failed", "deleted"].includes(row.state) || !Number.isSafeInteger(row.generation) || row.generation < 1) return "team_context_invalid";
          contexts.set(`${row.id}/${row.generation}`, row.state);
        }
        const refs = new Map<string, { context_id: string; generation: number; session_id: string; state: string }>();
        const covered: string[] = [];
        if (hasTable(tx, "schway_native_refs")) {
          for (const row of boundedAll<{ run_id: string; context_id: string; generation: number; session_id: string; branch_id: string; state: string }>(tx, "schway_native_refs",
            "SELECT run_id, context_id, generation, session_id, branch_id, state FROM schway_native_refs ORDER BY sequence")) {
            nativeRefs++;
            if (!Number.isSafeInteger(row.generation) || row.generation < 1 || !["running", "finished"].includes(row.state) ||
                typeof row.session_id !== "string" || typeof row.branch_id !== "string") return "native_ref_invalid";
            refs.set(row.run_id, row);
            const contextState = contexts.get(`${row.context_id}/${row.generation}`);
            if (contextState === "deleted") continue;
            if (!contextState) return "native_ref_orphaned";
            covered.push(canonical([row.run_id, row.generation]));
          }
        }
        // Every attempt's native identity must belong to an existing context, to its own job and run
        // request, and (for Schway) correlate exactly with the durable bridge row. Bytes stay opaque.
        for (const row of boundedAll<{ id: string; job_id: string; record_json: string }>(tx, "job_attempts", "SELECT id, job_id, record_json FROM job_attempts")) {
          let attempt: Record<string, unknown>;
          try { attempt = JSON.parse(row.record_json) as Record<string, unknown>; } catch { return "attempt_unreadable"; }
          const problem = attemptEnvelopeProblem(attempt, row);
          if (problem) return `attempt_${row.id}_${problem}`;
          const native = attempt.native as { adapter: string; runId: string; sessionId: string; context: { id: string; generation: number } } | null;
          if (native === null) continue;
          nativeRefs++;
          const context = native.context;
          if (!contexts.has(`${context.id}/${context.generation}`)) return `attempt_${row.id}_context_orphaned`;
          if (native.adapter === "schway") {
            const ref = refs.get(native.runId as string);
            const engaged = attempt.transport !== "none" || ["running", "finished"].includes(attempt.nativeState as string);
            if (!ref) { if (engaged) return `attempt_${row.id}_native_ref_missing`; continue; }
            if (ref.context_id !== context.id || ref.generation !== context.generation) return `attempt_${row.id}_native_ref_mismatch`;
            if (attempt.nativeState === "finished" && ref.session_id === "") return `attempt_${row.id}_native_session_unresolved`;
          }
        }
        // Opaque binding: the recovery point captured exactly the staged copy's live native set.
        const captured = (manifest?.native.refs ?? []).map(r => canonical([r.id, r.generation]));
        if (!manifest || manifest.native.state !== "valid") return "native_recovery_point_invalid";
        if (canonical([...covered].sort()) !== canonical([...captured].sort())) return "native_refs_differ_from_recovery_point";
        return true;
      });
      check(checks, "ledger_preservation", () => {
        if (!journal.ledger) return "ledger_sidecar_missing";
        const sidecar = readLedgerSidecar(ctx, journal.id, journal.ledger);
        if (!sidecar) return "ledger_sidecar_unreadable";
        const staged = ledgerRows(tx);
        for (const key of ["deletions", "suppressions", "suppressedClaims", "suppressedSources", "sources"] as const) {
          if (canonical(staged[key]) !== canonical(sidecar[key])) return `${key}_differ`;
        }
        ledgersMatch = true;
        return true;
      });
      let stagedDigest: string | null = null;
      try { stagedDigest = managedStateDigest(tx); } catch { stagedDigest = null; }
      check(checks, "staged_digest", () => stagedDigest !== null || "upgrade_validation_bound_exceeded");
      return { tables, rows, nativeRefs, unknownOutbox, ledgersMatch, stagedSchema, stagedDigest };
    }));
  } catch {
    checks.push({ name: "staged_copy", pass: false, detail: "staged_copy_unreadable" });
  }
  const pass = checks.every(c => c.pass);
  const validation: UpgradeValidation = { stagedSchema: summary.stagedSchema ?? -1, liveSchema: live.schema, checks,
    ledgersMatch: summary.ledgersMatch, outstanding: { queued: live.queued, admitted: live.admitted },
    unknownOutbox: summary.unknownOutbox, nativeRefs: summary.nativeRefs, tables: summary.tables, rows: summary.rows };
  const validated = saveJournal(ctx.upgradeDir, { ...journal, state: pass ? "ready" : "blocked", validation,
    stagedDigest: pass ? summary.stagedDigest : null,
    steps: step(journal, "validate", now, pass, pass ? "all_checks_pass" : checks.filter(c => !c.pass).map(c => c.name).join(",")),
    reason: pass ? null : "validation_failed",
    nextAction: pass ? "activate_staged_copy_or_rollback" : "inspect_failed_check_then_migrate_again_or_rollback",
    requests: withRequest(journal, request), updatedAt: now });
  ctx.fault?.("validated");
  return validated;
}

// ---------------------------------------------------------------------------
// Activate and reconcile
// ---------------------------------------------------------------------------

/**
 * Resolves a persisted activation intent against the live database identity:
 * the validated staged digest means the swap happened (`activated`); the
 * pre-activation digest means it did not (`ready`, intent void); anything else
 * is an unsupported partial state that stays `blocked`. Never guesses.
 */
export function resolveActivation(store: TransactionStore, upgradeDir: string, journal: UpgradeJournal, now: number): UpgradeJournal {
  if (journal.state !== "activating") return journal;
  let digest: string | null = null;
  try { digest = store.read(managedStateDigest); } catch { digest = null; }
  if (digest !== null && digest === journal.stagedDigest) {
    return saveJournal(upgradeDir, { ...journal, state: "activated", steps: step(journal, "activate", now, true, "staged_is_live_after_reopen"),
      reason: null, nextAction: "reconcile_jobs_sessions_then_resume", updatedAt: now });
  }
  if (digest !== null && digest === journal.liveDigest) {
    return saveJournal(upgradeDir, { ...journal, state: "ready", steps: step(journal, "activate", now, false, "swap_not_applied"),
      reason: "activation_interrupted", nextAction: "activate_staged_copy_or_rollback", updatedAt: now });
  }
  return saveJournal(upgradeDir, { ...journal, state: "blocked", steps: step(journal, "activate", now, false, "live_identity_unknown"),
    reason: "activation_state_unknown", nextAction: "inspect_installation_then_restore_pre_upgrade_backup_through_ops02", updatedAt: now });
}

/**
 * Reopen reconciliation for every journal: an interrupted prepare becomes
 * failed and releases the fence (the live installation was never migrated);
 * an activation intent is resolved by {@link resolveActivation}. Fenced
 * journals keep their fence. Synchronous; never resumes work by itself.
 */
export function recoverUpgradesOnOpen(store: TransactionStore, upgradeDir: string, now: number): UpgradeJournal | null {
  for (const journal of listUpgrades(upgradeDir, 100)) {
    if (journal.state === "preparing") {
      saveJournal(upgradeDir, { ...journal, state: "failed", steps: step(journal, "prepare", now, false, "prepare_interrupted"),
        reason: "prepare_interrupted", nextAction: "inspect_failure_then_prepare_again", updatedAt: now });
      const fence = readUpgradeFence(store.path);
      if (fence?.upgradeId === journal.id) clearUpgradeFence(store.path);
    } else if (journal.state === "activating") {
      resolveActivation(store, upgradeDir, journal, now);
    }
  }
  const active = activeUpgrade(upgradeDir);
  const fence = readUpgradeFence(store.path);
  if (active && fencedUpgradeStates.includes(active.state)) {
    // A fenced journal whose fence file vanished is re-fenced; durable intent wins.
    if (!fence) writeUpgradeFence(store.path, active.id, now);
  } else if (fence && fence.upgradeId !== "unknown" && (!active || active.id === fence.upgradeId)) {
    // The fence's journal activated (reconcile at boot needs admission) or ended; release it.
    // A fence of unknown origin is never released automatically.
    const owner = listUpgrades(upgradeDir, 100).find(j => j.id === fence.upgradeId);
    if (owner && !fencedUpgradeStates.includes(owner.state)) clearUpgradeFence(store.path);
  }
  return active;
}

/**
 * upgrade.activate: under service lifecycle ownership — quiesce again, prove
 * the live installation is exactly the fenced state validated against and the
 * staged copy is exactly the validated one, persist activation intent, swap
 * atomically, prove the live identity is the validated staged copy, then
 * release the fence, rebuild ports and reconcile jobs/native sessions before
 * marking complete. If reconciliation fails the journal stays `activated`
 * (explicit, retryable) and nothing claims success.
 */
export async function activateUpgrade(ctx: UpgradeContext, journal: UpgradeJournal, request: UpgradeRequest | null): Promise<UpgradeJournal> {
  if (journal.state === "activating") journal = resolveActivation(ctx.store, ctx.upgradeDir, journal, ctx.now());
  if (journal.state === "activated") return completeActivation(ctx, journal, request);
  if (journal.state !== "ready" || !journal.stagedPath || !journal.stagedDigest || !journal.liveDigest) throw new AppError("upgrade_bad_state", 409);
  ensureFence(ctx, journal);
  const quiesce = await ctx.service.quiesce();
  if (!quiesce.settled) {
    saveJournal(ctx.upgradeDir, { ...journal, steps: step(journal, "quiesce", ctx.now(), false, quiesce.detail), updatedAt: ctx.now() });
    throw new AppError("upgrade_quiesce_incomplete", 409);
  }
  // From here to the swap nothing awaits: no in-process writer can interleave.
  const now = ctx.now();
  const block = (reason: string, detail: string): never => {
    saveJournal(ctx.upgradeDir, { ...journal, state: "blocked", steps: step(journal, "activate", now, false, detail), reason, stagedDigest: null,
      nextAction: "migrate_again_then_validate_or_rollback", requests: withRequest(journal, request), updatedAt: now });
    throw new AppError(reason, 409);
  };
  let liveDigest: string | null = null, stagedDigest: string | null = null;
  try { liveDigest = ctx.store.read(managedStateDigest); } catch { liveDigest = null; }
  if (liveDigest !== journal.liveDigest) return block("upgrade_stale_live", "live_changed_since_validate");
  const stagedPath = stepFile(ctx, journal, "staged.sqlite", false);
  try { stagedDigest = withStaged(stagedPath, false, staged => staged.read(managedStateDigest)); } catch { stagedDigest = null; }
  if (stagedDigest !== journal.stagedDigest) return block("upgrade_staged_changed", "staged_changed_since_validate");
  const intent = saveJournal(ctx.upgradeDir, { ...journal, state: "activating", steps: step(journal, "activation_intent", now, true, "intent_persisted"),
    nextAction: "reconcile_activation_intent", requests: withRequest(journal, request), updatedAt: now });
  ctx.fault?.("activation_intent");
  try {
    ctx.store.swapFrom(stagedPath);
  } catch (error) {
    if (error instanceof SimulatedCrash) throw error;
    // The swap is atomic: resolve which side is live instead of assuming.
    const resolved = resolveActivation(ctx.store, ctx.upgradeDir, intent, ctx.now());
    if (resolved.state !== "activated") throw new AppError("upgrade_activation_failed", 503);
    return completeActivation(ctx, resolved, null);
  }
  ctx.fault?.("swapped");
  const activated = resolveActivation(ctx.store, ctx.upgradeDir, intent, ctx.now());
  if (activated.state !== "activated") throw new AppError("upgrade_activation_failed", 503);
  ctx.fault?.("activated");
  return completeActivation(ctx, activated, null);
}

async function completeActivation(ctx: UpgradeContext, journal: UpgradeJournal, request: UpgradeRequest | null): Promise<UpgradeJournal> {
  // Reconciliation needs the scheduler admission gate open; workers stay hidden until it succeeds.
  const fence = readUpgradeFence(ctx.store.path);
  if (fence && fence.upgradeId === journal.id) clearUpgradeFence(ctx.store.path);
  const resumed = await safeResume(ctx);
  ctx.fault?.("reconciled");
  return finishReconcile(ctx, journal, resumed, request);
}

function finishReconcile(ctx: UpgradeContext, journal: UpgradeJournal, resumed: UpgradeResumeResult, request: UpgradeRequest | null): UpgradeJournal {
  const now = ctx.now();
  if (!resumed.reconciled) {
    return saveJournal(ctx.upgradeDir, { ...journal, state: "activated", reconcile: { ...resumed, at: now },
      steps: step(journal, "reconcile", now, false, resumed.detail), reason: "reconcile_pending",
      nextAction: resumed.detail === "no_scheduler_in_process" || resumed.detail === "service_restart_required"
        ? "start_service_to_reconcile_jobs_sessions" : "retry_activate_to_reconcile",
      requests: withRequest(journal, request), updatedAt: now });
  }
  const complete = saveJournal(ctx.upgradeDir, { ...journal, state: "complete", reconcile: { ...resumed, at: now },
    steps: step(journal, "reconcile", now, true, resumed.detail), reason: null,
    nextAction: "none; to return to the prior version restore the pre-upgrade backup through OPS02 quarantine",
    requests: withRequest(journal, request), updatedAt: now });
  removeStaged(ctx, complete);
  recordAudit(ctx, complete);
  return complete;
}

/**
 * Boot completion: the caller (service boot) already rebuilt the scheduler and
 * reconciled jobs/native sessions for the activated installation.
 */
export function completeAfterBootReconcile(ctx: UpgradeContext, resumed: UpgradeResumeResult): UpgradeJournal | null {
  const journal = listUpgrades(ctx.upgradeDir, 100).find(j => j.state === "activated");
  return journal ? finishReconcile(ctx, journal, resumed, null) : null;
}

// ---------------------------------------------------------------------------
// Rollback
// ---------------------------------------------------------------------------

/**
 * upgrade.rollback: abandons an attempt that has not activated. The live
 * installation was never migrated or swapped, so recovery keeps it exactly as
 * is — nothing is restored over it, no tombstone, suppression, source
 * generation, job settlement or outbox result can be erased and no external
 * effect becomes eligible for replay. The staged copy is discarded, the fence
 * released and the service resumed with reconciliation. The recovery-point
 * backup stays in the managed registry. After activation, rollback is refused:
 * the pre-upgrade backup is restored only through OPS02 quarantine with
 * current-ledger replay.
 */
export async function rollbackUpgrade(ctx: UpgradeContext, journal: UpgradeJournal, request: UpgradeRequest | null): Promise<UpgradeJournal> {
  if (journal.state === "activating") journal = resolveActivation(ctx.store, ctx.upgradeDir, journal, ctx.now());
  if (journal.state === "activated" || journal.state === "complete") throw new AppError("upgrade_rollback_requires_restore", 409);
  if (!upgradeActions(journal).includes("rollback")) throw new AppError("upgrade_bad_state", 409);
  const now = ctx.now();
  // Strict: an unsafe or undeletable staged artifact blocks the attempt (fence held) instead of being ignored.
  discardStaged(ctx, journal);
  let rolled = saveJournal(ctx.upgradeDir, { ...journal, state: "rolled_back", stagedDigest: null,
    steps: step(journal, "rollback", now, true, "live_installation_kept_staged_copy_discarded"),
    reason: "rolled_back_before_activation", nextAction: "inspect_then_prepare_again",
    requests: withRequest(journal, request), updatedAt: now });
  const fence = readUpgradeFence(ctx.store.path);
  if (fence && (fence.upgradeId === journal.id || fence.upgradeId === "unknown")) clearUpgradeFence(ctx.store.path);
  const resumed = await safeResume(ctx);
  rolled = saveJournal(ctx.upgradeDir, { ...rolled, reconcile: { ...resumed, at: ctx.now() } });
  recordAudit(ctx, rolled);
  return rolled;
}

/** Bounded upgrade status for owner views and the offline CLI; reads only and never touches the native port's snapshot. */
export function upgradeStatus(store: TransactionStore, upgradeDir: string, port: BackupNativePort | undefined) {
  const read = store.read(tx => ({ schema: readSchema(tx), revision: tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision }));
  return {
    contract: upgradeContract, currentSchema: read.schema, revision: read.revision,
    supported: { minSource: minUpgradeSourceSchema, target: currentSupportedSchema },
    target: currentSupportedSchema, jitVersion: jitAppVersion, engine: inspectUpgradeEngine(port),
    fenced: readUpgradeFence(store.path) !== null, active: activeUpgrade(upgradeDir),
    upgradeAvailable: planSchema(read.schema, currentSupportedSchema).compatible,
  };
}
export type UpgradeStatus = ReturnType<typeof upgradeStatus>;
