import { AppError } from "../errors";
import { requireId } from "../sources";
import type { AppTransaction } from "../store";

/**
 * Owner command (EXE03, ADR 0036): removes the project's box and its writable layer; with `wipeWorkspace` it also
 * deletes the workspace. Web only (`box_reset_requires_web`), revisioned by the box reset revision, refused while
 * an execution attempt of the project is admitted or the box is in use (`box_busy`).
 */
export interface ResetBoxCommand {
  kind: "execution.box.reset"; requestId: string; projectId: string; expectedRevision: number;
  payload: { wipeWorkspace: boolean };
}

/** The project's box state the owner sees: the reset revision, the latest reset and whether Jit holds a box now. */
export interface BoxView {
  projectId: string;
  /** Box reset revision; 0 before the first reset. */
  revision: number;
  lastReset: { revision: number; wipeWorkspace: boolean; channel: string; createdAt: number } | null;
  /** Whether a box is running or opening for the project in this process. */
  holding: boolean;
  /** Whether the box is in use or an execution attempt of the project is admitted. */
  busy: boolean;
}

/** The committed receipt of `execution.box.reset`. */
export interface BoxResetReceipt { box: BoxView }

const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/** True for `execution.box.reset` (the shape is checked by {@link boxCommandIdentity}). */
export function isBoxCommand(command: unknown): command is ResetBoxCommand {
  return !!command && typeof command === "object" && (command as { kind?: unknown }).kind === "execution.box.reset";
}

/** Validates the exact command shape (`invalid_box_command`) and returns its receipt identity. */
export function boxCommandIdentity(command: ResetBoxCommand): string {
  if (!isBoxCommand(command) || !exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
      !exact(command.payload, ["wipeWorkspace"]) || typeof command.payload.wipeWorkspace !== "boolean") throw new AppError("invalid_box_command");
  requireId(command.projectId);
  return JSON.stringify([command.kind, command.projectId, command.expectedRevision, command.payload.wipeWorkspace]);
}

/** True while an execution-capable job of the project holds admission (its attempt may be using the box). */
export function executionAttemptAdmitted(tx: AppTransaction, projectId: string): boolean {
  return !!tx.get(`SELECT 1 FROM jobs WHERE project_id = ? AND state = 'admitted' AND json_extract(record_json, '$.execution') = 1 LIMIT 1`, projectId);
}

/** Reads the persisted part of {@link BoxView}; `holding`/`busy` come from the live manager. */
export function readBoxResets(tx: AppTransaction, projectId: string): Pick<BoxView, "revision" | "lastReset"> {
  const row = tx.get<{ revision: number; wipe: number; channel: string; createdAt: number }>(
    "SELECT revision, wipe_workspace AS wipe, channel, created_at AS createdAt FROM execution_box_resets WHERE project_id = ? ORDER BY revision DESC LIMIT 1", projectId);
  return { revision: row?.revision ?? 0, lastReset: row ? { revision: row.revision, wipeWorkspace: row.wipe === 1, channel: row.channel, createdAt: row.createdAt } : null };
}

/** Appends the next reset revision (`stale_revision` when `expectedRevision` is not current). */
export function writeBoxReset(tx: AppTransaction, command: ResetBoxCommand, channel: string, now: number): void {
  const current = readBoxResets(tx, command.projectId).revision;
  if (current !== command.expectedRevision) throw new AppError("stale_revision", 409);
  tx.run("INSERT INTO execution_box_resets (project_id, revision, wipe_workspace, channel, created_at) VALUES (?, ?, ?, ?, ?)",
    command.projectId, current + 1, command.payload.wipeWorkspace ? 1 : 0, channel, now);
}
