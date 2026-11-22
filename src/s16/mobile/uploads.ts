import type { FileUpload } from "../files/types";
import { checkMobileIntent, mobileIntent, type MobileDrafts, type MobileFileChip, type MobileIntent } from "./drafts";
import type { MobileSession } from "./session";

/** Safe local upload diagnostic. No file bytes, native URI or credential enters the error. */
export class MobileUploadError extends Error { constructor(readonly code: string) { super(code); this.name = "MobileUploadError"; } }
const fail = (code: string): never => { throw new MobileUploadError(code); };
const hash = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
const code = (error: unknown) => error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(error.code) ? error.code : "mobile_file_unavailable";

/**
 * Original upload continuity over the actual shared client. Only immutable metadata is retained in drafts.
 * Check is read-only, including a lost create reply with no upload ID. A known empty creation requires a
 * new explicit OS selection of the same name/size/hash before bytes are sent to that original ID.
 * No offline byte cache, automatic retry, replacement creation, message send or work admission exists.
 */
export class MobileUploads {
  readonly #busy = new Set<string>();
  constructor(readonly session: MobileSession, readonly drafts: MobileDrafts) {}
  #input(intent: MobileIntent, name: string, bytes: Uint8Array, replacing?: string): Uint8Array<ArrayBuffer> {
    checkMobileIntent(intent);
    const capability = this.session.projection.bootstrap!.capabilities.uploads;
    if (!capability.available || typeof name !== "string" || !name.isWellFormed() || !name || name.length > 512 || !(bytes instanceof Uint8Array)) return fail("mobile_file_unavailable");
    const extension = name.split(".").at(-1)!.toLowerCase(), limit = capability.formats?.find(format => format.extension === extension)?.bytes ?? capability.limits.fileBytes;
    const others = this.drafts.get(intent.scope, intent.conversationId).files.filter(chip => chip.requestId !== replacing);
    if (!capability.extensions.includes(extension) || !Number.isSafeInteger(limit) || limit < 1 || limit > 32 * 1048576 || bytes.length < 1 || bytes.length > limit || others.length >= capability.limits.messageFiles || others.reduce((sum, chip) => sum + chip.bytes, bytes.length) > capability.limits.messageBytes) return fail("mobile_file_limit");
    return new Uint8Array(bytes);
  }
  #current(intent: MobileIntent, chip: MobileFileChip): void {
    checkMobileIntent(intent);
    const current = this.drafts.get(intent.scope, intent.conversationId).files.find(value => value.requestId === chip.requestId);
    if (!current || current.name !== chip.name || current.bytes !== chip.bytes || current.sha256 !== chip.sha256 || current.uploadId !== chip.uploadId) fail("mobile_upload_scope_invalid");
  }
  #change(intent: MobileIntent, chip: MobileFileChip, update: Partial<MobileFileChip>): MobileFileChip {
    this.#current(intent, chip); const next = Object.freeze({ ...chip, ...update });
    this.drafts.change(intent, current => ({ ...current, files: current.files.map(value => value.requestId === chip.requestId ? next : value) })); return next;
  }
  #verify(intent: MobileIntent, chip: MobileFileChip, upload: FileUpload): void {
    this.#current(intent, chip);
    if (upload.requestId !== chip.requestId || upload.conversationId !== intent.conversationId || upload.expectedBytes !== chip.bytes || upload.expectedHash !== chip.sha256 || chip.uploadId !== null && upload.id !== chip.uploadId) fail("mobile_upload_scope_invalid");
  }
  #state(upload: FileUpload): Pick<MobileFileChip, "phase" | "receipt" | "code"> {
    if (upload.state === "created") return { phase: "failed", receipt: null, code: "mobile_upload_select_again" };
    return { phase: upload.state === "ready" && upload.receipt ? "ready" : ["uploading", "validating"].includes(upload.state) ? "validating" : "failed", receipt: upload.state === "ready" ? upload.receipt : null, code: upload.code };
  }
  async #operation<T>(requestId: string, run: () => Promise<T>): Promise<T> {
    if (this.#busy.has(requestId)) return fail("mobile_file_busy");
    this.#busy.add(requestId); try { return await run(); } finally { this.#busy.delete(requestId); }
  }
  async #read(intent: MobileIntent, chip: MobileFileChip): Promise<FileUpload> {
    this.#current(intent, chip);
    const capability = this.session.projection.bootstrap!.capabilities.uploads;
    if (!chip.uploadId && (!capability.available || capability.creationLookup !== "s16-upload-creation/v1")) return fail("mobile_upload_recovery_unavailable");
    const upload = await this.session.perform((client, signal) => chip.uploadId ? client.uploadStatus(chip.uploadId, signal) : client.uploadCreation(intent.conversationId, chip.requestId, signal));
    this.#verify(intent, chip, upload); return upload;
  }
  async #write(intent: MobileIntent, chip: MobileFileChip, upload: FileUpload, bytes: Uint8Array<ArrayBuffer>): Promise<MobileFileChip> {
    this.#verify(intent, chip, upload);
    if (upload.state !== "created" || upload.bytes !== 0) return fail("mobile_upload_not_created");
    chip = this.#change(intent, chip, { uploadId: upload.id, phase: "uploading", code: null });
    try {
      const result = await this.session.perform((client, signal) => client.uploadBytes(upload.id, bytes, signal));
      this.#verify(intent, chip, result); return this.#change(intent, chip, this.#state(result));
    } catch (error) { try { this.#change(intent, chip, { phase: "failed", code: code(error) }); } catch { /* A fenced draft retains the original identity for a fresh Check. */ } throw error; }
  }
  /** One explicit native file selection prepares one immutable creation; bytes are sent at most once. */
  async begin(intent: MobileIntent, file: { name: string; bytes: Uint8Array }): Promise<MobileFileChip> {
    const name = file.name, bytes = this.#input(intent, name, file.bytes), sha256 = await hash(bytes); checkMobileIntent(intent);
    this.#input(intent, name, bytes);
    let chip: MobileFileChip = Object.freeze({ requestId: crypto.randomUUID().replaceAll("-", ""), name, bytes: bytes.length, sha256, uploadId: null, phase: "uploading", receipt: null, code: null });
    this.drafts.change(intent, current => ({ ...current, files: [...current.files, chip] }));
    return this.#operation(chip.requestId, async () => {
      try {
        const upload = await this.session.perform((client, signal) => client.createUpload({ requestId: chip.requestId, conversationId: intent.conversationId, name: chip.name, bytes: chip.bytes, sha256: chip.sha256 }, signal));
        return await this.#write(intent, chip, upload, bytes);
      } catch (error) { try { chip = this.#change(intent, chip, { phase: "failed", code: code(error) }); } catch { /* No private update after lifecycle/authentication fencing. */ } throw error; }
    });
  }
  /** Read only the original metadata/bytes outcome; a known empty creation never resumes automatically. */
  async check(chip: MobileFileChip): Promise<MobileFileChip> {
    const intent = mobileIntent(this.session);
    return this.#operation(chip.requestId, async () => { const upload = await this.#read(intent, chip); return this.#change(intent, chip, { uploadId: upload.id, ...this.#state(upload) }); });
  }
  /** A new owner OS gesture selects exactly the original bytes; only a fresh known empty creation is writable. */
  async resume(intent: MobileIntent, chip: MobileFileChip, file: { name: string; bytes: Uint8Array }): Promise<MobileFileChip> {
    this.#current(intent, chip);
    const name = file.name, bytes = this.#input(intent, name, file.bytes, chip.requestId), sha256 = await hash(bytes); this.#current(intent, chip);
    if (name !== chip.name || bytes.length !== chip.bytes || sha256 !== chip.sha256) return fail("mobile_upload_bytes_changed");
    return this.#operation(chip.requestId, async () => this.#write(intent, chip, await this.#read(intent, chip), bytes));
  }
}
