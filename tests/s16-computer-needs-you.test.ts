import { afterEach, expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppError } from "../src/errors";
import { ConversationStore } from "../src/s15/conversation/store";
import type { ConversationRequest } from "../src/s15/conversation/types";
import { VmStore } from "../src/s15/vm/store";
import { ComputerBrowser } from "../src/s16/computers/browser";
import { ComputerNeedsYou, computerNeedsYouOrigin } from "../src/s16/computers/needs-you";
import { ScreenControl } from "../src/s16/computers/screen";
import { screenOutcomeSources } from "../src/s16/computers/screen-outcomes";
import type { ComputerNeedsYouPost } from "../src/s16/computers/needs-you-types";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const fn of cleanups.splice(0).reverse()) fn(); });
const uid = () => crypto.randomUUID().replaceAll("-", "");
const origin = "https://notes.example.com";
const endpoint = { host: "vm.example.test", port: 22, user: "jit", identityFile: "/protected/key", knownHostsFile: "/protected/known" };

function fixture(minutes?: number) {
  const root = mkdtempSync(join(tmpdir(), "jit-needs-you-"));
  const store = new ConversationStore(join(root, "conversation.sqlite"), "fixture", true), vm = new VmStore(":memory:");
  cleanups.push(() => { vm.close(); store.close(); rmSync(root, { recursive: true, force: true }); });
  vm.save({ id: "vm", generation: 1, endpoint, managerId: "manager", state: "ready", networkCheckedAt: 1, networkIsolated: true, maxSessions: 2, reason: null, machineIdentity: "fixture-vm", boot: "boot", bindingMac: "52:54:00:12:34:56" });
  const owner = {}, sent: unknown[] = []; let now = 1_800_000_000_000, ownerGeneration = 1, sensitive = false, allowed = true;
  const requireOwner = (actor: object) => { if (actor !== owner) throw new AppError("authentication_required", 401); };
  const screenOptions = { store: vm, requireOwner, scope: () => ({ kind: "shared" as const }), now: () => now, leaseMs: 600_000,
    device: () => ({ async unavailable() { return null; }, async capture() { return new Uint8Array(64); }, async send(input: unknown) { sent.push(input); } }) };
  const screen = new ScreenControl(screenOptions);
  const options = { store, screen, requireOwner, ownerGeneration: () => ownerGeneration, vmGeneration: () => 1,
    tier: () => sensitive ? "sensitive" as const : undefined, allows: (request: ConversationRequest) => allowed && !!request.authority?.resources.includes("computer"), now: () => now, ...(minutes === undefined ? {} : { minutes }) };
  const cards = new ComputerNeedsYou(options);
  function request(id = uid(), conversationId = "conversation"): ConversationRequest {
    const command = { contract: "s15-conversation/v1" as const, requestId: id, conversationId, text: "continue", continuation: null };
    const row: ConversationRequest = { receipt: { contract: "s15-conversation-receipt/v1", requestId: id, rootRequestId: id, conversationId, receivedAt: now }, command, interpretationRequest: command, owner: { id: "owner", generation: 1 }, revision: 1, intent: { kind: "execute", instruction: "continue", subject: null, scope: { purposeId: "purpose", resourceIds: ["computer"], access: "reversible_write" } }, state: "running", code: null, authority: { id: `work_${id}`, purposeId: "purpose", policyRevision: 1, resources: ["computer"], route: { provider: "codex", model: "fixture-model" }, limits: { modelCalls: 5, toolCalls: 10, outputBytes: 32768, activeMs: 60000 } }, phase: "work", interpretation: null, interpretationCalls: 1, modelCalls: 0, toolCalls: 0, result: null, usage: null, actions: [], decision: null };
    store.db.query("INSERT INTO requests VALUES (?,?,?,?)").run(id, conversationId, row.state, JSON.stringify(row)); return row;
  }
  const row = request(), post: ComputerNeedsYouPost = { requestId: row.receipt.requestId, conversationId: "conversation", vmId: "vm", vmGeneration: 1, ownerGeneration: 1, reason: "sign_in", origin };
  const command = (kind: "watch" | "decline", cardId: string, generation: number) => cards.command(owner, { contract: "s16-computer-needs-you/v1", requestId: uid(), conversationId: "conversation", cardId, kind, generation });
  const back = async () => { const view = await screen.view(owner, "vm"); return screen.command(owner, { contract: "s16-screen-command/v1", requestId: uid(), vmId: "vm", kind: "hand_back", generation: view.generation, takeoverId: view.takeoverId }); };
  return { store, vm, screen, screenOptions, cards, options, owner, row, post, sent, request, command, back,
    advance(ms: number) { now += ms; }, get now() { return now; }, set sensitive(value: boolean) { sensitive = value; }, set allowed(value: boolean) { allowed = value; }, set ownerGeneration(value: number) { ownerGeneration = value; } };
}

test("card insertion commits before yield; a read in the two-store gap never voids the card", () => {
  const f = fixture();
  const write = f.screen.yieldToOwner.bind(f.screen), seen: string[] = [];
  const spy = spyOn(f.screen, "yieldToOwner").mockImplementation((vm, id, expiry) => {
    expect(f.store.db.inTransaction).toBe(false);
    expect(f.cards.list(f.owner, "conversation")[0]).toMatchObject({ id, state: "pending", canWatch: false });
    seen.push(id); return write(vm, id, expiry);
  });
  const result = f.cards.post(f.post); spy.mockRestore();
  expect(seen).toEqual([result.cardId]); expect(result).toMatchObject({ state: "yielded", generation: 1, expiresAt: f.now + 240 * 60_000 });
  expect(f.cards.list(f.owner, "conversation")[0]).toMatchObject({ state: "pending", canWatch: true, screenState: "yield" });
  expect(() => f.screen.agentInput("vm")).toThrow(expect.objectContaining({ code: "computer_yielded" }));
  expect(f.screen.idleBlocked("vm")).toBe(true);
  f.advance(31 * 60_000); expect(f.screen.idleBlocked("vm")).toBe(true);
});

test("failed insert leaves agent; failed yield voids its already durable card", () => {
  const f = fixture(); f.store.db.exec("CREATE TRIGGER fail_card BEFORE INSERT ON computer_needs_you BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(() => f.cards.post(f.post)).toThrow(); expect(f.screen.idleBlocked("vm")).toBe(false);
  f.store.db.exec("DROP TRIGGER fail_card");
  f.vm.db.exec("CREATE TRIGGER fail_yield BEFORE INSERT ON s16_screen_events WHEN NEW.kind='yield_started' BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(() => f.cards.post(f.post)).toThrow(); expect(f.screen.idleBlocked("vm")).toBe(false);
  expect(f.cards.list(f.owner, "conversation")[0]).toMatchObject({ state: "void", canWatch: false });
});

test("crash orphan is repaired at startup only after 60 seconds; failed void repairs on the next read", () => {
  const f = fixture(); const spy = spyOn(f.screen, "yieldToOwner").mockImplementation(() => { throw new Error("fixture crash gap"); });
  f.store.db.exec("CREATE TRIGGER fail_void BEFORE UPDATE ON computer_needs_you BEGIN SELECT RAISE(ABORT,'fixture'); END");
  expect(() => f.cards.post(f.post)).toThrow(); spy.mockRestore();
  expect(f.cards.list(f.owner, "conversation")[0]).toMatchObject({ state: "pending", canWatch: false });
  f.advance(59_999); expect(new ComputerNeedsYou(f.options).list(f.owner, "conversation")[0]!.state).toBe("pending");
  f.advance(1); expect(() => f.cards.list(f.owner, "conversation")).toThrow(); f.store.db.exec("DROP TRIGGER fail_void");
  expect(new ComputerNeedsYou(f.options).list(f.owner, "conversation")[0]).toMatchObject({ state: "void", canWatch: false });
});

test("SIGKILL after the committed insert leaves a durable orphan that startup repairs after the deadline", async () => {
  const f = fixture(), path = f.store.path, vmPath = join(path, "..", "vm.sqlite"), now = f.now;
  const registration = f.vm.registration("vm"); f.store.close();
  const child = Bun.spawn([process.execPath, "-e", `
    import { ConversationStore } from "./src/s15/conversation/store.ts";
    import { VmStore } from "./src/s15/vm/store.ts";
    import { ScreenControl } from "./src/s16/computers/screen.ts";
    import { ComputerNeedsYou } from "./src/s16/computers/needs-you.ts";
    const [path, vmPath, record, post, stamp] = process.argv.slice(1);
    const store = new ConversationStore(path, "fixture", false), vm = new VmStore(vmPath); vm.save(JSON.parse(record));
    const screen = new ScreenControl({store:vm, requireOwner(){}, device(){return null}, scope(){return {kind:"shared"}}, now:()=>Number(stamp)});
    screen.yieldToOwner = () => { if(store.db.inTransaction) throw Error("insert_not_committed"); process.kill(process.pid,"SIGKILL"); throw Error("kill_failed"); };
    new ComputerNeedsYou({store,screen,requireOwner(){},ownerGeneration:()=>1,vmGeneration:()=>1,tier(){},allows:()=>true,now:()=>Number(stamp)}).post(JSON.parse(post));
  `, path, vmPath, JSON.stringify(registration), JSON.stringify(f.post), String(now)], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
  const code = await child.exited; expect(code).not.toBe(0); expect(await new Response(child.stderr).text()).toBe("");
  const store = new ConversationStore(path, "fixture", false), vm = new VmStore(vmPath);
  cleanups.push(() => { store.close(); vm.close(); });
  let stamp = now + 59_999;
  const screen = new ScreenControl({ ...f.screenOptions, store: vm, now: () => stamp });
  const options = { ...f.options, store, screen, now: () => stamp };
  expect(new ComputerNeedsYou(options).list(f.owner, "conversation")[0]).toMatchObject({ state: "pending", canWatch: false });
  stamp++;
  expect(new ComputerNeedsYou(options).list(f.owner, "conversation")[0]).toMatchObject({ state: "void", canWatch: false });
  expect(screen.idleBlocked("vm")).toBe(false);
});

test("yield survives posting-run cancellation; takeover settles existing work before owner input and retains event card ID", async () => {
  const f = fixture(), ticket = f.screen.agentInput("vm"), result = f.cards.post(f.post);
  f.row.state = "stopped"; f.store.save(f.row);
  await expect(f.command("watch", result.cardId, 0)).rejects.toMatchObject({ code: "stale_screen" });
  let view = (await f.command("watch", result.cardId, result.generation)).screen!;
  expect(view).toMatchObject({ state: "settling", agentBusy: true });
  await expect(f.screen.command(f.owner, { contract: "s16-screen-command/v1", requestId: uid(), vmId: "vm", kind: "input", generation: view.generation, takeoverId: view.takeoverId, input: { kind: "text", text: "fixture" } })).rejects.toMatchObject({ code: "takeover_settling" });
  expect(f.sent).toEqual([]); ticket.end(); view = await f.screen.view(f.owner, "vm"); expect(view.state).toBe("owner");
  await f.screen.command(f.owner, { contract: "s16-screen-command/v1", requestId: uid(), vmId: "vm", kind: "input", generation: view.generation, takeoverId: view.takeoverId, input: { kind: "text", text: "fixture" } });
  expect(f.sent).toHaveLength(1); const back = (await f.back()).view;
  expect(back.generation).toBe(3); expect(back.state).toBe("agent");
  expect(f.vm.db.query("SELECT card_id FROM s16_screen_control WHERE vm_id='vm'").get()).toEqual({ card_id: null });
  expect(f.screen.cardOutcome(result.cardId)).toMatchObject({ outcome: "resumed", generation: 3, cardId: result.cardId });
  f.store.db.exec("CREATE TRIGGER fail_card_update BEFORE UPDATE ON computer_needs_you BEGIN SELECT RAISE(ABORT,'fixture'); END");
  f.advance(240 * 60_000); expect(f.cards.list(f.owner, "conversation")[0]).toMatchObject({ state: "resumed", generation: 3 });
  await expect(f.screen.frame(f.owner, "vm", view.generation)).rejects.toMatchObject({ code: "stale_screen" });
});

test("decline and lazy expiry return to agent with old card ID; fixed expiry belongs only to yield", async () => {
  const f = fixture(30), first = f.cards.post(f.post); expect(first.expiresAt).toBe(f.now + 30 * 60_000);
  await f.command("decline", first.cardId, first.generation); expect(f.screen.cardOutcome(first.cardId)?.outcome).toBe("declined");
  const second = f.cards.post(f.post); f.advance(30 * 60_000);
  expect(f.screen.idleBlocked("vm")).toBe(false); expect(f.screen.cardOutcome(second.cardId)).toMatchObject({ cardId: second.cardId, outcome: "expired" });
  const third = f.cards.post(f.post); await f.command("watch", third.cardId, third.generation);
  f.advance(31 * 60_000); expect((await f.screen.view(f.owner, "vm")).state).toBe("fenced");
  expect(f.screen.cardOutcome(third.cardId)).toBeNull(); expect(f.cards.list(f.owner, "conversation").find(card => card.id === third.cardId)!.expiresAt).toBe(third.expiresAt);
  const restarted = new ScreenControl(f.screenOptions); expect(restarted.cardControl(third.cardId)!.state).toBe("fenced");
  expect(restarted.cardOutcome(third.cardId)).toBeNull(); await f.back(); expect(f.screen.cardOutcome(third.cardId)?.outcome).toBe("resumed");
});

test("card expiry never removes a renewed owner; restarting owner control keeps the card fenced", async () => {
  const f = fixture(30), card = f.cards.post(f.post), taken = (await f.command("watch", card.cardId, card.generation)).screen!;
  for (let i = 0; i < 4; i++) {
    f.advance(9 * 60_000);
    await f.screen.command(f.owner, { contract: "s16-screen-command/v1", requestId: uid(), vmId: "vm", kind: "renew", generation: taken.generation, takeoverId: taken.takeoverId });
  }
  expect((await f.screen.view(f.owner, "vm")).state).toBe("owner"); expect(f.screen.cardOutcome(card.cardId)).toBeNull();
  const restarted = new ScreenControl(f.screenOptions); expect(restarted.cardControl(card.cardId)).toMatchObject({ state: "fenced", generation: taken.generation + 1 });
  expect(f.cards.list(f.owner, "conversation")[0]).toMatchObject({ state: "pending", canWatch: true });
});

test("screen CHECK migration preserves existing controls, events and commands and fences retained owner control", () => {
  const f = fixture();
  f.vm.db.exec("DROP TABLE s16_screen_control; DROP TABLE s16_screen_events; CREATE TABLE s16_screen_control(vm_id TEXT PRIMARY KEY,generation INTEGER NOT NULL,state TEXT NOT NULL CHECK(state IN ('agent','settling','owner','fenced')),takeover_id TEXT,expires_at INTEGER); CREATE TABLE s16_screen_events(sequence INTEGER PRIMARY KEY,vm_id TEXT NOT NULL,kind TEXT NOT NULL,generation INTEGER NOT NULL,at INTEGER NOT NULL); INSERT INTO s16_screen_control VALUES('vm',7,'owner','old_takeover',90000); INSERT INTO s16_screen_events VALUES(1,'vm','takeover',7,1000); INSERT INTO s16_screen_commands VALUES('old_command','old_hash','vm');");
  const migrated = new ScreenControl(f.screenOptions);
  expect(migrated.generation("vm")).toBe(8);
  expect(f.vm.db.query("SELECT state,card_id FROM s16_screen_control").get()).toEqual({ state: "fenced", card_id: null });
  expect(f.vm.db.query("SELECT kind,card_id FROM s16_screen_events WHERE sequence=1").get()).toEqual({ kind: "takeover", card_id: null });
  expect(f.vm.db.query("SELECT hash FROM s16_screen_commands WHERE id='old_command'").get()).toEqual({ hash: "old_hash" });
});

test("browser high-water marks survive restart without interrupting tickets or changing the settling generation", async () => {
  const f = fixture(), ticket = f.screen.agentInput("vm");
  f.screen.observedBrowserGeneration("vm", 42); expect(() => ticket.current()).not.toThrow();
  const taken = (await f.screen.command(f.owner, { contract: "s16-screen-command/v1", requestId: uid(), vmId: "vm", kind: "takeover", generation: 0 })).view;
  expect(taken).toMatchObject({ state: "settling", generation: 43 }); ticket.end();
  expect((await f.screen.view(f.owner, "vm"))).toMatchObject({ state: "owner", generation: 43 });
  await f.back(); const restarted = new ScreenControl(f.screenOptions); expect(restarted.browserGeneration("vm")).toBe(44);
});

test("a changed tier after the availability wait refuses takeover; metadata and origin cannot expand scope", async () => {
  const f = fixture(), result = f.cards.post(f.post), gate = Promise.withResolvers<void>();
  const device = f.screenOptions.device()!; device.unavailable = async () => { await gate.promise; return null; };
  const get = spyOn(f.screen.options, "device").mockReturnValue(device);
  const watch = f.command("watch", result.cardId, result.generation); f.sensitive = true; gate.resolve();
  await expect(watch).rejects.toMatchObject({ code: "website_protected" }); get.mockRestore();
  expect(f.screen.cardControl(result.cardId)!.state).toBe("yield");
  await expect(f.cards.command({}, { contract: "s16-computer-needs-you/v1", requestId: uid(), conversationId: "conversation", cardId: result.cardId, kind: "decline", generation: 1 })).rejects.toMatchObject({ code: "authentication_required" });
  expect(() => f.cards.post({ ...f.post, origin: "https://github.com" })).toThrow(expect.objectContaining({ code: "website_sensitive_only" }));
  f.sensitive = false; f.allowed = false; expect(() => f.cards.post(f.post)).toThrow(expect.objectContaining({ code: "outside_scope" }));
});

test("only exact carried cards mark delivered inside committed publication; rollback, scope and owner fences preserve them", async () => {
  const f = fixture(), first = f.cards.post(f.post); await f.command("decline", first.cardId, first.generation);
  const next = f.request(); expect(f.cards.prepare(next)).toEqual([{ cardId: first.cardId, origin, reason: "sign_in", outcome: "declined", generation: 2 }]);
  f.allowed = false; expect(f.cards.prepare(next)).toEqual([]); f.allowed = true;
  expect(f.cards.prepare(f.request(uid(), "other"))).toEqual([]);
  next.screenOutcomeCards = [first.cardId]; next.state = "completed";
  expect(() => f.cards.delivered(next)).toThrow(expect.objectContaining({ code: "completion_transaction_required" }));
  expect(() => f.store.transaction(() => { f.cards.delivered(next); throw new Error("publication rollback"); })).toThrow();
  expect(f.cards.prepare(next)).toHaveLength(1);
  const second = f.cards.post(f.post); await f.command("decline", second.cardId, second.generation);
  f.store.transaction(() => f.cards.delivered(next));
  expect(f.cards.prepare(next).map(card => card.cardId)).toEqual([second.cardId]);
  f.ownerGeneration = 2; expect(f.cards.prepare(next)).toEqual([]); expect(f.cards.list(f.owner, "conversation")).toEqual([]);
});

test("bounded undelivered custody refuses the 65th card without yielding; changing expiry affects future cards only", async () => {
  const f = fixture(30), first = f.cards.post(f.post); await f.command("decline", first.cardId, first.generation);
  const later = new ComputerNeedsYou({ ...f.options, minutes: 1440 });
  for (let i = 1; i < 64; i++) {
    const card = later.post(f.post); expect(card.expiresAt).toBe(f.now + 1440 * 60_000);
    f.screen.declineYield("vm", card.cardId, card.generation);
  }
  expect(later.list(f.owner, "conversation").find(card => card.id === first.cardId)!.expiresAt).toBe(first.expiresAt);
  expect(() => later.post(f.post)).toThrow(expect.objectContaining({ code: "computer_needs_you_limit" }));
  expect(f.screen.idleBlocked("vm")).toBe(false); expect(later.list(f.owner, "conversation")).toHaveLength(64);
});

test("needs_you sends no CDP batch or ticket, returns immediately, and later browser calls are yielded", async () => {
  const f = fixture(); let streams = 0, tickets = 0;
  const browser = new ComputerBrowser({ assertAgent: vm => f.screen.assertAgent(vm), agentInput: vm => { tickets++; return f.screen.agentInput(vm); }, async unavailable() { return null; }, async stream() { streams++; throw Error("unexpected CDP"); }, tier: () => undefined, needsYou: input => f.cards.post(input), generation: vm => f.screen.generation(vm) });
  const abort = new AbortController(), run = browser.open("vm", () => {}, abort.signal, undefined, f.post);
  const yielded = await run.execute({ kind: "needs_you", reason: "sign_in", origin }); expect(yielded.state).toBe("yielded");
  expect(streams).toBe(0); expect(tickets).toBe(0);
  await expect(run.execute({ kind: "state" })).rejects.toMatchObject({ code: "computer_yielded" });
  await expect(run.execute({ kind: "needs_you", reason: "verify", origin })).rejects.toMatchObject({ code: "takeover_state_changed" });
  abort.abort(); expect(f.screen.cardControl(String(yielded.cardId))!.state).toBe("yield"); browser.close();
});

test("routine needs_you holds without a card or yield; secret-bearing and malformed operations are refused", async () => {
  const f = fixture(), browser = new ComputerBrowser({ assertAgent: vm => f.screen.assertAgent(vm), agentInput: vm => f.screen.agentInput(vm), async unavailable() { return null; }, async stream() { throw Error("unexpected stream"); }, tier: () => undefined, needsYou: input => f.cards.post(input) });
  const run = browser.open("vm", () => {}, new AbortController().signal, undefined, { ...f.post, routine: true });
  for (const bad of [{ kind: "needs_you", reason: "sign_in", origin, password: "secret" }, { kind: "needs_you", reason: "sign_in", origin, generation: 1 }, { kind: "needs_you", reason: "sign_in", origin: origin + "/login?token=secret" }, { kind: "needs_you", reason: "other", origin }]) await expect(run.execute(bad)).rejects.toMatchObject({ code: "computer_browser_operation_invalid" });
  expect(await run.execute({ kind: "needs_you", reason: "captcha", origin })).toMatchObject({ state: "needs_you" });
  expect(run.completionHold()).toBe("computer_needs_you"); expect(f.screen.idleBlocked("vm")).toBe(false); expect(f.cards.list(f.owner, "conversation")).toEqual([]); browser.close();
  expect(() => screenOutcomeSources([{ cardId: "card", origin, reason: "sign_in", outcome: "resumed", generation: 2, password: "secret" } as never])).toThrow();
  for (const value of ["file:///tmp", "https://user:secret@notes.example.com", "https://127.0.0.1", origin + "#secret"]) expect(() => computerNeedsYouOrigin(value)).toThrow();
});
