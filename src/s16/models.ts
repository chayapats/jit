import type { OwnerActor, S15PolicyService } from "../s15/policy";
import { canonical } from "../s15/conversation/validation";
import type { ApprovedModelRegistry, ModelService } from "../s15/model/types";
import type { ClientModelsView, ClientModelUsage } from "./client/contracts";

/** Protected read-only MODEL16 client seam. Callers supply only work IDs from an authenticated owner snapshot. */
export interface S16ModelsPort<Owner> {
  view(owner: Owner): ClientModelsView;
  usage(owner: Owner, requests: readonly { requestId: string; workId: string }[]): ClientModelUsage;
}

/** Reuse MODEL's exact recorded controls/reservations, without provider discovery, reconciliation or inference. */
export function createS16ModelsPort(models: ModelService, registry: ApprovedModelRegistry, policy: S15PolicyService): S16ModelsPort<OwnerActor> {
  return {
    view(owner) {
      const current = policy.owner.current(owner), { currency, ceilings, subscriptionLimits, unsettled, routes } = models.project(owner, undefined, false);
      return { contract: "s16-client-models/v1", routes: structuredClone(registry.list()).map(route => {
        const approved = !!current?.selections.some(selection => canonical(selection) === canonical(route.selection));
        return { selection: route.selection, provider: route.provider, modelId: route.modelId, account: route.account, billing: route.billing, recipient: route.recipient, charge: route.charge, availability: route.availability, approved,
          holdCode: !current ? "policy_required" : !approved ? "selection_pinned" : routes.find(row => canonical(row.selection) === canonical(route.selection))?.holdCode ?? null };
      }), budget: { currency, ceilings, subscriptionLimits, unsettled } };
    },
    usage(owner, requests) {
      const ids = new Map(requests.map(row => [row.workId, row.requestId]));
      const page = models.observations(owner, [...ids.keys()]);
      return { truncated: page.truncated, records: page.records.map(row => ({ id: row.id, requestId: ids.get(row.workId)!, provider: row.route.provider, model: row.route.modelId, selection: row.route.selection,
        state: row.state, code: row.code, createdAt: row.createdAt, tokens: row.tokens, usage: row.usage, providerRequests: row.providerRequests ?? null, effort: row.effort, reason: row.reason, controls: row.controls ?? null,
        physicalSends: row.physicalDispatches?.filter(send => !send.refusal).length ?? null, refusedSends: row.physicalDispatches?.filter(send => !!send.refusal).length ?? null, reservedCalls: row.reservations.length,
        partial: Object.values(row.usage).some(value => value === null) || row.tokenSamples.some(sample => !sample.usage || sample.usage.inputTokens === null || sample.usage.outputTokens === null) })) };
    },
  };
}
