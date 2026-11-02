import { AppError } from "../../errors";
import type { ActionRef, ActionSlip } from "../policy";
import type { ConversationApplication } from "./application";
import type { ConversationRequest } from "./types";
import { canonical, digest } from "./validation";

interface Presentation { action: ActionRef; sourceRequestId: string; expiresAt: number }
/** Exact original-owner decision grammar. Quotes, extra instructions and model output cannot match it. */
export function ownerDecision(text: string): { decision: "approve" | "deny"; actionId: string | null } | null {
  const value = text.trim().toLowerCase();
  if (/^(?:approve|approved|approve it|yes|yes approve|อนุมัติ|อนุมัติเลย|ตกลง)[.!\s]*$/u.test(value)) return { decision: "approve", actionId: null };
  if (/^(?:deny|reject|do not approve|ไม่อนุมัติ)[.!\s]*$/u.test(value)) return { decision: "deny", actionId: null };
  const selected = /^(approve|deny|อนุมัติ|ไม่อนุมัติ)\s+(?:action\s+)?([a-zA-Z0-9_-]{1,128})[.!\s]*$/iu.exec(text.trim());
  return selected ? { decision: selected[1]!.toLowerCase() === "approve" || selected[1] === "อนุมัติ" ? "approve" : "deny", actionId: selected[2]! } : null;
}

/** Retains only exact owner-presented refs, never payload/approval authority. Used at the synchronous owner read boundary. */
export function rememberActionPresentation<Owner, Work>(app: ConversationApplication<Owner, Work>, request: ConversationRequest, slips: readonly ActionSlip[]): void {
  app.store.transaction(() => {
    for (const slip of slips) {
      const presentation: Presentation = { action: { id: slip.action.id, revision: slip.action.revision, actionHash: slip.action.actionHash }, sourceRequestId: request.receipt.rootRequestId, expiresAt: slip.expiresAt };
      app.store.db.query("INSERT INTO presentations VALUES (?,?,?,?) ON CONFLICT(conversation_id,action_id) DO UPDATE SET owner_generation=excluded.owner_generation,record_json=excluded.record_json").run(request.receipt.conversationId, slip.action.id, request.owner.generation, canonical(presentation));
    }
  });
}

/**
 * Records an authenticated exact decision inside the ingress writer boundary. A bare affirmative uses
 * POLICY.decidePending with the complete conversation work set; several pending items ask which one.
 * Explicit IDs can select only a previously presented exact revision. Approval queues only that action,
 * never another model loop or a widened work grant. Duplicate commands use the original receipt.
 */
export function applyOwnerDecision<Owner, Work>(app: ConversationApplication<Owner, Work>, actor: Owner, request: ConversationRequest, decision: NonNullable<ReturnType<typeof ownerDecision>>): void {
  const policy = app.options.policy;
  request.phase = "decision";
  if (!policy.decidePending || !policy.decideAction) throw new AppError("approval_reference_required", 409);
  const presentations = app.store.db.query<{ record_json: string }, [string, number]>("SELECT record_json FROM presentations WHERE conversation_id=? AND owner_generation=? ORDER BY rowid DESC LIMIT 65").all(request.receipt.conversationId, request.owner.generation).map(row => JSON.parse(row.record_json) as Presentation);
  const live = policy.actionSlips?.(actor, presentations.map(row => row.action)) ?? [];
  const pending = presentations.filter(row => live.some(slip => slip.action.id === row.action.id && slip.state === "pending" && slip.canApprove));
  if (!decision.actionId && pending.length !== 1) throw new AppError("approval_reference_required", 409);
  const seen = decision.actionId ? presentations.find(row => row.action.id === decision.actionId) : pending[0];
  if (!seen) throw new AppError("approval_reference_required", 409);
  const origins = app.store.db.query<{ id: string }, [string]>("SELECT id FROM requests WHERE conversation_id=? AND json_extract(record_json,'$.phase')='work' AND json_type(record_json,'$.authority')='object'").all(request.receipt.conversationId).map(row => app.store.request(row.id));
  const principal = policy.requireOwner(actor);
  if (origins.some(origin => origin.owner.id !== principal.id || origin.owner.generation !== principal.generation)) throw new AppError("authentication_required", 401);
  const workIds = [...new Set(origins.map(origin => origin.authority!.id))];
  const original = origins.find(origin => origin.receipt.rootRequestId === seen.sourceRequestId);
  if (!original || workIds.length > 64) throw new AppError("approval_reference_required", 409);
  const input = { requestId: `cd_${digest(request.receipt.requestId)}`, action: seen.action, decision: decision.decision, expiresAt: seen.expiresAt };
  if (decision.actionId) policy.decideAction(actor, input);
  else policy.decidePending(actor, { requestId: input.requestId, workIds, seen: seen.action, decision: input.decision, expiresAt: input.expiresAt });
  request.decision = { action: seen.action, decision: input.decision, expiresAt: input.expiresAt, observation: null };
  request.actions = [seen.action]; request.authority = original.authority;
  request.state = decision.decision === "approve" ? "queued" : "accepted";
  request.code = "approval_recorded";
}
