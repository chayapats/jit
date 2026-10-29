import { statfsSync } from "node:fs";
import { totalmem } from "node:os";
import { dirname } from "node:path";

/** S13 release interlock satisfied by merged ATT04/ATT06; ingestion still requires an explicit operator opt-in. */
export const attachmentsReleasable = true;
const parsedEnvironments = new WeakMap<AttachmentLimits, Record<string, string | undefined>>();
const MiB = 1024 * 1024, GiB = 1024 * MiB;
/** Detected host capacities, injectable so configuration tests never depend on the test machine. */
export interface AttachmentHost { memoryBytes: number; dataFilesystemBytes: number; backupFilesystemBytes: number }
/** Bounded ingestion, sanitizer and lifecycle settings from app.attachments/v1. */
export interface AttachmentLimits {
  enabled: boolean; fileBytes: number; messageFiles: number; projectBytes: number; diskReserveBytes: number;
  stagedHours: number; sanitizerMemoryMB: number; sanitizerSeconds: number; backupBytes: number; imagePixels: number;
}
function filesystemBytes(path: string): number {
  for (;;) {
    try { const fs = statfsSync(path); return Number(fs.blocks) * Number(fs.bsize); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || dirname(path) === path) throw error;
      path = dirname(path);
    }
  }
}
/** Probes the nearest existing ancestors without creating directories or requiring a particular host size. */
export function attachmentHost(dataDirectory: string, backupDirectory: string): AttachmentHost {
  return { memoryBytes: totalmem(), dataFilesystemBytes: filesystemBytes(dataDirectory), backupFilesystemBytes: filesystemBytes(backupDirectory) };
}
/** Reads the closed env settings; env wins over host-scaled defaults and the release gate fails closed. */
export function attachmentLimits(env: Record<string, string | undefined>, host: AttachmentHost): AttachmentLimits {
  const gate = env.JIT_ATTACHMENTS ?? "0";
  if (!["0", "1"].includes(gate) || (gate === "1" && !attachmentsReleasable)) throw new Error("Invalid JIT_ATTACHMENTS");
  for (const n of Object.values(host)) if (!Number.isSafeInteger(n) || n <= 0) throw new Error("Invalid attachment host capacity");
  const int = (key: string, fallback: number, min: number, max: number) => {
    const raw = env[key], n = raw === undefined ? Math.floor(fallback) : Number(raw);
    if ((raw !== undefined && !/^\d+$/.test(raw)) || !Number.isSafeInteger(n) || n < min || n > max) throw new Error(`Invalid ${key}`);
    return n;
  };
  const sanitizerMemoryMB = int("JIT_ATTACHMENT_SANITIZER_MEMORY_MB", Math.min(512, Math.max(256, host.memoryBytes / MiB / 16)), 256, 2048);
  const limits: AttachmentLimits = {
    enabled: gate === "1", fileBytes: int("JIT_ATTACHMENT_FILE_BYTES", 10 * MiB, 1, 16 * MiB),
    messageFiles: int("JIT_ATTACHMENT_MESSAGE_FILES", 5, 1, 10),
    projectBytes: int("JIT_ATTACHMENT_PROJECT_BYTES", Math.min(500 * MiB, Math.max(50 * MiB, host.dataFilesystemBytes * .05)), 16 * MiB, 16 * GiB),
    diskReserveBytes: int("JIT_ATTACHMENT_DISK_RESERVE_BYTES", 2 * GiB, 256 * MiB, 64 * GiB),
    stagedHours: int("JIT_ATTACHMENT_STAGED_HOURS", 24, 1, 168), sanitizerMemoryMB,
    sanitizerSeconds: int("JIT_ATTACHMENT_SANITIZER_SECONDS", 30, 10, 120),
    backupBytes: int("JIT_BACKUP_ATTACHMENT_BYTES", Math.min(2 * GiB, Math.max(256 * MiB, host.backupFilesystemBytes * .1)), 64 * MiB, 64 * GiB),
    imagePixels: Math.floor(40_000_000 * Math.min(1, sanitizerMemoryMB / 512)),
  };
  // Keep only declared non-secret attachment overrides; service paths may select another filesystem after config load.
  parsedEnvironments.set(limits, Object.fromEntries(Object.entries(env).filter(([key]) =>
    ["JIT_ATTACHMENTS", "JIT_ATTACHMENT_FILE_BYTES", "JIT_ATTACHMENT_MESSAGE_FILES", "JIT_ATTACHMENT_PROJECT_BYTES", "JIT_ATTACHMENT_DISK_RESERVE_BYTES", "JIT_ATTACHMENT_STAGED_HOURS", "JIT_ATTACHMENT_SANITIZER_MEMORY_MB", "JIT_ATTACHMENT_SANITIZER_SECONDS", "JIT_BACKUP_ATTACHMENT_BYTES"].includes(key))));
  return limits;
}
/** Bun transport ceiling only; ordinary owner routes retain payload()'s bodyBytes limit. */
export function attachmentRequestBytes(limits: AttachmentLimits): number { return limits.messageFiles * limits.fileBytes + 65536; }

/** Re-probes defaults for the resolved service paths, preserving declared env overrides. Explicit injected policies stay unchanged. */
export function attachmentLimitsForDirectories(limits: AttachmentLimits, dataDirectory: string, backupDirectory: string): AttachmentLimits {
  const env = parsedEnvironments.get(limits);
  return env ? attachmentLimits(env, attachmentHost(dataDirectory, backupDirectory)) : limits;
}
