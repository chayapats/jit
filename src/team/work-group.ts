import { commitAttentionIntent, resolveDeliveryIntent, type AttentionClass, type DeliveryResolution } from "../delivery";
import { AppError } from "../errors";
import { dictionaries, type MessageKey } from "../i18n";
import { readJob } from "../jobs/queue";
import { upgradeFenced } from "../ops/upgrade-fence";
import { readPersona } from "../persona";
import { promotionFrom } from "../promotion";
import type { AppTransaction, TransactionStore } from "../store";
import type { TeamPolicy } from "./types";
import { readDispatchCard, type DispatchCardView } from "./jit-dispatch";

/**
 * delivery.attention_levels/v1 work groups (REL04, ADR 0032 "Notify once").
 *
 * A Jit reply that admits a dispatch, the discussion it starts and the team reply that speaks for it form one work
 * group. The group id is assigned when the reply's dispatch proposal is recorded with at least one role (started under
 * the allowance or waiting on the owner's card) and is carried as `workGroupId` on the reply, discussion and team reply
 * records. A Jit reply without a dispatch forms no group and, as before REL04, creates no intent.
 *
 * Every evaluation reads committed state only and is idempotent: each notice key is decided once and the decision
 * (created, or filtered by the attention level) is stored on the `work_groups` row, so a restart, a replayed callback
 * or a later level change never adds a second intent for the same key.
 *
 * - Intermediate events (a specialist finishing, a team reply thinking) create nothing.
 * - Final: one notice once no participation is queued, running or waiting and the team reply's result is committed.
 * - Stalls on the owner create their `needs_owner` notice immediately: the proposal card, a role or team reply
 *   waiting on its route, a team reply that could not start, or settled work Jit did not answer.
 * - When a stall stops waiting (the owner answered from any channel, or it closed by itself), its intent is resolved
 *   in that same transaction: unsent work is cancelled, a sent one is marked resolved.
 */

/** One decided notice of a group. */
interface GroupNotice { class: AttentionClass; decision: "created" | "filtered"; intentId: string | null; at: number; resolved: boolean }
interface GroupRecord { items: Record<string, GroupNotice>; closed: string | null }
interface GroupRow { id: string; projectId: string; topicId: string; replyId: string; state: "open" | "closed"; recordJson: string }

type Notice = { item: string; class: AttentionClass; key: MessageKey; values: Record<string, string> };

/** The most open groups one sweep evaluates; the next tick continues after the last one, then wraps around. */
export const workGroupSweepLimit = 200;
/** Per-database position of the rotating sweep (process memory; a restart starts from the oldest group). */
const sweepCursors = new Map<string, { createdAt: number; id: string }>();

/**
 * Opens the work group of a dispatching reply inside its commit. Idempotent per reply (`reply_id` is unique);
 * returns the group id.
 */
export function openWorkGroup(tx: AppTransaction, input: { projectId: string; topicId: string; replyId: string; now: number }): string {
  const existing = tx.get<{ id: string }>("SELECT id FROM work_groups WHERE reply_id = ?", input.replyId);
  if (existing) return existing.id;
  const id = crypto.randomUUID();
  const record: GroupRecord = { items: {}, closed: null };
  tx.run("INSERT INTO work_groups (id, project_id, topic_id, reply_id, state, record_json, created_at, updated_at) VALUES (?, ?, ?, ?, 'open', ?, ?, ?)",
    id, input.projectId, input.topicId, input.replyId, JSON.stringify(record), input.now, input.now);
  return id;
}

/** Evaluates every open group of one topic (for example in the transaction that promotes it). */
export function evaluateTopicWorkGroups(tx: AppTransaction, projectId: string, topicId: string, policy: TeamPolicy, now: number, reason: DeliveryResolution["reason"]): void {
  for (const row of tx.all<{ id: string }>("SELECT id FROM work_groups WHERE project_id = ? AND topic_id = ? AND state = 'open' ORDER BY created_at, id", projectId, topicId)) {
    evaluateWorkGroup(tx, row.id, policy, now, reason);
  }
}

/** The group a dispatching Jit reply opened, or null. */
export function workGroupOfReply(tx: AppTransaction, replyId: string): string | null {
  return tx.get<{ id: string }>("SELECT id FROM work_groups WHERE reply_id = ?", replyId)?.id ?? null;
}

/**
 * The group a job belongs to: a specialist run's discussion, or a Jit reply (dispatching or team reply). Null for
 * every other job.
 */
export function workGroupOfJob(tx: AppTransaction, projectId: string, jobId: string): string | null {
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM team_runs WHERE project_id = ? AND job_id = ? LIMIT 1", projectId, jobId);
  if (!row) return null;
  const record = JSON.parse(row.record_json) as { kind?: string; workGroupId?: string | null; discussionId?: string; id?: string };
  if (record.kind === "specialist" && record.discussionId) {
    const discussion = tx.get<{ record_json: string }>("SELECT record_json FROM team_runs WHERE project_id = ? AND id = ?", projectId, record.discussionId);
    return discussion ? (JSON.parse(discussion.record_json) as { workGroupId?: string | null }).workGroupId ?? null : null;
  }
  if (record.kind === "jit_reply") return record.workGroupId ?? (record.id ? workGroupOfReply(tx, record.id) : null);
  return null;
}

/** The group of a discussion, from its record. */
export function workGroupOfDiscussion(tx: AppTransaction, projectId: string, discussionId: string): string | null {
  const row = tx.get<{ record_json: string }>("SELECT record_json FROM team_runs WHERE project_id = ? AND id = ?", projectId, discussionId);
  return row ? (JSON.parse(row.record_json) as { kind?: string; workGroupId?: string | null }).workGroupId ?? null : null;
}

/** The group of a dispatch proposal (through the reply that recorded it). */
export function workGroupOfProposal(tx: AppTransaction, projectId: string, proposalId: string): string | null {
  const row = tx.get<{ replyId: string }>("SELECT reply_id AS replyId FROM dispatch_proposals WHERE project_id = ? AND id = ?", projectId, proposalId);
  return row ? workGroupOfReply(tx, row.replyId) : null;
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

/** The owner-waiting stalls that hold now, and the final notice when the group has finished. */
function observe(tx: AppTransaction, row: GroupRow, card: DispatchCardView): { stalls: Notice[]; final: Notice | null; closed: string | null } {
  const stalls: Notice[] = [];
  const job = (jobId: string) => readJob(tx, row.projectId, jobId);
  // app.specialist_results/v2: every named role is still blocked on this request, so nothing ran and the card shows
  // their unblock actions; that blocked result waits on the owner.
  if (card.state === "empty" && card.blocked.length) {
    return { stalls, final: { item: "final:group", class: "needs_owner", key: "attention.notice_result_blocked", values: { count: String(card.blocked.length) } }, closed: "final" };
  }
  if (card.state === "empty" || card.state === "dismissed") return { stalls, final: null, closed: card.state };
  // A promoted origin is read-only (app.topic_promotion/v1): its card can no longer be accepted, and nobody can answer
  // there, so the group ends quietly and any notice still waiting on the owner resolves.
  const promoted = promotionFrom(tx, row.projectId, row.topicId) !== null;
  if (card.state === "proposed") {
    if (promoted) return { stalls, final: null, closed: "promoted" };
    stalls.push({ item: `proposal:${card.id}`, class: "needs_owner", key: "attention.notice_proposal", values: { count: String(card.roles.length) } });
    return { stalls, final: null, closed: null };
  }
  const discussion = card.discussion;
  if (!discussion) return { stalls, final: null, closed: null };
  // REL04 follow-up (#157): a stopped-all team closes silently. Check before
  // collecting stalls and before deciding any final, so a re-included role that
  // settles after stop-all never emits a final:group notice.
  if (discussion.stoppedAll) return { stalls, final: null, closed: "stopped" };
  for (const role of discussion.roles) {
    if (role.activity !== "waiting") continue;
    const waiting = job(role.jobId);
    stalls.push({ item: `job:${waiting.id}:${waiting.steps}`, class: "needs_owner", key: "attention.notice_blocked", values: { reason: waiting.reason } });
  }
  const reply = card.teamReply;
  // A role the owner included again after the team reply started keeps the group open until it settles too.
  const open = discussion.roles.some(role => role.activity !== "settled");
  if (reply) {
    if (reply.state === "thinking") return { stalls, final: null, closed: null };
    if (reply.state === "blocked") {
      const waiting = job(reply.jobId!);
      stalls.push({ item: `job:${waiting.id}:${waiting.steps}`, class: "needs_owner", key: "attention.notice_blocked", values: { reason: waiting.reason } });
      return { stalls, final: null, closed: null };
    }
    if (open) return { stalls, final: null, closed: null };
    if (reply.state === "answered") {
      // app.specialist_results/v2: a team answer that carries blocked results (each with its unblock action) waits on
      // the owner; an answer without them is informational.
      const blocked = (reply.team?.gaps ?? []).filter(gap => gap.reason === "result_blocked").length;
      return { stalls, final: blocked
        ? { item: "final:group", class: "needs_owner", key: "attention.notice_result_blocked", values: { count: String(blocked) } }
        : { item: "final:group", class: "informational", key: "attention.notice_final", values: { count: String(reply.team?.citations.length ?? 0) } }, closed: "final" };
    }
    if (reply.state === "failed") {
      return { stalls, final: { item: "final:group", class: "needs_owner", key: "attention.notice_failed", values: { reason: reply.reason ?? "worker_failed" } }, closed: "final" };
    }
    // Stopped by the owner (or never admitted): the owner's own action ends the group without a notice.
    return { stalls, final: null, closed: reply.state };
  }
  if (open) return { stalls, final: null, closed: null };
  if (promoted) return { stalls, final: null, closed: "promoted" };
  if (card.teamHold) {
    stalls.push({ item: `hold:${card.id}:${card.revision}`, class: "needs_owner", key: "attention.notice_hold", values: { reason: card.teamHold } });
    return { stalls, final: null, closed: null };
  }
  if (!discussion.roles.some(role => role.state === "completed" && role.opinion?.text != null)) {
    return { stalls, final: { item: "final:group", class: "needs_owner", key: "attention.notice_no_result", values: {} }, closed: "final" };
  }
  // Settled with results but no team reply (its admission failed outside any hold): the card offers "answer now".
  stalls.push({ item: `answer:${card.id}`, class: "needs_owner", key: "attention.notice_hold", values: { reason: "not_started" } });
  return { stalls, final: null, closed: null };
}

/** Fixed notice text in the persona's language: a dictionary sentence, reason codes and a page path; never model text. */
function noticeText(tx: AppTransaction, row: GroupRow, card: DispatchCardView, notice: Notice): string {
  const dictionary = dictionaries[readPersona(tx).language];
  const fill = (template: string, values: Record<string, string>) => template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? "");
  const path = `/projects/${row.projectId}/topics/${row.topicId}#dispatch-${card.id}`;
  return `${fill(dictionary[notice.key], notice.values)}\n${fill(dictionary["attention.notice_open"], { path })}`;
}

/**
 * Evaluates one work group from committed state inside the caller's transaction. Contained: a failure here rolls back
 * only the evaluation, never the result, control or owner command that triggered it; the next evaluation retries.
 * `reason` labels stalls that stopped waiting: `owner_answered` from an owner command, `no_longer_waiting` otherwise.
 */
export function evaluateWorkGroup(tx: AppTransaction, groupId: string | null | undefined, policy: TeamPolicy, now: number, reason: DeliveryResolution["reason"]): void {
  if (!groupId) return;
  try { withSavepoint(tx, "work_group_eval", () => evaluate(tx, groupId, policy, now, reason)); }
  catch { /* The sweep re-evaluates from committed state. */ }
}

function evaluate(tx: AppTransaction, groupId: string, policy: TeamPolicy, now: number, reason: DeliveryResolution["reason"]): void {
  if (!Number.isSafeInteger(now) || now < 0) throw new AppError("invalid_commit_time");
  const row = tx.get<GroupRow>(`SELECT id, project_id AS projectId, topic_id AS topicId, reply_id AS replyId, state, record_json AS recordJson
    FROM work_groups WHERE id = ?`, groupId);
  if (!row || row.state !== "open") return;
  const proposal = tx.get<{ id: string }>("SELECT id FROM dispatch_proposals WHERE project_id = ? AND reply_id = ?", row.projectId, row.replyId);
  if (!proposal) return;
  const record = JSON.parse(row.recordJson) as GroupRecord;
  const card = readDispatchCard(tx, row.projectId, proposal.id, policy);
  const seen = observe(tx, row, card);
  const waiting = new Set(seen.stalls.map(stall => stall.item));
  let changed = false;
  // Stalls that stopped waiting resolve their intents in this transaction (cancel unsent, mark sent resolved).
  for (const [item, notice] of Object.entries(record.items)) {
    if (notice.resolved || notice.class !== "needs_owner" || item === "final:group" || waiting.has(item)) continue;
    if (notice.intentId) resolveDeliveryIntent(tx, row.projectId, notice.intentId, reason, now);
    notice.resolved = true; changed = true;
  }
  for (const notice of [...seen.stalls, ...seen.final ? [seen.final] : []]) {
    if (record.items[notice.item]) continue;
    const dedupeKey = `attention/${row.id}/${notice.item}`;
    const receipt = commitAttentionIntent(tx, {
      projectId: row.projectId, kind: "report", text: noticeText(tx, row, card, notice), dedupeKey, maxBytes: 4000,
      attention: { class: notice.class, item: notice.item, workGroupId: row.id },
    }, now);
    record.items[notice.item] = { class: notice.class, decision: receipt ? "created" : "filtered", intentId: receipt?.intent.id ?? null, at: now, resolved: false };
    changed = true;
  }
  if (seen.closed) { record.closed = seen.closed; changed = true; }
  if (!changed) return;
  tx.run("UPDATE work_groups SET state = ?, record_json = ?, updated_at = ? WHERE id = ?", seen.closed ? "closed" : "open", JSON.stringify(record), now, row.id);
}

/**
 * Recomputes every open group from committed state, one transaction each. The service runs it on start and on every
 * tick, which covers transitions the queue makes alone (a route wait, a deadline, a restart's interrupted work).
 * Nothing runs under an upgrade or restore fence. Returns the number of groups evaluated.
 */
export function tickWorkGroups(store: TransactionStore, policy: TeamPolicy, now: number, limit = workGroupSweepLimit): number {
  if (upgradeFenced(store.path)) return 0;
  // Keyset pages that rotate through every open group, so long-waiting groups never starve newer ones.
  const after = sweepCursors.get(store.path) ?? { createdAt: -1, id: "" };
  const page = (from: { createdAt: number; id: string }) => store.read(tx => tx.all<{ id: string; createdAt: number }>(
    `SELECT id, created_at AS createdAt FROM work_groups WHERE state = 'open' AND (created_at > ? OR (created_at = ? AND id > ?))
     ORDER BY created_at, id LIMIT ?`, from.createdAt, from.createdAt, from.id, limit));
  let rows = page(after);
  if (rows.length < limit && after.createdAt >= 0) {
    const seen = new Set(rows.map(row => row.id));
    rows = [...rows, ...page({ createdAt: -1, id: "" }).filter(row => !seen.has(row.id))].slice(0, limit);
  }
  const last = rows.at(-1);
  sweepCursors.set(store.path, last && rows.length >= limit ? { createdAt: last.createdAt, id: last.id } : { createdAt: -1, id: "" });
  const ids = rows.map(row => row.id);
  for (const id of ids) {
    try { store.transaction(tx => evaluateWorkGroup(tx, id, policy, now, "no_longer_waiting")); }
    catch { /* Storage or ownership failure: the next tick retries. */ }
  }
  return ids.length;
}
