import { AppError } from "../errors";
import type { AppConfig } from "../config";
import { JobQueue, readJob } from "../jobs/queue";
import type { JobLimits } from "../jobs/types";
import { lookupSource, requireId, type SourceReference } from "../sources";
import type { AppTransaction } from "../store";
import { allowanceCeiling, readDispatchAllowance } from "./allowance";
import { readTeam } from "./configuration";
import { readDecisionModel } from "./decisions";
import { prepareDispatch, projectDiscussion, readDiscussion, readSpecialist } from "./dispatch";
import { admitTeamReply, readReply, replyLimits, type JitReplyView, type ReplyNotAdmitted, type TeamReplyGap, type TeamReplyResult } from "./jit-reply";
import type { Discussion, DiscussionOrigin, DiscussionParticipation, SynthesisState } from "./types";
import { promotionFrom } from "../promotion";
import { blockedForRequest, citableResult, unblockAction } from "./specialist-results";

/** Lifecycle of one dispatch proposal. Only `admitted` (standing allowance) and `accepted` (owner) start work. */
export type DispatchProposalState = "admitted" | "proposed" | "accepted" | "dismissed" | "empty";
/** Why a proposal waits for the owner instead of starting under the allowance. */
export type DispatchHoldReason = "over_allowance" | "allowance_disabled" | "queue_full" | "scheduler_unavailable" | "not_admitted";

/** Identity-only record: validated role ids and names from owner configuration; never the model's text. */
interface DispatchRecord {
  roles: { roleId: string; roleName: string }[];
  /**
   * What the service dropped: names that match no role (count only), names shared by several eligible specialists
   * (count only), disabled/unrouted roles, the coordinator, roles over the ceiling.
   */
  dropped: { unknown: number; ambiguous: number; disabled: string[]; coordinator: number; overCeiling: number };
  reason: DispatchHoldReason | null;
  /** Roles the owner accepted from the card (a subset of `roles`). */
  acceptedRoleIds: string[] | null;
  /** Why the latest team reply admission did not start (queue full, no route, …); the owner may answer again. */
  teamHold?: ReplyNotAdmitted | null;
  /**
   * app.specialist_results/v2: named roles Jit did not call again because their latest result for this same request
   * is still blocked, with the unblock action to show instead. Absent on records written before v2.
   */
  blocked?: { roleId: string; roleName: string; runId: string }[];
}

/** A role held back from a dispatch because its latest result for the same request is blocked, with its unblock action. */
export interface BlockedRole { roleId: string; roleName: string; runId: string; unblock: string | null }

interface ProposalRow {
  id: string; projectId: string; topicId: string; replyId: string; revision: number; state: DispatchProposalState;
  admission: "standing_allowance" | "owner" | null; allowanceRevision: number; discussionId: string | null; teamReplyId: string | null;
  recordJson: string; createdAt: number; updatedAt: number;
}
const columnsOf = (alias: string) => `${alias}id, ${alias}project_id AS projectId, ${alias}topic_id AS topicId, ${alias}reply_id AS replyId,
  ${alias}revision, ${alias}state, ${alias}admission, ${alias}allowance_revision AS allowanceRevision, ${alias}discussion_id AS discussionId,
  ${alias}team_reply_id AS teamReplyId, ${alias}record_json AS recordJson, ${alias}created_at AS createdAt, ${alias}updated_at AS updatedAt`;
const proposalColumns = columnsOf("");

/** One role on the team card: projected participation plus its committed opinion text when still available. */
export interface TeamCardRole extends DiscussionParticipation {
  /** `live` while queued or running, `waiting` on its original route, otherwise `settled`. */
  activity: "live" | "waiting" | "settled";
  opinion: { reference: SourceReference; text: string | null } | null;
}

/**
 * app.dispatch_allowance/v1 read model behind one proposal or team card. Reads persisted state only; it never
 * admits, resumes or reconnects work.
 */
export interface DispatchCardView {
  id: string; projectId: string; topicId: string; replyId: string; replyMessageId: string;
  /** Topic sequence of the dispatching Jit reply, so links open the page that holds the card. */
  anchorSequence: number; revision: number;
  state: DispatchProposalState; admission: "standing_allowance" | "owner" | null; allowanceRevision: number;
  reason: DispatchHoldReason | null; roles: { roleId: string; roleName: string }[]; dropped: DispatchRecord["dropped"];
  acceptedRoleIds: string[] | null;
  /** Named roles Jit did not call again because they are still blocked on this request, with their unblock action. */
  blocked: BlockedRole[];
  /** Why Jit could not start the team reply last time; null when it started or was never tried. */
  teamHold: ReplyNotAdmitted | null;
  discussion: { id: string; revision: number; origin: DiscussionOrigin | null; stoppedAll: boolean; coverageGap: string[]; roles: TeamCardRole[] } | null;
  teamReply: JitReplyView | null;
  /** The owner may ask Jit to answer now: the team was started, nothing runs, a result exists and no team reply yet. */
  canAnswer: boolean; canStopAll: boolean;
  /** Existing decision path (ADR 0015): the latest synthesis and proposal for this discussion. */
  decision: { synthesis: SynthesisState | null; proposalId: string | null; proposalRevision: number | null; decided: boolean } | null;
  createdAt: number;
}

/** Owner commands on a dispatch proposal card. Model text is never a member of this union. */
export type DispatchCommand = {
  kind: "dispatch.proposal.accept"; requestId: string; projectId: string; expectedRevision: number;
  payload: { proposalId: string; roleIds: string[] };
} | {
  kind: "dispatch.proposal.dismiss"; requestId: string; projectId: string; expectedRevision: number; payload: { proposalId: string };
} | {
  /** Ask Jit to answer now from the committed results, for example after a role hit a deadline outside any callback. */
  kind: "dispatch.answer"; requestId: string; projectId: string; expectedRevision: number; payload: { proposalId: string };
};
export interface DispatchReceipt { proposal: DispatchCardView }

const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/** Validates a dispatch command and returns its receipt identity. */
export function dispatchIdentity(command: DispatchCommand, config: AppConfig): string {
  if (!exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) ||
      !["dispatch.proposal.accept", "dispatch.proposal.dismiss", "dispatch.answer"].includes(command.kind) ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) throw new AppError("invalid_dispatch_command");
  requireId(command.projectId);
  if (command.kind === "dispatch.proposal.accept") {
    if (!exact(command.payload, ["proposalId", "roleIds"]) || !Array.isArray(command.payload.roleIds) || command.payload.roleIds.length < 1 ||
        command.payload.roleIds.length > allowanceCeiling(config) || new Set(command.payload.roleIds).size !== command.payload.roleIds.length) {
      throw new AppError("invalid_dispatch_command");
    }
    for (const id of command.payload.roleIds) requireId(id);
  } else if (!exact(command.payload, ["proposalId"])) throw new AppError("invalid_dispatch_command");
  requireId(command.payload.proposalId);
  return JSON.stringify([command.kind, command.projectId, command.expectedRevision, command.payload]);
}

function withSavepoint<T>(tx: AppTransaction, name: string, run: () => T): T {
  tx.run(`SAVEPOINT ${name}`);
  try {
    const result = run();
    tx.run(`RELEASE ${name}`);
    return result;
  } catch (error) {
    tx.run(`ROLLBACK TO ${name}`);
    tx.run(`RELEASE ${name}`);
    throw error;
  }
}

function readProposalRow(tx: AppTransaction, projectId: string, proposalId: string): ProposalRow {
  const row = tx.get<ProposalRow>(`SELECT ${proposalColumns} FROM dispatch_proposals WHERE project_id = ? AND id = ?`, projectId, proposalId);
  if (!row) throw new AppError("dispatch_proposal_not_found", 404);
  return row;
}

/**
 * Finite limits for one discussion a dispatch proposal starts: the reply's per-attempt budgets, with a role budget
 * that covers the named roles and their retries, inside the installation maximum.
 */
export function dispatchLimits(config: AppConfig, roleCount: number): JobLimits {
  const base = replyLimits(config.jobs.maximum, config.team.contextBytes);
  return { ...base, roles: Math.min(Math.max(roleCount, base.roles), config.jobs.maximum.roles) };
}

/**
 * The discussion purpose from the owner's message: whitespace collapsed and cut to the job purpose limit (300 UTF-16
 * units, the unit `jobs.queue_admission/v1` counts) without splitting a surrogate pair.
 */
export function dispatchPurpose(text: string): string {
  let purpose = "";
  for (const char of text.replace(/\s+/g, " ").trim()) {
    if (purpose.length + char.length > 300) break;
    purpose += char;
  }
  return purpose.trim() || "Jit dispatch";
}

/** The owner message a Jit reply answered, and the discussion purpose it gives; null when its source is unavailable. */
function ownerRequest(tx: AppTransaction, projectId: string, replyId: string) {
  const reply = tx.get<{ messageId: string }>("SELECT message_id AS messageId FROM jit_replies WHERE id = ?", replyId)!;
  const message = tx.get<{ sourceId: string; revision: number; generation: number }>(
    "SELECT source_id AS sourceId, source_revision AS revision, source_generation AS generation FROM messages WHERE id = ?", reply.messageId)!;
  const source = lookupSource(tx, projectId, message);
  return source.state === "available" ? { source, purpose: dispatchPurpose(source.text) } : null;
}

/**
 * Starts the discussion through the existing `team.dispatch` router/dispatch path (prepareDispatch): the named roles
 * are the owner-side include list and every other eligible specialist is excluded, so the router can select only
 * them. The frozen source is the owner's message. The origin records who authorized it.
 */
function startDiscussion(tx: AppTransaction, input: {
  row: ProposalRow; roleIds: string[]; origin: DiscussionOrigin; requestId: string; config: AppConfig; queue: JobQueue | undefined; generation: number; now: number;
}): Discussion {
  const { row, config } = input;
  const request = ownerRequest(tx, row.projectId, row.replyId);
  if (!request) throw new AppError("dispatch_source_unavailable", 409);
  const { source, purpose } = request;
  const team = readTeam(tx, row.projectId, config.team);
  const exclude = team.roles.filter(role => role.kind === "specialist" && role.enabled && role.effective.route && !input.roleIds.includes(role.id)).map(role => role.id);
  const project = tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", row.projectId)!;
  const receipt = prepareDispatch(tx, {
    kind: "team.dispatch", requestId: input.requestId, projectId: row.projectId, expectedRevision: project.revision,
    payload: { topicId: row.topicId, purpose, sources: [source.reference], include: input.roleIds, exclude, limits: dispatchLimits(config, input.roleIds.length) },
  }, config, input.queue, input.generation, input.now);
  const discussion = readDiscussion(tx, row.projectId, receipt.discussion!.id);
  discussion.origin = input.origin;
  tx.run("UPDATE team_runs SET record_json = ? WHERE id = ?", JSON.stringify(discussion), discussion.id);
  return discussion;
}

/**
 * app.dispatch_allowance/v1 admission, inside the fenced commit of the Jit reply that named specialists (ADR 0030).
 * Names are matched against the owner's configuration: unknown names, disabled or unrouted roles, the coordinator and
 * roles beyond the operator ceiling are dropped. If the remaining roles fit the allowance current at admission and it
 * is enabled, a normal `team.discussion` starts through the existing router/dispatch path, attributed
 * `standing-allowance` with the allowance revision. Otherwise the proposal waits for the owner's card. A failure to
 * start (queue full, scheduler unavailable) never rolls back the reply; the proposal then waits for the owner too.
 */
export function admitJitDispatch(tx: AppTransaction, input: {
  reply: { id: string; projectId: string; topicId: string; messageId: string; replyMessageId: string; generation: number };
  names: readonly string[]; config: AppConfig; queue: JobQueue | undefined; now: number;
}): void {
  const { reply, config, now } = input;
  const team = readTeam(tx, reply.projectId, config.team);
  const ceiling = allowanceCeiling(config);
  const record: DispatchRecord = { roles: [], dropped: { unknown: 0, ambiguous: 0, disabled: [], coordinator: 0, overCeiling: 0 }, reason: null, acceptedRoleIds: null, teamHold: null };
  const keyOf = (name: string) => name.normalize("NFC").toLocaleLowerCase();
  const eligible = (role: (typeof team.roles)[number]) => role.kind === "specialist" && role.enabled && !!role.effective.route;
  const seen = new Set<string>();
  for (const name of input.names) {
    const key = keyOf(name);
    if (seen.has(key)) continue;
    seen.add(key);
    // Role names need not be unique: an eligible specialist is never shadowed by a namesake, and a name shared by
    // several eligible specialists names nobody, because the service will not guess which one the model meant.
    const matches = team.roles.filter(item => keyOf(item.name) === key), callable = matches.filter(eligible);
    if (!matches.length) record.dropped.unknown++;
    else if (callable.length > 1) record.dropped.ambiguous++;
    else if (callable.length === 1) {
      if (record.roles.some(role => role.roleId === callable[0]!.id)) continue;
      if (record.roles.length >= ceiling) record.dropped.overCeiling++;
      else record.roles.push({ roleId: callable[0]!.id, roleName: callable[0]!.name });
    } else if (matches.some(item => item.kind === "specialist")) record.dropped.disabled.push(matches.find(item => item.kind === "specialist")!.name);
    else record.dropped.coordinator++;
  }
  // app.specialist_results/v2: a role whose latest result for this same request (topic and purpose) is still blocked
  // is not called again; the card shows its unblock action instead. A different request is unaffected.
  const purpose = ownerRequest(tx, reply.projectId, reply.id)?.purpose;
  if (purpose !== undefined) {
    const blocked: NonNullable<DispatchRecord["blocked"]> = [];
    record.roles = record.roles.filter(role => {
      const held = blockedForRequest(tx, { projectId: reply.projectId, topicId: reply.topicId, roleId: role.roleId, purpose });
      if (!held) return true;
      blocked.push({ ...role, runId: held.runId });
      return false;
    });
    if (blocked.length) record.blocked = blocked;
  }
  const allowance = readDispatchAllowance(tx, reply.projectId, config);
  const row: ProposalRow = {
    id: crypto.randomUUID(), projectId: reply.projectId, topicId: reply.topicId, replyId: reply.id, revision: 1, state: "proposed",
    admission: null, allowanceRevision: allowance.revision, discussionId: null, teamReplyId: null, recordJson: "", createdAt: now, updatedAt: now,
  };
  tx.run(`INSERT INTO dispatch_proposals (id, project_id, topic_id, reply_id, revision, state, admission, allowance_revision, discussion_id, team_reply_id, record_json, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, 'proposed', NULL, ?, NULL, NULL, '{}', ?, ?)`, row.id, row.projectId, row.topicId, row.replyId, row.allowanceRevision, now, now);
  if (!record.roles.length) { row.state = "empty"; return saveRow(tx, row, record); }
  if (!allowance.enabled) { record.reason = "allowance_disabled"; return saveRow(tx, row, record); }
  if (record.roles.length > allowance.effectiveMaxRoles) { record.reason = "over_allowance"; return saveRow(tx, row, record); }
  if (!input.queue || !input.queue.available(tx)) { record.reason = "scheduler_unavailable"; return saveRow(tx, row, record); }
  try {
    const discussion = withSavepoint(tx, "jit_dispatch", () => startDiscussion(tx, {
      row, roleIds: record.roles.map(role => role.roleId), requestId: `allowance-${reply.id}`, config, queue: input.queue, generation: reply.generation, now,
      origin: { kind: "standing-allowance", proposalId: row.id, replyId: reply.id, allowanceRevision: allowance.revision },
    }));
    row.state = "admitted"; row.admission = "standing_allowance"; row.discussionId = discussion.id;
  } catch (error) {
    record.reason = error instanceof AppError && (error.code === "job_queue_full") ? "queue_full"
      : error instanceof AppError && error.code === "scheduler_unavailable" ? "scheduler_unavailable" : "not_admitted";
  }
  saveRow(tx, row, record);
}

function saveRow(tx: AppTransaction, row: ProposalRow, record: DispatchRecord): void {
  tx.run(`UPDATE dispatch_proposals SET revision = ?, state = ?, admission = ?, discussion_id = ?, team_reply_id = ?, record_json = ?, updated_at = ?
    WHERE id = ?`, row.revision, row.state, row.admission, row.discussionId, row.teamReplyId, JSON.stringify(record), row.updatedAt, row.id);
}

/** Classifies a projected participation for the card and for settling: work that may still produce a result is not settled. */
function activity(tx: AppTransaction, projectId: string, item: DiscussionParticipation): TeamCardRole["activity"] {
  if (item.state === "queued" || item.state === "running") return "live";
  if (item.state !== "blocked") return "settled";
  // A committed outcome is final even while its own commit is still in flight (the job is then still admitted).
  if (readSpecialist(tx, projectId, item.runId).outcome) return "settled";
  const job = readJob(tx, projectId, item.jobId);
  return job.state === "waiting" ? "waiting" : job.state === "queued" || job.state === "admitted" ? "live" : "settled";
}

/** Committed, still available results and the coverage gap, frozen for a team reply. Skipped or excluded roles are the owner's choice, not a gap. */
function teamResults(tx: AppTransaction, discussion: Discussion): { results: TeamReplyResult[]; gaps: TeamReplyGap[] } {
  const results: TeamReplyResult[] = [], gaps: TeamReplyGap[] = [];
  for (const item of projectDiscussion(tx, discussion).participations) {
    // app.specialist_results/v2: blocked, failed and incomplete results are gaps; a blocked one carries its unblock action.
    if (item.state === "completed" && item.output && !citableResult(item.result)) {
      gaps.push({ roleId: item.roleId, roleName: item.roleName, reason: `result_${item.result!.status}`, ...item.result!.status === "blocked" ? { runId: item.runId } : {} });
    } else if (item.state === "completed" && item.output) {
      const found = lookupSource(tx, discussion.projectId, item.output);
      if (found.state === "available") results.push({ roleId: item.roleId, roleName: item.roleName, reference: found.reference, text: found.text });
      else gaps.push({ roleId: item.roleId, roleName: item.roleName, reason: "source_unavailable" });
    } else if (item.state !== "skipped" && item.state !== "excluded") gaps.push({ roleId: item.roleId, roleName: item.roleName, reason: item.reason ?? item.state });
  }
  return { results, gaps };
}

/** Signals a team reply admission that did not start, so its anchor row is rolled back and the owner may retry. */
class TeamHold extends Error { constructor(readonly reason: ReplyNotAdmitted) { super(reason); } }

/**
 * Admits the team reply. Its anchor is the dispatching reply message; its question is the owner message that reply
 * answered. If admission does not start (queue full, scheduler or route unavailable, context too large), the anchor
 * row is rolled back so `message_id` stays free, the reason is kept on the proposal and the owner can answer again.
 * Returns "empty" when no result exists yet.
 */
function admitTeam(tx: AppTransaction, row: ProposalRow, discussion: Discussion, input: {
  requestId: string; config: AppConfig; queue: JobQueue | undefined; generation: number; now: number;
}): "admitted" | "empty" | ReplyNotAdmitted {
  const { results, gaps } = teamResults(tx, discussion);
  if (!results.length) return "empty";
  type Message = { id: string; sequence: number; sourceId: string; revision: number; generation: number };
  const columns = "m.id, m.sequence, m.source_id AS sourceId, m.source_revision AS revision, m.source_generation AS generation";
  const anchor = tx.get<Message>(`SELECT ${columns} FROM jit_replies r JOIN messages m ON m.id = r.reply_message_id WHERE r.id = ?`, row.replyId);
  const question = tx.get<Message>(`SELECT ${columns} FROM jit_replies r JOIN messages m ON m.id = r.message_id WHERE r.id = ?`, row.replyId);
  if (!anchor || !question) return "empty";
  const asAnchor = (m: Message) => ({ id: m.id, projectId: row.projectId, topicId: row.topicId, sequence: m.sequence,
    source: { sourceId: m.sourceId, revision: m.revision, generation: m.generation } });
  const record = JSON.parse(row.recordJson) as DispatchRecord;
  try {
    const replyId = withSavepoint(tx, "jit_team_admit", () => {
      const admitted = admitTeamReply(tx, { anchor: asAnchor(anchor), question: asAnchor(question), proposalId: row.id, discussionId: discussion.id, results, gaps,
        requestId: input.requestId, config: input.config, queue: input.queue, generation: input.generation, now: input.now });
      if (admitted.reason) throw new TeamHold(admitted.reason);
      return admitted.id;
    });
    row.teamReplyId = replyId; record.teamHold = null;
  } catch (error) {
    if (!(error instanceof TeamHold)) throw error;
    record.teamHold = error.reason;
  }
  row.revision += 1; row.updatedAt = input.now; row.recordJson = JSON.stringify(record);
  saveRow(tx, row, record);
  return record.teamHold ?? "admitted";
}

/**
 * Admits the team reply once a dispatched discussion has settled: no role queued, running or waiting on its route,
 * the team not stopped, and no team reply yet. Called inside the specialist result commit and the owner's control
 * transactions. A failure here is contained, so it never rolls back the result or the control that triggered it.
 */
export function settleDispatch(tx: AppTransaction, input: { projectId: string; discussionId: string; config: AppConfig; queue: JobQueue | undefined; now: number }): void {
  const row = tx.get<ProposalRow>(`SELECT ${proposalColumns} FROM dispatch_proposals WHERE project_id = ? AND discussion_id = ?`, input.projectId, input.discussionId);
  if (!row || row.teamReplyId || (row.state !== "admitted" && row.state !== "accepted")) return;
  try {
    withSavepoint(tx, "jit_team_reply", () => {
      const discussion = readDiscussion(tx, input.projectId, input.discussionId);
      if (discussion.stoppedAll) return;
      // app.topic_promotion/v1: a promoted origin is read-only; stopping or skipping there never starts a team reply.
      if (promotionFrom(tx, input.projectId, discussion.topicId)) return;
      const projected = projectDiscussion(tx, discussion);
      if (projected.participations.some(item => activity(tx, input.projectId, item) !== "settled")) return;
      // The team reply carries the authority of the discussion it speaks for.
      const generation = readJob(tx, input.projectId, discussion.jobId).authorization.generation;
      admitTeam(tx, row, discussion, { requestId: `team-reply-${row.id}`, config: input.config, queue: input.queue, generation, now: input.now });
    });
  } catch { /* The card offers "answer now"; the triggering result or control still commits. */ }
}

/** Owner commands on a proposal card: accept a subset of the proposed roles, dismiss it, or ask Jit to answer now. */
export function executeDispatchCommand(tx: AppTransaction, command: DispatchCommand, config: AppConfig, queue: JobQueue | undefined, generation: number, now: number): DispatchReceipt {
  const row = readProposalRow(tx, command.projectId, command.payload.proposalId);
  if (row.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  const record = JSON.parse(row.recordJson) as DispatchRecord;
  if (command.kind === "dispatch.proposal.accept") {
    if (row.state !== "proposed") throw new AppError("dispatch_proposal_closed", 409);
    if (!queue) throw new AppError("scheduler_unavailable", 503);
    const offered = new Set(record.roles.map(role => role.roleId));
    if (command.payload.roleIds.some(id => !offered.has(id))) throw new AppError("dispatch_role_not_proposed", 409);
    const discussion = startDiscussion(tx, {
      row, roleIds: command.payload.roleIds, requestId: command.requestId, config, queue, generation, now,
      origin: { kind: "owner-accepted", proposalId: row.id, replyId: row.replyId, allowanceRevision: row.allowanceRevision },
    });
    row.state = "accepted"; row.admission = "owner"; row.discussionId = discussion.id; record.acceptedRoleIds = [...command.payload.roleIds];
  } else if (command.kind === "dispatch.proposal.dismiss") {
    if (row.state !== "proposed") throw new AppError("dispatch_proposal_closed", 409);
    row.state = "dismissed";
  } else {
    if ((row.state !== "admitted" && row.state !== "accepted") || !row.discussionId || row.teamReplyId) throw new AppError("team_reply_not_ready", 409);
    const discussion = readDiscussion(tx, row.projectId, row.discussionId);
    if (projectDiscussion(tx, discussion).participations.some(item => activity(tx, row.projectId, item) === "live")) throw new AppError("team_reply_not_ready", 409);
    const outcome = admitTeam(tx, row, discussion, { requestId: command.requestId, config, queue, generation, now });
    if (outcome === "empty") throw new AppError("team_reply_not_ready", 409);
    // A hold is recorded on the card (with its next action) and the owner may answer again later.
    return { proposal: readCard(tx, readProposalRow(tx, row.projectId, row.id)) };
  }
  row.revision += 1; row.updatedAt = now;
  saveRow(tx, row, record);
  return { proposal: readCard(tx, readProposalRow(tx, row.projectId, row.id)) };
}

function readCard(tx: AppTransaction, row: ProposalRow): DispatchCardView {
  const record = JSON.parse(row.recordJson) as DispatchRecord;
  const anchor = tx.get<{ id: string; sequence: number }>("SELECT m.id, m.sequence FROM jit_replies r JOIN messages m ON m.id = r.reply_message_id WHERE r.id = ?", row.replyId)!;
  const replyMessageId = anchor.id;
  let discussion: DispatchCardView["discussion"] = null, canAnswer = false, canStopAll = false, decision: DispatchCardView["decision"] = null;
  const teamReply = row.teamReplyId ? readReply(tx, row.projectId, row.teamReplyId) : null;
  if (row.discussionId) {
    const stored = readDiscussion(tx, row.projectId, row.discussionId), projected = projectDiscussion(tx, stored);
    const roles = projected.participations.map(item => {
      const found = item.output ? lookupSource(tx, row.projectId, item.output) : null;
      return { ...item, activity: activity(tx, row.projectId, item),
        opinion: item.output ? { reference: item.output, text: found?.state === "available" ? found.text : null } : null };
    });
    discussion = { id: stored.id, revision: stored.revision, origin: stored.origin ?? null, stoppedAll: stored.stoppedAll === true, coverageGap: projected.coverageGap, roles };
    canStopAll = roles.some(item => item.activity !== "settled") || teamReply?.state === "thinking" || teamReply?.state === "blocked";
    canAnswer = !row.teamReplyId && !roles.some(item => item.activity === "live") &&
      roles.some(item => item.state === "completed" && citableResult(item.result) && item.opinion?.text !== null);
    const model = readDecisionModel(tx, row.projectId, row.topicId, stored.id);
    decision = { synthesis: model.synthesis?.state ?? null, proposalId: model.proposal?.id ?? null, proposalRevision: model.proposal?.revision ?? null,
      decided: model.decisions.some(entry => entry.decision.supersededBy === null) };
  }
  return {
    id: row.id, projectId: row.projectId, topicId: row.topicId, replyId: row.replyId, replyMessageId, anchorSequence: anchor.sequence, revision: row.revision, state: row.state,
    admission: row.admission, allowanceRevision: row.allowanceRevision, reason: record.reason, roles: record.roles, dropped: record.dropped,
    acceptedRoleIds: record.acceptedRoleIds, blocked: (record.blocked ?? []).map(role => ({ ...role, unblock: unblockAction(tx, row.projectId, role.runId) })), teamHold: record.teamHold ?? null, discussion, teamReply, canAnswer, canStopAll, decision, createdAt: row.createdAt,
  };
}

/** One proposal by id within its project. */
export function readDispatchCard(tx: AppTransaction, projectId: string, proposalId: string): DispatchCardView {
  return readCard(tx, readProposalRow(tx, projectId, proposalId));
}

/**
 * app.dispatch_allowance/v1: the proposal and team cards of one topic whose dispatching Jit reply is one of the given
 * messages, keyed by that reply message id, so a page shows each card under the reply that asked for it.
 */
export function readDispatchCards(tx: AppTransaction, projectId: string, topicId: string, messageIds: readonly string[]): Map<string, DispatchCardView> {
  const cards = new Map<string, DispatchCardView>();
  for (let index = 0; index < messageIds.length; index += 200) {
    const batch = messageIds.slice(index, index + 200);
    if (!batch.length) continue;
    const marks = batch.map(() => "?").join(",");
    // A page shows the card under its dispatching reply, and the citations under a team reply on a later page.
    for (const row of tx.all<ProposalRow>(`SELECT ${columnsOf("p.")} FROM dispatch_proposals p JOIN jit_replies r ON r.id = p.reply_id
      LEFT JOIN jit_replies t ON t.id = p.team_reply_id
      WHERE p.project_id = ? AND p.topic_id = ? AND (r.reply_message_id IN (${marks}) OR t.reply_message_id IN (${marks}))`, projectId, topicId, ...batch, ...batch)) {
      const card = readCard(tx, row);
      cards.set(card.replyMessageId, card);
    }
  }
  return cards;
}

/** Discussion ids whose specialist messages a team card shows, so the chat column can fold them into the card. */
export function cardDiscussionIds(cards: Iterable<DispatchCardView>): Set<string> {
  return new Set([...cards].flatMap(card => card.discussion ? [card.discussion.id] : []));
}
