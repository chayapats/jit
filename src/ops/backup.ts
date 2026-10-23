import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AppError } from "../errors";
import { requireId } from "../sources";
import type { AppTransaction } from "../store";

export const backupContract = "ops.backup_manifest/v1" as const;
export const backupSchemaVersion = 20;
export const backupRetention = Object.freeze({ maxBackups: 10, maxBytes: 64 * 1024 * 1024 });

export interface BackupNativeSnapshot {
  refs: { id: string; generation: number }[];
  bytes: number;
  engine: string;
}

/** Engine bridge for quiesced native snapshots; production default is unavailable (fail-closed). */
export interface BackupNativePort {
  available(): boolean;
  snapshot(): BackupNativeSnapshot;
}

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

export interface BackupManifest {
  contract: typeof backupContract;
  id: string;
  createdAt: number;
  appSchema: number;
  jitVersion: string;
  appRevision: number;
  projects: { projectId: string; revision: number }[];
  sourceGenerations: { projectId: string; sourceId: string; revision: number; generation: number }[];
  lifecycle: { available: boolean; checkpoint: string | null; reason: string | null };
  native: {
    state: "valid" | "unavailable" | "incomplete";
    refs: { id: string; generation: number }[];
    bytes: number;
    engine: string | null;
    reason: string | null;
  };
  content: { bytes: number; hash: string; projects: number; sources: number };
  retention: { maxBackups: number; maxBytes: number; pruned: string[] };
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

function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

function lifecycleCheckpoint(tx: AppTransaction): { available: boolean; checkpoint: string | null; reason: string | null } {
  try {
    const rows = tx.all<{ record_json: string }>("SELECT record_json FROM memory_suppressions ORDER BY rowid DESC LIMIT 1");
    if (!rows.length) return { available: false, checkpoint: null, reason: "no_ledger_checkpoint" };
    const parsed = JSON.parse(rows[0]!.record_json) as { id?: string };
    if (typeof parsed.id !== "string") return { available: false, checkpoint: null, reason: "ledger_unverifiable" };
    return { available: true, checkpoint: parsed.id, reason: null };
  } catch {
    return { available: false, checkpoint: null, reason: "ledger_unverifiable" };
  }
}

function collectProjects(tx: AppTransaction): { projectId: string; revision: number }[] {
  return tx.all<{ projectId: string; revision: number }>("SELECT id AS projectId, revision FROM projects ORDER BY created_at, id LIMIT 1000");
}

function collectSources(tx: AppTransaction): { projectId: string; sourceId: string; revision: number; generation: number }[] {
  return tx.all<{ projectId: string; sourceId: string; revision: number; generation: number }>(
    "SELECT project_id AS projectId, id AS sourceId, current_revision AS revision, generation FROM sources ORDER BY project_id, id LIMIT 4000");
}

/** Reads one manifest without parsing backup bytes or native private formats. */
export function readBackupManifest(tx: AppTransaction, id: string): BackupManifest {
  requireId(id);
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM ops_backups WHERE id = ?", id);
  if (!row) throw new AppError("backup_not_found", 404);
  const manifest = JSON.parse(row.record_json) as BackupManifest;
  if (manifest.contract !== backupContract || typeof manifest.id !== "string") throw new AppError("backup_corrupt", 500);
  return manifest;
}

/** Bounded inventory outside ordinary project data, newest last. */
export function listBackups(tx: AppTransaction, limit = 50): BackupManifest[] {
  const rows = tx.all<{ record_json: string }>("SELECT record_json FROM ops_backups ORDER BY created_at, id LIMIT ?", Math.min(Math.max(limit, 1), 100));
  return rows.map(row => JSON.parse(row.record_json) as BackupManifest);
}

/**
 * Prepares a consistent manifest inside the caller transaction. The caller writes
 * snapshot bytes to `artifactPath` (chmod 0600) before committing the row; a crash
 * before commit leaves at most an orphan file that inventory never lists.
 */
export function prepareBackupManifest(tx: AppTransaction, input: {
  id: string; now: number; appRevision: number; appSchema: number; snapshotBytes: Uint8Array; snapshotHash: string;
  native: BackupManifest["native"]; artifactPath: string; pruned: string[];
}): BackupManifest {
  const projects = collectProjects(tx);
  const sources = collectSources(tx);
  const lifecycle = lifecycleCheckpoint(tx);
  const content = {
    bytes: input.snapshotBytes.length,
    hash: input.snapshotHash,
    projects: projects.length,
    sources: sources.length,
  };
  const nativeIncomplete = input.native.state !== "valid";
  const lifecycleIncomplete = !lifecycle.available;
  const state = nativeIncomplete || lifecycleIncomplete ? "incomplete" : "valid";
  const reason = nativeIncomplete ? input.native.reason : lifecycleIncomplete ? lifecycle.reason : null;
  return {
    contract: backupContract,
    id: input.id,
    createdAt: input.now,
    appSchema: input.appSchema,
    jitVersion: "jit-mvp-fixture",
    appRevision: input.appRevision,
    projects,
    sourceGenerations: sources,
    lifecycle,
    native: input.native,
    content,
    retention: { maxBackups: backupRetention.maxBackups, maxBytes: backupRetention.maxBytes, pruned: input.pruned },
    state,
    reason,
    artifact: { path: input.artifactPath, bytes: input.snapshotBytes.length, hash: input.snapshotHash },
  };
}

/** Resolves the native snapshot fail-closed: unavailable engine never yields a valid backup. */
export function resolveNativeSnapshot(port: BackupNativePort | undefined): BackupManifest["native"] {
  if (!port || !port.available()) {
    return { state: "unavailable", refs: [], bytes: 0, engine: null, reason: "native_snapshot_unavailable" };
  }
  try {
    const snap = port.snapshot();
    if (!snap || typeof snap.bytes !== "number" || snap.bytes < 0 || !Array.isArray(snap.refs) || typeof snap.engine !== "string" || !snap.engine) {
      return { state: "incomplete", refs: [], bytes: 0, engine: null, reason: "native_snapshot_invalid" };
    }
    for (const ref of snap.refs) requireId(ref.id);
    return { state: "valid", refs: snap.refs.map(r => ({ ...r })), bytes: snap.bytes, engine: snap.engine, reason: null };
  } catch (error) {
    if (error instanceof AppError) return { state: "unavailable", refs: [], bytes: 0, engine: null, reason: error.code };
    return { state: "incomplete", refs: [], bytes: 0, engine: null, reason: "native_snapshot_failed" };
  }
}

/** Retention pruning inside the backup transaction; deletes only managed artifact files. */
export function enforceRetention(tx: AppTransaction, backupDir: string, incomingBytes: number, keepOverride?: number): string[] {
  const keep = Math.min(keepOverride ?? backupRetention.maxBackups, backupRetention.maxBackups);
  const existing = tx.all<{ id: string; created_at: number; record_json: string }>("SELECT id, created_at AS created_at, record_json FROM ops_backups ORDER BY created_at, id");
  let total = incomingBytes;
  for (const row of existing) {
    try { total += (JSON.parse(row.record_json) as BackupManifest).artifact.bytes; } catch { /* Corrupt rows count as zero; validation surfaces them. */ }
  }
  const pruned: string[] = [];
  const excess = existing.length + 1 - keep;
  const victims = existing.slice(0, Math.max(0, excess));
  if (total > backupRetention.maxBytes) {
    for (const row of existing.slice(victims.length)) {
      const projected = total - artifactBytes(row.record_json);
      if (projected <= backupRetention.maxBytes) break;
      victims.push(row);
    }
  }
  for (const row of victims) {
    tx.run("DELETE FROM ops_backups WHERE id = ?", row.id);
    pruned.push(row.id);
    try {
      const manifest = JSON.parse(row.record_json) as BackupManifest;
      const file = join(backupDir, `${row.id}.sqlite`);
      if (manifest.artifact.path === file && existsSync(file)) rmSync(file);
    } catch { /* Pruning never fails the new backup; orphan cleanup is best-effort. */ }
  }
  return pruned;
}

function artifactBytes(recordJson: string): number {
  try { return (JSON.parse(recordJson) as BackupManifest).artifact.bytes ?? 0; } catch { return 0; }
}

/** Writes snapshot bytes with restrictive permissions; throws `backup_storage_unavailable` on failure. */
export function writeArtifact(dir: string, id: string, bytes: Uint8Array): string {
  ensureDir(dir);
  const path = join(dir, `${id}.sqlite`);
  try {
    writeFileSync(path, bytes, { mode: 0o600 });
    chmodSync(path, 0o600);
  } catch {
    throw new AppError("backup_storage_unavailable", 503);
  }
  return path;
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
      if (!entry.endsWith(".sqlite")) continue;
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
  const dir = override ?? backupDirFor(databasePath);
  if (dirname(dir) === dir || dir.length > 1024) throw new AppError("invalid_backup_destination", 500);
  return dir;
}
