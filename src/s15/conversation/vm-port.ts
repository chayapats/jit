import type { ToolDefinition } from "schway/host";
import { AppError } from "../../errors";
import { identity } from "./validation";
import type { ConversationPolicyWork } from "./policy-port";
import type { ConversationToolPort } from "./types";

/** Minimal VM15 conversation-facing surface; no endpoint, credential, manager or raw backend escapes it. */
export interface ConversationWorkingVm {
  openAttempt(actor: object, input: { vmId: string; workId: string; attemptId: string; signal?: AbortSignal; mode?: "work" | "system" }): Promise<{
    definitions: readonly ToolDefinition[];
    cancel(): Promise<void>;
    close(): Promise<void>;
  }>;
}
const reads = new Set(["read", "ls", "find", "grep"]);
const writes = new Set(["write", "edit", "bash"]);

/**
 * Binds real VM15 work sessions to frozen conversational scope. Access classes come from the pinned
 * public core-tool registry, never model hints or unreviewed dynamic tools. Inspection exposes only
 * read/ls/find/grep; shell/edit/write require reversible-write authority. VM15 owns final dispatch,
 * retained response/evidence, cancellation and actual settlement; no host-local fallback exists.
 */
export function createConversationVmTools<Worker extends object>(vm: ConversationWorkingVm, configuration: {
  vmId: string; resourceId: string;
}): ConversationToolPort<ConversationPolicyWork<Worker>> {
  identity(configuration.vmId); identity(configuration.resourceId);
  const { vmId, resourceId } = configuration;
  return { async open(work, input) {
    input.guard();
    if (!work.authority.request.resources.some(resource => resource.id === resourceId)) throw new AppError("outside_scope", 403);
    const session = await vm.openAttempt(work.actor, { vmId, workId: work.authority.id, attemptId: `chat_${work.authority.id}`, signal: input.signal, mode: "work" });
    try { input.guard(); }
    catch (error) { await session.cancel().catch(() => {}); await session.close().catch(() => {}); throw error; }
    const definitions = session.definitions.filter(definition => reads.has(definition.name) || input.mode === "execute" && writes.has(definition.name));
    return { tools: definitions.map(definition => ({ access: reads.has(definition.name) ? "read" : "reversible_write", definition: { ...definition, async execute(value, context) {
      input.guard(); const result = await definition.execute(value, context); input.guard(); return result;
    } } })), cancel: () => session.cancel(), close: () => session.close() };
  } };
}
