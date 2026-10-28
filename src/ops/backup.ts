import { createHash } from "node:crypto";
import {
  closeSync, constants as fsConstants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync,
  realpathSync, rmSync, statSync, writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import packageManifest from "../../package.json";
import { AppError } from "../errors";
import { requireId } from "../sources";
import type { AppTransaction, TransactionStore } from "../store";

/**
 * ops.backup_manifest/v1 — consistent managed backups (OPS01, issue #18).
 *
 * A managed backup is one committed inventory row in `ops_backups` plus the
 * files it names inside the trusted backup directory: a credential-free
 * SQLite application image (`<id>.sqlite`) and zero or more opaque native
 * session artifacts (`<id>.native-<n>.json`) produced by the engine's
 * supported snapshot contract. Creation is staged: capture, stage files,
 * then commit the manifest; a manifest never names a file that was not
 * fully written, and files without a committed manifest are orphans that
 * reconciliation removes. See docs/contracts/ops-backup-manifest-v1.md.
 */
export const backupContract = "ops.backup_manifest/v1" as const;
export const backupSchemaVersion = 20;
/** Finite installation-wide retention: count and total stored bytes (app image plus native artifacts). */
export const backupRetention = Object.freeze({ maxBackups: 10, maxBytes: 64 * 1024 * 1024 });
/** Bounded reference inventory recorded in one manifest; overflow marks the manifest incomplete. */
export const backupInventoryLimits = Object.freeze({ projects: 1000, sources: 4000 });
/** Staged files younger than this are never treated as orphans (another creation may still own them). */
export const backupOrphanGraceMs = 10 * 60 * 1000;

const VERSION_PATTERN = /^jit\/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]{1,64})?$/;
/** Application build identity recorded in every manifest, derived from the shipped package.json. */
export const jitAppVersion = `jit/${String(packageManifest.version)}`;

/** True for a well-formed application build identity (`jit/<semver>`). */
export function isJitVersion(value: unknown): value is string {
  return typeof value === "string" && VERSION_PATTERN.test(value);
}

/** One opaque native artifact returned by an engine snapshot; Jit hashes and stores it, never parses it. */
export interface BackupNativeArtifact {
  /** Short file-safe label, e.g. `session-snapshot-0`. */
  name: string;
  bytes: Uint8Array;
  /** Hex SHA-256 the engine reports for `bytes`; must match the measured hash. */
  sha256: string;
}

/**
 * Exact native reference set resolved inside the application snapshot
 * transaction. `fingerprint` is compared again at manifest commit; any change
 * means the native set moved during capture and the backup is not valid.
 */
export interface BackupNativePlan {
  refs: { id: string; generation: number }[];
  fingerprint: string;
  /** Port-private detail (for example opaque native session ids); never persisted in a manifest. */
  detail?: unknown;
}

export interface BackupNativeSnapshot {
  refs: { id: string; generation: number }[];
  /**
   * Declared native size. Informational only: the manifest records the
   * measured size of persisted artifacts, never this declaration.
   */
  bytes: number;
  engine: string;
  /** Supported engine snapshot contract the artifacts conform to. */
  contract?: string;
  /** Engine native format version observed at capture. */
  formatVersion?: number;
  /** Opaque engine artifacts. Absent or empty is only valid for an empty reference set. */
  artifacts?: BackupNativeArtifact[];
}

/**
 * Engine bridge for quiesced native snapshots. Production default is no port
 * (fail-closed: every backup is `incomplete` with native `unavailable`).
 */
export interface BackupNativePort {
  available(): boolean;
  /**
   * Captures the native state for `plan` (or for the port's own resolution
   * when no plan is given). Ports performing engine I/O return a Promise and
   * set `staged`; they are only driven by the staged backup command.
   */
  snapshot(plan?: BackupNativePlan, limits?: BackupNativeLimits): BackupNativeSnapshot | Promise<BackupNativeSnapshot>;
  /** Resolves the exact native reference set inside the app snapshot transaction. */
  resolve?(tx: AppTransaction): BackupNativePlan;
  /**
   * Pinned engine label for preflight display. The snapshot itself stays
   * authoritative for manifest content; ports without a label read as the
   * scripted fixture for backward-compatible display only.
   */
  readonly engine?: string;
  /** True when `snapshot` is asynchronous engine I/O; synchronous callers must fail closed instead of invoking it. */
  readonly staged?: boolean;
  /** Supported snapshot contract; required for any non-empty capture, which must match it exactly. */
  readonly contract?: string;
  /** Supported native format version; a non-empty capture must match it exactly. */
  readonly formatVersion?: number;
}

/** Per-capture limits the core passes to a port; `maxBytes` is the remaining backup budget for native artifacts. */
export interface BackupNativeLimits { maxBytes: number }

export const unavailableNativePort: BackupNativePort = {
  available: () => false,
  snapshot: () => { throw new AppError("native_snapshot_unavailable", 503); },
};

export interface CreateBackupCommand {
  kind: "backup.create";
  requestId: string;
  projectId: null;
  expectedRevision: number;
  payload: { note: string };
}

export interface PruneBackupsCommand {
  kind: "backup.prune";
  requestId: string;
  projectId: null;
  expectedRevision: number;
  payload: { keep: number };
}

export type BackupCommand = CreateBackupCommand | PruneBackupsCommand;

/** Persisted native artifact inventory entry; `path` is inside the managed backup directory. */
export interface BackupNativeArtifactRecord { name: string; path: string; bytes: number; hash: string }

export interface BackupManifest {
  contract: typeof backupContract;
  id: string;
  createdAt: number;
  appSchema: number;
  /** Producing application build (`jit/<package version>`); validated on read and restore. */
  jitVersion: string;
  appRevision: number;
  projects: { projectId: string; revision: number }[];
  sourceGenerations: { projectId: string; sourceId: string; revision: number; generation: number }[];
  /** Explicit reference-inventory completeness; truncated inventories never present as valid. */
  inventory: {
    complete: boolean;
    projects: { total: number; recorded: number };
    sources: { total: number; recorded: number };
  };
  /** Lifecycle-ledger checkpoint; `position` counts committed deletion tombstones and suppressions. */
  lifecycle: { available: boolean; checkpoint: string | null; reason: string | null; position?: { deletions: number; suppressions: number } | null };
  native: {
    state: "valid" | "unavailable" | "incomplete";
    refs: { id: string; generation: number }[];
    /** Measured bytes of persisted native artifacts. */
    bytes: number;
    engine: string | null;
    reason: string | null;
    contract: string | null;
    formatVersion: number | null;
    artifacts: BackupNativeArtifactRecord[];
  };
  content: { bytes: number; hash: string; projects: number; sources: number };
  retention: { maxBackups: number; maxBytes: number; pruned: string[] };
  /** Credential state is never part of an ordinary backup image. */
  credentials: { included: false; excludedTables: string[]; scrubbed: string[]; restore: "owner_credential_setup_required" };
  state: "valid" | "incomplete";
  reason: string | null;
  artifact: { path: string; bytes: number; hash: string };
}

export interface BackupReceipt {
  manifest: BackupManifest;
  duplicate: boolean;
}

const exact = (value: unknown, keys: string[]) =>
  !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export function backupIdentity(command: BackupCommand, noteBytes = 500): string {
  if (!command || typeof command !== "object" || !exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"])) {
    throw new AppError("invalid_backup_command");
  }
  if (typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) {
    throw new AppError("invalid_backup_command");
  }
  if (command.kind === "backup.create") {
    if (command.projectId !== null || !exact(command.payload, ["note"]) || typeof command.payload.note !== "string" ||
        Buffer.byteLength(command.payload.note) > noteBytes || !command.payload.note.isWellFormed()) {
      throw new AppError("invalid_backup_command");
    }
  } else if (command.kind === "backup.prune") {
    if (command.projectId !== null || !exact(command.payload, ["keep"]) ||
        !Number.isSafeInteger(command.payload.keep) || command.payload.keep < 1 || command.payload.keep > backupRetention.maxBackups) {
      throw new AppError("invalid_backup_command");
    }
  } else throw new AppError("invalid_backup_command");
  return createHash("sha256").update(JSON.stringify([command.kind, command.requestId, command.expectedRevision, command.payload])).digest("hex");
}

export function backupDirFor(databasePath: string): string {
  return `${databasePath}.backups`;
}

/**
 * Why `dir` is not a trusted managed-backup directory, or `null` when it is: it must exist as a real directory
 * (the final component is never a symlink; its canonical path resolves to the same inode), be owned by the
 * service user (`uid`, the current process by default) and grant no group/other access. `mkdirSync` modes only
 * apply on creation, so an existing directory is always inspected rather than trusted.
 */
export function backupDirectoryProblem(dir: string, uid: number | undefined = process.getuid?.()): string | null {
  let link;
  try { link = lstatSync(dir); } catch { return "backup_directory_missing"; }
  if (link.isSymbolicLink()) return "backup_directory_symlink";
  if (!link.isDirectory()) return "backup_directory_not_directory";
  try {
    const real = statSync(realpathSync(dir));
    if (real.ino !== link.ino || real.dev !== link.dev) return "backup_directory_moved";
  } catch { return "backup_directory_missing"; }
  if (uid !== undefined && link.uid !== uid) return "backup_directory_foreign_owner";
  if ((link.mode & 0o077) !== 0) return "backup_directory_permissive";
  return null;
}

/**
 * Creates the managed directory (0700) or hardens an existing one before any write: the directory is opened
 * without following a symlink, a foreign owner is rejected and group/other access is removed through the
 * opened descriptor. Throws `backup_storage_unavailable`.
 */
function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd: number | null = null;
  try {
    fd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(fd), uid = process.getuid?.();
    if (!opened.isDirectory() || (uid !== undefined && opened.uid !== uid)) throw new Error("untrusted");
    if ((opened.mode & 0o077) !== 0) fchmodSync(fd, opened.mode & 0o700);
  } catch {
    throw new AppError("backup_storage_unavailable", 503);
  } finally {
    if (fd !== null) closeSync(fd);
  }
  if (backupDirectoryProblem(dir) !== null) throw new AppError("backup_storage_unavailable", 503);
}

// ---------------------------------------------------------------------------
// Credential-free application image
// ---------------------------------------------------------------------------

/**
 * Explicit classification of every application table for ordinary backup
 * images. `exclude` tables are emptied (credential or live-authority state);
 * everything else is copied. A table missing from this map fails backup
 * creation closed (`backup_schema_unclassified`): new schema must be
 * classified before it can enter a backup.
 */
export const backupImageTables: Readonly<Record<string, "include" | "exclude" | "scrub">> = Object.freeze({
  owner: "exclude", sessions: "exclude", login_throttle: "exclude",
  job_scheduler: "exclude", delivery_worker: "exclude",
  // Installation-scoped registry: preserved from live on activation, never restored from an image.
  ops_backups: "exclude",
  // Installation lifecycle ledger (app.deletion_ledger/v1, schema 23): preserved from live on activation,
  // never restored from an image, so a restore point can never roll back current tombstones.
  lifecycle_ledger: "exclude", lifecycle_checkpoint: "exclude",
  // Export artifacts (registry + bytes) never enter images, so a restore cannot resurrect
  // content deleted after an export; restored request ids replay as export_expired.
  export_artifact_bodies: "exclude",
  // app.schedule_feed/v1 (schema 30): installation-scoped feed token hash; preserved from live on activation.
  schedule_feed: "exclude",
  telegram_binding: "scrub", command_receipts: "scrub",
  app_state: "include", audit: "include", coordinator_syntheses: "include", decision_proposals: "include",
  deletion_ledger: "include", deletion_operations: "include", deletion_previews: "include",
  delivery_attempts: "include", delivery_intents: "include", delivery_reports: "include",
  export_artifacts: "exclude", job_attempts: "include", job_authority: "include", job_reconciliation: "include",
  job_schedule_occurrences: "include", job_schedules: "include", jobs: "include",
  memory_claims: "include", memory_context_entries: "include", memory_contexts: "include", memory_corrections: "include",
  memory_decision_sources: "include", memory_derived_sources: "include", memory_extractions: "include",
  memory_suppressed_claims: "include", memory_suppressed_sources: "include", memory_suppressions: "include",
  messages: "include", owner_decisions: "include", project_groups: "include",
  // ui.preferences/v1 (schema 24): owner theme/language, configuration without credentials.
  owner_preferences: "include",
  // app.persona/v1 and app.jit_reply/v1 (schema 25): owner persona revisions and identity-only reply index.
  persona_revisions: "include", jit_replies: "include", jit_reply_sources: "include",
  // app.setup/v1 and app.general_space/v1 (schema 26): setup progress and the General space identity, no credentials.
  setup_state: "include", general_space: "include",
  // app.dispatch_allowance/v1 (schema 27): owner allowance revisions and identity-only dispatch proposals.
  dispatch_allowance_revisions: "include", dispatch_proposals: "include",
  // app.topic_promotion/v1 (schema 28): identity-only links between a promoted General topic and its continuation.
  topic_promotions: "include",
  // Chat-first home (schema 28): identity-only lineage from a derived chat title to its first message.
  chat_title_sources: "include",
  // app.local_api/v1 (schema 29): whether the owner turned the loopback API on; the token is never in the database.
  local_api_settings: "include",
  // app.access_level/v1 (schema 31): owner access level, role restriction and kill switch revisions, no credentials.
  project_access_revisions: "include", role_access_overrides: "include", execution_halts: "include",
  // app.webhook_triggers/v1 (schema 32): trigger identities keep, the sealed secret is nulled in every image (rotate
  // after a restore); receipts hold delivery ids only; the poll schedule is service-owned timing.
  webhook_triggers: "scrub", webhook_receipts: "include", pr_poll_due: "include",
  // exec.box_runtime/v1 (schema 33): owner box reset revisions only; the box and its workspace are never in an image.
  execution_box_resets: "include",
  // app.connections/v1 (schema 34): connection metadata and audit only; values live in the secrets directory, never in an image.
  connections: "include", connection_audit: "include",
  // delivery.attention_levels/v1 (schema 35): per-channel notification level and identity-only work group notices.
  attention_levels: "include", work_groups: "include",
  // exec.run_tools/v1 (schema 36): bounded tool call audit; subjects are redacted command/path prefixes, never output.
  execution_tool_calls: "include",
  // app.approval_cards/v1 and app.auto_approve/v1 (schema 37): cards, rules and effect targets hold actions, digests,
  // receipts and connection ids only — never a connection value.
  approval_cards: "include", auto_approve_rules: "include", git_remotes: "include", deploy_targets: "include",
  // app.mcp_servers/v1 (schema 38): install proposals and installed servers hold specs, env names and connection ids
  // only — never a connection value; the installed packages live in the execution directory, never in an image.
  mcp_proposals: "include", mcp_servers: "include",
  // app.takeover/v1 (schema 39): owner takeover revisions, identity only; screenshots are memory-only, never in an image.
  takeover_sessions: "include",
  // exec.computer/v1 (schema 40): the owner's confirm-every-action revisions, no credentials.
  computer_settings: "include",
  project_team: "include", projects: "include", restore_quarantines: "include", roles: "include",
  schway_native_refs: "include", source_versions: "include", sources: "include",
  task_events: "include", task_evidence_artifacts: "include", task_proposals: "include", tasks: "include",
  team_contexts: "include", team_runs: "include", team_state: "include",
  telegram_inbox: "include", telegram_poll: "include", topics: "include", upgrade_journal: "include",
  // PR tables are created lazily by ensurePrSchema; none holds credentials (payloads are credential-screened).
  pr_monitors: "include", pr_poll_checkpoints: "include", pr_candidates: "include", pr_snapshots: "include",
  pr_reports: "include", pr_report_annotations: "include",
  pr_alert_policies: "include", pr_alert_decisions: "include", pr_alerts: "include",
});

/** JSON keys whose values are one-time secrets and are nulled wherever receipts persist them. */
const SECRET_JSON_KEYS = new Set(["challengeNonce", "password", "passwordHash", "password_hash", "token", "tokenHash", "token_hash", "csrf"]);

function scrubJson(value: unknown): { value: unknown; changed: boolean } {
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map(item => { const r = scrubJson(item); changed ||= r.changed; return r.value; });
    return { value: out, changed };
  }
  if (value && typeof value === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (SECRET_JSON_KEYS.has(key) && item !== null) { out[key] = null; changed = true; continue; }
      const r = scrubJson(item); changed ||= r.changed; out[key] = r.value;
    }
    return { value: out, changed };
  }
  return { value, changed: false };
}

export interface BackupImage { bytes: Uint8Array; hash: string; excludedTables: string[]; scrubbed: string[] }

/**
 * Serializes the caller's consistent transaction view, then removes all
 * credential and live-authority state from an in-memory copy: owner password
 * verifier, browser sessions, login throttle, scheduler/delivery claims,
 * pending Telegram challenge nonces and secret-bearing receipt fields. Deleted
 * pages are zeroed (`secure_delete`) and the copy is vacuumed, so no residual
 * credential bytes survive. The live database is never modified.
 */
export function captureBackupImage(tx: AppTransaction, store: Pick<TransactionStore, "snapshotBytes">): BackupImage {
  const tables = tx.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map(r => r.name);
  const unclassified = tables.filter(name => !name.startsWith("sqlite_") && !(name in backupImageTables));
  if (unclassified.length) throw new AppError("backup_schema_unclassified", 500);
  const raw = store.snapshotBytes();
  const copy = new Uint8Array(raw);
  // A WAL-mode header cannot be written as an in-memory image; mark the copy
  // rollback-journal. TransactionStore re-enables WAL when the image is opened.
  if (copy.length >= 20) { copy[18] = 1; copy[19] = 1; }
  let image: Database;
  try { image = Database.deserialize(copy); } catch { throw new AppError("backup_snapshot_failed", 500); }
  const excludedTables: string[] = [], scrubbed: string[] = [];
  try {
    image.exec("PRAGMA foreign_keys = OFF; PRAGMA secure_delete = ON;");
    for (const name of tables) {
      if (backupImageTables[name] === "exclude") { image.exec(`DELETE FROM "${name}"`); excludedTables.push(name); }
    }
    if (tables.includes("telegram_binding")) {
      image.exec("UPDATE telegram_binding SET challenge_nonce = NULL, challenge_expires_at = NULL");
      scrubbed.push("telegram_binding.challenge_nonce");
    }
    if (tables.includes("webhook_triggers")) {
      image.exec("UPDATE webhook_triggers SET sealed_secret = NULL");
      scrubbed.push("webhook_triggers.sealed_secret");
    }
    if (tables.includes("command_receipts")) {
      const rows = image.query("SELECT rowid AS id, result_json FROM command_receipts").all() as { id: number; result_json: string }[];
      const update = image.query("UPDATE command_receipts SET result_json = ? WHERE rowid = ?");
      for (const row of rows) {
        let parsed: unknown;
        try { parsed = JSON.parse(row.result_json); } catch { continue; }
        const result = scrubJson(parsed);
        if (result.changed) update.run(JSON.stringify(result.value), row.id);
      }
      scrubbed.push("command_receipts.result_json");
    }
    image.exec("VACUUM");
    const bytes = image.serialize();
    return { bytes, hash: sha256(bytes), excludedTables, scrubbed };
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError("backup_snapshot_failed", 500);
  } finally {
    image.close();
  }
}

// ---------------------------------------------------------------------------
// Reference inventory
// ---------------------------------------------------------------------------

/**
 * Lifecycle-ledger checkpoint: the exact committed position of the deletion
 * ledger (`app.deletion_ledger/v1`) and owner suppressions, read in the same
 * transaction as the image. An empty but readable ledger is position zero and
 * is recorded as such; an unreadable or malformed ledger is `unavailable`
 * (`ledger_unverifiable`), never inferred as "no deletions".
 */
export function lifecycleCheckpoint(tx: AppTransaction): BackupManifest["lifecycle"] {
  try {
    const deletions = tx.all<{ id: string }>("SELECT id FROM deletion_ledger ORDER BY rowid").map(r => r.id);
    const suppressions: string[] = [];
    for (const row of tx.all<{ record_json: string }>("SELECT record_json FROM memory_suppressions ORDER BY rowid")) {
      const parsed = JSON.parse(row.record_json) as { id?: unknown } | null;
      if (!parsed || typeof parsed.id !== "string") return { available: false, checkpoint: null, reason: "ledger_unverifiable", position: null };
      suppressions.push(parsed.id);
    }
    const checkpoint = `ledger:${sha256(new TextEncoder().encode(JSON.stringify([deletions, suppressions])))}`;
    return { available: true, checkpoint, reason: null, position: { deletions: deletions.length, suppressions: suppressions.length } };
  } catch {
    return { available: false, checkpoint: null, reason: "ledger_unverifiable", position: null };
  }
}

/** Bounded inventory with exact totals: overflow is recorded, never silently dropped. */
export function collectInventory(tx: AppTransaction, limits: { projects: number; sources: number } = backupInventoryLimits): {
  projects: BackupManifest["projects"]; sourceGenerations: BackupManifest["sourceGenerations"]; inventory: BackupManifest["inventory"];
} {
  const projects = tx.all<{ projectId: string; revision: number }>(
    "SELECT id AS projectId, revision FROM projects ORDER BY created_at, id LIMIT ?", limits.projects);
  const sourceGenerations = tx.all<{ projectId: string; sourceId: string; revision: number; generation: number }>(
    "SELECT project_id AS projectId, id AS sourceId, current_revision AS revision, generation FROM sources ORDER BY project_id, id LIMIT ?", limits.sources);
  const projectTotal = tx.get<{ n: number }>("SELECT count(*) AS n FROM projects")!.n;
  const sourceTotal = tx.get<{ n: number }>("SELECT count(*) AS n FROM sources")!.n;
  return {
    projects, sourceGenerations,
    inventory: {
      complete: projectTotal === projects.length && sourceTotal === sourceGenerations.length,
      projects: { total: projectTotal, recorded: projects.length },
      sources: { total: sourceTotal, recorded: sourceGenerations.length },
    },
  };
}

// ---------------------------------------------------------------------------
// Native capture normalization
// ---------------------------------------------------------------------------

/** Normalized native capture: the manifest section (paths filled at staging) plus the bytes to stage. */
export interface NativeCapture {
  section: Omit<BackupManifest["native"], "artifacts">;
  artifacts: BackupNativeArtifact[];
}

const emptyNative = (state: "unavailable" | "incomplete", reason: string, engine: string | null = null): NativeCapture => ({
  section: { state, refs: [], bytes: 0, engine, reason, contract: null, formatVersion: null },
  artifacts: [],
});

function nativeFailure(error: unknown, engine: string | null): NativeCapture {
  if (error instanceof AppError) {
    return emptyNative(error.code === "native_snapshot_unavailable" ? "unavailable" : "incomplete",
      /^[a-z0-9_]{1,64}$/.test(error.code) ? error.code : "native_snapshot_failed", engine);
  }
  // Engine messages never enter a manifest.
  return emptyNative("incomplete", "native_snapshot_failed", engine);
}

const ARTIFACT_NAME = /^[a-z0-9][a-z0-9.-]{0,63}$/;

/** Validates a port result fail-closed: refs, artifact hashes and coverage; never inspects artifact content. */
const CONTRACT_PATTERN = /^[a-z0-9][a-z0-9.-]{0,96}\/v[1-9][0-9]{0,3}$/;

/** True for a well-formed snapshot contract id and positive format version. */
export function isNativeContract(contract: unknown, formatVersion: unknown): boolean {
  return typeof contract === "string" && CONTRACT_PATTERN.test(contract) && Number.isSafeInteger(formatVersion) && (formatVersion as number) >= 1;
}

export function normalizeNativeSnapshot(snap: unknown, plan?: BackupNativePlan, port?: Pick<BackupNativePort, "contract" | "formatVersion">): NativeCapture {
  const s = snap as BackupNativeSnapshot | null;
  if (!s || typeof s !== "object" || !Array.isArray(s.refs) || typeof s.engine !== "string" || !s.engine || s.engine.length > 200) {
    return emptyNative("incomplete", "native_snapshot_invalid");
  }
  const engine = s.engine;
  // The declared size is informational, but a non-integer or negative declaration is a broken engine result.
  if (!Number.isSafeInteger(s.bytes) || s.bytes < 0) return emptyNative("incomplete", "native_snapshot_invalid", engine);
  try {
    const seen = new Set<string>();
    for (const ref of s.refs) {
      // Exact `{ id, generation }` shape, valid id, positive safe generation, no duplicates.
      if (!exact(ref, ["id", "generation"])) return emptyNative("incomplete", "native_snapshot_invalid", engine);
      requireId(ref.id);
      if (!Number.isSafeInteger(ref.generation) || ref.generation < 1 || seen.has(ref.id)) return emptyNative("incomplete", "native_snapshot_invalid", engine);
      seen.add(ref.id);
    }
  } catch { return emptyNative("incomplete", "native_snapshot_invalid", engine); }
  if (plan && JSON.stringify(plan.refs) !== JSON.stringify(s.refs.map(r => ({ id: r.id, generation: r.generation })))) {
    return emptyNative("incomplete", "native_snapshot_mismatch", engine);
  }
  const artifacts = s.artifacts ?? [];
  if (!Array.isArray(artifacts)) return emptyNative("incomplete", "native_snapshot_invalid", engine);
  const names = new Set<string>();
  let bytes = 0;
  for (const artifact of artifacts) {
    if (!artifact || typeof artifact.name !== "string" || !ARTIFACT_NAME.test(artifact.name) || names.has(artifact.name) ||
        !(artifact.bytes instanceof Uint8Array) || artifact.bytes.length < 1 || typeof artifact.sha256 !== "string") {
      return emptyNative("incomplete", "native_snapshot_invalid", engine);
    }
    names.add(artifact.name);
    if (sha256(artifact.bytes) !== artifact.sha256) return emptyNative("incomplete", "native_artifact_hash_mismatch", engine);
    bytes += artifact.bytes.length;
  }
  if (s.refs.length > 0 && artifacts.length === 0) return emptyNative("incomplete", "native_artifacts_missing", engine);
  if (artifacts.length > 0 && s.refs.length === 0) return emptyNative("incomplete", "native_snapshot_invalid", engine);
  // Non-empty captures must declare the supported contract and format they conform to.
  if (artifacts.length > 0 && (!isNativeContract(s.contract, s.formatVersion) || !port || !isNativeContract(port.contract, port.formatVersion) ||
      s.contract !== port.contract || s.formatVersion !== port.formatVersion)) {
    return emptyNative("incomplete", "native_snapshot_incompatible", engine);
  }
  const declared = isNativeContract(s.contract, s.formatVersion);
  return {
    section: {
      state: "valid", refs: s.refs.map(r => ({ id: r.id, generation: r.generation })), bytes, engine, reason: null,
      contract: declared ? s.contract! : null,
      formatVersion: declared ? s.formatVersion! : null,
    },
    artifacts: artifacts.map(a => ({ name: a.name, bytes: a.bytes, sha256: a.sha256 })),
  };
}

/** Staged capture: drives synchronous or asynchronous ports; any failure is an explicit non-valid state. */
export async function captureNativeSnapshot(port: BackupNativePort | undefined, plan?: BackupNativePlan,
  limits: BackupNativeLimits = { maxBytes: backupRetention.maxBytes }): Promise<NativeCapture> {
  if (!port) return emptyNative("unavailable", "native_snapshot_unavailable");
  let available = false;
  try { available = port.available(); } catch { available = false; }
  if (!available) return emptyNative("unavailable", "native_snapshot_unavailable", port.engine ?? null);
  try {
    const result = normalizeNativeSnapshot(await port.snapshot(plan, limits), plan, port);
    if (result.section.state === "valid" && result.section.bytes > limits.maxBytes) throw new AppError("backup_too_large", 507);
    return result;
  } catch (error) {
    // An over-budget capture is an explicit command failure, never a manifest.
    if (error instanceof AppError && error.code === "backup_too_large") throw error;
    return nativeFailure(error, port.engine ?? null);
  }
}

/**
 * Synchronous capture for callers that cannot await (upgrade prepare). Staged
 * engine ports are never invoked here: they fail closed as unavailable.
 */
export function resolveNativeSnapshot(port: BackupNativePort | undefined): BackupManifest["native"] {
  const capture = resolveNativeCaptureSync(port);
  return { ...capture.section, artifacts: [] };
}

/** Synchronous variant returning the bytes to stage; see {@link resolveNativeSnapshot}. */
export function resolveNativeCaptureSync(port: BackupNativePort | undefined): NativeCapture {
  if (!port) return emptyNative("unavailable", "native_snapshot_unavailable");
  let available = false;
  try { available = port.available(); } catch { available = false; }
  if (!available) return emptyNative("unavailable", "native_snapshot_unavailable");
  if (port.staged) return emptyNative("unavailable", "native_snapshot_requires_staged_backup", port.engine ?? null);
  try {
    const result = port.snapshot();
    if (result instanceof Promise) {
      result.catch(() => { /* Never awaited on the synchronous path. */ });
      return emptyNative("unavailable", "native_snapshot_requires_staged_backup", port.engine ?? null);
    }
    return normalizeNativeSnapshot(result, undefined, port);
  } catch (error) {
    return nativeFailure(error, port.engine ?? null);
  }
}

// ---------------------------------------------------------------------------
// Manifest
// ---------------------------------------------------------------------------

/**
 * Builds a manifest from a consistent capture. State is `valid` only when the
 * native set, lifecycle checkpoint and reference inventory are all complete;
 * the first failing component supplies `reason`.
 */
export function prepareBackupManifest(tx: AppTransaction, input: {
  id: string; now: number; appRevision: number; appSchema: number; jitVersion: string;
  image: BackupImage; native: BackupManifest["native"]; artifactPath: string; pruned: string[];
  inventory?: ReturnType<typeof collectInventory>;
  lifecycle?: BackupManifest["lifecycle"];
}): BackupManifest {
  if (!isJitVersion(input.jitVersion)) throw new AppError("invalid_jit_version", 500);
  const collected = input.inventory ?? collectInventory(tx);
  const lifecycle = input.lifecycle ?? lifecycleCheckpoint(tx);
  const reason = input.native.state !== "valid" ? input.native.reason ?? "native_snapshot_failed"
    : !lifecycle.available || !lifecycle.checkpoint ? lifecycle.reason ?? "ledger_unverifiable"
      : !collected.inventory.complete ? "inventory_truncated" : null;
  return {
    contract: backupContract,
    id: input.id,
    createdAt: input.now,
    appSchema: input.appSchema,
    jitVersion: input.jitVersion,
    appRevision: input.appRevision,
    projects: collected.projects,
    sourceGenerations: collected.sourceGenerations,
    inventory: collected.inventory,
    lifecycle,
    native: input.native,
    content: { bytes: input.image.bytes.length, hash: input.image.hash, projects: collected.projects.length, sources: collected.sourceGenerations.length },
    retention: { maxBackups: backupRetention.maxBackups, maxBytes: backupRetention.maxBytes, pruned: input.pruned },
    credentials: { included: false, excludedTables: input.image.excludedTables, scrubbed: input.image.scrubbed, restore: "owner_credential_setup_required" },
    state: reason === null ? "valid" : "incomplete",
    reason,
    artifact: { path: input.artifactPath, bytes: input.image.bytes.length, hash: input.image.hash },
  };
}

/** Captures the consistent application side of a backup inside the caller transaction. */
export function captureAppSide(tx: AppTransaction, store: Pick<TransactionStore, "snapshotBytes">) {
  const appSchema = tx.get<{ user_version: number }>("PRAGMA user_version")!.user_version;
  const appRevision = tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision;
  const inventory = collectInventory(tx);
  const lifecycle = lifecycleCheckpoint(tx);
  const image = captureBackupImage(tx, store);
  return { appSchema, appRevision, inventory, lifecycle, image };
}

/** Inputs for {@link stageManagedBackup}; shared by `backup.create` and upgrade prepare (ops.schema_migrations/v1). */
export interface StageBackupInput<R> {
  store: TransactionStore;
  backupDir: string;
  port: BackupNativePort | undefined;
  jitVersion: string;
  now(): number;
  /** Backup ids whose files are staged but not yet committed; reconciliation never removes them. */
  inflight: Set<string>;
  /**
   * Authorizes inside each transaction (`capture`, then `commit`). A non-null
   * result (for example a duplicate receipt) ends creation with that result
   * and discards anything staged.
   */
  guard(tx: AppTransaction, phase: "capture" | "commit"): R | null;
  /** Records the committed manifest (receipts, audit, journals) inside the commit transaction. */
  record(tx: AppTransaction, manifest: BackupManifest, now: number): R;
  /** Fault seam after retention selection, before the manifest row is written. */
  beforeCommit?(): void;
}

/**
 * Staged ops.backup_manifest/v1 creation, the one implementation behind
 * `backup.create` and the upgrade recovery point.
 *
 * 1. One immediate transaction: guard, reconcile orphans, then capture the
 *    credential-free app image, reference inventory, lifecycle checkpoint and
 *    exact native reference plan from the same committed view.
 * 2. Await the engine's supported native snapshot for exactly that plan
 *    (the port is invoked exactly once).
 * 3. Reject an over-ceiling backup before anything is deleted, then stage the
 *    image and native artifacts (mode 0600) in the managed directory.
 * 4. One immediate transaction: guard again, recheck the native plan
 *    fingerprint, retire retention victims' rows, insert the manifest and call
 *    `record`.
 * 5. Only after commit, delete victims' files. Any failure before commit
 *    removes only this attempt's staged files; committed backups are untouched.
 */
export async function stageManagedBackup<R>(input: StageBackupInput<R>): Promise<R> {
  const id = crypto.randomUUID();
  const { store, backupDir, port } = input;
  input.inflight.add(id);
  const written: string[] = [];
  try {
    const staged = store.transaction(tx => {
      const prior = input.guard(tx, "capture");
      if (prior !== null) return { done: true as const, prior };
      reconcileBackupArtifacts(tx, backupDir, input.inflight);
      const app = captureAppSide(tx, store);
      let plan: BackupNativePlan | undefined;
      let planFailed = false;
      try { plan = port?.resolve?.(tx); } catch { planFailed = true; }
      return { done: false as const, app, plan, planFailed };
    });
    if (staged.done) return staged.prior;
    const capture: NativeCapture = staged.planFailed
      ? { section: { state: "incomplete", refs: [], bytes: 0, engine: port?.engine ?? null, reason: "native_snapshot_failed", contract: null, formatVersion: null }, artifacts: [] }
      : await captureNativeSnapshot(port, staged.plan, { maxBytes: Math.max(0, backupRetention.maxBytes - staged.app.image.bytes.length) });
    const incoming = staged.app.image.bytes.length + capture.artifacts.reduce((sum, a) => sum + a.bytes.length, 0);
    if (incoming > backupRetention.maxBytes) throw new AppError("backup_too_large", 507);
    const artifactPath = writeArtifact(backupDir, id, staged.app.image.bytes);
    written.push(artifactPath);
    const nativeArtifacts = writeNativeArtifacts(backupDir, id, capture.artifacts, written);
    let victims: string[] = [];
    const discard: string[] = [];
    const result = store.transaction(tx => {
      const prior = input.guard(tx, "commit");
      if (prior !== null) { discard.push(...written); return prior; }
      let native: BackupManifest["native"] = { ...capture.section, artifacts: nativeArtifacts };
      if (native.state === "valid" && staged.plan && port?.resolve) {
        let current: BackupNativePlan | null = null;
        try { current = port.resolve(tx); } catch { current = null; }
        if (!current || current.fingerprint !== staged.plan.fingerprint) {
          // The native set moved during capture: never present it as valid.
          discard.push(...nativeArtifacts.map(a => a.path));
          native = { ...native, state: "incomplete", refs: [], bytes: 0, reason: "native_changed_during_backup", artifacts: [] };
        }
      }
      const storedBytes = staged.app.image.bytes.length + native.artifacts.reduce((sum, a) => sum + a.bytes, 0);
      const selected = selectRetentionVictims(tx, backupDir, storedBytes);
      victims = selected.files;
      input.beforeCommit?.();
      const now = input.now();
      const manifest = prepareBackupManifest(tx, {
        id, now, appRevision: staged.app.appRevision, appSchema: staged.app.appSchema, jitVersion: input.jitVersion,
        image: staged.app.image, native, artifactPath, pruned: selected.pruned,
        inventory: staged.app.inventory, lifecycle: staged.app.lifecycle,
      });
      tx.run("INSERT INTO ops_backups VALUES (?, ?, ?)", manifest.id, manifest.createdAt, JSON.stringify(manifest));
      return input.record(tx, manifest, now);
    });
    written.length = 0;
    removeManagedFiles([...victims, ...discard]);
    return result;
  } finally {
    // Anything still listed was staged by a failed attempt and never committed.
    removeManagedFiles(written);
    input.inflight.delete(id);
  }
}

/** Structural validation for manifests read back from inventory or used for restore. */
export function validateManifestRecord(value: unknown): BackupManifest {
  const m = value as BackupManifest;
  if (!m || typeof m !== "object" || m.contract !== backupContract || typeof m.id !== "string" ||
      !Number.isSafeInteger(m.appSchema) || !Number.isSafeInteger(m.createdAt) || !isJitVersion(m.jitVersion) ||
      !m.artifact || typeof m.artifact.path !== "string" || typeof m.artifact.hash !== "string" || !Number.isSafeInteger(m.artifact.bytes)) {
    throw new AppError("backup_corrupt", 500);
  }
  return m;
}

/** Integrity verdict for a committed backup's managed files. */
export type BackupIntegrity = { state: "verified"; reason: null } | { state: "invalid"; reason: string };

function checkManagedFile(path: string, expected: string, bytes: unknown, hash: unknown, prefix: string): string | null {
  if (path !== expected) return `${prefix}_outside_backup_dir`;
  let stats;
  try { stats = lstatSync(path); } catch { return `${prefix}_missing`; }
  if (!stats.isFile() || stats.isSymbolicLink()) return `${prefix}_not_regular_file`;
  if (!Number.isSafeInteger(bytes) || stats.size !== bytes) return `${prefix}_size_mismatch`;
  let content: Uint8Array;
  try { content = readFileSync(path); } catch { return `${prefix}_missing`; }
  if (content.length !== bytes || typeof hash !== "string" || sha256(content) !== hash) return `${prefix}_hash_mismatch`;
  return null;
}

/**
 * Strict managed-artifact validation used by detailed inspection and restore.
 * Every file must be the exact managed child of `backupDir` for this backup id
 * (`<id>.sqlite`, `<id>.native-<n>.json` in order), a regular non-symlink file
 * with the recorded size and SHA-256; native artifacts additionally need a
 * declared snapshot contract/format and must cover a non-empty native set.
 * Content is hashed, never parsed.
 */
export function verifyBackupArtifacts(manifest: BackupManifest, backupDir: string): BackupIntegrity {
  const fail = (reason: string): BackupIntegrity => ({ state: "invalid", reason });
  const dir = resolve(backupDir);
  const image = checkManagedFile(manifest.artifact?.path, artifactPathFor(dir, manifest.id), manifest.artifact?.bytes, manifest.artifact?.hash, "image");
  if (image) return fail(image);
  const native = manifest.native as Partial<BackupManifest["native"]> | undefined;
  if (!native) return fail("native_record_missing");
  const artifacts = native.artifacts ?? [];
  if (!Array.isArray(artifacts)) return fail("native_record_invalid");
  if (native.state === "valid" && (native.refs ?? []).length > 0 && artifacts.length === 0) return fail("native_artifacts_missing");
  if (artifacts.length > 0 && !isNativeContract(native.contract, native.formatVersion)) return fail("native_contract_invalid");
  let total = 0;
  for (const [index, artifact] of artifacts.entries()) {
    const problem = checkManagedFile(artifact?.path, join(dir, `${manifest.id}.native-${index}.json`), artifact?.bytes, artifact?.hash, "native_artifact");
    if (problem) return fail(problem);
    total += artifact.bytes;
  }
  if (native.bytes !== total) return fail("native_size_mismatch");
  return { state: "verified", reason: null };
}

/**
 * Restore gate: only a `valid` manifest with a lifecycle-ledger checkpoint, a
 * valid native capture, a complete inventory and verified managed files may be
 * prepared for restore. No owner acknowledgment overrides this.
 */
export function assertRestorableBackup(manifest: BackupManifest, backupDir: string): void {
  if (manifest.state !== "valid" || !manifest.lifecycle?.available || !manifest.lifecycle.checkpoint ||
      manifest.native?.state !== "valid" || manifest.inventory?.complete !== true) {
    throw new AppError("backup_incomplete", 409);
  }
  const integrity = verifyBackupArtifacts(manifest, backupDir);
  if (integrity.state !== "verified") {
    throw new AppError(integrity.reason === "image_missing" ? "backup_artifact_missing" : "backup_integrity_failed", 409);
  }
}

/** Reads one manifest without parsing backup bytes or native private formats. */
export function readBackupManifest(tx: AppTransaction, id: string): BackupManifest {
  requireId(id);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM ops_backups WHERE id = ?", id);
  if (!row) throw new AppError("backup_not_found", 404);
  let parsed: unknown;
  try { parsed = JSON.parse(row.record_json); } catch { throw new AppError("backup_corrupt", 500); }
  const manifest = validateManifestRecord(parsed);
  if (manifest.id !== id) throw new AppError("backup_corrupt", 500);
  return manifest;
}

/** Bounded inventory outside ordinary project data, newest last. */
export function listBackups(tx: AppTransaction, limit = 50): BackupManifest[] {
  const rows = tx.all<{ record_json: string }>("SELECT record_json FROM ops_backups ORDER BY created_at, rowid LIMIT ?", Math.min(Math.max(limit, 1), 100));
  return rows.map(row => JSON.parse(row.record_json) as BackupManifest);
}

// ---------------------------------------------------------------------------
// Retention
// ---------------------------------------------------------------------------

/** Stored bytes a manifest occupies: app image plus persisted native artifacts. */
export function manifestStoredBytes(manifest: Pick<BackupManifest, "artifact"> & { native?: { artifacts?: { bytes: number }[] } }): number {
  const nativeBytes = (manifest.native?.artifacts ?? []).reduce((sum, a) => sum + (Number.isSafeInteger(a.bytes) ? a.bytes : 0), 0);
  return (Number.isSafeInteger(manifest.artifact?.bytes) ? manifest.artifact.bytes : 0) + nativeBytes;
}

/**
 * Pure retention plan over existing backups (oldest first). Rejects an
 * incoming backup that alone exceeds the byte ceiling before anything is
 * chosen; otherwise returns the minimal oldest-first victim set so that the
 * kept count is at most `keep` (including the incoming one when present) and
 * the cumulative projected total fits the ceiling.
 */
export function planRetention(existing: { id: string; bytes: number }[], incomingBytes: number | null, keep: number,
  maxBytes: number = backupRetention.maxBytes): string[] {
  if (incomingBytes !== null && incomingBytes > maxBytes) throw new AppError("backup_too_large", 507);
  const slots = Math.max(0, Math.min(keep, backupRetention.maxBackups) - (incomingBytes === null ? 0 : 1));
  const victims: string[] = [];
  const kept = [...existing];
  while (kept.length > slots) victims.push(kept.shift()!.id);
  let total = (incomingBytes ?? 0) + kept.reduce((sum, row) => sum + row.bytes, 0);
  while (total > maxBytes && kept.length) {
    const row = kept.shift()!;
    victims.push(row.id);
    total -= row.bytes;
  }
  return victims;
}

/** Files a committed manifest owns inside the managed directory. */
export function manifestFiles(backupDir: string, id: string, recordJson: string): string[] {
  const files = [artifactPathFor(backupDir, id)];
  try {
    const manifest = JSON.parse(recordJson) as Partial<BackupManifest>;
    for (const artifact of manifest.native?.artifacts ?? []) {
      if (typeof artifact.path === "string" && dirname(artifact.path) === backupDir && artifact.path.startsWith(join(backupDir, `${id}.native-`))) {
        files.push(artifact.path);
      }
    }
  } catch { /* Corrupt rows still release their image file. */ }
  return files;
}

/**
 * Removes retention victims' inventory rows inside the caller transaction and
 * returns their files. Physical deletion is the caller's job AFTER commit:
 * a rolled-back transaction must leave every previously committed artifact intact.
 */
export function selectRetentionVictims(tx: AppTransaction, backupDir: string, incomingBytes: number | null, keep: number = backupRetention.maxBackups): { pruned: string[]; files: string[] } {
  // Oldest first by commit time, then commit order (rowid) for equal clocks.
  const rows = tx.all<{ id: string; record_json: string }>("SELECT id, record_json FROM ops_backups ORDER BY created_at, rowid");
  const sized = rows.map(row => {
    let bytes = 0;
    try { bytes = manifestStoredBytes(JSON.parse(row.record_json) as BackupManifest); } catch { /* Corrupt rows count as zero. */ }
    return { id: row.id, bytes };
  });
  const pruned = planRetention(sized, incomingBytes, keep);
  const files: string[] = [];
  for (const id of pruned) {
    const row = rows.find(r => r.id === id)!;
    tx.run("DELETE FROM ops_backups WHERE id = ?", id);
    files.push(...manifestFiles(backupDir, id, row.record_json));
  }
  return { pruned, files };
}

/** Best-effort removal of managed files; failures leave orphans for reconciliation. */
export function removeManagedFiles(files: string[]): void {
  for (const file of files) {
    try { if (existsSync(file)) rmSync(file); } catch { /* Reconciliation retries orphans. */ }
  }
}

const MANAGED_FILE = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.(?:sqlite|native-\d{1,4}\.json)$/;

/**
 * Orphan reconciliation: removes managed-pattern files whose backup id has no
 * committed manifest, skipping ids still being created and files younger than
 * `graceMs` (wall clock). Directories and foreign names are never touched.
 */
export function reconcileBackupArtifacts(tx: AppTransaction, backupDir: string, inflight: ReadonlySet<string>, graceMs = backupOrphanGraceMs): string[] {
  let entries: string[];
  try { entries = readdirSync(backupDir); } catch { return []; }
  const committed = new Set(tx.all<{ id: string }>("SELECT id FROM ops_backups").map(r => r.id));
  const removed: string[] = [];
  const cutoff = Date.now() - graceMs;
  for (const entry of entries) {
    const match = MANAGED_FILE.exec(entry);
    if (!match || committed.has(match[1]!) || inflight.has(match[1]!)) continue;
    const path = join(backupDir, entry);
    try {
      const stats = statSync(path);
      if (!stats.isFile() || stats.mtimeMs > cutoff) continue;
      rmSync(path);
      removed.push(entry);
    } catch { /* Changing files are retried next time. */ }
  }
  return removed;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/**
 * Writes one managed file (0600) into a trusted, hardened directory. The file is created exclusively and without
 * following symlinks, so an existing file or planted link at the name is never overwritten or followed (only a
 * file this call created is removed on failure). Throws `backup_storage_unavailable` on failure.
 */
export function writeManagedFile(dir: string, name: string, bytes: Uint8Array): string {
  const path = join(dir, name);
  ensureDir(dir);
  let fd: number | null = null;
  try {
    fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
  } catch {
    throw new AppError("backup_storage_unavailable", 503);
  }
  try {
    fchmodSync(fd, 0o600);
    for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    closeSync(fd); fd = null;
  } catch {
    if (fd !== null) { try { closeSync(fd); } catch { /* Already failing. */ } }
    try { rmSync(path, { force: true }); } catch { /* Partial file becomes an orphan. */ }
    throw new AppError("backup_storage_unavailable", 503);
  }
  return path;
}

/** Writes snapshot bytes with restrictive permissions; throws `backup_storage_unavailable` on failure. */
export function writeArtifact(dir: string, id: string, bytes: Uint8Array): string {
  return writeManagedFile(dir, `${id}.sqlite`, bytes);
}

/** Stages native artifacts beside the image; returns manifest records in capture order. */
export function writeNativeArtifacts(dir: string, id: string, artifacts: BackupNativeArtifact[], written: string[]): BackupNativeArtifactRecord[] {
  return artifacts.map((artifact, index) => {
    const path = writeManagedFile(dir, `${id}.native-${index}.json`, artifact.bytes);
    written.push(path);
    return { name: artifact.name, path, bytes: artifact.bytes.length, hash: artifact.sha256 };
  });
}

/** Scans a manifest/artifact projection for secret material; returns canary hits (empty when clean). */
export function scanBackupSecrets(manifest: BackupManifest, canaries: string[]): string[] {
  const text = JSON.stringify(manifest);
  return canaries.filter(c => c && text.includes(c));
}

export function backupStorageStats(dir: string): { files: number; bytes: number } {
  try {
    let files = 0, bytes = 0;
    for (const entry of readdirSync(dir)) {
      if (!MANAGED_FILE.test(entry)) continue;
      try { bytes += statSync(join(dir, entry)).size; files++; } catch { /* Missing/changing artifacts stay explicit to callers. */ }
    }
    return { files, bytes };
  } catch {
    return { files: 0, bytes: 0 };
  }
}

export function artifactPathFor(dir: string, id: string): string {
  return join(dir, `${id}.sqlite`);
}

export function ownBackupDir(databasePath: string, override?: string): string {
  const dir = resolve(override ?? backupDirFor(databasePath));
  if (dirname(dir) === dir || dir.length > 1024) throw new AppError("invalid_backup_destination", 500);
  return dir;
}
