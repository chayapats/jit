import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Model } from "schway/host";
import { AppError } from "../../src/errors";
import { ConversationApplication, ConversationStore, createConversationPolicy, createConversationPolicyTools } from "../../src/s15/conversation";
import { createRecurringRules, type ActionDraft, type OwnerActor, type PrepareInput, type WorkActor } from "../../src/s15/policy";
import { zero } from "../../src/s15/policy/validation";
import { createS15WebHandler, s15ActionsPort, s15ConversationPort, s15RecurringPort, type S15WebPorts } from "../../src/s15/web";
import { fixture as policyFixture, ref, selection } from "./s15-policy";

/**
 * Deterministic UX15-02 Web fixture over the real POLICY service, the real CHAT application and the real S15 Web
 * handler. The scripted model prepares one exact held effect through the real policy tools; nothing is networked.
 */
export const origin = "http://jit.test";
const id = () => crypto.randomUUID().replaceAll("-", "");
export const conversationId = "conversation";

export function actionsFixture(extra: (ports: S15WebPorts<OwnerActor>) => Partial<S15WebPorts<OwnerActor>> = () => ({})) {
  const root = mkdtempSync(join(tmpdir(), "jit-s15-web-actions-"));
  const f = policyFixture();
  f.add("purpose", ref("interpret")); f.input.purposes.push(ref("interpret")); f.input.interpretationPurpose = ref("interpret"); f.install();
  let workTurn = 0;
  const model: Model = { provider: "codex", id: "scripted", async *stream(request) {
    if (request.systemPrompt.includes("JIT_ISOLATED_INTERPRETATION_V1")) {
      workTurn = 0;
      yield { type: "message_complete", message: { type: "assistant", id: id(), content: [{ type: "text", text: JSON.stringify({ intent: "execute", purposeId: "purpose", resourceIds: ["repo", "account"], access: "effect", subject: null }) }] } }; return;
    }
    workTurn++;
    const parts = workTurn === 1 ? [{ type: "tool_call" as const, id: id(), name: "send_note", arguments: {} }] : [{ type: "text" as const, text: "Prepared for your review." }];
    yield { type: "message_complete", message: { type: "assistant", id: id(), content: parts } };
  } };
  const policy = createConversationPolicy(f.service, { ownerId: "owner", ownerGeneration: () => 1, bot: ref("bot"), selection, route: { provider: "codex", model: "scripted" }, limits: { modelCalls: 5, toolCalls: 4, outputBytes: 4096, activeMs: 60000 }, modelCallUpperBound: { ...zero(), calls: 1, spendMinor: "1" } });
  const preparations: { actor: WorkActor; input: PrepareInput }[] = [];
  const instrumented = { ...f.service, work: { ...f.service.work, prepare(actor: WorkActor, input: PrepareInput) { preparations.push({ actor, input: structuredClone(input) }); return f.service.work.prepare(actor, input); } } };
  const tools = createConversationPolicyTools(instrumented, [{ name: "send_note", description: "Prepare the exact effect for owner review", inputSchema: { type: "object", properties: {}, additionalProperties: false }, access: "effect", adapter: "fixture", proposal: value => value }]);
  const store = new ConversationStore(join(root, "conversation.sqlite"), "test_installation", true);
  const app = new ConversationApplication(store, { policy, tools, model, nativeDirectory: join(root, "native"), clock: { now: () => f.now, sleep: (_ms, signal) => new Promise<void>((_resolve, reject) => { signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }); }) } });
  const owner = f.owner;
  const recurring = createRecurringRules(f.service, { frequencies: [{ id: "monthly", minIntervalMs: 2_592_000_000 }], maxPayments: 12, ruleLifetimeMs: 50_000, now: () => f.now });
  const base: S15WebPorts<OwnerActor> = {
    authentication: { authenticate(token) { if (token !== "owner-token") throw new AppError("authentication_required", 401); return { actor: owner, csrf: "csrf-fixture" }; }, verifyCsrf(expected, supplied) { if (expected !== supplied) throw new AppError("csrf_rejected", 403); } },
    conversation: s15ConversationPort(app),
    actions: s15ActionsPort(f.service, actor => actor),
    recurring: s15RecurringPort(recurring, actor => actor),
    rules: { current: actor => f.service.owner.current(actor), propose: () => { throw new AppError("not_found", 404); }, install: () => { throw new AppError("not_found", 404); }, budgetOptions: () => ({ currencies: [], periods: [] }) },
  };
  const ports = { ...base, ...extra(base) };
  const handler = createS15WebHandler(ports, { origin, cookieName: "jit_s15", loginPath: "/s14/login" });
  const headers = (more: Record<string, string> = {}) => ({ cookie: "jit_s15=owner-token", host: "jit.test", ...more });
  const get = (path: string) => handler(new Request(`${origin}${path}`, { headers: headers() }));
  const html = async (path: string) => { const response = await get(path); return { status: response.status, html: await response.text() }; };
  const post = (path: string, fields: Record<string, string>) => handler(new Request(`${origin}${path}`, { method: "POST", headers: headers({ origin, "content-type": "application/x-www-form-urlencoded" }), body: new URLSearchParams({ csrf: "csrf-fixture", requestId: id(), ...fields }) }));
  /** Owner asks; the scripted work prepares the current `f.draft` as one held exact action. */
  const hold = async (draft: Partial<ActionDraft> = {}, text = "Send the prepared note") => {
    f.draft = { ...f.draft, operation: "send", classes: ["communication"], resources: [ref("repo")], recipients: [ref("payee")], payload: { to: "fixture-recipient", body: text }, upperBound: { ...zero(), calls: 1, spendMinor: "1" }, transaction: null, github: null, ...draft };
    app.submit(owner, { contract: "s15-conversation/v1", requestId: id(), conversationId, text, continuation: null }); await app.drain();
  };
  const query = <T>(sql: string): T[] => { const db = new Database(f.path, { readonly: true }); try { return db.query(sql).all() as T[]; } finally { db.close(); } };
  /** Re-prepares the last held action in its original slot with the current draft: same action id, revision n+1. */
  const revise = (draft: Partial<ActionDraft>) => { const last = preparations.at(-1)!; f.draft = { ...f.draft, ...draft }; return f.service.work.prepare(last.actor, last.input); };
  return { f, app, owner, ports, handler, get, html, post, hold, query, recurring, revise,
    cleanup() { store.close(); f.cleanup(); rmSync(root, { recursive: true, force: true }); } };
}
export type ActionsFixture = ReturnType<typeof actionsFixture>;
