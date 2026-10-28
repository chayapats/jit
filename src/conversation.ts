import { AppError } from "./errors";
import type { AppTransaction } from "./store";
import { commitOwnerSource, lookupSource, requireId, requireText, type Attribution, type SourceReference } from "./sources";
import { requireParticipationReference, type ParticipationReference } from "./team/routing";

/** Creates a topic under the selected project's current aggregate revision. */
export interface CreateTopicCommand {
  kind: "topic.create"; requestId: string; projectId: string; expectedRevision: number; payload: { title: string };
}
/**
 * Appends literal owner text under the selected topic's current conversation revision. `replyTo` optionally names the
 * participation (one role in one discussion of this topic) the owner is answering; app.routing_selection/v1 uses it to
 * call that role again without a model choice. It is owner input and never comes from model text.
 */
export interface SendMessageCommand {
  kind: "message.send"; requestId: string; projectId: string; expectedRevision: number;
  payload: { topicId: string; text: string; replyTo?: ParticipationReference };
}
/**
 * Starts a new chat from the home composer (app.topic_promotion/v1 home, S09-D05/D09): one topic in the chosen project
 * (the General space by default) titled from the first line of the text, and the owner's first message in it, in one
 * commit. `expectedRevision` is the workspace revision the home page rendered its project chip from.
 */
export interface StartChatCommand {
  kind: "chat.start"; requestId: string; projectId: string; expectedRevision: number; payload: { text: string };
}
/** Represents the owner conversation commands accepted by every authenticated ingress adapter. */
export type ConversationCommand = CreateTopicCommand | SendMessageCommand | StartChatCommand;
/** Identifies a topic, its creator and its immutable metadata source independently from its conversation revision. */
export interface Topic {
  id: string; projectId: string; groupId: string; title: string | null; revision: number; sequence: number;
  createdAt: number; attribution: Attribution; source: SourceReference; availability: "available" | "unavailable";
}
/** A committed app message keeps provenance and ordered identity even when its source becomes unavailable. */
export interface CommittedMessage {
  id: string; projectId: string; topicId: string; sequence: number; status: "committed"; committedAt: number;
  attribution: Attribution; source: SourceReference; text: string | null; availability: "available" | "unavailable";
}
/** Returns a topic and the new project revision only after their atomic creation commit. */
export interface TopicReceipt { topic: Topic; projectRevision: number }
/** Returns an immutable message and the new topic revision only after its append commit. */
export interface MessageReceipt { message: CommittedMessage; topicRevision: number }
/** Returns the new chat's topic and first message after their single commit. */
export interface ChatReceipt { topic: Topic; message: CommittedMessage; projectRevision: number; topicRevision: number }
/** A bounded cursor page never reads the entire conversation or topic collection. */
export interface CursorPage<T> { items: T[]; hasMore: boolean; nextAfter: number }

interface TopicRow {
  id: string; projectId: string; groupId: string; revision: number; sequence: number; messageSequence: number;
  createdAt: number; attribution: string; sourceId: string; sourceRevision: number; sourceGeneration: number;
}
interface MessageRow {
  id: string; projectId: string; topicId: string; sequence: number; committedAt: number; attribution: string;
  sourceId: string; sourceRevision: number; sourceGeneration: number;
}
const topicColumns = `id, project_id AS projectId, group_id AS groupId, revision, sequence,
  message_sequence AS messageSequence, created_at AS createdAt, attribution_json AS attribution,
  source_id AS sourceId, source_revision AS sourceRevision, source_generation AS sourceGeneration`;
const reference = (row: TopicRow | MessageRow): SourceReference =>
  ({ sourceId: row.sourceId, revision: row.sourceRevision, generation: row.sourceGeneration });

function topicProjection(tx: AppTransaction, row: TopicRow): Topic {
  const source = lookupSource(tx, row.projectId, reference(row));
  return { id: row.id, projectId: row.projectId, groupId: row.groupId, revision: row.revision, sequence: row.sequence,
    title: source.state === "available" ? source.text : null, createdAt: row.createdAt,
    attribution: JSON.parse(row.attribution) as Attribution, source: reference(row), availability: source.state };
}
function messageProjection(tx: AppTransaction, row: MessageRow): CommittedMessage {
  const source = lookupSource(tx, row.projectId, reference(row));
  return { id: row.id, projectId: row.projectId, topicId: row.topicId, sequence: row.sequence, status: "committed",
    committedAt: row.committedAt, attribution: JSON.parse(row.attribution) as Attribution, source: reference(row),
    text: source.state === "available" ? source.text : null, availability: source.state };
}

/** Rejects unbounded or malformed cursors before querying a bounded history page. */
export function requireCursor(after: number): void {
  if (!Number.isSafeInteger(after) || after < 0) throw new AppError("invalid_cursor");
}
/** Validates exact command fields and returns the canonical identity used by durable receipts. */
export function conversationIdentity(command: ConversationCommand, messageBytes: number): string {
  if (!command || Object.keys(command).some(k => !["kind", "requestId", "projectId", "expectedRevision", "payload"].includes(k)) ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0 ||
      !command.payload || typeof command.payload !== "object" || Array.isArray(command.payload)) throw new AppError("invalid_conversation_command");
  requireId(command.projectId);
  if (command.kind === "topic.create") {
    if (Object.keys(command.payload).some(k => k !== "title")) throw new AppError("invalid_conversation_command");
    requireText(command.payload.title, 800);
    if (command.payload.title.length > 200) throw new AppError("title_too_long");
    return JSON.stringify([command.kind, command.projectId, command.expectedRevision, command.payload.title]);
  }
  if (command.kind === "chat.start") {
    if (Object.keys(command.payload).some(k => k !== "text")) throw new AppError("invalid_conversation_command");
    requireText(command.payload.text, messageBytes);
    return JSON.stringify([command.kind, command.projectId, command.expectedRevision, command.payload.text]);
  }
  if (command.kind === "message.send") {
    if (Object.keys(command.payload).some(k => !["topicId", "text", "replyTo"].includes(k))) throw new AppError("invalid_conversation_command");
    requireId(command.payload.topicId); requireText(command.payload.text, messageBytes);
    // A message without a reply target keeps its original receipt identity.
    if (!Object.hasOwn(command.payload, "replyTo")) return JSON.stringify([command.kind, command.projectId, command.expectedRevision, command.payload.topicId, command.payload.text]);
    const replyTo = requireParticipationReference(command.payload.replyTo);
    return JSON.stringify([command.kind, command.projectId, command.expectedRevision, command.payload.topicId, command.payload.text, replyTo.discussionId, replyTo.roleId]);
  }
  throw new AppError("invalid_conversation_command");
}

/** Reads a topic only within its explicit project; names cannot resolve scope. */
export function readTopic(tx: AppTransaction, projectId: string, topicId: string): Topic {
  const row = tx.get<TopicRow>(`SELECT ${topicColumns} FROM topics WHERE id = ? AND project_id = ?`, topicId, projectId);
  if (!row) throw new AppError("topic_not_found", 404);
  return topicProjection(tx, row);
}

/** Reads one bounded topic page ordered by serialized project commits. */
export function readTopics(tx: AppTransaction, projectId: string, after: number, limit: number): CursorPage<Topic> {
  const rows = tx.all<TopicRow>(`SELECT ${topicColumns} FROM topics WHERE project_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`, projectId, after, limit + 1);
  const visible = rows.slice(0, limit);
  return { items: visible.map(row => topicProjection(tx, row)), hasMore: rows.length > limit,
    nextAfter: visible.at(-1)?.sequence ?? after };
}

/** Reads one bounded history page ordered by serialized topic appends, independently from timestamps. */
export function readMessages(tx: AppTransaction, projectId: string, topicId: string, after: number, limit: number): CursorPage<CommittedMessage> {
  const rows = tx.all<MessageRow>(`SELECT id, project_id AS projectId, topic_id AS topicId, sequence,
    committed_at AS committedAt, attribution_json AS attribution, source_id AS sourceId,
    source_revision AS sourceRevision, source_generation AS sourceGeneration
    FROM messages WHERE project_id = ? AND topic_id = ? AND sequence > ? ORDER BY sequence LIMIT ?`, projectId, topicId, after, limit + 1);
  const visible = rows.slice(0, limit);
  return { items: visible.map(row => messageProjection(tx, row)), hasMore: rows.length > limit,
    nextAfter: visible.at(-1)?.sequence ?? after };
}

/** Most characters of a topic title derived from a chat's first line. */
export const chatTitleChars = 60;
/** The title of a chat started from the home composer: its first non-empty line, whitespace collapsed, bounded. */
export function chatTitle(text: string): string {
  const line = text.split("\n").map(item => item.replace(/\s+/g, " ").trim()).find(Boolean) ?? "";
  const chars = Array.from(line);
  return chars.length > chatTitleChars ? `${chars.slice(0, chatTitleChars - 1).join("").trimEnd()}…` : line;
}

/** Mutates conversation state inside an owner-validated transaction; the caller commits receipts and audit atomically. */
export function mutateConversation(tx: AppTransaction, command: ConversationCommand, now: number): TopicReceipt | MessageReceipt | ChatReceipt {
  const attribution: Attribution = { kind: "owner", ownerId: "owner" };
  if (command.kind === "chat.start") {
    const workspace = tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision;
    if (workspace !== command.expectedRevision) throw new AppError("stale_revision", 409);
    const project = tx.get<{ revision: number }>("SELECT revision FROM projects WHERE id = ?", command.projectId);
    if (!project) throw new AppError("project_not_found", 404);
    const { topic, projectRevision } = mutateConversation(tx, { kind: "topic.create", requestId: command.requestId, projectId: command.projectId,
      expectedRevision: project.revision, payload: { title: chatTitle(command.payload.text) } }, now) as TopicReceipt;
    const { message, topicRevision } = mutateConversation(tx, { kind: "message.send", requestId: command.requestId, projectId: command.projectId,
      expectedRevision: topic.revision, payload: { topicId: topic.id, text: command.payload.text } }, now) as MessageReceipt;
    // The title is a copy of the message's first line: record the lineage, so deleting the message deletes the title.
    tx.run("INSERT INTO chat_title_sources (title_source_id, project_id, topic_id, message_source_id) VALUES (?, ?, ?, ?)",
      topic.source.sourceId, command.projectId, topic.id, message.source.sourceId);
    return { topic: readTopic(tx, command.projectId, topic.id), message, projectRevision, topicRevision };
  }
  if (command.kind === "topic.create") {
    const project = tx.get<{ revision: number; groupId: string }>(`SELECT p.revision, g.id AS groupId
      FROM projects p JOIN project_groups g ON p.id = g.project_id WHERE p.id = ?`, command.projectId);
    if (!project) throw new AppError("project_not_found", 404);
    if (project.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
    const id = crypto.randomUUID();
    const source = commitOwnerSource(tx, { projectId: command.projectId, descriptor: { kind: "topic", topicId: id },
      text: command.payload.title.trim(), committedAt: now });
    tx.run("INSERT INTO topics VALUES (?, ?, ?, 1, ?, 0, ?, ?, ?, ?, ?)", id, command.projectId, project.groupId,
      project.revision + 1, now, JSON.stringify(attribution), source.sourceId, source.revision, source.generation);
    tx.run("UPDATE projects SET revision = revision + 1 WHERE id = ?", command.projectId);
    return { topic: readTopic(tx, command.projectId, id), projectRevision: project.revision + 1 };
  }
  const topic = tx.get<TopicRow>(`SELECT ${topicColumns} FROM topics WHERE id = ? AND project_id = ?`, command.payload.topicId, command.projectId);
  if (!topic) throw new AppError("topic_not_found", 404);
  // app.topic_promotion/v1: a promoted origin is read-only; the conversation continues in its new project.
  const promoted = tx.get<{ projectId: string; topicId: string }>("SELECT project_id AS projectId, topic_id AS topicId FROM topic_promotions WHERE origin_project_id = ? AND origin_topic_id = ?", command.projectId, topic.id);
  if (promoted) throw new AppError("topic_promoted", 409, { projectId: promoted.projectId, path: `/projects/${promoted.projectId}/topics/${promoted.topicId}` });
  if (topic.revision !== command.expectedRevision) throw new AppError("stale_revision", 409);
  const id = crypto.randomUUID(), sequence = topic.messageSequence + 1;
  const source = commitOwnerSource(tx, { projectId: command.projectId,
    descriptor: { kind: "message", topicId: topic.id, messageId: id }, text: command.payload.text, committedAt: now });
  tx.run("INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)", id, command.projectId, topic.id, sequence,
    now, JSON.stringify(attribution), source.sourceId, source.revision, source.generation);
  tx.run("UPDATE topics SET revision = revision + 1, message_sequence = ? WHERE id = ? AND project_id = ?", sequence, topic.id, command.projectId);
  return { message: { id, projectId: command.projectId, topicId: topic.id, sequence, status: "committed", committedAt: now,
    attribution, source, text: command.payload.text, availability: "available" }, topicRevision: topic.revision + 1 };
}
