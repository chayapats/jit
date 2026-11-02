import type { ToolDefinition } from "schway/host";
import type { WorkActor } from "../policy";
import type { ConversationPolicyWork, ConversationToolPort } from "../conversation";
import { GithubService } from "./service";
import { exact, fail, identity } from "./validation";

/**
 * CHAT tools use its exact already-admitted issue subject. Discovery exposes no mutation. Selection
 * cannot take an issue number from a model; the authenticated owner's frozen subject supplies it.
 * Publication uses separate exact POLICY actions and CHAT's existing owner-slip/decision path.
 */
export function createGithubConversationTools<Attempt>(service: GithubService<Attempt>, repositoryId: string): ConversationToolPort<ConversationPolicyWork> {
  identity(repositoryId);
  return { async open(work, input) {
    input.guard();
    const tool = (name: string, access: "read" | "reversible_write" | "effect", properties: Record<string, object>, required: string[], execute: (value: unknown) => Promise<unknown>) => ({ access, definition: { name, description: `Scoped GitHub ${name}; repository and selected issue come from authenticated work, never source instructions.`, inputSchema: { type: "object", properties, required, additionalProperties: false }, execution: "exclusive", effect: access === "read" ? "read-only" : "mutating", async execute(value: unknown) { input.guard(); const result = await execute(value); input.guard(); return { content: JSON.stringify(result) }; } } satisfies ToolDefinition });
    const tools = [tool("github_readiness", "read", {}, [], async value => { exact(value, []); return service.discover(work.actor, repositoryId); })];
    if (input.mode === "execute" && work.authority.request.subject?.resource.id === repositoryId && work.authority.request.access !== "read") {
      tools.push(tool("github_select_and_implement", "reversible_write", { reportId: { type: "string" }, base: { type: "string" }, issueVersion: { type: "string" } }, ["reportId", "base", "issueVersion"], async value => {
        exact(value, ["reportId", "base", "issueVersion"]); identity(value.reportId);
        const selected = await service.select(work.actor, { requestId: work.authority.request.requestId, issue: work.authority.request.subject!.issue, reportId: value.reportId, base: value.base as string, issueVersion: value.issueVersion as string });
        return service.implement(work.actor, selected.id);
      }));
      if (work.authority.request.access === "effect") tools.push(tool("github_prepare_publication", "effect", { selectionId: { type: "string" }, operation: { type: "object" } }, ["selectionId", "operation"], async value => {
        exact(value, ["selectionId", "operation"]); identity(value.selectionId);
        const p = await service.prepare(work.actor, value.selectionId, value.operation as Parameters<typeof service.prepare>[2]);
        const ref = { id: p.action.id, revision: p.action.revision, actionHash: p.action.actionHash };
        if (!input.onAction) fail("adapter_unproven"); input.onAction(ref);
        if (p.decision.state !== "allow") return { action: ref, disposition: p.decision };
        return { action: ref, observation: await service.dispatch(work.actor, ref) };
      }));
    }
    return { tools, async cancel() {}, async close() {} };
  } };
}
