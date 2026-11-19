import * as DocumentPicker from "expo-document-picker";
import { Platform } from "react-native";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import Gate from "../modules/jit-native-gate";
import Export from "../modules/jit-native-gate/export";
import { checkMobileIntent, mobileIntent, MobileIntentError, type MobileDrafts, type MobileFileChip, type MobileIntent } from "../../../src/s16/mobile/drafts";
import type { MobileSession } from "../../../src/s16/mobile/session";
import type { FileArtifact, FileUpload } from "../../../src/s16/files/types";

/** Wait for the owner's OS sheet to release the app. No timer or lifecycle event submits work. */
export async function nativeActive(): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let finished = false, epoch = 0;
    const end = (error?: Error) => { if (finished) return; finished = true; clearTimeout(timer); subscription.remove(); error ? reject(error) : resolve(); };
    const receive = (value: { epoch: number; active: boolean }) => { if (value.epoch < epoch) return; epoch = value.epoch; if (value.active) end(); };
    const subscription = Gate.addListener("lifecycle", receive), timer = setTimeout(() => end(new Error("mobile_native_inactive")), 30000);
    void Gate.status().then(receive, () => end(new Error("mobile_lifecycle_unavailable")));
  });
}
const code = (error: unknown) => error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[a-z][a-z0-9_]{0,127}$/.test(error.code) ? error.code : "mobile_file_unavailable";
function cached(uri: string): File | null {
  try {
    const url = new URL(uri), directory = new URL(new Directory(Paths.cache, "DocumentPicker").uri.replace(/\/+$/, "") + "/");
    return url.protocol === "file:" && !url.host && !url.search && !url.hash && url.pathname.startsWith(directory.pathname) && !url.pathname.slice(directory.pathname.length).includes("/") ? new File(url.href) : null;
  } catch { return null; }
}
/** Clear only app-owned picker staging left by a killed process; never touches a selected original or an export. */
export function clearPickerStaging(): void {
  const directory = new Directory(Paths.cache, "DocumentPicker");
  if (!directory.exists) return;
  for (const entry of directory.list()) if (entry instanceof File && cached(entry.uri)) entry.delete();
}
/** Actual native picker and bounded upload path. Selection/permission sheets may remount the private React root. */
export class NativeFiles {
  #picking = false;
  constructor(readonly session: MobileSession, readonly drafts: MobileDrafts) {}
  async #revalidate(intent: MobileIntent): Promise<void> { await nativeActive(); await this.session.restore(); checkMobileIntent(intent); }
  #chip(intent: MobileIntent, value: MobileFileChip): void {
    this.drafts.change(intent, current => ({ ...current, files: current.files.map(chip => chip.requestId === value.requestId ? Object.freeze(value) : chip) }));
  }
  /** One file gesture, no automatic Send. Cancellation leaves every draft and pending request identity unchanged. */
  async pick(): Promise<void> {
    if (this.#picking) return; this.#picking = true;
    let assets: DocumentPicker.DocumentPickerAsset[] = [];
    try {
      const intent = mobileIntent(this.session), capability = this.session.projection.bootstrap!.capabilities.uploads;
      if (!capability.available) throw new Error("upload_unavailable");
      if (this.drafts.get(intent.scope, intent.conversationId).files.length >= capability.limits.messageFiles) throw new MobileIntentError("mobile_file_limit");
      const selection = await DocumentPicker.getDocumentAsync({ copyToCacheDirectory: true, multiple: false, type: ["text/*", ...(capability.binary ? ["application/pdf", ...(capability.binary.images ? ["image/png", "image/jpeg"] : [])] : [])] });
      if (selection.canceled) return;
      assets = selection.assets;
      if (assets.length !== 1) throw new Error("mobile_picker_invalid");
      await this.#revalidate(intent);
      const asset = assets[0]!, file = cached(asset.uri), extension = asset.name.split(".").at(-1)!.toLowerCase();
      const currentCapability = this.session.projection.bootstrap!.capabilities.uploads;
      if (!file || !currentCapability.available || !currentCapability.extensions.includes(extension)) throw new Error("mobile_file_type_unavailable");
      const limit = currentCapability.formats?.find(format => format.extension === extension)?.bytes ?? currentCapability.limits.fileBytes;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 32 * 1048576 || asset.size !== undefined && (!Number.isSafeInteger(asset.size) || asset.size < 1 || asset.size > limit)) throw new MobileIntentError("mobile_file_limit");
      const handle = file.open(FileMode.ReadOnly); let bytes: Uint8Array<ArrayBuffer>;
      try { bytes = await handle.readBytes(limit + 1); } finally { handle.close(); }
      checkMobileIntent(intent);
      if (!bytes.length || bytes.length > limit || asset.size !== undefined && asset.size !== bytes.length) throw new MobileIntentError("mobile_file_limit");
      const draft = this.drafts.get(intent.scope, intent.conversationId);
      if (draft.files.length >= currentCapability.limits.messageFiles || draft.files.reduce((sum, chip) => sum + chip.bytes, bytes.length) > currentCapability.limits.messageBytes) throw new MobileIntentError("mobile_file_limit");
      const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), byte => byte.toString(16).padStart(2, "0")).join("");
      checkMobileIntent(intent);
      let chip: MobileFileChip = { requestId: crypto.randomUUID().replaceAll("-", ""), name: asset.name, bytes: bytes.length, uploadId: null, phase: "uploading", receipt: null, code: null };
      this.drafts.change(intent, current => ({ ...current, files: [...current.files, Object.freeze(chip)] }));
      try {
        const upload = await this.session.perform((client, signal) => client.createUpload({ requestId: chip.requestId, conversationId: intent.conversationId, name: chip.name, bytes: bytes.length, sha256 }, signal));
        chip = { ...chip, uploadId: upload.id }; this.#chip(intent, chip);
        const ready = await this.session.perform((client, signal) => client.uploadBytes(upload.id, bytes, signal));
        this.#chip(intent, { ...chip, ...this.#state(ready) });
      } catch (error) { try { this.#chip(intent, { ...chip, phase: "failed", code: code(error) }); } catch { /* Lifecycle fence keeps the original upload identity; only Check may recover it. */ } throw error; }
    } finally {
      this.#picking = false;
      for (const asset of assets) { const file = cached(asset.uri); if (file?.exists) file.delete(); }
    }
  }
  #state(upload: FileUpload): Pick<MobileFileChip, "phase" | "receipt" | "code"> {
    return { phase: upload.state === "ready" && upload.receipt ? "ready" : ["created", "uploading", "validating"].includes(upload.state) ? "validating" : "failed", receipt: upload.state === "ready" ? upload.receipt : null, code: upload.code };
  }
  /** Read-only recovery for this original upload, including parser completion; never replays bytes. */
  async check(chip: MobileFileChip): Promise<void> {
    const intent = mobileIntent(this.session); if (!chip.uploadId) throw new Error("mobile_upload_identity_unavailable");
    const upload = await this.session.perform((client, signal) => client.uploadStatus(chip.uploadId!, signal));
    if (upload.requestId !== chip.requestId || upload.conversationId !== intent.conversationId) throw new Error("mobile_upload_scope_invalid");
    this.#chip(intent, { ...chip, ...this.#state(upload) });
  }
  /** An owner-selected directory, followed by fresh guarded bytes; no shared session/URL enters another app. */
  async export(artifact: FileArtifact): Promise<void> {
    const intent = mobileIntent(this.session);
    if (artifact.conversationId !== intent.conversationId || !artifact.name || artifact.name === "." || artifact.name === ".." || /[\\/\u0000-\u001f]/.test(artifact.name)) throw new Error("mobile_export_invalid");
    const destination = await Directory.pickDirectoryAsync();
    await this.#revalidate(intent);
    const bytes = await this.session.perform((client, signal) => client.artifactBytes(artifact, signal)); checkMobileIntent(intent);
    if (Platform.OS === "ios") {
      if (!Export) throw new Error("mobile_export_unavailable");
      await Export.writeNew(destination.uri, artifact.name, bytes);
    } else {
      if (Platform.OS !== "android" || new URL(destination.uri).protocol !== "content:") throw new Error("mobile_export_invalid");
      const file = destination.createFile(artifact.name, artifact.mime); await file.write(bytes);
    }
  }
}
