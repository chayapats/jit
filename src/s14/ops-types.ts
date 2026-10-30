import type { HostRuntime } from "schway/host";
import type { Envelope } from "./types";
import type { NativeIntent } from "./recovery-types";

/** Exact released S14 backup envelope; legacy formats are never interpreted as this contract. */
export const managedBackupContract = "app.managed-backup/v1" as const;
/** Exact staged reconciliation and owner-authorized activation contract. */
export const restoreActivationContract = "app.restore-activation/v1" as const;
/** Finite maintenance limits, checked before allocating or creating candidate state. */
export const opsLimits = Object.freeze({ bytes: 64 * 1024 * 1024, files: 1026, native: 1024, rows: 200000, backups: 10, journalBytes: 2 * 1024 * 1024 });
/** Opaque supported native management surface; no inference, credentials or private imports are exposed. */
export interface OpsNativePort {
  supported(): boolean;
  open(intent: NativeIntent, sessionDirectory?: string): Promise<Pick<HostRuntime, "snapshotSessions" | "validateSessionSnapshot" | "restoreSessionSnapshot" | "listSessions" | "retireSession" | "deleteSession" | "close">>;
}
/** One hashed flat archive component; paths and native payloads never appear in owner summaries. */
export interface OpsComponent { name: string; size: number; sha256: string }
/** Complete credential-free image inventory with independent ledger position, never a replacement ledger. */
export interface ManagedBackupManifest {
  contract: typeof managedBackupContract; format: "jit.s14/v1"; schema: number; build: "jit/0.1.0"; id: string; installationId: string; createdAt: number;
  state: "complete"; ledger: string; ledgerPosition: { table: string; count: number; digest: string }[]; nativeContract: "schway.host.session-snapshot/v1"; nativeFormat: number;
  image: OpsComponent; native: { intentId: string; component: OpsComponent }[]; artifacts: { id: string; size: number; sha256: string }[];
  credentials: "excluded_reconnect_required";
}
/** Staged maintenance result; partial and blocked always retain the worker fence. */
export interface OpsStage {
  id: string; mode: "restore" | "upgrade"; backupId: string; state: "preparing" | "validated" | "activating" | "complete" | "partial" | "blocked" | "discarded";
  reason: string | null; candidateHash: string | null; liveHash: string; ledger: string; actionHash: string | null; priorHash: string | null; targetHash: string | null; activationHash: string | null;
  nativeDigest: string | null; nativeDirectory: string; priorNativeDirectory: string; recoveryBackupId: string;
}
/** Bounded installation control state, stored outside every application image. */
export interface OpsControl {
  contract: typeof restoreActivationContract; revision: number; backups: string[]; pendingBackupId: string | null; stage: OpsStage | null;
  receipts: { requestId: string; hash: string; result: OpsReceipt }[];
}
/** Owner command set uses control revision; activate binds the exact validated action hash. */
export type OpsCommand = Envelope<"backup.create", Record<string, never>>
  | Envelope<"restore.prepare", { backupId: string }>
  | Envelope<"upgrade.prepare", { targetSchema: number }>
  | Envelope<"restore.validate", { stageId: string }>
  | Envelope<"restore.discard", { stageId: string }>
  | Envelope<"upgrade.rollback", { stageId: string }>
  | Envelope<"restore.activate", { stageId: string; actionHash: string }>;
/** Credential-free durable outcome, with explicit worker and reconnection requirements. */
export interface OpsReceipt { requestId: string; revision: number; state: "complete" | "partial" | "blocked" | "validated" | "discarded"; reason: string | null; backupId?: string; stage?: OpsStage; workers: "fenced" | "stopped"; reconnectionRequired: true }

/** Running-service owner ingress uses the backup revision, not the offline maintenance or Home revision. */
export type OnlineBackupCommand = Envelope<"backup.create", Record<string, never>>;
/** Bounded metadata-only progress; a timed-out native call retains the writer fence until it actually settles. */
export interface OnlineBackupReceipt {
  kind: "backup.create"; requestId: string; revision: number; backupId: string;
  state: "capturing" | "complete" | "blocked"; reason: string | null;
  progress: { phase: "application" | "native" | "waiting_native_settlement" | "complete" | "blocked"; completed: number; total: number };
  startedAt: number; deadlineAt: number; workers: "paused" | "running"; reconnectionRequired: true;
}
/** Finite online retry journal, independent of images and offline activation authority. */
export interface OnlineBackupControl {
  contract: typeof managedBackupContract; revision: number; managedIds: string[];
  requests: { hash: string; replaces: string[]; result: OnlineBackupReceipt }[];
}
