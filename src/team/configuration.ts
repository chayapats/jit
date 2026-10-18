import { createHash } from "node:crypto";
import { AppError } from "../errors";
import { jobData } from "../jobs/queue";
import { requireId, requireText } from "../sources";
import type { AppTransaction } from "../store";
import type { EffectiveRoleRoute, Role, RoleRoute, TeamCommand, TeamPolicy, TeamReceipt } from "./types";

/** Validates an opaque configured route without probing credentials, inferring model availability or selecting fallback. */
export function requireRoleRoute(value: unknown): asserts value is RoleRoute | null {
  if (value === null) return;
  const route = value as RoleRoute;
  if (!route || Object.keys(route).sort().join(",") !== "authRoute,model,provider" || !["grok", "codex"].includes(route.provider) ||
      typeof route.model !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,119}$/.test(route.model) ||
      typeof route.authRoute !== "string" || !/^[a-z][a-z0-9._-]{0,63}$/.test(route.authRoute)) throw new AppError("invalid_role_route");
}
/** Validates the exact bounded owner command before producing its global receipt fingerprint. */
export function teamIdentity(command: TeamCommand, policy: TeamPolicy): string {
  const encoded = jobData(command, policy.contextBytes);
  const exact = (value: object, keys: string[]) => Object.keys(value).sort().join(",") === keys.sort().join(",");
  if (!command || !exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) || !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
      !command.payload || typeof command.payload !== "object") throw new AppError("invalid_team_command");
  if (command.projectId !== null) requireId(command.projectId);
  if (command.kind === "role.save") {
    const p = command.payload;
    if (command.projectId !== null || !exact(p, ["roleId", "name", "kind", "responsibility", "enabled", "route"])) throw new AppError("invalid_team_command");
    if (p.roleId !== null) requireId(p.roleId);
    requireText(p.name, 200); requireText(p.responsibility, policy.responsibilityBytes);
    if (!["specialist", "coordinator"].includes(p.kind) || typeof p.enabled !== "boolean") throw new AppError("invalid_team_command");
    requireRoleRoute(p.route);
  } else if (command.kind === "route.save") {
    const p = command.payload;
    if (!exact(p, ["roleId", "route"]) || (command.projectId === null && p.roleId !== null)) throw new AppError("invalid_team_command");
    if (p.roleId !== null) requireId(p.roleId); requireRoleRoute(p.route);
  } else if (command.kind === "role.preview") {
    const p = command.payload;
    if (command.projectId === null || !exact(p, ["roleId", "topicId", "purpose", "sources", "limits"])) throw new AppError("invalid_team_command");
    requireId(p.roleId); requireId(p.topicId); requireText(p.purpose, 1200);
    if (p.purpose.length > 300 || !Array.isArray(p.sources) || p.sources.length > policy.sourceLimit) throw new AppError("invalid_team_command");
  } else throw new AppError("invalid_team_command");
  return createHash("sha256").update(encoded).digest("hex");
}

/** Reads one role by stable identity, independent of model names or project names. */
export function readRole(tx: AppTransaction, roleId: string): Role {
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM roles WHERE id = ?", roleId);
  if (!row) throw new AppError("role_not_found", 404); return JSON.parse(row.record_json) as Role;
}
/** Resolves complete routes by project-role > project default > owner-role > owner default; never mixes fields. */
export function readTeam(tx: AppTransaction, projectId: string | null, policy: TeamPolicy) {
  const owner = tx.get<{ revision: number; route_json: string | null }>("SELECT revision, route_json FROM team_state WHERE id = 1")!;
  const project = projectId ? tx.get<{ revision: number; route_json: string | null; overrides_json: string }>("SELECT * FROM project_team WHERE project_id = ?", projectId) : null;
  const overrides = JSON.parse(project?.overrides_json ?? "{}") as Record<string, RoleRoute>;
  const ownerDefault = owner.route_json ? JSON.parse(owner.route_json) as RoleRoute : null;
  const projectDefault = project?.route_json ? JSON.parse(project.route_json) as RoleRoute : null;
  const roles = tx.all<{ record_json: string }>("SELECT record_json FROM roles ORDER BY sequence LIMIT ?", policy.roleLimit).map(row => JSON.parse(row.record_json) as Role);
  return { ownerRevision: owner.revision, projectRevision: project?.revision ?? 0, ownerDefault, projectDefault, overrides,
    roles: roles.map(role => {
      const selected: [EffectiveRoleRoute["layer"], RoleRoute | null] = overrides[role.id] ? ["project_role", overrides[role.id]!] : projectDefault ? ["project_default", projectDefault] : role.route ? ["owner_role", role.route] : ownerDefault ? ["owner_default", ownerDefault] : ["missing", null];
      const effective: EffectiveRoleRoute = { layer: selected[0], route: selected[1], ownerRevision: owner.revision, projectRevision: project?.revision ?? 0, roleRevision: role.revision,
        status: role.enabled && selected[1] ? "unverified" : "blocked", nextAction: !role.enabled ? "enable_role" : !selected[1] ? "configure_exact_route" : "connect_and_verify_public_host_adapter" };
      return { ...role, effective };
    }) };
}

/** Applies owner-validated settings atomically; the caller persists the shared command receipt and audit. */
export function mutateTeamConfiguration(tx: AppTransaction, command: Exclude<TeamCommand, { kind: "role.preview" }>, policy: TeamPolicy, now: number): TeamReceipt {
  const state = readTeam(tx, command.projectId, policy), revision = command.projectId ? state.projectRevision : state.ownerRevision;
  if (command.expectedRevision !== revision) throw new AppError("stale_revision", 409);
  if (command.kind === "role.save") {
    const p = command.payload, old = p.roleId ? readRole(tx, p.roleId) : null;
    if (!old && state.roles.length >= policy.roleLimit) throw new AppError("role_limit", 409);
    const role: Role = { id: old?.id ?? crypto.randomUUID(), sequence: old?.sequence ?? 0, revision: (old?.revision ?? 0) + 1,
      name: p.name.trim(), kind: p.kind, responsibility: p.responsibility, enabled: p.enabled, route: p.route,
      createdAt: old?.createdAt ?? now, updatedAt: now };
    if (old) tx.run("UPDATE roles SET record_json = ? WHERE id = ?", JSON.stringify(role), role.id);
    else {
      tx.run("INSERT INTO roles (id, record_json) VALUES (?, ?)", role.id, JSON.stringify(role));
      role.sequence = tx.get<{ sequence: number }>("SELECT sequence FROM roles WHERE id = ?", role.id)!.sequence;
      tx.run("UPDATE roles SET record_json = ? WHERE id = ?", JSON.stringify(role), role.id);
    }
    tx.run("UPDATE team_state SET revision = revision + 1 WHERE id = 1"); return { revision: revision + 1, role };
  }
  const p = command.payload;
  if (p.roleId) readRole(tx, p.roleId);
  if (!command.projectId) tx.run("UPDATE team_state SET revision = revision + 1, route_json = ? WHERE id = 1", p.route ? JSON.stringify(p.route) : null);
  else {
    const overrides = { ...state.overrides };
    if (p.roleId) { if (p.route) overrides[p.roleId] = p.route; else delete overrides[p.roleId]; }
    const route = p.roleId ? state.projectDefault : p.route;
    tx.run("INSERT OR REPLACE INTO project_team VALUES (?, ?, ?, ?)", command.projectId, revision + 1, route ? JSON.stringify(route) : null, JSON.stringify(overrides));
  }
  return { revision: revision + 1 };
}
