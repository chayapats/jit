import { AppError } from "../errors";
import { requireId } from "../sources";
import type { AppTransaction } from "../store";
import { mutateTeamConfiguration, readTeam, requireRoleRoute, teamIdentity } from "./configuration";
import { readReplyRecord, saveReplyRecord, safeIdentifier } from "./jit-reply";
import type { Role, RoleRoute, TeamCommand, TeamPolicy } from "./types";

/**
 * app.role_proposals/v1 — a specialist that Jit suggests in a reply (S09-D03, ADR 0029, FR-20, FR-17).
 *
 * A proposal is a list of immutable revisions kept with the reply record that produced it (`team_runs`, kind
 * `jit_reply`), so data deletion, correction, restore and backups cover it like the reply itself. Revision 1 is
 * Jit's, parsed from untrusted model output: it has a name, a responsibility and optionally a route that equals
 * one the owner has already configured. Everything else the model asked for (tools, budgets, unknown fields, a
 * route that is not configured) is dropped and named on the card. An owner edit appends an owner-authored
 * revision and supersedes the one before it. Only `role.proposal.accept` of the current revision creates a role,
 * through the `role.save` path in the same transaction and receipt. Model output never moves a proposal's state.
 */
export type RoleProposalState = "proposed" | "accepted" | "rejected" | "superseded";
/** One immutable revision. `author` is service-recorded: `jit` for parsed model output, `owner` for an edit. */
export interface RoleProposalRevision {
  revision: number; author: "jit" | "owner"; state: RoleProposalState;
  name: string; responsibility: string;
  /** A route the owner had configured when the revision was written; null inherits the default route. */
  route: RoleRoute | null;
  /** What was dropped from the model's suggestion, as safe codes (`field:tools`, `route:unconfigured`). */
  dropped: string[]; droppedTotal: number;
  createdAt: number; decidedAt: number | null;
}
/** Persisted with the reply record. Revisions are append-only; only the last one can be open. */
export interface RoleProposal { id: string; revisions: RoleProposalRevision[]; roleId: string | null }
/** Read model of one proposal: the current revision plus the history and what Jit's revision dropped. */
export interface RoleProposalView {
  id: string; replyId: string; projectId: string; topicId: string;
  revision: number; state: RoleProposalState; author: "jit" | "owner";
  name: string; responsibility: string; route: RoleRoute | null;
  dropped: string[]; droppedTotal: number;
  /** The role the accepted revision created. */
  roleId: string | null;
  /** Topic message sequence of the reply that carries the card, for page links. */
  replySequence: number | null;
  history: { revision: number; author: "jit" | "owner"; state: RoleProposalState }[];
  updatedAt: number;
}

interface ProposalTarget { topicId: string; replyId: string; proposalId: string }
/** Owner commands on one proposal. `expectedRevision` is the proposal revision on the card the owner saw. */
export type RoleProposalCommand = {
  kind: "role.proposal.accept"; requestId: string; projectId: string; expectedRevision: number; payload: ProposalTarget;
} | {
  kind: "role.proposal.reject"; requestId: string; projectId: string; expectedRevision: number; payload: ProposalTarget;
} | {
  kind: "role.proposal.revise"; requestId: string; projectId: string; expectedRevision: number;
  payload: ProposalTarget & { name: string; responsibility: string; route: RoleRoute | null };
};
/** Acknowledged only with its audit and receipt. Accept also carries the role and owner team revision of `role.save`. */
export interface RoleProposalReceipt { proposal: RoleProposalView; role?: Role; teamRevision?: number }

/** Most role proposals one reply may carry; the rest are discarded as `proposal:role`. */
export const roleProposalLimit = 2;
/** Most dropped codes kept per revision; the rest are counted. */
const droppedLimit = 8;
/** Name bound in characters. Role names are single-line. */
export const roleProposalNameChars = 80;
const proposalKeys = ["kind", "name", "responsibility", "route"];

const sameRoute = (a: RoleRoute, b: RoleRoute) => a.provider === b.provider && a.model === b.model && a.authRoute === b.authRoute;
const singleLine = (value: string) => !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value);
/** Responsibility is plain text: line breaks and tabs only. */
const plainText = (value: string) => !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
const validName = (value: string) => value.length > 0 && value.length <= roleProposalNameChars && value.isWellFormed() && singleLine(value);
const validResponsibility = (value: string, policy: TeamPolicy) => value.length > 0 && value.isWellFormed() && plainText(value) &&
  Buffer.byteLength(value) <= policy.responsibilityBytes;

/**
 * The routes the owner has configured, in a stable order: the owner default, each role's own route, then the
 * project default and the project's per-role overrides. A proposal may reference only these.
 */
export function configuredRoutes(tx: AppTransaction, projectId: string, policy: TeamPolicy): RoleRoute[] {
  return routesOf(readTeam(tx, projectId, policy));
}
/** {@link configuredRoutes} of an already read team configuration (the topic page's team read). */
export function routesOf(team: Pick<ReturnType<typeof readTeam>, "ownerDefault" | "roles" | "projectDefault" | "overrides">): RoleRoute[] {
  const found: RoleRoute[] = [];
  for (const route of [team.ownerDefault, ...team.roles.map(role => role.route), team.projectDefault, ...Object.values(team.overrides)]) {
    if (route && !found.some(known => sameRoute(known, route))) found.push(structuredClone(route));
  }
  return found;
}

/**
 * Trusted operator lines that describe the role proposal shape and list the configured routes by value. Route
 * aliases are opaque references, never credentials.
 */
export function roleProposalInstructions(routes: readonly RoleRoute[]): string[] {
  const list = routes.length ? routes.map(route => JSON.stringify(route)).join(", ") : "none (omit route)";
  return [
    `Optional "proposals": at most ${roleProposalLimit} entries {"kind":"role","name":string,"responsibility":string,"route"?:object} that suggest a new specialist when the owner asks for one or clearly needs one. A proposal is only a card the owner may create, edit or dismiss; it never creates a role, and it never names tools, budgets or new routes.`,
    `Configured routes a role proposal may reference exactly (omit route to use the default): ${list}`,
  ];
}

/**
 * Parses one untrusted `{"kind":"role"}` proposal into Jit's revision 1, or null when it has no usable name and
 * responsibility. Unknown keys and unusable routes are dropped and recorded; nothing is copied from key names.
 */
export function parseRoleProposal(item: unknown, routes: readonly RoleRoute[], policy: TeamPolicy, now: number): RoleProposal | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const value = item as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  const responsibility = typeof value.responsibility === "string" ? value.responsibility.trim() : "";
  if (!validName(name) || !validResponsibility(responsibility, policy)) return null;
  const dropped: string[] = [];
  let route: RoleRoute | null = null;
  if (value.route !== undefined && value.route !== null) {
    try {
      requireRoleRoute(value.route);
      const match = routes.find(known => sameRoute(known, value.route as RoleRoute));
      if (match) route = structuredClone(match); else dropped.push("route:unconfigured");
    } catch { dropped.push("route:invalid"); }
  }
  for (const key of Object.keys(value)) if (!proposalKeys.includes(key)) dropped.push(`field:${safeIdentifier(key)}`);
  return { id: crypto.randomUUID(), roleId: null, revisions: [{ revision: 1, author: "jit", state: "proposed", name, responsibility, route,
    dropped: dropped.slice(0, droppedLimit), droppedTotal: dropped.length, createdAt: now, decidedAt: null }] };
}

/** Projects stored proposals of one reply into read models. */
export function roleProposalViews(reply: { id: string; projectId: string; topicId: string }, proposals: readonly RoleProposal[] | undefined, replySequence: number | null): RoleProposalView[] {
  return (proposals ?? []).map(proposal => {
    const head = proposal.revisions.at(-1)!, first = proposal.revisions[0]!;
    return { id: proposal.id, replyId: reply.id, projectId: reply.projectId, topicId: reply.topicId,
      revision: head.revision, state: head.state, author: head.author, name: head.name, responsibility: head.responsibility, route: head.route,
      dropped: first.dropped, droppedTotal: first.droppedTotal, roleId: proposal.roleId, replySequence,
      history: proposal.revisions.map(item => ({ revision: item.revision, author: item.author, state: item.state })),
      updatedAt: head.decidedAt ?? head.createdAt };
  });
}

const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/** Validates the exact command shape and returns its receipt identity. */
export function roleProposalIdentity(command: RoleProposalCommand, policy: TeamPolicy): string {
  const kinds = ["role.proposal.accept", "role.proposal.reject", "role.proposal.revise"];
  const target = ["topicId", "replyId", "proposalId"];
  if (!exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) || !kinds.includes(command.kind) ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1 ||
      !exact(command.payload, command.kind === "role.proposal.revise" ? [...target, "name", "responsibility", "route"] : target)) {
    throw new AppError("invalid_role_proposal_command");
  }
  requireId(command.projectId); requireId(command.payload.topicId); requireId(command.payload.replyId); requireId(command.payload.proposalId);
  if (command.kind === "role.proposal.revise") {
    const p = command.payload;
    if (typeof p.name !== "string" || !validName(p.name.trim())) throw new AppError("invalid_role_proposal_command");
    if (typeof p.responsibility !== "string" || !validResponsibility(p.responsibility.trim(), policy)) throw new AppError("invalid_role_proposal_command");
    requireRoleRoute(p.route);
    return JSON.stringify([command.kind, command.projectId, command.expectedRevision, p.topicId, p.replyId, p.proposalId, p.name, p.responsibility, p.route]);
  }
  const p = command.payload;
  return JSON.stringify([command.kind, command.projectId, command.expectedRevision, p.topicId, p.replyId, p.proposalId]);
}

/**
 * Applies one owner command inside the caller's receipt transaction. The current revision must be open and equal
 * `expectedRevision`; accepted, rejected and superseded revisions are closed. Accept writes the role through
 * `role.save` (`mutateTeamConfiguration`) with the owner team revision read in this same transaction, so the role
 * and the accepted proposal commit together or not at all. A route is re-checked against the configured routes.
 */
export function executeRoleProposal(tx: AppTransaction, command: RoleProposalCommand, policy: TeamPolicy, now: number): RoleProposalReceipt {
  const record = readReplyRecord(tx, command.projectId, command.payload.replyId);
  const proposal = record.topicId === command.payload.topicId ? record.roleProposals?.find(item => item.id === command.payload.proposalId) : undefined;
  if (!proposal) throw new AppError("role_proposal_not_found", 404);
  const head = proposal.revisions.at(-1)!;
  if (head.state !== "proposed") throw new AppError("role_proposal_closed", 409);
  if (head.revision !== command.expectedRevision) throw new AppError("role_proposal_stale", 409);
  const routes = configuredRoutes(tx, command.projectId, policy);
  const configured = (route: RoleRoute | null) => !route || routes.some(known => sameRoute(known, route));
  let accepted: { role: Role; teamRevision: number } | null = null;
  if (command.kind === "role.proposal.accept") {
    if (!configured(head.route)) throw new AppError("route_not_configured", 409);
    const save: Extract<TeamCommand, { kind: "role.save" }> = { kind: "role.save", requestId: command.requestId, projectId: null,
      expectedRevision: readTeam(tx, null, policy).ownerRevision,
      payload: { roleId: null, name: head.name, kind: "specialist", responsibility: head.responsibility, enabled: true, route: head.route } };
    teamIdentity(save, policy);
    const saved = mutateTeamConfiguration(tx, save, policy, now);
    accepted = { role: saved.role!, teamRevision: saved.revision };
    head.state = "accepted"; head.decidedAt = now; proposal.roleId = saved.role!.id;
  } else if (command.kind === "role.proposal.reject") {
    head.state = "rejected"; head.decidedAt = now;
  } else {
    const p = command.payload;
    if (!configured(p.route)) throw new AppError("route_not_configured", 409);
    head.state = "superseded"; head.decidedAt = now;
    proposal.revisions.push({ revision: head.revision + 1, author: "owner", state: "proposed", name: p.name.trim(), responsibility: p.responsibility.trim(),
      route: p.route ? structuredClone(p.route) : null, dropped: [], droppedTotal: 0, createdAt: now, decidedAt: null });
  }
  record.updatedAt = now;
  saveReplyRecord(tx, record);
  const sequence = record.replyMessageId
    ? tx.get<{ sequence: number }>("SELECT sequence FROM messages WHERE id = ?", record.replyMessageId)?.sequence ?? null : null;
  const view = roleProposalViews(record, [proposal], sequence)[0]!;
  return { proposal: view, ...accepted };
}
