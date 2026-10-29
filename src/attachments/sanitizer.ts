import { invalidateReadiness } from "../exec/readiness-cache";
import { join } from "node:path";
import { opendirSync } from "node:fs";
import { stripAttachmentMetadata } from "./fallback";
import { writeAttachmentEvent } from "./records";
import type { AttachmentStorage } from "./storage";
import { sanitizerReasons, type AttachmentSanitizerRuntime, type SanitizeJob } from "./sanitizer-runtime";
import { sanitizerOutputBudget, sanitizerOutputLimits } from "./sanitizer-output";
export { sanitizerOutputLimits } from "./sanitizer-output";

interface Pending {
  id: string; projectId: string; sha256: string; bytes: number; revision: number;
  mediaType: string; kind: string; attempts: number; reason: string | null;
}
interface Derivatives { clean?: Buffer; model?: Buffer; text?: Buffer; mediaType?: string; truncated: boolean }
const running = new Map<string, Promise<number>>();

/**
 * Oldest-first pending-row worker, serialized per installation. Attempts commit before parsing, so a crash consumes
 * an attempt and at most two attempts can occur. Service ownership/lifecycle fences are rechecked at publication.
 */
export class AttachmentSanitizer {
  #closed = false;
  #deletionPauses = 0;
  #abort = new AbortController();
  #unsafeWork: { release(): void }[] = [];
  constructor(readonly storage: AttachmentStorage, readonly runtime: AttachmentSanitizerRuntime | null,
    readonly options: { now?: () => number; assertCurrent?: () => void; onSettled?: () => void } = {}) {}
  /** Probes only the rootless runtime and pinned image; no container or attachment bytes are opened. */
  async available(): Promise<boolean> {
    const available = !this.#closed && !!this.runtime && await this.runtime.available();
    if (!available && this.runtime) invalidateReadiness(this.runtime);
    return available;
  }
  /** Processes a bounded batch; overlapping callers share the installation's current batch. Safe with ingestion off. */
  pump(maximum = 8): Promise<number> {
    if (this.#closed || this.#deletionPauses) return Promise.resolve(0);
    const existing = running.get(this.storage.root); if (existing) return existing;
    const work = this.#pump(maximum).finally(() => { if (running.get(this.storage.root) === work) running.delete(this.storage.root); });
    running.set(this.storage.root, work); return work;
  }
  /** Stops admission, kills an active parser, and waits for its cleanup before the caller closes SQLite. */
  async close(): Promise<void> { this.#closed = true; this.#abort.abort(); await running.get(this.storage.root)?.catch(() => undefined); }
  /** Fences parser admission, aborts the current batch and verifies cleanup of its private input/output copies before deletion completes. */
  async settleForDeletion(): Promise<void> {
    this.#deletionPauses++;
    try {
      const hasWork = this.storage.hasSanitizerWork();
      this.#abort.abort();
      await running.get(this.storage.root)?.catch(() => undefined);
      if (hasWork || this.#unsafeWork.length) {
        if (!this.runtime) throw new Error("sanitizer_cleanup_failed");
        await this.runtime.reset();
        for (const work of this.#unsafeWork.splice(0)) work.release();
      }
    } finally { this.#deletionPauses--; if (!this.#deletionPauses && !this.#closed) this.#abort = new AbortController(); }
  }
  #current(): void { if (this.#closed || this.#deletionPauses) throw new Error("sanitizer_unavailable"); this.storage.options.assertWritable?.(); this.options.assertCurrent?.(); }
  async #pump(maximum: number): Promise<number> {
    let settled = 0;
    for (let n = 0; n < maximum; n++) {
      this.#current();
      if (this.storage.backupActive()) break;
      const row = this.storage.store.read(tx => tx.get<Pending>(`SELECT id, project_id AS projectId, sha256, bytes, revision,
        media_type AS mediaType, kind, sanitize_attempts AS attempts, reason FROM attachments WHERE state = 'pending' ORDER BY created_at, id LIMIT 1`));
      if (!row) break;
      const container = await this.available(); this.#current();
      if (this.#unsafeWork.length && !container) throw new Error("sanitizer_cleanup_failed");
      if (container) { await this.runtime!.reset(); for (const work of this.#unsafeWork.splice(0)) work.release(); }
      // A crash during the second attempt leaves pending/2. Do not run a third parser.
      if (row.attempts >= 2) { this.#finish(row, null, "container", row.reason ?? "sanitizer_unavailable", 0); settled++; continue; }
      const claimed = this.storage.store.transaction(tx => {
        this.#current();
        if (!tx.get("SELECT 1 FROM attachments WHERE id = ? AND state = 'pending' AND revision = ? AND sanitize_attempts = ?", row.id, row.revision, row.attempts)) return false;
        tx.run(`UPDATE attachments SET sanitize_attempts = sanitize_attempts + 1, reason = 'sanitizer_unavailable', updated_at = ?
          WHERE id = ? AND state = 'pending' AND revision = ? AND sanitize_attempts = ?`, this.#now(), row.id, row.revision, row.attempts); return true;
      });
      if (!claimed) continue;
      const start = this.#now(); let result: Derivatives | null = null, reason: string | null = null;
      let work: ReturnType<AttachmentStorage["sanitizerWork"]> | undefined;
      let safe = true;
      try {
        work = this.storage.sanitizerWork(row.projectId, row.sha256, row.bytes, container ? sanitizerOutputBudget(row.kind) : 0);
        if (container) {
          try { await this.runtime!.run({ input: work.input, output: work.output, kind: this.#kind(row), pixels: this.storage.limits.imagePixels }, this.#abort.signal); }
          catch (error) { invalidateReadiness(this.runtime!); if ((error as Error).message === "sanitizer_cleanup_failed") safe = false; throw error; }
          this.#current(); result = this.#outputs(row, work.output);
        } else {
          if (row.mediaType !== "image/png" && row.mediaType !== "image/jpeg") throw new Error("sanitizer_unavailable");
          const bytes = this.storage.sanitizerOutput(join(work.input, "input"), this.storage.limits.fileBytes);
          result = { clean: Buffer.from(stripAttachmentMetadata(bytes, row.mediaType, this.storage.limits.imagePixels)), mediaType: row.mediaType, truncated: false };
        }
      } catch (error) { const code = (error as Error).message; reason = sanitizerReasons.has(code) ? code : "sanitize_output_invalid"; }
      finally { if (work) { if (safe) work.release(); else this.#unsafeWork.push(work); } }
      if (!safe) throw new Error("sanitizer_cleanup_failed");
      this.#current();
      let done: boolean;
      try { done = this.#finish(row, result, container ? "container" : "fallback", reason, Math.max(0, this.#now() - start)); }
      catch (error) {
        this.#current();
        if (!result) throw error;
        const code = (error as Error).message;
        done = this.#finish(row, null, container ? "container" : "fallback", sanitizerReasons.has(code) ? code : "sanitize_output_invalid", Math.max(0, this.#now() - start));
      }
      if (done) settled++;
    }
    return settled;
  }
  #now(): number { return (this.options.now ?? Date.now)(); }
  #kind(row: Pending): SanitizeJob["kind"] {
    if (row.kind === "pdf") return "pdf";
    const kind = ({ "image/png": "png", "image/jpeg": "jpeg", "image/webp": "webp" } as const)[row.mediaType as "image/png"];
    if (!kind) throw new Error("sanitize_output_invalid"); return kind;
  }
  #outputs(row: Pending, directory: string): Derivatives {
    const invalid = (): never => { throw new Error("sanitize_output_invalid"); };
    let result: Record<string, unknown>;
    try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.storage.sanitizerOutput(join(directory, "result.json"), sanitizerOutputLimits.result))); }
    catch { return invalid(); }
    if (!result || typeof result !== "object" || Array.isArray(result) || typeof result.ok !== "boolean") return invalid();
    if (!result.ok) { if (typeof result.reason === "string" && sanitizerReasons.has(result.reason)) throw new Error(result.reason); return invalid(); }
    if (typeof result.truncated !== "boolean") return invalid();
    // A compromised parser cannot make validation enumerate an unbounded output directory.
    const directoryHandle = opendirSync(directory), names: string[] = [];
    try { for (let n = 0; n < 4; n++) { const entry = directoryHandle.readSync(); if (!entry) break; names.push(entry.name); } }
    finally { directoryHandle.closeSync(); }
    const files = names.sort().join(",");
    if (row.kind === "pdf") {
      if (!Number.isSafeInteger(result.pages) || Number(result.pages) < 1 || Number(result.pages) > 50) return invalid();
      if (files !== "result.json,text.txt") return invalid();
      const text = this.storage.sanitizerOutput(join(directory, "text.txt"), sanitizerOutputLimits.text);
      try { if (new TextDecoder("utf-8", { fatal: true }).decode(text).includes("\0")) return invalid(); } catch { return invalid(); }
      return { text, truncated: result.truncated };
    }
    if (![result.width, result.height].every(n => Number.isSafeInteger(n) && Number(n) > 0) || Number(result.width) * Number(result.height) > this.storage.limits.imagePixels) return invalid();
    const jpeg = row.mediaType === "image/jpeg", ext = jpeg ? "jpg" : "png", magic = Buffer.from(jpeg ? "ffd8ff" : "89504e470d0a1a0a", "hex");
    if (files !== `clean.${ext},model.${ext},result.json`) return invalid();
    const clean = this.storage.sanitizerOutput(join(directory, `clean.${ext}`), sanitizerOutputLimits.image);
    const model = this.storage.sanitizerOutput(join(directory, `model.${ext}`), sanitizerOutputLimits.image);
    if (![clean, model].every(bytes => bytes.length > magic.length && bytes.subarray(0, magic.length).equals(magic))) return invalid();
    return { clean, model, mediaType: jpeg ? "image/jpeg" : "image/png", truncated: false };
  }
  #finish(row: Pending, result: Derivatives | null, by: "container" | "fallback", reason: string | null, durationMs: number): boolean {
    let settled = false;
    this.storage.store.transaction(tx => {
      this.#current();
      const current = tx.get<{ attempts: number }>("SELECT sanitize_attempts AS attempts FROM attachments WHERE id = ? AND state = 'pending' AND sha256 = ?", row.id, row.sha256);
      if (!current) return;
      const at = this.#now();
      if (result) {
        const publish = (bytes: Buffer | undefined) => bytes === undefined ? null : this.storage.publishDerivative(row.projectId, bytes);
        const clean = publish(result.clean), model = publish(result.model), text = publish(result.text);
        tx.run(`UPDATE attachments SET state = 'ready', revision = revision + 1, sanitized_by = ?, clean_sha256 = ?, clean_media_type = ?, clean_bytes = ?,
          model_sha256 = ?, model_bytes = ?, text_sha256 = ?, text_bytes = ?, text_truncated = ?, reason = NULL, updated_at = ? WHERE id = ?`,
          by, clean, result.mediaType ?? null, result.clean?.length ?? null, model, result.model?.length ?? null, text, result.text?.length ?? null, result.truncated ? 1 : 0, at, row.id);
        settled = true;
      } else if (current.attempts >= 2) {
        tx.run("UPDATE attachments SET state = 'rejected', revision = revision + 1, sha256 = NULL, reason = ?, updated_at = ? WHERE id = ?", reason, at, row.id);
        writeAttachmentEvent(tx, { projectId: row.projectId, attachmentId: row.id, kind: "reject", status: "refused", reason, createdAt: at }); settled = true;
      } else tx.run("UPDATE attachments SET reason = ?, updated_at = ? WHERE id = ?", reason, at, row.id);
      writeAttachmentEvent(tx, { projectId: row.projectId, attachmentId: row.id, kind: "sanitize", status: result ? "ok" : "failed", reason,
        detail: { sanitizedBy: by, durationMs, truncated: result?.truncated ?? false }, createdAt: at });
    });
    if (settled) {
      this.storage.removeUnreferenced(row.projectId, row.sha256);
      try { this.options.onSettled?.(); } catch { /* The service queue tick retries admission independently. */ }
    }
    return settled;
  }
}
