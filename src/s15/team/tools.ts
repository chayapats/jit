import { AppError } from "../../errors";
import type { ConversationToolPort } from "../conversation/types";
import type { TeamActor } from "./types";
import type { TeamService } from "./service";
import { content, ids, integer } from "./validation";

/** Registered host mapping, never a model-selected path/key or native read-only hint. */
export interface TeamToolBinding {
  name: string; resources: string[]; mode: "read" | "write" | "input";
  /** Returning tool text/closing a session alone does not prove external settlement. */
  settled: () => boolean;
}
/**
 * Wraps existing mediated CHAT VM/broker tools with team scope and cooperative conflict leases.
 * It grants no tools/effects; the underlying protected adapter retains POLICY, budgets, browser
 * generations, actual I/O/CAS and settlement ownership. Independent contexts share only approved data.
 */
export function createTeamResourceTools<Work>(team: TeamService, underlying: ConversationToolPort<Work>, options: {
  actor(work: Work): TeamActor; bindings: readonly TeamToolBinding[]; leaseMs: number;
}): ConversationToolPort<Work> {
  integer(options.leaseMs, 1, 3600000);
  const bindings = options.bindings.map(binding => { ids(binding.resources, 32); if (!binding.resources.length) throw new AppError("invalid_resource"); return { ...binding, resources: [...binding.resources] }; });
  if (new Set(bindings.map(binding => binding.name)).size !== bindings.length) throw new AppError("invalid_resource");
  return { async open(work, input) {
    const context = team.bind(options.actor(work)); input.guard();
    let stopped = false;
    const scopedGuard = () => {
      if (input.signal.aborted || stopped) throw new AppError("aborted");
      input.guard(); team.guard(context);
      for (const resourceId of new Set(bindings.flatMap(binding => binding.resources))) team.resource(context, resourceId);
    };
    scopedGuard();
    const session = await underlying.open(work, { ...input, guard: scopedGuard });
    try {
      if (input.signal.aborted || stopped) throw new AppError("aborted");
      scopedGuard();
      return { cancel: () => { stopped = true; return session.cancel(); }, close: () => { stopped = true; return session.close(); }, tools: session.tools.map(tool => {
        const binding = bindings.find(binding => binding.name === tool.definition.name);
        if (!binding || (tool.access === "read") !== (binding.mode === "read")) throw new AppError("tool_unavailable", 409);
        return { ...tool, definition: { ...tool.definition, execute: async (value, call) => {
          scopedGuard(); binding.resources.forEach(id => team.resource(context, id, binding.mode === "read" ? "read" : binding.mode));
          const run = async () => {
            const result = await tool.definition.execute(value, call);
            content(result.content, 32768);
            scopedGuard(); binding.resources.forEach(id => team.resource(context, id, binding.mode === "read" ? "read" : binding.mode));
            return result;
          };
          if (binding.mode === "read") return run();
          const lease = team.acquire(context, binding.resources, binding.mode, options.leaseMs);
          return team.dispatch(lease, async () => {
            const result = await tool.definition.execute(value, call);
            // Record real settlement even when later publication is denied or credential bytes refuse.
            return { value: result, settled: binding.settled() };
          }).then(result => { content(result.content, 32768); scopedGuard(); return result; });
        } } };
      }) };
    } catch (error) { try { await session.cancel(); } finally { await session.close(); } throw error; }
  } };
}
