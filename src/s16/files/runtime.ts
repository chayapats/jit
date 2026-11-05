import { hostCapabilities, type HostImageProbeRecord } from "schway/host";
import { AppError } from "../../errors";
import { pinnedImagePattern } from "../../exec/box-runtime";
import { PodmanAttachmentSanitizer, sanitizerCommandRunner } from "../../attachments/sanitizer-runtime";
import type { AttachmentLimits } from "../../attachments/limits";
import { binaryLimits } from "./parser";
import { SCHWAY_PINNED_REVISION } from "../../schway-version";

/** Owner-controlled, credential-free opt-in. Probes must describe the configured live account/route. */
export interface BinaryFileConfig { parserImage: string; imageProbes: HostImageProbeRecord[] }
/** Strict closed configuration. Test probe evidence cannot enable an installed live image route. */
export function validateBinaryFileConfig(raw: unknown): asserts raw is BinaryFileConfig {
  const value = raw as BinaryFileConfig;
  if (!value || typeof value !== "object" || Object.keys(value).sort().join() !== "imageProbes,parserImage" || typeof value.parserImage !== "string" || !pinnedImagePattern.test(value.parserImage) || !Array.isArray(value.imageProbes) || value.imageProbes.length > 32 || value.imageProbes.some(p => !p || typeof p !== "object" || p.revision !== SCHWAY_PINNED_REVISION) || new Set(value.imageProbes.map(p => `${p.route}/${p.model}`)).size !== value.imageProbes.length) throw new AppError("invalid_s15_config");
  try { hostCapabilities(value.imageProbes); } catch { throw new AppError("invalid_s15_config"); }
}
/** Independent S16 limits; no legacy project database, attachment env policy or network is imported. */
export function binaryFileRuntime(config: BinaryFileConfig, installation: string, env: Record<string, string | undefined>): PodmanAttachmentSanitizer {
  validateBinaryFileConfig(config);
  const limits: AttachmentLimits = { enabled: true, fileBytes: binaryLimits.originalBytes, messageFiles: 4, projectBytes: 64 * 1024 * 1024, diskReserveBytes: 256 * 1024 * 1024, stagedHours: 24, sanitizerMemoryMB: 256, sanitizerSeconds: 30, backupBytes: 64 * 1024 * 1024, imagePixels: binaryLimits.pixels };
  return new PodmanAttachmentSanitizer(config.parserImage, installation + "/s16-files", limits, sanitizerCommandRunner("podman", env), undefined, "s16-isolated-file/v1");
}
