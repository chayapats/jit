import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, ToolDefinition } from "schway/host";
import { runConversation } from "../src/s15/conversation/schway";
import { transientBrowserInputs } from "../src/s15/conversation/browser-inputs";
import type { ConversationRequest } from "../src/s15/conversation/types";

const payload = "TRANSIENT_BROWSER_INPUT_82fe2061";
test("native Schway history, next-turn context and evidence contain no type/select payload; actual tool receives it once", async () => {
  const root = mkdtempSync(join(tmpdir(),"jit-browser-history-"));
  const seen: unknown[] = [], requests: unknown[] = [];
  let turn = 0;
  const definition: ToolDefinition = { name: "computer_browser", description: "fixture", inputSchema: { type: "object", properties: { kind: { type: "string" }, value: { type: "string" } }, additionalProperties: false }, execution: "exclusive", effect: "mutating", async execute(input) { seen.push(input); return { content: '{"state":"ok"}' }; } };
  const model: Model = { provider: "codex", id: "scripted", async *stream(request) {
    requests.push(JSON.parse(JSON.stringify(request))); turn++;
    yield { type: "message_complete", message: { type: "assistant", id: `m${turn}`, content: turn < 3 ? [{ type: "tool_call", id: `t${turn}`, name: "computer_browser", arguments: { kind: turn === 1 ? "type" : "select", value: payload }, providerMetadata: { rawArguments: payload } }] : [{ type: "text", text: "Done" }] } };
  } };
  // runConversation reads only this retained authority/command/receipt/intent projection.
  const request = { receipt: { contract: "s15-conversation-receipt/v1", requestId: "root", rootRequestId: "root", conversationId: "conversation", receivedAt: 1000 }, command: { contract: "s15-conversation/v1", requestId: "root", conversationId: "conversation", text: "Update the form", continuation: null }, intent: { kind: "execute", subject: null, instruction: "Update the form" }, authority: { id: "authority", policyRevision: 1, purposeId: "work", resources: ["vm"], route: { provider: "codex", model: "scripted" }, limits: { modelCalls: 4, toolCalls: 4, outputBytes: 4096, activeMs: 10000 } } } as unknown as ConversationRequest;
  try {
    expect((await runConversation({ directory: root, request, definitions: [definition], signal: new AbortController().signal, clock: { now: () => 1000, sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => { if (signal?.aborted) reject(new DOMException("Aborted","AbortError")); else signal?.addEventListener("abort", () => reject(new DOMException("Aborted","AbortError")), { once: true }); }) }, scripted: model, guard() {}, reserveModel: () => ({ settle() {} }), correlated() {} })).text).toBe("Done");
    expect(seen).toEqual([{ kind: "type", value: payload }, { kind: "select", value: payload }]);
    expect(JSON.stringify(requests)).not.toContain(payload);
    function files(path: string): string[] { return readdirSync(path,{ withFileTypes: true }).flatMap(e => e.isDirectory() ? files(join(path,e.name)) : [join(path,e.name)]); }
    const artifacts = files(root).map(p => readFileSync(p).toString()).join("\n");
    expect(artifacts).toContain("browser_input_"); expect(artifacts).not.toContain(payload);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
test("transient tokens cannot be fabricated, repeated or retained across runs", async () => {
  const seen: unknown[] = [];
  const def: ToolDefinition = { name: "computer_browser", description: "fixture", inputSchema: { type: "object" }, execution: "exclusive", effect: "mutating", async execute(input) { seen.push(input); return { content: "ok" }; } };
  const vault = transientBrowserInputs([def]);
  const transformed = vault.event({ type: "message_complete", message: { type: "assistant", id: "m", content: [{ type: "tool_call", id: "c", name: "computer_browser", arguments: { kind: "type", value: payload } }] } });
  if (transformed.type !== "message_complete") throw new Error("event");
  const part = transformed.message.content[0]!; if (part.type !== "tool_call") throw new Error("part");
  const tool = vault.definitions[0]!, context = { signal: new AbortController().signal, workspace: { root: "/", launchCwd: "/", extraRoots: [] } };
  expect((await tool.execute({ kind: "type", value: "forged" }, context)).isError).toBe(true);
  expect((await tool.execute(part.arguments, context)).isError).toBeUndefined();
  expect((await tool.execute(part.arguments, context)).isError).toBe(true);
  vault.clear(); expect(seen).toEqual([{ kind: "type", value: payload }]);
});
