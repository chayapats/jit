import { AppError } from "../errors";
import type { AppConfig } from "../config";
import { requireId } from "../sources";
import type { AppTransaction } from "../store";
import { readTeam } from "./configuration";
import type { Discussion } from "./types";

/**
 * app.routing_selection/v1 rules (ADR 0033, revised by #169). Only explicit owner intent calls specialists without
 * Jit: `named` and `reply`. Otherwise Jit answers itself and may propose a dispatch (`model`). `follow_up` and
 * `single` stay in the type because discussions recorded before #169 carry them; the service no longer selects them.
 */
export type SelectionRule = "named" | "reply" | "follow_up" | "single" | "model";
/** Fixed rules the service still applies, in order. */
export const fixedSelectionRules = ["named", "reply"] as const;
/**
 * How the specialists of one dispatch were chosen. `roleIds` are role ids from owner configuration; `why` is Jit's
 * own short reason for a `model` selection (untrusted text, shown escaped and labelled as Jit's reasoning, never as
 * evidence) and null for every fixed rule.
 */
export interface RoutingSelection { rule: SelectionRule; roleIds: string[]; why: string | null }
/** The participation an owner message replies to: one role inside one discussion of the same topic. */
export interface ParticipationReference { discussionId: string; roleId: string }
/**
 * A fixed-rule result. `continues` names the discussion a `follow_up` continues, so that discussion stops counting as
 * open once the follow-up starts; it is null for the other rules.
 */
export interface FixedSelection { selection: RoutingSelection & { rule: Exclude<SelectionRule, "model"> }; continues: string | null }
/**
 * The only open Jit-dispatched discussion that the owner's message directly follows (#169). It never calls anyone by
 * itself: Jit is told about it, and a dispatch Jit proposes for a subset of these roles continues that discussion.
 */
export interface FollowUpCandidate { discussionId: string; roleIds: string[] }

/** Longest `why` a model selection may carry, in characters (code points). */
export const selectionWhyLimit = 160;

/** Role-name lookup key shared with app.dispatch_allowance/v1 matching: NFC, case-insensitive, exact. */
export const roleKey = (name: string) => name.normalize("NFC").toLocaleLowerCase();

/** Validates an owner reply target's shape (ids only); its existence is checked by {@link selectRoles}. */
export function requireParticipationReference(value: unknown): ParticipationReference {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "discussionId,roleId") {
    throw new AppError("invalid_conversation_command");
  }
  const { discussionId, roleId } = value as ParticipationReference;
  requireId(discussionId); requireId(roleId);
  return { discussionId, roleId };
}

const wordChar = /[\p{L}\p{M}\p{N}_]/u;
/**
 * The configured role keys the owner wrote as `@name`. A mention starts at an `@` that is not inside a word or an
 * address (`a@b` is not a mention) and must end at a word boundary; the longest configured key that fits wins, so
 * names may contain spaces. Text that names no configured role is not a mention.
 */
function mentionedKeys(text: string, keys: readonly string[]): string[] {
  const haystack = roleKey(text), longestFirst = [...keys].filter(Boolean).sort((a, b) => b.length - a.length);
  const found: string[] = [];
  for (let index = haystack.indexOf("@"); index !== -1; index = haystack.indexOf("@", index + 1)) {
    const before = Array.from(haystack.slice(Math.max(0, index - 2), index)).at(-1);
    if (before !== undefined && (wordChar.test(before) || before === "@" || before === ".")) continue;
    const rest = haystack.slice(index + 1);
    const key = longestFirst.find(candidate => rest.startsWith(candidate) && !wordChar.test(Array.from(rest.slice(candidate.length, candidate.length + 2))[0] ?? ""));
    if (key && !found.includes(key)) found.push(key);
  }
  return found;
}

/** Whether the owner has a current (not superseded) decision on this discussion; a decided discussion is closed. */
function decided(tx: AppTransaction, projectId: string, discussionId: string): boolean {
  return !!tx.get(`SELECT 1 FROM owner_decisions WHERE project_id = ? AND superseded_by IS NULL
    AND proposal_id IN (SELECT id FROM decision_proposals WHERE project_id = ? AND discussion_id = ?) LIMIT 1`, projectId, projectId, discussionId);
}

/**
 * app.routing_selection/v1: the fixed rules of ADR 0033, evaluated in order inside the owner's `message.send`
 * transaction, with no model call. Returns null when no rule applies, so Jit's tool-less dispatch proposal decides.
 *
 * 1. `named`: every `@name` that exactly matches one enabled, routed specialist (NFC, case-insensitive). A mention
 *    shared by several eligible specialists is ambiguous: the service does not guess, so only an explicit `reply`
 *    target may still apply and otherwise the model path decides. Mentions of the coordinator, of disabled or unrouted
 *    roles, or of nobody are ignored.
 * 2. `reply`: the message replies to a participation (`replyTo`) whose role is still an eligible specialist. The
 *    discussion must belong to this topic and the role must take part in it (`reply_target_not_found`).
 *
 * Nothing else calls specialists without Jit (#169): an owner message that names nobody is answered by Jit, which
 * proposes a dispatch only when the message needs the team. The former `follow_up` condition is now
 * {@link followUpCandidate}, context for that proposal; the former `single` rule is gone, because it called the only
 * specialist on every message, small talk included.
 *
 * The selection only names roles. Admission still runs through app.dispatch_allowance/v1 when Jit's reply commits:
 * the roles are checked against configuration again and against the allowance current then.
 */
export function selectRoles(tx: AppTransaction, input: {
  message: { id: string; sequence: number; text: string | null; replyTo?: ParticipationReference | null };
  topic: { id: string }; project: { id: string }; config: AppConfig;
}): FixedSelection | null {
  const { message, topic, project, config } = input;
  const team = readTeam(tx, project.id, config.team);
  const eligible = team.roles.filter(role => role.kind === "specialist" && role.enabled && !!role.effective.route);
  const eligibleIds = new Set(eligible.map(role => role.id));
  // A reply target is owner input: it must exist in this topic even when an earlier rule decides.
  let replyTarget: Discussion | null = null;
  if (message.replyTo) {
    const row = tx.get<{ record_json: string }>("SELECT record_json FROM team_runs WHERE project_id = ? AND id = ?", project.id, message.replyTo.discussionId);
    const discussion = row ? JSON.parse(row.record_json) as Discussion : null;
    if (!discussion || discussion.kind !== "discussion" || discussion.topicId !== topic.id ||
        !discussion.participations.some(item => item.roleId === message.replyTo!.roleId)) throw new AppError("reply_target_not_found", 404);
    replyTarget = discussion;
  }
  let ambiguous = false;
  if (message.text) {
    const named: string[] = [];
    for (const key of mentionedKeys(message.text, [...new Set(team.roles.map(role => roleKey(role.name)))])) {
      const callable = eligible.filter(role => roleKey(role.name) === key);
      if (callable.length > 1) ambiguous = true;
      else if (callable.length === 1 && !named.includes(callable[0]!.id)) named.push(callable[0]!.id);
    }
    if (named.length && !ambiguous) return { selection: { rule: "named", roleIds: named, why: null }, continues: null };
  }
  if (replyTarget && eligibleIds.has(message.replyTo!.roleId)) {
    return { selection: { rule: "reply", roleIds: [message.replyTo!.roleId], why: null }, continues: null };
  }
  // The owner meant someone specific but the name fits several: the service does not guess, so the model decides.
  return null;
}

/**
 * The open discussion an owner message directly follows (#169, formerly the `follow_up` rule): the topic has exactly
 * one open Jit-dispatched discussion (not stopped, not decided by the owner and not continued by a later dispatch), its
 * team reply has committed, and no other owner message came after that team reply. The roles are its participants the
 * owner did not skip or exclude, still eligible. Returns null otherwise. It selects nobody.
 */
export function followUpCandidate(tx: AppTransaction, input: {
  message: { sequence: number }; topic: { id: string }; project: { id: string }; config: AppConfig;
}): FollowUpCandidate | null {
  const { message, topic, project, config } = input;
  const team = readTeam(tx, project.id, config.team);
  const eligibleIds = new Set(team.roles.filter(role => role.kind === "specialist" && role.enabled && !!role.effective.route).map(role => role.id));
  const dispatched = tx.all<{ discussionId: string; teamReplyId: string | null; recordJson: string }>(
    `SELECT discussion_id AS discussionId, team_reply_id AS teamReplyId, record_json AS recordJson FROM dispatch_proposals
     WHERE project_id = ? AND topic_id = ? AND discussion_id IS NOT NULL`, project.id, topic.id);
  const continued = new Set(dispatched.flatMap(row => {
    const continues = (JSON.parse(row.recordJson) as { continues?: string | null }).continues;
    return continues ? [continues] : [];
  }));
  const open = dispatched.filter(row => !continued.has(row.discussionId)).flatMap(row => {
    const stored = tx.get<{ record_json: string }>("SELECT record_json FROM team_runs WHERE project_id = ? AND id = ?", project.id, row.discussionId);
    const discussion = stored ? JSON.parse(stored.record_json) as Discussion : null;
    return discussion && !discussion.stoppedAll && !decided(tx, project.id, discussion.id) ? [{ row, discussion }] : [];
  });
  if (open.length === 1) {
    const { row, discussion } = open[0]!;
    const answered = row.teamReplyId ? tx.get<{ sequence: number }>(
      "SELECT m.sequence FROM jit_replies r JOIN messages m ON m.id = r.reply_message_id WHERE r.id = ?", row.teamReplyId) : null;
    const ownerSince = answered ? tx.get(`SELECT 1 FROM messages WHERE project_id = ? AND topic_id = ? AND sequence > ? AND sequence < ?
      AND json_extract(attribution_json, '$.kind') = 'owner' LIMIT 1`, project.id, topic.id, answered.sequence, message.sequence) : null;
    if (answered && answered.sequence < message.sequence && !ownerSince) {
      const roleIds = [...new Set(discussion.participations.filter(item => item.state !== "skipped" && item.state !== "excluded").map(item => item.roleId))]
        .filter(id => eligibleIds.has(id));
      if (roleIds.length) return { discussionId: discussion.id, roleIds };
    }
  }
  return null;
}

/**
 * The `why` of a model dispatch proposal: absent is null; otherwise a non-empty, well-formed single string of at most
 * {@link selectionWhyLimit} characters after trimming, or undefined when it breaks the closed schema.
 */
export function selectionWhy(value: unknown): string | null | undefined {
  if (value === undefined) return null;
  if (typeof value !== "string" || !value.isWellFormed()) return undefined;
  const why = value.replace(/\s+/g, " ").trim();
  return why && Array.from(why).length <= selectionWhyLimit ? why : undefined;
}
