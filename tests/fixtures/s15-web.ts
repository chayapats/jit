import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model, ToolDefinition } from "schway/host";
import { AppError } from "../../src/errors";
import { ConversationApplication } from "../../src/s15/conversation/application";
import { groundConversationIntent } from "../../src/s15/conversation/intent";
import { ConversationStore } from "../../src/s15/conversation/store";
import type { ConversationAuthority, ConversationPolicy, ConversationToolPort } from "../../src/s15/conversation/types";
import { createS15WebHandler, s15ConversationPort, type S15WebPorts } from "../../src/s15/web";

/** Deterministic S15 Web fixture: real CHAT15 application, scripted model, fixture policy and VM-named tools. No network. */
export type WebActor = { ownerId: string };
type Work = { authority: ConversationAuthority };
export const origin = "http://jit.test";
const id = () => crypto.randomUUID().replaceAll("-", "");

export function webFixture(extra: (ports: S15WebPorts<WebActor>) => Partial<S15WebPorts<WebActor>> = () => ({})) {
  const root = mkdtempSync(join(tmpdir(), "jit-s15-web-"));
  const store = new ConversationStore(join(root, "conversation.sqlite"), "fixture", true);
  const actor: WebActor = Object.freeze({ ownerId: "owner" }), contexts = new WeakSet<Work>();
  let turn = 0, calls = 0, expired = false;
  const issued: ConversationAuthority = { id: "authority1", purposeId: "assigned", policyRevision: 4, resources: ["workspace"], route: { provider: "codex", model: "scripted" }, limits: { modelCalls: 4, toolCalls: 4, outputBytes: 16384, activeMs: 60000 } };
  const policy: ConversationPolicy<WebActor, Work> = {
    requireOwner(input) { if (input !== actor || expired) throw new AppError("authentication_required", 401); return { id: "owner", generation: 1 }; },
    prepareInterpretation(input) { this.requireOwner(input); return { state: "admitted", authority: { ...structuredClone(issued), resources: [], limits: { ...issued.limits, modelCalls: 1, toolCalls: 0 } }, purposes: ["assigned"], resources: ["workspace"] }; },
    admit(input) { this.requireOwner(input); return { state: "admitted", authority: structuredClone(issued) }; },
    open(authority) { const work = { authority }; contexts.add(work); return work; },
    guard(work) { if (!contexts.has(work)) throw new AppError("authority_revoked"); },
    reserveModel(work) { this.guard(work, "model"); return { settle() {} }; },
  };
  const tool = (name: string, access: "read" | "write"): ToolDefinition => ({ name, description: `Fixture ${name}`, inputSchema: { type: "object", properties: {}, additionalProperties: false }, execution: "exclusive", effect: access === "read" ? "read-only" : "mutating",
    async execute() { calls++; if (name === "write") { writeFileSync(join(root, "hello.txt"), "hello\n"); return { content: "wrote hello.txt (6 bytes)" }; } return { content: "issue #42 ready; issue #43 blocked by #41" }; } });
  const modes: string[] = [];
  const tools: ConversationToolPort<Work> = { async open(_work, input) { modes.push(input.mode); input.guard(); return { tools: [{ access: "read", definition: tool("grep", "read") }, { access: "reversible_write", definition: tool("write", "write") }], async cancel() {}, async close() {} }; } };
  const model: Model = { provider: "codex", id: "scripted", async *stream(request) {
    if (request.systemPrompt.includes("JIT_ISOLATED_INTERPRETATION_V1")) {
      const source = request.items.filter(item => item.type === "user").at(-1)!;
      const text = source.type === "user" ? source.content.filter(part => part.type === "text").map(part => part.text).join("\n") : "";
      const grounded = groundConversationIntent(text);
      yield { type: "message_complete", message: { type: "assistant", id: id(), content: [{ type: "text", text: JSON.stringify({ intent: grounded.kind, purposeId: "assigned", resourceIds: ["workspace"], access: grounded.kind === "execute" ? "reversible_write" : "read", subject: grounded.subject }) }] } }; return;
    }
    turn++;
    const parts = turn % 2 === 1 ? [{ type: "tool_call", id: `call_${turn}`, name: modes.at(-1) === "inspect" ? "grep" : "write", arguments: {} }] : [{ type: "text", text: "Finished; see the recorded tool evidence." }];
    yield { type: "message_complete", message: { type: "assistant", id: id(), content: parts as never } };
  } };
  let now = 1800000000000;
  const app = new ConversationApplication(store, { policy, tools, model, nativeDirectory: join(root, "native"), clock: { now: () => now, sleep: (_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => {
    if (signal?.aborted) reject(new DOMException("Aborted", "AbortError")); else signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
  }) } });
  const base: S15WebPorts<WebActor> = {
    authentication: { authenticate(token) { if (token !== "owner-token" || expired) throw new AppError("authentication_required", 401); return { actor, csrf: "csrf-fixture" }; }, verifyCsrf(expected, supplied) { if (expected !== supplied) throw new AppError("csrf_rejected", 403); } },
    conversation: s15ConversationPort(app),
  };
  const ports = { ...base, ...extra(base) };
  const handler = createS15WebHandler(ports, { origin, cookieName: "jit_s15", loginPath: "/s14/login" });
  const headers = (more: Record<string, string> = {}) => ({ cookie: "jit_s15=owner-token", host: "jit.test", ...more });
  const get = (path: string, more: Record<string, string> = {}) => handler(new Request(`${origin}${path}`, { headers: headers(more) }));
  const post = (path: string, fields: Record<string, string>, more: Record<string, string> = {}) => handler(new Request(`${origin}${path}`, { method: "POST", headers: headers({ origin, "content-type": "application/x-www-form-urlencoded", ...more }), body: new URLSearchParams({ csrf: "csrf-fixture", requestId: id(), ...fields }) }));
  const send = (conversationId: string, text: string, more: Record<string, string> = {}) => post("/s15/forms/message", { conversationId, text, ...more });
  return { root, store, app, actor, ports, handler, get, post, send, issued, counts: () => ({ turn, calls, modes: [...modes] }), expire: () => { expired = true; }, advance: (ms: number) => { now += ms; },
    cleanup() { store.close(); rmSync(root, { recursive: true, force: true }); } };
}
export type WebFixture = ReturnType<typeof webFixture>;
export const newId = id;
