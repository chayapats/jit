import type { ConversationMemoryPort, ConversationRequest } from "../conversation/types";
import type { ConversationPolicyWork } from "../conversation/policy-port";
import type { TeamContext } from "../team";
import type { MemoryService } from "./service";

/**
 * Small additive CHAT adapter: capture actual owner ingress after policy admission; supply only
 * labelled memory data; guard every later model/tool/publication; exclude withdrawn ordinary history.
 * Every request gets fresh Schway native ownership, retired by CHAT's existing finally path.
 */
export function createConversationMemory(memory: MemoryService): ConversationMemoryPort<ConversationPolicyWork> {
  const contexts = new Map<string, TeamContext>();
  const context = (work: ConversationPolicyWork, requestId: string) => {
    let current = contexts.get(requestId);
    if (!current) { current = memory.options.team.bind(work.actor); contexts.set(requestId, current); }
    return current;
  };
  return {
    prepare(work, request: ConversationRequest) {
      const current = context(work, request.receipt.rootRequestId), authority = memory.options.team.guard(current);
      const scope = memory.options.retention(authority);
      const retained = scope ? memory.retain(current, { id: `message_${request.interpretationRequest.requestId}`, text: request.interpretationRequest.text, origin: { kind: "owner_message", id: request.interpretationRequest.requestId, conversationId: request.receipt.conversationId, at: request.receipt.receivedAt }, scope, resources: [], parents: [] }) : [];
      const packet = memory.prepare(current, request.receipt.rootRequestId, request.intent.instruction);
      return { section: packet.section, retained: retained.map(claim => ({ id: claim.id, kind: claim.kind, category: claim.category, source: claim.provenance.origin })) };
    },
    guard(work, requestId) { memory.guard(context(work, requestId), requestId); },
    observe(work, request, evidence) {
      const current = context(work, request.receipt.rootRequestId), authority = memory.options.team.guard(current), scope = memory.options.retention(authority);
      if (!scope || evidence.isError) return [];
      const packet = memory.derivative(current, request.receipt.rootRequestId);
      const retained = memory.retain(current, { id: `evidence_${evidence.id}`, text: evidence.content, origin: { kind: "work", id: evidence.id, conversationId: request.receipt.conversationId, at: evidence.at }, scope, resources: authority.request.resources, parents: packet.claimIds });
      memory.include(current, request.receipt.rootRequestId, retained.map(claim => claim.id));
      return retained.map(claim => ({ id: claim.id, kind: claim.kind, category: claim.category, source: claim.provenance.origin }));
    },
    complete(work, requestId, text) { memory.derive(context(work, requestId), requestId, { id: `reply_${requestId}`, kind: "summary", text, workId: work.authority.id }); },
    allowHistory(requestId, text) { return memory.allowHistory(requestId, text); },
    release(requestId) { contexts.delete(requestId); },
  };
}
