import { createHash } from "node:crypto";
import { AppError } from "../errors";
import type { AppConfig } from "../config";
import { requireId } from "../sources";
import type { AppTransaction } from "../store";

/**
 * app.access_level/v1 (S11-D02, ADR 0037) — a project's revisioned execution permission.
 *
 * `read` (the default, revision 0) runs no execution tool; `workspace` runs core tools in the project box;
 * `full` adds network. Only the owner in Web widens anything, after confirming the exact revision; any authorized
 * owner channel may narrow. Model output, retrieved content and Telegram text never change a level: the only writers
 * are the owner commands below, committed through `Application.execute` with receipts.
 */
export type AccessLevel = "read" | "workspace" | "full";

/** Every access level, lowest first. */
export const accessLevels: readonly AccessLevel[] = Object.freeze(["read", "workspace", "full"]);

/** The order of access levels: `read` 0, `workspace` 1, `full` 2. Throws `invalid_access_level` for anything else. */
export function levelRank(level: AccessLevel): number {
  const rank = accessLevels.indexOf(level);
  if (rank < 0) throw new AppError("invalid_access_level");
  return rank;
}

const isLevel = (value: unknown): value is AccessLevel => typeof value === "string" && (accessLevels as readonly string[]).includes(value);
const lowest = (a: AccessLevel, b: AccessLevel): AccessLevel => levelRank(a) <= levelRank(b) ? a : b;

/**
 * The project's current access state. `revision` is the level revision (0 before the owner ever set one) and
 * `haltRevision` the kill switch revision; each command expects the revision of the state it changes.
 * `fullAllowed` echoes the operator flag `JIT_EXECUTION_FULL_ALLOWED`, without which `full` cannot be set.
 */
export interface ProjectAccess {
  projectId: string; level: AccessLevel; revision: number; halted: boolean; haltRevision: number; fullAllowed: boolean; updatedAt: number | null;
}

/** The level a run of one role may use: the lower of the project level and the role override, or `read` while halted. */
export interface EffectiveAccess { level: AccessLevel; halted: boolean; projectLevel: AccessLevel; roleLevel: AccessLevel | null }

/**
 * The latest restrict-only override of one role in one project. `level: null` means the override was cleared and the
 * role follows the project. `effective` is computed against the current project state, so after the project is
 * lowered below an override the role follows the project.
 */
export interface RoleAccess { projectId: string; roleId: string; level: AccessLevel | null; revision: number; updatedAt: number; effective: EffectiveAccess }

interface AccessState { level: AccessLevel; revision: number; halted: boolean; haltRevision: number; updatedAt: number | null }

function readAccessState(tx: AppTransaction, projectId: string): AccessState {
  const level = tx.get<{ revision: number; level: AccessLevel; createdAt: number }>(
    "SELECT revision, level, created_at AS createdAt FROM project_access_revisions WHERE project_id = ? ORDER BY revision DESC LIMIT 1", projectId);
  const halt = tx.get<{ revision: number; halted: number; createdAt: number }>(
    "SELECT revision, halted, created_at AS createdAt FROM execution_halts WHERE project_id = ? ORDER BY revision DESC LIMIT 1", projectId);
  const times = [level?.createdAt, halt?.createdAt].filter((value): value is number => typeof value === "number");
  return { level: level?.level ?? "read", revision: level?.revision ?? 0, halted: halt?.halted === 1, haltRevision: halt?.revision ?? 0,
    updatedAt: times.length ? Math.max(...times) : null };
}

/** Reads one project's access state. A project the owner never configured reads `read`, revision 0, not halted. */
export function readProjectAccess(tx: AppTransaction, projectId: string, config: AppConfig): ProjectAccess {
  return { projectId, ...readAccessState(tx, projectId), fullAllowed: config.execution.fullAllowed };
}

function readRoleOverride(tx: AppTransaction, projectId: string, roleId: string): { level: AccessLevel | null; revision: number; updatedAt: number } | null {
  return tx.get<{ level: AccessLevel | null; revision: number; updatedAt: number }>(
    `SELECT level, revision, created_at AS updatedAt FROM role_access_overrides WHERE project_id = ? AND role_id = ?
     ORDER BY revision DESC LIMIT 1`, projectId, roleId);
}

/** Lists the latest override of every role the owner ever restricted in this project, by role id. */
export function readRoleAccess(tx: AppTransaction, projectId: string): RoleAccess[] {
  const state = readAccessState(tx, projectId);
  return tx.all<{ roleId: string; level: AccessLevel | null; revision: number; updatedAt: number }>(
    `SELECT o.role_id AS roleId, o.level, o.revision, o.created_at AS updatedAt FROM role_access_overrides o
     WHERE o.project_id = ? AND o.revision = (SELECT max(revision) FROM role_access_overrides x WHERE x.project_id = o.project_id AND x.role_id = o.role_id)
     ORDER BY o.role_id`, projectId)
    .map(row => ({ projectId, ...row, effective: effectiveAccess(state, row.level) }));
}

/**
 * The effective level: the minimum of the project level and the role override. While the kill switch holds, the
 * effective level is `read` with `halted: true`, whatever the stored levels say.
 */
export function effectiveAccess(project: Pick<ProjectAccess, "level" | "halted">, roleOverride: AccessLevel | null): EffectiveAccess {
  const combined = roleOverride ? lowest(project.level, roleOverride) : project.level;
  return { level: project.halted ? "read" : combined, halted: project.halted, projectLevel: project.level, roleLevel: roleOverride };
}

/**
 * The widening confirmation the Web confirmation page renders: SHA-256 hex of the JSON array
 * `[projectId, from, to, expectedRevision]`. It binds the owner's confirmation to one exact transition at one revision,
 * so a token for another level or revision is rejected. It is a confirmation, not a secret.
 */
export function accessConfirmToken(projectId: string, from: AccessLevel, to: AccessLevel, expectedRevision: number): string {
  return createHash("sha256").update(JSON.stringify([projectId, from, to, expectedRevision])).digest("hex");
}

/** Owner command: sets the project level. Widening needs `channel: web` and `confirmToken`; `full` needs the operator flag. */
export interface SetAccessLevelCommand {
  kind: "access.level.set"; requestId: string; projectId: string; expectedRevision: number;
  payload: { level: AccessLevel; confirmToken?: string };
}
/** Owner command: sets (or with `level: null` clears) a role's override. It may never exceed the project level. */
export interface RestrictRoleAccessCommand {
  kind: "access.role.restrict"; requestId: string; projectId: string; expectedRevision: number;
  payload: { roleId: string; level: AccessLevel | null };
}
/** The kill switch, accepted from any authorized owner channel. `expectedRevision` is the halt revision. */
export interface HaltExecutionCommand {
  kind: "execution.halt"; requestId: string; projectId: string; expectedRevision: number;
  payload: { reason?: string };
}
/** Lifts the kill switch; Web only. `expectedRevision` is the halt revision. */
export interface ResumeExecutionCommand {
  kind: "execution.resume"; requestId: string; projectId: string; expectedRevision: number;
  payload: Record<string, never>;
}
/** app.access_level/v1 owner commands. */
export type AccessCommand = SetAccessLevelCommand | RestrictRoleAccessCommand | HaltExecutionCommand | ResumeExecutionCommand;

/**
 * What the kill switch stopped in its own transaction: execution jobs it fenced, and the Jit replies, team discussions
 * and coordinator syntheses it stopped.
 */
export interface HaltOutcome { fencedJobIds: string[]; stoppedReplyIds: string[]; stoppedDiscussionIds: string[]; stoppedSynthesisIds: string[] }
/** The receipt of every access command: the committed state, plus what a halt stopped. */
export interface AccessReceipt { access: ProjectAccess; roles: RoleAccess[]; halt?: HaltOutcome }

const accessKinds = new Set(["access.level.set", "access.role.restrict", "execution.halt", "execution.resume"]);
/** True when the command is one of the app.access_level/v1 kinds (shape is checked by {@link accessCommandIdentity}). */
export function isAccessCommand(command: unknown): command is AccessCommand {
  return !!command && typeof command === "object" && accessKinds.has((command as { kind?: unknown }).kind as string);
}

const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const maximumReasonBytes = 500;

/**
 * Validates an access command's exact shape (`invalid_access_command`) and returns its receipt identity: the kind,
 * project, expected revision and canonical payload. A replay with another payload is a `request_id_conflict`.
 */
export function accessCommandIdentity(command: AccessCommand): string {
  const invalid = () => new AppError("invalid_access_command");
  if (!isAccessCommand(command) || !exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0) throw invalid();
  requireId(command.projectId);
  const head = [command.kind, command.projectId, command.expectedRevision];
  if (command.kind === "access.level.set") {
    const payload = command.payload;
    if (!(exact(payload, ["level"]) || exact(payload, ["level", "confirmToken"])) || !isLevel(payload.level) ||
        (payload.confirmToken !== undefined && (typeof payload.confirmToken !== "string" || !/^[a-f0-9]{64}$/.test(payload.confirmToken)))) throw invalid();
    return JSON.stringify([...head, payload.level, payload.confirmToken ?? null]);
  }
  if (command.kind === "access.role.restrict") {
    const payload = command.payload;
    if (!exact(payload, ["roleId", "level"]) || (payload.level !== null && !isLevel(payload.level))) throw invalid();
    requireId(payload.roleId);
    return JSON.stringify([...head, payload.roleId, payload.level]);
  }
  if (command.kind === "execution.halt") {
    const payload = command.payload;
    if (!(exact(payload, []) || exact(payload, ["reason"]))) throw invalid();
    if (payload.reason !== undefined && (typeof payload.reason !== "string" || !payload.reason.trim() || !payload.reason.isWellFormed() ||
        Buffer.byteLength(payload.reason) > maximumReasonBytes)) throw invalid();
    return JSON.stringify([...head, payload.reason ?? null]);
  }
  if (!exact(command.payload, [])) throw invalid();
  return JSON.stringify(head);
}

/**
 * Restrict-only authority: only the `web` channel may widen anything (a level, a role override, or resume after a
 * halt). Every other channel — `telegram`, the local API, an automatic rule, a model — is refused with
 * `access_widen_requires_web` (403).
 */
export function requireWideningChannel(channel: string): void {
  if (channel !== "web") throw new AppError("access_widen_requires_web", 403);
}

/**
 * Appends the next project level revision. Rules, in order: widening needs the `web` channel (403); the expected
 * revision must be current (`stale_revision`); `full` needs `config.execution.fullAllowed` (`access_full_not_allowed`);
 * widening needs the exact {@link accessConfirmToken} for `[projectId, current, requested, expectedRevision]`
 * (`access_confirm_required`). Narrowing or re-setting the same level needs no token.
 */
export function writeAccessLevel(tx: AppTransaction, command: SetAccessLevelCommand, channel: string, config: AppConfig, now: number): ProjectAccess {
  const current = readAccessState(tx, command.projectId), to = command.payload.level;
  const widening = levelRank(to) > levelRank(current.level);
  if (widening) requireWideningChannel(channel);
  if (current.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  if (to === "full" && !config.execution.fullAllowed) throw new AppError("access_full_not_allowed", 409);
  if (widening && command.payload.confirmToken !== accessConfirmToken(command.projectId, current.level, to, command.expectedRevision)) {
    throw new AppError("access_confirm_required", 409);
  }
  tx.run("INSERT INTO project_access_revisions (project_id, revision, level, channel, created_at) VALUES (?, ?, ?, ?, ?)",
    command.projectId, current.revision + 1, to, channel, now);
  return readProjectAccess(tx, command.projectId, config);
}

/**
 * Appends the next override revision of one existing role (`role_not_found`). An override above the current project
 * level is `access_role_above_project` (409). Raising the stored cap — a higher override, or clearing an override,
 * which removes the cap — is widening and needs the `web` channel, even when the project level currently hides the
 * difference (the cap applies again once the project is widened). `expectedRevision` is the role's override revision
 * (0 before any).
 */
export function writeRoleRestriction(tx: AppTransaction, command: RestrictRoleAccessCommand, channel: string, now: number): RoleAccess {
  if (!tx.get("SELECT id FROM roles WHERE id = ?", command.payload.roleId)) throw new AppError("role_not_found", 404);
  const project = readAccessState(tx, command.projectId), current = readRoleOverride(tx, command.projectId, command.payload.roleId);
  const to = command.payload.level;
  // A missing or cleared override is no cap at all, above every level.
  const cap = (level: AccessLevel | null | undefined) => level ? levelRank(level) : accessLevels.length;
  if (cap(to) > cap(current?.level)) requireWideningChannel(channel);
  if ((current?.revision ?? 0) !== command.expectedRevision) throw new AppError("stale_revision", 409);
  if (to && levelRank(to) > levelRank(project.level)) throw new AppError("access_role_above_project", 409);
  tx.run("INSERT INTO role_access_overrides (project_id, role_id, revision, level, channel, created_at) VALUES (?, ?, ?, ?, ?, ?)",
    command.projectId, command.payload.roleId, (current?.revision ?? 0) + 1, to, channel, now);
  return readRoleAccess(tx, command.projectId).find(item => item.roleId === command.payload.roleId)!;
}

/**
 * Records the kill switch as the next halt revision (`stale_revision` otherwise). Accepted from any authorized owner
 * channel. The caller fences execution work and stops replies and discussions in the same transaction.
 */
export function writeHalt(tx: AppTransaction, command: HaltExecutionCommand, channel: string, now: number): void {
  const current = readAccessState(tx, command.projectId);
  if (current.haltRevision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  tx.run("INSERT INTO execution_halts (project_id, revision, halted, channel, reason, created_at) VALUES (?, ?, 1, ?, ?, ?)",
    command.projectId, current.haltRevision + 1, channel, command.payload.reason?.trim() ?? null, now);
}

/**
 * Lifts the kill switch. Resume restores execution power, so it is Web only (`access_widen_requires_web`); it needs
 * the current halt revision and a halted project (`execution_not_halted`).
 */
export function writeResume(tx: AppTransaction, command: ResumeExecutionCommand, channel: string, now: number): void {
  requireWideningChannel(channel);
  const current = readAccessState(tx, command.projectId);
  if (current.haltRevision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  if (!current.halted) throw new AppError("execution_not_halted", 409);
  tx.run("INSERT INTO execution_halts (project_id, revision, halted, channel, reason, created_at) VALUES (?, ?, 0, ?, NULL, ?)",
    command.projectId, current.haltRevision + 1, channel, now);
}

/**
 * The admission guard every execution path calls inside its own transaction, before admitting or committing work.
 * Throws `execution_halted` (409) while the kill switch holds, and `access_level_insufficient` (409, detail
 * `{ effective, needed }`) when the effective level of the project — and of `roleId`'s override when given — is below
 * `needed`. Returns the effective level otherwise.
 */
export function assertExecutionAllowed(tx: AppTransaction, projectId: string, roleId: string | null, needed: AccessLevel): AccessLevel {
  const state = readAccessState(tx, projectId);
  if (state.halted) throw new AppError("execution_halted", 409);
  const effective = effectiveAccess(state, roleId ? readRoleOverride(tx, projectId, roleId)?.level ?? null : null).level;
  if (levelRank(effective) < levelRank(needed)) throw new AppError("access_level_insufficient", 409, { effective, needed });
  return effective;
}
