import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, existsSync, fsyncSync, fstatSync, lstatSync, openSync, readFileSync, readSync, readdirSync, renameSync, rmSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AppError } from "../errors";
import type { AppTransaction } from "../store";
import { requireId } from "../sources";
import { attachmentHost, attachmentLimits } from "./limits";
import { safeAttachmentDirectory, verifyAttachmentBlob } from "./storage";

/** One content-addressed blob in a backup index, deduplicated within its project, including all derivatives. */
export interface AttachmentBlob { projectId: string; sha256: string; bytes: number }
/** Attachment artifact section. Legacy manifests omit this section only when their image has no live attachment rows. */
export interface BackupAttachments {
  state: "valid" | "incomplete" | "none"; reason: string | null; count: number; bytes: number; bound: number;
  index: { path: string; bytes: number; hash: string } | null;
}
const pins = new Map<string, Map<string, AttachmentBlob[]>>();
/** Protects a staged snapshot's shared blobs until its manifest commits or the attempt is discarded. */
export function pinBackupAttachments(backupDir: string, id: string, blobs: AttachmentBlob[] | null): void {
  const key = resolve(backupDir), active = pins.get(key) ?? new Map<string, AttachmentBlob[]>();
  if (blobs) active.set(id, blobs); else active.delete(id);
  if (active.size) pins.set(key, active); else pins.delete(key);
}
const sha = (v: Uint8Array) => createHash("sha256").update(v).digest("hex");
/** Resolves the platform-neutral default against the actual backup filesystem; the caller supplies configured overrides. */
export function backupAttachmentBound(databasePath: string, backupDir: string): number {
  return attachmentLimits({}, attachmentHost(dirname(databasePath), backupDir)).backupBytes;
}
/** Collects each original, clean, model and text hash once per project from the same snapshot as the app image. */
export function collectAttachmentBlobs(tx: Pick<AppTransaction, "all" | "get">): { count: number; bytes: number; blobs: AttachmentBlob[] } {
  if (!tx.get("SELECT 1 FROM sqlite_master WHERE name = 'attachments'")) return { count: 0, bytes: 0, blobs: [] };
  const rows = tx.all<Record<string, string | number | null>>("SELECT * FROM attachments WHERE state != 'deleted' ORDER BY project_id, id LIMIT 200001");
  if (rows.length > 200_000) throw new AppError("attachment_inventory_too_large", 409);
  const found = new Map<string, AttachmentBlob>();
  for (const row of rows) for (const [hashColumn, sizeColumn] of [["sha256", "bytes"], ["clean_sha256", "clean_bytes"], ["model_sha256", "model_bytes"], ["text_sha256", "text_bytes"]]) {
    const hash = row[hashColumn!], bytes = row[sizeColumn!], projectId = row.project_id as string;
    if (hash == null) continue;
    requireId(projectId);
    if (typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash) || !Number.isSafeInteger(bytes) || (bytes as number) < 0) throw new AppError("attachment_blob_corrupt", 409);
    const key = `${projectId}/${hash}`, prior = found.get(key);
    if (prior && prior.bytes !== bytes) throw new AppError("attachment_blob_corrupt", 409);
    found.set(key, { projectId, sha256: hash, bytes: bytes as number });
  }
  const blobs = [...found.values()].sort((a, b) => `${a.projectId}/${a.sha256}`.localeCompare(`${b.projectId}/${b.sha256}`));
  return { count: rows.length, bytes: blobs.reduce((n, b) => n + b.bytes, 0), blobs };
}
/** Validates generated project/hash components and all private directory ancestors; filenames are never owner input. */
export function attachmentArtifactPath(root: string, blob: AttachmentBlob, create = false): string {
  requireId(blob.projectId);
  if (!/^[a-f0-9]{64}$/.test(blob.sha256)) throw new AppError("attachment_blob_corrupt", 409);
  for (const path of [root, join(root, blob.projectId), join(root, blob.projectId, blob.sha256.slice(0, 2))]) {
    if (create) safeAttachmentDirectory(path);
    else { const st = lstatSync(path); if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077)) throw new AppError("attachment_blob_corrupt", 409); }
  }
  return join(root, blob.projectId, blob.sha256.slice(0, 2), blob.sha256);
}
/** Copies through a private, verified and fsynced sibling before atomic publication; repairs corrupt regular files without following links or sharing inodes. */
export function copyAttachmentBlob(sourceRoot: string, targetRoot: string, blob: AttachmentBlob): void {
  const source = attachmentArtifactPath(sourceRoot, blob);
  verifyAttachmentBlob(source, blob.sha256, blob.bytes);
  const target = attachmentArtifactPath(targetRoot, blob, true);
  const checkTarget = () => {
    try {
      const st = lstatSync(target);
      if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077)) throw new AppError("attachment_blob_corrupt", 409);
      return true;
    } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return false; throw e; }
  };
  if (checkTarget()) {
    try { verifyAttachmentBlob(target, blob.sha256, blob.bytes); return; }
    catch { /* Only a verified replacement may repair this regular file. */ }
  }
  const temporary = join(dirname(target), `.${blob.sha256}.${randomUUID()}.tmp`);
  let input: number | null = null, output: number | null = null;
  try {
    output = openSync(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    input = openSync(source, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const stat = fstatSync(input);
    if (!stat.isFile() || stat.size !== blob.bytes || (stat.mode & 0o077)) throw new Error("attachment_blob_corrupt");
    const digest = createHash("sha256"), chunk = Buffer.alloc(65536); let bytes = 0;
    for (;;) {
      const n = readSync(input, chunk, 0, chunk.length, null); if (!n) break;
      bytes += n; if (bytes > blob.bytes) throw new Error("attachment_blob_corrupt"); digest.update(chunk.subarray(0, n));
      for (let at = 0; at < n;) {
        const written = writeSync(output, chunk, at, n - at);
        if (!written) throw new Error("attachment_write_failed");
        at += written;
      }
    }
    if (bytes !== blob.bytes || digest.digest("hex") !== blob.sha256) throw new Error("attachment_blob_corrupt");
    fsyncSync(output);
    closeSync(output); output = null;
    // Recheck the authorized directory and refuse non-regular destinations before replacing the name.
    attachmentArtifactPath(targetRoot, blob); checkTarget();
    renameSync(temporary, target);
    const fd = openSync(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { fsyncSync(fd); } finally { closeSync(fd); }
  } finally {
    if (output !== null) closeSync(output);
    if (input !== null) closeSync(input);
    rmSync(temporary, { force: true });
  }
}
/** Captures blobs inside the snapshot transaction. The bound must be checked before this function or any backup writer runs. */
export function stageBackupAttachments(databasePath: string, backupDir: string, inventory: ReturnType<typeof collectAttachmentBlobs>, bound: number): Omit<BackupAttachments, "index"> {
  let reason: string | null = null;
  if (inventory.blobs.length) safeAttachmentDirectory(backupDir);
  for (const blob of inventory.blobs) {
    try { copyAttachmentBlob(join(dirname(resolve(databasePath)), "attachments"), join(backupDir, "attachments"), blob); }
    catch (e) { reason ??= (e as NodeJS.ErrnoException).code === "ENOENT" ? "attachment_blob_missing" : "attachment_blob_corrupt"; }
  }
  return { state: reason ? "incomplete" : inventory.count ? "valid" : "none", reason, count: inventory.count, bytes: inventory.bytes, bound };
}
/** Reads a bounded, hashed per-backup index; rejects traversal, duplicates, malformed sizes and non-regular files. */
export function readAttachmentIndex(section: BackupAttachments | undefined, backupDir: string, id: string): AttachmentBlob[] {
  if (!section) return [];
  if (!section.index) { if (section.state === "none" && section.bytes === 0 && section.count === 0) return []; throw new AppError("attachment_index_missing", 409); }
  const expected = join(resolve(backupDir), `${id}.attachments.json`), index = section.index;
  if (index.path !== expected || !Number.isSafeInteger(index.bytes) || index.bytes > 32 * 1024 * 1024 || index.bytes < 2) throw new AppError("attachment_index_corrupt", 409);
  const st = lstatSync(expected);
  if (!st.isFile() || st.isSymbolicLink() || st.size !== index.bytes) throw new AppError("attachment_index_corrupt", 409);
  const bytes = readFileSync(expected);
  if (sha(bytes) !== index.hash) throw new AppError("attachment_index_corrupt", 409);
  const rows = JSON.parse(bytes.toString()) as AttachmentBlob[];
  if (!Array.isArray(rows) || rows.length > 200_000) throw new AppError("attachment_index_corrupt", 409);
  const seen = new Set<string>(); let total = 0;
  for (const row of rows) {
    requireId(row.projectId);
    const key = `${row.projectId}/${row.sha256}`;
    if (!/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || seen.has(key)) throw new AppError("attachment_index_corrupt", 409);
    seen.add(key); total += row.bytes;
  }
  if (total !== section.bytes) throw new AppError("attachment_index_corrupt", 409);
  return rows;
}
/** Listing checks the index hash and blob sizes; restore additionally streams every blob through SHA-256. */
export function verifyBackupAttachments(section: BackupAttachments | undefined, backupDir: string, id: string, hashes: boolean): string | null {
  if (!section) return null;
  if (section.state === "incomplete") return section.reason ?? "attachment_blob_corrupt";
  try {
    for (const blob of readAttachmentIndex(section, backupDir, id)) {
      const path = attachmentArtifactPath(join(backupDir, "attachments"), blob), st = lstatSync(path);
      if (!st.isFile() || st.isSymbolicLink() || st.size !== blob.bytes || (st.mode & 0o077)) return "attachment_blob_corrupt";
      if (hashes) verifyAttachmentBlob(path, blob.sha256, blob.bytes);
    }
    return null;
  } catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT" ? "attachment_blob_missing" : "attachment_blob_corrupt"; }
}
/** Prunes only unreferenced shared backup blobs; corrupt committed indexes disable pruning rather than endanger retained backups. */
export function sweepBackupAttachmentBlobs(tx: AppTransaction, backupDir: string, graceMs = 600_000): void {
  const live = new Set<string>([...(pins.get(resolve(backupDir))?.values() ?? [])].flatMap(blobs => blobs.map(b => `${b.projectId}/${b.sha256}`)));
  try {
    for (const row of tx.all<{ id: string; json: string }>("SELECT id, record_json AS json FROM ops_backups")) {
      const manifest = JSON.parse(row.json);
      for (const b of readAttachmentIndex(manifest.attachments, backupDir, row.id)) live.add(`${b.projectId}/${b.sha256}`);
    }
  } catch { return; }
  const root = join(backupDir, "attachments"); if (!existsSync(root)) return;
  if (lstatSync(root).isSymbolicLink()) throw new AppError("backup_storage_unavailable", 503);
  for (const project of readdirSync(root, { withFileTypes: true })) {
    if (!project.isDirectory() || !/^[a-f0-9-]{36}$/.test(project.name)) continue;
    for (const prefix of readdirSync(join(root, project.name), { withFileTypes: true })) {
      if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
      for (const entry of readdirSync(join(root, project.name, prefix.name), { withFileTypes: true })) {
        if (!entry.isFile() || !/^[a-f0-9]{64}$/.test(entry.name) || live.has(`${project.name}/${entry.name}`)) continue;
        const path = join(root, project.name, prefix.name, entry.name);
        if (graceMs === 0 || lstatSync(path).mtimeMs <= Date.now() - graceMs) rmSync(path);
      }
    }
  }
}
