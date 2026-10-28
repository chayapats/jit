import { createHash } from "node:crypto";
import { AppError } from "../errors";
import type { AppTransaction } from "../store";

/**
 * app.local_api/v1 — whether the owner turned the loopback API on (REL06, ADR 0035, FR-32).
 *
 * One installation-wide row (schema 29, `local_api_settings`). Without a row the API is off at revision 0.
 * It changes only through the `local_api.set` owner command, which is revisioned and idempotent by request id
 * like every other command. The setting grants no authority of its own: the API maps onto existing owner
 * commands and queries. The token is never stored here.
 */
export interface LocalApiSettings { enabled: boolean; revision: number; updatedAt: number | null }
export interface SetLocalApiCommand {
  kind: "local_api.set";
  requestId: string;
  projectId: null;
  /** Revision of the settings row the owner saw (0 before the first save). */
  expectedRevision: number;
  payload: { enabled: boolean };
}
export interface LocalApiReceipt { localApi: LocalApiSettings }

export const defaultLocalApi: LocalApiSettings = Object.freeze({ enabled: false, revision: 0, updatedAt: null });

/** Reads the setting, or the default (off, revision 0) when the owner never saved one. */
export function readLocalApi(tx: AppTransaction): LocalApiSettings {
  const row = tx.get<{ enabled: number; revision: number; updated_at: number }>("SELECT enabled, revision, updated_at FROM local_api_settings WHERE id = 1");
  return row ? { enabled: row.enabled === 1, revision: row.revision, updatedAt: row.updated_at } : { ...defaultLocalApi };
}

/** Validates a command shape and returns its stable identity for receipt replay. */
export function localApiIdentity(command: SetLocalApiCommand): string {
  if (!command || command.kind !== "local_api.set" || command.projectId !== null ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
      !command.payload || typeof command.payload !== "object" || typeof command.payload.enabled !== "boolean" ||
      Object.keys(command.payload).some(key => key !== "enabled")) throw new AppError("invalid_local_api");
  return createHash("sha256").update(JSON.stringify([command.kind, command.expectedRevision, command.payload.enabled])).digest("hex");
}

/** Applies a validated command inside the caller's write transaction. A stale revision is rejected. */
export function writeLocalApi(tx: AppTransaction, command: SetLocalApiCommand, now: number): LocalApiSettings {
  const current = readLocalApi(tx);
  if (current.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  const next: LocalApiSettings = { enabled: command.payload.enabled, revision: current.revision + 1, updatedAt: now };
  tx.run(`INSERT INTO local_api_settings (id, revision, enabled, updated_at) VALUES (1, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET revision = excluded.revision, enabled = excluded.enabled, updated_at = excluded.updated_at`,
  next.revision, next.enabled ? 1 : 0, now);
  return next;
}
