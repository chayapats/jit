import type { ToolDefinition, ToolExecutionResult } from "schway/host";
import { AppError } from "../../errors";
import { PolicyError, type BudgetVector, type Fence, type JsonValue, type ReadOperation, type Ref, type S15PolicyService } from "../policy";
import type { ConversationPolicyWork } from "./policy-port";
import type { ConversationToolPort } from "./types";
import { canonical, content, digest } from "./validation";

type Metadata = Pick<ToolDefinition, "name" | "description" | "inputSchema"> & { evidenceContent?: (content: string) => string };
/** Protected read implementation must call dispatch with the actual final payload after all waits.
 * Fulfillment certifies this read's transport ended. A rejection after dispatch leaves uncertainty.
 * No client/model effect hint registers this handler or substitutes for POLICY's ReadHandler. */
export interface ConversationPolicyRead extends Metadata {
  access: "read"; resource: Ref; operation: ReadOperation; upperBound: BudgetVector; fences: Fence[];
  payload(input: unknown): JsonValue;
  perform(payload: JsonValue, context: { signal: AbortSignal; dispatch<T>(finalPayload: JsonValue, start: () => Promise<T>): Promise<T> }): Promise<ToolExecutionResult>;
}
/** A pinned registered POLICY adapter derives exact semantics and owns actual effect dispatch. */
export interface ConversationPolicyAction extends Metadata {
  access: "reversible_write" | "effect"; adapter: string;
  proposal(input: unknown): unknown;
}
/**
 * One exact POLICY action from a conversation tool: prepare through the registered adapter, record the action
 * on the request, dispatch only an `allow` decision, then require a publishable success. A held action stays
 * for the owner's in-chat card; nothing here approves or retries it.
 */
export async function runConversationAction(host: S15PolicyService, work: ConversationPolicyWork, input: { guard: () => void; onAction?: (action: { id: string; revision: number; actionHash: string }) => void }, slot: string, adapter: string, proposal: unknown): Promise<{ action: { id: string; revision: number; actionHash: string }; status: "succeeded" }> {
  const prepared = host.work.prepare(work.actor, { slot, adapter, proposal });
  const ref = { id: prepared.action.id, revision: prepared.action.revision, actionHash: prepared.action.actionHash };
  if (!input.onAction) throw new AppError("adapter_unproven");
  input.onAction(ref);
  if (prepared.decision.state !== "allow") throw new AppError(prepared.decision.code);
  input.guard(); const observation = await host.work.dispatch(work.actor, ref);
  if (observation.outcome !== "succeeded") throw new AppError(observation.code ?? "reconciliation_required");
  input.guard(); host.control.publishable(work.actor, ref);
  return { action: ref, status: "succeeded" };
}
const unknownUsage = () => ({ attempts: null, steps: null, calls: null, reads: null, outputBytes: null, activeMs: null, spendMinor: null });
const code = (error: unknown) => error instanceof PolicyError || error instanceof AppError ? error.code : "conversation_unavailable";

/**
 * Real POLICY read/action tools. Reads reserve/claim before I/O and publish only the settled bound
 * response. Writes prepare exact immutable actions; held actions are retained for owner slips without
 * dispatch. The model never receives owner/control ports, adapter selection or a reusable permit.
 */
export function createConversationPolicyTools(host: S15PolicyService, registrations: readonly (ConversationPolicyRead | ConversationPolicyAction)[]): ConversationToolPort<ConversationPolicyWork> {
  const registry = registrations.map(entry => ({ ...entry, inputSchema: structuredClone(entry.inputSchema), ...(entry.access === "read" ? { resource: structuredClone(entry.resource), upperBound: structuredClone(entry.upperBound), fences: structuredClone(entry.fences) } : {}) }));
  return { async open(work, input) {
    input.guard(); let sequence = 0;
    return { tools: registry.filter(entry => input.mode === "execute" || entry.access === "read").map(entry => ({ access: entry.access, ...(entry.evidenceContent ? { evidenceContent: entry.evidenceContent } : {}),
      definition: { name: entry.name, description: entry.description, inputSchema: entry.inputSchema, execution: "exclusive", effect: entry.access === "read" ? "read-only" : "mutating",
        async execute(value) {
          input.guard(); const slot = `ct_${digest(`${work.authority.id}:${++sequence}`)}`;
          if (entry.access !== "read") return { content: JSON.stringify(await runConversationAction(host, work, input, slot, entry.adapter, entry.proposal(value))) };
          const payload = JSON.parse(canonical(entry.payload(value))) as JsonValue, pinned = canonical(payload);
          const admitted = host.work.reserveRead(work.actor, { requestId: slot, resource: entry.resource, operation: entry.operation, exactPayload: payload, upperBound: entry.upperBound, fences: entry.fences });
          if (admitted.state !== "allow") throw new AppError(admitted.code);
          let dispatched = false, returned = false, recorded = false, observedBytes: number | null = null;
          try {
            const result = await entry.perform(payload, { signal: input.signal, dispatch: (finalPayload, start) => {
              input.guard();
              if (dispatched) throw new AppError("already_claimed");
              if (canonical(finalPayload) !== pinned) throw new AppError("hash_mismatch");
              host.work.guardRead(work.actor, admitted.claim.id); dispatched = true;
              return start();
            } });
            returned = true;
            if (!dispatched) throw new AppError("read_operation_unavailable");
            if (typeof result.content === "string") observedBytes = Buffer.byteLength(result.content);
            if (observedBytes !== null && observedBytes > Math.min(32768, entry.upperBound.outputBytes)) throw new AppError("output_limit");
            content(result.content, Math.min(32768, entry.upperBound.outputBytes));
            const resultHash = digest(result.content);
            host.control.settleRead(admitted.claim.id, { outcome: result.isError ? "failed" : "succeeded", basis: "remote_verified", code: null, actual: { ...unknownUsage(), reads: 1, outputBytes: Buffer.byteLength(result.content) }, transportSettled: true }, result.isError ? null : resultHash); recorded = true;
            input.guard(); const published = host.control.publishRead(work.actor, admitted.claim.id);
            if (!result.isError && published.resultHash !== resultHash) throw new AppError("hash_mismatch");
            return { content: result.content, isError: result.isError === true };
          } catch (error) {
            if (!recorded) host.control.settleRead(admitted.claim.id, { outcome: dispatched ? "unknown" : "not_dispatched", basis: dispatched ? "uncertain" : "local_guard", code: "read_unavailable", actual: { ...unknownUsage(), outputBytes: observedBytes }, transportSettled: returned || !dispatched }, null);
            throw new AppError(code(error));
          }
        } } })),
      async cancel() { /* Registered read transports receive the original abort signal; action outcomes remain in POLICY. */ },
      async close() {},
    };
  } };
}
