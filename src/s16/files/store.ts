import { createImageContent, type ImageContent } from "schway/host";
import { FileParser, type BinaryKind } from "./parser";
import type { AttachmentSanitizerRuntime } from "../../attachments/sanitizer-runtime";
import { createHash } from "node:crypto";
import { closeSync, constants, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { AppError } from "../../errors";
import { attachmentDisplayName, AttachmentSniffer } from "../../attachments/types";
import { containsCredential } from "../../security/credentials";
import { DurableJournal } from "../../s15/durable-journal";
import { canonical, digest, exact, identity, integer } from "../../s15/conversation/validation";
import { defaultFileLimits, type FileArtifact, type FileLimits, type FileOwner, type FileReceipt, type FileReference, type FileUpload, type FileUploadCommand } from "./types";
import type { Ref } from "../../s15/policy";
import { ref as validateRef } from "../../s15/policy/validation";
import type { DisclosureSource } from "../../s15/disclosure";
import { filePins, type FileSourcePin } from "../../s15/file-lineage";

interface UploadRecord extends FileUpload { kind: "upload"; owner: FileOwner; resource: Ref }
interface ArtifactRecord extends FileArtifact { kind: "artifact"; owner: FileOwner; inputs: FileReference[] }
/** Protected storage composition. Work/resource/disclosure authorization stays with the owning adapter. */
export interface FileStoreOptions<Actor> {
  path: string; directory: string; installationId: string; create: boolean;
  requireOwner(actor: Actor): FileOwner;
  resource: Ref;
  parserRuntime?: AttachmentSanitizerRuntime;
  limits?: FileLimits; now?: () => number;
}
const hash = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const sha = (value: unknown): value is string => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const textExtensions = new Set(["txt", "md", "markdown", "csv", "tsv"]);

/**
 * Immutable private byte custody with a separate protected journal. No source is executable and no
 * model receives a storage path. It supplies storage/lifecycle, not work, recipient or effect authority.
 */
export class FileStore<Actor> {
  readonly journal: DurableJournal;
  readonly limits: FileLimits;
  readonly now: () => number;
  readonly directory: string;
  readonly parser: FileParser | undefined;
  #closed = false;
  #closing: Promise<void> | null = null;
  #cancellations = new Map<string, AbortController>();
  #writes = new Set<Promise<FileUpload>>();
  constructor(readonly options: FileStoreOptions<Actor>) {
    if (!isAbsolute(options.directory) || resolve(options.directory) !== options.directory) throw new AppError("protected_file_path_required");
    validateRef(options.resource);
    this.limits = { ...(options.limits ?? (options.parserRuntime ? { ...defaultFileLimits, fileBytes: 1024 * 1024, messageBytes: 4 * 1024 * 1024, totalBytes: 64 * 1024 * 1024 } : defaultFileLimits)) }; this.now = options.now ?? Date.now;
    integer(this.limits.fileBytes, 1, 1024 * 1024); integer(this.limits.messageFiles, 1, 8); integer(this.limits.messageBytes, this.limits.fileBytes, 4 * 1024 * 1024); integer(this.limits.totalBytes, this.limits.messageBytes, 1024 * 1024 * 1024); integer(this.limits.uploadLifetimeMs, 60000, 7 * 24 * 60 * 60 * 1000);
    const existed = existsSync(options.directory);
    if (!existed && !options.create) throw new AppError("file_continuity_unavailable", 503);
    if (!existed) mkdirSync(options.directory, { mode: 0o700 });
    const stat = lstatSync(options.directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077 || realpathSync(options.directory) !== options.directory) throw new AppError("unprotected_file_store");
    this.directory = options.directory;
    this.journal = new DurableJournal(options.path, options.installationId, options.create, 0x4a495446, undefined, [1, 2]);
    const history = this.records().some(row => row.kind === "upload" && (row.receipt?.contract === "s16-file-receipt/v2" || /\.(pdf|png|jpe?g)$/i.test(row.name)));
    if (history && !options.parserRuntime) { this.journal.close(); throw new AppError("file_parser_required", 503); }
    try { this.parser = options.parserRuntime ? new FileParser(options.parserRuntime, join(this.directory, "..", "file-parser"), options.create || !history) : undefined; } catch (error) { this.journal.close(); throw error; }
    // A partial upload is not replay-safe after process loss. Keep identity, reject it and retire bytes.
    for (const row of this.records()) if (row.kind === "upload" && ["uploading", "validating"].includes(row.state)) {
      this.journal.tx(() => { row.state = "rejected"; row.code = "upload_interrupted"; this.journal.put(row.id, row); });
      rmSync(this.path(row.id, true), { force: true });
      rmSync(this.path(row.id), { force: true }); rmSync(this.path(row.id) + ".derived", { force: true });
    }
  }
  private records(): (UploadRecord | ArtifactRecord)[] { return this.journal.all<UploadRecord | ArtifactRecord>(); }
  private current(actor: Actor): FileOwner {
    if (this.#closed) throw new AppError("service_closed", 503);
    const owner = this.options.requireOwner(actor); identity(owner.id); integer(owner.generation, 1); return owner;
  }
  private owner(actor: Actor, record: { owner: FileOwner }): void {
    const owner = this.current(actor);
    if (owner.id !== record.owner.id || owner.generation !== record.owner.generation) throw new AppError("authentication_required", 401);
  }
  private path(id: string, temporary = false): string { identity(id); return join(this.directory, `${id}${temporary ? ".part" : ".blob"}`); }
  private syncDirectory(): void { const fd = openSync(this.directory, constants.O_RDONLY); try { fsyncSync(fd); } finally { closeSync(fd); } }
  private upload(id: string): UploadRecord {
    identity(id); const value = this.journal.get<UploadRecord>(id);
    if (value.kind !== "upload") throw new AppError("file_not_found", 404); return value;
  }
  private publicUpload(record: UploadRecord): FileUpload { const { kind: _kind, owner: _owner, resource: _resource, ...view } = record; return structuredClone(view); }
  private capacity(additional: number): void {
    for (const row of this.records()) if (row.kind === "upload" && !row.retained && this.now() >= row.expiresAt && ["created", "uploading", "validating", "ready"].includes(row.state)) {
      row.state = "expired"; row.code = "upload_expired"; this.journal.put(row.id, row);
      this.#cancellations.get(row.id)?.abort(); rmSync(this.path(row.id, true), { force: true }); rmSync(this.path(row.id), { force: true }); rmSync(this.path(row.id) + ".derived", { force: true });
    }
    // Include complete reservations for open streams. Interrupted/rejected/cancelled bytes release space.
    const used = this.records().reduce((sum, row) => sum + (row.kind === "artifact" ? row.bytes : ["created", "uploading", "validating", "ready"].includes(row.state) ? (row.expectedBytes + (row.receipt?.contract === "s16-file-receipt/v2" ? row.receipt.representation.bytes : 0)) : 0), 0);
    if (used + additional > this.limits.totalBytes) throw new AppError("file_capacity", 409);
  }
  /** Commits exact upload metadata once; no bytes or execution are accepted by this operation. */
  create(actor: Actor, input: FileUploadCommand): FileUpload {
    this.current(actor); exact(input, ["requestId", "conversationId", "name", "bytes", "sha256"]); identity(input.requestId); identity(input.conversationId);
    integer(input.bytes, 1, this.limits.fileBytes);
    if (!sha(input.sha256) || typeof input.name !== "string" || containsCredential(input.name)) throw new AppError("invalid_file_metadata");
    const name = attachmentDisplayName(encodeURIComponent(input.name));
    if (this.parser && textExtensions.has(name.split(".").at(-1)!.toLowerCase()) && input.bytes > defaultFileLimits.fileBytes) throw new AppError("file_too_large", 413);
    if (!textExtensions.has(name.split(".").at(-1)!.toLowerCase()) && !(this.parser && /\.(pdf|png|jpe?g)$/i.test(name))) throw new AppError("file_type_unavailable", 415);
    return this.journal.tx(() => {
      const owner = this.current(actor), fingerprint = digest(canonical({ owner, input }));
      const created = this.journal.once(`create_${input.requestId}`, fingerprint, () => {
        this.capacity(input.bytes);
        // Fence old text-only file readers even before the first binary CHAT ingress.
        if (/\.(pdf|png|jpe?g)$/i.test(name)) this.journal.db.exec("PRAGMA user_version=2");
        const id = `file_${crypto.randomUUID().replaceAll("-", "")}`, at = this.now();
        const row: UploadRecord = { kind: "upload", resource: structuredClone(this.options.resource), contract: "s16-file-upload/v1", owner, id, requestId: input.requestId, conversationId: input.conversationId, name, expectedBytes: input.bytes, expectedHash: input.sha256, bytes: 0, state: "created", code: null, createdAt: at, expiresAt: at + this.limits.uploadLifetimeMs, retained: false, receipt: null };
        this.journal.put(id, row); return { id };
      });
      return this.status(actor, created.id);
    });
  }
  /** Current owner-scoped lifecycle. Expiry narrows availability; it never creates or restarts work. */
  status(actor: Actor, id: string): FileUpload {
    let row = this.upload(id); this.owner(actor, row);
    if (!row.retained && this.now() >= row.expiresAt && ["created", "uploading", "validating", "ready"].includes(row.state)) {
      this.journal.tx(() => { row = this.upload(id); row.state = "expired"; row.code = "upload_expired"; this.journal.put(id, row); });
      this.#cancellations.get(id)?.abort(); rmSync(this.path(id, true), { force: true }); rmSync(this.path(id), { force: true }); rmSync(this.path(id) + ".derived", { force: true });
    }
    return this.publicUpload(row);
  }
  /** Stream once into private quarantine, verify actual type/hash/UTF-8/size, then publish immutable input. */
  write(actor: Actor, id: string, stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<FileUpload> {
    const writing = this.writeStream(actor, id, stream, signal); this.#writes.add(writing);
    void writing.then(() => { this.#writes.delete(writing); }, () => { this.#writes.delete(writing); });
    return writing;
  }
  private async writeStream(actor: Actor, id: string, stream: ReadableStream<Uint8Array>, signal?: AbortSignal): Promise<FileUpload> {
    const initial = this.status(actor, id);
    if (initial.state === "ready") return initial;
    if (initial.state !== "created") throw new AppError(initial.code ?? "upload_not_writable", 409);
    if (signal?.aborted) throw new AppError("aborted");
    if (stream.locked) throw new AppError("invalid_file_stream");
    this.journal.tx(() => { const row = this.upload(id); this.owner(actor, row); if (row.state !== "created") throw new AppError("upload_not_writable", 409); row.state = "uploading"; this.journal.put(id, row); });
    const reader = stream.getReader(), sniffer = new AttachmentSniffer(), digest = createHash("sha256");
    const abort = () => { void reader.cancel().catch(() => {}); };
    const local = new AbortController(); this.#cancellations.set(id, local);
    const deadline = AbortSignal.timeout(this.parser ? 60000 : 30000), stop = AbortSignal.any([deadline, local.signal, ...(signal ? [signal] : [])]); stop.addEventListener("abort", abort, { once: true });
    let fd: number | undefined, bytes = 0;
    try {
      fd = openSync(this.path(id, true), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      for (;;) {
        if (stop.aborted) throw new AppError(signal?.aborted || local.signal.aborted ? "aborted" : "upload_timeout", 408);
        const chunk = await reader.read();
        const current = this.status(actor, id); if (current.state !== "uploading") throw new AppError(current.code ?? "upload_not_writable", 409);
        if (chunk.done) break;
        bytes += chunk.value.length;
        if (bytes > initial.expectedBytes || bytes > this.limits.fileBytes) throw new AppError("file_too_large", 413);
        sniffer.push(chunk.value); digest.update(chunk.value);
        let offset = 0; while (offset < chunk.value.length) offset += writeSync(fd, chunk.value, offset, chunk.value.length - offset);
      }
      if (stop.aborted) throw new AppError(signal?.aborted || local.signal.aborted ? "aborted" : "upload_timeout", 408);
      const detected = sniffer.finish(initial.name);
      if (detected.kind !== "text" && !this.parser) throw new AppError("file_type_unavailable", 415);
      if (bytes !== initial.expectedBytes || digest.digest("hex") !== initial.expectedHash) throw new AppError("file_content_changed", 409);
      fsyncSync(fd); closeSync(fd); fd = undefined;
      const original = this.readPath(this.path(id, true), bytes);
      let parsed: import("./parser").ParsedFile | undefined;
      if (detected.kind === "text") { if (containsCredential(new TextDecoder("utf-8", { fatal: true }).decode(original))) throw new AppError("credential_content_refused", 403); }
      else {
        const kind: BinaryKind = detected.kind === "pdf" ? "pdf" : detected.mediaType === "image/png" ? "png" : "jpeg";
        this.journal.tx(() => { const row = this.upload(id); this.owner(actor, row); if (row.state !== "uploading") throw new AppError("file_unavailable"); row.state = "validating"; row.bytes = bytes; this.journal.put(id, row); });
        parsed = await this.parser!.parse(kind, original, stop);
      }
      return this.journal.tx(() => {
        const row = this.upload(id); this.owner(actor, row);
        if (!["uploading", "validating"].includes(row.state) || this.now() >= row.expiresAt) throw new AppError("upload_not_writable", 409);
        if (parsed) { this.capacity(parsed.bytes.length); writeFileSync(this.path(id) + ".derived", parsed.bytes, { mode: 0o600, flag: "wx" }); const output = openSync(this.path(id) + ".derived", constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(output); } finally { closeSync(output); } }
        renameSync(this.path(id, true), this.path(id));
        this.syncDirectory();
        row.state = "ready"; row.bytes = bytes;
        row.receipt = { contract: "s16-file-receipt/v1", id, sha256: row.expectedHash, conversationId: row.conversationId, name: row.name, mime: "text/plain", bytes, expiresAt: row.expiresAt };
        if (parsed) row.receipt = { ...row.receipt, contract: "s16-file-receipt/v2", mime: detected.kind === "pdf" ? "application/pdf" : parsed.mime as "image/png" | "image/jpeg", validation: "s16-isolated-file/v1", parserGeneration: this.parser!.runtime.s16!.generation, representation: { sha256: parsed.sha256, bytes: parsed.bytes.length, mime: parsed.mime, pages: parsed.kind === "pdf" ? parsed.pages : null, width: parsed.kind === "image" ? parsed.width : null, height: parsed.kind === "image" ? parsed.height : null, originalWidth: parsed.kind === "image" ? parsed.originalWidth : null, originalHeight: parsed.kind === "image" ? parsed.originalHeight : null } };
        this.journal.put(id, row); return this.publicUpload(row);
      });
    } catch (error) {
      if (fd !== undefined) closeSync(fd);
      await reader.cancel().catch(() => {});
      this.journal.tx(() => { const row = this.upload(id); if (["uploading", "validating"].includes(row.state)) { row.state = "rejected"; row.code = error instanceof AppError ? error.code : "file_validation_failed"; this.journal.put(id, row); } });
      rmSync(this.path(id, true), { force: true });
      // A failed journal commit may leave published bytes, but no ready receipt: remove that orphan.
      if (this.upload(id).state !== "ready") { rmSync(this.path(id), { force: true }); rmSync(this.path(id) + ".derived", { force: true }); }
      throw error;
    } finally { this.#cancellations.delete(id); stop.removeEventListener("abort", abort); reader.releaseLock(); }
  }
  private readPath(path: string, expectedBytes: number): Uint8Array {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== expectedBytes || stat.mode & 0o077) throw new AppError("file_integrity_failed", 409);
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      if (fstatSync(fd).size !== expectedBytes) throw new AppError("file_integrity_failed", 409);
      const bytes = new Uint8Array(expectedBytes + 1); let offset = 0;
      for (;;) { const length = readSync(fd, bytes, offset, bytes.length - offset, offset); if (!length) break; offset += length; if (offset > expectedBytes) throw new AppError("file_integrity_failed", 409); }
      if (offset !== expectedBytes) throw new AppError("file_integrity_failed", 409);
      return bytes.subarray(0, offset);
    } finally { closeSync(fd); }
  }
  /** Resolve exact selected input bytes only; callers still supply owning work/disclosure/lineage guards. */
  read(actor: Actor, conversationId: string, reference: FileReference): { receipt: FileReceipt; text: string } {
    exact(reference, ["id", "sha256"]); identity(conversationId);
    const upload = this.status(actor, reference.id);
    if (upload.state !== "ready" || !upload.receipt || upload.conversationId !== conversationId || upload.expectedHash !== reference.sha256) throw new AppError("file_unavailable", 409);
    const bytes = this.readPath(this.path(upload.id), upload.bytes);
    if (hash(bytes) !== reference.sha256) throw new AppError("file_integrity_failed", 409);
    if (upload.receipt.contract === "s16-file-receipt/v2") { const derived = this.readPath(this.path(upload.id) + ".derived", upload.receipt.representation.bytes); if (hash(derived) !== upload.receipt.representation.sha256) throw new AppError("file_integrity_failed", 409); return { receipt: upload.receipt, text: upload.receipt.representation.mime === "text/plain" ? new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(derived) : "" }; }
    return { receipt: upload.receipt, text: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes) };
  }
  /** Current sanitized image bytes for the trusted Schway resolver; never raw original bytes. */
  image(actor: Actor, conversationId: string, reference: FileReference): { content: ImageContent; bytes: Uint8Array } {
    const { receipt } = this.read(actor, conversationId, reference);
    if (receipt.contract !== "s16-file-receipt/v2" || receipt.representation.mime === "text/plain") throw new AppError("file_image_unavailable");
    const bytes = this.readPath(this.path(receipt.id) + ".derived", receipt.representation.bytes);
    const image = createImageContent(receipt.id, receipt.representation.mime, bytes);
    if (image.sha256 !== receipt.representation.sha256 || image.width !== receipt.representation.width || image.height !== receipt.representation.height) throw new AppError("file_integrity_failed", 409);
    return { content: image, bytes };
  }
  /** Owner cancellation/withdrawal is monotonic. It never revives a cancelled transfer or refunds effects. */
  withdraw(actor: Actor, id: string): FileUpload {
    const result = this.journal.tx(() => { const row = this.upload(id); this.owner(actor, row); if (["withdrawn", "cancelled", "expired", "rejected"].includes(row.state)) return this.publicUpload(row); row.state = row.state === "ready" ? "withdrawn" : "cancelled"; row.code = row.state === "withdrawn" ? "file_withdrawn" : "upload_cancelled"; this.journal.put(id, row); return this.publicUpload(row); });
    this.#cancellations.get(id)?.abort();
    rmSync(this.path(id, true), { force: true }); rmSync(this.path(id), { force: true }); rmSync(this.path(id) + ".derived", { force: true }); return result;
  }
  /** Selected references are validated as one bounded set before work admission; no file is silently omitted. */
  inputs(actor: Actor, conversationId: string, references: readonly FileReference[]): { receipt: FileReceipt; text: string }[] {
    if (!Array.isArray(references) || !references.length || references.length > this.limits.messageFiles || new Set(references.map(r => r.id)).size !== references.length) throw new AppError("file_count_limit");
    const inputs = references.map(ref => this.read(actor, conversationId, ref));
    if (inputs.reduce((sum, file) => sum + file.receipt.bytes, 0) > this.limits.messageBytes) throw new AppError("file_message_limit", 413);
    return inputs;
  }
  /** Retain selected inputs for a committed message/work lineage; staging expiry no longer erases deliverables. */
  retain(actor: Actor, conversationId: string, references: readonly FileReference[]): void {
    this.inputs(actor, conversationId, references);
    this.journal.tx(() => { for (const ref of references) { const row = this.upload(ref.id); this.owner(actor, row); row.retained = true; row.receipt!.expiresAt = null; this.journal.put(row.id, row); } });
  }
  /** Internal artifact staging: publication/download must additionally check the committed CHAT association. */
  stageArtifact(actor: Actor, input: { id: string; requestId: string; workId: string; conversationId: string; name: string; text: string; inputs: FileReference[] }): FileArtifact {
    this.current(actor); identity(input.id); identity(input.requestId); identity(input.workId); identity(input.conversationId);
    const { name, mime, bytes } = this.validateArtifact(input);
    this.inputs(actor, input.conversationId, input.inputs);
    let created: string | undefined;
    try { return this.journal.tx(() => {
      const owner = this.current(actor), fingerprint = digest(canonical({ owner, input }));
      const saved = this.journal.once(`artifact_${input.id}`, fingerprint, () => {
        this.retain(actor, input.conversationId, input.inputs);
        this.capacity(bytes.length);
        const id = `artifact_${crypto.randomUUID().replaceAll("-", "")}`;
        created = id;
        writeFileSync(this.path(id), bytes, { mode: 0o600, flag: "wx" });
        const fd = openSync(this.path(id), constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); }
        this.syncDirectory();
        const row: ArtifactRecord = { kind: "artifact", contract: "s16-file-artifact/v1", owner, id, sha256: hash(bytes), requestId: input.requestId, workId: input.workId, conversationId: input.conversationId, name, mime, bytes: bytes.length, createdAt: this.now(), inputs: structuredClone(input.inputs) };
        try { this.journal.put(id, row); } catch (error) { rmSync(this.path(id), { force: true }); throw error; }
        return row;
      });
      this.owner(actor, saved);
      const { kind: _kind, owner: _owner, inputs: _inputs, ...view } = saved; return view;
    }); } catch (error) { if (created) rmSync(this.path(created), { force: true }); throw error; }
  }
  /** Pure local format/bound check before an adapter claim. It grants no work or publication authority. */
  validateArtifact(input: { name: string; text: string }): { name: string; mime: FileArtifact["mime"]; bytes: Uint8Array } {
    if (typeof input.name !== "string" || containsCredential(input.name)) throw new AppError("artifact_content_refused");
    const name = attachmentDisplayName(encodeURIComponent(input.name));
    const ext = name.split(".").at(-1)!.toLowerCase(), mime = ext === "md" || ext === "markdown" ? "text/markdown" : ext === "csv" ? "text/csv" : ext === "txt" ? "text/plain" : null;
    if (!mime || typeof input.text !== "string" || !input.text.isWellFormed() || containsCredential(input.text)) throw new AppError("artifact_content_refused");
    const bytes = new TextEncoder().encode(input.text); integer(bytes.length, 1, this.limits.fileBytes);
    const sniffer = new AttachmentSniffer(); sniffer.push(bytes); if (sniffer.finish(name).kind !== "text") throw new AppError("artifact_content_refused");
    return { name, mime, bytes };
  }
  /** Protected source catalog only. The immutable resource generation is pinned at upload creation. */
  source(id: string): DisclosureSource | null {
    let row: UploadRecord | ArtifactRecord; try { row = this.journal.get(id); } catch { return null; }
    if (!row || row.kind !== "upload") return null;
    return { ref: { id: row.id, revision: 1, generation: row.owner.generation }, resource: structuredClone(row.resource), classification: "private", ownerReleasable: true, active: row.state === "ready" && (row.retained || this.now() < row.expiresAt) };
  }
  /** Owner-scoped metadata anchor; it contains no private bytes, path or reusable principal. */
  pin(actor: Actor, id: string): FileSourcePin {
    const status = this.status(actor, id), row = this.upload(id);
    if (status.state !== "ready" || !status.receipt) throw new AppError("lineage_withdrawn", 409);
    return { contract: "s16-file-source/v1", source: this.source(id)!.ref, resource: structuredClone(row.resource), sha256: status.receipt.sha256, representationSha256: status.receipt.contract === "s16-file-receipt/v2" ? status.receipt.representation.sha256 : null };
  }
  /** Protected metadata query for filtering/ranking/tombstone UI; never a byte-release permit. */
  pinsCurrent(input: readonly FileSourcePin[]): boolean {
    if (this.#closed) return false;
    try { return filePins(input).every(pin => { const row = this.upload(pin.source.id), source = this.source(pin.source.id); return !!source?.active && canonical(source.ref) === canonical(pin.source) && canonical(row.resource) === canonical(pin.resource) && row.expectedHash === pin.sha256 && (row.receipt?.contract === "s16-file-receipt/v2" ? row.receipt.representation.sha256 : null) === pin.representationSha256; }); } catch { return false; }
  }
  /** Final selected original/derived byte verification under the caller's current protected owner/work. */
  verifyPins(actor: Actor, input: readonly FileSourcePin[]): void {
    const pins = filePins(input); if (!this.pinsCurrent(pins)) throw new AppError("lineage_withdrawn", 409);
    for (const pin of pins) { const row = this.upload(pin.source.id); this.read(actor, row.conversationId, { id: row.id, sha256: pin.sha256 }); }
  }
  /** Internal candidates only. A client library/download must additionally verify committed CHAT references. */
  candidates(actor: Actor, requestId: string, workId: string): FileArtifact[] {
    this.current(actor);
    return this.records().flatMap(row => { if (row.kind !== "artifact" || row.requestId !== requestId || row.workId !== workId) return []; this.owner(actor, row); const { kind: _kind, owner: _owner, inputs: _inputs, ...view } = row; return [view]; });
  }
  /** Internal exact artifact read; caller must first verify the current producer and committed result reference. */
  artifact(actor: Actor, id: string): { artifact: FileArtifact; bytes: Uint8Array; inputs: FileReference[] } {
    identity(id); const row = this.journal.get<ArtifactRecord>(id); this.owner(actor, row);
    if (row.kind !== "artifact") throw new AppError("file_not_found", 404);
    this.inputs(actor, row.conversationId, row.inputs);
    const bytes = this.readPath(this.path(id), row.bytes); if (hash(bytes) !== row.sha256) throw new AppError("file_integrity_failed", 409);
    const { kind: _kind, owner: _owner, inputs, ...artifact } = row; return { artifact, bytes, inputs };
  }
  /** Fence admission, cancel active byte readers and settle them before closing protected continuity. */
  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    this.#closed = true; for (const stop of this.#cancellations.values()) stop.abort();
    return this.#closing = (async () => { await Promise.allSettled([...this.#writes]); await this.parser?.close(); this.journal.close(); })();
  }
}
