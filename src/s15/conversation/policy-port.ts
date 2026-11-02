import { AppError } from "../../errors";
import { PolicyError, type BudgetVector, type OwnerActor, type Ref, type Selection, type S15PolicyService, type WorkActor, type WorkAuthority } from "../policy";
import { canonical, digest, integer } from "./validation";
import type { ConversationAuthority, ConversationPolicy } from "./types";

/** One configured conservative physical model-call bound; no cost or allowance is invented by CHAT. */
export type ModelCallBound = BudgetVector;
/** Registered POLICY actor plus immutable data, held only by trusted CHAT/VM composition. */
export interface ConversationPolicyWork<Worker extends object = WorkActor> { actor: Worker; authority: WorkAuthority }

const known = new Set(["authentication_required", "authority_revoked", "stale_authority", "expired", "outside_scope", "finite_budget_required", "cost_unknown", "budget_exhausted", "capacity_busy", "selection_pinned", "recipient_approval_required", "lineage_withdrawn", "payload_withdrawn", "approval_reference_required", "stale_action", "already_claimed", "approval_required", "action_denied", "reconciliation_required", "read_bound_exhausted", "read_operation_unavailable", "recipient_unapproved", "classification_unknown", "recipient_unknown", "disclosure_changed", "disclosure_nonreleasable", "opaque_egress_unavailable"]);
function mapped(error: unknown): AppError {
  const code = (error instanceof PolicyError || error instanceof AppError) && known.has(error.code) ? error.code : "policy_match_required";
  return new AppError(code, code === "authentication_required" ? 401 : 409);
}

/**
 * Adapts the real protected POLICY15 owner/work/control ports. Inference bootstrap has no work tools
 * or resources; its separate current catalog supplies allowed interpretation choices. Work and each
 * physical model reservation have stable domain-separated IDs. A stranded POLICY admission cannot
 * dispatch without CHAT's committed queue. All numeric/cost profiles are required host configuration.
 */
export function createConversationPolicy(host: S15PolicyService, input: {
  ownerId: string;
  /** The same protected current-generation source used by PolicyOptions, independent of an old installed policy. */
  ownerGeneration: () => number;
  bot: Ref; selection: Selection;
  route: ConversationAuthority["route"]; limits: ConversationAuthority["limits"];
  modelCallUpperBound: ModelCallBound;
  /** Protected repository catalog distinguishes the selected issue resource from an accompanying VM. */
  subjectResourceIds?: readonly string[];
}): ConversationPolicy<OwnerActor, ConversationPolicyWork> {
  const config = structuredClone({ ownerId: input.ownerId, bot: input.bot, selection: input.selection, route: input.route, limits: input.limits, modelCallUpperBound: input.modelCallUpperBound });
  const invoke = <T>(call: () => T): T => { try { return call(); } catch (error) { throw mapped(error); } };
  const current = (actor: OwnerActor) => invoke(() => { const policy = host.owner.current(actor); if (!policy) throw new AppError("policy_match_required"); return policy; });
  const snapshot = (work: WorkAuthority, interpretation = false): ConversationAuthority => ({ id: work.id, purposeId: work.request.purpose.id, policyRevision: work.policyRevision, resources: work.request.resources.map(resource => resource.id), route: { ...config.route }, limits: { ...config.limits, ...(interpretation ? { modelCalls: 1, toolCalls: 0, activeMs: Math.min(config.limits.activeMs, 30000) } : {}) } });
  return {
    requireOwner(actor) { current(actor); const generation = input.ownerGeneration(); integer(generation, 1); return { id: config.ownerId, generation }; },
    prepareInterpretation(actor, request) {
      try {
        // The standing expiry is stable across an interrupted local ingress commit; local phase deadlines stay finite.
        const policy = current(actor), prepared = invoke(() => host.owner.prepareInterpretation(actor, { requestId: `ci_${digest(request.requestId)}`, selection: config.selection, expiresAt: Math.min(policy.expiresAt, policy.budget?.expiresAt ?? policy.expiresAt) }));
        return { state: "admitted", authority: snapshot(prepared.authority, true), purposes: prepared.purposes.map(purpose => purpose.id), resources: policy.resources.map(resource => resource.id) };
      } catch (error) { return { state: "held", code: mapped(error).code }; }
    },
    admit(actor, request, intent) {
      try {
        const policy = current(actor), scope = intent.scope;
        if (!scope) throw new AppError("outside_scope");
        const purpose = policy.purposes.find(purpose => purpose.id === scope.purposeId);
        const resources = scope.resourceIds.map(id => { const resource = policy.resources.find(resource => resource.id === id); if (!resource) throw new AppError("outside_scope"); return resource; });
        if (!purpose) return { state: "proposed", code: "outside_scope" };
        const subjects = input.subjectResourceIds ? resources.filter(r => input.subjectResourceIds!.includes(r.id)) : resources;
        if (intent.subject && subjects.length !== 1) return { state: "held", code: "material_ambiguity" };
        const admitted = invoke(() => host.owner.admit(actor, { requestId: `cw_${digest(request.requestId)}`, intent: intent.kind === "execute" ? "execute" : "inspect", access: scope.access, purpose, bot: config.bot, resources, recipients: policy.recipients, selection: config.selection, selectionPin: config.selection, expiresAt: Math.min(policy.expiresAt, policy.budget?.expiresAt ?? policy.expiresAt), readLimit: Math.min(config.limits.toolCalls, policy.budget?.ceiling.reads ?? 0), subject: intent.subject ? { resource: subjects[0]!, issue: Number(intent.subject.slice(6)) } : null }));
        if (!admitted.work) throw new AppError("outside_scope");
        return { state: "admitted", authority: snapshot(admitted.work) };
      } catch (error) { const code = mapped(error).code; return { state: code === "outside_scope" ? "proposed" : "held", code }; }
    },
    open(reference) {
      return invoke(() => {
        const actor = host.control.bindWork(reference.id), work = host.work.guard(actor);
        if (work.policyRevision !== reference.policyRevision || canonical(work.request.selection) !== canonical(config.selection) || work.request.purpose.id !== reference.purposeId || canonical(work.request.resources.map(resource => resource.id)) !== canonical(reference.resources)) throw new AppError("stale_authority");
        return { actor, authority: work };
      });
    },
    guard(work) { invoke(() => host.work.guard(work.actor)); },
    actionSlips(actor, actions) { return invoke(() => actions.map(action => host.owner.actionSlip(actor, action))); },
    decidePending(actor, input) { invoke(() => host.owner.decidePending(actor, input)); },
    decideAction(actor, input) { invoke(() => host.owner.decide(actor, input)); },
    dispatchAction(reference, action) { return host.work.dispatch(invoke(() => host.control.bindWork(reference.id)), action).catch(error => { throw mapped(error); }); },
    stopWork(actor, reference, requestId) { invoke(() => host.owner.revoke(actor, `cs_${digest(requestId)}`, { kind: "work", id: reference.id })); },
    reserveModel(work, slot) {
      const reservation = invoke(() => host.work.reserveModelCall(work.actor, { requestId: `cm_${digest(slot)}`, selection: config.selection, upperBound: config.modelCallUpperBound }));
      invoke(() => host.work.guardReservation(work.actor, reservation.id));
      let settled = false;
      return { settle() {
        if (settled) return; settled = true;
        // Iterator completion proves transport return, not known token/spend usage or an effect outcome.
        invoke(() => host.control.settleReservation(reservation.id, { attempts: null, steps: null, calls: null, reads: null, outputBytes: null, activeMs: null, spendMinor: null }, true));
      } };
    },
  };
}
