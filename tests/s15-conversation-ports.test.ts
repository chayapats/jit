import { expect, test } from "bun:test";
import type { ToolDefinition } from "schway/host";
import { AppError } from "../src/errors";
import { createConversationVmTools, type ConversationWorkingVm } from "../src/s15/conversation/vm-port";
import type { ConversationPolicyWork } from "../src/s15/conversation/policy-port";

const ref = (id: string) => ({ id, revision: 1, generation: 1 });
const work: ConversationPolicyWork<object> = { actor: Object.freeze({}), authority: {
  id: "work", mode: "work", readLimit: 4, ownerGeneration: 1, policyRevision: 1, policyHash: "a".repeat(64), createdAt: 0, expiresAt: 10000,
  request: { requestId: "request", intent: "execute", purpose: ref("purpose"), bot: ref("bot"), recipients: [], selectionPin: null, expiresAt: 10000, resources: [ref("workspace")], selection: { route: ref("route"), model: ref("model"), effort: "high" } },
} };
const definition = (name: string, effect: "read-only" | "mutating" = "read-only"): ToolDefinition => ({ name, effect, description: name, execution: "exclusive", inputSchema: { type: "object" }, async execute() { return { content: "observed" }; } });

test("VM consumer denies dynamic read hints and shell writes under report-only scope", async () => {
  const opened: unknown[] = [];
  const vm: ConversationWorkingVm = { async openAttempt(actor, input) { opened.push({ actor, input }); return { definitions: [definition("read"), definition("bash", "read-only"), definition("write", "read-only"), definition("send_message", "read-only")], async cancel() {}, async close() {} }; } };
  const tools = createConversationVmTools(vm, { vmId: "vm", resourceId: "workspace" });
  const signal = new AbortController().signal;
  const inspection = await tools.open(work, { mode: "inspect", signal, guard() {} });
  expect(inspection.tools.map(tool => tool.definition.name)).toEqual(["read"]);
  const execution = await tools.open(work, { mode: "execute", signal, guard() {} });
  expect(execution.tools.map(tool => [tool.definition.name, tool.access])).toEqual([["read", "read"], ["bash", "reversible_write"], ["write", "reversible_write"]]);
  expect(opened).toHaveLength(2);
  expect(opened[0]).toMatchObject({ actor: work.actor, input: { vmId: "vm", workId: "work", attemptId: "chat_work", mode: "work" } });
  await expect(createConversationVmTools(vm, { vmId: "vm", resourceId: "unapproved" }).open(work, { mode: "execute", signal, guard() {} })).rejects.toThrow("outside_scope");
  expect(opened).toHaveLength(2);
});

test("revocation while VM opens fences tools and requests only the original session cleanup", async () => {
  const entered = Promise.withResolvers<void>(), finish = Promise.withResolvers<void>(); let revoked = false, cancels = 0, closes = 0;
  const vm: ConversationWorkingVm = { async openAttempt() { entered.resolve(); await finish.promise; return { definitions: [definition("bash")], async cancel() { cancels++; }, async close() { closes++; } }; } };
  const opening = createConversationVmTools(vm, { vmId: "vm", resourceId: "workspace" }).open(work, { mode: "execute", signal: new AbortController().signal, guard() { if (revoked) throw new AppError("authority_revoked"); } });
  await entered.promise; revoked = true; finish.resolve();
  await expect(opening).rejects.toThrow("authority_revoked"); expect(cancels).toBe(1); expect(closes).toBe(1);
});
