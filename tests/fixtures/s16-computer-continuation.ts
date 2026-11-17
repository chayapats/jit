import type { Model } from "schway/host";
import { composedFixture } from "./s15-composition";
import { JitClient } from "../../src/s16/client";
import type { ComputerNeedsYouCard } from "../../src/s16/computers/needs-you-types";

/** Actual Jit composition; models, hypervisor input and guest protocol are deterministic fixtures only. */
export async function computerContinuationFixture(partial = true, modelCalls = 5) {
  const prompts: string[] = [], sent: unknown[] = [];
  type Plan = "initial" | "continue" | "again" | "no_evidence";
  let plan: Plan = "initial";
  let hold: { plan: Plan; results: number; taken: boolean; entered: ReturnType<typeof Promise.withResolvers<void>>; release: ReturnType<typeof Promise.withResolvers<void>> } | null = null;
  const uid = () => crypto.randomUUID().replaceAll("-", "");
  const f = await composedFixture("default", false, undefined, o => ({ ...o, computers: { idleStopMs: 30 * 60_000, sweepMs: 0 }, screen: {}, conversation: { ...o.conversation, limits: { ...o.conversation.limits, modelCalls, toolCalls: modelCalls === 5 ? o.conversation.limits.toolCalls : 64 } },
    vm: { ...o.vm, managers: new Map([...o.vm.managers].map(([id, manager]) => [id, Object.assign(manager, { screen: () => ({ async unavailable() { return null; }, async capture() { return new Uint8Array(64); }, async send(input: unknown) { sent.push(input); } }) })])) },
    model: { ...o.model, scripted: route => ({ provider: "codex-subscription", id: route.modelId, async *stream(request) {
      prompts.push(JSON.stringify(request));
      const results = request.items.filter(item => item.type === "tool_result").length;
      const runPlan = plan;
      if (hold && hold.plan === runPlan && hold.results === results && !hold.taken) { hold.taken = true; hold.entered.resolve(); await hold.release.promise; }
      const tool = (name: string, args: Record<string, unknown>) => [{ type: "tool_call" as const, id: uid(), name, arguments: args }];
      const needs = () => tool("computer_browser", { kind: "needs_you", reason: "sign_in", origin: "https://notes.example.com" });
      const text = (text: string) => [{ type: "text" as const, text }];
      const parts = !request.tools?.length ? text("An unrelated answer.") : runPlan === "no_evidence" ? text("No observed tool result.") : runPlan === "initial"
        ? partial && results === 0 ? tool("write", { path: "draft.txt", content: "draft before sign-in" }) : results === (partial ? 1 : 0) ? needs() : text("Waiting for the owner handoff.")
        : results === 0 ? runPlan === "again" ? needs() : tool(partial ? "read" : "bash", partial ? { path: "draft.txt" } : { command: "printf continued" }) : text("Continued from observed evidence.");
      yield { type: "message_complete", message: { type: "assistant", id: uid(), content: parts } };
    } } as Model) } }));
  const client = new JitClient({ origin: "http://localhost:3099", fetch: async request => { const url = new URL(request.url); return f.request(url.pathname + url.search, request.method, request.method === "POST" ? await request.json() : undefined); } });
  await client.bootstrap();
  async function card(): Promise<ComputerNeedsYouCard> { const cards = (await client.snapshot("conversation")).needsYouCards!; return cards.findLast(card => card.state === "pending") ?? cards.at(-1)!; }
  async function handBack(input?: ComputerNeedsYouCard) {
    const value = input ?? await card();
    const taken = await client.needsYou({ contract: "s16-computer-needs-you/v1", requestId: uid(), conversationId: "conversation", cardId: value.id, kind: "watch", generation: value.generation! });
    return client.screenCommand({ contract: "s16-screen-command/v1", requestId: uid(), vmId: value.vmId, kind: "hand_back", generation: taken.screen!.generation, takeoverId: taken.screen!.takeoverId });
  }
  return { f, client, prompts, sent, card, handBack,
    hold(at: Plan, results: number) { const value = { plan: at, results, taken: false, entered: Promise.withResolvers<void>(), release: Promise.withResolvers<void>() }; hold = value; return value; },
    deferScheduler() { const drain = f.service.drain; f.service.drain = async () => {}; return () => { f.service.drain = drain; }; }, set plan(value: Plan) { plan = value; } };
}
