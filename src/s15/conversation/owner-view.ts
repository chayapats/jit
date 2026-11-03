import type { ConversationApplication } from "./application";
import type { ConversationEvidence, ConversationReceipt, ConversationRequest, ConversationScope } from "./types";
import { identity } from "./validation";
import type { ActionRef, ActionSlip, Observation } from "../policy";

/** CHAT row of the Opus-authored s15.owner-view/v1 handoff; labels/layout remain the UI's responsibility. */
export interface ConversationOwnerRow {
  requestId: string; receipt: ConversationReceipt; ownerMessage: string;
  /** Current request revision; a clarification continuation must name it exactly. */
  revision: number;
  /** Subject grounded from the owner's original bytes (for example `issue:328`), never from model output. */
  subject: string | null;
  state: "received" | "understanding" | "inspecting" | "working" | "needs_you" | "question" | "budget_hold" | "blocked" | "unsupported" | "unknown" | "stopped" | "done" | "partial" | "denied";
  intentLine: "report_only" | "started_work" | "obligation_only" | "question" | null;
  scopeLine: { authorityId: string; purposeId: string; policyRevision: number; resources: readonly string[]; access: ConversationScope["access"] } | null;
  /** Control progress never certifies completion; only observed committed evidence appears below. */
  progress: { provisional: true; phase: "interpretation" | "work" | "decision"; active: boolean };
  evidence: ConversationEvidence[];
  result: { status: "done"; text: string } | null;
  needsYou: ConversationNeedsYou | null;
  slips: ActionSlip[];
  memory: ConversationRequest["memory"] | null;
  /** The owner's latest clarification reply when it differs from the root message; owner bytes, not model text. */
  reply: string | null;
  /** Material clarification hold only: issue references taken from the owner's own original bytes. They are reply labels, not a selection. */
  question: { candidates: string[] } | null;
  /** Owner decision this message recorded on one exact action revision, with its dispatch observation when known. */
  decision: { action: ActionRef; decision: "approve" | "deny"; outcome: Observation["outcome"] | null } | null;
}
/** Safe hold entry with the real POLICY owner-only exact prepared payload projection. */
export interface ConversationNeedsYou { id: string; requestId: string; code: string; kind: "question" | "action" | "reconciliation"; slip: ActionSlip | null }
/** Bounded read-only owner projection; no polling/reconnect action can admit work or approve a slip. */
export interface ConversationOwnerView { contract: "s15.owner-view/v1"; conversationId: string;
  /** Latest event sequence of this conversation; a client resumes event reads after it. */
  cursor: number; rows: ConversationOwnerRow[]; needsYou: ConversationNeedsYou[] }
/** Read-only navigation entry; the label is the owner's own first message, never model text. */
export interface ConversationListEntry { conversationId: string; firstMessage: string; latestAt: number }

function state(request: ConversationRequest): ConversationOwnerRow["state"] {
  if (request.state === "stopped") return "stopped";
  if (request.decision?.decision === "deny") return "denied";
  if (request.decision?.observation?.outcome === "succeeded") return "done";
  if (request.state === "completed" && request.code === "owner_start_required") return "question";
  if (request.state === "completed") return request.result === null ? "blocked" : "done";
  if (request.state === "reconcile_only") return "unknown";
  if (request.state === "accepted") return "received";
  if (request.state === "blocked") return "blocked";
  if (request.state === "held" || request.state === "proposed") {
    if (request.code === "material_ambiguity" || request.code === "approval_reference_required") return "question";
    if (request.code === "budget_exhausted" || request.code === "finite_budget_required") return "budget_hold";
    if (request.code === "adapter_unproven" || request.code === "tool_unavailable") return "unsupported";
    return "needs_you";
  }
  if (request.phase === "interpretation") return "understanding";
  return request.intent.kind === "inspect" ? "inspecting" : "working";
}

/** Projects only currently authenticated owner rows; app.view reacquires publication guards for result/evidence. */
export function conversationOwnerView<Actor, Work>(app: ConversationApplication<Actor, Work>, actor: Actor, conversationId: string): ConversationOwnerView {
  app.options.policy.requireOwner(actor); identity(conversationId);
  const rows = app.store.db.query<{ id: string }, [string]>("SELECT id FROM requests WHERE conversation_id=? ORDER BY rowid DESC LIMIT 32").all(conversationId).reverse().map(({ id }) => ownerRow(app, actor, id));
  const cursor = app.store.db.query<{ cursor: number | null }, [string]>("SELECT max(sequence) AS cursor FROM events WHERE conversation_id=?").get(conversationId)?.cursor ?? 0;
  return { contract: "s15.owner-view/v1", conversationId, cursor, rows, needsYou: [...new Map(rows.flatMap(row => row.needsYou ? [[row.needsYou.id, row.needsYou] as const] : [])).values()] };
}

/** One owner row; app.view rechecks the owner and reacquires publication guards for result and evidence. */
function ownerRow<Actor, Work>(app: ConversationApplication<Actor, Work>, actor: Actor, id: string): ConversationOwnerRow {
    const request = app.view(actor, id);
    // Settled actions do not certify the interrupted model's entire completion rule.
    const disposition = request.state === "held" && request.slips.length > 0 && request.slips.every(slip => slip.state === "succeeded") ? "partial" : state(request);
    const pendingSlip = request.slips.find(slip => slip.state === "pending" || slip.state === "unknown");
    const needsYou: ConversationNeedsYou | null = pendingSlip ? { id: `action_${pendingSlip.action.id}_${pendingSlip.action.revision}`, requestId: id, code: pendingSlip.reasonCode ?? "approval_required", kind: pendingSlip.state === "unknown" ? "reconciliation" : "action", slip: pendingSlip } : request.slips.length === 0 && ["question", "needs_you", "budget_hold", "unknown"].includes(disposition) ? { id: `hold_${id}_${request.revision}`, requestId: id, code: request.code ?? "policy_match_required", kind: disposition === "question" ? "question" : disposition === "unknown" ? "reconciliation" : "action", slip: null } : null;
    const question = request.state === "held" && request.code === "material_ambiguity" && request.phase === "interpretation"
      ? { candidates: [...new Set([...request.command.text.matchAll(/(?:issue\s*|#)(\d+)/gi)].map(match => `#${match[1]}`))].slice(0, 4) } : null;
    return { requestId: id, receipt: request.receipt, ownerMessage: request.command.text, revision: request.revision, subject: request.intent.subject, state: disposition,
      intentLine: request.phase === "decision" ? null : request.state === "accepted" ? "obligation_only" : request.phase === "interpretation" ? request.state === "held" ? "question" : null : request.intent.kind === "inspect" ? "report_only" : request.intent.kind === "execute" ? "started_work" : null,
      scopeLine: request.authority && request.intent.scope ? { authorityId: request.authority.id, purposeId: request.authority.purposeId, policyRevision: request.authority.policyRevision, resources: request.authority.resources, access: request.intent.scope.access } : null,
      progress: { provisional: true, phase: request.phase, active: request.state === "running" }, evidence: request.evidence,
      result: request.result === null ? null : { status: "done", text: request.result }, needsYou, slips: request.slips, memory: request.memory ?? null, question,
      reply: request.interpretationRequest.requestId === request.command.requestId ? null : request.interpretationRequest.text,
      decision: request.decision ? { action: { ...request.decision.action }, decision: request.decision.decision, outcome: request.decision.observation?.outcome ?? null } : null };
}

/**
 * Every outstanding owner item across all conversations, independent of the bounded thread and
 * navigation windows, newest first. Only requests that can still wait on the owner are read.
 */
export function conversationPendingNeeds<Actor, Work>(app: ConversationApplication<Actor, Work>, actor: Actor): { conversationId: string; entry: ConversationNeedsYou }[] {
  app.options.policy.requireOwner(actor);
  const candidates = app.store.db.query<{ id: string; conversation_id: string }, []>(`SELECT id, conversation_id FROM requests WHERE state IN ('held','proposed','reconcile_only')
    OR (state='completed' AND json_extract(record_json,'$.code')='owner_start_required')
    OR (state<>'stopped' AND json_array_length(json_extract(record_json,'$.actions'))>0) ORDER BY rowid DESC LIMIT 1024`).all();
  return candidates.flatMap(({ id, conversation_id }) => { const entry = ownerRow(app, actor, id).needsYou; return entry ? [{ conversationId: conversation_id, entry }] : []; });
}

/** Recent conversations for the authenticated owner, newest first. Reading starts no model, tool or queue. */
export function conversationList<Actor, Work>(app: ConversationApplication<Actor, Work>, actor: Actor, limit = 32): ConversationListEntry[] {
  const owner = app.options.policy.requireOwner(actor);
  const rows = app.store.db.query<{ conversation_id: string; latest: number }, [number]>("SELECT conversation_id, max(rowid) AS latest FROM requests GROUP BY conversation_id ORDER BY latest DESC LIMIT ?").all(Math.max(1, Math.min(limit, 64)));
  return rows.flatMap(row => {
    const first = app.store.db.query<{ id: string }, [string]>("SELECT id FROM requests WHERE conversation_id=? ORDER BY rowid LIMIT 1").get(row.conversation_id)!;
    const latest = app.store.db.query<{ id: string }, [number]>("SELECT id FROM requests WHERE rowid=?").get(row.latest)!;
    const opening = app.store.request(first.id), last = app.store.request(latest.id);
    if (opening.owner.id !== owner.id || opening.owner.generation !== owner.generation) return [];
    return [{ conversationId: row.conversation_id, firstMessage: opening.command.text, latestAt: last.receipt.receivedAt }];
  });
}

/**
 * Owner-checked lookup of one prepared action across every conversation, independent of the bounded
 * thread and navigation windows. It reads the newest work request that prepared the action through
 * app.view, so ownership, presentation and replacement resolution are the same as for a thread read.
 */
export function conversationAction<Actor, Work>(app: ConversationApplication<Actor, Work>, actor: Actor, actionId: string): { conversationId: string; requestId: string; slips: ActionSlip[] } | null {
  app.options.policy.requireOwner(actor); identity(actionId);
  const row = app.store.db.query<{ id: string; conversation_id: string }, [string]>("SELECT r.id, r.conversation_id FROM requests r, json_each(r.record_json, '$.actions') a WHERE json_extract(a.value, '$.id')=? AND json_extract(r.record_json, '$.phase')='work' ORDER BY r.rowid DESC LIMIT 1").get(actionId);
  if (!row) return null;
  const view = app.view(actor, row.id);
  return { conversationId: row.conversation_id, requestId: row.id, slips: view.slips.filter(slip => slip.action.id === actionId) };
}
