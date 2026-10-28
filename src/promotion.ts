import { AppError } from "./errors";
import { mutateConversation, readMessages, readTopic, type CommittedMessage, type TopicReceipt } from "./conversation";
import { registerExternalSource, requireId, type SourceReference } from "./sources";
import type { AppTransaction } from "./store";
import { readReplyRecord, saveReplyRecord, safeIdentifier } from "./team/jit-reply";
import { redactRoleProposals } from "./team/role-proposals";

/**
 * app.topic_promotion/v1 — continuing a General space topic in a new project (S09-D09, ADR 0031, FR-22, FR-01, FR-05).
 *
 * Jit may suggest a promotion in a reply to an owner message in the General space: `{"kind":"promotion","name":…}`.
 * The suggestion is kept with the reply record (`team_runs`, kind `jit_reply`) as immutable revisions, like a role
 * proposal (app.role_proposals/v1), so deletion, correction, restore and backups cover it the same way. Revision 1
 * is Jit's, parsed from untrusted model output: a project name. Every other field is dropped and named on the card.
 * An owner edit appends an owner-authored revision. Model output never moves a proposal's state.
 *
 * Only `topic.promote.accept` of the current open revision promotes, in one transaction: a new project (and group)
 * named by that revision, a new topic in it, and as that topic's first record an identity-only source that names the
 * origin topic at its exact conversation revision. A `topic_promotions` row links both ends; the origin topic is
 * then read-only. Nothing is moved, copied or rewritten: the origin's sources, memory claims, tasks and jobs keep the
 * General project, and the continuation reads the origin live through its own project, so a later deletion or forget
 * of origin content is honoured there too. The General space itself is never promoted, renamed or deleted.
 */
export type PromotionProposalState = "proposed" | "accepted" | "rejected" | "superseded";
/** One immutable revision. `author` is service-recorded: `jit` for parsed model output, `owner` for an edit. */
export interface PromotionProposalRevision {
  revision: number; author: "jit" | "owner"; state: PromotionProposalState;
  /** Suggested project name: untrusted text until the owner accepts it. */
  name: string;
  /** What was dropped from the model's suggestion, as safe codes (`field:<name>`). */
  dropped: string[]; droppedTotal: number;
  createdAt: number; decidedAt: number | null;
  /** `deletion`: a deletion redacted Jit's text while open. `promotion`: another proposal promoted the topic first. */
  closedBy?: "deletion" | "promotion";
}
/** Persisted with the reply record. Revisions are append-only; only the last one can be open. */
export interface PromotionProposal { id: string; revisions: PromotionProposalRevision[]; promotionId: string | null }
/** Read model of one promotion proposal card. */
export interface PromotionProposalView {
  id: string; kind: "promotion"; replyId: string; projectId: string; topicId: string;
  revision: number; state: PromotionProposalState; author: "jit" | "owner"; name: string;
  dropped: string[]; droppedTotal: number;
  /** Set once accepted: the promotion it created. */
  promotion: { id: string; projectId: string; topicId: string } | null;
  replySequence: number | null;
  closedByDeletion: boolean; closedByPromotion: boolean;
  history: { revision: number; author: "jit" | "owner"; state: PromotionProposalState }[];
  updatedAt: number;
}

/** One committed promotion: the origin at its exact revision and the continuation that links it. */
export interface TopicPromotion {
  id: string;
  origin: { projectId: string; topicId: string; topicRevision: number; messageSequence: number };
  target: { projectId: string; topicId: string };
  /** The continuation's first record: an identity-only external source naming the origin, and its message. */
  link: { messageId: string; source: SourceReference };
  replyId: string; proposalId: string; proposalRevision: number; createdAt: number;
}
/** The origin conversation as the continuation shows it: read live from the origin project, up to the linked revision. */
export interface PromotionOriginView {
  project: { id: string; name: string }; topicTitle: string | null;
  messages: (CommittedMessage & { jit: boolean })[]; hasMore: boolean;
}
/** app.topic_promotion/v1 read model of one topic: promoted into a continuation, continuing an origin, or neither. */
export interface TopicPromotionView {
  promotedTo: (TopicPromotion & { project: { id: string; name: string }; topicTitle: string | null }) | null;
  continuedFrom: (TopicPromotion & { origin: TopicPromotion["origin"] & PromotionOriginView }) | null;
}

interface ProposalTarget { topicId: string; replyId: string; proposalId: string }
/** Owner commands on one promotion proposal. `projectId` is the General space; `expectedRevision` is the card's revision. */
export type PromotionCommand = {
  kind: "topic.promote.accept"; requestId: string; projectId: string; expectedRevision: number; payload: ProposalTarget;
} | {
  kind: "topic.promote.dismiss"; requestId: string; projectId: string; expectedRevision: number; payload: ProposalTarget;
} | {
  kind: "topic.promote.revise"; requestId: string; projectId: string; expectedRevision: number; payload: ProposalTarget & { name: string };
};
export const promotionCommandKinds: readonly PromotionCommand["kind"][] = Object.freeze(["topic.promote.accept", "topic.promote.dismiss", "topic.promote.revise"]);
export const isPromotionCommand = (command: { kind?: unknown } | null | undefined): command is PromotionCommand =>
  (promotionCommandKinds as readonly unknown[]).includes(command?.kind);
/** Acknowledged only with its audit and receipt. Accept also carries the promotion it committed. */
export interface PromotionReceipt { proposal: PromotionProposalView; promotion?: TopicPromotion; workspaceRevision?: number }

/** Name bound in characters; within the 200-character project name bound of `project.create`. */
export const promotionNameChars = 120;
/** Most dropped codes kept per revision; the rest are counted. */
const droppedLimit = 8;
const proposalKeys = ["kind", "name"];
const validName = (value: string) => value.length > 0 && Array.from(value).length <= promotionNameChars && value.isWellFormed() &&
  !/[\u0000-\u001f\u007f\u2028\u2029]/.test(value);

/** The installation's General space project, or null before setup creates it (app.general_space/v1). */
export function generalProjectId(tx: AppTransaction): string | null {
  return tx.get<{ projectId: string }>("SELECT project_id AS projectId FROM general_space WHERE id = 1")?.projectId ?? null;
}

/**
 * Trusted policy sentence for a reply to an owner message in an open General space topic. It is appended to the fixed
 * policy line, because run requests hold at most eight operator lines.
 */
export const promotionInstruction = `Optional "proposals" entry {"kind":"promotion","name":string} (at most one) when this General conversation has clearly become a project of its own; name is a short suggested project name (at most ${promotionNameChars} characters, one line). It is only a card the owner may accept, edit or dismiss: it never creates a project, moves history, tasks or memory, or grants any authority.`;

/**
 * Parses one untrusted `{"kind":"promotion"}` entry into Jit's revision 1, or null when it has no usable name.
 * Unknown keys are dropped and recorded as safe identifiers; nothing is copied from key names.
 */
export function parsePromotionProposal(item: unknown, now: number): PromotionProposal | null {
  if (!item || typeof item !== "object" || Array.isArray(item)) return null;
  const value = item as Record<string, unknown>;
  const name = typeof value.name === "string" ? value.name.trim() : "";
  if (!validName(name)) return null;
  const dropped = Object.keys(value).filter(key => !proposalKeys.includes(key)).map(key => `field:${safeIdentifier(key)}`);
  return { id: crypto.randomUUID(), promotionId: null, revisions: [{ revision: 1, author: "jit", state: "proposed", name,
    dropped: dropped.slice(0, droppedLimit), droppedTotal: dropped.length, createdAt: now, decidedAt: null }] };
}

const promotionColumns = `id, origin_project_id AS originProjectId, origin_topic_id AS originTopicId, origin_topic_revision AS originTopicRevision,
  origin_message_sequence AS originMessageSequence, project_id AS projectId, topic_id AS topicId, link_message_id AS linkMessageId,
  link_source_id AS linkSourceId, link_source_revision AS linkSourceRevision, link_source_generation AS linkSourceGeneration,
  reply_id AS replyId, proposal_id AS proposalId, proposal_revision AS proposalRevision, created_at AS createdAt`;
interface PromotionRow {
  id: string; originProjectId: string; originTopicId: string; originTopicRevision: number; originMessageSequence: number;
  projectId: string; topicId: string; linkMessageId: string; linkSourceId: string; linkSourceRevision: number; linkSourceGeneration: number;
  replyId: string; proposalId: string; proposalRevision: number; createdAt: number;
}
const promotionOf = (row: PromotionRow): TopicPromotion => ({
  id: row.id, origin: { projectId: row.originProjectId, topicId: row.originTopicId, topicRevision: row.originTopicRevision, messageSequence: row.originMessageSequence },
  target: { projectId: row.projectId, topicId: row.topicId },
  link: { messageId: row.linkMessageId, source: { sourceId: row.linkSourceId, revision: row.linkSourceRevision, generation: row.linkSourceGeneration } },
  replyId: row.replyId, proposalId: row.proposalId, proposalRevision: row.proposalRevision, createdAt: row.createdAt,
});

/** The promotion whose origin is this topic, or null. A promoted origin is read-only. */
export function promotionFrom(tx: AppTransaction, projectId: string, topicId: string): TopicPromotion | null {
  const row = tx.get<PromotionRow>(`SELECT ${promotionColumns} FROM topic_promotions WHERE origin_project_id = ? AND origin_topic_id = ?`, projectId, topicId);
  return row ? promotionOf(row) : null;
}
/** The promotion this topic continues, or null. */
export function promotionInto(tx: AppTransaction, projectId: string, topicId: string): TopicPromotion | null {
  const row = tx.get<PromotionRow>(`SELECT ${promotionColumns} FROM topic_promotions WHERE project_id = ? AND topic_id = ?`, projectId, topicId);
  return row ? promotionOf(row) : null;
}

/** Refuses a command that would add conversation to a promoted origin topic; the owner continues in the new project. */
export function requireTopicOpen(tx: AppTransaction, projectId: string, topicId: string): void {
  const promotion = promotionFrom(tx, projectId, topicId);
  if (promotion) throw new AppError("topic_promoted", 409, { projectId: promotion.target.projectId, path: `/projects/${promotion.target.projectId}/topics/${promotion.target.topicId}` });
}

/** Origin messages shown in the continuation; more are a link to the origin topic. */
const originMessageLimit = 50;

/** app.topic_promotion/v1 read model of one topic (see {@link TopicPromotionView}). Reads only. */
export function readTopicPromotion(tx: AppTransaction, projectId: string, topicId: string): TopicPromotionView {
  const from = promotionFrom(tx, projectId, topicId), into = promotionInto(tx, projectId, topicId);
  const projectName = (id: string) => tx.get<{ name: string }>("SELECT name FROM projects WHERE id = ?", id)?.name ?? "";
  const title = (project: string, topic: string) => { try { return readTopic(tx, project, topic).title; } catch { return null; } };
  let continuedFrom: TopicPromotionView["continuedFrom"] = null;
  if (into) {
    // Read through the origin's own project at the linked revision: deleted text reads as unavailable there and here.
    const page = readMessages(tx, into.origin.projectId, into.origin.topicId, 0, originMessageLimit);
    const linked = page.items.filter(item => item.sequence <= into.origin.messageSequence);
    const jit = new Set(linked.length ? tx.all<{ id: string }>(`SELECT reply_message_id AS id FROM jit_replies WHERE project_id = ? AND topic_id = ? AND reply_message_id IS NOT NULL`,
      into.origin.projectId, into.origin.topicId).map(row => row.id) : []);
    continuedFrom = { ...into, origin: { ...into.origin, project: { id: into.origin.projectId, name: projectName(into.origin.projectId) },
      topicTitle: title(into.origin.projectId, into.origin.topicId),
      messages: linked.map(item => ({ ...item, jit: jit.has(item.id) || (item.attribution.kind === "service" && item.attribution.service === "jit-setup") })),
      hasMore: linked.length < into.origin.messageSequence } };
  }
  return {
    promotedTo: from ? { ...from, project: { id: from.target.projectId, name: projectName(from.target.projectId) }, topicTitle: title(from.target.projectId, from.target.topicId) } : null,
    continuedFrom,
  };
}

/** Projects a stored proposal into its card view. */
export function promotionProposalViews(reply: { id: string; projectId: string; topicId: string }, proposal: PromotionProposal | undefined,
  replySequence: number | null, promotion: TopicPromotion | null): PromotionProposalView[] {
  if (!proposal) return [];
  const head = proposal.revisions.at(-1)!, first = proposal.revisions[0]!;
  const own = promotion && promotion.proposalId === proposal.id ? promotion : null;
  return [{ id: proposal.id, kind: "promotion", replyId: reply.id, projectId: reply.projectId, topicId: reply.topicId,
    revision: head.revision, state: head.state, author: head.author, name: head.name, dropped: first.dropped, droppedTotal: first.droppedTotal,
    promotion: own ? { id: own.id, projectId: own.target.projectId, topicId: own.target.topicId } : null, replySequence,
    closedByDeletion: head.closedBy === "deletion", closedByPromotion: head.closedBy === "promotion",
    history: proposal.revisions.map(item => ({ revision: item.revision, author: item.author, state: item.state })),
    updatedAt: head.decidedAt ?? head.createdAt }];
}

const exact = (value: unknown, keys: string[]) => !!value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).sort().join(",") === [...keys].sort().join(",");

/** Validates the exact command shape and returns its receipt identity. */
export function promotionIdentity(command: PromotionCommand): string {
  const target = ["topicId", "replyId", "proposalId"];
  if (!exact(command, ["kind", "requestId", "projectId", "expectedRevision", "payload"]) || !isPromotionCommand(command) ||
      typeof command.requestId !== "string" || !/^[a-zA-Z0-9_-]{8,128}$/.test(command.requestId) ||
      !Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1 ||
      !exact(command.payload, command.kind === "topic.promote.revise" ? [...target, "name"] : target)) {
    throw new AppError("invalid_promotion_command");
  }
  requireId(command.projectId); requireId(command.payload.topicId); requireId(command.payload.replyId); requireId(command.payload.proposalId);
  const p = command.payload;
  if (command.kind === "topic.promote.revise") {
    const name = (p as { name: unknown }).name;
    if (typeof name !== "string" || !validName(name.trim())) throw new AppError("invalid_promotion_command");
    return JSON.stringify([command.kind, command.projectId, command.expectedRevision, p.topicId, p.replyId, p.proposalId, name]);
  }
  return JSON.stringify([command.kind, command.projectId, command.expectedRevision, p.topicId, p.replyId, p.proposalId]);
}

/** Whether a reply or team discussion of this topic is still queued, running or waiting; its result would land after the link. */
function topicBusy(tx: AppTransaction, projectId: string, topicId: string): boolean {
  return !!tx.get(`SELECT 1 FROM team_runs r JOIN jobs j ON j.id = r.job_id WHERE r.project_id = ? AND json_extract(r.record_json, '$.topicId') = ?
    AND j.state IN ('queued', 'admitted', 'waiting') LIMIT 1`, projectId, topicId);
}

/** Closes every other open promotion proposal of the origin topic: the topic has one continuation. */
function closeSiblings(tx: AppTransaction, projectId: string, topicId: string, keep: string, now: number): void {
  for (const row of tx.all<{ id: string }>("SELECT run_id AS id FROM jit_replies WHERE project_id = ? AND topic_id = ? AND run_id IS NOT NULL", projectId, topicId)) {
    const record = readReplyRecord(tx, projectId, row.id);
    const head = record.promotionProposal?.revisions.at(-1);
    if (!head || record.promotionProposal!.id === keep || head.state !== "proposed") continue;
    head.state = "superseded"; head.decidedAt = now; head.closedBy = "promotion";
    record.updatedAt = now;
    saveReplyRecord(tx, record);
  }
}

/**
 * Applies one owner command inside the caller's receipt transaction. The proposal must belong to a committed Jit reply
 * in the General space topic named by the command, its current revision must be open and equal `expectedRevision`,
 * and only accept promotes. A topic is promoted at most once (`topic_promotions.origin_topic_id` is unique).
 */
export function executePromotion(tx: AppTransaction, command: PromotionCommand, now: number): PromotionReceipt {
  const general = generalProjectId(tx);
  if (!general || command.projectId !== general) throw new AppError("promotion_proposal_not_found", 404);
  let record: ReturnType<typeof readReplyRecord>;
  try { record = readReplyRecord(tx, command.projectId, command.payload.replyId); }
  catch { throw new AppError("promotion_proposal_not_found", 404); }
  const proposal = record.topicId === command.payload.topicId && record.replyMessageId && record.promotionProposal?.id === command.payload.proposalId
    ? record.promotionProposal : undefined;
  if (!proposal) throw new AppError("promotion_proposal_not_found", 404);
  const head = proposal.revisions.at(-1)!;
  if (head.state !== "proposed") throw new AppError("promotion_proposal_closed", 409);
  if (head.revision !== command.expectedRevision) throw new AppError("promotion_proposal_stale", 409);
  const origin = { projectId: record.projectId, topicId: record.topicId };
  let promotion: TopicPromotion | null = null, workspaceRevision = 0;
  if (command.kind === "topic.promote.accept") {
    if (promotionFrom(tx, origin.projectId, origin.topicId)) throw new AppError("topic_already_promoted", 409);
    if (topicBusy(tx, origin.projectId, origin.topicId)) throw new AppError("promotion_topic_busy", 409);
    const at = tx.get<{ revision: number; sequence: number }>("SELECT revision, message_sequence AS sequence FROM topics WHERE project_id = ? AND id = ?", origin.projectId, origin.topicId)!;
    // The new project, exactly as project.create writes one, named by the accepted revision.
    const projectId = crypto.randomUUID(), groupId = crypto.randomUUID();
    tx.run("INSERT INTO projects VALUES (?, ?, 1, ?)", projectId, head.name, now);
    tx.run("INSERT INTO project_groups VALUES (?, ?)", groupId, projectId);
    tx.run("UPDATE app_state SET revision = revision + 1 WHERE id = 1");
    workspaceRevision = tx.get<{ revision: number }>("SELECT revision FROM app_state WHERE id = 1")!.revision;
    // The continuation topic is titled with the accepted name, never a copy of origin text.
    const { topic } = mutateConversation(tx, { kind: "topic.create", projectId, requestId: command.requestId, expectedRevision: 1, payload: { title: head.name } }, now) as TopicReceipt;
    // Its first record names the origin at its exact revision. Identity only: no origin text enters the new project.
    const source = registerExternalSource(tx, { projectId, committedAt: now, descriptor: { kind: "external", system: "jit", resourceType: "topic",
      resourceId: `${origin.projectId}/${origin.topicId}`, revisionHint: `revision ${at.revision} message ${at.sequence}` } });
    const messageId = crypto.randomUUID();
    tx.run("INSERT INTO messages VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)", messageId, projectId, topic.id, now,
      JSON.stringify({ kind: "service", service: "jit-promotion" }), source.sourceId, source.revision, source.generation);
    // Like other service messages it advances message order only; the topic revision counts owner changes.
    tx.run("UPDATE topics SET message_sequence = 1 WHERE project_id = ? AND id = ?", projectId, topic.id);
    const id = crypto.randomUUID();
    tx.run(`INSERT INTO topic_promotions (id, origin_project_id, origin_topic_id, origin_topic_revision, origin_message_sequence, project_id, topic_id,
      link_message_id, link_source_id, link_source_revision, link_source_generation, reply_id, proposal_id, proposal_revision, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, id, origin.projectId, origin.topicId, at.revision, at.sequence, projectId, topic.id,
    messageId, source.sourceId, source.revision, source.generation, record.id, proposal.id, head.revision, now);
    promotion = promotionFrom(tx, origin.projectId, origin.topicId)!;
    head.state = "accepted"; head.decidedAt = now; proposal.promotionId = id;
    closeSiblings(tx, origin.projectId, origin.topicId, proposal.id, now);
  } else if (command.kind === "topic.promote.dismiss") {
    head.state = "rejected"; head.decidedAt = now;
  } else {
    const name = command.payload.name.trim();
    head.state = "superseded"; head.decidedAt = now;
    proposal.revisions.push({ revision: head.revision + 1, author: "owner", state: "proposed", name, dropped: [], droppedTotal: 0, createdAt: now, decidedAt: null });
  }
  record.updatedAt = now;
  saveReplyRecord(tx, record);
  const sequence = tx.get<{ sequence: number }>("SELECT sequence FROM messages WHERE id = ?", record.replyMessageId)?.sequence ?? null;
  const view = promotionProposalViews(record, proposal, sequence, promotion ?? promotionFrom(tx, origin.projectId, origin.topicId))[0]!;
  return { proposal: view, ...(promotion ? { promotion, workspaceRevision } : {}) };
}

/**
 * Data-lifecycle rule for a stored promotion proposal: the app.role_proposals/v1 rule (Jit-authored text only; an open
 * revision whose text is rewritten is closed by deletion). Owner revisions and an accepted project name are owner
 * configuration and stay exact.
 */
export function redactPromotionProposal(value: unknown, rewrite: (text: string) => string): { value: unknown; changed: boolean } {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { value, changed: false };
  const result = redactRoleProposals([value], rewrite);
  return { value: (result.value as unknown[])[0], changed: result.changed };
}
