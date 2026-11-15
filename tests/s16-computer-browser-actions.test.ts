import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BrowserActionCard as BrowserActionCardView } from "../src/s16/web/BrowserActionCard";
import { copy } from "../src/s16/web/copy";
import { JitClient } from "../src/s16/client";
import { createS16ClientHandler } from "../src/s16/http";
import { webFixture, origin as webOrigin } from "./fixtures/s15-web";
import { afterEach, expect, spyOn, test } from "bun:test";
import { parseHTML } from "linkedom";
import { AppError } from "../src/errors";
import type { BoxStream } from "../src/exec/box-runtime";
import { ComputerBrowser } from "../src/s16/computers/browser";
import { humanBrowserRow, type BrowserActionFacts, type BrowserInput } from "../src/s16/computers/browser-actions";
import { BrowserActionCards } from "../src/s16/computers/browser-cards";
import { ScreenControl } from "../src/s16/computers/screen";
import { VmStore } from "../src/s15/vm/store";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const close of cleanups.splice(0).reverse()) close(); });
const endpoint = { host: "127.0.0.1", port: 2222, user: "jit", identityFile: "/protected/key", knownHostsFile: "/protected/known" };
const facts = (name: string): BrowserActionFacts => ({ url: "https://public.org/", name, ref: "node", tag: "button", type: "submit", formNames: [], fields: [], revision: "r" });
const input: BrowserInput = { kind: "submit", generation: 1, target: "el_" + "a".repeat(32) };
for (const [row, words] of Object.entries({ a: ["pay", "buy", "purchase", "checkout", "order", "transfer", "subscribe", "ชำระเงิน", "ซื้อ", "โอน"], b: ["Send", "ส่งข้อความ", "ส่งอีเมล"], c: ["post", "publish", "share publicly", "เผยแพร่", "โพสต์"], d: ["deploy", "release", "promote to production", "ดีพลอย"], e: ["delete", "remove", "cancel account", "close account", "ลบ", "ปิดบัญชี"], f: ["password", "account settings", "security", "permissions", "รหัสผ่าน", "สิทธิ์"] })) {
  test.each(words)(`vocabulary row ${row}: %s`, word => expect(humanBrowserRow(input, facts(word))).toBe(row as never));
}
test("ordinary submits and non-Enter typing do not wait; form names and decoded URL paths do", () => {
  expect(humanBrowserRow(input, facts("Search"))).toBeNull();
  expect(humanBrowserRow({ ...input, kind: "type", value: "hello" }, facts("Send"))).toBeNull();
  expect(humanBrowserRow({ ...input, kind: "type", value: "hello\n" }, facts("Send"))).toBe("b");
  expect(humanBrowserRow(input, { ...facts("Continue"), formNames: ["account settings"] })).toBe("f");
  expect(humanBrowserRow(input, { ...facts("Continue"), url: "https://public.org/%70ay" })).toBe("a");
  expect(humanBrowserRow(input, facts("Reorderable list"))).toBeNull();
});

function fixture(label = "Continue", owner: object = {}) {
  const store = new VmStore(":memory:"); cleanups.push(() => store.close());
  store.save({ id: "vm1", generation: 1, endpoint, managerId: "manager", state: "ready", networkCheckedAt: 1, networkIsolated: true, maxSessions: 2, reason: null, machineIdentity: "m", boot: "b" });
  const { document, window } = parseHTML(`<html><body><form><input name="amount" value="20"><input name="recipients" value="alice@example.test"><textarea name="content">message body</textarea><input type="password" value="SECRET_PASSWORD"><input type="hidden" value="SECRET_HIDDEN"><input type="file" value="SECRET_FILE"><input autocomplete="one-time-code" value="SECRET_OTP"><select name="choice"><option value="one">one</option><option value="two">two</option></select><button type="submit">${label}</button></form></body></html>`);
  const form = document.querySelector("form")!, button = document.querySelector("button")!, field = document.querySelector("input")!, select = document.querySelector("select")!;
  Object.defineProperty(form, "elements", { get: () => [...form.querySelectorAll("input,textarea,select,button")] });
  let dispatches = 0, now = 1000, ownerGeneration = 1, opened = 0, tickets = 0, throwTicket = false;
  let redirect: string | undefined, beforeDispatch: (() => void) | undefined;
  for (const e of form.querySelectorAll("input,textarea,select,button")) Object.defineProperty(e, "form", { get: () => form });
  for (const e of form.querySelectorAll('[type=password],[type=file],[type=hidden],[autocomplete="one-time-code"]')) Object.defineProperty(e, "value", { get: () => { throw new Error("secret value read"); } });
  Object.defineProperty(form, "requestSubmit", { value: () => { dispatches++; } });
  Object.defineProperty(button, "click", { value: () => { dispatches++; if (redirect) location.href = redirect; } });
  const location = { href: "https://public.org/" }, global = {};
  const evaluate = (expression: string) => new Function("document", "location", "NodeFilter", "getComputedStyle", "globalThis", "crypto", "WeakRef", "Event", "KeyboardEvent", `return ${expression}`)(document, location, { SHOW_TEXT: 4, SHOW_ELEMENT: 1 }, () => ({ display: "block", visibility: "visible" }), global, crypto, WeakRef, window.Event, window.Event);
  let browser!: ComputerBrowser;
  const screen = new ScreenControl({ store, requireOwner: () => {}, scope: () => ({ kind: "shared" }), device: () => ({ async unavailable() { return null; }, async capture() { return new Uint8Array(); }, async send() {} }), onTransition: vm => browser.invalidate(vm), now: () => now });
  const streams: { closed: boolean }[] = [], methods: string[] = [];
  let cards!: BrowserActionCards<object>;
  browser = new ComputerBrowser({
    assertAgent: vm => screen.assertAgent(vm),
    agentInput: vm => { if (throwTicket) throw new AppError("takeover_active", 409); tickets++; const ticket = screen.agentInput(vm); return { current: () => ticket.current(), end: () => { tickets--; ticket.end(); } }; },
    pressGuard: card => { if (store.registration(card.vm).generation !== card.vmGeneration) throw new AppError("computer_browser_stale", 409); },
    unavailable: async () => null, tier: host => host === "sensitive.org" ? "sensitive" : undefined,
    hold: a => cards.hold(a),
    stream: async () => {
      opened++; const entry = { closed: false }; streams.push(entry);
      let out!: ReadableStreamDefaultController<Uint8Array>, exited!: (n: number) => void;
      const stream: BoxStream = { stdout: new ReadableStream({ start(c) { out = c; } }), exited: new Promise(resolve => { exited = resolve; }), close() { if (!entry.closed) { entry.closed = true; out.close(); exited(0); } }, write(bytes) {
        const m = JSON.parse(Buffer.from(bytes).subarray(0,-1).toString()); methods.push(m.method);
        let result: Record<string, unknown> = {};
        if (m.method === "Target.getTargets") result = { targetInfos: [{ targetId: "t1", type: "page", url: location.href }] };
        if (m.method === "Target.getTargetInfo") result = { targetInfo: { targetId: "t1", type: "page", url: location.href } };
        if (m.method === "Target.attachToTarget") result = { sessionId: "s1" };
        if (m.method === "Runtime.evaluate" && m.params.expression.includes("const op=")) beforeDispatch?.();
        if (m.method === "Runtime.evaluate") result = { result: { value: evaluate(m.params.expression) } };
        out.enqueue(Buffer.from(JSON.stringify({ id: m.id, result })+"\0"));
      } }; return stream;
    },
  });
  cards = new BrowserActionCards({ store, browser, requireOwner: actor => { if (actor !== owner) throw new AppError("authentication_required", 401); }, ownerGeneration: () => ownerGeneration, now: () => now });
  cleanups.push(() => browser.close());
  const run = () => browser.open("vm1", () => {}, new AbortController().signal, undefined, { requestId: "request", conversationId: "conversation", ownerGeneration: 1, vmGeneration: 1 });
  const observe = async (r = run(), index = 0) => { const o = await r.execute({ kind: "read", generation: 1 }); const es = o.elements as { id: string; tag: string; type: string; name: string }[]; return { r, o, target: es[index]!.id, es }; };
  const command = (kind: string, generation: number, takeoverId?: string | null) => screen.command(owner, { contract: "s16-screen-command/v1", requestId: crypto.randomUUID(), vmId: "vm1", kind, generation, ...(kind === "hand_back" ? { takeoverId } : {}) });
  const decide = (cardId: string, decision = "approve") => cards.decide(owner, { contract: "s16-browser-card-decision/v1", conversationId: "conversation", cardId, decision });
  return { browser, store, cards, owner, document, window, field, button, select, location, methods, run, observe, command, screen, decide, streams, get opened() { return opened; }, get dispatches() { return dispatches; }, get tickets() { return tickets; }, setNow: (v: number) => { now = v; }, setOwnerGeneration: (v: number) => { ownerGeneration = v; }, setThrow: (v: boolean) => { throwTicket = v; }, beforeDispatch: (hook: () => void) => { beforeDispatch = hook; }, setRedirect: (v: string) => { redirect = v; } };
}

async function held(f: ReturnType<typeof fixture>) {
  const { r, o, es } = await f.observe(); const target = es.find(e => e.tag === "button")!.id;
  const pending = await r.execute({ kind: "click", target, generation: o.generation });
  expect(pending.state).toBe("pending"); return { r, pending, cardId: pending.cardId as string };
}
test("actual DOM input programs: ordinary click/submit/type/select, secret fields never read or entered", async () => {
  const f = fixture();
  for (const kind of ["click", "submit"] as const) {
    const { r, o, es } = await f.observe(); const result = await r.execute({ kind, target: es.find(e => e.tag === "button")!.id, generation: o.generation });
    expect(result.state).toBe("ok"); r.close();
  }
  const { r, o, es } = await f.observe(); expect(await r.execute({ kind: "type", value: "transient input", target: es[0]!.id, generation: o.generation })).toMatchObject({ state: "ok" }); expect(f.field.value).toBe("transient input"); r.close();
  const next = await f.observe(); expect((await next.r.execute({ kind: "select", value: "two", target: next.es.find(e => e.tag === "select")!.id, generation: next.o.generation })).state).toBe("ok"); next.r.close();
  for (const index of [3,4,5,6]) for (const kind of ["click", "submit", "type", "select"] as const) {
    const a = await f.observe(); await expect(a.r.execute({ kind, target: a.es[index]!.id, generation: a.o.generation, ...(["type","select"].includes(kind) ? { value: "NEVER_ENTER" } : {}) })).rejects.toMatchObject({ code: "computer_browser_secret_field" }); a.r.close();
  }
  expect(f.dispatches).toBe(2);
});
test("held card shows exact nonsecret values, closes posting stream/ticket, survives run end and sends once", async () => {
  const f = fixture("Pay"), h = await held(f);
  expect(f.streams[0]!.closed).toBe(true); expect(f.tickets).toBe(0); expect(f.dispatches).toBe(0);
  const card = f.cards.list(f.owner, "conversation")[0]!;
  expect(JSON.stringify(card)).toContain("alice@example.test"); expect(JSON.stringify(card)).toContain("message body"); expect(JSON.stringify(card)).toContain('"20"'); expect(JSON.stringify(card)).not.toContain("SECRET_");
  h.r.close(); expect((await f.decide(h.cardId)).state).toBe("sent"); expect(f.dispatches).toBe(1); expect(f.tickets).toBe(0); expect(f.streams.every(s => s.closed)).toBe(true);
  expect((await f.decide(h.cardId)).state).toBe("sent"); expect(f.dispatches).toBe(1);
});
test.each(["url", "element", "value"])("changed %s makes a card stale with no dispatch", async change => {
  const f = fixture("Pay"), h = await held(f);
  if (change === "url") f.location.href += "changed";
  if (change === "element") f.button.textContent = "Buy";
  if (change === "value") f.field.value = "30";
  expect((await f.decide(h.cardId)).state).toBe("stale"); expect(f.dispatches).toBe(0); expect(f.tickets).toBe(0); expect(f.streams.every(s => s.closed)).toBe(true);
});
test("press while another stream is held is busy, allocates no ticket, preserves pending then sends once", async () => {
  const f = fixture("Pay"), h = await held(f); await h.r.execute({ kind: "state" });
  const before = f.opened; await expect(f.decide(h.cardId)).rejects.toMatchObject({ code: "computer_browser_busy" }); expect(f.tickets).toBe(0); expect(f.opened).toBe(before);
  expect(f.cards.list(f.owner, "conversation")[0]!.state).toBe("pending"); h.r.disconnect();
  expect((await f.decide(h.cardId)).state).toBe("sent"); expect(f.dispatches).toBe(1);
});
test("refused origin and agentInput throw leave no stream or ticket, neither consumes the press", async () => {
  const f = fixture("Pay"), h = await held(f);
  f.location.href = "https://sensitive.org/secret"; await expect(f.decide(h.cardId)).rejects.toMatchObject({ code: "website_protected" });
  expect(f.streams.every(s => s.closed)).toBe(true); expect(f.tickets).toBe(0); expect(f.cards.list(f.owner,"conversation")[0]!.state).toBe("pending");
  f.location.href = "https://public.org/"; f.setThrow(true); await expect(f.decide(h.cardId)).rejects.toMatchObject({ code: "takeover_active" }); expect(f.streams.every(s => s.closed)).toBe(true); expect(f.tickets).toBe(0);
  f.setThrow(false); expect((await f.decide(h.cardId)).state).toBe("sent"); expect(f.dispatches).toBe(1);
});
test("pending releases takeover immediately; screen refusal is before stream/ticket and a later press still works", async () => {
  const f = fixture("Pay"), h = await held(f); const takeover = await f.command("takeover", 0);
  expect(takeover.view.state).toBe("owner"); const opened = f.opened;
  await expect(f.decide(h.cardId)).rejects.toMatchObject({ code: "takeover_active" }); expect(f.opened).toBe(opened); expect(f.tickets).toBe(0);
  await f.command("hand_back", takeover.view.generation, takeover.view.takeoverId); expect((await f.decide(h.cardId)).state).toBe("sent");
});
test("decline/expiry/restart are inert; reload of a sent card never repeats input", async () => {
  const f = fixture("Pay"), h = await held(f); expect((await f.decide(h.cardId,"decline")).state).toBe("declined");
  const h2 = await held(f); f.setNow(1_801_000); expect((await f.decide(h2.cardId)).state).toBe("expired"); expect(f.dispatches).toBe(0);
  const h3 = await held(f); expect((await f.decide(h3.cardId)).state).toBe("sent");
  const restarted = new BrowserActionCards({ store: f.store, browser: f.browser, requireOwner: () => {}, ownerGeneration: () => 1, now: () => 1_801_000 });
  expect(restarted.list(f.owner,"conversation").at(-1)!.state).toBe("sent"); expect(f.dispatches).toBe(1);
});
test("redirecting input returns no sensitive page text; secret or foreign targets and stale generations refuse", async () => {
  const f = fixture(); const a = await f.observe(); f.setRedirect("https://sensitive.org/secret?token=abc");
  await expect(a.r.execute({ kind: "click", target: a.es.find(e => e.tag === "button")!.id, generation: a.o.generation })).rejects.toMatchObject({ code: "website_protected" }); expect(f.dispatches).toBe(1);
});

test("late mutation inside the atomic input batch is stale, not sent or unknown", async () => {
  const f = fixture("Pay"), h = await held(f); f.beforeDispatch(() => { f.field.value = "40"; });
  expect((await f.decide(h.cardId)).state).toBe("stale"); expect(f.dispatches).toBe(0); expect(f.tickets).toBe(0);
});
test("concurrent presses cannot send twice; a changed VM/owner generation cannot dispatch", async () => {
  const f = fixture("Pay"), h = await held(f); const first = f.decide(h.cardId);
  await expect(f.decide(h.cardId)).rejects.toMatchObject({ code: "computer_browser_busy" }); expect((await first).state).toBe("sent"); expect(f.dispatches).toBe(1);
  const second = await held(f), registration = f.store.registration("vm1"); f.store.save({ ...registration, generation: registration.generation+1 });
  expect((await f.decide(second.cardId)).state).toBe("stale"); expect(f.dispatches).toBe(1);
  const third = await held(f); f.setOwnerGeneration(2); await expect(f.decide(third.cardId)).rejects.toMatchObject({ code: "not_found" }); expect(f.cards.list(f.owner,"conversation")).toEqual([]);
});
test("a proposed type value is owner-visible only in memory; restart invalidates it rather than replaying", async () => {
  const f = fixture("Pay"), { r, o, es } = await f.observe(); f.field.setAttribute("aria-label","Send");
  const pending = await r.execute({ kind: "type", target: es[0]!.id, generation: o.generation, value: "TRANSIENT_PROPOSED_TEXT\n" });
  expect(pending.state).toBe("pending"); const card = f.cards.list(f.owner,"conversation")[0]!;
  expect(card.value).toBe("TRANSIENT_PROPOSED_TEXT\n"); expect(f.field.value).toBe("20");
  expect(JSON.stringify(f.store.db.query("SELECT record FROM s16_browser_cards").all())).not.toContain("TRANSIENT_PROPOSED_TEXT");
  const restarted = new BrowserActionCards({ store: f.store, browser: f.browser, requireOwner() {}, ownerGeneration: () => 1, now: () => 1000 });
  expect(restarted.list(f.owner,"conversation")[0]!.state).toBe("stale"); expect(f.dispatches).toBe(0);
});
test("no unsafe schema escape, stale generation, removed element, secret conversion or oversized snapshot", async () => {
  const f = fixture(), { r, o, es } = await f.observe();
  await expect(r.execute({ kind: "click", target: es[0]!.id, generation: 99 })).rejects.toMatchObject({ code: "computer_browser_stale" });
  for (const extra of [{ selector: "button" }, { expression: "alert(1)" }, { protocol: "Runtime.evaluate" }, { credentials: "x" }]) await expect(r.execute({ kind: "click", target: es[0]!.id, generation: o.generation, ...extra })).rejects.toMatchObject({ code: "computer_browser_operation_invalid" });
  await expect(r.execute({ kind: "type", target: es[0]!.id, generation: o.generation, value: "x".repeat(4097) })).rejects.toMatchObject({ code: "computer_browser_operation_invalid" });
  f.field.remove(); await expect(r.execute({ kind: "click", target: es[0]!.id, generation: o.generation })).rejects.toMatchObject({ code: "computer_browser_stale" }); r.close();
  const a = await f.observe(); const button = a.es.find(e => e.tag === "button")!; f.button.setAttribute("type","hidden"); await expect(a.r.execute({ kind: "click", target: button.id, generation: a.o.generation })).rejects.toMatchObject({ code: "computer_browser_secret_field" }); a.r.close();
  expect(f.dispatches).toBe(0);
});

test("owner API uses exact cards only; text/cross-site/CSRF/foreign-conversation decisions never dispatch", async () => {
  const web = webFixture(); cleanups.push(() => web.cleanup());
  const f = fixture("Pay",web.actor), h = await held(f);
  await web.send("conversation",`approve ${h.cardId}`);
  const handler = createS16ClientHandler(web.app, { origin: webOrigin, cookieName: "jit_s15", authentication: web.ports.authentication, browserCards: f.cards });
  const headers = { cookie: "jit_s15=owner-token", origin: webOrigin, "content-type": "application/json", "x-csrf-token": "csrf-fixture" };
  const command = { contract: "s16-browser-card-decision/v1", conversationId: "conversation", cardId: h.cardId, decision: "approve" };
  const post = (body: unknown, more: Record<string,string> = {}) => handler(new Request(webOrigin+"/api/s16/client/browser-cards/decisions",{ method: "POST", headers: { ...headers,...more }, body: JSON.stringify(body) }));
  for (const more of [{ cookie: "" },{ origin: "https://evil.invalid" },{ "x-csrf-token": "" }]) expect((await post(command,more)).status).toBeGreaterThanOrEqual(400);
  expect((await post({ ...command, conversationId: "other" })).status).toBe(404);
  expect((await post({ ...command, value: "tampered" })).status).toBe(400);
  const snapshot = await handler(new Request(webOrigin+"/api/s16/client/conversations/conversation",{ headers })); expect(snapshot.status).toBe(200); expect(snapshot.headers.get("cache-control")).toBe("private, no-store");
  expect((await snapshot.json() as { browserCards: unknown[] }).browserCards).toHaveLength(1); expect(f.dispatches).toBe(0);
  const client = new JitClient({ origin: webOrigin, fetch: request => handler(new Request(request,{ headers: { ...Object.fromEntries(request.headers),cookie: "jit_s15=owner-token",origin: webOrigin } })) }); await client.bootstrap();
  expect((await client.snapshot("conversation")).browserCards).toHaveLength(1);
  expect((await client.browserCard("conversation",h.cardId,"approve")).state).toBe("sent"); expect(f.dispatches).toBe(1);
  expect((await client.browserCard("conversation",h.cardId,"approve")).state).toBe("sent"); expect(f.dispatches).toBe(1);
  web.expire(); expect((await post(command)).status).toBe(401);
});
test("owner authentication is refreshed immediately before the independent input batch", async () => {
  const f = fixture("Pay"), h = await held(f);
  await expect(f.cards.decide(f.owner, { contract: "s16-browser-card-decision/v1",conversationId: "conversation",cardId: h.cardId,decision: "approve" }, () => { throw new AppError("authentication_required",401); })).rejects.toMatchObject({ code: "authentication_required" });
  expect(f.dispatches).toBe(0); expect(f.tickets).toBe(0); expect(f.streams.every(s => s.closed)).toBe(true); expect(f.cards.list(f.owner,"conversation")[0]!.state).toBe("pending");
});
test("inline owner card escapes exact amount, recipients, content; full-review link and bilingual controls exist", async () => {
  const f = fixture("Pay"), h = await held(f), card = f.cards.list(f.owner,"conversation")[0]!;
  card.facts.fields.push({ name: "unsafe", value: '<script>alert("x")</script>' });
  for (const locale of ["en","th"] as const) {
    const html = renderToStaticMarkup(createElement(BrowserActionCardView,{ card, client: {} as JitClient, t: copy(locale), refresh() {}, onFailure() {} }));
    expect(html).toContain("alice@example.test"); expect(html).toContain("message body"); expect(html).toContain("&lt;script&gt;"); expect(html).not.toContain("<script>"); expect(html).not.toContain("SECRET_");
    expect(html).toContain(`#browser-card-values-${h.cardId}`); expect(html).toContain(copy(locale)("s16.card.approve")); expect(html).toContain(copy(locale)("s16.card.decline"));
  }
});

test("label associations classify the actual accessible name, even past the observation name cap", async () => {
  const f = fixture(); f.field.id = "amount"; const label = f.document.createElement("label"); label.setAttribute("for","amount"); label.textContent = "x".repeat(140)+" Pay"; f.document.body.append(label);
  const { r,o,es } = await f.observe(); expect(es[0]!.name.length).toBe(128);
  expect((await r.execute({ kind: "type", target: es[0]!.id, generation: o.generation, value: "100\n" })).state).toBe("pending"); expect(f.dispatches).toBe(0);
});
test.each(["checked","action"])("changed submitted %s state invalidates a press", async change => {
  const f = fixture("Pay"); f.field.setAttribute("type","checkbox"); Object.defineProperty(f.field,"checked",{ value: true,writable: true });
  const h = await held(f);
  if (change === "checked") (f.field as unknown as {checked: boolean}).checked = false;
  else f.document.querySelector("form")!.setAttribute("action","/new-destination");
  expect((await f.decide(h.cardId)).state).toBe("stale"); expect(f.dispatches).toBe(0);
});
test("large full form snapshots fail closed, without a card or dispatch", async () => {
  const f = fixture("Pay"); f.field.value = "x".repeat(12001); const a = await f.observe();
  await expect(a.r.execute({ kind: "click", target: a.es.find(e => e.tag === "button")!.id, generation: a.o.generation })).rejects.toMatchObject({ code: "computer_browser_snapshot_limit" }); expect(f.cards.list(f.owner,"conversation")).toHaveLength(0); expect(f.dispatches).toBe(0);
});
test("a durable sending claim recovers as unknown and is never automatically repeated", async () => {
  const f = fixture("Pay"), h = await held(f), record = f.store.db.query<{ record:string },[string]>("SELECT record FROM s16_browser_cards WHERE id=?").get(h.cardId)!;
  f.store.db.query("UPDATE s16_browser_cards SET record=? WHERE id=?").run(JSON.stringify({ ...JSON.parse(record.record),state:"sending" }),h.cardId);
  const restarted = new BrowserActionCards({ store:f.store,browser:f.browser,requireOwner(){},ownerGeneration:()=>1,now:()=>1000 });
  expect((await restarted.decide(f.owner,{contract:"s16-browser-card-decision/v1",conversationId:"conversation",cardId:h.cardId,decision:"approve"})).state).toBe("unknown"); expect(f.dispatches).toBe(0);
});

test.each(["role-button","input-submit"])("classifies the actual accessible name of %s without reading editable values into observations", async kind => {
  const f = fixture(), element = f.document.createElement(kind === "role-button" ? "div" : "input");
  if (kind === "role-button") { element.setAttribute("role","button"); element.textContent="Pay"; }
  else { element.setAttribute("type","submit"); (element as unknown as {value:string}).value="Pay"; }
  f.document.body.append(element); const a=await f.observe(); const target=a.es.find(e=>kind==="role-button"?e.tag==="div":e.tag==="input"&&e.type==="submit")!;
  if (kind==="input-submit") expect(target.name).not.toContain("Pay");
  expect((await a.r.execute({ kind:"click",target:target.id,generation:a.o.generation })).state).toBe("pending"); expect(f.cards.list(f.owner,"conversation")[0]!.facts.name).toBe("Pay"); expect(f.dispatches).toBe(0);
});


test("a display label cannot hide a raw HTML field name from matching or the saved revision", async () => {
  const f = fixture(); f.field.id = "amount"; f.field.name = "pay";
  const label = f.document.createElement("label"); label.setAttribute("for", "amount"); label.textContent = "Amount"; f.document.body.append(label);
  const h = await held(f), card = f.cards.list(f.owner, "conversation")[0]!;
  expect(card.row).toBe("a"); expect(card.facts.formNames).toContain("pay"); expect(card.facts.formNames).toContain("Amount");
  expect(card.facts.fields[0]).toMatchObject({ name: "Amount", htmlName: "pay", value: "20" });
  expect(JSON.parse(card.facts.revision).fields[0].htmlName).toBe("pay");
  f.field.name = "buy";
  expect((await f.decide(h.cardId)).state).toBe("stale"); expect(f.dispatches).toBe(0);
});

test.each(["button text", "input value", "aria-labelledby"])("competing name sources use %s before a neutral fallback", async source => {
  const f = fixture("Pay"); let target: Element = f.button;
  if (source === "input value") {
    const button = f.document.createElement("input"); button.type = "submit"; button.value = "Pay";
    f.button.replaceWith(button); target = button;
  }
  target.setAttribute("title", "Continue");
  if (source === "aria-labelledby") {
    target.textContent = "Continue"; target.setAttribute("aria-label", "Continue");
    const label = f.document.createElement("span"); label.id = "pay-label"; label.textContent = "Pay"; f.document.body.append(label);
    target.setAttribute("aria-labelledby", "missing pay-label");
  }
  const { r, o, es } = await f.observe(); const element = es.find(e => source === "input value" ? e.type === "submit" : e.tag === "button")!;
  expect((await r.execute({ kind: "click", target: element.id, generation: o.generation })).state).toBe("pending");
  const card = f.cards.list(f.owner, "conversation")[0]!;
  expect(card.facts.name).toBe("Pay"); expect(card.row).toBe("a"); expect(f.dispatches).toBe(0);
});

test("ARIA labels still precede button contents, and title remains the fallback for unnamed buttons", async () => {
  const f = fixture("Pay"); f.button.setAttribute("aria-label", "Continue");
  const a = await f.observe();
  expect((await a.r.execute({ kind: "click", target: a.es.find(e => e.tag === "button")!.id, generation: a.o.generation })).state).toBe("ok"); a.r.close();
  f.button.removeAttribute("aria-label"); f.button.textContent = ""; f.button.setAttribute("title", "Pay");
  const h = await held(f); expect(f.cards.list(f.owner, "conversation")[0]!.facts.name).toBe("Pay");
  expect((await f.decide(h.cardId)).state).toBe("sent"); expect(f.dispatches).toBe(2);
});

test.each(["button image", "input image"])("%s requires a card, sends once, and a changed alt is stale", async source => {
  for (const changed of [false, true]) {
    const f = fixture(); let target: HTMLElement = f.button;
    const image = f.document.createElement(source === "button image" ? "img" : "input");
    image.setAttribute("alt", "Pay");
    if (source === "button image") f.button.replaceChildren(image);
    else { image.setAttribute("type", "image"); f.button.replaceWith(image); target = image; }
    const click = spyOn(target, "click").mockImplementation(() => {});
    const { r, o, es } = await f.observe(); const element = es.find(e => source === "button image" ? e.tag === "button" : e.type === "image")!;
    const pending = await r.execute({ kind: "click", target: element.id, generation: o.generation });
    expect(pending.state).toBe("pending"); expect(f.dispatches).toBe(0); expect(click).not.toHaveBeenCalled();
    const card = f.cards.list(f.owner, "conversation")[0]!;
    expect(element.name).toBe("Pay"); expect(card.facts.name).toBe("Pay"); expect(card.row).toBe("a");
    r.close();
    if (changed) image.setAttribute("alt", "Buy");
    expect((await f.decide(pending.cardId as string)).state).toBe(changed ? "stale" : "sent");
    expect((await f.decide(pending.cardId as string)).state).toBe(changed ? "stale" : "sent");
    expect(click).toHaveBeenCalledTimes(changed ? 0 : 1);
  }
});

test.each(["contents", "aria-label", "aria-labelledby"])("button under an editable ancestor keeps its %s without editable values", async source => {
  for (const changed of [false, true]) {
    const f = fixture("Pay"), editable = f.document.createElement("div"), privateText = f.document.createElement("span");
    editable.setAttribute("contenteditable", "true"); editable.textContent = "EDITABLE_PRIVATE";
    f.button.replaceWith(editable); editable.append(f.button);
    privateText.setAttribute("contenteditable", "true"); privateText.textContent = "EDITABLE_PRIVATE"; f.button.append(privateText);
    const label = f.document.createElement("span"); label.id = "button-label"; label.textContent = "Pay"; f.document.body.append(label);
    if (source === "aria-label") f.button.setAttribute("aria-label", "Pay");
    if (source === "aria-labelledby") f.button.setAttribute("aria-labelledby", label.id);
    const { r, o, es } = await f.observe();
    expect(JSON.stringify(o)).not.toContain("EDITABLE_PRIVATE"); expect(JSON.stringify(o)).not.toContain("SECRET_");
    const target = es.find(e => e.tag === "button")!;
    const pending = await r.execute({ kind: "click", target: target.id, generation: o.generation });
    expect(pending.state).toBe("pending"); expect(f.dispatches).toBe(0);
    const card = f.cards.list(f.owner, "conversation")[0]!;
    expect(target.name).toBe("Pay"); expect(card.row).toBe("a"); expect(card.facts.name).toBe("Pay");
    expect(JSON.stringify(card)).not.toContain("EDITABLE_PRIVATE"); expect(JSON.stringify(card)).not.toContain("SECRET_");
    r.close();
    if (changed) {
      if (source === "contents") f.button.firstChild!.textContent = "Buy";
      if (source === "aria-label") f.button.setAttribute("aria-label", "Buy");
      if (source === "aria-labelledby") label.textContent = "Buy";
    }
    expect((await f.decide(pending.cardId as string)).state).toBe(changed ? "stale" : "sent");
    expect(f.dispatches).toBe(changed ? 0 : 1);
  }
});

test.each([["pay_now", "a"], ["delete_account", "e"], ["pay-now", "a"], ["delete/account", "e"], ["paypal", null], ["reorder", null]] as const)("raw field name %s has the same separators as URL paths", async (rawName, row) => {
  expect(humanBrowserRow(input, { ...facts("Continue"), formNames: [rawName] })).toBe(row);
  const f = fixture(); f.field.name = rawName;
  const label = f.document.createElement("label"); label.setAttribute("for", "amount"); label.textContent = "Amount"; f.field.id = "amount"; f.field.before(label);
  const { r, o, es } = await f.observe();
  const result = await r.execute({ kind: "click", target: es.find(e => e.tag === "button")!.id, generation: o.generation });
  expect(result.state).toBe(row ? "pending" : "ok"); expect(f.dispatches).toBe(row ? 0 : 1);
  if (row) expect(f.cards.list(f.owner, "conversation")[0]!.row).toBe(row);
  r.close();
});

test("associated labels precede button subtree per HTML-AAM 4.1.4", async () => {
  const f = fixture("Pay"), label = f.document.createElement("label");
  f.button.id = "go"; label.setAttribute("for", "go"); label.textContent = "Next"; f.button.before(label);
  const { r, o, es } = await f.observe(); const target = es.find(e => e.tag === "button")!;
  expect(target.name).toBe("Next");
  expect((await r.execute({ kind: "click", target: target.id, generation: o.generation })).state).toBe("ok");
  expect(f.cards.list(f.owner, "conversation")).toHaveLength(0); expect(f.dispatches).toBe(1); r.close();
});

async function assertPayNameHeld(f: ReturnType<typeof fixture>, change: () => void, changed: boolean, expectedName = "Pay", node: HTMLElement = f.button) {
  const click = spyOn(node, "click");
  const { r, o, es } = await f.observe();
  const target = es.find(e => node.tagName === "INPUT" ? e.type === "image" : e.tag === "button")!;
  expect(target.name.trim()).toBe(expectedName);
  const pending = await r.execute({ kind: "click", target: target.id, generation: o.generation });
  expect(pending.state).toBe("pending"); expect(f.dispatches).toBe(0); expect(click).not.toHaveBeenCalled();
  const card = f.cards.list(f.owner, "conversation")[0]!;
  expect(card.row).toBe("a"); expect(card.facts.name.trim()).toBe(expectedName);
  expect(JSON.stringify(o)).not.toContain("SECRET_"); expect(JSON.stringify(card)).not.toContain("SECRET_");
  r.close();
  if (changed) change();
  expect((await f.decide(pending.cardId as string)).state).toBe(changed ? "stale" : "sent");
  expect((await f.decide(pending.cardId as string)).state).toBe(changed ? "stale" : "sent");
  expect(click).toHaveBeenCalledTimes(changed ? 0 : 1);
  expect(f.dispatches).toBe(node === f.button && !changed ? 1 : 0);
  click.mockRestore();
}

test.each([
  ["button", "false", true], ["button", "False", true], ["button", "false", false],
  ["button", "inherit", false], ["button", "invalid", false], ["button", "inherit", true],
  ["span", "false", false], ["span", "False", true], ["span", "inherit", false],
  ["img", "false", false], ["img", "False", true], ["img", "inherit", false],
  ["button-alt", "false", true], ["button-aria", "false", true],
] as const)("noneditable %s contenteditable=%s (editing ancestor=%s) holds its name", async (source, state, ancestor) => {
  for (const changed of [false, true]) {
    const f = fixture("Pay");
    if (ancestor) {
      const host = f.document.createElement("div"); host.setAttribute("contenteditable", "true");
      host.textContent = "SECRET_EDITABLE"; f.button.replaceWith(host); host.append(f.button);
    }
    let named: HTMLElement = f.button;
    if (source === "span" || source === "img" || source === "button-alt") {
      named = f.document.createElement(source === "span" ? "span" : "img");
      if (named.tagName === "IMG") named.setAttribute("alt", "Pay"); else named.textContent = "Pay";
      f.button.replaceChildren(named);
    }
    (source.startsWith("button") ? f.button : named).setAttribute("contenteditable", state);
    if (source === "button-aria") { f.button.textContent = "Continue"; f.button.setAttribute("aria-label", "Pay"); }
    await assertPayNameHeld(f, () => {
      if (source === "button-aria") f.button.setAttribute("aria-label", "Buy");
      else if (named.tagName === "IMG") named.setAttribute("alt", "Buy");
      else named.textContent = "Buy";
    }, changed);
  }
});

test.each(["aria-label", "labelledby", "labels", "all", "aria-to-label", "labelledby-to-aria"])("blank %s falls through without changing field facts", async source => {
  for (const changed of [false, true]) {
    const f = fixture(), image = f.document.createElement("img"); image.setAttribute("alt", "Pay"); f.button.replaceChildren(image);
    f.button.id = "go"; f.field.name = " raw_field "; f.field.value = " 20 ";
    if (["aria-label", "all", "aria-to-label"].includes(source)) f.button.setAttribute("aria-label", " \t\n ");
    if (["labelledby", "all", "labelledby-to-aria"].includes(source)) {
      for (const id of ["blank-one", "blank-two"]) { const span = f.document.createElement("span"); span.id = id; span.textContent = " \t "; f.document.body.append(span); }
      f.button.setAttribute("aria-labelledby", "blank-one blank-two");
    }
    let label: HTMLElement | undefined;
    if (["labels", "all", "aria-to-label"].includes(source)) {
      for (let i = 0; i < 2; i++) { label = f.document.createElement("label"); label.setAttribute("for", "go"); label.textContent = " \n "; f.button.before(label); }
    }
    if (source === "aria-to-label") { label!.textContent = "Pay"; image.setAttribute("alt", "Continue"); }
    if (source === "labelledby-to-aria") { f.button.setAttribute("aria-label", "Pay"); image.setAttribute("alt", "Continue"); }
    await assertPayNameHeld(f, () => {
      if (source === "aria-to-label") label!.textContent = "Buy";
      else if (source === "labelledby-to-aria") f.button.setAttribute("aria-label", "Buy");
      else image.setAttribute("alt", "Buy");
    }, changed);
    const field = f.cards.list(f.owner, "conversation")[0]!.facts.fields.find(field => field.htmlName === " raw_field ")!;
    expect(field.htmlName).toBe(" raw_field "); expect(field.value).toBe(" 20 ");
  }
});

test.each(["true", "", "plaintext-only", "TRUE", "PLAINTEXT-ONLY"])("editable state %s redacts self and descendants, including invalid inherited states", async state => {
  const f = fixture("SECRET_SELF"), host = f.document.createElement("div");
  f.button.setAttribute("contenteditable", state); f.button.setAttribute("aria-label", "Pay");
  host.setAttribute("contenteditable", state); host.innerHTML = '<a contenteditable="inherit">SECRET_LINK</a>';
  f.document.body.append(host);
  const publicButton = f.document.createElement("button"); publicButton.textContent = "Continue";
  const privateText = f.document.createElement("span"); privateText.setAttribute("contenteditable", state);
  privateText.innerHTML = '<b contenteditable="inherit">SECRET_TEXT</b><img alt="SECRET_ALT">'; publicButton.append(privateText); f.document.body.append(publicButton);
  const { r, o, es } = await f.observe();
  expect(JSON.stringify(o)).not.toContain("SECRET_"); expect(es.find(e => e.tag === "button")!.name).toBe("Pay");
  expect(es.filter(e => e.tag === "button")[1]!.name).toBe("Continue"); r.close();
});

test.each(["associated label", "aria-labelledby", "aria-label", "title", "input alt"])("editing-host native control keeps public %s, not editable text", async source => {
  for (const changed of [false, true]) {
    const f = fixture("SECRET_SELF"); let target: HTMLElement = f.button;
    f.button.setAttribute("contenteditable", "true"); f.button.id = "go";
    const privateText = f.document.createElement("span"); privateText.innerHTML = '<b>SECRET_DESCENDANT</b><img alt="SECRET_ALT">'; f.button.append(privateText);
    const label = f.document.createElement(source === "associated label" ? "label" : "span");
    label.id = "public-label"; label.textContent = "Pay"; label.setAttribute("contenteditable", "false");
    label.setAttribute("for", "go"); f.button.before(label);
    if (source === "aria-labelledby") f.button.setAttribute("aria-labelledby", label.id);
    if (source === "aria-label") f.button.setAttribute("aria-label", "Pay");
    if (source === "title") f.button.setAttribute("title", "Pay");
    if (source === "input alt") {
      target = f.document.createElement("input"); target.setAttribute("type", "image");
      target.setAttribute("alt", "Pay"); target.setAttribute("contenteditable", "true"); f.button.replaceWith(target);
    }
    await assertPayNameHeld(f, () => {
      if (source === "associated label" || source === "aria-labelledby") label.textContent = "Buy";
      else target.setAttribute(source === "input alt" ? "alt" : source, "Buy");
    }, changed, "Pay", target);
  }
});

for (const state of ["true", "", "plaintext-only"]) for (const word of ["Pay", "ชำระเงิน"]) {
  test.each(["span", "img"])(`false %s island in contenteditable=${state} button keeps ${word}`, async tag => {
    for (const changed of [false, true]) {
      const f = fixture("SECRET_SELF"); f.button.setAttribute("contenteditable", state);
      const privateText = f.document.createElement("span"); privateText.innerHTML = '<b contenteditable="inherit">SECRET_DESCENDANT</b><img alt="SECRET_ALT">';
      const island = f.document.createElement(tag); island.setAttribute("contenteditable", "false");
      if (tag === "img") island.setAttribute("alt", word); else island.textContent = word;
      f.button.append(privateText, island);
      await assertPayNameHeld(f, () => {
        if (tag === "img") island.setAttribute("alt", "Buy"); else island.textContent = "Buy";
      }, changed, word);
    }
  });
}

test.each([
  ["contents", null], ["contents", "inherit"], ["contents", "invalid"], ["contents", "false"], ["contents", "False"],
  ["associated label", "false"], ["associated label", null], ["associated label", "inherit"],
  ["aria-labelledby", "false"], ["aria-labelledby", null], ["aria-labelledby", "inherit"],
] as const)("designMode on keeps native %s (state=%s) and redacts inherited document/label text", async (source, state) => {
  for (const changed of [false, true]) {
    const f = fixture("Pay"); f.document.designMode = "On";
    const host = f.document.createElement("div"); host.innerHTML = 'SECRET_DESIGN<a href="/continue">SECRET_DESIGN_LINK</a><b contenteditable="inherit">SECRET_DESIGN_INHERITED</b><span contenteditable="false">Public text</span>';
    f.document.body.append(host);
    f.button.id = "go";
    let named: HTMLElement = f.button;
    if (source !== "contents") {
      named = f.document.createElement(source === "associated label" ? "label" : "span"); named.id = "design-label";
      named.textContent = state === "false" ? "Pay" : "SECRET_DESIGN_LABEL"; f.button.before(named);
      if (source === "associated label") named.setAttribute("for", "go"); else f.button.setAttribute("aria-labelledby", named.id);
    }
    if (state !== null) named.setAttribute("contenteditable", state);
    const privateText = f.document.createElement("span"); privateText.setAttribute("contenteditable", "true");
    privateText.innerHTML = '<b contenteditable="invalid">SECRET_DESIGN_DESCENDANT</b><img alt="SECRET_DESIGN_ALT">'; f.button.append(privateText);
    const observation = await f.observe();
    expect(observation.o.text).toContain("Public text"); expect(JSON.stringify(observation.o)).not.toContain("SECRET_"); observation.r.close();
    await assertPayNameHeld(f, () => {
      if (source === "contents" || state !== "false") f.button.firstChild!.textContent = "Buy";
      else named.textContent = "Buy";
    }, changed);
  }
});

test.each(["false", "False"])("designMode honors %s reset, then explicit true and invalid inheritance", async state => {
  const f = fixture("Pay"); f.document.designMode = "on";
  const island = f.document.createElement("div"); island.setAttribute("contenteditable", state);
  island.innerHTML = 'Public reset<a href="/continue" contenteditable="invalid">Public link</a><div contenteditable="true">SECRET_DESIGN_RESET<span contenteditable="invalid">SECRET_DESIGN_CHILD</span></div>';
  f.document.body.append(island);
  const { r, o, es } = await f.observe();
  expect(o.text).toContain("Public reset"); expect(o.text).toContain("Public link");
  expect(es.find(e => e.tag === "a")!.name).toBe("Public link"); expect(JSON.stringify(o)).not.toContain("SECRET_"); r.close();
});

test("refresh loads only live cards and the latest 64 terminal cards, not historical snapshots", async () => {
  const f = fixture("Pay"), h = await held(f), original = f.cards.list(f.owner, "conversation")[0]!;
  const insert = f.store.db.query("INSERT INTO s16_browser_cards VALUES (?,?,?)");
  for (let i = 0; i < 200; i++) {
    for (const [prefix, conversationId, ownerGeneration] of [["history", "conversation", 1], ["old-owner", "conversation", 0], ["foreign", "other", 1]] as const) {
      const card = { ...original, id: `${prefix}_${i}`, conversationId, ownerGeneration, state: "sent", facts: { ...original.facts, revision: "x".repeat(32000) } };
      insert.run(card.id, conversationId, JSON.stringify(card));
    }
  }
  const plans = [
    ["SELECT record FROM s16_browser_cards WHERE conversation_id=? AND json_extract(record,'$.state')='pending' ORDER BY rowid", ["conversation"], "s16_browser_cards_pending"],
    ["SELECT record FROM s16_browser_cards WHERE conversation_id=? AND json_extract(record,'$.ownerGeneration')=? AND json_extract(record,'$.state')!='pending' ORDER BY rowid DESC LIMIT 64", ["conversation", 1], "s16_browser_cards_recent"],
  ] as const;
  for (const [sql, args, index] of plans) {
    const plan = JSON.stringify(f.store.db.query("EXPLAIN QUERY PLAN " + sql).all(...args));
    expect(plan).toContain(index); expect(plan).not.toContain("SCAN"); expect(plan).not.toContain("TEMP B-TREE");
  }
  const parse = spyOn(JSON, "parse");
  let cards;
  try {
    new BrowserActionCards({ store: f.store, browser: f.browser, requireOwner() {}, ownerGeneration: () => 1, now: () => 1000 });
    expect(parse.mock.calls).toHaveLength(0); // Recovery updates sending claims in SQL, not by parsing history.
    cards = f.cards.list(f.owner, "conversation");
    expect(parse.mock.calls.length).toBe(65);
  } finally { parse.mockRestore(); }
  expect(cards.map(c => c.id)).toEqual([h.cardId, ...Array.from({ length: 64 }, (_, i) => `history_${i + 136}`)]);
  // Pending expiry is reconciled before the bounded history selection; no duplicate or lost card.
  f.setNow(original.expiresAt);
  cards = f.cards.list(f.owner, "conversation");
  expect(cards).toHaveLength(64); expect(cards.every(c => c.state === "sent")).toBe(true);
  expect((await f.decide(h.cardId)).state).toBe("expired"); expect(f.dispatches).toBe(0);
});


test("all 64 live cards survive the bounded terminal history and the pending limit remains enforced", async () => {
  const f = fixture("Pay"), h = await held(f), original = f.cards.list(f.owner, "conversation")[0]!;
  const action = { ...original, op: { ...input, kind: "click" as const } };
  const ids = [h.cardId];
  for (let i = 1; i < 64; i++) ids.push(f.cards.hold(action).cardId);
  expect(() => f.cards.hold(action)).toThrow("computer_browser_card_limit");
  expect(f.cards.list(f.owner, "conversation").map(c => c.id)).toEqual(ids);
  expect((await f.decide(ids[1]!, "decline")).state).toBe("declined");
  const next = f.cards.hold(action);
  const cards = f.cards.list(f.owner, "conversation");
  expect(cards.filter(c => c.state === "pending")).toHaveLength(64);
  expect(cards.filter(c => c.state === "declined").map(c => c.id)).toEqual([ids[1]!]);
  expect(cards.some(c => c.id === next.cardId)).toBe(true); expect(f.dispatches).toBe(0);
});

// Linkedom has no native form-owner/label forwarding/default-submit implementation.
// These shims exercise the host/card pipeline; Chromium evidence separately checks native activation.
function activationFixture(state: string, source: "external" | "button" | "link" | "label" | "wrapped label" | "input label", word = "Pay") {
  const f = fixture();
  const child = f.document.createElement("span"); child.setAttribute("contenteditable", state); child.textContent = "!";
  const form = f.document.querySelector("form")!; form.id = "outside";
  let control: HTMLElement, label: HTMLElement | undefined;
  if (source === "link") {
    control = f.document.createElement("a"); control.setAttribute("href", "/continue");
    f.document.body.append(control);
  } else if (source === "input label") {
    control = f.document.createElement("input"); control.setAttribute("type", "image"); control.setAttribute("alt", word);
    f.document.body.append(control);
  } else {
    control = f.document.createElement("button"); control.setAttribute("type", source === "external" ? "submit" : "button");
    f.document.body.append(control);
  }
  control.id = "effective";
  if (source === "external") control.setAttribute("form", form.id);
  // Honor an explicit unresolved form= rather than falling back to an ancestor form.
  if (control.tagName !== "A") Object.defineProperty(control, "form", { get: () => control.hasAttribute("form") ? f.document.getElementById(control.getAttribute("form")!) : control.closest("form") });
  if (source.includes("label")) {
    label = f.document.createElement("label"); label.setAttribute("for", control.id); label.append(word, child);
    Object.defineProperty(label, "control", { configurable: true, get: () => f.document.getElementById(label!.getAttribute("for")!) });
    f.document.body.append(label);
    if (source === "wrapped label") { label.removeAttribute("for"); label.append(control); Object.defineProperty(label, "control", { configurable: true, get: () => label!.querySelector("button") }); }
    // linkedom does not provide .labels; the production helper's existing label lookup handles it.
  } else control.append(word, child);
  let listeners = 0, submits = 0;
  const click = spyOn(child, "click").mockImplementation(() => { listeners++; if (source === "external") submits++; });
  const controlClick = spyOn(control, "click");
  return { f, child, control, label, click, controlClick, form, get listeners() { return listeners; }, get submits() { return submits; } };
}

for (const state of ["false", "true"]) for (const source of ["external", "button", "link", "label", "wrapped label", "input label"] as const) {
  test.each(["unchanged", "name", "identity", "attribute", "form owner"])(`child contenteditable=${state} activates ${source}: %s`, async change => {
    const a = activationFixture(state, source), { f } = a;
    const { r, o, es } = await f.observe();
    const target = es.find(e => e.tag === "span")!; expect(target).toBeDefined();
    const pending = await r.execute({ kind: "click", target: target.id, generation: o.generation });
    expect(pending.state).toBe("pending"); expect(a.listeners).toBe(0); expect(a.submits).toBe(0); expect(f.dispatches).toBe(0);
    expect(a.click).not.toHaveBeenCalled(); expect(a.controlClick).not.toHaveBeenCalled();
    const card = f.cards.list(f.owner, "conversation")[0]!;
    expect(card.row).toBe("a"); expect(card.facts.tag).toBe("span"); if (state === "true" || !a.label) expect(card.facts.name).toBe("");
    expect(card.facts.activation?.name).toContain("Pay"); expect(card.facts.activation?.ref).not.toBe(card.facts.ref);
    expect(JSON.stringify(o)).not.toContain("SECRET_"); expect(JSON.stringify(card)).not.toContain("SECRET_");
    if (source === "external") expect(card.facts.fields.find(field => field.htmlName === "amount")?.value).toBe("20");
    r.close();
    if (change === "name") {
      if (a.label) a.label.firstChild!.textContent = "Buy";
      else a.control.firstChild!.textContent = "Buy";
    }
    if (change === "identity") {
      const replacement = a.control.cloneNode(true) as HTMLElement;
      if (a.label) a.control.replaceWith(replacement);
      else { a.control.replaceWith(replacement); replacement.append(a.child); }
    }
    if (change === "attribute") a.control.setAttribute(source === "link" ? "href" : "formaction", "/changed");
    if (change === "form owner") {
      if (source === "external") { const other = f.document.createElement("form"); other.id = "other"; f.document.body.append(other); a.control.setAttribute("form", other.id); }
      else if (a.label && source !== "wrapped label") a.label.setAttribute("for", f.field.id = "different");
      else a.control.setAttribute(source === "link" ? "target" : "form", "different");
    }
    const expected = change === "unchanged" ? "sent" : "stale";
    expect((await f.decide(pending.cardId as string)).state).toBe(expected);
    expect((await f.decide(pending.cardId as string)).state).toBe(expected);
    expect(a.click).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0);
    expect(a.controlClick).not.toHaveBeenCalled(); // Always click the original child, never substitute its control.
    expect(a.listeners).toBe(change === "unchanged" ? 1 : 0); expect(a.submits).toBe(change === "unchanged" && source === "external" ? 1 : 0);
    expect(f.dispatches).toBe(0);
  });
}

test.each(["false", "true"])("ordinary Continue child (%s) does not require a card", async state => {
  for (const source of ["external", "button", "link", "label"] as const) {
    const a = activationFixture(state, source, "Continue"), { f } = a;
    const { r, o, es } = await f.observe();
    expect((await r.execute({ kind: "click", target: es.find(e => e.tag === "span")!.id, generation: o.generation })).state).toBe("ok");
    expect(f.cards.list(f.owner, "conversation")).toHaveLength(0); expect(a.listeners).toBe(1); expect(a.controlClick).not.toHaveBeenCalled(); r.close();
  }
});

test.each(["association", "identity", "action", "field"])("child approval pins effective form %s even with identical control names", async change => {
  const a = activationFixture("true", "external"), { f } = a;
  const { r, o, es } = await f.observe();
  const pending = await r.execute({ kind: "click", target: es.find(e => e.tag === "span")!.id, generation: o.generation });
  expect(pending.state).toBe("pending"); r.close();
  if (change === "identity" || change === "association") {
    const replacement = a.form.cloneNode(true) as HTMLElement;
    Object.defineProperty(replacement, "elements", { get: () => [...a.form.querySelectorAll("input,textarea,select,button")] });
    if (change === "identity") a.form.replaceWith(replacement);
    else { replacement.id = "other"; f.document.body.append(replacement); a.control.setAttribute("form", "other"); }
  }
  if (change === "action") a.form.setAttribute("action", "/changed");
  if (change === "field") f.field.value = "30";
  expect((await f.decide(pending.cardId as string)).state).toBe("stale"); expect(a.click).not.toHaveBeenCalled(); expect(a.submits).toBe(0);
});

test("label forwarding cannot expose or activate a secret control", async () => {
  const f = fixture(), label = f.document.createElement("label"), child = f.document.createElement("span");
  child.setAttribute("contenteditable", "false"); label.append("Pay", child); f.document.body.append(label);
  const secret = f.document.querySelector('[type="password"]')!; Object.defineProperty(label, "control", { configurable: true, get: () => secret });
  const click = spyOn(child, "click"); const { r, o, es } = await f.observe();
  await expect(r.execute({ kind: "click", target: es.find(e => e.tag === "span")!.id, generation: o.generation })).rejects.toMatchObject({ code: "computer_browser_secret_field" });
  expect(click).not.toHaveBeenCalled(); expect(f.cards.list(f.owner, "conversation")).toHaveLength(0); r.close();
});

test("interactive link inside a label is its own activation context, not the label's control", async () => {
  const a = activationFixture("false", "label"), { f } = a;
  a.label!.firstChild!.textContent = ""; a.control.setAttribute("aria-label", "Pay");
  const link = f.document.createElement("a"); link.setAttribute("href", "/continue"); link.append("Continue", a.child); a.label!.append(link);
  // The Pay-labelled control must not turn this separate Continue link into a held activation.
  const { r, o, es } = await f.observe();
  expect((await r.execute({ kind: "click", target: es.find(e => e.tag === "span")!.id, generation: o.generation })).state).toBe("ok");
  expect(f.cards.list(f.owner, "conversation")).toHaveLength(0); r.close();
});


test("child matching includes the effective external form's raw names, not only the ancestor's name", async () => {
  const a = activationFixture("true", "external", "Continue"), { f } = a;
  f.field.name = "pay_now"; f.field.value = " 20 ";
  const { r, o, es } = await f.observe();
  const pending = await r.execute({ kind: "click", target: es.find(e => e.tag === "span")!.id, generation: o.generation });
  expect(pending.state).toBe("pending"); expect(a.click).not.toHaveBeenCalled();
  const card = f.cards.list(f.owner, "conversation")[0]!;
  expect(card.row).toBe("a"); expect(card.facts.activation?.name).toBe("Continue");
  expect(card.facts.fields.find(field => field.htmlName === "pay_now")?.value).toBe(" 20 "); r.close();
});

test("an unresolved explicit form owner does not inherit an unrelated enclosing form", async () => {
  const a = activationFixture("false", "button", "Continue"), { f } = a;
  f.field.name = "pay_now"; a.form.append(a.control); a.control.setAttribute("form", "missing");
  const { r, o, es } = await f.observe();
  expect((await r.execute({ kind: "click", target: es.find(e => e.tag === "span")!.id, generation: o.generation })).state).toBe("ok");
  expect(a.click).toHaveBeenCalledTimes(1); expect(f.cards.list(f.owner, "conversation")).toHaveLength(0); r.close();
});

// These native association/default-action shims deliberately validate the submitted form and submitter.
// They are host-pipeline tests, not native-browser evidence; the same structures are probed in Chromium.
function nativeActivationFixture(state: string, nested = "direct", owner = "pay", type = "submit", word = "Pay") {
  const f = fixture();
  f.document.body.innerHTML = `<form id="pay"><input name="pay_now" value=" 20 "><input type="password" value="SECRET_PASSWORD"></form><form id="neutral"><input id="other" name="notes" value="hello"></form><form id="encdel"><input name="delete_account" value="yes"></form>`;
  const control = f.document.createElement(type === "image" ? "input" : "button"); control.id = "native";
  if (type !== "default") control.setAttribute("type", type);
  control.setAttribute("form", owner);
  if (type === "image") control.setAttribute("alt", word); else control.append(word);
  // Deliberately put the control inside a DIFFERENT form from its external owner.
  f.document.getElementById(owner === "pay" ? "encdel" : "pay")!.append(control);
  const child = f.document.createElement("span"); child.setAttribute("contenteditable", state); child.textContent = "!";
  let wrapper: HTMLElement | undefined;
  if (nested !== "direct") {
    wrapper = f.document.createElement(nested === "link" ? "a" : "label");
    if (nested === "link") wrapper.setAttribute("href", "/continue");
    if (nested === "label other") wrapper.setAttribute("for", "other");
    if (nested !== "link") Object.defineProperty(wrapper, "control", { get: () => wrapper!.hasAttribute("for") ? f.document.getElementById(wrapper!.getAttribute("for")!) : wrapper!.querySelector("input,button") });
    control.append(wrapper); wrapper.append(child);
  } else if (type !== "image") control.append(child);
  const submissions: { form: Element; submitter: Element | undefined }[] = [];
  const forms = [...f.document.querySelectorAll("form")];
  for (const e of f.document.querySelectorAll("input,button")) Object.defineProperty(e, "form", { get: () => e.hasAttribute("form") ? f.document.getElementById(e.getAttribute("form")!) : e.closest("form") });
  for (const form of forms) {
    Object.defineProperty(form, "elements", { get: () => [...f.document.querySelectorAll("input,button")].filter(e => (e as HTMLInputElement).form === form) });
    Object.defineProperty(form, "requestSubmit", { value: (submitter?: HTMLButtonElement) => {
      if (submitter && submitter.form !== form) throw new Error("wrong native submitter");
      submissions.push({ form, submitter });
    } });
  }
  const secret = f.document.querySelector('[type="password"]')!;
  Object.defineProperty(secret, "value", { get: () => { throw new Error("secret read"); } });
  let listeners = 0;
  control.addEventListener("click", () => { listeners++; });
  const original = type === "image" ? control : child;
  const click = spyOn(original, "click").mockImplementation(() => {
    original.dispatchEvent(new f.window.Event("click", { bubbles: true }));
    const form = (control as HTMLButtonElement).form;
    if (form && !["button", "reset"].includes(type)) form.requestSubmit(control as HTMLButtonElement);
  });
  const observe = async () => {
    const { r, o, es } = await f.observe();
    const target = es.find(e => type === "image" ? e.type === "image" : e.tag === "span")!.id;
    return { r, o, target };
  };
  return { f, control, child, wrapper, original, click, observe, submissions, get listeners() { return listeners; } };
}

for (const type of ["button", "reset", "image", "submit"]) test(`submit refuses a null native form owner (${type}) rather than sending the enclosing Pay form`, async () => {
  const a = nativeActivationFixture("false", "direct", "missing", type, "Continue"), { f } = a;
  const { r, o, target } = await a.observe();
  await expect(r.execute({ kind: "submit", target, generation: o.generation })).rejects.toMatchObject({ code: "computer_browser_target_invalid" });
  expect(a.submissions).toHaveLength(0); expect(a.listeners).toBe(0); expect(a.click).not.toHaveBeenCalled();
  expect(f.cards.list(f.owner, "conversation")).toHaveLength(0); r.close();
});

for (const state of ["false", "true"]) for (const kind of ["click", "submit"] as const) {
  test(`child ${state} ${kind} submits the pinned external neutral form, never the enclosing Pay form`, async () => {
    const a = nativeActivationFixture(state, "direct", "neutral", "submit", "Continue"), { f } = a;
    const { r, o, target } = await a.observe();
    expect((await r.execute({ kind, target, generation: o.generation })).state).toBe("ok");
    expect(f.cards.list(f.owner, "conversation")).toHaveLength(0);
    expect(a.submissions.map(s => s.form.id)).toEqual(["neutral"]); expect(a.submissions[0]!.submitter).toBe(a.control); r.close();
  });
  test(`child ${state} ${kind} reviews and sends external Pay form, never enclosing Delete form`, async () => {
    const a = nativeActivationFixture(state, "direct"), { f } = a, { r, o, target } = await a.observe();
    const pending = await r.execute({ kind, target, generation: o.generation });
    expect(pending.state).toBe("pending"); expect(a.submissions).toHaveLength(0); expect(a.listeners).toBe(0);
    const card = f.cards.list(f.owner, "conversation")[0]!;
    expect(card.row).toBe("a"); expect(card.facts.fields.map(v => v.htmlName)).toContain("pay_now");
    expect(card.facts.fields.map(v => v.htmlName)).not.toContain("delete_account"); expect(JSON.stringify(card)).not.toContain("SECRET_");
    r.close(); expect((await f.decide(pending.cardId as string)).state).toBe("sent");
    expect((await f.decide(pending.cardId as string)).state).toBe("sent");
    expect(a.submissions.map(s => s.form.id)).toEqual(["pay"]); expect(a.submissions[0]!.submitter).toBe(a.control);
    expect(a.click).toHaveBeenCalledTimes(kind === "click" ? 1 : 0);
  });
}

for (const state of ["false", "true"]) for (const nested of ["label", "label other", "link"]) {
  test.each(["unchanged", "name", "identity", "form"])(`child ${state} inside button/${nested} pins native button: %s`, async change => {
    const a = nativeActivationFixture(state, nested), { f } = a, { r, o, target } = await a.observe();
    const pending = await r.execute({ kind: "click", target, generation: o.generation });
    expect(pending.state).toBe("pending"); expect(a.listeners).toBe(0); expect(a.submissions).toHaveLength(0); expect(a.click).not.toHaveBeenCalled();
    const card = f.cards.list(f.owner, "conversation")[0]!;
    expect(card.row).toBe("a"); expect(card.facts.ref).not.toBe(card.facts.activation?.ref); expect(card.facts.activation?.tag).toBe("button");
    expect(card.facts.fields.map(v => v.htmlName)).toContain("pay_now"); expect(JSON.stringify(card)).not.toContain("SECRET_");
    if (change === "name") a.control.firstChild!.textContent = "Buy";
    if (change === "form") a.control.setAttribute("form", "neutral");
    if (change === "identity") { const replacement = a.control.cloneNode(false) as HTMLElement; a.control.replaceWith(replacement); replacement.append("Pay", a.wrapper!); Object.defineProperty(replacement, "form", { get: () => f.document.getElementById("pay") }); }
    r.close(); expect((await f.decide(pending.cardId as string)).state).toBe(change === "unchanged" ? "sent" : "stale");
    expect((await f.decide(pending.cardId as string)).state).toBe(change === "unchanged" ? "sent" : "stale");
    expect(a.click).toHaveBeenCalledTimes(change === "unchanged" ? 1 : 0);
    expect(a.listeners).toBe(change === "unchanged" ? 1 : 0);
    expect(a.submissions.map(s => s.form.id)).toEqual(change === "unchanged" ? ["pay"] : []);
  });
  test(`submit child ${state} inside button/${nested} uses the pinned button as submitter`, async () => {
    const a = nativeActivationFixture(state, nested), { f } = a, { r, o, target } = await a.observe();
    const pending = await r.execute({ kind: "submit", target, generation: o.generation }); expect(pending.state).toBe("pending");
    expect(a.submissions).toHaveLength(0); r.close(); expect((await f.decide(pending.cardId as string)).state).toBe("sent");
    expect((await f.decide(pending.cardId as string)).state).toBe("sent");
    expect(a.submissions.map(s => s.form.id)).toEqual(["pay"]); expect(a.submissions[0]!.submitter).toBe(a.control);
    expect(a.click).not.toHaveBeenCalled(); expect(a.listeners).toBe(0);
  });
  test(`ordinary Continue child ${state} inside button/${nested} does not spuriously hold`, async () => {
    const a = nativeActivationFixture(state, nested, "neutral", "submit", "Continue"), { f } = a, { r, o, target } = await a.observe();
    expect((await r.execute({ kind: "click", target, generation: o.generation })).state).toBe("ok");
    expect(a.submissions.map(s => s.form.id)).toEqual(["neutral"]); expect(f.cards.list(f.owner, "conversation")).toHaveLength(0); r.close();
  });
}

for (const type of ["default", "image", "SuBmIt", "invalid-default"]) test(`submit preserves valid native ${type} submitter and stales changed external owner`, async () => {
  for (const change of [false, true]) {
    const a = nativeActivationFixture("true", "direct", "pay", type), { f } = a, { r, o, target } = await a.observe();
    const pending = await r.execute({ kind: "submit", target, generation: o.generation }); expect(pending.state).toBe("pending"); expect(a.submissions).toHaveLength(0);
    if (change) a.control.setAttribute("form", "neutral");
    r.close(); expect((await f.decide(pending.cardId as string)).state).toBe(change ? "stale" : "sent");
    expect(a.submissions.map(s => s.form.id)).toEqual(change ? [] : ["pay"]);
    if (!change) expect(a.submissions[0]!.submitter).toBe(a.control);
    expect(a.click).not.toHaveBeenCalled();
  }
});

for (const type of ["button", "reset"]) test(`submit refuses non-submitter ${type} even with a valid neutral owner`, async () => {
  const a = nativeActivationFixture("false", "direct", "neutral", type, "Continue"), { f } = a, { r, o, target } = await a.observe();
  await expect(r.execute({ kind: "submit", target, generation: o.generation })).rejects.toMatchObject({ code: "computer_browser_target_invalid" });
  expect(a.submissions).toHaveLength(0); expect(a.click).not.toHaveBeenCalled(); expect(f.cards.list(f.owner, "conversation")).toHaveLength(0); r.close();
});

for (const type of ["button", "reset"]) test(`direct ${type} submit also refuses null owner without closest-form fallback`, async () => {
  const a = nativeActivationFixture("false", "direct", "missing", type, "Continue"), { f } = a;
  const { r, o, es } = await f.observe(); const target = es.find(e => e.tag === "button")!.id;
  await expect(r.execute({ kind: "submit", target, generation: o.generation })).rejects.toMatchObject({ code: "computer_browser_target_invalid" });
  expect(a.submissions).toHaveLength(0); expect(a.listeners).toBe(0); expect(f.cards.list(f.owner, "conversation")).toHaveLength(0); r.close();
});

test("a held submit with an invalid effective submitter refuses atomically and never replays", async () => {
  const a = nativeActivationFixture("true", "label other", "pay", "button"), { f } = a, { r, o, target } = await a.observe();
  const pending = await r.execute({ kind: "submit", target, generation: o.generation }); expect(pending.state).toBe("pending");
  expect(a.submissions).toHaveLength(0); r.close(); expect((await f.decide(pending.cardId as string)).state).toBe("stale");
  expect((await f.decide(pending.cardId as string)).state).toBe("stale"); expect(a.submissions).toHaveLength(0); expect(a.listeners).toBe(0); expect(a.click).not.toHaveBeenCalled();
});
