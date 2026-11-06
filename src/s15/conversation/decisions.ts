import { AppError } from "../../errors";
import type { ActionRef, ActionSlip } from "../policy";
import type { ConversationApplication } from "./application";
import type { ConversationRequest } from "./types";
import { canonical, digest } from "./validation";

interface Presentation { action: ActionRef; sourceRequestId: string; expiresAt: number }
/** One exact owner decision. S16-D08: it comes only from the one-press decision command, never from typed text. */
export interface OwnerDecisionInput { decision: "approve" | "deny"; actionId: string | null }

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
 * POLICY.decidePending with the currently pending conversation work set; several pending items ask which one.
 * Explicit IDs can select only a previously presented exact revision. Approval queues only that action,
 * never another model loop or a widened work grant. Duplicate commands use the original receipt.
 */
export function applyOwnerDecision<Owner, Work>(app: ConversationApplication<Owner, Work>, actor: Owner, request: ConversationRequest, decision: OwnerDecisionInput): void {
  const policy = app.options.policy;
  request.phase = "decision";
  if (!policy.decidePending || !policy.decideAction) throw new AppError("approval_reference_required", 409);
  const principal = policy.requireOwner(actor);
  const sameAction = (a: ActionRef, b: ActionRef) => a.id === b.id && a.revision === b.revision && a.actionHash === b.actionHash;
  const presentation = (actionId: string): Presentation | null => {
    const row = app.store.db.query<{ record_json: string }, [string, string, number]>("SELECT record_json FROM presentations WHERE conversation_id=? AND action_id=? AND owner_generation=?").get(request.receipt.conversationId, actionId, principal.generation);
    return row ? JSON.parse(row.record_json) as Presentation : null;
  };
  const origin = (seen: Presentation): ConversationRequest => {
    const source = app.store.request(seen.sourceRequestId);
    if (source.receipt.conversationId !== request.receipt.conversationId || source.owner.id !== principal.id || source.owner.generation !== principal.generation) throw new AppError("authentication_required", 401);
    if (source.phase !== "work" || !source.authority || !source.actions.some(action => sameAction(action, seen.action))) throw new AppError("approval_reference_required", 409);
    return source;
  };
  let seen: Presentation | null, original: ConversationRequest;
  const workIds: string[] = [];
  if (decision.actionId) {
    // Resolve the exact source before reading any payload. Unrelated history cannot block this item.
    seen = presentation(decision.actionId);
    if (!seen) throw new AppError("approval_reference_required", 409);
    original = origin(seen);
    if (!policy.actionSlips?.(actor, [seen.action]).some(slip => sameAction(slip.action, seen!.action))) throw new AppError("approval_reference_required", 409);
  } else {
    const pending = new Map<string, { action: ActionRef; source: ConversationRequest }>();
    const origins = app.store.db.query<{ id: string }, [string]>("SELECT id FROM requests WHERE conversation_id=? AND json_extract(record_json,'$.phase')='work' AND json_type(record_json,'$.authority')='object' AND json_array_length(record_json,'$.actions')>0").all(request.receipt.conversationId);
    for (const row of origins) {
      const source = app.store.request(row.id);
      if (source.owner.id !== principal.id || source.owner.generation !== principal.generation) continue;
      for (const action of source.actions) {
        let slips: ActionSlip[];
        try { slips = policy.actionSlips?.(actor, [action]) ?? []; }
        catch (error) {
          // Only expected withdrawal isolates a historical payload; continuity/operational errors fail closed.
          if (error instanceof AppError && ["lineage_withdrawn", "payload_withdrawn"].includes(error.code)) continue;
          throw error;
        }
        for (const slip of slips) if (slip.state === "pending" && slip.canApprove) pending.set(slip.action.id, { action: { id: slip.action.id, revision: slip.action.revision, actionHash: slip.action.actionHash }, source });
        if (pending.size > 1) throw new AppError("approval_reference_required", 409);
      }
    }
    const only = [...pending.values()][0];
    if (!only) throw new AppError("approval_reference_required", 409);
    seen = presentation(only.action.id);
    if (!seen) throw new AppError("approval_reference_required", 409);
    original = origin(seen);
    if (!sameAction(only.action, seen.action)) throw new AppError("stale_action", 409);
    workIds.push(original.authority!.id);
  }
  const input = { requestId: `cd_${digest(request.receipt.requestId)}`, action: seen.action, decision: decision.decision, expiresAt: seen.expiresAt };
  if (decision.actionId) policy.decideAction(actor, input);
  else policy.decidePending(actor, { requestId: input.requestId, workIds, seen: seen.action, decision: input.decision, expiresAt: input.expiresAt });
  request.decision = { action: seen.action, decision: input.decision, expiresAt: input.expiresAt, observation: null };
  request.actions = [seen.action]; request.authority = original.authority;
  request.state = decision.decision === "approve" ? "queued" : "accepted";
  request.code = "approval_recorded";
}
