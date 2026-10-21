import { createHash } from "node:crypto";
import { AppError, type AppErrorDetail } from "./errors";
import { jobData } from "./jobs/queue";
import { commitOwnerSource, lookupSource, requireId, requireReference, requireText, type SourceLookup, type SourceReference } from "./sources";
import type { AppTransaction } from "./store";
import { readDecisionModel } from "./team/decisions";
import type { DecisionReadModel } from "./team/types";

/** Ingress label stored on a task receipt. Telegram transport itself is not this slice. */
export type TaskChannel = "web" | "telegram";
export type TaskState = "proposed" | "accepted" | "ready_for_review" | "completed" | "dismissed" | "cancelled" | "superseded";
export type TaskOrigin = "owner" | "validated_output";
export type TaskEventKind =
  | "proposed" | "edited" | "dismissed" | "accepted" | "cancelled" | "completed" | "reopened" | "superseded" | "policy_changed" | "ready_for_review";
export type TaskEvidenceWorkType = "analysis" | "review" | "reminder";
export type TaskEvidenceOutcome = "complete" | "partial" | "failed" | "unknown";
export type TaskDeliveryState = "sent" | "failed" | "unknown";
export type CompletionPolicyKind = "owner_confirmed" | "evidence_satisfied";

/** Registered completion policies the owner may select. Generic auto-completion rules are not accepted. */
export const REGISTERED_COMPLETION_POLICIES = ["owner_confirmed", "evidence_satisfied"] as const;

/** Default MVP user-task completion remains owner-confirmed. Model output cannot change this. */
export const DEFAULT_USER_TASK_POLICY: CompletionPolicy = { kind: "owner_confirmed", workType: "user_task" };

/** Work-type completion policy stored on an accepted obligation. */
export interface CompletionPolicy { kind: CompletionPolicyKind; workType: "user_task" }

/** Owner revisioned confirmation that closes an obligation with optional cited evidence. */
export interface TaskCompletion {
  actorId: "owner"; channel: TaskChannel; proposalId: string; proposalRevision: number;
  evidence: SourceReference[]; note: string | null; completedAt: number;
}

/** Why an accepted obligation is not yet ready to close. Job success alone does not clear this. */
export interface TaskPendingReason {
  kind: "awaiting_owner" | "review_partial" | "job_failed" | "delivery_unknown" | "evidence_stale" | "awaiting_complete_evidence";
  detail: string;
}

/** Immutable evidence artifact from analysis, review, or reminder work. */
export interface TaskEvidenceArtifact {
  id: string; taskId: string; projectId: string; revision: number; workType: TaskEvidenceWorkType;
  outcome: TaskEvidenceOutcome; deliveryState: TaskDeliveryState | null; source: SourceReference; createdAt: number;
}

/**
 * app.task_commands/v1
 * Owner commands for proposing, editing, dismissing, accepting, cancelling, completing, or refusing to start a task.
 * Model text is not a member of this union. Acceptance is not permission to edit, run, or build.
 */
export type TaskCommand = {
  kind: "task.propose"; requestId: string; projectId: string; expectedRevision: number;
  payload: { topicId: string; title: string; summary: string; source?: SourceReference };
} | {
  kind: "task.edit"; requestId: string; projectId: string; expectedRevision: number;
  payload: { taskId: string; title: string; summary: string; source?: SourceReference };
} | {
  kind: "task.dismiss"; requestId: string; projectId: string; expectedRevision: number;
  payload: { taskId: string; proposalId: string; reason: string };
} | {
  kind: "task.accept"; requestId: string; projectId: string; expectedRevision: number;
  payload: { taskId: string; proposalId: string };
} | {
  kind: "task.cancel"; requestId: string; projectId: string; expectedRevision: number;
  payload: { taskId: string; reason: string };
} | {
  kind: "task.start"; requestId: string; projectId: string; expectedRevision: number;
  payload: { taskId: string };
} | {
  kind: "task.set_policy"; requestId: string; projectId: string; expectedRevision: number;
  payload: { taskId: string; policyKind: CompletionPolicyKind };
} | {
  kind: "task.complete"; requestId: string; projectId: string; expectedRevision: number;
  payload: { taskId: string; note?: string; evidence?: SourceReference[] };
} | {
  kind: "task.reopen"; requestId: string; projectId: string; expectedRevision: number;
  payload: { taskId: string; reason: string };
} | {
  kind: "task.supersede"; requestId: string; projectId: string; expectedRevision: number;
  payload: { taskId: string; reason: string; successorTaskId?: string };
};

/** One immutable proposal revision. Later edits append a revision; they do not rewrite this row. */
export interface TaskProposal {
  id: string; taskId: string; projectId: string; revision: number; title: string; summary: string;
  source: SourceReference; origin: TaskOrigin; createdAt: number;
}
/** Owner acceptance of one proposal revision. The actor is the installation owner, never a model. */
export interface TaskAcceptance {
  actorId: "owner"; channel: TaskChannel; proposalId: string; proposalRevision: number; acceptedAt: number;
}
/**
 * app.task_read_model/v1
 * One project obligation. `proposed` is not an obligation. `accepted` still does not start execution.
 */
export interface TaskRecord {
  id: string; projectId: string; topicId: string; state: TaskState; revision: number;
  title: string; summary: string; source: SourceReference; origin: TaskOrigin;
  acceptance: TaskAcceptance | null; closedReason: string | null;
  completionPolicy: CompletionPolicy; completion: TaskCompletion | null; pendingReason: TaskPendingReason | null;
  supersededBy: string | null; createdAt: number; updatedAt: number;
}
/** Append-only owner action. A refused start is not recorded, because that command commits nothing. */
export interface TaskEvent {
  sequence: number; taskId: string; kind: TaskEventKind; actorId: "owner"; channel: TaskChannel;
  proposalId: string | null; proposalRevision: number | null; reason: string | null; createdAt: number;
}
/** Current task, its proposal history, policy, evidence artifacts, and the exact source the current revision cites. */
export interface TaskReadModel {
  task: TaskRecord; proposals: TaskProposal[]; events: TaskEvent[]; source: SourceLookup;
  evidenceArtifacts: TaskEvidenceArtifact[];
}
/** Current obligations grouped by lifecycle. Cancelled and superseded rows are inactive, not active work. */
export interface TaskList {
  proposed: TaskRecord[]; accepted: TaskRecord[]; readyForReview: TaskRecord[];
  completed: TaskRecord[]; inactive: TaskRecord[];
}
/** Authoritative project continuity for memory, team, and Telegram adapters without inference. */
export interface ProjectContinuity {
  projectId: string; obligations: TaskList; activeObligations: TaskRecord[];
  decisions: Array<{ topicId: string; model: DecisionReadModel }>; queriedAt: number;
}
/** Receipt returned only after the task transaction commits. Replay returns this same value. */
export interface TaskReceipt { task: TaskRecord; proposal: TaskProposal; event: TaskEvent }

const taskKinds = [
  "task.propose", "task.edit", "task.dismiss", "task.accept", "task.cancel", "task.start",
  "task.set_policy", "task.complete", "task.reopen", "task.supersede",
] as const;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const exact = (value: object, keys: string[]) => Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const inactiveStates: TaskState[] = ["dismissed", "cancelled", "superseded"];
const activeObligationStates: TaskState[] = ["proposed", "accepted", "ready_for_review"];

/** Narrows a command to the task union without accepting extra kinds as conversation commands. */
export function isTaskCommand(command: { kind?: unknown } | null | undefined): command is TaskCommand {
  return !!command && typeof command.kind === "string" && (taskKinds as readonly string[]).includes(command.kind);
}

/**
 * app.task_commands/v1
 * Fingerprints one owner task command. Replay of the same request id and hash returns the original receipt.
 * The same request id with a different payload conflicts and is not stored as an edit.
 */
export function taskIdentity(command: TaskCommand, maximumBytes: number): string {
  if (!command || !exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) ||
      !(taskKinds as readonly string[]).includes(command.kind) ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
      !command.payload || typeof command.payload !== "object" || Array.isArray(command.payload)) throw new AppError("invalid_task_command");
  requireId(command.projectId);
  const payload = command.payload as unknown as Record<string, unknown>;
  if (command.kind === "task.propose" || command.kind === "task.edit") {
    const keys = command.kind === "task.propose" ? ["topicId", "title", "summary"] : ["taskId", "title", "summary"];
    const withSource = [...keys, "source"];
    if (!exact(payload, keys) && !exact(payload, withSource)) throw new AppError("invalid_task_command");
    if (command.kind === "task.propose") requireId(payload.topicId);
    else requireId(payload.taskId);
    boundWording(payload.title, payload.summary, maximumBytes);
    if ("source" in payload) parseSource(payload.source);
  } else if (command.kind === "task.dismiss") {
    if (!exact(payload, ["taskId", "proposalId", "reason"])) throw new AppError("invalid_task_command");
    requireId(payload.taskId); requireId(payload.proposalId); boundReason(payload.reason);
  } else if (command.kind === "task.accept") {
    if (!exact(payload, ["taskId", "proposalId"])) throw new AppError("invalid_task_command");
    requireId(payload.taskId); requireId(payload.proposalId);
  } else if (command.kind === "task.cancel" || command.kind === "task.reopen" || command.kind === "task.supersede") {
    if (!exact(payload, ["taskId", "reason"])) throw new AppError("invalid_task_command");
    requireId(payload.taskId); boundReason(payload.reason);
    if (command.kind === "task.supersede" && "successorTaskId" in payload) {
      if (!exact(payload, ["taskId", "reason", "successorTaskId"])) throw new AppError("invalid_task_command");
      requireId(payload.successorTaskId);
    }
  } else if (command.kind === "task.start") {
    if (!exact(payload, ["taskId"])) throw new AppError("invalid_task_command");
    requireId(payload.taskId);
  } else if (command.kind === "task.set_policy") {
    if (!exact(payload, ["taskId", "policyKind"])) throw new AppError("invalid_task_command");
    requireId(payload.taskId);
    if (!REGISTERED_COMPLETION_POLICIES.includes(payload.policyKind as CompletionPolicyKind)) throw new AppError("invalid_task_command");
  } else if (command.kind === "task.complete") {
    if (!exact(payload, ["taskId"]) && !exact(payload, ["taskId", "note"]) && !exact(payload, ["taskId", "evidence"])
        && !exact(payload, ["taskId", "note", "evidence"])) throw new AppError("invalid_task_command");
    requireId(payload.taskId);
    if ("note" in payload) boundReason(payload.note);
    if ("evidence" in payload) {
      if (!Array.isArray(payload.evidence)) throw new AppError("invalid_task_command");
      for (const item of payload.evidence) parseSource(item);
    }
  } else throw new AppError("invalid_task_command");
  return digest(jobData(command, maximumBytes + 4096));
}

/**
 * app.task_read_model/v1
 * Lists obligations by current state. Inactive rows exclude cancelled and superseded from active work.
 */
export function readTaskList(tx: AppTransaction, projectId: string, limit: number): TaskList {
  requireId(projectId);
  const rows = tx.all<TaskRow>(`SELECT ${taskColumns} FROM tasks WHERE project_id = ? ORDER BY updated_at, id`, projectId)
    .map(projectTask);
  const take = (state: TaskState) => rows.filter(task => task.state === state).slice(0, limit);
  return {
    proposed: take("proposed"), accepted: take("accepted"), readyForReview: take("ready_for_review"),
    completed: take("completed"), inactive: rows.filter(task => inactiveStates.includes(task.state)).slice(0, limit),
  };
}

/**
 * app.project_continuity/v1
 * Returns current obligations and owner decisions from committed state only. No provider inference is required.
 */
export function readProjectContinuity(tx: AppTransaction, projectId: string, limit: number, now: number): ProjectContinuity {
  requireId(projectId);
  const obligations = readTaskList(tx, projectId, limit);
  const activeObligations = [...obligations.proposed, ...obligations.accepted, ...obligations.readyForReview];
  const topicIds = tx.all<{ topicId: string }>("SELECT DISTINCT topic_id AS topicId FROM tasks WHERE project_id = ?", projectId)
    .map(row => row.topicId);
  const decisions = topicIds.map(topicId => ({ topicId, model: readDecisionModel(tx, projectId, topicId) }));
  return { projectId, obligations, activeObligations, decisions, queriedAt: now };
}

/**
 * app.task_read_model/v1
 * Reads one task, its proposal revisions, owner events, completion policy, and current source availability.
 */
export function readTaskModel(tx: AppTransaction, projectId: string, taskId: string): TaskReadModel {
  const task = projectTask(requireTask(tx, projectId, taskId));
  return {
    task, proposals: readProposals(tx, task.id), events: readEvents(tx, task.id),
    source: lookupSource(tx, projectId, task.source), evidenceArtifacts: readEvidenceArtifacts(tx, task.id),
  };
}

/** Effective completion policy for one task. GET exposes this before a close command is accepted. */
export function readTaskCompletionPolicy(tx: AppTransaction, projectId: string, taskId: string): CompletionPolicy {
  return parsePolicy(requireTask(tx, projectId, taskId));
}

/**
 * app.task_completion/v1
 * Registers one immutable evidence artifact for deterministic fixtures. Job success does not complete the task.
 */
export function registerTaskEvidenceArtifact(tx: AppTransaction, input: {
  taskId: string; projectId: string; workType: TaskEvidenceWorkType; outcome: TaskEvidenceOutcome;
  source: SourceReference; deliveryState?: TaskDeliveryState | null; now: number;
}): TaskEvidenceArtifact {
  const task = requireTask(tx, input.projectId, input.taskId);
  if (inactiveStates.includes(task.state) || task.state === "completed") throw new AppError("task_already_closed", 409);
  requireReference(input.source);
  const revision = (tx.get<{ revision: number }>("SELECT coalesce(max(revision), 0) AS revision FROM task_evidence_artifacts WHERE task_id = ?", input.taskId)?.revision ?? 0) + 1;
  const artifact: TaskEvidenceArtifact = {
    id: crypto.randomUUID(), taskId: input.taskId, projectId: input.projectId, revision,
    workType: input.workType, outcome: input.outcome, deliveryState: input.deliveryState ?? null,
    source: { ...input.source }, createdAt: input.now,
  };
  tx.run(`INSERT INTO task_evidence_artifacts (id, task_id, project_id, revision, work_type, outcome, delivery_state, source_id, source_revision, source_generation, record_json, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, artifact.id, artifact.taskId, artifact.projectId, artifact.revision,
    artifact.workType, artifact.outcome, artifact.deliveryState, artifact.source.sourceId, artifact.source.revision, artifact.source.generation,
    JSON.stringify({ workType: artifact.workType, outcome: artifact.outcome, deliveryState: artifact.deliveryState }), input.now);
  refreshTaskEvidenceStatus(tx, task, input.now);
  saveTask(tx, task);
  return artifact;
}

/**
 * app.task_commands/v1
 * Applies one validated task command inside the caller's transaction.
 * `task.start` always rejects. No command inserts a job, a run, or a tool request.
 */
export function applyTask(tx: AppTransaction, command: TaskCommand, channel: TaskChannel, now: number, maximumBytes: number): TaskReceipt {
  if (channel !== "web" && channel !== "telegram") throw new AppError("channel_not_authorized", 403);
  if (command.kind === "task.propose") return propose(tx, command, channel, now, maximumBytes);
  const task = requireTask(tx, command.projectId, command.payload.taskId);
  if (task.proposalRevision !== command.expectedRevision || (proposalId(command) !== null && proposalId(command) !== task.currentProposalId)) {
    throw new AppError("stale_revision", 409, latestDetail(task));
  }
  if (command.kind === "task.start") throw new AppError("coding_execution_unsupported", 409, latestDetail(task));
  if (command.kind === "task.complete") return completeTask(tx, task, command, channel, now);
  if (command.kind === "task.reopen") return reopenTask(tx, task, command, channel, now);
  if (command.kind === "task.set_policy") return setPolicy(tx, task, command, channel, now);
  if (command.kind === "task.supersede") return supersedeTask(tx, task, command, channel, now);
  if (inactiveStates.includes(task.state) || task.state === "completed") {
    if (command.kind === "task.accept") throw new AppError("task_already_closed", 409);
    throw new AppError(task.state === "completed" ? "task_already_completed" : "task_already_closed", 409);
  }
  if (command.kind === "task.cancel") {
    if (task.state !== "accepted" && task.state !== "ready_for_review") throw new AppError("task_not_accepted", 409);
    return closeTask(tx, task, "cancelled", command.payload.reason, channel, now, "task_not_accepted");
  }
  if (task.state === "accepted" || task.state === "ready_for_review") {
    if (command.kind === "task.accept") throw new AppError("task_already_accepted", 409);
    if (command.kind === "task.dismiss") throw new AppError("task_not_proposed", 409);
    if (command.kind === "task.edit") return edit(tx, task, command, channel, now, maximumBytes);
  }
  if (task.state === "proposed") {
    if (command.kind === "task.accept") return accept(tx, task, command, channel, now);
    if (command.kind === "task.edit") return edit(tx, task, command, channel, now, maximumBytes);
    if (command.kind === "task.dismiss") return closeTask(tx, task, "dismissed", command.payload.reason, channel, now, "task_not_proposed");
  }
  throw new AppError("task_not_proposed", 409);
}

const taskColumns = `id, project_id AS projectId, topic_id AS topicId, state, proposal_revision AS proposalRevision,
  current_proposal_id AS currentProposalId, title, summary, source_id AS sourceId, source_revision AS sourceRevision,
  source_generation AS sourceGeneration, origin, acceptance_json AS acceptanceJson, closed_reason AS closedReason,
  completion_policy_json AS completionPolicyJson, completion_json AS completionJson, pending_reason_json AS pendingReasonJson,
  superseded_by AS supersededBy, created_at AS createdAt, updated_at AS updatedAt`;

interface TaskRow {
  id: string; projectId: string; topicId: string; state: TaskState; proposalRevision: number; currentProposalId: string;
  title: string; summary: string; sourceId: string; sourceRevision: number; sourceGeneration: number; origin: TaskOrigin;
  acceptanceJson: string | null; closedReason: string | null; completionPolicyJson: string; completionJson: string | null;
  pendingReasonJson: string | null; supersededBy: string | null; createdAt: number; updatedAt: number;
}

function boundWording(title: unknown, summary: unknown, maximumBytes: number): void {
  requireText(title, 800);
  if (title.length > 200) throw new AppError("title_too_long");
  requireText(summary, maximumBytes);
  if (Buffer.byteLength(`${title}\n${summary}`) > 65536) throw new AppError("text_too_large_or_invalid", 413);
}
function boundReason(reason: unknown): void {
  requireText(reason, 800);
  if ((reason as string).length > 500) throw new AppError("text_too_large_or_invalid", 413);
}
function parseSource(value: unknown): SourceReference {
  if (!value || typeof value !== "object" || Array.isArray(value) || !exact(value, ["generation", "revision", "sourceId"])) throw new AppError("invalid_task_command");
  requireReference(value as SourceReference);
  return value as SourceReference;
}
function parsePolicy(row: TaskRow): CompletionPolicy {
  return JSON.parse(row.completionPolicyJson) as CompletionPolicy;
}
function parsePending(row: TaskRow): TaskPendingReason | null {
  return row.pendingReasonJson ? JSON.parse(row.pendingReasonJson) as TaskPendingReason : null;
}
function proposalId(command: TaskCommand): string | null {
  if (command.kind === "task.dismiss" || command.kind === "task.accept") return command.payload.proposalId;
  return null;
}
function latestDetail(task: TaskRow): AppErrorDetail {
  return {
    projectId: task.projectId, taskId: task.id, proposalId: task.currentProposalId, revision: task.proposalRevision,
    path: `/projects/${task.projectId}/tasks/${task.id}`,
  };
}
function requireTask(tx: AppTransaction, projectId: string, taskId: string): TaskRow {
  const task = tx.get<TaskRow>(`SELECT ${taskColumns} FROM tasks WHERE id = ? AND project_id = ?`, taskId, projectId);
  if (!task) throw new AppError("task_not_found", 404);
  return task;
}
function requireTopic(tx: AppTransaction, projectId: string, topicId: string, expectedRevision: number): void {
  const topic = tx.get<{ revision: number }>("SELECT revision FROM topics WHERE id = ? AND project_id = ?", topicId, projectId);
  if (!topic) throw new AppError("topic_not_found", 404);
  if (topic.revision !== expectedRevision) throw new AppError("stale_revision", 409, { projectId, path: `/projects/${projectId}/topics/${topicId}` });
}
function projectTask(row: TaskRow): TaskRecord {
  return {
    id: row.id, projectId: row.projectId, topicId: row.topicId, state: row.state, revision: row.proposalRevision,
    title: row.title, summary: row.summary,
    source: { sourceId: row.sourceId, revision: row.sourceRevision, generation: row.sourceGeneration },
    origin: row.origin, acceptance: row.acceptanceJson ? JSON.parse(row.acceptanceJson) as TaskAcceptance : null,
    closedReason: row.closedReason, completionPolicy: parsePolicy(row),
    completion: row.completionJson ? JSON.parse(row.completionJson) as TaskCompletion : null,
    pendingReason: parsePending(row), supersededBy: row.supersededBy, createdAt: row.createdAt, updatedAt: row.updatedAt,
  };
}
function readProposals(tx: AppTransaction, taskId: string): TaskProposal[] {
  return tx.all<{
    id: string; taskId: string; projectId: string; revision: number; title: string; summary: string;
    sourceId: string; sourceRevision: number; sourceGeneration: number; origin: TaskOrigin; createdAt: number;
  }>(`SELECT id, task_id AS taskId, project_id AS projectId, revision, title, summary, source_id AS sourceId,
      source_revision AS sourceRevision, source_generation AS sourceGeneration, origin, created_at AS createdAt
      FROM task_proposals WHERE task_id = ? ORDER BY revision`, taskId).map(row => ({
    id: row.id, taskId: row.taskId, projectId: row.projectId, revision: row.revision, title: row.title, summary: row.summary,
    source: { sourceId: row.sourceId, revision: row.sourceRevision, generation: row.sourceGeneration }, origin: row.origin, createdAt: row.createdAt,
  }));
}
function readEvents(tx: AppTransaction, taskId: string): TaskEvent[] {
  return tx.all<TaskEvent>(`SELECT sequence, task_id AS taskId, kind, actor_id AS actorId, channel, proposal_id AS proposalId,
    proposal_revision AS proposalRevision, reason, created_at AS createdAt FROM task_events WHERE task_id = ? ORDER BY sequence`, taskId);
}
function readEvidenceArtifacts(tx: AppTransaction, taskId: string): TaskEvidenceArtifact[] {
  return tx.all<{
    id: string; taskId: string; projectId: string; revision: number; workType: TaskEvidenceWorkType; outcome: TaskEvidenceOutcome;
    deliveryState: TaskDeliveryState | null; sourceId: string; sourceRevision: number; sourceGeneration: number; createdAt: number;
  }>(`SELECT id, task_id AS taskId, project_id AS projectId, revision, work_type AS workType, outcome,
      delivery_state AS deliveryState, source_id AS sourceId, source_revision AS sourceRevision, source_generation AS sourceGeneration, created_at AS createdAt
      FROM task_evidence_artifacts WHERE task_id = ? ORDER BY revision`, taskId).map(row => ({
    id: row.id, taskId: row.taskId, projectId: row.projectId, revision: row.revision, workType: row.workType, outcome: row.outcome,
    deliveryState: row.deliveryState, source: { sourceId: row.sourceId, revision: row.sourceRevision, generation: row.sourceGeneration }, createdAt: row.createdAt,
  }));
}
function cite(tx: AppTransaction, projectId: string, topicId: string, title: string, summary: string, source: SourceReference | undefined, now: number): { source: SourceReference; origin: TaskOrigin } {
  if (!source) {
    return {
      origin: "owner",
      source: commitOwnerSource(tx, { projectId, descriptor: { kind: "topic", topicId }, text: `${title}\n${summary}`, committedAt: now }),
    };
  }
  const located = tx.get<{ projectId: string }>("SELECT project_id AS projectId FROM sources WHERE id = ?", source.sourceId);
  if (located && located.projectId !== projectId) throw new AppError("project_mismatch", 409, { projectId, path: `/projects/${projectId}/tasks` });
  const looked = lookupSource(tx, projectId, source);
  if (looked.state !== "available" || looked.attribution.kind !== "participant" || looked.descriptor.kind !== "output") throw new AppError("source_not_validated", 409);
  const decision = tx.get("SELECT id FROM decision_proposals WHERE project_id = ? AND topic_id = ? AND source_id = ? AND source_revision = ? AND source_generation = ?",
    projectId, topicId, source.sourceId, source.revision, source.generation);
  const messages = tx.all<{ attribution: string }>("SELECT attribution_json AS attribution FROM messages WHERE project_id = ? AND topic_id = ? AND source_id = ? AND source_revision = ? AND source_generation = ?",
    projectId, topicId, source.sourceId, source.revision, source.generation);
  const specialist = messages.some(row => (JSON.parse(row.attribution) as { kind?: string }).kind === "participant");
  if (!decision && !specialist) throw new AppError("source_not_validated", 409);
  return { origin: "validated_output", source: { ...source } };
}
function insertProposal(tx: AppTransaction, task: { id: string; projectId: string }, revision: number, title: string, summary: string, cited: { source: SourceReference; origin: TaskOrigin }, now: number, id = crypto.randomUUID()): TaskProposal {
  const proposal: TaskProposal = { id, taskId: task.id, projectId: task.projectId, revision, title, summary, source: cited.source, origin: cited.origin, createdAt: now };
  tx.run(`INSERT INTO task_proposals (id, task_id, project_id, revision, title, summary, source_id, source_revision, source_generation, origin, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, proposal.id, task.id, task.projectId, revision, title, summary,
    cited.source.sourceId, cited.source.revision, cited.source.generation, cited.origin, now);
  return proposal;
}
function insertEvent(tx: AppTransaction, taskId: string, projectId: string, kind: TaskEventKind, channel: TaskChannel, proposal: TaskProposal | null, reason: string | null, now: number): TaskEvent {
  tx.run(`INSERT INTO task_events (task_id, project_id, kind, actor_id, channel, proposal_id, proposal_revision, reason, created_at)
    VALUES (?, ?, ?, 'owner', ?, ?, ?, ?, ?)`, taskId, projectId, kind, channel, proposal?.id ?? null, proposal?.revision ?? null, reason, now);
  const event = tx.get<TaskEvent>(`SELECT sequence, task_id AS taskId, kind, actor_id AS actorId, channel, proposal_id AS proposalId,
    proposal_revision AS proposalRevision, reason, created_at AS createdAt FROM task_events WHERE task_id = ? ORDER BY sequence DESC LIMIT 1`, taskId);
  if (!event || event.kind !== kind) throw new AppError("storage_unavailable", 503);
  return event;
}
function saveTask(tx: AppTransaction, row: TaskRow): void {
  tx.run(`UPDATE tasks SET state = ?, proposal_revision = ?, current_proposal_id = ?, title = ?, summary = ?, source_id = ?,
    source_revision = ?, source_generation = ?, origin = ?, acceptance_json = ?, closed_reason = ?, completion_policy_json = ?,
    completion_json = ?, pending_reason_json = ?, superseded_by = ?, updated_at = ? WHERE id = ? AND project_id = ?`,
    row.state, row.proposalRevision, row.currentProposalId, row.title, row.summary, row.sourceId, row.sourceRevision, row.sourceGeneration,
    row.origin, row.acceptanceJson, row.closedReason, row.completionPolicyJson, row.completionJson, row.pendingReasonJson, row.supersededBy,
    row.updatedAt, row.id, row.projectId);
}
function latestCompleteArtifact(tx: AppTransaction, taskId: string): TaskEvidenceArtifact | null {
  return readEvidenceArtifacts(tx, taskId).filter(item => item.outcome === "complete").at(-1) ?? null;
}
function validateCompletionEvidence(tx: AppTransaction, task: TaskRow, policy: CompletionPolicy, evidence: SourceReference[]): void {
  const artifacts = readEvidenceArtifacts(tx, task.id);
  if (policy.kind === "evidence_satisfied" && !latestCompleteArtifact(tx, task.id)) throw new AppError("completion_evidence_required", 409, latestDetail(task));
  for (const reference of evidence) {
    const located = lookupSource(tx, task.projectId, reference);
    if (located.state !== "available") throw new AppError("completion_evidence_stale", 409, latestDetail(task));
    const artifact = artifacts.find(item => item.source.sourceId === reference.sourceId && item.source.revision === reference.revision && item.source.generation === reference.generation);
    if (!artifact) throw new AppError("completion_evidence_stale", 409, latestDetail(task));
    if (artifact.outcome === "partial") throw new AppError("completion_evidence_partial", 409, latestDetail(task));
    if (artifact.outcome === "failed") throw new AppError("completion_evidence_failed", 409, latestDetail(task));
    if (artifact.deliveryState === "unknown" || artifact.outcome === "unknown") throw new AppError("completion_evidence_unknown", 409, latestDetail(task));
    if (artifact.outcome !== "complete") throw new AppError("completion_evidence_invalid", 409, latestDetail(task));
  }
}
function refreshTaskEvidenceStatus(tx: AppTransaction, task: TaskRow, now: number, channel: TaskChannel = "web"): void {
  const policy = parsePolicy(task);
  const artifacts = readEvidenceArtifacts(tx, task.id);
  const latest = artifacts.at(-1);
  let pending: TaskPendingReason | null = null;
  if (latest?.outcome === "partial") pending = { kind: "review_partial", detail: "ผลตรวจยังไม่ครบตามขอบเขต" };
  else if (latest?.outcome === "failed") pending = { kind: "job_failed", detail: "งานพื้นหลังล้มเหลว ยังปิดข้อผูกพันไม่ได้" };
  else if (latest?.deliveryState === "unknown" || latest?.outcome === "unknown") pending = { kind: "delivery_unknown", detail: "สถานะการส่งยังไม่ชัดเจน" };
  else if (policy.kind === "evidence_satisfied" && !latestCompleteArtifact(tx, task.id)) pending = { kind: "awaiting_complete_evidence", detail: "รอหลักฐานที่ครบตามนโยบาย" };
  else if (task.state === "accepted" || task.state === "ready_for_review") pending = pending ?? { kind: "awaiting_owner", detail: "รอคุณยืนยันผลตามนโยบาย" };
  task.pendingReasonJson = pending ? JSON.stringify(pending) : null;
  if (policy.kind === "evidence_satisfied" && latestCompleteArtifact(tx, task.id) && task.state === "accepted") {
    task.state = "ready_for_review";
    task.updatedAt = now;
    insertEvent(tx, task.id, task.projectId, "ready_for_review", channel, readProposals(tx, task.id).at(-1) ?? null, null, now);
  }
}
function propose(tx: AppTransaction, command: Extract<TaskCommand, { kind: "task.propose" }>, channel: TaskChannel, now: number, maximumBytes: number): TaskReceipt {
  requireTopic(tx, command.projectId, command.payload.topicId, command.expectedRevision);
  const { title, summary } = command.payload;
  boundWording(title, summary, maximumBytes);
  const cited = cite(tx, command.projectId, command.payload.topicId, title, summary, command.payload.source, now);
  const id = crypto.randomUUID();
  const proposalId = crypto.randomUUID();
  tx.run(`INSERT INTO tasks (id, project_id, topic_id, state, proposal_revision, current_proposal_id, title, summary, source_id, source_revision, source_generation, origin, acceptance_json, closed_reason, completion_policy_json, completion_json, pending_reason_json, superseded_by, created_at, updated_at)
    VALUES (?, ?, ?, 'proposed', 1, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, NULL, NULL, NULL, ?, ?)`, id, command.projectId, command.payload.topicId, proposalId, title, summary,
    cited.source.sourceId, cited.source.revision, cited.source.generation, cited.origin, JSON.stringify(DEFAULT_USER_TASK_POLICY), now, now);
  const proposal = insertProposal(tx, { id, projectId: command.projectId }, 1, title, summary, cited, now, proposalId);
  const event = insertEvent(tx, id, command.projectId, "proposed", channel, proposal, null, now);
  return { task: projectTask(requireTask(tx, command.projectId, id)), proposal, event };
}
function edit(tx: AppTransaction, task: TaskRow, command: Extract<TaskCommand, { kind: "task.edit" }>, channel: TaskChannel, now: number, maximumBytes: number): TaskReceipt {
  const { title, summary } = command.payload;
  boundWording(title, summary, maximumBytes);
  const cited = cite(tx, task.projectId, task.topicId, title, summary, command.payload.source, now);
  const proposal = insertProposal(tx, task, task.proposalRevision + 1, title, summary, cited, now);
  task.proposalRevision = proposal.revision; task.currentProposalId = proposal.id; task.title = title; task.summary = summary;
  task.sourceId = cited.source.sourceId; task.sourceRevision = cited.source.revision; task.sourceGeneration = cited.source.generation;
  task.origin = cited.origin; task.updatedAt = now;
  saveTask(tx, task);
  return { task: projectTask(task), proposal, event: insertEvent(tx, task.id, task.projectId, "edited", channel, proposal, null, now) };
}
function accept(tx: AppTransaction, task: TaskRow, command: Extract<TaskCommand, { kind: "task.accept" }>, channel: TaskChannel, now: number): TaskReceipt {
  const proposal = readProposals(tx, task.id).find(item => item.id === command.payload.proposalId && item.revision === task.proposalRevision);
  if (!proposal) throw new AppError("stale_revision", 409, latestDetail(task));
  const acceptance: TaskAcceptance = { actorId: "owner", channel, proposalId: proposal.id, proposalRevision: proposal.revision, acceptedAt: now };
  task.state = "accepted"; task.acceptanceJson = JSON.stringify(acceptance);
  task.completionPolicyJson = JSON.stringify(DEFAULT_USER_TASK_POLICY);
  task.pendingReasonJson = JSON.stringify({ kind: "awaiting_owner", detail: "รอคุณยืนยันผลตามนโยบาย" } satisfies TaskPendingReason);
  task.updatedAt = now;
  saveTask(tx, task);
  return { task: projectTask(task), proposal, event: insertEvent(tx, task.id, task.projectId, "accepted", channel, proposal, null, now) };
}
function closeTask(tx: AppTransaction, task: TaskRow, state: "dismissed" | "cancelled", reason: string, channel: TaskChannel, now: number, wrongState: string): TaskReceipt {
  if (task.state !== (state === "dismissed" ? "proposed" : "accepted") && !(state === "cancelled" && task.state === "ready_for_review")) throw new AppError(wrongState, 409);
  boundReason(reason);
  const proposal = readProposals(tx, task.id).at(-1)!;
  task.state = state; task.closedReason = reason; task.pendingReasonJson = null; task.updatedAt = now;
  saveTask(tx, task);
  return { task: projectTask(task), proposal, event: insertEvent(tx, task.id, task.projectId, state, channel, proposal, reason, now) };
}
function setPolicy(tx: AppTransaction, task: TaskRow, command: Extract<TaskCommand, { kind: "task.set_policy" }>, channel: TaskChannel, now: number): TaskReceipt {
  if (task.state !== "accepted" && task.state !== "ready_for_review") throw new AppError("task_not_accepted", 409);
  if (command.payload.policyKind === "evidence_satisfied" && !latestCompleteArtifact(tx, task.id)) throw new AppError("completion_policy_unsupported", 409, latestDetail(task));
  task.completionPolicyJson = JSON.stringify({ kind: command.payload.policyKind, workType: "user_task" } satisfies CompletionPolicy);
  refreshTaskEvidenceStatus(tx, task, now);
  task.updatedAt = now;
  saveTask(tx, task);
  const proposal = readProposals(tx, task.id).at(-1)!;
  return { task: projectTask(task), proposal, event: insertEvent(tx, task.id, task.projectId, "policy_changed", channel, proposal, command.payload.policyKind, now) };
}
function completeTask(tx: AppTransaction, task: TaskRow, command: Extract<TaskCommand, { kind: "task.complete" }>, channel: TaskChannel, now: number): TaskReceipt {
  if (task.state === "completed" || task.completionJson) throw new AppError("task_already_completed", 409);
  if (task.state !== "accepted" && task.state !== "ready_for_review") throw new AppError("task_not_accepted", 409);
  const policy = parsePolicy(task);
  const evidence = command.payload.evidence ?? [];
  validateCompletionEvidence(tx, task, policy, evidence);
  const proposal = readProposals(tx, task.id).at(-1)!;
  const completion: TaskCompletion = {
    actorId: "owner", channel, proposalId: proposal.id, proposalRevision: proposal.revision,
    evidence, note: command.payload.note ?? null, completedAt: now,
  };
  task.state = "completed"; task.completionJson = JSON.stringify(completion); task.pendingReasonJson = null; task.updatedAt = now;
  saveTask(tx, task);
  return { task: projectTask(task), proposal, event: insertEvent(tx, task.id, task.projectId, "completed", channel, proposal, command.payload.note ?? null, now) };
}
function reopenTask(tx: AppTransaction, task: TaskRow, command: Extract<TaskCommand, { kind: "task.reopen" }>, channel: TaskChannel, now: number): TaskReceipt {
  if (task.state !== "completed") throw new AppError("task_not_completed", 409);
  boundReason(command.payload.reason);
  const proposal = readProposals(tx, task.id).at(-1)!;
  task.state = "accepted"; task.completionJson = null; task.updatedAt = now;
  refreshTaskEvidenceStatus(tx, task, now);
  saveTask(tx, task);
  return { task: projectTask(task), proposal, event: insertEvent(tx, task.id, task.projectId, "reopened", channel, proposal, command.payload.reason, now) };
}
function supersedeTask(tx: AppTransaction, task: TaskRow, command: Extract<TaskCommand, { kind: "task.supersede" }>, channel: TaskChannel, now: number): TaskReceipt {
  if (task.state !== "accepted" && task.state !== "ready_for_review") throw new AppError("task_not_accepted", 409);
  boundReason(command.payload.reason);
  const proposal = readProposals(tx, task.id).at(-1)!;
  task.state = "superseded"; task.closedReason = command.payload.reason;
  task.supersededBy = command.payload.successorTaskId ?? null; task.pendingReasonJson = null; task.updatedAt = now;
  saveTask(tx, task);
  return { task: projectTask(task), proposal, event: insertEvent(tx, task.id, task.projectId, "superseded", channel, proposal, command.payload.reason, now) };
}
