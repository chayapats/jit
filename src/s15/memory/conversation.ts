import type { ConversationMemoryPort, ConversationRequest } from "../conversation/types";
import type { ConversationPolicyWork } from "../conversation/policy-port";
import type { TeamContext } from "../team";
import type { MemoryService } from "./service";
import { filePins, type FileSourcePin } from "../file-lineage";
import { extractMemory } from "./extract";
import { digest } from "../conversation/validation";
import { memoryId } from "./identity";
import type { ConversationEvidence } from "../conversation/types";

/** Trusted selected-file observation and DATA15 release hooks; no model has access to these ports. */
export interface ConversationFileMemory {
  pins(work: ConversationPolicyWork, request: ConversationRequest): FileSourcePin[];
  observed(work: ConversationPolicyWork, request: ConversationRequest, evidence: ConversationEvidence, observations?: readonly ConversationEvidence[]): string | null;
  disclose(work: ConversationPolicyWork, pins: readonly FileSourcePin[]): void;
}

/**
 * Small additive CHAT adapter: capture actual owner ingress after policy admission; supply only
 * labelled memory data; guard every later model/tool/publication; exclude withdrawn ordinary history.
 * Every request gets fresh Schway native ownership, retired by CHAT's existing finally path.
 */
export function createConversationMemory(memory: MemoryService, files?: ConversationFileMemory): ConversationMemoryPort<ConversationPolicyWork> {
  const contexts = new Map<string, TeamContext>();
  const conversations = new Map<string, string>();
  const histories = new WeakMap<ConversationPolicyWork, TeamContext>();
  const historyContext = (work: ConversationPolicyWork) => { let value = histories.get(work); if (!value) { value = memory.options.team.bindHistory(work.actor); histories.set(work, value); } return value; };
  const context = (work: ConversationPolicyWork, requestId: string) => {
    let current = contexts.get(requestId);
    if (!current) { current = memory.options.team.bind(work.actor); contexts.set(requestId, current); }
    return current;
  };
  return {
    ...(files ? { fileContract: "s16-file-memory/v1" as const } : {}),
    prepare(work, request: ConversationRequest, ingress) {
      conversations.set(request.receipt.rootRequestId, request.receipt.conversationId);
      const current = context(work, request.receipt.rootRequestId), authority = memory.options.team.guard(current);
      const pins = request.fileInputs && files ? files.pins(work, request) : [];
      const scope = memory.options.retention(authority);
      const messages = [{ command: request.command, at: request.receipt.receivedAt }];
      if (request.interpretationRequest.requestId !== request.command.requestId) messages.push({ command: request.interpretationRequest, at: ingress?.receivedAt ?? request.receipt.receivedAt });
      const retained = scope ? messages.flatMap(({ command, at }) => memory.retain(current, { id: memoryId(`message_${command.requestId}`), text: command.text, origin: { kind: "owner_message", id: command.requestId, conversationId: request.receipt.conversationId, at }, scope, resources: pins.map(pin => pin.resource).filter((pin, index, all) => all.findIndex(other => other.id === pin.id) === index), parents: [], ...(pins.length ? { filePins: pins } : {}) })) : [];
      const packet = memory.prepare(current, request.receipt.rootRequestId, request.intent.instruction, pins);
      // Schway receives the complete owner instruction regardless of memory ranking. Its retained
      // claims must fence the reply even when they are absent from the bounded ranked source subset.
      memory.include(current, packet.id, retained.map(claim => claim.id));
      files?.disclose(work, memory.ancestry(current, packet.id));
      return { section: packet.section, retained: retained.map(claim => ({ id: claim.id, kind: claim.kind, category: claim.category, source: claim.provenance.origin })) };
    },
    guard(work, requestId) { const current = context(work, requestId); memory.guard(current, requestId); files?.disclose(work, memory.ancestry(current, requestId)); },
    observe(work, request, evidence, observations) {
      const current = context(work, request.receipt.rootRequestId), authority = memory.options.team.guard(current), scope = memory.options.retention(authority);
      if (!scope || evidence.isError) return [];
      const packet = memory.derivative(current, request.receipt.rootRequestId);
      const text = request.fileInputs ? files?.observed(work, request, evidence, observations) : evidence.content; if (!text) return [];
      const retained = memory.retain(current, { id: memoryId(`evidence_${evidence.id}`), text, origin: { kind: "work", id: memoryId(evidence.id), conversationId: request.receipt.conversationId, at: evidence.at }, scope, resources: authority.request.resources, parents: packet.claimIds, ...(packet.filePins?.length ? { filePins: packet.filePins } : {}) });
      memory.include(current, request.receipt.rootRequestId, retained.map(claim => claim.id));
      return retained.map(claim => ({ id: claim.id, kind: claim.kind, category: claim.category, source: claim.provenance.origin }));
    },
    complete(work, requestId, text) {
      const current = context(work, requestId), packet = memory.derivative(current, requestId), authority = memory.options.team.guard(current), scope = memory.options.retention(authority);
      const retained = files && scope && packet.filePins?.length && memory.retainGeneratedFiles(current, requestId) ? memory.retain(current, { id: `reply_claims_${digest(requestId)}`, text, origin: { kind: "work", id: requestId, conversationId: conversations.get(requestId) ?? null, at: memory.now() }, scope, resources: authority.request.resources, parents: packet.claimIds, filePins: packet.filePins }, extractMemory(text).map(candidate => ({ ...candidate, kind: "inference" as const }))) : [];
      if (retained.length) memory.include(current, requestId, retained.map(claim => claim.id));
      memory.derive(current, requestId, { id: memoryId(`reply_${requestId}`), kind: "summary", text, workId: work.authority.id });
      return retained.map(claim => ({ id: claim.id, kind: claim.kind, category: claim.category, source: claim.provenance.origin }));
    },
    artifacts(work, requestId, artifacts) { for (const artifact of artifacts) memory.derive(context(work, requestId), requestId, { id: `file_artifact_${digest(artifact.id)}`, kind: "artifact", text: null, workId: work.authority.id }); },
    allowHistory(requestId, text) { return memory.allowHistory(requestId, text); },
    ...(files ? {
      history(work: ConversationPolicyWork, requestId: string, text: string) { try { memory.history(historyContext(work), requestId, text); return true; } catch { return false; } },
      guardHistory(work: ConversationPolicyWork, fragments: readonly { id: string; text: string }[]) { return filePins(...fragments.map(fragment => memory.history(historyContext(work), fragment.id, fragment.text))); },
    } : {}),
    release(requestId) { contexts.delete(requestId); conversations.delete(requestId); },
  };
}
