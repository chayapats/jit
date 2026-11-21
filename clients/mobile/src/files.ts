import * as DocumentPicker from "expo-document-picker";
import { Platform } from "react-native";
import { Directory, File, FileMode, Paths } from "expo-file-system";
import Gate from "../modules/jit-native-gate";
import Export from "../modules/jit-native-gate/export";
import { checkMobileIntent, mobileIntent, MobileIntentError, type MobileDrafts, type MobileFileChip, type MobileIntent } from "../../../src/s16/mobile/drafts";
import type { MobileSession } from "../../../src/s16/mobile/session";
import { MobileUploads } from "../../../src/s16/mobile/uploads";
import type { FileArtifact } from "../../../src/s16/files/types";

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
  readonly #uploads: MobileUploads;
  constructor(readonly session: MobileSession, readonly drafts: MobileDrafts) { this.#uploads = new MobileUploads(session, drafts); }
  async #revalidate(intent: MobileIntent): Promise<void> { await nativeActive(); await this.session.restore(); checkMobileIntent(intent); }
  /** One file gesture, no automatic Send. Cancellation leaves every draft and pending request identity unchanged. */
  pick(): Promise<void> { return this.#select(null); }
  /** A fresh explicit OS selection may finish only the known empty original upload with identical bytes. */
  resume(chip: MobileFileChip): Promise<void> { return this.#select(chip); }
  async #select(resume: MobileFileChip | null): Promise<void> {
    if (this.#picking) return; this.#picking = true;
    let assets: DocumentPicker.DocumentPickerAsset[] = [];
    try {
      const intent = mobileIntent(this.session), capability = this.session.projection.bootstrap!.capabilities.uploads;
      if (!capability.available) throw new Error("upload_unavailable");
      if (!resume && this.drafts.get(intent.scope, intent.conversationId).files.length >= capability.limits.messageFiles) throw new MobileIntentError("mobile_file_limit");
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
      const others = draft.files.filter(chip => chip.requestId !== resume?.requestId);
      if (others.length >= currentCapability.limits.messageFiles || others.reduce((sum, chip) => sum + chip.bytes, bytes.length) > currentCapability.limits.messageBytes) throw new MobileIntentError("mobile_file_limit");
      if (resume) await this.#uploads.resume(intent, resume, { name: asset.name, bytes });
      else await this.#uploads.begin(intent, { name: asset.name, bytes });
    } finally {
      this.#picking = false;
      for (const asset of assets) { const file = cached(asset.uri); if (file?.exists) file.delete(); }
    }
  }
  /** Read-only recovery for this original upload, including parser completion; never replays bytes. */
  async check(chip: MobileFileChip): Promise<void> { await this.#uploads.check(chip); }
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
