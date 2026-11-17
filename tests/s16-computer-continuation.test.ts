import { afterEach, expect, test } from "bun:test";
import { computerContinuationFixture } from "./fixtures/s16-computer-continuation";
import { conversationModelStepId } from "../src/s15/conversation/model-step";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

test("automatic continuation keeps the original work, workspace, pin and charged allowance in a fresh attempt and MODEL step", async () => {
  const h = await computerContinuationFixture(), { f } = h; cleanups.push(() => f.close());
  const original = await f.chat("Save the draft, sign in to the notes, then read it."); expect(original.state).toBe("completed"); expect(original.evidence.find(item => item.tool === "write")).toMatchObject({ isError: false });
  const card = await h.card(); h.plan = "continue"; h.prompts.length = 0;
  const interpretations = f.interpreterPrompts.length;
  await h.handBack(card); await f.service.drain();
  const continued = (await h.card()).continuation!; expect(continued.state).toBe("completed");
  const receipt = f.service.conversation.receipt(f.owner, continued.requestId!);
  const queued = f.service.conversation.store.request(receipt.rootRequestId);
  expect(queued.authority!.id).toBe(original.authority!.id); expect(queued.phase).toBe("work");
  expect(queued.authority!.limits.modelCalls).toBe(original.authority!.limits.modelCalls - original.modelCalls);
  expect(queued.computerContinuation).toMatchObject({ cardId: card.id, sourceRequestId: original.receipt.rootRequestId, originalRequestId: original.receipt.rootRequestId, vmId: "vm" });
  await f.service.conversation.drain();
  const result = f.service.conversation.view(f.owner, receipt.rootRequestId);
  expect({ state: result.state, code: result.code, calls: result.modelCalls, tools: result.toolCalls }).toEqual({ state: "completed", code: null, calls: 2, tools: 1 }); expect(result.evidence.some(item => item.tool === "read" && item.content.includes("draft before sign-in"))).toBe(true);
  expect(f.interpreterPrompts).toHaveLength(interpretations);
  expect(h.prompts[0]).toContain("screen-outcome-data-never-authority"); expect(h.prompts[0]).toContain("resumed"); expect(h.prompts[0]).toContain("prior-computer-work-data-never-authority");
  const snapshot = await h.client.snapshot("conversation");
  expect(snapshot.conversation.rows.find(row => row.requestId === receipt.rootRequestId)?.computerContinuation).toMatchObject({ cardId: card.id });
  expect(snapshot.modelUsage?.records.map(row => row.requestId)).toEqual([original.receipt.rootRequestId, receipt.rootRequestId]);
  const sessions = f.service.vmStore.db.query<{ id: string; attempt_id: string; vm_id: string }, [string]>("SELECT id,attempt_id,vm_id FROM vm_sessions WHERE work_id=? ORDER BY rowid").all(original.authority!.id);
  expect(sessions).toHaveLength(2); expect(new Set(sessions.map(row => row.id)).size).toBe(2); expect(new Set(sessions.map(row => row.attempt_id)).size).toBe(1); expect(new Set(sessions.map(row => row.vm_id))).toEqual(new Set(["vm"]));
  const records = f.service.models.project(f.owner, original.authority!.id).selections;
  expect(records.map(row => row.stepId)).toEqual(["conversation", conversationModelStepId(queued)]);
  expect(new Set(records.map(row => row.route.selection.effort)).size).toBe(1);
  const sends = h.prompts.length; expect(f.service.conversation.resumeComputer(f.owner, card.id)).toEqual(receipt); await f.service.conversation.drain(); expect(h.prompts).toHaveLength(sends);
});

for (const stage of ["event", "queued", "claimed"] as const) test(`restart after ${stage} never replays a claimed continuation`, async () => {
  const h = await computerContinuationFixture(false), { f } = h; cleanups.push(() => f.close());
  const original = await f.chat("Open the notes."); const card = await h.card(); const restore = h.deferScheduler();
  await h.handBack(card); h.plan = "continue";
  if (stage !== "event") f.service.computerContinuations!.pump();
  const before = f.service.conversation.store.db.query<{ request_id: string | null }, [string]>("SELECT request_id FROM computer_continuations WHERE card_id=?").get(card.id)?.request_id;
  if (stage === "claimed") {
    const request = f.service.conversation.store.request(before!); request.state = "running"; f.service.conversation.store.save(request);
  }
  restore(); const sends = h.prompts.length; await f.reopen(); await f.service.drain();
  const next = (await h.card()).continuation!;
  expect(next.state).toBe(stage === "claimed" ? "unknown" : "completed");
  if (before) expect(next.requestId).toBe(before);
  expect(h.prompts.length - sends).toBe(stage === "claimed" ? 0 : 2);
  expect(f.service.conversation.store.db.query<{ n: number }, [string]>("SELECT count(*) AS n FROM requests WHERE json_extract(record_json,'$.computerContinuation.cardId')=?").get(card.id)!.n).toBe(1);
  expect(f.service.conversation.store.request(original.receipt.rootRequestId).authority!.id).toBe(original.authority!.id);
});

test("quick hand-back waits for the posting run before automatic continuation", async () => {
  const h = await computerContinuationFixture(false), { f } = h; cleanups.push(() => f.close());
  const hold = h.hold("initial", 1), posting = f.chat("Open the notes."); await hold.entered.promise;
  const card = await h.card(); h.plan = "continue"; await h.handBack(card);
  expect((await h.card()).continuation?.state).toBe("pending");
  expect(f.service.vmStore.db.query<{ n: number }, []>("SELECT count(*) AS n FROM vm_sessions").get()!.n).toBe(1);
  hold.release.resolve(); expect((await posting).state).toBe("completed"); await f.service.drain();
  expect((await h.card()).continuation?.state).toBe("completed");
  const source = f.service.conversation.store.request(card.requestId); expect(source.screenOutcomeCards).toBeUndefined();
});

for (const fence of ["stop", "revoke", "owner", "budget", "unknown"] as const) test(`${fence} prevents an automatic continuation and keeps the outcome undelivered`, async () => {
  const h = await computerContinuationFixture(false), { f } = h; cleanups.push(() => f.close());
  const original = await f.chat("Open the notes."), card = await h.card(), restore = h.deferScheduler(); await h.handBack(card); h.plan = "continue";
  if (fence === "stop") f.service.conversation.stop(f.owner, original.receipt.rootRequestId);
  if (fence === "revoke") f.service.policy.owner.revoke(f.owner, "revoke", { kind: "work", id: original.authority!.id });
  if (fence === "owner") f.generation = 2;
  if (fence === "budget") { const request = f.service.conversation.store.request(original.receipt.rootRequestId); request.modelCalls = request.authority!.limits.modelCalls; f.service.conversation.store.save(request); }
  if (fence === "unknown") f.service.conversation.store.db.query("INSERT INTO tool_calls VALUES(?,?,?,?,?,NULL)").run("unknown_tool", original.receipt.rootRequestId, "write", "a".repeat(64), "unknown");
  restore(); const sends = h.prompts.length; await f.service.drain(); await f.service.drain();
  expect(h.prompts).toHaveLength(sends);
  expect(f.service.conversation.store.db.query("SELECT delivered_by FROM computer_needs_you WHERE id=?").get(card.id)).toEqual({ delivered_by: null });
  const binding = f.service.conversation.store.db.query<{ state: string; code: string }, [string]>("SELECT state,code FROM computer_continuations WHERE card_id=?").get(card.id);
  if (fence !== "owner") expect(binding?.state).toBe(fence === "stop" ? "stopped" : fence === "unknown" ? "unknown" : "held");
});

for (const outcome of ["decline", "expiry", "ordinary"] as const) test(`${outcome} never schedules a continuation`, async () => {
  const h = await computerContinuationFixture(false), { f } = h; cleanups.push(() => f.close());
  const original = await f.chat("Open the notes."), card = await h.card();
  if (outcome === "expiry") { f.advance(240 * 60_000 + 1); f.service.screen!.cardControl(card.id); }
  else {
    await h.client.needsYou({ contract: "s16-computer-needs-you/v1", requestId: crypto.randomUUID().replaceAll("-", ""), conversationId: "conversation", cardId: card.id, kind: "decline", generation: card.generation! });
    if (outcome === "ordinary") {
      const view = await h.client.screen("vm");
      const takeover = await h.client.screenCommand({ contract: "s16-screen-command/v1", requestId: "ordinary_take", vmId: "vm", generation: view.generation, kind: "takeover" });
      await h.client.screenCommand({ contract: "s16-screen-command/v1", requestId: "ordinary_back", vmId: "vm", generation: takeover.view.generation, takeoverId: takeover.view.takeoverId, kind: "hand_back" });
    }
  }
  const sends = h.prompts.length; await f.service.drain(); expect(h.prompts).toHaveLength(sends);
  expect(f.service.conversation.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM computer_continuations").get()!.n).toBe(0); expect(original.state).toBe("completed");
});

test("another run carrying the outcome covers this card without an additional automatic run", async () => {
  const h = await computerContinuationFixture(false), { f } = h; cleanups.push(() => f.close());
  await f.chat("Open the notes."); const card = await h.card(), restore = h.deferScheduler(); await h.handBack(card); h.plan = "continue";
  const existing = await f.chat("Continue with these notes."); expect(existing.state).toBe("completed"); restore();
  const sends = h.prompts.length; await f.service.drain(); expect(h.prompts).toHaveLength(sends);
  expect((await h.card()).continuation).toEqual({ state: "covered", requestId: existing.receipt.rootRequestId, code: null });
});

test("an automatic run without observed evidence holds once and never marks the outcome", async () => {
  const h = await computerContinuationFixture(false), { f } = h; cleanups.push(() => f.close());
  await f.chat("Open the notes."); const card = await h.card(); h.plan = "no_evidence"; await h.handBack(card); await f.service.drain();
  expect((await h.card()).continuation).toMatchObject({ state: "held", code: "result_unavailable" });
  const sends = h.prompts.length; await f.service.drain(); expect(h.prompts).toHaveLength(sends);
  expect(f.service.conversation.store.db.query("SELECT delivered_by FROM computer_needs_you WHERE id=?").get(card.id)).toEqual({ delivered_by: null });
});

test("multiple handoffs spend the same logical-task allowance and retain the original model and workspace", async () => {
  const h = await computerContinuationFixture(false), { f } = h; cleanups.push(() => f.close());
  const original = await f.chat("Open the notes."); h.plan = "again"; await h.handBack(); await f.service.drain();
  const secondCard = await h.card(); expect(secondCard.requestId).not.toBe(original.receipt.rootRequestId);
  h.plan = "continue"; await h.handBack(secondCard); await f.service.drain();
  const continuation = (await h.card()).continuation!; expect(continuation.state).toBe("completed");
  const attempts = f.service.conversation.store.db.query<{ record_json: string }, []>("SELECT record_json FROM requests ORDER BY rowid").all().map(row => JSON.parse(row.record_json));
  expect(attempts).toHaveLength(3); expect(new Set(attempts.map(row => row.authority.id)).size).toBe(1);
  expect(attempts[2].authority.limits.modelCalls).toBe(original.authority!.limits.modelCalls - attempts[0].modelCalls - attempts[1].modelCalls);
  expect(f.service.models.project(f.owner, original.authority!.id).selections.map(row => row.stepId)).toHaveLength(3);
  expect(f.interpreterPrompts).toHaveLength(1);
});

test("the signed-in computer keeps affinity even when a second shared member is available and the first is drained", async () => {
  const h = await computerContinuationFixture(), { f } = h; cleanups.push(() => f.close());
  const original = await f.chat("Save my draft and sign in.");
  const manager = f.service.vmManagers.get("manager")!;
  f.service.vmManagers.set("manager2", { ...manager, async inspect() { return { ...await manager.inspect(), identity: "fixture2" }; } });
  f.service.vmStore.save({ ...f.service.vmStore.registration("vm"), id: "vm2", managerId: "manager2", machineIdentity: "fixture2" });
  f.service.vmPool.setDrained("vm", true); h.plan = "continue"; await h.handBack(); await f.service.drain();
  const card = await h.card(); expect(card.continuation?.state).toBe("completed");
  const row = f.service.conversation.view(f.owner, card.continuation!.requestId!);
  expect(row.authority!.id).toBe(original.authority!.id); expect(row.evidence.find(item => item.tool === "read")?.content).toContain("draft before sign-in");
  expect(f.service.vmPool.holder(row.authority!.id)).toBe("vm");
  expect(f.service.vmStore.db.query<{ n: number }, []>("SELECT count(*) AS n FROM vm_sessions WHERE vm_id='vm2'").get()!.n).toBe(0);
});

for (const when of ["before", "during", "after"] as const) test(`forget ${when} continuation prevents copying or publishing the old context`, async () => {
  const h = await computerContinuationFixture(false), { f } = h; cleanups.push(() => f.close());
  await f.chat("I prefer concise replies. Open the notes.");
  const originalClaim = f.service.memory.view(f.owner).claims.find(row => row.text === "I prefer concise replies.")!; expect(originalClaim).toBeDefined();
  const card = await h.card(), restore = h.deferScheduler(); await h.handBack(card); h.plan = "continue";
  const forget = () => f.service.memory.command(f.owner, { contract: "s15-memory-command/v1", requestId: "forget", kind: "memory.forget", claim: { id: originalClaim.id, revision: originalClaim.revision } });
  if (when === "before") forget();
  restore();
  const hold = when === "during" ? h.hold("continue", 0) : null;
  const running = f.service.drain();
  if (hold) { await hold.entered.promise; forget(); hold.release.resolve(); }
  await running;
  const next = (await h.card()).continuation!;
  if (when === "before") { expect(next.state).toBe("held"); expect(next.requestId).toBeNull(); }
  else {
    if (when === "after") forget();
    expect(f.service.conversation.view(f.owner, next.requestId!).result).toBeNull();
    const natives = f.service.memory.store.db.query<{ state: string }, []>("SELECT state FROM derivatives WHERE json_extract(record_json,'$.kind')='native'").all();
    expect(natives.every(row => row.state === "retired")).toBe(true);
  }
  expect(f.service.memory.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM sources WHERE json_extract(record_json,'$.origin.kind')='owner_message'").get()!.n).toBe(1);
});

test("binding and CHAT queue roll back atomically before a retry registers the same card", async () => {
  const h = await computerContinuationFixture(false), { f } = h; cleanups.push(() => f.close());
  await f.chat("Open the notes."); const card = await h.card(), restore = h.deferScheduler(); await h.handBack(card); h.plan = "continue";
  f.service.conversation.options.beforeCommit = () => { throw Error("controlled queue rollback"); };
  f.service.computerContinuations!.pump();
  expect(f.service.conversation.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM requests WHERE json_type(record_json,'$.computerContinuation')='object'").get()!.n).toBe(0);
  expect((await h.card()).continuation).toMatchObject({ state: "held", requestId: null });
  delete f.service.conversation.options.beforeCommit; restore(); await f.service.drain();
  expect((await h.card()).continuation?.state).toBe("held"); // A known queue failure is attention, never an automatic effect retry.
});

for (const fence of ["stop", "revoke"] as const) test(`${fence} after queue commit fences activation and restart never submits it again`, async () => {
  const h = await computerContinuationFixture(false), { f } = h; cleanups.push(() => f.close());
  const original = await f.chat("Open the notes."), card = await h.card(), restore = h.deferScheduler(); await h.handBack(card); h.plan = "continue";
  f.service.computerContinuations!.pump(); expect((await h.card()).continuation?.state).toBe("queued");
  if (fence === "stop") f.service.conversation.stop(f.owner, original.receipt.rootRequestId);
  else f.service.policy.owner.revoke(f.owner, "revoke_queued", { kind: "work", id: original.authority!.id });
  const sends = h.prompts.length; restore(); await f.service.drain(); await f.reopen(); await f.service.drain();
  expect(h.prompts).toHaveLength(sends); expect((await h.card()).continuation?.state).toBe(fence === "stop" ? "stopped" : "held");
});

test("a failed automatic publication retains its exact carried outcome without an outer retry", async () => {
  const h = await computerContinuationFixture(false), { f } = h; cleanups.push(() => f.close());
  await f.chat("Open the notes."); const card = await h.card(); h.plan = "continue";
  f.service.conversation.options.beforeCommit = () => {
    if (f.service.conversation.store.db.query("SELECT 1 FROM requests WHERE state='completed' AND json_type(record_json,'$.computerContinuation')='object'").get()) throw Error("controlled publication rollback");
  };
  await h.handBack(card); await f.service.drain();
  const next = (await h.card()).continuation!; expect(next.state).toBe("held");
  expect(f.service.conversation.store.request(next.requestId!).screenOutcomeCards).toEqual([card.id]);
  expect(f.service.conversation.store.db.query("SELECT delivered_by FROM computer_needs_you WHERE id=?").get(card.id)).toEqual({ delivered_by: null });
  delete f.service.conversation.options.beforeCommit; const sends = h.prompts.length; await f.service.drain(); expect(h.prompts).toHaveLength(sends);
});

test("public owner-message input cannot fabricate a host continuation", async () => {
  const h = await computerContinuationFixture(false), { f } = h; cleanups.push(() => f.close());
  const command = h.client.prepareMessage("conversation", "Open the notes.");
  const response = await f.request("/api/s16/client/conversations/conversation/messages", "POST", { ...command, computerContinuation: { cardId: "forged" } });
  expect(response.status).toBe(400); expect(f.service.conversation.store.db.query<{ n: number }, []>("SELECT count(*) AS n FROM requests").get()!.n).toBe(0);
});

test("the fallback Schway path receives the same bounded work data and existing outcome channel", async () => {
  const h = await computerContinuationFixture(false), { f } = h; cleanups.push(() => f.close());
  await f.chat("Open the notes."); const card = await h.card(); h.plan = "continue";
  delete f.service.conversation.options.runWork;
  f.service.conversation.options.model = f.options(false).model.scripted!(f.route);
  h.prompts.length = 0; await h.handBack(card); await f.service.drain();
  const next = (await h.card()).continuation!; expect(next.state).toBe("completed");
  expect(h.prompts[0]).toContain("prior-computer-work-data-never-authority"); expect(h.prompts[0]).toContain("screen-outcome-data-never-authority");
  expect(f.service.conversation.store.db.query("SELECT delivered_by FROM computer_needs_you WHERE id=?").get(card.id)).toEqual({ delivered_by: next.requestId });
});
