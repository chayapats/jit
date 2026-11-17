import { afterEach, expect, spyOn, test } from "bun:test";
import type { Model, ModelRequest } from "schway/host";
import { JitClient } from "../src/s16/client";
import type { ComputerNeedsYouCard } from "../src/s16/computers/needs-you-types";
import { conversationRequestView } from "../src/s15/conversation/owner-view";
import { occurrenceOutcome } from "../src/s16/routines/service";
import { composedFixture } from "./fixtures/s15-composition";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
const uid = () => crypto.randomUUID().replaceAll("-", "");
const origin = "https://notes.example.com", sourceId = "screen-outcome-data-never-authority";
const shell = () => [{ type: "tool_call" as const, id: uid(), name: "bash", arguments: { command: "printf observed" } }];
async function fixture() {
  let mode: "normal" | "failure" | "no_evidence" = "normal", gate: Promise<void> | undefined;
  let entered = Promise.withResolvers<void>(); const prompts: string[] = [], inputs: ModelRequest[] = [], sent: unknown[] = [];
  const f = await composedFixture("default", false, undefined, o => ({ ...o, computers: { idleStopMs: 30 * 60_000, sweepMs: 0 }, screen: {},
    model: { ...o.model, scripted: route => {
      const original = o.model.scripted!(route);
      return { ...original, async *stream(request, call) {
        prompts.push(JSON.stringify(request)); inputs.push(request); entered.resolve();
        if (gate) await gate;
        if (mode === "failure") throw Error("controlled provider failure");
        if (mode === "no_evidence") { yield { type: "message_complete", message: { type: "assistant", id: uid(), content: [{ type: "text", text: "Completed without any observed tool result." }] } }; return; }
        yield* original.stream(request, call);
      } } as Model;
    } },
    vm: { ...o.vm, managers: new Map([...o.vm.managers].map(([id, manager]) => [id, Object.assign(manager, { screen: () => ({ async unavailable() { return null; }, async capture() { return new Uint8Array(64); }, async send(input: unknown) { sent.push(input); } }) })])) } }));
  cleanups.push(() => f.close());
  const client = new JitClient({ origin: "http://localhost:3099", fetch: async request => { const url = new URL(request.url); return f.request(url.pathname + url.search, request.method, request.method === "POST" ? await request.json() : undefined); } });
  await client.bootstrap();
  async function post() {
    f.script = [{ type: "tool_call", id: uid(), name: "computer_browser", arguments: { kind: "needs_you", reason: "sign_in", origin } }];
    const row = await f.chat("Open my notes in the computer browser."); expect(row.state).toBe("completed");
    const cards = (await client.snapshot("conversation")).needsYouCards!;
    expect(cards.at(-1)).toMatchObject({ state: "pending", reason: "sign_in", origin, canWatch: true });
    expect(f.vmCalls.some(call => JSON.stringify(call).includes("cdp-attach"))).toBe(false);
    return cards.at(-1)!;
  }
  const command = (card: ComputerNeedsYouCard, kind: "watch" | "decline", generation = card.generation!) => client.needsYou({ contract: "s16-computer-needs-you/v1", requestId: uid(), conversationId: "conversation", cardId: card.id, kind, generation });
  async function resume(card: ComputerNeedsYouCard) {
    const taken = await command(card, "watch"); expect(taken.screen!.state).toBe("owner");
    await client.screenCommand({ contract: "s16-screen-command/v1", requestId: uid(), vmId: "vm", kind: "input", generation: taken.screen!.generation, takeoverId: taken.screen!.takeoverId!, input: { kind: "text", text: "fixture-login" } });
    const back = await client.screenCommand({ contract: "s16-screen-command/v1", requestId: uid(), vmId: "vm", kind: "hand_back", generation: taken.screen!.generation, takeoverId: taken.screen!.takeoverId });
    expect(sent).toHaveLength(1); expect(back.view.state).toBe("agent"); return back.view.generation;
  }
  return { f, client, prompts, inputs, post, resume, command, set mode(value: typeof mode) { mode = value; }, hold(value: Promise<void> | undefined) { gate = value; if (value) entered = Promise.withResolvers<void>(); }, get entered() { return entered.promise; } };
}

test("composed non-IdP login handoff survives end of run; only continue carries outcome into the production MODEL request once", async () => {
  const h = await fixture(), { f, client } = h, card = await h.post();
  expect(f.service.screen!.idleBlocked("vm")).toBe(true);
  // Typed acknowledgement is neither a handoff decision nor a screen command.
  f.script = shell(); const whileYielded = await f.chat("ok"); expect(whileYielded.state).toBe("held"); expect(whileYielded.code).toBe("computer_yielded");
  expect((await client.snapshot("conversation")).needsYouCards!.find(row => row.id === card.id)!.state).toBe("pending");
  const generation = await h.resume(card);
  expect(f.service.vmStore.db.query("SELECT card_id FROM s16_screen_control WHERE vm_id='vm'").get()).toEqual({ card_id: null });
  h.prompts.length = 0; f.modelPrompts.length = 0; f.script = shell();
  const row = await f.chat("continue"); expect(row.state).toBe("completed");
  expect(f.service.conversation.store.request(row.receipt.requestId).screenOutcomeCards).toEqual([card.id]);
  for (const prompts of [h.prompts, f.modelPrompts]) {
    expect(prompts.length).toBeGreaterThan(0); expect(prompts[0]).toContain(sourceId); expect(prompts[0]).toContain(origin); expect(prompts[0]).toContain("resumed");
    const documents = JSON.parse((JSON.parse(prompts[0]!).context as { name: string; content: string }[]).find(entry => entry.name === "host-source-documents")!.content.split("\n").slice(1).join("\n"));
    expect(JSON.parse(documents.find((entry: { id: string }) => entry.id === sourceId).content)).toEqual({ authority: "none", outcomes: [{ cardId: card.id, origin, reason: "sign_in", outcome: "resumed", generation }] });
  }
  expect(f.interpreterPrompts.at(-1)).not.toContain(sourceId); expect(f.interpreterPrompts.at(-1)).not.toContain(origin);
  h.prompts.length = 0; expect((await f.chat("continue")).state).toBe("completed"); expect(h.prompts.join()).not.toContain(sourceId);
});

for (const failure of ["failure", "no_evidence", "publication_rollback"] as const) test(`a ${failure} run keeps its carried outcome for the next eligible production run`, async () => {
  const h = await fixture(), { f } = h, card = await h.post(); await h.resume(card);
  h.prompts.length = 0; f.script = shell();
  if (failure === "publication_rollback") f.service.conversation.options.beforeCommit = () => { if (f.service.conversation.store.db.query("SELECT 1 FROM requests WHERE state='completed' AND json_extract(record_json,'$.screenOutcomeCards[0]') IS NOT NULL").get()) throw Error("controlled publication failure"); };
  else h.mode = failure;
  const failed = await f.chat("continue"); expect(failed.state).toBe("held"); expect(h.prompts[0]).toContain(sourceId);
  expect(f.service.conversation.store.request(failed.receipt.requestId).screenOutcomeCards).toEqual([card.id]);
  expect(f.service.conversation.store.db.query("SELECT delivered_by FROM computer_needs_you WHERE id=?").get(card.id)).toEqual({ delivered_by: null });
  if (failure === "no_evidence") {
    expect(failed.code).toBe("result_unavailable");
    expect(f.service.models.project(f.owner, failed.authority!.id).selections[0]!.state).toBe("completed");
  }
  h.mode = "normal"; delete f.service.conversation.options.beforeCommit; h.prompts.length = 0;
  expect((await f.chat("continue")).state).toBe("completed"); expect(h.prompts[0]).toContain(sourceId); expect(h.prompts[0]).toContain("resumed"); expect(h.prompts[0]).toContain(origin);
});

test("completed answer without the computer never carries or marks the outcome", async () => {
  const h = await fixture(), { f } = h, card = await h.post(); await h.resume(card);
  h.mode = "no_evidence"; h.prompts.length = 0;
  f.interpretation = { intent: "answer", purposeId: "purpose", resourceIds: [], access: "read", subject: null };
  const answer = await f.chat("Answer only."); expect(answer.state).toBe("completed");
  expect(h.prompts[0]).not.toContain(sourceId); expect(f.service.conversation.store.request(answer.receipt.requestId).screenOutcomeCards).toBeUndefined();
  expect(f.service.conversation.store.db.query("SELECT delivered_by FROM computer_needs_you WHERE id=?").get(card.id)).toEqual({ delivered_by: null });
  h.mode = "normal"; h.prompts.length = 0; f.script = shell(); f.interpretation = { intent: "execute", purposeId: "purpose", resourceIds: ["computer"], access: "reversible_write", subject: null };
  expect((await f.chat("continue")).state).toBe("completed"); expect(h.prompts[0]).toContain(sourceId);
});

test("outcome arriving after prompt preparation is not marked by that completed run", async () => {
  const h = await fixture(), { f } = h, card = await h.post(), taken = await h.command(card, "watch");
  const gate = Promise.withResolvers<void>(), opened = Promise.withResolvers<void>();
  const port = f.service.conversation.options.tools, originalOpen = port.open.bind(port);
  const spy = spyOn(port, "open").mockImplementation(async (...args) => { opened.resolve(); await gate.promise; return originalOpen(...args); });
  h.prompts.length = 0; f.script = shell();
  const running = f.chat("continue"); await opened.promise;
  try {
    expect(f.service.conversation.store.db.query("SELECT 1 FROM requests WHERE state='running' AND json_extract(record_json,'$.screenOutcomeCards[0]') IS NOT NULL").get()).toBeNull();
    await h.client.screenCommand({ contract: "s16-screen-command/v1", requestId: uid(), vmId: "vm", kind: "hand_back", generation: taken.screen!.generation, takeoverId: taken.screen!.takeoverId });
  } finally { spy.mockRestore(); gate.resolve(); }
  expect((await running).state).toBe("completed");
  expect(f.service.conversation.store.db.query("SELECT delivered_by FROM computer_needs_you WHERE id=?").get(card.id)).toEqual({ delivered_by: null });
  h.prompts.length = 0; expect((await f.chat("continue")).state).toBe("completed"); expect(h.prompts[0]).toContain(sourceId);
});

test("needs-you ingress rechecks auth, CSRF, closed shape and exact conversation; routine uses the existing occurrence hold", async () => {
  const h = await fixture(), { f } = h, card = await h.post();
  const input = { contract: "s16-computer-needs-you/v1", requestId: uid(), conversationId: "conversation", cardId: card.id, kind: "watch", generation: card.generation };
  expect((await f.request("/api/s16/client/needs-you/commands", "POST", input, { cookie: "" })).status).toBe(401);
  expect((await f.request("/api/s16/client/needs-you/commands", "POST", input, { "x-csrf-token": "wrong" })).status).toBe(403);
  expect((await f.request("/api/s16/client/needs-you/commands", "POST", { ...input, password: "secret" })).status).toBe(400);
  expect((await f.request("/api/s16/client/needs-you/commands", "POST", { ...input, conversationId: "other" })).status).toBe(404);
  await h.command(card, "decline");
  f.script = [{ type: "tool_call", id: uid(), name: "computer_browser", arguments: { kind: "needs_you", reason: "captcha", origin } }];
  const id = uid(); f.service.conversation.submitRoutine(f.owner, { contract: "s15-conversation/v1", requestId: id, conversationId: "conversation", text: "Update the notes.", continuation: null }, { contract: "s16-routine-run/v1", routineId: "routine", occurrenceId: "occurrence", purposeId: "purpose", resourceIds: ["computer"], access: "reversible_write", quiet: false });
  await f.service.conversation.drain();
  expect(f.service.conversation.store.request(id)).toMatchObject({ state: "held", code: "computer_needs_you" });
  expect(occurrenceOutcome(conversationRequestView(f.service.conversation, f.owner, id))).toEqual(["needs_you", "computer_needs_you"]);
  expect(f.service.screen!.idleBlocked("vm")).toBe(false); expect((await h.client.snapshot("conversation")).needsYouCards).toHaveLength(1);
});

test("idle sweep keeps an untouched yielded VM awake at 31 minutes and lazily expires and sleeps it after four hours", async () => {
  const h = await fixture(), { f } = h, card = await h.post();
  f.advance(31 * 60_000); expect(await f.service.vm.sleepIdle()).toEqual([]);
  expect(f.service.vmStore.registration("vm").state).toBe("ready");
  f.advance(210 * 60_000); expect(await f.service.vm.sleepIdle()).toEqual(["vm"]);
  expect(f.service.screen!.cardOutcome(card.id)).toMatchObject({ outcome: "expired", cardId: card.id });
  expect(() => f.service.screen!.assertAgent("vm")).not.toThrow();
});
