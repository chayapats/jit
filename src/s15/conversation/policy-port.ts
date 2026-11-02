import { AppError } from "../../errors";
import { canonical, digest } from "./validation";
import type { ConversationAuthority, ConversationPolicy } from "./types";

/** Narrow structural consumer types match POLICY15's protected exported API; no model/HTTP input implements them. */
export interface PolicyRef { id: string; revision: number; generation: number }
/** Exact approved route/model/effort selected by protected composition. */
export interface PolicySelection { route: PolicyRef; model: PolicyRef; effort: string }
/** One configured conservative physical model-call bound; no cost or allowance is invented by CHAT. */
export interface ModelCallBound { attempts: number; steps: number; calls: number; reads: number; outputBytes: number; activeMs: number; spendMinor: string }
/** Minimal durable authority data needed by CHAT. The private actor is separately issued by POLICY. */
export interface PolicyWorkAuthority { id: string; policyRevision: number; expiresAt: number; request: { purpose: PolicyRef; resources: PolicyRef[]; selection: PolicySelection } }
/** Consumer-only POLICY surface. Concrete S15PolicyService is structurally checked at composition/testing. */
export interface ConversationPolicyHost<Owner extends object, Worker extends object> {
  owner: {
    current(actor: Owner): { revision: number; ownerGeneration: number; purposes: PolicyRef[]; resources: PolicyRef[]; expiresAt: number; budget: { expiresAt: number } | null } | null;
    prepareInterpretation(actor: Owner, input: { requestId: string; selection: PolicySelection; expiresAt: number }): { authority: PolicyWorkAuthority; purposes: PolicyRef[] };
    admit(actor: Owner, input: { requestId: string; intent: "inspect" | "execute" | "accept_obligation"; access: "read" | "reversible_write" | "effect"; purpose: PolicyRef; bot: PolicyRef; resources: PolicyRef[]; recipients: PolicyRef[]; selection: PolicySelection; selectionPin: PolicySelection | null; expiresAt: number; subject: { resource: PolicyRef; issue: number } | null }): { work: PolicyWorkAuthority | null; receiptId: string };
  };
  work: {
    guard(actor: Worker): PolicyWorkAuthority;
    reserveModelCall(actor: Worker, input: { requestId: string; selection: PolicySelection; upperBound: ModelCallBound }): { id: string };
    guardReservation(actor: Worker, reservationId: string): unknown;
  };
  control: { bindWork(id: string): Worker; settleReservation(id: string, actual: { [K in keyof ModelCallBound]: ModelCallBound[K] | null }, settled: boolean): void };
}
/** Registered POLICY actor plus immutable data, held only by trusted CHAT/VM composition. */
export interface ConversationPolicyWork<Worker extends object> { actor: Worker; authority: PolicyWorkAuthority }

const known = new Set(["authentication_required", "authority_revoked", "stale_authority", "expired", "outside_scope", "finite_budget_required", "cost_unknown", "budget_exhausted", "capacity_busy", "selection_pinned", "recipient_approval_required", "lineage_withdrawn"]);
function mapped(error: unknown): AppError {
  const code = error && typeof error === "object" && "code" in error && typeof error.code === "string" && known.has(error.code) ? error.code : "policy_match_required";
  return new AppError(code, code === "authentication_required" ? 401 : 409);
}

/**
 * Adapts the real protected POLICY15 owner/work/control ports. Inference bootstrap has no work tools
 * or resources; its separate current catalog supplies allowed interpretation choices. Work and each
 * physical model reservation have stable domain-separated IDs. A stranded POLICY admission cannot
 * dispatch without CHAT's committed queue. All numeric/cost profiles are required host configuration.
 */
export function createConversationPolicy<Owner extends object, Worker extends object>(host: ConversationPolicyHost<Owner, Worker>, input: {
  ownerId: string; bot: PolicyRef; selection: PolicySelection;
  route: ConversationAuthority["route"]; limits: ConversationAuthority["limits"];
  modelCallUpperBound: ModelCallBound; now?: () => number;
}): ConversationPolicy<Owner, ConversationPolicyWork<Worker>> {
  const config = structuredClone({ ownerId: input.ownerId, bot: input.bot, selection: input.selection, route: input.route, limits: input.limits, modelCallUpperBound: input.modelCallUpperBound });
  const now = input.now ?? Date.now;
  const invoke = <T>(call: () => T): T => { try { return call(); } catch (error) { throw mapped(error); } };
  const current = (actor: Owner) => invoke(() => { const policy = host.owner.current(actor); if (!policy) throw new AppError("policy_match_required"); return policy; });
  const snapshot = (work: PolicyWorkAuthority, interpretation = false): ConversationAuthority => ({ id: work.id, purposeId: work.request.purpose.id, policyRevision: work.policyRevision, resources: work.request.resources.map(resource => resource.id), route: { ...config.route }, limits: { ...config.limits, ...(interpretation ? { modelCalls: 1, toolCalls: 0, activeMs: Math.min(config.limits.activeMs, 30000) } : {}) } });
  return {
    requireOwner(actor) { const policy = current(actor); return { id: config.ownerId, generation: policy.ownerGeneration }; },
    prepareInterpretation(actor, request) {
      try {
        const policy = current(actor), prepared = invoke(() => host.owner.prepareInterpretation(actor, { requestId: `ci_${digest(request.requestId)}`, selection: config.selection, expiresAt: Math.min(policy.expiresAt, policy.budget?.expiresAt ?? policy.expiresAt, now() + Math.min(config.limits.activeMs, 30000)) }));
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
        if (intent.subject && resources.length !== 1) return { state: "held", code: "material_ambiguity" };
        const admitted = invoke(() => host.owner.admit(actor, { requestId: `cw_${digest(request.requestId)}`, intent: intent.kind === "execute" ? "execute" : "inspect", access: scope.access, purpose, bot: config.bot, resources, recipients: [], selection: config.selection, selectionPin: config.selection, expiresAt: Math.min(policy.expiresAt, policy.budget?.expiresAt ?? policy.expiresAt, now() + config.limits.activeMs), subject: intent.subject ? { resource: resources[0]!, issue: Number(intent.subject.slice(6)) } : null }));
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
