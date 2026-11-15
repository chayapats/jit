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
  return { browser, store, cards, owner, document, field, button, select, location, methods, run, observe, command, screen, decide, streams, get opened() { return opened; }, get dispatches() { return dispatches; }, get tickets() { return tickets; }, setNow: (v: number) => { now = v; }, setOwnerGeneration: (v: number) => { ownerGeneration = v; }, setThrow: (v: boolean) => { throwTicket = v; }, beforeDispatch: (hook: () => void) => { beforeDispatch = hook; }, setRedirect: (v: string) => { redirect = v; } };
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
