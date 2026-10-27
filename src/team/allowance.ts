import { AppError } from "../errors";
import type { AppConfig } from "../config";
import { requireId } from "../sources";
import type { AppTransaction } from "../store";

/** Product default for how many existing specialists Jit may call per owner message without asking (S09-D04). */
export const defaultDispatchAllowance = 3;

/**
 * app.dispatch_allowance/v1 — the owner's standing authorization for Jit to call existing specialists (ADR 0030).
 * `maxRoles` is what the owner set; `effectiveMaxRoles` is that value capped by the current operator ceiling, so a
 * lowered ceiling takes effect without rewriting the owner's revision. Revision 0 is the product default.
 */
export interface DispatchAllowance {
  projectId: string; revision: number; enabled: boolean; maxRoles: number; effectiveMaxRoles: number; ceiling: number; updatedAt: number | null;
}

/** Owner command; the only writer of the allowance. `expectedRevision` is the allowance revision the form showed. */
export interface SetDispatchAllowanceCommand {
  kind: "dispatch.allowance.set"; requestId: string; projectId: string; expectedRevision: number;
  payload: { enabled: boolean; maxRoles: number };
}
export interface DispatchAllowanceReceipt { allowance: DispatchAllowance }

/**
 * Operator ceiling (ADR 0010, NFR-06): the per-job role budget and the team role limit. A discussion admitted under
 * the allowance never needs more roles than one job may hold.
 */
export function allowanceCeiling(config: AppConfig): number {
  return Math.max(1, Math.min(config.jobs.maximum.roles, config.team.roleLimit, 100));
}

/** The current allowance of one project, or the product default (revision 0) when the owner never set one. */
export function readDispatchAllowance(tx: AppTransaction, projectId: string, config: AppConfig): DispatchAllowance {
  const ceiling = allowanceCeiling(config);
  const row = tx.get<{ revision: number; enabled: number; maxRoles: number; createdAt: number }>(
    `SELECT revision, enabled, max_roles AS maxRoles, created_at AS createdAt FROM dispatch_allowance_revisions
     WHERE project_id = ? ORDER BY revision DESC LIMIT 1`, projectId);
  const maxRoles = row?.maxRoles ?? defaultDispatchAllowance;
  return { projectId, revision: row?.revision ?? 0, enabled: row ? row.enabled === 1 : true, maxRoles,
    effectiveMaxRoles: Math.min(maxRoles, ceiling), ceiling, updatedAt: row?.createdAt ?? null };
}

const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/** Validates the command shape and returns its receipt identity (the exact payload under its project and revision). */
export function allowanceIdentity(command: SetDispatchAllowanceCommand): string {
  if (!exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) || command.kind !== "dispatch.allowance.set" ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 || !exact(command.payload, ["enabled", "maxRoles"]) ||
      typeof command.payload.enabled !== "boolean" || !Number.isSafeInteger(command.payload.maxRoles) || command.payload.maxRoles < 1) {
    throw new AppError("invalid_dispatch_allowance");
  }
  requireId(command.projectId);
  return JSON.stringify([command.kind, command.projectId, command.expectedRevision, command.payload.enabled, command.payload.maxRoles]);
}

/**
 * Appends one owner revision. The value must fit the operator ceiling at the time of the command
 * (`allowance_above_ceiling`); a disabled allowance keeps its number so turning it back on restores it.
 */
export function writeDispatchAllowance(tx: AppTransaction, command: SetDispatchAllowanceCommand, config: AppConfig, now: number): DispatchAllowance {
  const current = readDispatchAllowance(tx, command.projectId, config);
  if (current.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  if (command.payload.maxRoles > current.ceiling) throw new AppError("allowance_above_ceiling", 409);
  tx.run("INSERT INTO dispatch_allowance_revisions (project_id, revision, enabled, max_roles, created_at) VALUES (?, ?, ?, ?, ?)",
    command.projectId, current.revision + 1, command.payload.enabled ? 1 : 0, command.payload.maxRoles, now);
  return readDispatchAllowance(tx, command.projectId, config);
}
