import type { ExecutionBackend, ToolDefinition } from "schway/host";
import { AppError } from "../../errors";
import { identity } from "./validation";
import type { ConversationPolicyWork } from "./policy-port";
import type { ConversationToolPort } from "./types";

/** Structural counterpart of VM15 VmEvidence; captured guest facts never become protected management proof. */
export interface ConversationVmEvidence {
  id: string; vmId: string; sessionId: string; operationId: string; payloadHash: string;
  outcome: "not_dispatched" | "guest_reported" | "unknown";
  responseHash: string | null; outputBytes: number | null;
  transport: "pending" | "closed";
  execution: "unsettled" | "guest_scope_empty" | "vm_stopped";
  published: boolean;
}
/** Structural counterpart of VM15 VmSession. CHAT consumes only its guarded tool definitions and cleanup. */
export interface ConversationVmSession {
  readonly id: string;
  readonly backend: ExecutionBackend;
  readonly definitions: readonly ToolDefinition[];
  evidence(): readonly ConversationVmEvidence[];
  cancel(): Promise<void>;
  close(): Promise<void>;
}
/** VM15 WorkingVmPort counterpart pending #355; no endpoint, credential, manager or raw backend escapes to models. */
export interface ConversationWorkingVm {
  openAttempt(actor: object, input: { vmId: string; workId: string; attemptId: string; signal?: AbortSignal;
    mode?: "work" | "system"; access?: "inspect" | "execute" }): Promise<ConversationVmSession>;
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
    const session = await vm.openAttempt(work.actor, { vmId, workId: work.authority.id, attemptId: `chat_${work.authority.id}`, signal: input.signal, mode: "work", access: input.mode });
    try { input.guard(); }
    catch (error) { await session.cancel().catch(() => {}); await session.close().catch(() => {}); throw error; }
    const definitions = session.definitions.filter(definition => reads.has(definition.name) || input.mode === "execute" && writes.has(definition.name));
    return { tools: definitions.map(definition => ({ access: reads.has(definition.name) ? "read" : "reversible_write", definition: { ...definition, async execute(value, context) {
      input.guard(); const result = await definition.execute(value, context); input.guard(); return result;
    } } })), cancel: () => session.cancel(), close: () => session.close() };
  } };
}
