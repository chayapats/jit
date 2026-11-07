import type { VmEvidence, VmSession, WorkingVmPort } from "../vm";
import { AppError } from "../../errors";
import { identity } from "./validation";
import type { ConversationPolicyWork } from "./policy-port";
import type { ConversationToolPort, ConversationTools } from "./types";

/** Stable CHAT export alias for the real VM15 retained guest-evidence contract. */
export type ConversationVmEvidence = VmEvidence;
/** Stable CHAT export alias; backend/definitions/evidence/cleanup belong to the real VM module. */
export type ConversationVmSession = VmSession;
/** Real VM15 port. No endpoint, credential, manager or raw backend escapes to models. */
export type ConversationWorkingVm = WorkingVmPort;
const reads = new Set(["read", "ls", "find", "grep"]);
const writes = new Set(["write", "edit", "bash"]);

/**
 * Binds real VM15 work sessions to frozen conversational scope. Access classes come from the pinned
 * public core-tool registry, never model hints or unreviewed dynamic tools. Inspection exposes only
 * read/ls/find/grep; shell/edit/write require reversible-write authority. VM15 owns final dispatch,
 * retained response/evidence, cancellation and actual settlement; no host-local fallback exists.
 * With a working-computer pool (POOL15-01) `vmId` is the pool id: the composed placing port chooses the
 * member for new work and returns every later attempt of the same work to the member holding its workspace.
 * Neither the model nor the conversation can name a member, VM id or endpoint.
 */
export function createConversationVmTools<Worker extends object>(vm: ConversationWorkingVm, configuration: {
  /** Pool id (or, without a pool, the single VM id); fixed by trusted composition, never by a model. */
  vmId: string; resourceId: string;
}): ConversationToolPort<ConversationPolicyWork<Worker>> {
  identity(configuration.vmId); identity(configuration.resourceId);
  const { vmId, resourceId } = configuration;
  return { async open(work, input) {
    input.guard();
    if (!work.authority.request.resources.some(resource => resource.id === resourceId)) throw new AppError("outside_scope", 403);
    const session = await openConversationVmSession(vm, vmId, work, input);
    return { tools: conversationVmSessionTools(session, input), cancel: () => session.cancel(), close: () => session.close() };
  } };
}

/** Opens the conversation's VM attempt (`chat_<work>`) and closes it again if the work stopped meanwhile. */
export async function openConversationVmSession<Worker extends object>(vm: ConversationWorkingVm, vmId: string, work: ConversationPolicyWork<Worker>, input: { mode: "inspect" | "execute"; signal: AbortSignal; guard: () => void }): Promise<VmSession> {
  const session = await vm.openAttempt(work.actor, { vmId, workId: work.authority.id, attemptId: `chat_${work.authority.id}`, signal: input.signal, mode: "work", access: input.mode });
  try { input.guard(); }
  catch (error) { await session.cancel().catch(() => {}); await session.close().catch(() => {}); throw error; }
  return session;
}
/** Public core tools of an open VM session, filtered by access class and guarded at every call. */
export function conversationVmSessionTools(session: VmSession, input: { mode: "inspect" | "execute"; guard: () => void }): ConversationTools["tools"] {
  const definitions = session.definitions.filter(definition => reads.has(definition.name) || input.mode === "execute" && writes.has(definition.name));
  return definitions.map(definition => ({ access: reads.has(definition.name) ? "read" : "reversible_write", definition: { ...definition,
    // Public core schemas carry TypeBox symbols; only their JSON schema crosses the model boundary.
    inputSchema: JSON.parse(JSON.stringify(definition.inputSchema)), async execute(value, context) {
    input.guard(); const result = await definition.execute(value, context); input.guard(); return result;
  } } }));
}
