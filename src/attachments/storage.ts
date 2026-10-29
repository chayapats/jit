import { createHash } from "node:crypto";
import { closeSync, constants, fchmodSync, fsyncSync, fstatSync, linkSync, lstatSync, mkdirSync, openSync, readSync, readFileSync, readdirSync, statfsSync, unlinkSync, writeSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { AppError } from "../errors";
import { requireId } from "../sources";
import type { AppTransaction, TransactionStore } from "../store";
import type { AttachmentLimits } from "./limits";
import { attachmentBlobReferenced, attachmentProjectBytes, readAttachment, writeAttachmentEvent, type AttachmentView } from "./records";
import { attachmentDisplayName, AttachmentSniffer } from "./types";

/** Deterministic I/O seams; absent isolated-sanitizer capability refuses PDF/WebP. */
export interface AttachmentStorageOptions {
  now?: () => number; diskFree?: (directory: string) => number; sanitizerAvailable?: () => boolean;
  forbiddenDirectories?: readonly (string | null)[];
  backupActive?: () => boolean; assertWritable?: () => void;
}
/** One file stream, reusable by ATT03's ordered multipart reader after it has verified CSRF and scope. */
export interface AttachmentUpload { body: ReadableStream<Uint8Array> | null; encodedName: string | null; contentLength?: string | null }
/** Maximum original blobs compared per upload; an overflow disables the quota dedupe exception entirely. */
export const attachmentDedupeCandidates = 16;
const hashPattern = /^[a-f0-9]{64}$/;
const projectPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const active = new Map<string, { stages: Set<string>; reserved: number }>();
function safeDirectory(path: string): void {
  let created = false;
  try { mkdirSync(path, { mode: 0o700 }); created = true; } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0 || (process.getuid && st.uid !== process.getuid())) throw new AppError("storage_unavailable", 503);
  if (created) {
    const parent = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
    try { fsyncSync(parent); } finally { closeSync(parent); }
  }
}
function writeAll(fd: number, bytes: Uint8Array, written: (bytes: number) => void): void {
  let at = 0; while (at < bytes.length) { const n = writeSync(fd, bytes, at, bytes.length - at); if (!n) throw new Error("attachment_write_failed"); at += n; written(n); }
}
function verifyBlob(path: string, hash: string, bytes: number): void {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size !== bytes || (stat.mode & 0o077) !== 0) throw new Error("attachment_blob_invalid");
    const digest = createHash("sha256"), chunk = Buffer.alloc(65536);
    for (;;) { const n = readSync(fd, chunk, 0, chunk.length, null); if (!n) break; digest.update(chunk.subarray(0, n)); }
    if (digest.digest("hex") !== hash) throw new Error("attachment_blob_invalid");
  } finally { closeSync(fd); }
}

/** Content-addressed per-project store; callers authorize scope before admission and again in the commit transaction. */
export class AttachmentStorage {
  readonly root: string;
  #now: () => number;
  #diskFree: (directory: string) => number;
  #state: { stages: Set<string>; reserved: number };
  constructor(readonly store: TransactionStore, readonly limits: AttachmentLimits, readonly options: AttachmentStorageOptions = {}) {
    this.root = join(dirname(resolve(store.path)), "attachments");
    for (const directory of options.forbiddenDirectories ?? []) {
      if (!directory) continue;
      const path = resolve(directory);
      if (path === this.root || path.startsWith(this.root + "/") || this.root.startsWith(path + "/")) throw new AppError("storage_unavailable", 503);
    }
    this.#now = options.now ?? Date.now;
    this.#diskFree = options.diskFree ?? (directory => { const fs = statfsSync(directory); return Number(fs.bavail) * Number(fs.bsize); });
    this.#state = active.get(this.root) ?? { stages: new Set(), reserved: 0 }; active.set(this.root, this.#state);
  }
  /** Computes only generated paths, never display names. Does not create or follow untrusted path components. */
  blobPath(projectId: string, hash: string): string {
    requireId(projectId); if (!hashPattern.test(hash)) throw new AppError("invalid_identity");
    return join(this.root, projectId, hash.slice(0, 2), hash);
  }
  #directories(projectId?: string, hash?: string): void {
    safeDirectory(this.root); safeDirectory(join(this.root, ".staging"));
    if (projectId) { safeDirectory(join(this.root, projectId)); if (hash) safeDirectory(join(this.root, projectId, hash.slice(0, 2))); }
  }
  #writable(): void { this.options.assertWritable?.(); }
  /** Streams and hashes with immediate size/quota cut-off; commits metadata only after a durable verified blob exists. */
  async upload(projectId: string, topicId: string, input: AttachmentUpload, authorize: (tx: AppTransaction) => void): Promise<AttachmentView> {
    for (const id of [projectId, topicId]) requireId(id);
    this.store.read(authorize); this.#writable();
    if (!this.limits.enabled) throw new AppError("attachments_disabled", 404);
    let stage: string | null = null, fd: number | null = null, reservation = 0, reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    let bytes = 0, committed = false, verified = false;
    try {
      const name = attachmentDisplayName(input.encodedName);
      const declared = input.contentLength == null ? null : /^\d+$/.test(input.contentLength) ? Number(input.contentLength) : NaN;
      if (declared !== null && (!Number.isSafeInteger(declared) || declared < 0)) throw new AppError("invalid_attachment_upload");
      if (declared !== null && declared > this.limits.fileBytes) throw new AppError("attachment_too_large", 413);
      this.#directories();
      const required = declared ?? this.limits.fileBytes;
      if (this.#diskFree(this.root) - this.#state.reserved - required < this.limits.diskReserveBytes) throw new AppError("attachment_disk_reserve", 507);
      reservation = required; this.#state.reserved += reservation;
      // Keep possible same-project duplicates alive even at the quota. Comparing prefixes prevents buffering the file
      // or denying a duplicate just because its original already consumes the last quota byte.
      const remaining = this.store.read(tx => this.limits.projectBytes - attachmentProjectBytes(tx, projectId));
      let candidates = this.store.read(tx => tx.all<{ hash: string; bytes: number }>(`SELECT sha256 AS hash, max(bytes) AS bytes FROM attachments
        WHERE project_id = ? AND state != 'deleted' AND sha256 IS NOT NULL AND bytes > ? AND (? IS NULL OR bytes = ?) GROUP BY sha256 LIMIT ?`, projectId, remaining, declared, declared, attachmentDedupeCandidates + 1));
      if (candidates.length > attachmentDedupeCandidates) candidates = [];
      if (declared !== null && declared > remaining && !candidates.length) throw new AppError("attachment_quota_exceeded", 413, { limit: "project_bytes" });
      if (!input.body) throw new AppError("invalid_attachment_upload");
      stage = join(this.root, ".staging", crypto.randomUUID());
      fd = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      fchmodSync(fd, 0o600); this.#state.stages.add(stage);
      const digest = createHash("sha256"), sniffer = new AttachmentSniffer(); reader = input.body.getReader();
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        this.#writable(); this.store.read(authorize);
        const next = bytes + value.byteLength;
        if (next > this.limits.fileBytes) throw new AppError("attachment_too_large", 413);
        if (declared !== null && next > declared) throw new AppError("invalid_attachment_upload");
        candidates = candidates.filter(candidate => {
          if (candidate.bytes < next) return false;
          let compare: number | null = null;
          try {
            compare = openSync(this.blobPath(projectId, candidate.hash), constants.O_RDONLY | constants.O_NOFOLLOW);
            const buffer = Buffer.alloc(value.length); let n = 0;
            while (n < buffer.length) { const got = readSync(compare, buffer, n, buffer.length - n, bytes + n); if (!got) return false; n += got; }
            return buffer.equals(value);
          } catch { return false; } finally { if (compare !== null) closeSync(compare); }
        });
        if (next > remaining && !candidates.length) throw new AppError("attachment_quota_exceeded", 413, { limit: "project_bytes" });
        // The probe is checked during the stream as well, to catch non-Jit writers consuming the reserve.
        if (this.#diskFree(this.root) - value.length < this.limits.diskReserveBytes) throw new AppError("attachment_disk_reserve", 507);
        writeAll(fd, value, n => { reservation -= n; this.#state.reserved -= n; }); digest.update(value); sniffer.push(value); bytes = next;
      }
      if (declared !== null && bytes !== declared) throw new AppError("invalid_attachment_upload");
      const type = sniffer.finish(name);
      if ((type.kind === "pdf" || type.mediaType === "image/webp") && !this.options.sanitizerAvailable?.()) {
        throw new AppError("attachment_needs_sanitizer", 415, { kind: type.kind === "pdf" ? "pdf" : "webp" });
      }
      fsyncSync(fd); closeSync(fd); fd = null;
      const hash = digest.digest("hex"), id = crypto.randomUUID(), at = this.#now();
      this.#directories(projectId, hash);
      const path = this.blobPath(projectId, hash);
      const view = this.store.transaction(tx => {
        authorize(tx); this.#writable();
        const duplicate = tx.get(`SELECT 1 FROM attachments WHERE project_id = ? AND sha256 = ? AND state != 'deleted' LIMIT 1`, projectId, hash);
        if (!duplicate && attachmentProjectBytes(tx, projectId) + bytes > this.limits.projectBytes) throw new AppError("attachment_quota_exceeded", 413, { limit: "project_bytes" });
        try { linkSync(stage!, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
        verifyBlob(path, hash, bytes);
        const dir = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
        try { fsyncSync(dir); } finally { closeSync(dir); }
        tx.run(`INSERT INTO attachments (id, project_id, topic_id, revision, state, kind, media_type, display_name, bytes, sha256,
          sanitized_by, text_sha256, text_bytes, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, projectId, topicId, type.kind === "text" ? "ready" : "pending", type.kind, type.mediaType, name, bytes, hash,
          type.kind === "text" ? "service" : null, type.kind === "text" ? hash : null, type.kind === "text" ? bytes : null, at, at);
        writeAttachmentEvent(tx, { projectId, attachmentId: id, kind: "upload", status: "ok", bytes, createdAt: at });
        return readAttachment(tx, projectId, topicId, id);
      });
      committed = true;
      // Do not release staging until the transaction commits AND the final path is verified. It can recover a
      // missing path even after a failed GC/unlink; an interrupted uploader leaves a recoverable orphan for sweep.
      try { verifyBlob(path, hash, bytes); } catch (error) {
        try { linkSync(stage, path); verifyBlob(path, hash, bytes); } catch { throw error; }
      }
      verified = true; return view;
    } catch (error) {
      if (reader) { try { await reader.cancel(); } catch { /* Preserve the safe rejection. */ } }
      if (error instanceof AppError && ["attachment_too_large", "attachment_quota_exceeded", "attachment_disk_reserve", "attachment_type_unsupported", "attachment_needs_sanitizer"].includes(error.code)) {
        this.store.transaction(tx => { authorize(tx); this.#writable(); writeAttachmentEvent(tx, { projectId, kind: "reject", status: "refused",
          reason: error.detail?.reason as string ?? error.code, bytes, detail: error.detail?.reason ? {} : error.detail ?? {}, createdAt: this.#now() }); });
      }
      throw error;
    } finally {
      reader?.releaseLock(); if (fd !== null) closeSync(fd);
      if (stage) { this.#state.stages.delete(stage); if (!committed || verified) { try { unlinkSync(stage); } catch { /* Sweep retries abandoned staging files. */ } } }
      this.#state.reserved -= reservation;
    }
  }
  /** Creates a protected per-job copy, never mounting the content store or a name supplied by an owner. */
  sanitizerWork(projectId: string, hash: string, bytes: number, outputBytes = 0): { directory: string; input: string; output: string; release(): void } {
    this.#writable(); this.#directories(projectId, hash);
    const root = join(this.root, ".work"); safeDirectory(root);
    const directory = join(root, crypto.randomUUID()); safeDirectory(directory); this.#state.stages.add(directory);
    const input = join(directory, "in"), output = join(directory, "out");
    let reservation = 0;
    try {
      if (this.#diskFree(this.root) - this.#state.reserved - bytes - outputBytes < this.limits.diskReserveBytes) throw new Error("sanitizer_unavailable");
      reservation = outputBytes; this.#state.reserved += reservation;
      safeDirectory(input); safeDirectory(output);
      verifyBlob(this.blobPath(projectId, hash), hash, bytes);
      const source = openSync(this.blobPath(projectId, hash), constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const target = openSync(join(input, "input"), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
          const chunk = Buffer.alloc(65536); let copied = 0;
          for (;;) {
            const n = readSync(source, chunk, 0, chunk.length, null); if (!n) break;
            if (copied + n > bytes || this.#diskFree(this.root) - this.#state.reserved - n < this.limits.diskReserveBytes) throw new Error("sanitizer_unavailable");
            writeAll(target, chunk.subarray(0, n), () => {}); copied += n;
          }
          if (copied !== bytes) throw new Error("sanitize_output_invalid");
          fsyncSync(target);
        } finally { closeSync(target); }
      } finally { closeSync(source); }
      return { directory, input, output, release: () => { rmSync(directory, { recursive: true, force: true }); this.#state.stages.delete(directory); this.#state.reserved -= reservation; reservation = 0; } };
    } catch (error) { rmSync(directory, { recursive: true, force: true }); this.#state.stages.delete(directory); this.#state.reserved -= reservation; throw error; }
  }
  /** Reads only a bounded regular output file without following symlinks; used after every parser has stopped. */
  sanitizerOutput(path: string, cap: number): Buffer {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const st = fstatSync(fd);
      if (!st.isFile() || st.nlink !== 1 || st.size > cap) throw new Error("sanitize_output_invalid");
      const bytes = readFileSync(fd);
      if (bytes.length !== st.size || bytes.length > cap) throw new Error("sanitize_output_invalid");
      return bytes;
    } finally { closeSync(fd); }
  }
  /** Publishes validated derivative bytes under the writer transaction; failed commits leave sweepable orphans. */
  publishDerivative(projectId: string, bytes: Uint8Array): string {
    this.#writable();
    const hash = createHash("sha256").update(bytes).digest("hex"); this.#directories(projectId, hash);
    const stage = join(this.root, ".staging", crypto.randomUUID());
    const fd = openSync(stage, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    this.#state.stages.add(stage);
    try {
      if (this.#diskFree(this.root) - this.#state.reserved - bytes.length < this.limits.diskReserveBytes) throw new Error("sanitizer_unavailable");
      writeAll(fd, bytes, () => {}); fsyncSync(fd);
      const path = this.blobPath(projectId, hash);
      try { linkSync(stage, path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      verifyBlob(path, hash, bytes.length);
      const dir = openSync(dirname(path), constants.O_RDONLY | constants.O_NOFOLLOW);
      try { fsyncSync(dir); } finally { closeSync(dir); }
      return hash;
    } finally { closeSync(fd); unlinkSync(stage); this.#state.stages.delete(stage); }
  }
  /** Removes one original/derivative only when no live row references it and no backup is being staged. */
  removeUnreferenced(projectId: string, hash: string): void {
    this.store.transaction(tx => {
      this.#writable(); if (this.options.backupActive?.() || attachmentBlobReferenced(tx, projectId, hash)) return;
      this.#directories(projectId, hash);
      try { unlinkSync(this.blobPath(projectId, hash)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    });
  }
  /** Expires only unbound staged rows, then removes unreferenced blobs and >10 minute abandoned work. Safe with gate off. */
  sweep(): { expired: number; removed: number } {
    this.#writable();
    if (this.options.backupActive?.()) return { expired: 0, removed: 0 };
    this.#directories();
    const at = this.#now(); let expired = 0, removed = 0;
    this.store.transaction(tx => {
      this.#writable(); if (this.options.backupActive?.()) return;
      const rows = tx.all<{ id: string; projectId: string }>(`SELECT id, project_id AS projectId FROM attachments
        WHERE message_id IS NULL AND state != 'deleted' AND created_at <= ?`, at - this.limits.stagedHours * 3600_000);
      for (const row of rows) {
        tx.run(`UPDATE attachments SET state = 'deleted', revision = revision + 1, reason = 'staged_expired', display_name = NULL,
          sha256 = NULL, clean_sha256 = NULL, model_sha256 = NULL, text_sha256 = NULL, updated_at = ?, deleted_at = ? WHERE id = ?`, at, at, row.id);
        writeAttachmentEvent(tx, { projectId: row.projectId, attachmentId: row.id, kind: "delete", status: "ok", reason: "staged_expired", createdAt: at }); expired++;
      }
    });
    this.store.transaction(tx => {
      this.#writable(); if (this.options.backupActive?.()) return;
      // All reference checks and unlinks share this immediate writer transaction, so no row can race an unlink.
      for (const project of readdirSync(this.root, { withFileTypes: true })) {
        if (!project.isDirectory() || !projectPattern.test(project.name)) continue;
        requireId(project.name); safeDirectory(join(this.root, project.name));
        for (const prefix of readdirSync(join(this.root, project.name), { withFileTypes: true })) {
          if (!prefix.isDirectory() || !/^[a-f0-9]{2}$/.test(prefix.name)) continue;
          const dir = join(this.root, project.name, prefix.name); safeDirectory(dir);
          for (const entry of readdirSync(dir, { withFileTypes: true })) if (entry.isFile() && hashPattern.test(entry.name) && entry.name.startsWith(prefix.name) && !attachmentBlobReferenced(tx, project.name, entry.name)) {
            unlinkSync(join(dir, entry.name)); removed++;
          }
        }
      }
      for (const name of [".staging", ".work"]) {
        const dir = join(this.root, name);
        try { if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) continue; } catch { continue; }
        for (const entry of readdirSync(dir)) {
          const path = join(dir, entry);
          if (this.#state.stages.has(path) || lstatSync(path).mtimeMs > at - 600_000) continue;
          rmSync(path, { recursive: true, force: true }); removed++;
        }
      }
    });
    return { expired, removed };
  }
}
