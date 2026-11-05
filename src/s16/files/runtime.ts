import { hostCapabilities } from "schway/host";
import { AppError } from "../../errors";
import { PodmanAttachmentSanitizer, sanitizerCommandRunner } from "../../attachments/sanitizer-runtime";
import type { AttachmentLimits } from "../../attachments/limits";
import { binaryLimits } from "./parser";
import { validateBinaryFileConfig, type BinaryFileConfig } from "./config";
export { validateBinaryFileConfig, type BinaryFileConfig } from "./config";
/** Independent S16 limits; no legacy project database, attachment env policy or network is imported. */
export function binaryFileRuntime(config: BinaryFileConfig, installation: string, env: Record<string, string | undefined>): PodmanAttachmentSanitizer {
  validateBinaryFileConfig(config);
  try { hostCapabilities(config.imageProbes); } catch { throw new AppError("invalid_s15_config"); }
  const limits: AttachmentLimits = { enabled: true, fileBytes: binaryLimits.originalBytes, messageFiles: 4, projectBytes: 64 * 1024 * 1024, diskReserveBytes: 256 * 1024 * 1024, stagedHours: 24, sanitizerMemoryMB: 256, sanitizerSeconds: 30, backupBytes: 64 * 1024 * 1024, imagePixels: binaryLimits.pixels };
  return new PodmanAttachmentSanitizer(config.parserImage, installation + "/s16-files", limits, sanitizerCommandRunner("podman", env), undefined, "s16-isolated-file/v1");
}
