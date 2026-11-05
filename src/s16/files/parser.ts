import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, opendirSync, readSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { createImageContent } from "schway/host";
import { AppError } from "../../errors";
import { containsCredential } from "../../security/credentials";
import type { AttachmentSanitizerRuntime } from "../../attachments/sanitizer-runtime";

/** Closed original formats. The existing runtime's WebP path is intentionally not advertised. */
export type BinaryKind = "pdf" | "png" | "jpeg";
/** Independent original/decoded/derived bounds, not a monetary grant or an upstream default. */
export const binaryLimits = Object.freeze({ originalBytes: 1024 * 1024, textBytes: 65536, imageBytes: 1024 * 1024, pages: 50, pixels: 4194304, originalDimension: 16384, dimension: 2048, activeMs: 60000, queued: 4 });
/** Actual independently verified parser output. No parser-selected path or authority is accepted. */
export type ParsedFile = { kind: "pdf"; bytes: Uint8Array; mime: "text/plain"; pages: number; sha256: string }
  | { kind: "image"; bytes: Uint8Array; mime: "image/png" | "image/jpeg"; width: number; height: number; originalWidth: number; originalHeight: number; sha256: string };
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const invalid = (): never => { throw new AppError("file_validation_failed", 409); };
/** Header inspection only; complex decoding remains inside the disposable runtime. */
function dimensions(kind: "png" | "jpeg", bytes: Uint8Array): { width: number; height: number } {
  const b = Buffer.from(bytes); let width = 0, height = 0;
  if (kind === "png") { if (b.length < 33 || b.subarray(0, 8).toString("hex") !== "89504e470d0a1a0a" || b.toString("ascii", 12, 16) !== "IHDR") invalid(); width = b.readUInt32BE(16); height = b.readUInt32BE(20); }
  else { if (b.length < 4 || b[0] !== 255 || b[1] !== 216) invalid(); let at = 2;
    for (let n = 0; n < 512 && at + 4 <= b.length; n++) { if (b[at++] !== 255) invalid(); while (b[at] === 255) at++; const marker = b[at++]!; if (marker === 218 || marker === 217) break;
      if (at + 2 > b.length) invalid(); const length = b.readUInt16BE(at); if (length < 2 || at + length > b.length) invalid();
      if ([192, 193, 194].includes(marker)) { if (length < 8) invalid(); height = b.readUInt16BE(at + 3); width = b.readUInt16BE(at + 5); break; } at += length;
    }
  }
  if (!width || !height || width > binaryLimits.originalDimension || height > binaryLimits.originalDimension || width * height > binaryLimits.pixels) invalid();
  return { width, height };
}

/** Networkless disposable decoding, serialized under the owning FileStore installation lock. Only
 * generated snapshots are mounted. A cleanup failure preserves custody and fences every later job. */
export class FileParser {
  #tail: Promise<unknown> = Promise.resolve();
  #queued = 0;
  #closed = false;
  #active = new AbortController();
  #unsafe = new Set<string>();
  constructor(readonly runtime: AttachmentSanitizerRuntime, readonly directory: string, create: boolean) {
    if (runtime.s16?.contract !== "s16-isolated-file/v1" || !runtime.s16.generation || runtime.s16.generation.length > 512 || containsCredential(runtime.s16.generation)) throw new AppError("file_parser_required", 503);
    if (!isAbsolute(directory) || resolve(directory) !== directory) invalid();
    if (!lstatSync(directory, { throwIfNoEntry: false })) { if (!create) throw new AppError("file_continuity_unavailable", 503); mkdirSync(directory, { mode: 0o700 }); }
    const stat = lstatSync(directory); if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || realpathSync(directory) !== directory) invalid();
    const handle = opendirSync(directory);
    try { for (let n = 0; ; n++) { const row = handle.readSync(); if (!row) break; if (n >= 64 || !/^job-[A-Za-z0-9]+$/.test(row.name)) invalid(); const path = join(directory, row.name), s = lstatSync(path); if (!s.isDirectory() || s.isSymbolicLink()) invalid(); this.#unsafe.add(path); } } finally { handle.closeSync(); }
  }
  /** Availability is a runtime probe, never inferred from an installed executable or model claim. */
  async available(): Promise<boolean> { try { return !this.#closed && await this.runtime.available(); } catch { return false; } }
  /** Reconcile a prior process before exposing its installation. Uncertain cleanup retains snapshots. */
  async recover(): Promise<void> {
    if (this.#closed || this.#queued) throw new AppError("sanitizer_busy", 409);
    if (!this.#unsafe.size) return;
    if (!await this.available()) throw new AppError("sanitizer_cleanup_failed", 503);
    try { await this.runtime.reset(); } catch { throw new AppError("sanitizer_cleanup_failed", 503); }
    for (const path of this.#unsafe) rmSync(path, { recursive: true, force: true }); this.#unsafe.clear();
  }
  /** Finite serialized job. Cancellation while queued never starts a parser or affects its predecessor. */
  parse(kind: BinaryKind, original: Uint8Array, signal?: AbortSignal): Promise<ParsedFile> {
    if (this.#closed || this.#queued >= binaryLimits.queued) return Promise.reject(new AppError("sanitizer_busy", 409));
    if (!original.length || original.length > binaryLimits.originalBytes) return Promise.reject(new AppError("file_too_large", 413));
    const detached = new Uint8Array(original), deadline = AbortSignal.timeout(binaryLimits.activeMs), stop = AbortSignal.any([this.#active.signal, deadline, ...(signal ? [signal] : [])]);
    this.#queued++;
    const job = this.#tail.then(async () => {
      if (stop.aborted || this.#closed) throw new AppError("aborted");
      if (!await this.available()) throw new AppError("sanitizer_unavailable", 503);
      await this.runtime.reset();
      for (const path of this.#unsafe) rmSync(path, { recursive: true, force: true }); this.#unsafe.clear();
      if (stop.aborted) throw new AppError("aborted");
      const root = mkdtempSync(join(this.directory, "job-"));
      mkdirSync(join(root, "in"), { mode: 0o700 }); mkdirSync(join(root, "out"), { mode: 0o700 });
      writeFileSync(join(root, "in/input"), detached, { mode: 0o600, flag: "wx" });
      try {
        await this.runtime.run({ input: join(root, "in"), output: join(root, "out"), kind, pixels: binaryLimits.pixels }, stop);
        if (stop.aborted || this.#closed) throw new AppError("aborted");
        return this.outputs(join(root, "out"), kind, detached);
      } catch (error) {
        if (error instanceof Error && error.message === "sanitizer_cleanup_failed") { this.#unsafe.add(root); throw new AppError("sanitizer_cleanup_failed", 503); }
        if (error instanceof AppError) throw error;
        throw new AppError("file_validation_failed", 409);
      } finally { if (!this.#unsafe.has(root)) rmSync(root, { recursive: true, force: true }); }
    }).finally(() => { this.#queued--; });
    this.#tail = job.catch(() => {}); return job;
  }
  private read(path: string, cap: number): Uint8Array {
    const stat = lstatSync(path); if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.mode & 0o077 || stat.size > cap) invalid();
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try { if (fstatSync(fd).size !== stat.size) invalid(); const bytes = new Uint8Array(stat.size + 1); let length = 0;
      for (;;) { const n = readSync(fd, bytes, length, bytes.length - length, length); if (!n) break; length += n; if (length > stat.size) invalid(); }
      if (length !== stat.size) invalid(); return bytes.subarray(0, length);
    } finally { closeSync(fd); }
  }
  private outputs(directory: string, kind: BinaryKind, original: Uint8Array): ParsedFile {
    const names: string[] = [], dir = opendirSync(directory); try { for (let n = 0; ; n++) { const entry = dir.readSync(); if (!entry) break; if (n >= 3) invalid(); names.push(entry.name); } } finally { dir.closeSync(); }
    let result: Record<string, unknown>;
    try { result = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(this.read(join(directory, "result.json"), 2048))); } catch { return invalid(); }
    if (!result || typeof result !== "object" || result.ok !== true || result.truncated !== false || result.validation !== "s16-isolated-file/v1") throw new AppError("file_extraction_incomplete", 409);
    if (kind === "pdf") {
      if (names.sort().join() !== "result.json,text.txt" || result.encrypted !== false || !Number.isSafeInteger(result.pages) || Number(result.pages) < 1 || Number(result.pages) > binaryLimits.pages) invalid();
      const bytes = this.read(join(directory, "text.txt"), binaryLimits.textBytes); let text: string;
      try { text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { return invalid(); }
      if (!text.trim() || /[\u0000-\u0008\u000b\u000e-\u001f\u007f]/u.test(text) || containsCredential(text)) invalid();
      return { kind: "pdf", bytes, mime: "text/plain", pages: Number(result.pages), sha256: hash(bytes) };
    }
    const mime = kind === "png" ? "image/png" : "image/jpeg", ext = kind === "png" ? "png" : "jpg";
    if (names.sort().join() !== `clean.${ext},model.${ext},result.json`) invalid();
    const source = dimensions(kind, original);
    const clean = dimensions(kind, this.read(join(directory, `clean.${ext}`), binaryLimits.imageBytes));
    const bytes = this.read(join(directory, `model.${ext}`), binaryLimits.imageBytes), model = createImageContent("model", mime, bytes);
    if (source.width !== result.width || source.height !== result.height || clean.width !== source.width || clean.height !== source.height || model.width > source.width || model.height > source.height) invalid();
    return { kind: "image", bytes, mime, width: model.width, height: model.height, originalWidth: source.width, originalHeight: source.height, sha256: hash(bytes) };
  }
  /** Fence admission and settle active/queued jobs before the owning protected stores close. */
  async close(): Promise<void> { this.#closed = true; this.#active.abort(); await this.#tail; }
}
