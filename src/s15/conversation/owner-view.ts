import type { ConversationApplication } from "./application";
import type { ConversationEvidence, ConversationReceipt, ConversationRequest, ConversationScope } from "./types";
import { identity } from "./validation";
import type { ActionSlip } from "../policy";

/** CHAT row of the Opus-authored s15.owner-view/v1 handoff; labels/layout remain the UI's responsibility. */
export interface ConversationOwnerRow {
  requestId: string; receipt: ConversationReceipt; ownerMessage: string;
  state: "received" | "understanding" | "inspecting" | "working" | "needs_you" | "question" | "budget_hold" | "blocked" | "unsupported" | "unknown" | "stopped" | "done" | "partial" | "denied";
  intentLine: "report_only" | "started_work" | "obligation_only" | "question" | null;
  scopeLine: { authorityId: string; purposeId: string; policyRevision: number; resources: readonly string[]; access: ConversationScope["access"] } | null;
  /** Control progress never certifies completion; only observed committed evidence appears below. */
  progress: { provisional: true; phase: "interpretation" | "work" | "decision"; active: boolean };
  evidence: ConversationEvidence[];
  result: { status: "done"; text: string } | null;
  needsYou: ConversationNeedsYou | null;
  slips: ActionSlip[];
}
/** Safe hold entry with the real POLICY owner-only exact prepared payload projection. */
export interface ConversationNeedsYou { id: string; requestId: string; code: string; kind: "question" | "action" | "reconciliation"; slip: ActionSlip | null }
/** Bounded read-only owner projection; no polling/reconnect action can admit work or approve a slip. */
export interface ConversationOwnerView { contract: "s15.owner-view/v1"; conversationId: string; rows: ConversationOwnerRow[]; needsYou: ConversationNeedsYou[] }

function state(request: ConversationRequest): ConversationOwnerRow["state"] {
  if (request.state === "stopped") return "stopped";
  if (request.decision?.decision === "deny") return "denied";
  if (request.decision?.observation?.outcome === "succeeded") return "done";
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
  const rows = app.store.db.query<{ id: string }, [string]>("SELECT id FROM requests WHERE conversation_id=? ORDER BY rowid DESC LIMIT 32").all(conversationId).reverse().map(({ id }): ConversationOwnerRow => {
    const request = app.view(actor, id);
    // Settled actions do not certify the interrupted model's entire completion rule.
    const disposition = request.state === "held" && request.slips.length > 0 && request.slips.every(slip => slip.state === "succeeded") ? "partial" : state(request);
    const pendingSlip = request.slips.find(slip => slip.state === "pending" || slip.state === "unknown");
    const needsYou: ConversationNeedsYou | null = pendingSlip ? { id: `action_${pendingSlip.action.id}_${pendingSlip.action.revision}`, requestId: id, code: pendingSlip.reasonCode ?? "approval_required", kind: pendingSlip.state === "unknown" ? "reconciliation" : "action", slip: pendingSlip } : request.slips.length === 0 && ["question", "needs_you", "budget_hold", "unknown"].includes(disposition) ? { id: `hold_${id}_${request.revision}`, requestId: id, code: request.code ?? "policy_match_required", kind: disposition === "question" ? "question" : disposition === "unknown" ? "reconciliation" : "action", slip: null } : null;
    return { requestId: id, receipt: request.receipt, ownerMessage: request.command.text, state: disposition,
      intentLine: request.phase === "decision" ? null : request.state === "accepted" ? "obligation_only" : request.phase === "interpretation" ? request.state === "held" ? "question" : null : request.intent.kind === "inspect" ? "report_only" : request.intent.kind === "execute" ? "started_work" : null,
      scopeLine: request.authority && request.intent.scope ? { authorityId: request.authority.id, purposeId: request.authority.purposeId, policyRevision: request.authority.policyRevision, resources: request.authority.resources, access: request.intent.scope.access } : null,
      progress: { provisional: true, phase: request.phase, active: request.state === "running" }, evidence: request.evidence,
      result: request.result === null ? null : { status: "done", text: request.result }, needsYou, slips: request.slips };
  });
  return { contract: "s15.owner-view/v1", conversationId, rows, needsYou: [...new Map(rows.flatMap(row => row.needsYou ? [[row.needsYou.id, row.needsYou] as const] : [])).values()] };
}
